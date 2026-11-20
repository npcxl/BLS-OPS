/**
 * A live, non-interactive session for the P3 management modules.
 *
 * Every module (services, logs, Docker, Nginx, deployments) works by running
 * fixed commands on exec channels — none of them needs a shell. So they all
 * connect the same way the monitoring view does: authenticated, but with no
 * PTY and no shell channel. That keeps the server free of idle terminals and
 * means exec channels never interleave with anything a user might be typing.
 *
 * The hook owns the whole lifecycle for one tab:
 * - connect on mount (and on reconnect);
 * - surface the host-key challenge if the server is new or changed;
 * - stop everything when the transport drops (`ssh-closed-<id>`);
 * - disconnect and unregister on unmount, so a closed tab leaves nothing behind.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { opsApi, toErrorMessage } from "@/api/ops-api";
import { i18n } from "@/i18n";
import { sshClosedEvent } from "@/lib/events";
import { useSessionStore } from "@/stores/session-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkspaceTab } from "@/workbench/types";

/**
 * 握手总超时（与终端页一致）。
 *
 * 没有它，TCP 黑洞会让「连接中」永远转下去：模块页显示一个空白，用户既没有
 * 报错也不知道该点哪里。
 */
const CONNECT_TIMEOUT_MS = 20_000;

export type CommandSessionPhase =
  /** No server attached to the tab yet. */
  | "idle"
  | "connecting"
  | "connected"
  /** Connect failed, or a host-key decision is pending. */
  | "error"
  /** The transport is gone; nothing will work until the user reconnects. */
  | "closed";

export interface CommandSession {
  sessionId: string;
  /**
   * 连接代次：每次发起连接（含重连）都 +1。
   *
   * 用于让"按会话缓存"的东西（例如工具存在性探测）随连接失效 ——
   * `sessionId` 在重连时**不会变**，只看它会让缓存永远不刷新。
   */
  epoch: number;
  phase: CommandSessionPhase;
  error: string | null;
  /** True only when commands can actually be sent. */
  ready: boolean;
  connect: () => void;
  disconnect: () => void;
  /** Runs `action` only when the session is connected. */
  hasTarget: boolean;
}

export function useCommandSession(tab: WorkspaceTab): CommandSession {
  // The tab carries its own session id so a reconnect starts clean instead of
  // inheriting a dead connection.
  const fallbackRef = useRef<string | null>(null);
  if (!fallbackRef.current) fallbackRef.current = crypto.randomUUID();
  const sessionId = tab.sessionId ?? fallbackRef.current;

  const [phase, setPhase] = useState<CommandSessionPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const connectingRef = useRef(false);
  /** 连接代次：断开 / 重连后，旧握手的迟到结果必须失效。 */
  const connectSeqRef = useRef(0);

  const register = useSessionStore((s) => s.register);
  const setStatus = useSessionStore((s) => s.setStatus);
  const removeSession = useSessionStore((s) => s.remove);
  const raiseChallenge = useSessionStore((s) => s.raiseChallenge);
  const updateTab = useWorkbenchStore((s) => s.updateTab);

  const hasTarget = Boolean(tab.serverId || tab.quickTarget);

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    const seq = ++connectSeqRef.current;
    // 新代次：上一次连接期间探到的工具状态全部作废（服务器可能已经变了）。
    setEpoch((current) => current + 1);
    setPhase("connecting");
    setError(null);

    register({
      sessionId,
      tabId: tab.id,
      title: tab.title,
      subtitle: tab.subtitle,
      serverId: tab.serverId,
    });

    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => {
        reject(
          new Error(
            i18n.t("连接超时：{{seconds}} 秒内服务器没有响应", { seconds: 20 }),
          ),
        );
      }, CONNECT_TIMEOUT_MS);
    });

    try {
      const request = opsApi.sshConnectMonitor({
        sessionId,
        serverId: tab.serverId,
        target: tab.quickTarget,
        credentialId: tab.credentialId,
        password: tab.oneTimePassword,
      });
      // 超时 / 被取代之后握手仍可能成功：成功就立刻清理，别留无主会话。
      request
        .then(() => {
          if (connectSeqRef.current !== seq) {
            void opsApi.sshDisconnect(sessionId).catch(() => undefined);
          }
        })
        .catch(() => undefined);
      const result = await Promise.race([request, timeout]);
      // 已被断开 / 重连取代：结果作废，并清掉可能刚建立的会话。
      if (connectSeqRef.current !== seq) {
        void opsApi.sshDisconnect(sessionId).catch(() => undefined);
        return;
      }

      if (result.status === "connected") {
        setStatus(sessionId, "connected", { connectedAt: Date.now() });
        setPhase("connected");
        // A one-time password is used once and then forgotten.
        if (tab.oneTimePassword) updateTab(tab.id, { oneTimePassword: undefined });
        return;
      }

      // Host keys are never accepted silently. With ProxyJump the challenge
      // belongs to a jump host, so the copy names that endpoint.
      const challengeLabel = `${result.challenge_host}:${result.challenge_port}`;
      const isJumpHop = challengeLabel !== `${result.host}:${result.port}`;
      const message =
        result.status === "host_key_changed"
          ? i18n.t("Host fingerprint of {{host}} has changed. Confirm before connecting", { host: challengeLabel })
          : i18n.t("First connection to {{host}}. Confirm the host fingerprint", { host: challengeLabel });

      setStatus(sessionId, "error", { error: i18n.t("Waiting for host fingerprint confirmation") });
      setPhase("error");
      setError(message);

      raiseChallenge({
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
        retry: () => void connect(),
        cancel: () => {
          setStatus(sessionId, "closed");
          setPhase("closed");
          setError(i18n.t("Host fingerprint rejected, connection cancelled"));
        },
      });
    } catch (cause) {
      // 已被断开 / 重连取代：旧结果不许写回界面。
      if (connectSeqRef.current !== seq) return;
      const message = toErrorMessage(cause);
      setStatus(sessionId, "error", { error: message });
      setPhase("error");
      setError(message);
      // 超时 / 半途失败：后端可能还握着一条没走完的握手，清掉才能干净重试。
      void opsApi.sshDisconnect(sessionId).catch(() => undefined);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
      if (connectSeqRef.current === seq) connectingRef.current = false;
    }
  }, [
    raiseChallenge,
    register,
    sessionId,
    setStatus,
    tab.credentialId,
    tab.id,
    tab.oneTimePassword,
    tab.quickTarget,
    tab.serverId,
    tab.subtitle,
    tab.title,
    updateTab,
  ]);

  const disconnect = useCallback(() => {
    // 作废进行中的握手，并允许立刻重连（否则 `connectingRef` 会一直挡住）。
    connectSeqRef.current += 1;
    connectingRef.current = false;
    void opsApi.sshDisconnect(sessionId).catch(() => undefined);
    setStatus(sessionId, "closed");
    setPhase("closed");
  }, [sessionId, setStatus]);

  // Connect on mount; tear the session down when the tab goes away.
  useEffect(() => {
    if (!hasTarget) {
      setPhase("idle");
      return;
    }

    let disposed = false;
    setPhase("connecting");

    // A dropped transport must stop the page immediately: commands sent to a
    // dead session fail one by one, which looks like a broken module rather
    // than a broken connection.
    const unlisten = listen<string>(sshClosedEvent(sessionId), () => {
      if (disposed) return;
      setStatus(sessionId, "closed");
      setPhase("closed");
      setError(i18n.t("SSH connection closed"));
    });

    void connect();

    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
      void opsApi.sshDisconnect(sessionId).catch(() => undefined);
      removeSession(sessionId);
    };
    // Reconnecting when the target changes is intentional; `connect` is stable
    // for the lifetime of the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTarget, sessionId, tab.serverId]);

  return {
    sessionId,
    epoch,
    phase,
    error,
    ready: phase === "connected",
    connect: () => void connect(),
    disconnect,
    hasTarget,
  };
}
