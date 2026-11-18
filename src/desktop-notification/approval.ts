/**
 * 审批 → 桌面通知。
 *
 * # 什么时候出现
 *
 * 只有**应用已经收起**（最小化 / 收进托盘 / 页面不可见）**且**有操作在等确认
 * 时才推这条通知。先出现确认条、随后收起应用也会补发一次（`sync` 里记着当前
 * 那条，收起时直接重推）。
 *
 * # 两处同步
 *
 * 通知窗口是独立 WebView，没有超能模式的状态；按钮点击只把 `key` 转回主窗口，
 * 由主窗口调用**同一个** `agent_approve`。任一处提交成功后，主窗口把同一 id 的
 * 通知更新成「已允许 / 已拒绝」，另一边立刻看到结果。
 *
 * # 关闭 ≠ 处理
 *
 * 右上角的 × 只关通知（`dismiss`），审批仍挂在会话里等用户回来处理。
 */
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  dismissDesktopNotification,
  pushDesktopNotification,
  type DesktopNotificationPayload,
} from "@/desktop-notification/bridge";

export type ApprovalNoticePhase = "pending" | "sending" | "allowed" | "denied" | "failed";

export interface ApprovalNotice {
  /** 审批的唯一标识（后端 `callId`）：同一条审批只占一个通知槽。 */
  callId: string;
  /** 一句话操作，例如「重载 Nginx」。 */
  operation: string;
  server?: string;
  /** 首屏影响（已经过后端归一；未知时是一句实话）。 */
  impact: string;
  risk: "write" | "danger";
  phase: ApprovalNoticePhase;
  /** `phase === "failed"` 的原因。 */
  failure?: string | null;
}

interface ApprovalHandlers {
  /** 与点确认条走同一个流程：`allow` 为真表示允许本次。 */
  decide: (callId: string, allow: boolean) => void | Promise<void>;
  /** 点通知正文：把主窗口叫回前台。 */
  open: () => void;
}

const ID_PREFIX = "extreme-approval-";
/** 已处理的通知留一会儿再收：让用户看到"确实生效了"。 */
const RESOLVED_MS = 4000;

let handlers: ApprovalHandlers | null = null;
let current: ApprovalNotice | null = null;
/** 当前显示在通知里的那条 id（`null` = 当前没有我们的通知）。 */
let shownId: string | null = null;
let collapsed = false;
let installed = false;

function notificationId(callId: string): string {
  return `${ID_PREFIX}${callId}`;
}

function isHidden(): boolean {
  return collapsed || document.hidden;
}

function serverLine(notice: ApprovalNotice): string {
  return notice.server ? `服务器：${notice.server}` : "";
}

/** 一条通知显示什么：标题 / 正文 / 按钮 / 停留时长。 */
function compose(
  notice: ApprovalNotice,
  t: (key: string, options?: Record<string, unknown>) => string,
): Omit<DesktopNotificationPayload, "id"> {
  const where = serverLine(notice);
  const buttons = [
    { key: "deny", label: t("拒绝执行") },
    { key: "allow", label: t("允许本次") },
  ];
  switch (notice.phase) {
    case "sending":
      return {
        source: t("超能模式 · 需要确认"),
        tone: "warning",
        title: t("确认{{what}}", { what: notice.operation }),
        body: t("正在提交…"),
        durationMs: 0,
        action: { kind: "none" },
      };
    case "allowed":
      return {
        source: t("超能模式 · 已处理"),
        tone: "success",
        title: t("已允许 · 正在执行"),
        body: [notice.operation, where].filter(Boolean).join("\n"),
        durationMs: RESOLVED_MS,
        action: { kind: "none" },
      };
    case "denied":
      return {
        source: t("超能模式 · 已处理"),
        tone: "info",
        title: t("已拒绝 · 此步骤未执行"),
        body: [notice.operation, where].filter(Boolean).join("\n"),
        durationMs: RESOLVED_MS,
        action: { kind: "none" },
      };
    case "failed":
      return {
        source: t("超能模式 · 需要确认"),
        tone: "danger",
        title: t("确认没有送达"),
        body: [
          t("{{reason}}。可以再试一次。", {
            reason: notice.failure?.trim() || t("连接中断"),
          }),
          where,
        ]
          .filter(Boolean)
          .join("\n"),
        durationMs: 0,
        buttons,
        action: { kind: "none" },
      };
    default:
      return {
        source: t("超能模式 · 需要确认"),
        tone: notice.risk === "danger" ? "danger" : "warning",
        title: t("确认{{what}}", { what: notice.operation }),
        body: [notice.impact, where, t("5 分钟内未确认，任务将自动停止。")]
          .filter(Boolean)
          .join("\n"),
        // 常驻：必须由用户处理，或者任务自己结束。
        durationMs: 0,
        buttons,
        action: { kind: "none" },
      };
  }
}

function push(
  notice: ApprovalNotice,
  t: (key: string, options?: Record<string, unknown>) => string,
): void {
  const id = notificationId(notice.callId);
  shownId = id;
  pushDesktopNotification({ id, ...compose(notice, t) });
}

/**
 * 把当前审批状态同步到通知。
 *
 * 应用在前台时**不推**（确认条就在输入框上方）；已经推过的会被收起 ——
 * 同一个审批不该同时出现两处"可以点"的按钮。
 */
export function syncApprovalNotification(
  notice: ApprovalNotice | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): void {
  if (!installed) return;
  current = notice;

  if (!notice) {
    if (shownId) {
      dismissDesktopNotification(shownId);
      shownId = null;
    }
    return;
  }

  if (!isHidden()) {
    if (shownId) {
      dismissDesktopNotification(shownId);
      shownId = null;
    }
    return;
  }

  push(notice, t);
}

/**
 * 收起正在显示的那条通知（应用回到前台时用）。
 *
 * 只关通知，**不动** `current`：下次再收起应用时还要能补发。
 */
export function hideApprovalNotification(): void {
  if (!shownId) return;
  dismissDesktopNotification(shownId);
  shownId = null;
}

/** 把主窗口叫回前台（点通知正文时）。 */
async function revealMainWindow(): Promise<void> {
  try {
    const window = getCurrentWindow();
    await window.show();
    await window.unminimize();
    await window.setFocus();
  } catch {
    // 浏览器预览 / 没有窗口权限：忽略。
  }
}

/**
 * 装监听：收起、页面可见性、通知按钮、点正文。
 *
 * 返回清理函数（组件卸载时调用，避免重复注册）。
 */
export function installApprovalNotifications(
  next: ApprovalHandlers,
  t: (key: string, options?: Record<string, unknown>) => string,
): () => void {
  handlers = next;
  if (installed) return () => undefined;
  installed = true;

  const disposers: (() => void)[] = [];

  void listen("app:collapsed", () => {
    collapsed = true;
    // 先有确认条、后收起：补发一次。
    if (current) push(current, t);
  })
    .then((unlisten) => disposers.push(unlisten))
    .catch(() => undefined);

  const onVisibility = () => {
    if (!document.hidden) {
      collapsed = false;
      // 回到前台：确认条已经在眼前了。
      hideApprovalNotification();
      return;
    }
    if (current) push(current, t);
  };
  document.addEventListener("visibilitychange", onVisibility);
  disposers.push(() => document.removeEventListener("visibilitychange", onVisibility));

  // 通知按钮：只把决定转回主窗口，真正的 approve 仍在主窗口做。
  void listen<{ id: string; key: string }>(
    "desktop-notification:decide",
    (event) => {
      const { id, key } = event.payload ?? {};
      if (!id?.startsWith(ID_PREFIX)) return;
      const callId = id.slice(ID_PREFIX.length);
      if (!current || current.callId !== callId) return;
      void handlers?.decide(callId, key === "allow");
    },
  )
    .then((unlisten) => disposers.push(unlisten))
    .catch(() => undefined);

  // 点正文：回到会话看完整命令。通知本身留着，用户回来自己处理。
  void listen<{ id: string }>("desktop-notification:activate", (event) => {
    const id = event.payload?.id;
    if (!id?.startsWith(ID_PREFIX)) return;
    // 窗口被叫回来了：后续状态直接在确认条上更新，不再往通知里推。
    collapsed = false;
    handlers?.open();
    void revealMainWindow();
  })
    .then((unlisten) => disposers.push(unlisten))
    .catch(() => undefined);

  // 用户自己把窗口点回前台（没走通知）时同样算"不再收起"。
  const onFocus = () => {
    collapsed = false;
    hideApprovalNotification();
  };
  window.addEventListener("focus", onFocus);
  disposers.push(() => window.removeEventListener("focus", onFocus));

  return () => {
    handlers = null;
    installed = false;
    for (const dispose of disposers) dispose();
  };
}
