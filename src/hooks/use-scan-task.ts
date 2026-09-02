import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { projectScanResultEvent } from "@/lib/events";
import { opsApi, toErrorMessage, type ProjectScanResult, type ProjectScanStatus } from "@/api/ops-api";

/**
 * One project-discovery run: start it, poll its status, subscribe to its
 * result event, cancel it, and clean up on unmount.
 *
 * Moved verbatim from the `ProjectView` container (阶段 D) — the view now only
 * renders state; all transport lives here.
 */
export function useScanTask(serverId: string | undefined, sessionId: string, ready: boolean) {
  const [scan, setScan] = useState<ProjectScanStatus | null>(null);
  const [result, setResult] = useState<ProjectScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const discover = useCallback(
    async (incremental = false) => {
      console.log("[ProjectView] 开始发现项目", {
        incremental,
        sessionReady: ready,
        sessionId,
        serverId,
      });
      if (!ready || !serverId) {
        console.warn("[ProjectView] 无法开始发现：SSH 会话未连接或缺少服务器", {
          sessionReady: ready,
          sessionId,
          serverId,
        });
        setError("SSH 会话未连接，请先连接服务器");
        return;
      }
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        console.log("[ProjectView] 调用 project_scan_start", {
          sessionId,
          serverId,
          incremental,
        });
        const started = await opsApi.projectScanStart(sessionId, serverId, incremental);
        console.log("[ProjectView] project_scan_start 返回", started);
        setScan(started);
        console.log("[ProjectView] 监听扫描结果事件", {
          eventName: projectScanResultEvent(started.id),
        });
        const unlisten = await listen<ProjectScanResult>(
          projectScanResultEvent(started.id),
          (event) => {
            console.log("[ProjectView] 收到扫描结果事件", event.payload);
            unlistenRef.current = null;
            setResult(event.payload);
            setScan((current) =>
              current
                ? {
                    ...current,
                    state: "completed",
                    progress: { ...current.progress, progress: 100 },
                  }
                : current,
            );
            setLoading(false);
            unlisten();
          },
        );
        unlistenRef.current = unlisten;
        const poll = window.setInterval(async () => {
          timerRef.current = poll;
          try {
            const status = await opsApi.projectScanStatus(started.id);
            console.log("[ProjectView] project_scan_status 返回", status);
            if (status) setScan(status);
            if (status && ["completed", "cancelled", "failed"].includes(status.state)) {
              console.log("[ProjectView] 扫描已结束", {
                state: status.state,
                error: status.error,
                progress: status.progress,
              });
              if (status.error) {
                console.error("[ProjectView] 后端扫描错误", status.error);
                setError(status.error);
              }
              window.clearInterval(poll);
              const found = await opsApi.projectScanResult(started.id);
              console.log("[ProjectView] project_scan_result 返回", found);
              if (found) setResult(found);
              setLoading(false);
              unlisten();
            }
          } catch (cause) {
            console.error("[ProjectView] 查询扫描状态失败", cause);
            window.clearInterval(poll);
            setError(toErrorMessage(cause));
            setLoading(false);
            unlisten();
          }
        }, 700);
      } catch (cause) {
        console.error("[ProjectView] 启动项目发现失败", cause);
        setError(toErrorMessage(cause));
        setLoading(false);
      }
    },
    [ready, sessionId, serverId],
  );

  const cancel = useCallback(async () => {
    if (scan) await opsApi.projectScanCancel(scan.id);
  }, [scan]);

  // Leaving the view stops polling, unsubscribes, and cancels an in-flight scan.
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      unlistenRef.current?.();
      if (scan && ["running", "queued"].includes(scan.state))
        void opsApi.projectScanCancel(scan.id);
    },
    [scan],
  );

  return { scan, result, loading, error, discover, cancel };
}
