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

export function useDirSizeQueue(sessionId: string, onError: (message: string) => void) {
  const sizeQueueRef = useRef<SizeQueueItem[]>([]);
  const sizeRunningRef = useRef(0);
  const sizeQueuedRef = useRef(new Set<string>());
  const sizePumpRef = useRef<() => void>(() => undefined);
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

  sizePumpRef.current = () => {
    while (sizeRunningRef.current < 2 && sizeQueueRef.current.length > 0) {
      const item = sizeQueueRef.current.shift();
      if (!item) continue;
      sizeRunningRef.current += 1;
      void opsApi
        // `force` 必须一路传到后端，否则重新计算只会拿回旧缓存。
        .directorySizeStart(sessionId, item.path, undefined, item.force)
        .then((initial) => useDirSizeStore.getState().apply(initial))
        .catch((cause) => onError(toErrorMessage(cause)))
        .finally(() => {
          sizeRunningRef.current -= 1;
          sizeQueuedRef.current.delete(item.path);
          sizePumpRef.current();
        });
    }
  };

  const cancelDirSize = useCallback(
    (path: string) => {
      if (!path) return;
      void opsApi.directorySizeCancel(sessionId, path);
    },
    [sessionId],
  );

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

  return { computeDirSize, cancelDirSize, listenerReady };
}

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
