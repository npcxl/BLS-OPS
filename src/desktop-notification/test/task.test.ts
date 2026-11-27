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

import { i18n } from "@/i18n";
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
      // 文案跟随界面语言（测试固定英文），不能在通知里漏中文。
      source: i18n.t("超能模式"),
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

  it("续跑复用同一个 taskId：时间窗之外的新一轮完成仍提醒一次", async () => {
    const done = card("resumed-task", "done");
    await notifyTaskOutcome(done, { now: 1_000 });
    // 同一次运行的重复事件（时间窗内）不重复弹。
    await notifyTaskOutcome(done, { now: 2_000 });
    expect(bridge.push).toHaveBeenCalledTimes(1);

    // 续跑后的第二次真实完成：任务卡内容更新，时间也早已超出窗口。
    const again = { ...done, result: "续跑完成" };
    await notifyTaskOutcome(again, { now: 120_000 });
    expect(bridge.push).toHaveBeenCalledTimes(2);
    expect(bridge.push.mock.calls[1][0].body).toContain("续跑完成");
  });
});
