import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  QUIET_MS,
  TerminalCommandCoordinator,
  type CapturedResult,
  type CoordinatorDeps,
} from "./TerminalCommandCoordinator";
import type { StructuredCommandResult } from "@/api/ops-api";

/** 假时钟：手动推进以验证静默期触发，不依赖真实等待。 */
function useFakeTimers() {
  vi.useFakeTimers();
  return {
    advance: (ms: number) => vi.advanceTimersByTime(ms),
    restore: () => vi.useRealTimers(),
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
    adaptCalls: [] as { knowledgeId: string; command: string; stdout: string }[],
  };
  const value: CoordinatorDeps = {
    match: async (text) => {
      state.matchCalls.push(text);
      return text.startsWith("docker") ? "docker.ps.all" : null;
    },
    adapt: async (input) => {
      state.adaptCalls.push({
        knowledgeId: input.knowledgeId,
        command: input.command,
        stdout: input.stdout,
      });
      return structured("table");
    },
    onResult: (result) => state.results.push(result),
    ...overrides,
  };
  return { value, state };
}

/** 冲刷微任务队列（假定时器下 setTimeout 不会自己跑）。 */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

let timers: ReturnType<typeof useFakeTimers>;

beforeEach(() => {
  timers = useFakeTimers();
});

afterEach(() => {
  timers.restore();
});

describe("终端命令协调器", () => {
  it("识别到知识库命令 → 捕获输出并产出结构化结果", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker ps -a");
    await Promise.resolve(); // 让 match 的微任务跑完
    coordinator.onOutput("CONTAINER ID\n");
    coordinator.onOutput("abc123  web\n");
    timers.advance(QUIET_MS);
    await Promise.resolve();

    expect(state.matchCalls).toEqual(["docker ps -a"]);
    expect(state.adaptCalls).toHaveLength(1);
    // 关键：原样传递已产生的输出，不截断、不加工。
    expect(state.adaptCalls[0].stdout).toBe("CONTAINER ID\nabc123  web\n");
    expect(state.results).toHaveLength(1);
    expect(state.results[0].command).toBe("docker ps -a");
  });

  it("未识别命令 → 完全不介入（不弹空面板）", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("echo hello");
    await Promise.resolve();
    coordinator.onOutput("hello\n");
    timers.advance(QUIET_MS + 1000);
    await Promise.resolve();

    // 未识别命令：不解析、不产出结果。
    expect(state.adaptCalls).toHaveLength(0);
    expect(state.results).toHaveLength(0);
  });

  it("解析只发生一次（绝不重复执行命令）", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker ps");
    await Promise.resolve();
    for (let i = 0; i < 5; i += 1) coordinator.onOutput(`line ${i}\n`);
    timers.advance(QUIET_MS);
    await Promise.resolve();
    // 即使继续有输出/继续等，也不会再解析第二次。
    timers.advance(5000);
    await Promise.resolve();

    expect(state.adaptCalls).toHaveLength(1);
    expect(state.results).toHaveLength(1);
  });

  it("匹配期间的输出不丢（异步 match 竞态）", async () => {
    let resolveMatch: (value: string | null) => void = () => {};
    const { value, state } = deps({
      match: () => new Promise<string | null>((resolve) => (resolveMatch = resolve)),
    });
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker images");
    // match 还没返回，输出就来了 —— 必须缓冲住。
    coordinator.onOutput("REPOSITORY\n");
    resolveMatch("docker.images");
    await Promise.resolve();
    coordinator.onOutput("nginx\n");
    timers.advance(QUIET_MS);
    await Promise.resolve();

    expect(state.adaptCalls[0]?.stdout).toBe("REPOSITORY\nnginx\n");
  });

  it("新命令提交会取消上一次捕获（不串味）", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker ps");
    await Promise.resolve();
    coordinator.onOutput("first\n");
    coordinator.submit("docker images"); // 抢跑
    await Promise.resolve();
    coordinator.onOutput("second\n");
    timers.advance(QUIET_MS);
    await Promise.resolve();

    expect(state.adaptCalls).toHaveLength(1);
    expect(state.adaptCalls[0].command).toBe("docker images");
    expect(state.adaptCalls[0].stdout).not.toContain("first");
  });

  it("长流命令有上限兜底（不会永久挂着）", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker logs -f web");
    await Promise.resolve();
    coordinator.onOutput("streaming…\n");
    // 模拟持续输出（每次都重置静默计时器）。
    for (let i = 0; i < 40; i += 1) {
      timers.advance(300);
      coordinator.onOutput("more\n");
    }
    await Promise.resolve();

    // MAX_MS 兜底必须触发。
    expect(state.adaptCalls).toHaveLength(1);
  });

  it("dispose 后不再产出结果", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);
    coordinator.submit("docker ps");
    coordinator.dispose();
    await Promise.resolve();
    timers.advance(QUIET_MS + 1000);
    await Promise.resolve();

    expect(state.results).toHaveLength(0);
  });

  it("adapt 失败不抛错、不产出结果（终端输出已原样显示）", async () => {
    const calls: string[] = [];
    const { value, state } = deps({
      // 记录后抛错：模拟后端解析失败。
      adapt: async (input) => {
        calls.push(input.command);
        throw new Error("boom");
      },
    });
    const coordinator = new TerminalCommandCoordinator(value);

    coordinator.submit("docker ps");
    await flush();
    timers.advance(QUIET_MS);
    await flush();

    // 解析失败：不产出结果，异常不向上传播（终端该怎么显示还怎么显示）。
    expect(calls).toEqual(["docker ps"]);
    expect(state.results).toHaveLength(0);

    // 失败后协调器依然可用 —— 下一条命令照常工作。
    coordinator.submit("docker images");
    await flush();
    coordinator.onOutput("ok\n");
    timers.advance(QUIET_MS);
    await flush();
    expect(calls).toEqual(["docker ps", "docker images"]);
    // 解析一直失败 → 一直没有结果。
    expect(state.results).toHaveLength(0);
  });

  it("空命令不启动捕获", async () => {
    const { value, state } = deps();
    const coordinator = new TerminalCommandCoordinator(value);
    coordinator.submit("   ");
    await Promise.resolve();
    expect(state.matchCalls).toHaveLength(0);
  });
});
