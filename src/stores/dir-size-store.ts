import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { DIRECTORY_SIZE_EVENT, type DirectorySizeResult } from "@/api/ops-api";

/**
 * Caches on-demand directory-size computations keyed by sessionId + path.
 *
 * The Rust side pushes DirectorySizeResult over the directory-size-update
 * event as a scan progresses; this store simply collects those updates so the
 * file panel can render "computing..." or "1.26 GB - 12,586 files" without
 * polling. Results are kept per session; refreshing a directory reuses a
 * finished result instead of recomputing it.
 */
interface DirSizeState {
  /** sessionId + "::" + path -> latest result. */
  results: Record<string, DirectorySizeResult>;
  /** Whether the global event listener is attached. */
  listening: boolean;
  /** Detaches the event listener (called on app teardown). */
  unlisten: UnlistenFn | null;

  /** Returns the cached result for a path, if any. */
  get: (sessionId: string, path: string) => DirectorySizeResult | undefined;
  /** Merges an incoming event payload into the cache. */
  apply: (result: DirectorySizeResult) => void;
  /** Ensures the single event listener is registered. */
  ensureListening: () => Promise<void>;
  /** Drops every cached result for a session (on disconnect). */
  forgetSession: (sessionId: string) => void;
}

const keyOf = (sessionId: string, path: string) => `${sessionId}::${path}`;

export const useDirSizeStore = create<DirSizeState>()((set, get) => ({
  results: {},
  listening: false,
  unlisten: null,

  get: (sessionId, path) => get().results[keyOf(sessionId, path)],

  apply: (result) =>
    set((state) => ({
      results: { ...state.results, [keyOf(result.sessionId, result.path)]: result },
    })),

  ensureListening: async () => {
    if (get().listening) return;
    set({ listening: true });
    const unlisten = await listen<DirectorySizeResult>(DIRECTORY_SIZE_EVENT, (event) => {
      get().apply(event.payload);
    });
    set({ unlisten });
  },

  forgetSession: (sessionId) =>
    set((state) => {
      const next: Record<string, DirectorySizeResult> = {};
      for (const [key, value] of Object.entries(state.results)) {
        if (value.sessionId !== sessionId) next[key] = value;
      }
      return { results: next };
    }),
}));
