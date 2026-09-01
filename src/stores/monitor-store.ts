/**
 * Server monitoring state — one entry per tab.
 *
 * Each terminal tab and each server monitor tab owns its own entry, so
 * switching tabs never mixes history or pause state. Nothing here is ever
 * seeded with generated numbers: a metric that could not be read simply is
 * not in `history`.
 */
import { create } from "zustand";
import { opsApi, toErrorMessage, type MonitorSnapshot } from "@/api/ops-api";

/** Default collection cadence. */
export const MONITOR_INTERVAL_MS = 5_000;
/** How much history the trend charts keep. */
export const MONITOR_HISTORY_WINDOW_MS = 30 * 60 * 1000;
const MAX_SAMPLES = Math.ceil(MONITOR_HISTORY_WINDOW_MS / MONITOR_INTERVAL_MS);

export const MONITOR_INTERVALS = [
  { value: 2_000, label: "2 秒" },
  { value: 5_000, label: "5 秒" },
  { value: 10_000, label: "10 秒" },
  { value: 30_000, label: "30 秒" },
] as const;

export type MonitorPhase =
  /** Registered, not connected yet. */
  | "idle"
  | "connecting"
  /** Session is live and collection is running. */
  | "connected"
  /** The remote OS is not Linux — collection stops by design. */
  | "unsupported"
  /** A collection failed but the session is still alive; keep retrying. */
  | "error"
  /** SSH is gone; polling stops until the user reconnects. */
  | "closed";

/** One point on the trend charts. */
export interface MonitorSample {
  at: number;
  /** CPU utilisation, percent. */
  cpu: number;
  /** Memory utilisation, percent. */
  memory: number;
  /** Bytes per second received across all interfaces. */
  download: number;
  /** Bytes per second transmitted across all interfaces. */
  upload: number;
}

export interface MonitorEntry {
  tabId: string;
  sessionId: string;
  serverId?: string;
  phase: MonitorPhase;
  /** User-requested pause — separate from "hidden", which is automatic. */
  paused: boolean;
  intervalMs: number;
  snapshot: MonitorSnapshot | null;
  history: MonitorSample[];
  error: string | null;
  unsupportedReason: string | null;
  lastUpdatedAt: number | null;
  /** Guards against overlapping collections. */
  collecting: boolean;
}

interface MonitorState {
  entries: Record<string, MonitorEntry>;

  /** Registers a tab's monitoring state; re-attaching keeps its history. */
  attach: (tabId: string, sessionId: string, serverId?: string) => void;
  detach: (tabId: string) => void;
  setPhase: (tabId: string, phase: MonitorPhase, patch?: { error?: string | null; unsupportedReason?: string | null }) => void;
  setPaused: (tabId: string, paused: boolean) => void;
  setInterval: (tabId: string, intervalMs: number) => void;
  /** Drops samples and metrics — used when the session is re-established. */
  reset: (tabId: string) => void;
  /** Collects one snapshot. No-op while a collection is already in flight. */
  refresh: (tabId: string) => Promise<void>;
}

function sampleFrom(snapshot: MonitorSnapshot, at: number): MonitorSample {
  let download = 0;
  let upload = 0;
  for (const nic of snapshot.network) {
    download += nic.receive_speed;
    upload += nic.transmit_speed;
  }
  return { at, cpu: snapshot.cpu.usage_percent, memory: snapshot.memory.usage_percent, download, upload };
}

export const useMonitorStore = create<MonitorState>()((set, get) => ({
  entries: {},

  attach: (tabId, sessionId, serverId) =>
    set((state) => {
      const existing = state.entries[tabId];
      // Re-attaching with a NEW session (a reconnect) starts clean: diffing
      // rates across two different connections would be nonsense.
      const base: MonitorEntry = existing && existing.sessionId === sessionId
        ? existing
        : {
            tabId,
            sessionId,
            serverId,
            phase: "idle",
            paused: false,
            intervalMs: MONITOR_INTERVAL_MS,
            snapshot: null,
            history: [],
            error: null,
            unsupportedReason: null,
            lastUpdatedAt: null,
            collecting: false,
          };
      return { entries: { ...state.entries, [tabId]: { ...base, serverId: serverId ?? base.serverId } } };
    }),

  detach: (tabId) =>
    set((state) => {
      const next = { ...state.entries };
      delete next[tabId];
      return { entries: next };
    }),

  setPhase: (tabId, phase, patch) =>
    set((state) => {
      const entry = state.entries[tabId];
      if (!entry) return state;
      return {
        entries: {
          ...state.entries,
          [tabId]: {
            ...entry,
            phase,
            error: patch?.error !== undefined ? patch.error : entry.error,
            unsupportedReason:
              patch?.unsupportedReason !== undefined ? patch.unsupportedReason : entry.unsupportedReason,
          },
        },
      };
    }),

  setPaused: (tabId, paused) =>
    set((state) => {
      const entry = state.entries[tabId];
      if (!entry) return state;
      return { entries: { ...state.entries, [tabId]: { ...entry, paused } } };
    }),

  setInterval: (tabId, intervalMs) =>
    set((state) => {
      const entry = state.entries[tabId];
      if (!entry) return state;
      return { entries: { ...state.entries, [tabId]: { ...entry, intervalMs } } };
    }),

  reset: (tabId) =>
    set((state) => {
      const entry = state.entries[tabId];
      if (!entry) return state;
      return {
        entries: {
          ...state.entries,
          [tabId]: { ...entry, snapshot: null, history: [], error: null, lastUpdatedAt: null, collecting: false },
        },
      };
    }),

  refresh: async (tabId) => {
    const entry = get().entries[tabId];
    // `closed` and `unsupported` never poll again until the user acts.
    if (!entry || entry.collecting) return;
    if (entry.phase !== "connected" && entry.phase !== "error") return;

    set((state) => ({
      entries: { ...state.entries, [tabId]: { ...state.entries[tabId], collecting: true } },
    }));

    const finish = (patch: Partial<MonitorEntry>) =>
      set((state) => {
        const current = state.entries[tabId];
        if (!current) return state;
        return { entries: { ...state.entries, [tabId]: { ...current, ...patch, collecting: false } } };
      });

    try {
      const snapshot = await opsApi.monitorSnapshot(entry.sessionId);

      if (!snapshot.supported) {
        // Explicit refusal rather than a page full of zeroes.
        finish({
          phase: "unsupported",
          snapshot,
          unsupportedReason: snapshot.unsupported_reason ?? "不支持的操作系统",
          error: null,
          lastUpdatedAt: Date.now(),
        });
        return;
      }

      const at = Date.now();
      const history = [...entry.history, sampleFrom(snapshot, at)].filter(
        (point) => at - point.at <= MONITOR_HISTORY_WINDOW_MS,
      );
      // Trim from the front as well: a manual refresh storm must not grow the
      // array without bound.
      finish({
        phase: "connected",
        snapshot,
        history: history.slice(-MAX_SAMPLES),
        error: null,
        unsupportedReason: null,
        lastUpdatedAt: at,
      });
    } catch (cause) {
      const message = toErrorMessage(cause);
      // Distinguish "the connection is gone" from "this collection failed".
      let alive = false;
      try {
        alive = await opsApi.sshStatus(entry.sessionId);
      } catch {
        alive = false;
      }
      if (!alive) {
        finish({ phase: "closed", error: `SSH 连接已断开，监控已停止：${message}` });
      } else {
        finish({ phase: "error", error: message });
      }
    }
  },
}));

/** Total download/upload across every interface, in bytes/second. */
export function totalThroughput(snapshot: MonitorSnapshot | null): { download: number; upload: number } {
  if (!snapshot) return { download: 0, upload: 0 };
  let download = 0;
  let upload = 0;
  for (const nic of snapshot.network) {
    download += nic.receive_speed;
    upload += nic.transmit_speed;
  }
  return { download, upload };
}
