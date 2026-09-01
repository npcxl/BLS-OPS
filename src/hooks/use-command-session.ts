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
import { useSessionStore } from "@/stores/session-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkspaceTab } from "@/workbench/types";

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
  const connectingRef = useRef(false);

  const register = useSessionStore((s) => s.register);
  const setStatus = useSessionStore((s) => s.setStatus);
  const removeSession = useSessionStore((s) => s.remove);
  const raiseChallenge = useSessionStore((s) => s.raiseChallenge);
  const updateTab = useWorkbenchStore((s) => s.updateTab);

  const hasTarget = Boolean(tab.serverId || tab.quickTarget);

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setPhase("connecting");
    setError(null);

    register({
      sessionId,
      tabId: tab.id,
      title: tab.title,
      subtitle: tab.subtitle,
      serverId: tab.serverId,
    });

    try {
      const result = await opsApi.sshConnectMonitor({
        sessionId,
        serverId: tab.serverId,
        target: tab.quickTarget,
        credentialId: tab.credentialId,
        password: tab.oneTimePassword,
      });

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
          ? `${challengeLabel} 的主机指纹已变化，请确认后再连接`
          : `首次连接 ${challengeLabel}，请确认主机指纹`;

      setStatus(sessionId, "error", { error: "等待主机指纹确认" });
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
          setError("已拒绝该主机指纹，连接已取消");
        },
      });
    } catch (cause) {
      const message = toErrorMessage(cause);
      setStatus(sessionId, "error", { error: message });
      setPhase("error");
      setError(message);
    } finally {
      connectingRef.current = false;
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
    const unlisten = listen<string>(`ssh-closed-${sessionId}`, () => {
      if (disposed) return;
      setStatus(sessionId, "closed");
      setPhase("closed");
      setError("SSH 连接已断开");
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
    phase,
    error,
    ready: phase === "connected",
    connect: () => void connect(),
    disconnect,
    hasTarget,
  };
}
