/**
 * 任务成功 / 失败的桌面通知。
 *
 * 只由**实时终态**触发：历史恢复、切换对话、重开快照都只更新卡片与消息，
 * 不经过这里。是否真的弹由 `isMainWindowHidden()` 决定 —— 窗口在眼前时
 * 结果留在对话里，不打扰。
 */
import { pushDesktopNotification } from "@/desktop-notification/bridge";
import { isMainWindowHidden } from "@/desktop-notification/visibility";
import type { TaskCardModel } from "@/workbench/views/terminal/extreme-core/task-view";

/** 每个「任务 + 终态」只提醒一次：重复事件、续跑重放都不叠通知。 */
const notified = new Set<string>();

export async function notifyTaskOutcome(task: TaskCardModel): Promise<void> {
  if (task.status !== "done" && task.status !== "failed") return;
  const key = `${task.id}:${task.status}`;
  if (notified.has(key)) return;
  // 先在窗口可见时就记下"已处理过终态"：之后用户再最小化，也不补发旧结果。
  notified.add(key);
  if (!(await isMainWindowHidden())) return;

  pushDesktopNotification({
    id: `extreme-${task.id}`,
    tone: task.status === "done" ? "success" : "danger",
    source: "超能模式",
    time: "刚刚",
    title: task.title,
    body:
      task.result ||
      (task.status === "done"
        ? "任务已执行完成，点击回到超能模式查看结果。"
        : "任务执行失败，点击回到超能模式查看详情。"),
    durationMs: 9000,
    action: task.serverId
      ? { kind: "extreme", serverId: task.serverId, server: task.server }
      : { kind: "none" },
  });
}
