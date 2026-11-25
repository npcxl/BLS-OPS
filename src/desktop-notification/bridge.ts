/**
 * 主窗口 ↔ 通知窗口的桥（主窗口侧）。
 *
 * 通知窗口是固定大小的池（[`MAX_VISIBLE`] 个槽，见 Rust 的
 * `desktop_notification.rs`）：主窗口只管推数据和关某一条，排列、间距、
 * 补位、排队全部由原生管理器做。浏览器预览（没有 Tauri）直接跳过。
 */
import * as tauriCore from "@tauri-apps/api/core";

const { invoke } = tauriCore;

/**
 * Tauri 能力探测。
 *
 * 测试与浏览器预览里 `@tauri-apps/api/core` 常被**部分 mock**（只有 `invoke` /
 * `Channel`）：直接解构 `isTauri` 会拿到 `undefined`，一调就抛错 —— 而这段代码
 * 在模块顶层执行，等于整个 import 链崩掉。这里统一退化成"不是 Tauri"。
 */
function isTauri(): boolean {
  try {
    const probe = (tauriCore as { isTauri?: () => boolean }).isTauri;
    return typeof probe === "function" ? probe() : false;
  } catch {
    return false;
  }
}

import type { DesktopNotificationTone } from "@/components/ui/desktop-notification";

/**
 * 点击通知后由主窗口执行的动作。
 *
 * 原生侧只负责把它原样转回来（`desktop-notification:activate`），
 * 具体做什么由主窗口的 `activate.ts` 分派。
 */
export type DesktopNotificationAction =
  | { kind: "update" }
  | {
      kind: "extreme";
      serverId: string;
      server?: string | null;
      /** 结果通知：点开后定位到这条任务。 */
      taskId?: string;
      workspaceId?: string | null;
    }
  | { kind: "none" };

export interface DesktopNotificationPayload {
  /** 同一 id 重复推送会就地替换（不新建窗口、不改变位置）。 */
  id: string;
  title: string;
  body?: string;
  source?: string;
  meta?: string;
  time?: string;
  tone?: DesktopNotificationTone;
  /** 停留时长（毫秒）；`0` = 常驻，缺省 = 前端默认 6s。 */
  durationMs?: number;
  /** 点击整张卡片时执行的动作。 */
  action?: DesktopNotificationAction;
  /**
   * 卡片上的操作按钮（审批用）。
   *
   * 只是「标签 + 键」：点了由通知窗口把 `key` 转给主窗口，真正的审批仍在
   * 主窗口走同一个 `agent_approve`。
   */
  buttons?: { key: string; label: string }[];
}

/** 只准备一次：重复调用会浪费 IPC，也可能和正在创建的那批窗口抢主线程。 */
let prepared = false;

/** 预创建窗口池（隐藏）。主窗口挂载后调一次。 */
export function prepareDesktopNotificationWindows(): void {
  if (prepared || !isTauri()) return;
  prepared = true;
  void invoke("desktop_notification_prepare").catch((error) => {
    // 预创建失败不影响推送：push 里还会再确保一次。
    console.warn("[desktop-notification] prepare failed", error);
  });
}

/** 推一条通知给原生管理器：有空槽就显示，没有就排队。 */
export function pushDesktopNotification(payload: DesktopNotificationPayload): void {
  if (!isTauri()) return;
  void invoke("desktop_notification_push", { payload }).catch((error) => {
    console.warn("[desktop-notification] push failed", error);
  });
}

/** 关掉一条（点关闭、计时到点，或业务方主动收回）。 */
export function dismissDesktopNotification(id: string): void {
  if (!isTauri()) return;
  void invoke("desktop_notification_dismiss", { id }).catch(() => undefined);
}

/**
 * 撤下所有超能通知，并清掉仍在等待显示的队列。
 *
 * 主窗口回到前台时调用：单个 dismiss 只清掉已占槽的那条，队列里的会在槽位
 * 空出来时补上 —— 那正是"关了一条，又冒出一条旧结果"的来源。
 */
export function clearExtremeNotifications(): void {
  if (!isTauri()) return;
  void invoke("desktop_notification_clear_extreme").catch(() => undefined);
}

/** 点击通知：原生侧把 action 转给主窗口，由 `activate.ts` 执行。 */
export function activateDesktopNotification(id: string): void {
  if (!isTauri()) return;
  void invoke("desktop_notification_activate", { id }).catch(() => undefined);
}

/**
 * 通知上的审批按钮：把 `key` 转给主窗口。
 *
 * **不在这里关闭通知**：主窗口会把同 id 的通知更新成「已允许 / 已拒绝」，
 * 由新 payload 的 `durationMs` 自己到期 —— 否则用户点完只看到通知消失。
 */
export function decideDesktopNotification(id: string, key: string): void {
  if (!isTauri()) return;
  void invoke("desktop_notification_decide", { id, key }).catch(() => undefined);
}

/**
 * 验收用：在主窗口 DevTools 里给通知塞合成测试图（不同位置的竖线）。
 *
 * `__blsNotifyDebug.texture(0)`、`__blsNotifyDebug.texture(1)`：验证"同一位置
 * 换图，纹理更新且玻璃不消失"。调用后真实采集会暂停，重新推送通知恢复。
 */
if (import.meta.env.DEV && isTauri()) {
  (window as unknown as { __blsNotifyDebug?: unknown }).__blsNotifyDebug = {
    texture: (step: number) => {
      void invoke("desktop_notification_debug_texture", { step });
    },
  };
}
