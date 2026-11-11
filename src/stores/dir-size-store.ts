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
 *
 * 更新契约（与后端 `dirsize.rs` 的 serde 契约对应）：载荷字段是 camelCase
 * （`sessionId` / `sizeBytes` / `calculatedAt` …），`status` 枚举值是
 * snake_case（`permission_denied` 等）。写入失败（畸形载荷）绝不能静默成
 * `undefined::path` 这类坏 key。
 */
interface DirSizeState {
  /** sessionId + "::" + path -> latest result. */
  results: Record<string, DirectorySizeResult>;
  /** 需要强制重算的路径（key 与 results 一致）。 */
  stale: Record<string, true>;
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
  /**
   * Drops the cached size of `parent` and its direct children, and marks them
   * stale so the next computation asks the backend for a **fresh** `du`
   * (otherwise the backend's own cache would just replay the old number).
   *
   * 只清一层：一次刷新把整棵树的 `du` 全部重跑太重。
   */
  invalidateUnder: (sessionId: string, parent: string) => void;
  /**
   * Reads and clears the stale mark for a path.
   *
   * `true` 表示"这个目录刚被标脏，必须带 force 重算"。
   */
  consumeStale: (sessionId: string, path: string) => boolean;
}

/**
 * Pure POSIX path normalisation for cache keys, so `/var/www`, `/var//www`
 * and `/var/www/` all land on the same entry. The remote is always POSIX —
 * never apply the local OS's rules here.
 */
export function normalizeRemotePath(path: string): string {
  if (!path) return "/";
  const normalized = `/${path}`
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");

  return normalized || "/";
}

/** The one place that builds cache keys — `get` and `apply` must agree. */
const keyOf = (sessionId: string, path: string) =>
  `${sessionId}::${normalizeRemotePath(path)}`;

/**
 * Shared registration promise for `ensureListening`. Two panels mounting at
 * once must await the *same* `listen()` call, a failed registration must fall
 * back to a retryable state, and there must never be more than one global
 * `directory-size-update` listener. It lives outside the store so it can hold
 * the in-flight promise without turning `listening` true prematurely.
 */
let listenerPromise: Promise<void> | null = null;

export const useDirSizeStore = create<DirSizeState>()((set, get) => ({
  results: {},
  stale: {},
  listening: false,
  unlisten: null,

  get: (sessionId, path) => get().results[keyOf(sessionId, path)],

  apply: (result) =>
    set((state) => {
      // 畸形载荷（旧版本后端 / 反序列化事故）不写入 —— 否则会落进
      // `undefined::path` 这样的坏 key，把真实结果"藏"起来。
      if (!result || !result.sessionId || !result.path) {
        console.error("[dir-size] invalid payload", result);
        return state;
      }
      const key = keyOf(result.sessionId, result.path);
      const previous = state.results[key];
      if (previous) {
        // 终态是终点：更旧的过渡态（pending/computing）不得回滚它。
        if (previous.complete && !result.complete) return state;
        // 其余按时间戳防回退：迟到的事件不能覆盖更新的状态。
        if (previous.calculatedAt > result.calculatedAt) return state;
      }
      return { results: { ...state.results, [key]: result } };
    }),

  ensureListening: async () => {
    if (get().listening) return;
    if (listenerPromise) return listenerPromise;

    listenerPromise = listen<DirectorySizeResult>(DIRECTORY_SIZE_EVENT, (event) => {
      useDirSizeStore.getState().apply(event.payload);
    })
      .then((unlisten) => {
        set({ listening: true, unlisten });
      })
      .catch((error) => {
        // 失败必须回到可重试状态：listening 保持 false，下次调用重新注册。
        set({ listening: false, unlisten: null });
        throw error;
      })
      .finally(() => {
        listenerPromise = null;
      });

    return listenerPromise;
  },

  forgetSession: (sessionId) =>
    set((state) => {
      const next: Record<string, DirectorySizeResult> = {};
      for (const [key, value] of Object.entries(state.results)) {
        if (value.sessionId !== sessionId) next[key] = value;
      }
      return { results: next };
    }),

  invalidateUnder: (sessionId, parent) =>
    set((state) => {
      const base = normalizeRemotePath(parent);
      const prefix = base === "/" ? "/" : `${base}/`;
      const next: Record<string, DirectorySizeResult> = {};
      let stale: Record<string, true> | null = null;
      let removed = 0;
      for (const [key, value] of Object.entries(state.results)) {
        if (value.sessionId !== sessionId) {
          next[key] = value;
          continue;
        }
        const path = normalizeRemotePath(value.path);
        const directChild = path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
        if (path === base || directChild) {
          removed += 1;
          stale = { ...(stale ?? state.stale), [key]: true };
          continue;
        }
        next[key] = value;
      }
      return removed > 0 ? { results: next, stale: stale ?? state.stale } : state;
    }),

  consumeStale: (sessionId, path) => {
    const key = keyOf(sessionId, path);
    if (!get().stale[key]) return false;
    set((state) => {
      const next = { ...state.stale };
      delete next[key];
      return { stale: next };
    });
    return true;
  },
}));
