/**
 * 一次**发起**的归属快照：后续动作（上传 / 计划 / 执行 / 终端）只认这份数据。
 *
 * # 为什么不能再读渲染闭包
 *
 * 等待右栏探测、等终端输出、等模型回话都是异步的。回来时界面可能已经切到
 * 另一条对话、甚至另一台服务器；那时 `execRef.current` 里的执行器用的是**新**
 * 闭包 —— A 的上传会读到 B 的附件，A 的命令会发到 B 的连接上。
 *
 * 所以发起时就把「哪条对话、哪台服务器、哪次连接、第几号请求」以及**真正要用
 * 的附件 / 计划 / 候选服务**记下来，执行器全部从这份快照取值。
 *
 * # 每一步之前都要核对
 *
 * 原连接断开、服务器变了、计划失效时，这一步**暂停**并把原因写回原对话；
 * 绝不用当前前台对话的连接顶替。
 */
import type { ExtremeAttachment } from "@/stores/extreme-store";
import type { CheckItem } from "./checks";
import type { ContextMode, OutputStyle, PickedContext } from "./chat-context";
import type { DeployStep } from "./deploy-plan";
import type { PermissionMode } from "./permissions";
import type { PreflightResult } from "./preflight";
import type { ServiceCandidate } from "./update-plan";

/** 发起时的一份输入偏好快照（之后改选只影响下一条）。 */
export interface ScopePrefs {
  context: ContextMode;
  output: OutputStyle;
  picked: PickedContext[];
}

export interface ActionScope {
  /** 发起它的对话：所有回写按它落库。 */
  workspaceId: string;
  /** 服务器配置 id；`null` = 临时连接（只能靠 sessionId 认）。 */
  serverId: string | null;
  server: string;
  /** 发起时的那条 SSH 连接。 */
  sessionId: string;
  /** 这条对话里的请求版本（B 的请求不会让 A 的后续动作失效）。 */
  requestId: number;
  /** 这次请求的任务 id：动作链、回执与历史都挂在它下面。 */
  taskId?: string;
  /** 发起时取到的家目录（上传临时目录要用）。 */
  home: string | null;
  permission: PermissionMode;
  preflight: PreflightResult | null;
  envChecks: CheckItem[];
  /** 真正要用的附件（不是"现在屏幕上勾着的"）。 */
  attachments: ExtremeAttachment[];
  prefs: ScopePrefs;
  focusId: string | null;
  selectedAttachmentIds: string[];
  /** 发起时的计划版本。 */
  plan: DeployStep[] | null;
  planSession: string | null;
  planTaskId: string | null;
  /** 发起时已知的服务候选（为空时执行器可以再探一次，用同一连接）。 */
  candidates: ServiceCandidate[] | null;
  /** 这条对话在服务器上的临时工作目录（上传后由执行器补上）。 */
  remoteRoot?: string | null;
}

/** 归属核对要看的当前世界（从 store 现读，不用渲染闭包）。 */
export interface ScopeWorld {
  workspaceId: string | null;
  sessionId: string | null;
  workspaces: { id: string; serverId: string | null }[];
  connections: Record<string, { sessionId: string } | undefined>;
}

/**
 * 这一步为什么不能继续。
 *
 * * `workspace-missing` —— 原对话已被删除；
 * * `no-server` —— 原对话没有关联任何服务器（没有可用的执行目标）；
 * * `disconnected` —— 原服务器的连接已经断开；
 * * `reconnected` —— 连接已重建（sessionId 变了），旧动作不能落到新连接上。
 */
export type ScopeBlocker = "workspace-missing" | "no-server" | "disconnected" | "reconnected";

export type ScopeCheck = { ok: true } | { ok: false; reason: ScopeBlocker };

const OK: ScopeCheck = { ok: true };

/** 归属还在不在、连接还是不是发起时那条。 */
export function checkScope(scope: ActionScope, world: ScopeWorld): ScopeCheck {
  const entry = world.workspaces.find((item) => item.id === scope.workspaceId);
  if (!entry) return { ok: false, reason: "workspace-missing" };
  if (!scope.sessionId) return { ok: false, reason: "disconnected" };

  if (!entry.serverId) {
    // 临时连接没有配置 id：只能确认"当前仍绑着同一条连接"。
    if (scope.serverId) return { ok: false, reason: "no-server" };
    return world.sessionId === scope.sessionId
      ? OK
      : { ok: false, reason: scope.sessionId ? "reconnected" : "disconnected" };
  }

  if (scope.serverId && entry.serverId !== scope.serverId) {
    // 对话被重新绑到另一台服务器上：旧动作属于上一台。
    return { ok: false, reason: "no-server" };
  }

  const live = world.connections[entry.serverId];
  if (!live) return { ok: false, reason: "disconnected" };
  if (live.sessionId !== scope.sessionId) return { ok: false, reason: "reconnected" };
  return OK;
}

/** 快照所属对话是否正显示在眼前（只有这时才允许动右栏 / 焦点 / 计划镜像）。 */
export function scopeForeground(scope: ActionScope, world: Pick<ScopeWorld, "workspaceId">): boolean {
  return Boolean(scope.workspaceId) && world.workspaceId === scope.workspaceId;
}

/** 计划快照是否仍然有效：生成计划与执行必须是同一条连接。 */
export function planValidFor(scope: ActionScope): boolean {
  return Boolean(scope.plan?.length) && scope.planSession === scope.sessionId;
}

/** 归属原因 → 一句人话（写回原对话 / 提示条）。 */
export function explainBlocker(
  reason: ScopeBlocker,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (reason) {
    case "workspace-missing":
      return t("这条对话已经不在了，这一步没有执行。");
    case "no-server":
      return t("这条对话没有关联服务器，这一步没有执行。");
    case "reconnected":
      return t("这条对话的服务器连接已经重建，这一步停在原地：回到原对话重新确认后再继续。");
    default:
      return t("这条对话的服务器连接已断开，这一步停在原地：重新连接后再继续。");
  }
}
