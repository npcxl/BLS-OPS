import { describe, expect, it } from "vitest";
import { canSendIn, deriveRunState, isTerminalRun, runStateLabel } from "../run-state";

const t = (key: string) => key;
const card = (status: "running" | "confirming" | "done" | "failed" | "cancelled", steps = 0) => ({
  status,
  steps: Array.from({ length: steps }, () => ({})),
});

describe("运行状态派生", () => {
  it("刚发出、还没有步骤 = 正在分析", () => {
    expect(
      deriveRunState({ task: null, thinking: true, stopping: false, stale: false }),
    ).toBe("analyzing");
  });

  it("有步骤 = 执行中", () => {
    expect(
      deriveRunState({
        task: card("running", 2),
        thinking: true,
        stopping: false,
        stale: false,
      }),
    ).toBe("running");
  });

  it("有步骤在等确认 = 等待用户", () => {
    expect(
      deriveRunState({
        task: card("confirming", 1),
        thinking: true,
        stopping: false,
        stale: false,
      }),
    ).toBe("waiting");
  });

  it("点了停止、后端还没确认 = 正在停止（不是已停止）", () => {
    expect(
      deriveRunState({
        task: card("running", 1),
        thinking: true,
        stopping: true,
        stale: false,
      }),
    ).toBe("stopping");
    // 还没到终态，"已停止"不能提前出现。
    expect(isTerminalRun("stopping")).toBe(false);
  });

  it("事件丢了 / 快照超时 = 状态待核对，不能显示完成", () => {
    expect(
      deriveRunState({ task: null, thinking: false, stopping: false, stale: true }),
    ).toBe("stale");
    expect(isTerminalRun("stale")).toBe(false);
  });

  it("真终态才算结束", () => {
    for (const status of ["done", "failed", "cancelled"] as const) {
      const state = deriveRunState({
        task: card(status),
        thinking: false,
        stopping: true,
        stale: true,
      });
      // 状态是终态时，界面上的 stopping / stale 都要让位。
      expect(isTerminalRun(state)).toBe(true);
    }
  });

  it("停止请求迟到：已经完成的任务不会被改回正在停止", () => {
    expect(
      deriveRunState({ task: card("done"), thinking: true, stopping: true, stale: false }),
    ).toBe("done");
  });

  it("进程中断是终态，但仍可从检查点继续", () => {
    const state = deriveRunState({
      task: { status: "interrupted", steps: [] },
      thinking: false,
      stopping: false,
      stale: false,
    });
    expect(state).toBe("interrupted");
    expect(isTerminalRun(state)).toBe(true);
    expect(runStateLabel(state, t)).toBe("已中断");
    expect(canSendIn(state)).toBe(true);
  });

  it("没有任务也不在请求 = 空闲", () => {
    expect(
      deriveRunState({ task: null, thinking: false, stopping: false, stale: false }),
    ).toBe("idle");
  });
});

describe("输入框可用性", () => {
  it("等待审批时可以输入自然语言", () => {
    expect(canSendIn("waiting")).toBe(true);
  });

  it("正在停止时仍可输入（消息会被受理并提示）", () => {
    expect(canSendIn("stopping")).toBe(true);
  });

  it("状态待核对时先核对再发", () => {
    expect(canSendIn("stale")).toBe(false);
  });
});

describe("文案", () => {
  it("每种状态都有具体说法", () => {
    expect(runStateLabel("analyzing", t)).toBe("正在分析…");
    expect(runStateLabel("stopping", t)).toBe("正在停止…");
    expect(runStateLabel("stale", t)).toBe("状态待核对");
    expect(runStateLabel("waiting", t)).toBe("等待你确认");
    expect(runStateLabel("idle", t)).toBe("");
  });
});
