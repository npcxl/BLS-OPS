/**
 * 从超能之外进入超能模式。
 *
 * 超能的所有命令都跑在一条 SSH 连接上。首页与服务器右键菜单没有现成的终端
 * 标签，所以入口统一走这里：
 *
 * 1. 复用这台服务器上**已经连上**的会话（终端 / 监控 / 服务管理等都算）；
 * 2. 没有就建一条只跑命令的会话（无 PTY，不在服务器上占一个 shell）；
 * 3. 连上之后再 `enter`，首页指定的对话再 `openWorkspace` 切过去。
 *
 * 主机指纹照常交给全局 `useSessionStore` 的挑战流程，绝不静默信任。
 *
 * 同一台服务器上的并发入口只发起一次连接：首页连点两下不该在服务器上留
 * 两条会话。
 */
import { listen } from "@tauri-apps/api/event";
import { i18n } from "@/i18n";
import { opsApi, toErrorMessage } from "@/api/ops-api";
import type { ServerRecord } from "@/api/types/servers";
import { pushErrorToast } from "@/components/ui/toast";
import { sshClosedEvent } from "@/lib/events";
import { useDomainStore } from "@/stores/domain-store";
import { useExtremeStore } from "@/stores/extreme-store";
import { useSessionStore } from "@/stores/session-store";

export type ExtremeEntryServer = Pick<
  ServerRecord,
  "id" | "name" | "host" | "port" | "username" | "credential_id"
>;

export interface EnterExtremeOptions {
  /** 直接打开这条对话（首页最近对话）。 */
  workspaceId?: string;
  /**
   * 强制新建连接（超能里的「重新连接」）。
   *
   * 不复用仍标着 `connected` 的旧会话：它可能只是"还没收到断开事件"的死连接，
   * 复用它等于把新命令继续发进黑洞。
   */
  reconnect?: boolean;
}

/** 这台服务器上已经连上的会话（任何一个模块建的都算）。 */
export function connectedSessionFor(serverId: string): string | null {
  const sessions = useSessionStore.getState().sessions;
  for (const session of Object.values(sessions)) {
    if (session.serverId === serverId && session.status === "connected") {
      return session.sessionId;
    }
  }
  return null;
}

function openExtreme(server: ExtremeEntryServer, sessionId: string, workspaceId?: string) {
  const detail = `${server.username}@${server.host}:${server.port}`;
  const store = useExtremeStore.getState();
  store.enter(server.id, server.name, sessionId, detail);
  if (workspaceId) useExtremeStore.getState().openWorkspace(workspaceId);
}

/** 同一台服务器的并发进入共用一个连接过程。 */
const inflight = new Map<string, Promise<boolean>>();

/** 自建会话的断开监听：没有视图组件替它收尾，必须自己把状态清干净。 */
const closedWatchers = new Map<string, () => void>();

function watchClose(sessionId: string, serverId: string) {
  let closed = false;
  void listen<string>(sshClosedEvent(sessionId), () => {
    closed = true;
    closedWatchers.get(sessionId)?.();
    closedWatchers.delete(sessionId);
    useSessionStore.getState().remove(sessionId);
    // 只在这台服务器正被超能使用时标成"未连接"。
    if (useExtremeStore.getState().serverId === serverId) {
      useExtremeStore.getState().markDisconnected(serverId);
    }
  }).then((unlisten) => {
    // 极快断开：listen 还没落定时事件已经来过，直接注销。
    if (closed) unlisten();
    else closedWatchers.set(sessionId, unlisten);
  });
}

async function connectAndEnter(
  server: ExtremeEntryServer,
  options: EnterExtremeOptions,
): Promise<boolean> {
  const sessionId = crypto.randomUUID();
  const sessionStore = useSessionStore.getState();
  sessionStore.register({
    sessionId,
    tabId: `extreme:${server.id}`,
    title: server.name,
    subtitle: `${server.host}:${server.port}`,
    serverId: server.id,
  });

  try {
    const result = await opsApi.sshConnectMonitor({
      sessionId,
      serverId: server.id,
      credentialId: server.credential_id ?? undefined,
    });

    if (result.status === "connected") {
      useSessionStore.getState().setStatus(sessionId, "connected", { connectedAt: Date.now() });
      watchClose(sessionId, server.id);
      openExtreme(server, sessionId, options.workspaceId);
      return true;
    }

    // 主机指纹：与监控页同一条挑战路径（绝不静默接受）。
    const challengeLabel = `${result.challenge_host}:${result.challenge_port}`;
    const isJumpHop = challengeLabel !== `${result.host}:${result.port}`;
    useSessionStore.getState().setStatus(sessionId, "error", {
      error: i18n.t("等待确认主机指纹"),
    });
    useSessionStore.getState().raiseChallenge({
      sessionId,
      kind: result.status === "host_key_changed" ? "changed" : "unknown",
      challengeHost: result.challenge_host,
      challengePort: result.challenge_port,
      targetHost: result.host,
      targetPort: result.port,
      isJumpHop,
      fingerprint: result.fingerprint,
      fingerprintType: result.fingerprint_type,
      knownFingerprint: "known_fingerprint" in result ? result.known_fingerprint : undefined,
      retry: () => {
        // 确认指纹后这一条旧记录没有价值了，避免会话列表里多一条 error。
        useSessionStore.getState().remove(sessionId);
        void enterExtremeForServer(server, options);
      },
      cancel: () => {
        useSessionStore.getState().setStatus(sessionId, "closed");
        useSessionStore.getState().remove(sessionId);
      },
    });
    return false;
  } catch (cause) {
    useSessionStore.getState().setStatus(sessionId, "error", {
      error: toErrorMessage(cause),
    });
    pushErrorToast(cause, {
      title: i18n.t("无法连接到 {{name}}，超能模式打不开", { name: server.name }),
    });
    return false;
  }
}

/**
 * 进入超能并绑到这台服务器；有 `workspaceId` 时直接打开那条对话。
 *
 * 连接失败 / 等指纹确认时返回 `false`，界面保持原样（不会出现一个没有连接的
 * 超能空壳）。
 */
export function enterExtremeForServer(
  server: ExtremeEntryServer,
  options: EnterExtremeOptions = {},
): Promise<boolean> {
  const ready = connectedSessionFor(server.id);
  if (options.reconnect && ready) {
    // 主动丢弃旧连接：它的状态可能已经过期，重连必须真的重新握手。
    void opsApi.sshDisconnect(ready).catch(() => undefined);
    useSessionStore.getState().remove(ready);
  } else if (ready) {
    openExtreme(server, ready, options.workspaceId);
    return Promise.resolve(true);
  }

  const pending = inflight.get(server.id);
  if (pending) {
    return pending.then((ok) => {
      if (!ok) return false;
      const sessionId = connectedSessionFor(server.id);
      if (!sessionId) return false;
      openExtreme(server, sessionId, options.workspaceId);
      return true;
    });
  }

  const task = connectAndEnter(server, options).finally(() => {
    inflight.delete(server.id);
  });
  inflight.set(server.id, task);
  return task;
}

/**
 * 首页「最近对话」：按对话自己的服务器进入。
 *
 * 服务器配置已经被删 / 旧记录没有归属时**只读打开**，不猜一台服务器绑上去
 * 继续执行（那等于把命令打到错的机器上）。
 */
export function openExtremeWorkspace(workspaceId: string): boolean {
  const entry = useExtremeStore.getState().workspaces.find((item) => item.id === workspaceId);
  if (!entry) return false;
  const server = entry.serverId
    ? useDomainStore.getState().servers.find((item) => item.id === entry.serverId)
    : undefined;
  if (server) {
    void enterExtremeForServer(server, { workspaceId });
    return true;
  }
  const store = useExtremeStore.getState();
  // 不传 host：`enter` 的"同目标接管"会按 host 去认领记录，这里没有真实
  // 服务器可绑，传了反而会把一条未关联的历史改写成伪服务器。
  store.enter(entry.serverId ?? `history:${entry.id}`, entry.server, "", null);
  useExtremeStore.getState().openWorkspace(workspaceId);
  return true;
}
