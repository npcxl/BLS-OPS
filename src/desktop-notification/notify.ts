/**
 * 收起软件时的后台任务提醒。
 *
 * 「收起」有两条路径，原生侧都会发 `app:collapsed`：
 * - 点 X → 隐藏到托盘（`CloseRequested`）；
 * - 最小化（`Resized` + `is_minimized`）。
 *
 * 前端收到后检查超能模式里是否还有 running / waiting 的任务：
 * 有就弹一条常驻通知（同 id 复用，反复收起重置而不是叠一摞），
 * 任务全部结束再自动收回。
 */
import { listen } from "@tauri-apps/api/event";

import {
  dismissDesktopNotification,
  pushDesktopNotification,
} from "@/desktop-notification/bridge";
import { i18n } from "@/i18n";
import { useExtremeStore } from "@/stores/extreme-store";

/** 固定 id：一次提醒只占一个槽，反复收起只会刷新内容。 */
const COLLAPSE_NOTICE_ID = "extreme-running";

let installed = false;
/**
 * 这一轮收起是否已经提醒过。
 *
 * 最小化在部分平台会连续发多次 `app:collapsed`，页面可见性也可能再来一次；
 * 同一次收起只提醒一次，回到前台复位。真正的"状态变化"仍会更新那条通知。
 */
let announced = false;

function runningTasks() {
  const tasks = useExtremeStore.getState().tasks;
  return Object.values(tasks).filter(
    (task) => task.status === "running" || task.status === "waiting",
  );
}

function notifyCollapsed(): void {
  if (announced) return;
  const running = runningTasks();
  if (running.length === 0) return;
  announced = true;

  const first = running[0];
  pushDesktopNotification({
    id: COLLAPSE_NOTICE_ID,
    tone: "info",
    source: i18n.t("超能模式"),
    time: i18n.t("刚刚"),
    title: i18n.t("还有任务在后台运行"),
    body: i18n.t("{{count}} 个任务尚未完成，收起窗口不会中断它们。", {
      count: running.length,
    }),
    // 常驻：任务结束或用户主动关闭才消失。
    durationMs: 0,
    /*
     * 点通知要回到**具体某条任务**所在的对话：只给 serverId 的话，用户停在
     * 别的工作区时点开只会看到一个空白入口。第一条件任务就是入口。
     */
    action: first.serverId
      ? {
          kind: "extreme",
          serverId: first.serverId,
          server: first.server,
          taskId: first.id,
          workspaceId: first.workspaceId,
        }
      : { kind: "none" },
  });
}

export function ensureCollapseNotice(): void {
  if (installed) return;
  installed = true;

  void listen("app:collapsed", () => notifyCollapsed()).catch((error) => {
    console.warn("[desktop-notification] collapse listener failed", error);
  });

  // 兜底：某些平台最小化时不一定发 Resized 事件，页面可见性变化同样算收起。
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      notifyCollapsed();
      return;
    }
    // 回到前台：下一次收起重新提醒一次（而不是叠加）。
    announced = false;
  });
  window.addEventListener("focus", () => {
    announced = false;
  });

  // 任务全部结束：那条"还有任务"的提醒自动收回。
  useExtremeStore.subscribe((state) => {
    const running = Object.values(state.tasks).some(
      (task) => task.status === "running" || task.status === "waiting",
    );
    if (!running) dismissDesktopNotification(COLLAPSE_NOTICE_ID);
  });
}
