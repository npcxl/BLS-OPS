/**
 * 任务成功 / 失败的桌面通知。
 *
 * 只由**实时终态**触发：历史恢复、切换对话、重开快照都只更新卡片与消息，
 * 不经过这里。是否真的弹由 `isMainWindowHidden()` 决定 —— 窗口在眼前时
 * 结果留在对话里，不打扰。
 *
 * # 去重
 *
 * 续跑会**复用同一个 taskId**，所以不能按 `taskId + status` 永久去重（那会
 * 把第二轮真实完成永久吞掉）。这里只压掉"同一次运行里重复到达的终态事件"：
 * 同一个 `taskId + status` 在很短的时间窗内只记一次。窗口之外的再次完成
 * （续跑、重新执行）仍然会正常提醒一次。
 */
import { pushDesktopNotification } from "@/desktop-notification/bridge";
import { isMainWindowHidden } from "@/desktop-notification/visibility";
import { i18n } from "@/i18n";
import { notificationAllowed } from "@/stores/extreme-settings-store";
import type { TaskCardModel } from "@/workbench/views/terminal/extreme-core/task-view";

/** 同一任务同状态在这个窗口内视为"同一次运行的重复事件"。 */
const DUPLICATE_WINDOW_MS = 10_000;
/** 超过这个时间的记录直接清掉，避免 Map 随任务数无限增长。 */
const RETENTION_MS = 60_000;

const notified = new Map<string, number>();

function prune(now: number): void {
  for (const [key, at] of notified) {
    if (now - at > RETENTION_MS) notified.delete(key);
  }
}

export interface NotifyTaskOptions {
  /** 测试用：显式给定"现在"，便于验证去重窗口。 */
  now?: number;
}

export async function notifyTaskOutcome(
  task: TaskCardModel,
  options: NotifyTaskOptions = {},
): Promise<void> {
  if (task.status !== "done" && task.status !== "failed") return;
  const now = options.now ?? Date.now();
  const key = `${task.id}:${task.status}`;
  const previous = notified.get(key);
  // 只在时间窗内压重：持久 Set 会把续跑的第二轮永久吞掉。
  if (previous !== undefined && now - previous < DUPLICATE_WINDOW_MS) return;
  notified.set(key, now);
  prune(now);
  // 设置里关掉这一类：只更新会话内状态，不弹桌面通知。
  if (!notificationAllowed(task.status === "done" ? "success" : "failed")) return;
  if (!(await isMainWindowHidden())) return;

  pushDesktopNotification({
    id: `extreme-${task.id}`,
    tone: task.status === "done" ? "success" : "danger",
    source: i18n.t("超能模式"),
    time: i18n.t("刚刚"),
    title: task.title,
    body:
      task.result ||
      (task.status === "done"
        ? i18n.t("任务已执行完成，点击回到超能模式查看结果。")
        : i18n.t("任务执行失败，点击回到超能模式查看详情。")),
    durationMs: 9000,
    action: task.serverId
      ? {
          kind: "extreme",
          serverId: task.serverId,
          server: task.server,
          taskId: task.id,
          workspaceId: task.workspaceId,
        }
      : { kind: "none" },
  });
}
