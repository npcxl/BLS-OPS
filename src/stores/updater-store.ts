/**
 * The single owner of update state.
 *
 * Components never call `@tauri-apps/plugin-updater` themselves — they read
 * this store and call its actions. That is what makes "no duplicate checks"
 * and "no concurrent downloads" enforceable in one place instead of being
 * re-implemented (and forgotten) in every button handler.
 */
import { create } from "zustand";
import type {
  UpdateError,
  UpdatePhase,
  UpdateProgress,
  UpdateRelease,
  UpdateStage,
} from "@/api/types/updater";
import { classifyUpdateError } from "@/lib/updater/errors";
import { collectRestartBlockers, type RestartBlocker } from "@/lib/updater/restart-guard";
import {
  createTauriUpdaterClient,
  isDevRuntime,
  type UpdaterClient,
} from "@/lib/updater/updater-client";
import { useDomainStore } from "@/stores/domain-store";
import { countTickets, useActivityStore } from "@/stores/activity-store";
import {
  selectActiveCount,
  selectConnectingCount,
  useSessionStore,
} from "@/stores/session-store";

const AUTO_CHECK_KEY = "bls-ops.updater.autoCheck";
const LAST_CHECK_KEY = "bls-ops.updater.lastCheckedAt";

/** Delay before the startup check, so it never competes with first paint. */
export const AUTO_CHECK_DELAY_MS = 8_000;

interface UpdaterState {
  phase: UpdatePhase;
  /** Installed version — only ever what the backend reported. */
  currentVersion: string | null;
  release: UpdateRelease | null;
  progress: UpdateProgress | null;
  error: UpdateError | null;
  /** Stage of the failed step — for the error headline and diagnostics. */
  errorStage: UpdateStage | null;
  lastCheckedAt: number | null;
  autoCheck: boolean;
  /** Non-blocking "a new version is available" banner (auto-check only). */
  bannerVisible: boolean;
  /** True once this process has performed a check — auto or manual. */
  checkedThisLaunch: boolean;

  init: () => void;
  check: (options?: { manual?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  remindLater: () => void;
  dismissBanner: () => void;
  restart: () => Promise<void>;
  setAutoCheck: (enabled: boolean) => void;
}

/*
 * In-flight guards live **outside** the store: they must survive re-renders,
 * must not be serialised into state, and must be shared by every caller.
 */
let client: UpdaterClient = createTauriUpdaterClient();
let checkInFlight: Promise<void> | null = null;
let installInFlight: Promise<void> | null = null;

/**
 * Live snapshot of the work a restart would interrupt.
 *
 * Read from the stores that actually own that state — the session store for
 * live SSH, the activity store for transfers, unsaved files and long tasks.
 *
 * The updater calls it **twice**: once before downloading and once more right
 * before running the installer. A download can take minutes, and a session
 * opened while it was in flight must not be killed by a check that is already
 * stale.
 */
export function blockingActivity(): RestartBlocker[] {
  const sessions = useSessionStore.getState();
  return collectRestartBlockers({
    connectedSessions: selectActiveCount(sessions),
    connectingSessions: selectConnectingCount(sessions),
    activity: countTickets(useActivityStore.getState().tickets),
  });
}

/** Swaps the backend — used by tests and by nothing else. */
export function setUpdaterClient(next: UpdaterClient): void {
  client = next;
}

function readAutoCheck(): boolean {
  try {
    return localStorage.getItem(AUTO_CHECK_KEY) !== "0";
  } catch {
    return true;
  }
}

function readLastCheckedAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_CHECK_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistLastCheckedAt(value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(LAST_CHECK_KEY);
    else localStorage.setItem(LAST_CHECK_KEY, String(value));
  } catch {
    // A locked-down WebView just loses the "last checked" hint; not fatal.
  }
}

function logFailure(where: UpdateStage, error: UpdateError): void {
  // Dev log keeps the classified code and a sanitised reason — never the
  // installer path, never a token, never the signature blob.
  console.error(`[updater] ${where} failed (${error.code}/${error.stage})`, error.detail);
}

/** Sets the error **and** the stage it happened in — one place, never split. */
function fail(error: UpdateError): UpdateState {
  return { phase: "error", progress: null, error, errorStage: error.stage };
}

type UpdateState = Partial<UpdaterState>;

export const useUpdaterStore = create<UpdaterState>()((set, get) => ({
  phase: "idle",
  currentVersion: null,
  release: null,
  progress: null,
  error: null,
  errorStage: null,
  lastCheckedAt: null,
  autoCheck: true,
  bannerVisible: false,
  checkedThisLaunch: false,

  init: () => {
    const appInfo = useDomainStore.getState().appInfo;
    set({
      autoCheck: readAutoCheck(),
      lastCheckedAt: readLastCheckedAt(),
      currentVersion: appInfo?.version ?? null,
    });
  },

  check: async (options) => {
    const manual = options?.manual ?? false;
    const state = get();

    // A download/install is already running: never start a second pipeline.
    if (state.phase === "downloading" || state.phase === "installing") return;
    // Already handled in this process and the user is waiting for a restart.
    if (state.phase === "restart_required") return;
    // De-dupe concurrent callers (double click, banner + settings page).
    if (checkInFlight) return checkInFlight;

    const run = async () => {
      set({ phase: "checking", error: null, bannerVisible: false, checkedThisLaunch: true });

      // Dev builds must never download a production installer.
      if (isDevRuntime()) {
        set({
          phase: "error",
          release: null,
          error: {
            code: "unsupported_build",
            detail: "tauri dev",
            stage: "check",
            at: new Date().toISOString(),
          },
          errorStage: "check",
        });
        return;
      }

      try {
        const release = await client.check();
        const now = Date.now();
        persistLastCheckedAt(now);

        if (!release) {
          // An automatic check stays silent when there is nothing new — only a
          // manual check may say "you are up to date".
          set({
            phase: manual ? "up_to_date" : "idle",
            release: null,
            progress: null,
            lastCheckedAt: now,
          });
          return;
        }

        set({
          phase: "available",
          release,
          currentVersion: release.currentVersion || get().currentVersion,
          lastCheckedAt: now,
          // The banner is the non-blocking channel for *automatic* findings.
          bannerVisible: !manual,
        });
      } catch (cause) {
        const error = classifyUpdateError(cause, "check");
        logFailure("check", error);
        const now = Date.now();
        persistLastCheckedAt(now);
        set({ release: null, lastCheckedAt: now, ...fail(error) });
      }
    };

    checkInFlight = run().finally(() => {
      checkInFlight = null;
    });
    return checkInFlight;
  },

  install: async () => {
    const state = get();
    if (installInFlight) return installInFlight;
    // Never re-download or re-install a package that is already applied, and
    // never start without something to install.
    if (
      state.phase === "restart_required" ||
      state.phase === "downloading" ||
      state.phase === "installing" ||
      !state.release
    ) {
      return;
    }

    const run = async () => {
      set({ error: null });
      // Tracks which half of the pipeline failed: `download` fetches the
      // package, `install` verifies + runs it. Reported so the user sees
      // "downloading failed" vs "starting the installer failed".
      let stage: UpdateStage = "download";
      try {
        // Skip the download when the package is already on disk: reaching
        // `downloaded` and finishing later must not fetch it twice.
        if (get().phase !== "downloaded") {
          set({ phase: "downloading", progress: { received: 0, total: null } });
          await client.download((progress) => set({ progress }));

          /*
           * Second guard — **only on the download path**. The user confirmed
           * the restart minutes ago; work (an SSH session, a transfer) may
           * have started since. Stopping here is *visible*: the phase label
           * switches to "Downloaded — waiting for a safe moment to install"
           * and the button becomes "Install and restart".
           *
           * It must NEVER run again on the `downloaded` → install step: that
           * click *is* the confirmation (the dialog was just acknowledged),
           * and re-blocking here with the very same blockers silently ate the
           * click — the reported "pressing install does nothing" bug.
           */
          if (blockingActivity().length > 0) {
            console.info("[updater] download finished with active work; holding at downloaded");
            set({ phase: "downloaded", bannerVisible: false });
            return;
          }
        }

        // The installer runs the verified package; on Windows it takes over and
        // this process exits, so `restart_required` is mostly a macOS/Linux
        // state — harmless (and honest) to set either way.
        set({ phase: "installing" });
        stage = "install";
        await client.install();
        set({ phase: "restart_required", bannerVisible: false });
      } catch (cause) {
        const error = classifyUpdateError(cause, stage);
        logFailure(stage, error);
        set(fail(error));
      }
    };

    installInFlight = run().finally(() => {
      installInFlight = null;
    });
    return installInFlight;
  },

  remindLater: () =>
    set((state) => ({
      bannerVisible: false,
      // "Remind me later" is a real decision, so it is recorded as such. The
      // release stays in state: postponing is not the same as rejecting, and
      // the user can still install it from the settings page.
      phase: state.phase === "available" ? "cancelled" : state.phase,
    })),

  dismissBanner: () => set({ bannerVisible: false }),

  restart: async () => {
    if (get().phase !== "restart_required") return;
    try {
      await client.relaunch();
    } catch (cause) {
      const error = classifyUpdateError(cause, "relaunch");
      logFailure("relaunch", error);
      // The install succeeded; only the restart failed. Say exactly that.
      set({
        error: {
          code: "restart_failed",
          detail: error.detail,
          stage: "relaunch",
          at: error.at,
        },
        errorStage: "relaunch",
      });
    }
  },

  setAutoCheck: (enabled) => {
    try {
      localStorage.setItem(AUTO_CHECK_KEY, enabled ? "1" : "0");
    } catch {
      // Preference is session-only when storage is unavailable.
    }
    set({ autoCheck: enabled });
  },
}));

/** Test-only reset: clears state *and* the in-flight guards. */
export function resetUpdaterStore(): void {
  checkInFlight = null;
  installInFlight = null;
  useUpdaterStore.setState({
    phase: "idle",
    currentVersion: null,
    release: null,
    progress: null,
    error: null,
    errorStage: null,
    lastCheckedAt: null,
    autoCheck: true,
    bannerVisible: false,
    checkedThisLaunch: false,
  });
}
