/**
 * 审批 → 桌面通知。
 *
 * # 什么时候出现
 *
 * 只有**应用已经收起**（最小化 / 收进托盘 / 页面不可见）**且**有操作在等确认
 * 时才推这条通知。先出现确认条、随后收起应用也会补发一次（`sync` 里记着当前
 * 那几条，收起时直接重推）。
 *
 * # 多条并存
 *
 * A、B 两条对话可能同时等确认。这里按 `taskId|callId` 分别记一条，各自推、
 * 各自收：处理 A 不会把 B 的通知撤掉。主窗口每次把**完整的待确认列表**同步
 * 过来，不在列表里的才收起。
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
  clearExtremeNotifications,
  dismissDesktopNotification,
  pushDesktopNotification,
  type DesktopNotificationPayload,
} from "@/desktop-notification/bridge";
import { isWindowHidden, setCollapsed } from "@/desktop-notification/visibility";
import { notificationAllowed } from "@/stores/extreme-settings-store";

export type ApprovalNoticePhase = "pending" | "sending" | "allowed" | "denied" | "failed";

export interface ApprovalNotice {
  /**
   * 所属运行。`callId` 只在一次运行内唯一（`call-0-0` 会重复），
   * 通知 id 必须带 taskId，否则两条任务的确认会抢同一个槽。
   */
  taskId: string;
  /** 本次运行里的审批标识。 */
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
  decide: (taskId: string, callId: string, allow: boolean) => void | Promise<void>;
  /** 点通知正文：把主窗口叫回前台。 */
  open: () => void;
}

const ID_PREFIX = "extreme-approval-";
/** 已处理的通知留一会儿再收：让用户看到"确实生效了"。 */
const RESOLVED_MS = 4000;

let handlers: ApprovalHandlers | null = null;
/** 当前**所有**待确认 / 刚处理的通知（id → 内容）。 */
let current = new Map<string, ApprovalNotice>();
/** 已经推给原生层的 id（`null` 语义由空 Map 表达）。 */
let shown = new Set<string>();
let installed = false;

function notificationId(taskId: string, callId: string): string {
  return `${ID_PREFIX}${encodeURIComponent(taskId)}|${encodeURIComponent(callId)}`;
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

/** 收起所有已显示的通知（应用回到前台时用）。 */
function dismissShown(): void {
  for (const id of shown) dismissDesktopNotification(id);
  shown = new Set();
}

/** 收起所有当前显示的通知；审批本身仍留着，下次收起还能补发。 */
export function hideApprovalNotification(): void {
  dismissShown();
}

/** 通知 id → (taskId, callId)；格式不对返回 null。 */
function parseNotificationId(id: string): { taskId: string; callId: string } | null {
  if (!id.startsWith(ID_PREFIX)) return null;
  const [taskId, callId] = id.slice(ID_PREFIX.length).split("|");
  if (!taskId || !callId) return null;
  return { taskId: decodeURIComponent(taskId), callId: decodeURIComponent(callId) };
}

/**
 * 把**整份**待确认列表同步到通知。
 *
 * 应用在前台时**不推**（确认条就在输入框上方）；已经推过的会被收起。
 * 不在列表里的（已撤回 / 任务结束）逐条 dismiss —— 同一条重复推送只替换内容，
 * 不会新开窗口。
 */
export function syncApprovalNotifications(
  notices: ApprovalNotice[],
  t: (key: string, options?: Record<string, unknown>) => string,
): void {
  if (!installed) return;
  const wanted = new Map<string, ApprovalNotice>();
  for (const notice of notices) wanted.set(notificationId(notice.taskId, notice.callId), notice);
  current = wanted;

  // 已经不在列表里的：立刻收起（撤回 / 任务结束）。
  for (const id of [...shown]) {
    if (wanted.has(id)) continue;
    dismissDesktopNotification(id);
    shown.delete(id);
  }

  if (!isWindowHidden() || !notificationAllowed("approval")) {
    // 前台 / 用户关掉了审批通知：确认条已在会话里，通知不该同时可点。
    dismissShown();
    return;
  }

  for (const [id, notice] of wanted) {
    shown.add(id);
    pushDesktopNotification({ id, ...compose(notice, t) });
  }
}

/**
 * 单条版本（兼容旧调用 / 单测）：语义与"只有这一条待确认"一致。
 */
export function syncApprovalNotification(
  notice: ApprovalNotice | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): void {
  syncApprovalNotifications(notice ? [notice] : [], t);
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

  // 启动先把上一轮遗留的超能通知（含还在排队的）清掉：历史任务不该在此时补发。
  clearExtremeNotifications();
  shown = new Set();

  const disposers: (() => void)[] = [];

  void listen("app:collapsed", () => {
    setCollapsed(true);
    if (!notificationAllowed("approval")) return;
    // 先有确认条、后收起：**每一条**都补发一次。
    for (const [id, notice] of current) {
      shown.add(id);
      pushDesktopNotification({ id, ...compose(notice, t) });
    }
  })
    .then((unlisten) => disposers.push(unlisten))
    .catch(() => undefined);

  const onVisibility = () => {
    if (!document.hidden) {
      setCollapsed(false);
      // 回到前台：确认条已经在眼前了；排队的旧结果也不再补弹。
      dismissShown();
      clearExtremeNotifications();
      return;
    }
    if (!notificationAllowed("approval")) return;
    for (const [id, notice] of current) {
      shown.add(id);
      pushDesktopNotification({ id, ...compose(notice, t) });
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  disposers.push(() => document.removeEventListener("visibilitychange", onVisibility));

  // 通知按钮：只把决定转回主窗口，真正的 approve 仍在主窗口做。
  void listen<{ id: string; key: string }>(
    "desktop-notification:decide",
    (event) => {
      const { id, key } = event.payload ?? {};
      const parsed = id ? parseNotificationId(id) : null;
      if (!parsed || !id) return;
      // 只处理**当前仍在列表里**的那一条：过期 / 已处理的通知点了不动。
      const notice = current.get(id);
      if (!notice) return;
      if (notice.taskId !== parsed.taskId || notice.callId !== parsed.callId) return;
      void handlers?.decide(parsed.taskId, parsed.callId, key === "allow");
    },
  )
    .then((unlisten) => disposers.push(unlisten))
    .catch(() => undefined);

  // 点正文：回到会话看完整命令。通知本身留着，用户回来自己处理。
  void listen<{ id: string }>("desktop-notification:activate", (event) => {
    const id = event.payload?.id;
    if (!id?.startsWith(ID_PREFIX)) return;
    // 窗口被叫回来了：后续状态直接在确认条上更新，不再往通知里推。
    setCollapsed(false);
    clearExtremeNotifications();
    handlers?.open();
    void revealMainWindow();
  })
    .then((unlisten) => disposers.push(unlisten))
    .catch(() => undefined);

  // 用户自己把窗口点回前台（没走通知）时同样算"不再收起"。
  const onFocus = () => {
    setCollapsed(false);
    dismissShown();
    // 主窗口回来了：超能任务 / 审批通知（包括队列）一并撤下。
    clearExtremeNotifications();
  };
  window.addEventListener("focus", onFocus);
  disposers.push(() => window.removeEventListener("focus", onFocus));

  return () => {
    handlers = null;
    installed = false;
    current = new Map();
    shown = new Set();
    // 卸载后没有监听再把状态翻回来：别把"收起"留给下一次进入。
    setCollapsed(false);
    for (const dispose of disposers) dispose();
  };
}
