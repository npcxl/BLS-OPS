/**
 * Live SSH session state.
 *
 * This is the only source for "how many sessions are connected" and for the
 * host-key confirmation prompt. Nothing here is seeded with fake numbers.
 */
import { create } from "zustand";
import { i18n } from "@/i18n";
import { opsApi, toErrorMessage } from "@/api/ops-api";

export type SessionStatus = "connecting" | "connected" | "error" | "closed";

export interface LiveSession {
  sessionId: string;
  tabId: string;
  title: string;
  subtitle?: string;
  serverId?: string;
  status: SessionStatus;
  error?: string;
  /** Real wall-clock time the handshake took, in milliseconds. */
  connectMs?: number;
  connectedAt?: number;
}

export interface HostKeyChallenge {
  sessionId: string;
  kind: "unknown" | "changed";
  /**
   * Endpoint whose key must be trusted. With ProxyJump this is the jump host,
   * NOT the server shown in the tab — always save under these values.
   */
  challengeHost: string;
  challengePort: number;
  /** Final destination, used only to explain the context to the user. */
  targetHost: string;
  targetPort: number;
  /** True when the challenge comes from a jump host rather than the target. */
  isJumpHop: boolean;
  fingerprint: string;
  fingerprintType: string;
  knownFingerprint?: string;
  /** Re-runs the connect attempt once the user has trusted the key. */
  retry: () => void;
  /** Gives up and marks the session as refused. */
  cancel: () => void;
}

interface SessionState {
  sessions: Record<string, LiveSession>;
  challenge: HostKeyChallenge | null;

  register: (session: Omit<LiveSession, "status">) => void;
  setStatus: (sessionId: string, status: SessionStatus, patch?: Partial<LiveSession>) => void;
  remove: (sessionId: string) => void;
  raiseChallenge: (challenge: HostKeyChallenge) => void;
  /** Trusts (or refuses) the pending host key, then retries or cancels. */
  resolveChallenge: (trust: boolean) => Promise<void>;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: {},
  challenge: null,

  register: (session) =>
    set((state) => ({
      sessions: { ...state.sessions, [session.sessionId]: { ...session, status: "connecting" } },
    })),

  setStatus: (sessionId, status, patch) =>
    set((state) => {
      const current = state.sessions[sessionId];
      if (!current) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...current, ...patch, status } },
      };
    }),

  remove: (sessionId) =>
    set((state) => {
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    }),

  raiseChallenge: (challenge) => set({ challenge }),

  resolveChallenge: async (trust) => {
    const challenge = get().challenge;
    if (!challenge) return;
    set({ challenge: null });
    try {
      // Trust the endpoint that presented the key, not the tab's destination.
      await opsApi.trustKnownHost(
        challenge.challengeHost,
        challenge.challengePort,
        challenge.fingerprint,
        challenge.fingerprintType,
        trust,
      );
    } catch (cause) {
      get().setStatus(challenge.sessionId, "error", { error: toErrorMessage(cause) });
      return;
    }
    if (trust) {
      challenge.retry();
    } else {
      get().setStatus(challenge.sessionId, "error", { error: i18n.t("Host fingerprint rejected, connection cancelled") });
      challenge.cancel();
    }
  },
}));

export function selectActiveCount(state: SessionState): number {
  return Object.values(state.sessions).filter((session) => session.status === "connected").length;
}

export function selectConnectingCount(state: SessionState): number {
  return Object.values(state.sessions).filter((session) => session.status === "connecting").length;
}
