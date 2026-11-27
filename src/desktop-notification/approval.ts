/**
 * 审批 → 桌面通知。
 *
 * # 什么时候出现
 *
 * 只有**应用已经收起**（最小化 / 收进托盘 / 页面不可见）**且**这条审批仍在
 * 等用户处理时才推。先出现确认条、随后收起应用会补发一次；前后台来回切换
 * 不会把同一条重复推出来。
 *
 * # 哪些审批算"仍需处理"
 *
 * `pending` / `sending` / `failed`（没送到后端，可以再试）。已允许 / 已拒绝 /
 * 已撤回 / 已过期 / 任务已结束的一律不算：它们不是"等你确认"，只是在通知里
 * 把已显示的那条就地更新成结果。
 *
 * # 幂等
 *
 * `app:collapsed` 与 `visibilitychange` 可能同一时刻都来：进入后台时**只**
 * 递增一次周期号，同一周期内每条审批最多新建一条通知；后续状态变化按同 id
 * 就地更新（原生侧同 id 复用槽位）。
 *
 * # 多条并存
 *
 * A、B 两条对话可能同时等确认。这里按 `taskId|callId` 分别记一条，各自推、
 * 各自收；主窗口每次把**完整的待确认列表**同步过来，不在列表里的才收起。
 *
 * # 两处同步
 *
 * 通知窗口是独立 WebView，没有超能模式的状态；按钮点击只把 `key` 转回主窗口，
 * 由主窗口调用**同一个** `agent_approve`。任一处提交成功后，主窗口把同一 id 的
 * 通知更新成「已允许 / 已拒绝」，另一边立刻看到结果。
 *
 * # 关闭 ≠ 处理
 *
 * 右上角的 × 只关通知（`dismiss`），审批仍挂在会话里等用户回来处理；同一次
 * 收起周期内不重复弹，回到前台再收起会重新提醒一次仍然有效的那条。
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
  /**
   * 归属：点通知要回到**这条任务所在的对话**。
   *
   * 只带 serverId 时用户可能停在别的工作区，点开只看到一个空白入口 ——
   * 从用户视角就是"通知串到别的会话去了"。
   */
  serverId?: string | null;
  workspaceId?: string | null;
  /** 首屏影响（已经过后端归一；未知时是一句实话）。 */
  impact: string;
  risk: "write" | "danger";
  phase: ApprovalNoticePhase;
  /** `phase === "failed"` 的原因。 */
  failure?: string | null;
  /** 已表态 / 已撤回：不再作为"等你处理"提醒，只更新已显示的那条。 */
  closed?: boolean;
  /** 等待截止时刻（毫秒时间戳）；缺失时不做本地过期判断。 */
  deadline?: number;
}

interface ApprovalHandlers {
  /** 与点确认条走同一个流程：`allow` 为真表示允许本次。 */
  decide: (taskId: string, callId: string, allow: boolean) => void | Promise<void>;
  /** 点通知正文：把主窗口叫回前台。 */
  open: () => void;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

const ID_PREFIX = "extreme-approval-";
/** 已处理的通知留一会儿再收：让用户看到"确实生效了"。 */
const RESOLVED_MS = 4000;

/** 仍然需要用户处理的阶段。 */
const ACTIVE_PHASES = new Set<ApprovalNoticePhase>(["pending", "sending", "failed"]);

let handlers: ApprovalHandlers | null = null;
let translate: Translate = (key) => key;
/** 当前**所有**审批（含刚处理的）：决定收起 / 更新，不直接决定推送。 */
let current = new Map<string, ApprovalNotice>();
/** 已经推给原生层的 id → 最后一次推送的内容指纹。 */
let shown = new Map<string, string>();
/** 是否处于后台（`app:collapsed` 与 `visibilitychange` 合并后的状态）。 */
let background = false;
/** 后台周期号：每次真正从"前台 → 后台"递增一次。 */
let backgroundCycle = 0;
/** 每个 id 在哪个后台周期提示过：同一周期不重复新建。 */
let pushedInCycle = new Map<string, number>();
let installed = false;

function notificationId(taskId: string, callId: string): string {
  return `${ID_PREFIX}${encodeURIComponent(taskId)}|${encodeURIComponent(callId)}`;
}

function serverLine(notice: ApprovalNotice, t: Translate): string {
  return notice.server ? t("服务器：{{server}}", { server: notice.server }) : "";
}

/**
 * 点击整张通知要去的对话。
 *
 * 归属完整（serverId）时回到原任务；缺 serverId 时退化成"只唤回主窗口"，
 * 不猜一个服务器把用户丢到错误的任务里。
 */
function openAction(
  notice: ApprovalNotice,
): DesktopNotificationPayload["action"] {
  if (!notice.serverId) return { kind: "none" };
  return {
    kind: "extreme",
    serverId: notice.serverId,
    server: notice.server,
    taskId: notice.taskId,
    workspaceId: notice.workspaceId,
  };
}

/** 还在等用户处理：没关闭、阶段有效、没到截止时刻。 */
function isActive(notice: ApprovalNotice, now = Date.now()): boolean {
  if (notice.closed) return false;
  if (!ACTIVE_PHASES.has(notice.phase)) return false;
  if (
    typeof notice.deadline === "number" &&
    notice.deadline > 0 &&
    notice.deadline <= now
  ) {
    return false;
  }
  return true;
}

/** 内容指纹：只在真正变了的时候才重推（同 id 原生侧就地替换）。 */
function signatureOf(notice: ApprovalNotice): string {
  return [
    notice.phase,
    notice.closed ? "1" : "0",
    notice.failure ?? "",
    notice.operation,
    notice.impact,
    notice.risk,
    notice.server ?? "",
    notice.serverId ?? "",
    notice.workspaceId ?? "",
    notice.deadline ?? "",
  ].join("\u0001");
}

/** 一条通知显示什么：标题 / 正文 / 按钮 / 停留时长。 */
function compose(
  notice: ApprovalNotice,
  t: Translate,
): Omit<DesktopNotificationPayload, "id"> {
  const where = serverLine(notice, t);
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
        action: openAction(notice),
      };
    case "allowed":
      return {
        source: t("超能模式 · 已处理"),
        tone: "success",
        title: t("已允许 · 正在执行"),
        body: [notice.operation, where].filter(Boolean).join("\n"),
        durationMs: RESOLVED_MS,
        action: openAction(notice),
      };
    case "denied":
      return {
        source: t("超能模式 · 已处理"),
        tone: "info",
        title: t("已拒绝 · 此步骤未执行"),
        body: [notice.operation, where].filter(Boolean).join("\n"),
        durationMs: RESOLVED_MS,
        action: openAction(notice),
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
        action: openAction(notice),
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
        action: openAction(notice),
      };
  }
}

/** 推一条 / 就地更新一条；内容没变就不发 IPC。 */
function publish(id: string, notice: ApprovalNotice): void {
  const signature = signatureOf(notice);
  if (shown.get(id) === signature) return;
  shown.set(id, signature);
  pushDesktopNotification({ id, ...compose(notice, translate) });
}

/** 收起所有已显示的通知（应用回到前台时用）。 */
function dismissShown(): void {
  for (const id of shown.keys()) dismissDesktopNotification(id);
  shown = new Map();
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
 * 进入后台：只有**真正从可见变为不可见**才开启新周期。
 *
 * `app:collapsed` 与 `visibilitychange` 会在一次收起的几毫秒内都触发；
 * 用同一个周期号把"同一条审批只提醒一次"守住。
 */
function enterBackground(): void {
  if (background) return;
  background = true;
  backgroundCycle += 1;
  pushedInCycle = new Map();
}

/** 回到前台：撤下通知并结束当前周期；审批本身不动。 */
function leaveBackground(): void {
  background = false;
  dismissShown();
  pushedInCycle.clear();
}

/** 后台周期内：把仍然有效的审批各提示一次（已显示 / 本周期提示过的不重复）。 */
function pushActive(now = Date.now()): void {
  if (!notificationAllowed("approval")) return;
  for (const [id, notice] of current) {
    if (!isActive(notice, now)) continue;
    if (shown.has(id)) {
      publish(id, notice);
      continue;
    }
    if (pushedInCycle.get(id) === backgroundCycle) continue;
    pushedInCycle.set(id, backgroundCycle);
    publish(id, notice);
  }
}

/**
 * 把**整份**待确认列表同步到通知。
 *
 * 应用在前台时**不推**（确认条就在输入框上方）；已经推过的会被收起。
 * 不在列表里的（已撤回 / 任务结束）逐条 dismiss；同一条重复推送只替换内容，
 * 不会新开窗口。
 */
export function syncApprovalNotifications(
  notices: ApprovalNotice[],
  t: Translate,
): void {
  translate = t;
  const wanted = new Map<string, ApprovalNotice>();
  for (const notice of notices) wanted.set(notificationId(notice.taskId, notice.callId), notice);
  current = wanted;

  // 已经不在列表里的：立刻收起（撤回 / 任务结束）。
  for (const id of [...shown.keys()]) {
    if (wanted.has(id)) continue;
    dismissDesktopNotification(id);
    shown.delete(id);
  }

  if (!isWindowHidden() || !notificationAllowed("approval")) {
    // 前台 / 用户关掉了审批通知：确认条已在会话里，通知不该同时可点。
    // 这里同时结束后台周期：下次收起要重新提醒仍然有效的那条。
    leaveBackground();
    return;
  }

  enterBackground();
  const now = Date.now();
  for (const [id, notice] of wanted) {
    if (!isActive(notice, now)) {
      // 已允许 / 已拒绝 / 已过期：**不新建**，只把已经显示的那条更新成结果。
      if (shown.has(id)) publish(id, notice);
      continue;
    }
    if (shown.has(id)) {
      publish(id, notice);
      continue;
    }
    if (pushedInCycle.get(id) === backgroundCycle) continue;
    pushedInCycle.set(id, backgroundCycle);
    publish(id, notice);
  }
}

/**
 * 单条版本（兼容旧调用 / 单测）：语义与"只有这一条待确认"一致。
 */
export function syncApprovalNotification(notice: ApprovalNotice | null, t: Translate): void {
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
 * 已安装时只更新 handlers / 翻译函数，**不重复注册**监听（切换页面、语言变化
 * 都不该叠加监听器）。返回清理函数：只有真正由这次安装注册的监听会被移除。
 */
export function installApprovalNotifications(next: ApprovalHandlers, t: Translate): () => void {
  handlers = next;
  translate = t;
  if (installed) return () => undefined;
  installed = true;
  let disposed = false;
  const disposers: (() => void)[] = [];
  const track = (pending: Promise<() => void>) => {
    void pending
      .then((unlisten) => {
        if (disposed) unlisten();
        else disposers.push(unlisten);
      })
      .catch(() => undefined);
  };

  // 启动先把上一轮遗留的超能通知（含还在排队的）清掉：历史任务不该在此时补发。
  clearExtremeNotifications();
  shown = new Map();
  background = false;
  pushedInCycle = new Map();

  track(
    listen("app:collapsed", () => {
      setCollapsed(true);
      if (!notificationAllowed("approval")) return;
      enterBackground();
      // 先有确认条、后收起：**仍然有效的每一条**补发一次（同周期不重复）。
      pushActive();
    }),
  );

  const onVisibility = () => {
    if (!document.hidden) {
      setCollapsed(false);
      leaveBackground();
      // 回到前台：确认条已经在眼前了；排队的旧结果也不再补弹。
      clearExtremeNotifications();
      return;
    }
    setCollapsed(true);
    if (!notificationAllowed("approval")) return;
    enterBackground();
    pushActive();
  };
  document.addEventListener("visibilitychange", onVisibility);
  disposers.push(() => document.removeEventListener("visibilitychange", onVisibility));

  // 通知按钮：只把决定转回主窗口，真正的 approve 仍在主窗口做。
  track(
    listen<{ id: string; key: string }>("desktop-notification:decide", (event) => {
      const { id, key } = event.payload ?? {};
      const parsed = id ? parseNotificationId(id) : null;
      if (!parsed || !id) return;
      // 只处理**当前仍在等待**的那一条：已处理 / 过期 / 已撤下的通知点了不动。
      const notice = current.get(id);
      if (!notice) return;
      if (notice.taskId !== parsed.taskId || notice.callId !== parsed.callId) return;
      if (!isActive(notice)) return;
      void handlers?.decide(parsed.taskId, parsed.callId, key === "allow");
    }),
  );

  // 点正文：回到会话看完整命令。通知本身留着，用户回来自己处理。
  track(
    listen<{ id: string }>("desktop-notification:activate", (event) => {
      const id = event.payload?.id;
      if (!id?.startsWith(ID_PREFIX)) return;
      // 窗口被叫回来了：后续状态直接在确认条上更新，不再往通知里推。
      setCollapsed(false);
      leaveBackground();
      clearExtremeNotifications();
      handlers?.open();
      void revealMainWindow();
    }),
  );

  // 用户自己把窗口点回前台（没走通知）时同样算"不再收起"。
  const onFocus = () => {
    setCollapsed(false);
    leaveBackground();
    // 主窗口回来了：超能任务 / 审批通知（包括队列）一并撤下。
    clearExtremeNotifications();
  };
  window.addEventListener("focus", onFocus);
  disposers.push(() => window.removeEventListener("focus", onFocus));

  return () => {
    disposed = true;
    if (handlers === next) handlers = null;
    installed = false;
    current = new Map();
    shown = new Map();
    background = false;
    pushedInCycle = new Map();
    // 卸载后没有监听再把状态翻回来：别把"收起"留给下一次进入。
    setCollapsed(false);
    for (const dispose of disposers) dispose();
    disposers.length = 0;
  };
}
