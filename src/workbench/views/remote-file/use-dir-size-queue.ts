import { useCallback, useEffect, useRef, useState } from "react";
import { opsApi, toErrorMessage, type RemoteFileEntry } from "@/api/ops-api";
import { useDirSizeStore } from "@/stores/dir-size-store";

/**
 * On-demand directory-size queue for one SFTP session.
 *
 * Moved verbatim from the `RemoteFilePanel` container (阶段 D). Errors
 * surface through `onError` (the panel shows them in its status area).
 *
 * 并发上限的说明：`directory_size_start` 只是"启动后台任务并立刻返回初始状态"，
 * 前端等不到真正算完，所以这里的计数**只用于节流 IPC 调用**，真实的并发限制
 * （每个 SSH 会话同时最多 2 个 du/SFTP）由 Rust 后端用 Semaphore 保证。排队中
 * 的任务后端会以 `pending` 状态上报，前端据此显示"排队中"。
 *
 * 大小计算由面板在**每次列目录时自动发起**（见 `RemoteFilePanel` 的
 * 自动计算 effect），不再有手动按钮；这里只负责排队与错误上报。
 *
 * 时序保证：返回的 `listenerReady` 只有在全局 `directory-size-update` 监听器
 * **注册成功之后**才为 true；面板必须等它再启动自动计算，否则小目录的
 * completed 事件会在监听器就位前发出并丢失。
 */

/** 队列项：`force` 决定后端是否丢弃旧缓存重新扫描。 */
interface SizeQueueItem {
  path: string;
  force: boolean;
}

/** 已提交、但还没到终态的任务上限。 */
export const MAX_IN_FLIGHT_DIR_SIZES = 3;

/**
 * 每个 `(session, path)` 当前被哪些面板需要。
 *
 * 这是"安全取消"的依据：同一 SSH 会话可能开着多个文件面板，取消一个任务
 * 之前必须确认**没有任何面板**还需要它。放在模块级而不是 React state，
 * 因为它只用于判定，不参与渲染。
 */
const demands = new Map<string, Set<string>>();

function acquireDemand(sessionId: string, path: string, panelId: string): void {
  const key = `${sessionId}::${path}`;
  const set = demands.get(key) ?? new Set<string>();
  set.add(panelId);
  demands.set(key, set);
}

/** 返回 `true` 表示：已经没有任何面板需要这个路径，可以安全取消。 */
function releaseDemand(sessionId: string, path: string, panelId: string): boolean {
  const key = `${sessionId}::${path}`;
  const set = demands.get(key);
  if (!set) return true;
  set.delete(panelId);
  if (set.size === 0) {
    demands.delete(key);
    return true;
  }
  return false;
}

export function useDirSizeQueue(sessionId: string, onError: (message: string) => void) {
  const sizeQueueRef = useRef<SizeQueueItem[]>([]);
  /** 排队 + 在途（去重用）：有它就不重复提交同一路径。 */
  const sizeQueuedRef = useRef(new Set<string>());
  /**
   * **已提交、还没到终态**的路径。
   *
   * 与旧的 `sizeRunningRef` 的关键差别：旧实现是 IPC 一返回就减计数，
   * 而 `directorySizeStart` 是"启动后台任务后立刻返回"——于是 12 个请求
   * 会在一瞬间全部灌进后端排队，前端限流形同虚设。
   * 现在名额保持到**事件里出现终态**（或请求失败）为止。
   */
  const inFlightRef = useRef(new Set<string>());
  const sizePumpRef = useRef<() => void>(() => undefined);
  /** 本面板的稳定 id，用于多面板需求计数。 */
  const panelIdRef = useRef<string>(`panel-${crypto.randomUUID()}`);
  const [listenerReady, setListenerReady] = useState(false);

  const computeDirSize = useCallback(
    (path: string, force = false) => {
      if (!path || sizeQueuedRef.current.has(path)) return;
      if (force) {
        useDirSizeStore.getState().apply({
          sessionId,
          path,
          sizeBytes: 0,
          fileCount: 0,
          directoryCount: 0,
          skippedCount: 0,
          status: "pending",
          complete: false,
          calculatedAt: Date.now(),
        });
      }
      sizeQueuedRef.current.add(path);
      sizeQueueRef.current.push({ path, force });
      sizePumpRef.current();
    },
    [sessionId],
  );

  /** 一个任务真正结束（终态或请求失败）：释放名额并补下一个。 */
  const finishOne = useCallback((path: string) => {
    inFlightRef.current.delete(path);
    sizeQueuedRef.current.delete(path);
    sizePumpRef.current();
  }, []);

  sizePumpRef.current = () => {
    while (
      inFlightRef.current.size < MAX_IN_FLIGHT_DIR_SIZES &&
      sizeQueueRef.current.length > 0
    ) {
      const item = sizeQueueRef.current.shift();
      if (!item) continue;
      inFlightRef.current.add(item.path);
      acquireDemand(sessionId, item.path, panelIdRef.current);
      void opsApi
        // `force` 必须一路传到后端，否则重新计算只会拿回旧缓存。
        .directorySizeStart(sessionId, item.path, undefined, item.force)
        .then((initial) => {
          useDirSizeStore.getState().apply(initial);
          // 缓存命中 / 立即失败：初始就是终态，不必等事件。
          if (initial.complete) finishOne(item.path);
        })
        .catch((cause) => {
          onError(toErrorMessage(cause));
          finishOne(item.path);
        });
      // 故意没有 `finally`：名额必须保持到**真的到终态**，
      // 否则又会退化成"IPC 一返回就放行"。
    }
  };

  /**
   * 丢弃**还没发出去**的排队项，保留满足 `keep` 的项。
   *
   * 只影响待发送队列；在途任务由 [`releaseStale`] 处理（要判断其他面板
   * 是否还需要，不能在这里直接取消）。
   */
  const dropQueued = useCallback((keep?: (path: string) => boolean) => {
    sizeQueueRef.current = keep
      ? sizeQueueRef.current.filter((item) => keep(item.path))
      : [];
    const stillQueued = new Set(sizeQueueRef.current.map((item) => item.path));
    for (const path of Array.from(sizeQueuedRef.current)) {
      // 在途的路径要等终态才清，否则会重复提交同一个目录。
      if (inFlightRef.current.has(path)) continue;
      if (!stillQueued.has(path)) sizeQueuedRef.current.delete(path);
    }
  }, []);

  /**
   * 不再需要的**在途**任务：先减需求；确实没人需要才真的取消。
   *
   * 这是"离开目录 / 关闭面板后不继续占用后端资源"的落点，同时保证
   * 同会话的另一个面板仍在等的任务不会被误杀。
   */
  const releaseStale = useCallback(
    (keep: (path: string) => boolean) => {
      for (const path of Array.from(inFlightRef.current)) {
        if (keep(path)) continue;
        inFlightRef.current.delete(path);
        sizeQueuedRef.current.delete(path);
        const unused = releaseDemand(sessionId, path, panelIdRef.current);
        if (unused) {
          void opsApi.directorySizeCancel(sessionId, path).catch(() => undefined);
        }
      }
      sizePumpRef.current();
    },
    [sessionId],
  );

  const cancelDirSize = useCallback(
    (path: string) => {
      if (!path) return;
      void opsApi.directorySizeCancel(sessionId, path);
    },
    [sessionId],
  );

  // 任务到终态时（事件驱动的 `apply`）释放名额，补下一个。
  useEffect(() => {
    return useDirSizeStore.subscribe(() => {
      for (const path of Array.from(inFlightRef.current)) {
        const result = useDirSizeStore.getState().get(sessionId, path);
        if (result?.complete) finishOne(path);
      }
    });
  }, [sessionId, finishOne]);

  // 卸载：丢弃待发送 + 对在途任务减需求（没人要了才取消）。
  useEffect(() => {
    const panelId = panelIdRef.current;
    return () => {
      sizeQueueRef.current = [];
      for (const path of Array.from(inFlightRef.current)) {
        const unused = releaseDemand(sessionId, path, panelId);
        if (unused) {
          void opsApi.directorySizeCancel(sessionId, path).catch(() => undefined);
        }
      }
      inFlightRef.current.clear();
      sizeQueuedRef.current.clear();
    };
  }, [sessionId]);

  // Register the global directory-size listener once, and only report the
  // panel ready once registration actually succeeded.
  useEffect(() => {
    let active = true;
    void useDirSizeStore
      .getState()
      .ensureListening()
      .then(() => {
        if (active) setListenerReady(true);
      })
      .catch((cause) => {
        if (active) onError(toErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [onError]);

  return { computeDirSize, cancelDirSize, dropQueued, releaseStale, listenerReady };
}

/**
 * 每个目录**自动**统计的文件夹数量上限。
 *
 * 为什么需要上限：以前是"列出多少子文件夹就统计多少"。浏览十个目录就会
 * 往后端塞上百个任务，每个都要排队（后端每会话并发 2），用户看到的就是
 * "一直在计算/排队"。现在的语义是"先算最前面的这些，剩下的等用户滚动或
 * 手动刷新时再说"——不取消自动统计能力，只是不再无限堆积。
 */
export const AUTO_DIR_SIZE_LIMIT = 12;

/** Watchdog tick interval — the event stream is primary; this is a fallback. */
export const DIR_SIZE_WATCHDOG_INTERVAL_MS = 3_000;

/** Watchdog single-round cap, mirroring the backend `MAX_STATUS_BATCH`. */
export const DIR_SIZE_WATCHDOG_LIMIT = 20;

/**
 * Selects the directory paths of one listing whose size computation has
 * started but not finished yet (max [`DIR_SIZE_WATCHDOG_LIMIT`]). Paths that
 * were never started are deliberately left out: the watchdog only recovers
 * lost events, it must not wake computations up.
 */
export function pendingWatchPaths(
  sessionId: string,
  entries: RemoteFileEntry[],
  limit = DIR_SIZE_WATCHDOG_LIMIT,
): string[] {
  const state = useDirSizeStore.getState();
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    const result = state.get(sessionId, entry.path);
    if (!result || result.complete) continue;
    if (paths.length >= limit) break;
    paths.push(entry.path);
  }
  return paths;
}

/**
 * 面板级兜底 watchdog：**每个面板一个**低频定时器（不是一目录一个）。
 *
 * 事件（`directory-size-update`）是主要更新方式；这个 3 秒一次的批量查询只
 * 捞取极少量的丢失事件。规则：
 * - 只查询当前目录里"已启动但未完成"的文件夹，单轮最多 20 条；
 * - 所有任务完成后本轮不发任何请求；
 * - 断开连接 / 卸载时随 effect 清理。
 */
export function useDirSizeWatchdog(args: {
  connected: boolean;
  listenerReady: boolean;
  sessionId: string;
  entries: RemoteFileEntry[];
}) {
  const { connected, listenerReady, sessionId, entries } = args;

  useEffect(() => {
    if (!connected || !listenerReady) return;

    const timer = window.setInterval(() => {
      const paths = pendingWatchPaths(sessionId, entries);
      if (paths.length === 0) return;
      void opsApi
        .directorySizeStatusMany(sessionId, paths)
        .then((results) => {
          for (const result of results) useDirSizeStore.getState().apply(result);
        })
        // 兜底通道失败保持安静：一次丢失的兜底查询 3 秒后自然重试。
        .catch(() => undefined);
    }, DIR_SIZE_WATCHDOG_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [connected, listenerReady, sessionId, entries]);
}

/** Panel-local upload notice with auto-dismiss timing. */
export function useAutoDismiss(value: string | null, clear: () => void, ms: number) {
  useEffect(() => {
    if (!value) return;
    const timer = window.setTimeout(clear, ms);
    return () => window.clearTimeout(timer);
  }, [value, clear, ms]);
}

/** Non-blocking notice (used for unsupported types) — auto-dismisses. */
export function useTransientNotice(): [string | null, (message: string | null) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  useAutoDismiss(notice, () => setNotice(null), 4000);
  return [notice, setNotice];
}
