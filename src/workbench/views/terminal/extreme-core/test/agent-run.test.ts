import { afterEach, describe, expect, it, vi } from "vitest";
import { opsApi } from "@/api/ops-api";
import type { AgentSnapshot } from "@/api/types/agent";
import {
  forgetAgentWait,
  notifyAgentFinished,
  snapshotFromEvent,
  waitForAgentRun,
} from "../agent-run";

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    taskId: "task-run",
    status: "running",
    model: "test-model",
    content: "",
    error: null,
    cwd: "/root",
    server: "prod",
    sessionId: "ssh-1",
    steps: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("等任务结束", () => {
  it("终态事件立刻唤醒，不必等轮询", async () => {
    vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot());
    const pending = waitForAgentRun("task-event", { pollMs: 20 });
    notifyAgentFinished(
      snapshot({ taskId: "task-event", status: "success", content: "好了" }),
    );
    await expect(pending).resolves.toMatchObject({ status: "success", content: "好了" });
  });

  it("事件丢了也能靠快照收敛", async () => {
    vi.useFakeTimers();
    vi.spyOn(opsApi, "aiAgentSnapshot")
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ status: "success", content: "完成" }));
    const pending = waitForAgentRun("task-poll", { pollMs: 100 });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ status: "success", content: "完成" });
  });

  it("主动放弃时按取消收尾，界面不会一直转圈", async () => {
    vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot());
    const pending = waitForAgentRun("task-forget", { pollMs: 5_000 });
    forgetAgentWait("task-forget");
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
  });

  it("后端已经没有这条运行：连续查不到就收尾，不永远等下去", async () => {
    vi.useFakeTimers();
    vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(null);
    const pending = waitForAgentRun("task-missing", { pollMs: 1_000 });

    // 立刻一次 + 每 1s 一次；超过 5s 且连续 3 次以上为空才放弃。
    await vi.advanceTimersByTimeAsync(0);
    for (let round = 0; round < 8; round += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await expect(pending).resolves.toBeNull();
  });

  it("复用 taskId 续跑：先读到上一轮的完成快照也不能当本轮结束", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.spyOn(opsApi, "aiAgentSnapshot")
      // 上一轮留下的终态：比本次启动早 → 必须忽略。
      .mockResolvedValueOnce(snapshot({ status: "success", content: "上一轮", updatedAt: now - 5_000 }))
      // 本轮刚登记：running。
      .mockResolvedValueOnce(snapshot({ status: "running", updatedAt: now + 10 }))
      // 本轮结束。
      .mockResolvedValueOnce(snapshot({ status: "success", content: "这一轮", updatedAt: now + 500 }));

    const pending = waitForAgentRun("task-reuse", { pollMs: 100, since: now });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toMatchObject({ status: "success", content: "这一轮" });
  });

  it("轮询超时仍在运行时，返回待核对，不能当作成功", async () => {
    vi.useFakeTimers();
    vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
    const pending = waitForAgentRun("task-timeout", { pollMs: 100, timeoutMs: 200 });
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBeNull();
  });

  it("同一个 taskId 的多个等待者都会被唤醒", async () => {
    vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot());
    const first = waitForAgentRun("task-multi", { pollMs: 20 });
    const second = waitForAgentRun("task-multi", { pollMs: 20 });
    notifyAgentFinished(snapshot({ taskId: "task-multi", status: "failed", error: "炸了" }));
    await expect(first).resolves.toMatchObject({ status: "failed", error: "炸了" });
    await expect(second).resolves.toMatchObject({ status: "failed" });
  });
});

describe("事件 → 快照", () => {
  it("三种终态各自映射，正文与错误都带上", () => {
    const finished = snapshotFromEvent({
      taskId: "t",
      kind: "finished",
      content: "结论",
      model: "m",
      cwd: "/srv",
    });
    expect(finished).toMatchObject({
      status: "success",
      content: "结论",
      model: "m",
      cwd: "/srv",
    });

    const failed = snapshotFromEvent({ taskId: "t", kind: "failed", message: "模型超时" });
    expect(failed).toMatchObject({ status: "failed", error: "模型超时" });

    const cancelled = snapshotFromEvent({ taskId: "t", kind: "cancelled", message: "已停止" });
    expect(cancelled).toMatchObject({ status: "cancelled", error: "已停止" });

    // 非终态事件不该被当成结束：状态保持 running。
    expect(snapshotFromEvent({ taskId: "t", kind: "tool_output" }).status).toBe("running");
  });
});
