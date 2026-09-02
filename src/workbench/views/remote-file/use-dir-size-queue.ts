import { useCallback, useEffect, useRef, useState } from "react";
import { opsApi, toErrorMessage } from "@/api/ops-api";
import { useDirSizeStore } from "@/stores/dir-size-store";
import type { RemoteFileEntry } from "@/api/ops-api";

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
 */

/** 队列项：`force` 决定后端是否丢弃旧缓存重新扫描。 */
interface SizeQueueItem {
  path: string;
  force: boolean;
}

export function useDirSizeQueue(
  sessionId: string,
  entries: RemoteFileEntry[],
  onError: (message: string) => void,
) {
  const sizeQueueRef = useRef<SizeQueueItem[]>([]);
  const sizeRunningRef = useRef(0);
  const sizeQueuedRef = useRef(new Set<string>());
  const sizePumpRef = useRef<() => void>(() => undefined);

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
        // `force` 必须一路传到后端，否则"重新计算大小"只会拿回旧缓存。
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

  /** Computes the size of every directory visible in the current listing. */
  const computeAllDirSizes = useCallback(() => {
    const directories = entries.filter((entry) => entry.kind === "directory");
    if (directories.some((entry) => entry.path === "/" || entry.path === "/var")) {
      if (!window.confirm("当前批量计算包含较大的系统目录，可能增加服务器磁盘 I/O。确定继续吗？")) return;
    }
    for (const entry of directories) computeDirSize(entry.path);
  }, [entries, computeDirSize]);

  // Subscribe to directory-size updates once per mount.
  useEffect(() => {
    void useDirSizeStore.getState().ensureListening();
  }, []);

  return { computeDirSize, cancelDirSize, computeAllDirSizes };
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
