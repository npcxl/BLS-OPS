import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 任务结果通知只认**实时终态**：
 * - 历史恢复 / 切换对话走 `upsertTask`，不能弹；
 * - 真终态也要等主窗口收起才弹，且同一任务只弹一次。
 */
const bridge = vi.hoisted(() => ({ push: vi.fn() }));
const visibility = vi.hoisted(() => ({ hidden: true }));

vi.mock("@/desktop-notification/bridge", () => ({
  pushDesktopNotification: bridge.push,
}));

vi.mock("@/desktop-notification/visibility", () => ({
  isWindowHidden: () => visibility.hidden,
  isMainWindowHidden: async () => visibility.hidden,
  setCollapsed: () => undefined,
}));

import { useExtremeStore } from "@/stores/extreme-store";
import { cardFromPlan } from "@/workbench/views/terminal/extreme-core/task-view";
import { notifyTaskOutcome } from "../task";

const card = (id: string, status: "done" | "failed") =>
  cardFromPlan({
    id,
    plan: [],
    server: "prod",
    sessionId: "ssh-1",
    status,
    result: status === "done" ? "已完成" : "失败了",
  });

beforeEach(() => {
  bridge.push.mockClear();
  visibility.hidden = true;
  useExtremeStore.setState({ tasks: {}, taskVersions: {}, unread: {} });
});

describe("任务结果通知", () => {
  it("历史恢复只写卡片，不补发桌面通知", () => {
    useExtremeStore.getState().upsertTask(card("history-task", "done"));
    useExtremeStore.getState().upsertTask(card("history-failed", "failed"));

    expect(useExtremeStore.getState().tasks["history-task"]?.status).toBe("done");
    expect(bridge.push).not.toHaveBeenCalled();
  });

  it("主窗口可见时结果只留在对话里", async () => {
    visibility.hidden = false;
    await notifyTaskOutcome(card("visible-task", "done"));

    expect(bridge.push).not.toHaveBeenCalled();
  });

  it("收起后真实终态只弹一条", async () => {
    const done = card("hidden-task", "done");
    await notifyTaskOutcome(done);
    await notifyTaskOutcome(done);

    expect(bridge.push).toHaveBeenCalledTimes(1);
    expect(bridge.push.mock.calls[0][0]).toMatchObject({
      id: "extreme-hidden-task",
      tone: "success",
      source: "超能模式",
      durationMs: 9000,
    });
  });

  it("失败也是同一条路径，带 danger 样式", async () => {
    await notifyTaskOutcome(card("hidden-failed", "failed"));

    expect(bridge.push).toHaveBeenCalledTimes(1);
    expect(bridge.push.mock.calls[0][0]).toMatchObject({
      id: "extreme-hidden-failed",
      tone: "danger",
    });
  });
});
