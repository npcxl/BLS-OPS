import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSearchHit, Mutability, RiskLevel } from "@/api/ops-api";
import {
  NO_MARKER_FAILSAFE_MS,
  TerminalCommandCoordinator,
  type CapturedResult,
} from "../TerminalCommandCoordinator";
import { planCommandSubmission } from "../command-plan";

function hit(overrides: Partial<CommandSearchHit> = {}): CommandSearchHit {
  return {
    id: "docker.ps.all",
    title: "查看所有容器",
    category: "container",
    syntax: "docker ps -a",
    risk: "read_only" as RiskLevel,
    mutability: "read" as Mutability,
    output_adapter: "docker-container-table",
    requires: ["docker"],
    required_params: [],
    placeholders: [],
    description: "显示运行中和已停止的容器",
    score: 1,
    matched_on: "syntax",
    ...overrides,
  } as CommandSearchHit;
}

let now = 1_000;
/**
 * 只推进**微任务**：用例跑在 fake timers 下（`window.setTimeout` 是假的），
 * 用 `setTimeout(0)` 等会永远卡住。`match` / `captureNow` / 渲染汇合都是
 * 立即 resolve 的 async，几个微任务周期就足够跑完
 * `submit → 结束标记 → provideRenderedText → emit` 链。
 */
const flush = async () => {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
};

describe("TerminalCommandCoordinator — 受控标记边界", () => {
  beforeEach(() => {
    now = 1_000;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(options?: {
    hit?: CommandSearchHit | null;
    captureNow?: () => { text: string | null } | Promise<{ text: string | null }>;
  }) {
    const results: CapturedResult[] = [];
    const coordinator = new TerminalCommandCoordinator({
      now: () => now,
      match: async () => (options && "hit" in options ? options.hit : hit()) ?? null,
      captureNow: options?.captureNow,
      onResult: (item) => results.push(item),
    });
    return { coordinator, results };
  }

  /** 提交一条命令（走真实计划）。 */
  const submit = (
    coordinator: TerminalCommandCoordinator,
    command: string,
    source: "input" | "rerun" | "history" | "suggest" = "input",
  ) => coordinator.submit(command, source, planCommandSubmission(command));

  it("收到结束标记 → 快照汇合后才产出；慢命令分两批输出不会提前结束", async () => {
    const { coordinator, results } = setup();
    submit(coordinator, "sleep 2 && ps aux");

    now += 2_000;
    coordinator.onOutput("第一批\n");
    await flush();
    expect(results).toHaveLength(0); // 第一批之后不能就当结束了

    // 中间隔了很久再来第二批（真实的慢命令形态）。
    now += 8_000;
    coordinator.onOutput("第二批\n", [{ type: "output_end", exitCode: 0 }]);
    await flush();
    // 结束标记到了，但渲染快照还没汇合 → 也不能提前产出。
    expect(results).toHaveLength(0);

    coordinator.provideRenderedText({ text: "第一批\n第二批\n" });
    await flush();

    expect(results).toHaveLength(1);
    expect(results[0].stdout).toBe("第一批\n第二批\n"); // 两批输出都不能丢
    expect(results[0].renderedText).toBe("第一批\n第二批\n");
    expect(results[0].renderedDegraded).toBe(false);
    expect(results[0].boundary.exitCode).toBe(0);
    expect(results[0].boundary.durationMs).toBe(10_000);
    expect(results[0].boundary.endedBy).toBe("marker");
  });

  it("超过 10 秒的命令不会被截断（静默期不再是结束判据）", async () => {
    const { coordinator, results } = setup();
    submit(coordinator, "make -j8");

    // 11 秒里持续出输出，中间从未静默满 400ms 之外的任何阈值。
    for (let i = 0; i < 11; i += 1) {
      now += 1_000;
      coordinator.onOutput(`line ${i}\n`);
    }
    await flush();
    expect(results).toHaveLength(0); // 输出还在继续 → 绝不能结束

    vi.advanceTimersByTime(NO_MARKER_FAILSAFE_MS - 1);
    await flush();
    expect(results).toHaveLength(0);

    // 命令真正结束（标记到达）→ 汇合快照后一次交付全部输出。
    now += 500;
    coordinator.onOutput("", [{ type: "output_end", exitCode: 0 }]);
    coordinator.provideRenderedText({ text: "lines" });
    await flush();
    expect(results).toHaveLength(1);
    expect(results[0].stdout.split("\n")).toHaveLength(12);
    expect(results[0].boundary.durationMs).toBe(11_500);
  });

  it("标记始终不来 → 兜底收场并降级（标明不是边界判定）", async () => {
    const { coordinator, results } = setup();
    submit(coordinator, "some-tool");
    coordinator.onOutput("半截输出");
    vi.advanceTimersByTime(NO_MARKER_FAILSAFE_MS);
    await flush();
    expect(results).toHaveLength(1);
    expect(results[0].boundary.endedBy).toBe("failsafe");
    expect(results[0].boundary.exitCode).toBeNull();
    expect(results[0].stdout).toBe("半截输出");
    // 无快照 → 降级：renderedText 是对原始流的清洗结果，并显式标记。
    expect(results[0].renderedDegraded).toBe(true);
    expect(results[0].renderedText).toBe("半截输出");
  });

  it("兜底路径也可经 captureNow 抓到当前快照（不需要标记汇合）", async () => {
    const { coordinator, results } = setup({
      captureNow: async () => ({ text: "catch 到的当前缓冲" }),
    });
    submit(coordinator, "long-runner");
    coordinator.onOutput("部分输出\n");
    vi.advanceTimersByTime(NO_MARKER_FAILSAFE_MS);
    await flush();
    expect(results).toHaveLength(1);
    expect(results[0].boundary.endedBy).toBe("failsafe");
    expect(results[0].renderedText).toBe("catch 到的当前缓冲");
    expect(results[0].renderedDegraded).toBe(false);
  });

  it("空输出是有效结果：快照为空串时不降级、不回落", async () => {
    const { coordinator, results } = setup();
    submit(coordinator, "noop-tool");
    coordinator.onOutput("", [{ type: "output_end", exitCode: 0 }]);
    coordinator.provideRenderedText({ text: "" });
    await flush();
    expect(results).toHaveLength(1);
    expect(results[0].renderedText).toBe("");
    expect(results[0].renderedDegraded).toBe(false);
  });

  it("输出开始标记优先于第一块输出；没有标记时用第一块输出", async () => {
    const { coordinator, results } = setup();
    submit(coordinator, "tool a");
    now += 50;
    coordinator.onOutput("x\n", [{ type: "output_start" }]);
    coordinator.onOutput("", [{ type: "output_end", exitCode: 3 }]);
    coordinator.provideRenderedText({ text: "x" });
    await flush();
    expect(results[0].boundary.outputStart).toBe(1_050);

    // 重置时钟，让第二段断言读起来直观。
    now = 1_000;
    const second = setup();
    submit(second.coordinator, "tool b");
    now += 70;
    second.coordinator.onOutput("y\n");
    second.coordinator.onOutput("", [{ type: "output_end", exitCode: 0 }]);
    second.coordinator.provideRenderedText({ text: "y" });
    await flush();
    expect(second.results[0].boundary.outputStart).toBe(1_070);
  });

  it("stdout 与 stderr 分开累积，stderr 不会污染 stdout", async () => {
    const { coordinator, results } = setup();
    submit(coordinator, "tool c");
    coordinator.onOutput("out\n");
    coordinator.onStderr("err\n");
    coordinator.onOutput("", [{ type: "output_end", exitCode: 1 }]);
    coordinator.provideRenderedText({ text: "out" });
    await flush();
    expect(results[0].stdout).toBe("out\n");
    expect(results[0].stderr).toBe("err\n");
    expect(results[0].renderedText).toBe("out");
  });

  it("重新运行生成**新的**结果 Tab（两条互不覆盖）", async () => {
    const { coordinator, results } = setup();
    coordinator.submit("df -h", "input", planCommandSubmission("df -h"));
    coordinator.onOutput("第一次\n", [{ type: "output_end", exitCode: 0 }]);
    coordinator.provideRenderedText({ text: "第一次" });
    await flush();

    coordinator.submit("df -h", "rerun", planCommandSubmission("df -h"));
    coordinator.onOutput("第二次\n", [{ type: "output_end", exitCode: 0 }]);
    coordinator.provideRenderedText({ text: "第二次" });
    await flush();

    expect(results).toHaveLength(2); // 每次执行都是一个新 Tab
    expect(results[0].id).not.toBe(results[1].id);
    expect(results[0].source).toBe("input");
    expect(results[1].source).toBe("rerun");
    expect(results[1].stdout).toBe("第二次\n"); // 新 Tab 不串上一次的输出
  });

  it("命令历史执行同样生成结果 Tab", async () => {
    const { coordinator, results } = setup();
    coordinator.submit(
      "systemctl status nginx",
      "history",
      planCommandSubmission("systemctl status nginx"),
    );
    coordinator.onOutput("active\n", [{ type: "output_end", exitCode: 0 }]);
    coordinator.provideRenderedText({ text: "active" });
    await flush();
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("history");
    expect(results[0].command).toBe("systemctl status nginx");
  });

  it("未命中知识库 → 仍出结果，但风险是 null（绝不伪装成只读）", async () => {
    const { coordinator, results } = setup({ hit: null });
    submit(coordinator, "lsblk");
    coordinator.onOutput("sda\n", [{ type: "output_end", exitCode: 0 }]);
    coordinator.provideRenderedText({ text: "sda" });
    await flush();
    expect(results).toHaveLength(1); // 没命中也要出结果 Tab（快照视图）
    expect(results[0].risk).toBeNull();
    expect(results[0].mutability).toBe("unknown");
    expect(results[0].knowledgeId).toBe("");
    expect(results[0].renderedDegraded).toBe(false);
  });

  it("命中知识库 → 带真实风险与可变性", async () => {
    const { coordinator, results } = setup();
    submit(coordinator, "docker ps -a");
    coordinator.onOutput("x\n", [{ type: "output_end", exitCode: 0 }]);
    coordinator.provideRenderedText({ text: "x" });
    await flush();
    expect(results[0].risk).toBe("read_only");
    expect(results[0].mutability).toBe("read");
  });

  it("命令用归一化形式匹配知识库（sudo / 管道前缀不影响命中）", async () => {
    const seen: string[] = [];
    const coordinator = new TerminalCommandCoordinator({
      now: () => now,
      match: async (text) => {
        seen.push(text);
        return null;
      },
      onResult: () => undefined,
    });
    coordinator.submit("sudo docker ps -a", "input", planCommandSubmission("sudo docker ps -a"));
    coordinator.onOutput("", [{ type: "output_end", exitCode: 0 }]);
    coordinator.provideRenderedText({ text: "" });
    await flush();
    expect(seen[0]).toBe("docker ps -a");
    coordinator.dispose();
  });

  it("交互式 / 无输出内建命令不产生结果 Tab（留在原生终端）", async () => {
    const { coordinator, results } = setup();
    for (const command of ["vim /etc/hosts", "top", "cd /var/log", "cat", "export FOO=1"]) {
      const plan = planCommandSubmission(command);
      expect(plan.capture).toBe(false);
      submit(coordinator, command);
    }
    coordinator.onOutput("whatever\n", [{ type: "output_end", exitCode: 0 }]);
    vi.advanceTimersByTime(NO_MARKER_FAILSAFE_MS);
    await flush();
    expect(results).toHaveLength(0);
  });

  it("未提交命令时的输出不会被捕获", async () => {
    const { coordinator, results } = setup();
    coordinator.onOutput("登录横幅\n");
    vi.advanceTimersByTime(NO_MARKER_FAILSAFE_MS);
    await flush();
    expect(results).toHaveLength(0);
  });

  it("新命令提交会作废上一次捕获（不串味）", async () => {
    const { coordinator, results } = setup();
    submit(coordinator, "tool a");
    coordinator.onOutput("A 的输出\n");
    submit(coordinator, "tool b");
    coordinator.onOutput("B 的输出\n", [{ type: "output_end", exitCode: 0 }]);
    coordinator.provideRenderedText({ text: "B 的输出" });
    await flush();
    expect(results).toHaveLength(1);
    expect(results[0].command).toBe("tool b");
    expect(results[0].stdout).toBe("B 的输出\n");
  });

  it("dispose 后不再产出结果", async () => {
    const { coordinator, results } = setup();
    submit(coordinator, "tool a");
    coordinator.dispose();
    coordinator.onOutput("x\n", [{ type: "output_end", exitCode: 0 }]);
    coordinator.provideRenderedText({ text: "x" });
    await flush();
    expect(results).toHaveLength(0);
  });

  describe("严格 JSON Tab 检测（数据完整，不做任何自动表格化）", () => {
    it("整段输出是合法 JSON → json 命中，渲染文本原样保留", async () => {
      const { coordinator, results } = setup();
      submit(coordinator, "docker inspect nginx");
      coordinator.onOutput('{"Id":"abc","Image":"nginx"}\n', [
        { type: "output_end", exitCode: 0 },
      ]);
      coordinator.provideRenderedText({ text: '{"Id":"abc","Image":"nginx"}' });
      await flush();
      expect(results[0].json).toEqual({
        kind: "json",
        value: { Id: "abc", Image: "nginx" },
      });
      expect(results[0].renderedText).toBe('{"Id":"abc","Image":"nginx"}');
      expect(results[0].stdout).toBe('{"Id":"abc","Image":"nginx"}\n');
    });

    it("快照首行是 prompt+命令回显 → 只影响检测，渲染文本不动", async () => {
      const { coordinator, results } = setup();
      submit(coordinator, "cat app.json");
      coordinator.onOutput('{"a":1}\n', [{ type: "output_end", exitCode: 0 }]);
      coordinator.provideRenderedText({ text: 'user@host:~$ cat app.json\n{"a":1}\n' });
      await flush();
      expect(results[0].json).toEqual({ kind: "json", value: { a: 1 } });
      // 终端输出保持“用户看到的原样”，检测只是额外加了一个 JSON Tab。
      expect(results[0].renderedText).toBe('user@host:~$ cat app.json\n{"a":1}\n');
    });

    it("多行每行都是合法 JSON → jsonl，且全部行都保留", async () => {
      const { coordinator, results } = setup();
      submit(coordinator, "docker ps --format json");
      coordinator.onOutput('{"a":1}\n{"a":2}\n', [{ type: "output_end", exitCode: 0 }]);
      coordinator.provideRenderedText({ text: '{"a":1}\n{"a":2}\n' });
      await flush();
      expect(results[0].json).toEqual({ kind: "jsonl", value: [{ a: 1 }, { a: 2 }] });
    });

    it("输出里混有非 JSON 行 → json 为 null，JSON Tab 不出现，原样全保留", async () => {
      const { coordinator, results } = setup();
      submit(coordinator, "docker ps");
      coordinator.onOutput('{"a":1}\nwarning: timeout\n', [{ type: "output_end", exitCode: 0 }]);
      coordinator.provideRenderedText({ text: '{"a":1}\nwarning: timeout\n' });
      await flush();
      expect(results[0].json).toBeNull(); // 绝无“跳过坏行只留好行”的部分解析
      expect(results[0].renderedText).toBe('{"a":1}\nwarning: timeout\n');
      expect(results[0].stdout).toBe('{"a":1}\nwarning: timeout\n');
    });

    it("普通文本 → json 为 null，默认仍是终端输出", async () => {
      const { coordinator, results } = setup();
      submit(coordinator, "ls -la");
      coordinator.onOutput("drwxr-xr-x  app\n", [{ type: "output_end", exitCode: 0 }]);
      coordinator.provideRenderedText({ text: "drwxr-xr-x  app" });
      await flush();
      expect(results[0].json).toBeNull();
      expect(results[0].renderedText).toBe("drwxr-xr-x  app");
    });
  });
});
