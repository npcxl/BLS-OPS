import { useCallback, useEffect, useRef, useState } from "react";
import { opsApi, toErrorMessage } from "@/api/ops-api";
import { useDirSizeStore } from "@/stores/dir-size-store";
import type { RemoteFileEntry } from "@/api/ops-api";

/**
 * On-demand directory-size queue for one SFTP session.
 *
 * Moved verbatim from the `RemoteFilePanel` container (阶段 D). At most two
 * computations run concurrently; extra requests wait in a FIFO queue. Errors
 * surface through `onError` (the panel shows them in its status area).
 */
export function useDirSizeQueue(
  sessionId: string,
  entries: RemoteFileEntry[],
  onError: (message: string) => void,
) {
  const sizeQueueRef = useRef<string[]>([]);
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
      sizeQueueRef.current.push(path);
      sizePumpRef.current();
    },
    [sessionId],
  );

  sizePumpRef.current = () => {
    while (sizeRunningRef.current < 2 && sizeQueueRef.current.length > 0) {
      const path = sizeQueueRef.current.shift();
      if (!path) continue;
      sizeRunningRef.current += 1;
      void opsApi
        .directorySizeStart(sessionId, path, undefined, false)
        .then((initial) => useDirSizeStore.getState().apply(initial))
        .catch((cause) => onError(toErrorMessage(cause)))
        .finally(() => {
          sizeRunningRef.current -= 1;
          sizeQueuedRef.current.delete(path);
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
