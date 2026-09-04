import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CommandSearchHit, StructuredCommandResult } from "@/api/ops-api";
import {
  QUIET_MS,
  TerminalCommandCoordinator,
  type CapturedResult,
  type CoordinatorDeps,
} from "./TerminalCommandCoordinator";

// React 19：act() 需要这个全局标记。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 冲刷微任务队列（假定时器下 setTimeout 不会自己跑）。 */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function useFakeTimers() {
  vi.useFakeTimers();
  return {
    advance: (ms: number) => vi.advanceTimersByTime(ms),
    restore: () => vi.useRealTimers(),
  };
}

let timers: ReturnType<typeof useFakeTimers>;

beforeEach(() => {
  timers = useFakeTimers();
});

afterEach(() => {
  timers.restore();
});

function hit(overrides: Partial<CommandSearchHit> = {}): CommandSearchHit {
  return {
    id: "docker.ps.all",
    executable: "docker",
    subcommand: "ps -a",
    title: "查看所有容器",
    description: "",
    category: "container",
    syntax: "docker ps -a",
    risk: "read_only",
    mutability: "read",
    output_adapter: "docker-container-table",
    requires: ["docker"],
    required_params: [],
    placeholders: [],
    can_execute: true,
    favorite: false,
    score: 0,
    ...overrides,
  };
}

function structured(view: string): StructuredCommandResult {
  return {
    view: view as StructuredCommandResult["view"],
    title: "结果",
    summary: [],
    columns: [],
    rows: [],
    sections: [],
    warnings: [],
    meta: { command: "cmd", exit_code: null, duration_ms: 1, truncated: false },
    raw: { stdout: "", stderr: "" },
  };
}

function deps(overrides: Partial<CoordinatorDeps> = {}) {
  const state = {
    results: [] as CapturedResult[],
    matchCalls: [] as string[],
    adaptCalls: [] as {
      knowledgeId: string;
      command: string;
      stdout: string;
      normalized: string;
    }[],
  };
  const value: CoordinatorDeps = {
    match: async (text) => {
      state.matchCalls.push(text);
      // 模拟后端两级匹配：docker 家族 / df 家族（-h、-hP 等标志变体同家族）。
      if (text.startsWith("docker")) return hit();
      if (text.startsWith("df")) return hit({ id: "df.h", syntax: "df -hP" });
      return null;
    },
    adapt: async (input) => {
      state.adaptCalls.push({
        knowledgeId: input.knowledgeId,
        command: input.command,
        stdout: input.stdout,
        normalized: input.normalized,
      });
      return structured("table");
    },
    onResult: (result) => state.results.push(result),
    ...overrides,
  };
  return { value, state };
}

describe("终端命令协调器", () => {
  it("识别到知识库命令 → 捕获输出并产出结构化结果", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker ps -a");
    await flush();
    coordinator.onOutput("CONTAINER ID\n");
    coordinator.onOutput("abc123  web\n");
    timers.advance(QUIET_MS);
    await flush();

    expect(state.matchCalls).toEqual(["docker ps -a"]);
    expect(state.adaptCalls).toHaveLength(1);
    // 关键：原样传递已产生的输出，不截断、不加工。
    expect(state.adaptCalls[0].stdout).toBe("CONTAINER ID\nabc123  web\n");
    // normalized 是净化后的解析输入：去尾部提示符行后不含尾换行（无 ANSI 时内容一致）。
    expect(state.adaptCalls[0].normalized).toBe("CONTAINER ID\nabc123  web");
    expect(state.results).toHaveLength(1);
    expect(state.results[0].command).toBe("docker ps -a");
    // 真实风险随结果带回（禁止伪装成只读）。
    expect(state.results[0].risk).toBe("read_only");
    expect(state.results[0].mutability).toBe("read");
    expect(state.results[0].canExecute).toBe(true);
  });

  it("未识别命令 → 完全不介入（不弹空面板）", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("echo hello");
    await flush();
    coordinator.onOutput("hello\n");
    timers.advance(QUIET_MS + 1000);
    await flush();

    expect(state.adaptCalls).toHaveLength(0);
    expect(state.results).toHaveLength(0);
  });

  it("解析只发生一次（绝不重复执行命令）", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker ps");
    await flush();
    for (let i = 0; i < 5; i += 1) coordinator.onOutput(`line ${i}\n`);
    timers.advance(QUIET_MS);
    await flush();
    timers.advance(5000);
    await flush();

    expect(state.adaptCalls).toHaveLength(1);
    expect(state.results).toHaveLength(1);
  });

  it("匹配期间的输出不丢（异步 match 竞态）", async () => {
    let resolveMatch: (value: CommandSearchHit | null) => void = () => {};
    const { value, state } = deps({
      match: () => new Promise<CommandSearchHit | null>((resolve) => (resolveMatch = resolve)),
    });
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker images");
    coordinator.onOutput("REPOSITORY\n");
    resolveMatch(hit({ id: "docker.images" }));
    await flush();
    coordinator.onOutput("nginx\n");
    timers.advance(QUIET_MS);
    await flush();

    expect(state.adaptCalls[0]?.stdout).toBe("REPOSITORY\nnginx\n");
  });

  it("sudo / 管道命令被标准化：sudo df -hP | grep → 匹配 df -hP", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    // 前导 sudo 去掉、管道之后截断 → 规范化为 "df -hP"。
    coordinator.submit("sudo df -hP | grep /dev");
    await flush();

    expect(state.matchCalls).toEqual(["df -hP"]);
  });

  it("纯管道命令不介入（输出结构已被改变）", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("| grep x");
    await flush();
    coordinator.onOutput("x\n");
    timers.advance(QUIET_MS + 1000);
    await flush();

    expect(state.matchCalls).toHaveLength(0);
    expect(state.results).toHaveLength(0);
  });

  it("交互式全屏程序（vim/top）不介入", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    for (const command of ["vim /etc/nginx/nginx.conf", "top"]) {
      coordinator.submit(command);
    }
    await flush();
    timers.advance(QUIET_MS + 1000);
    await flush();

    expect(state.matchCalls).toHaveLength(0);
    expect(state.results).toHaveLength(0);
  });

  it("新命令提交会取消上一次捕获（不串味）", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker ps");
    await flush();
    coordinator.onOutput("first\n");
    coordinator.submit("docker ps -a");
    await flush();
    coordinator.onOutput("second\n");
    timers.advance(QUIET_MS);
    await flush();

    expect(state.adaptCalls).toHaveLength(1);
    expect(state.adaptCalls[0].command).toBe("docker ps -a");
    expect(state.adaptCalls[0].stdout).not.toContain("first");
  });

  it("长流命令有上限兜底（不会永久挂着）", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker ps -a");
    await flush();
    coordinator.onOutput("streaming…\n");
    for (let i = 0; i < 40; i += 1) {
      timers.advance(300);
      coordinator.onOutput("more\n");
    }
    await flush();

    // MAX_MS 兜底必须触发。
    expect(state.adaptCalls).toHaveLength(1);
  });

  it("dispose 后不再产出结果", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);
    coordinator.submit("docker ps -a");
    coordinator.dispose();
    await flush();
    timers.advance(QUIET_MS + 1000);
    await flush();

    expect(state.results).toHaveLength(0);
  });

  it("adapt 失败不抛错、不产出结果（终端输出已原样显示）", async () => {
    const calls: string[] = [];
    const { value, state } = deps({
      adapt: async (input) => {
        calls.push(input.command);
        throw new Error("boom");
      },
    });
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker ps -a");
    await flush();
    timers.advance(QUIET_MS);
    await flush();

    // 解析失败：不产出结果，异常不向上传播（终端该怎么显示还怎么显示）。
    expect(calls).toEqual(["docker ps -a"]);
    expect(state.results).toHaveLength(0);

    // 失败后协调器依然可用 —— 下一条命令照常工作。
    coordinator.submit("docker ps -a");
    await flush();
    coordinator.onOutput("ok\n");
    timers.advance(QUIET_MS);
    await flush();
    expect(calls).toEqual(["docker ps -a", "docker ps -a"]);
    expect(state.results).toHaveLength(0);
  });

  it("空命令不启动捕获", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);
    coordinator.submit("   ");
    await flush();
    expect(state.matchCalls).toHaveLength(0);
  });

  it("真实风险随结果带回（medium 命令不再伪装成只读）", async () => {
    const { value, state } = deps({
      match: async () =>
        hit({
          id: "systemctl.restart",
          risk: "medium",
          mutability: "change",
        }),
    });
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker ps -a"); // 文本无所谓，match 被 mock
    await flush();
    timers.advance(QUIET_MS);
    await flush();

    expect(state.results).toHaveLength(1);
    expect(state.results[0].risk).toBe("medium");
    expect(state.results[0].mutability).toBe("change");
  });
});
