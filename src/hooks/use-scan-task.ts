import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { projectScanResultEvent } from "@/lib/events";
import { i18n } from "@/i18n";
import { opsApi, toErrorMessage, type ProjectScanResult, type ProjectScanStatus } from "@/api/ops-api";

/**
 * One project-discovery run: start it, poll its status, subscribe to its
 * result event, cancel it, and clean up on unmount.
 *
 * Moved verbatim from the `ProjectView` container (阶段 D) — the view now only
 * renders state; all transport lives here.
 *
 * Lifecycle rule (很重要): **`scan` 状态更新绝不能触发取消**。轮询每 700ms
 * 执行一次 `setScan(status)`，如果把 `scan` 放进 cleanup 的依赖数组，React 会在
 * 每次状态更新时先跑上一次 effect 的 cleanup，于是刚启动的扫描在第一次轮询时
 * 就被 `projectScanCancel` 取消 —— 用户永远拿不到完整结果。因此当前扫描 ID 存
 * 在 `activeScanIdRef`，cleanup 只在**卸载**或**服务器/会话切换**时执行。
 */

/** 仍在后端的扫描状态（需要被取消/继续轮询的状态）。 */
const isActiveState = (state: string | undefined) =>
  state === "running" || state === "queued";

export function useScanTask(serverId: string | undefined, sessionId: string, ready: boolean) {
  const [scan, setScan] = useState<ProjectScanStatus | null>(null);
  const [result, setResult] = useState<ProjectScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  /** 本次视图"拥有"的扫描 ID；只有 `discover` 会写它。 */
  const activeScanIdRef = useRef<string | null>(null);
  /** 该扫描的最新后端状态，供卸载/切换时判断是否需要取消。 */
  const activeStateRef = useRef<string | null>(null);
  const targetKeyRef = useRef(`${serverId ?? ""}::${sessionId}`);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const detach = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, []);

  /** 取消我们拥有的、且后端仍在跑的扫描。 */
  const cancelActive = useCallback(() => {
    const id = activeScanIdRef.current;
    const state = activeStateRef.current;
    activeScanIdRef.current = null;
    activeStateRef.current = null;
    // 已结束（completed/cancelled/failed）的扫描不需要取消。
    if (!id || !isActiveState(state ?? undefined)) return;
    void opsApi.projectScanCancel(id).catch((cause) => {
      console.error("[useScanTask] 取消扫描失败", cause);
    });
  }, []);

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
        setError(i18n.t("SSH session not connected. Connect to a server first"));
        return;
      }
      // 新一轮开始前，先收掉上一轮留下来的轮询/监听（不取消：下面由
      // cancelActive 决定），避免两个 interval 同时写状态。
      stopPolling();
      detach();
      cancelActive();
      setLoading(true);
      setError(null);
      // 注意：不再 setResult(null)。扫描过程中保留旧项目列表，显示"正在复核"，
      // 新结果返回后按 canonical_path 原位合并，避免旧项目在扫描期间整体消失。
      try {
        console.log("[ProjectView] 调用 project_scan_start", {
          sessionId,
          serverId,
          incremental,
        });
        const started = await opsApi.projectScanStart(sessionId, serverId, incremental);
        console.log("[ProjectView] project_scan_start 返回", started);
        activeScanIdRef.current = started.id;
        activeStateRef.current = started.state;
        setScan(started);

        const settle = () => {
          stopPolling();
          detach();
          setLoading(false);
        };

        console.log("[ProjectView] 监听扫描结果事件", {
          eventName: projectScanResultEvent(started.id),
        });
        const unlisten = await listen<ProjectScanResult>(
          projectScanResultEvent(started.id),
          (event) => {
            console.log("[ProjectView] 收到扫描结果事件", event.payload);
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
            activeStateRef.current = "completed";
            settle();
          },
        );
        unlistenRef.current = unlisten;
        const poll = window.setInterval(async () => {
          try {
            const status = await opsApi.projectScanStatus(started.id);
            console.log("[ProjectView] project_scan_status 返回", status);
            if (status) {
              activeStateRef.current = status.state;
              setScan(status);
            }
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
              settle();
              const found = await opsApi.projectScanResult(started.id);
              console.log("[ProjectView] project_scan_result 返回", found);
              if (found) setResult(found);
            }
          } catch (cause) {
            console.error("[ProjectView] 查询扫描状态失败", cause);
            settle();
            setError(toErrorMessage(cause));
          }
        }, 700);
        timerRef.current = poll;
      } catch (cause) {
        console.error("[ProjectView] 启动项目发现失败", cause);
        setError(toErrorMessage(cause));
        setLoading(false);
      }
    },
    [ready, sessionId, serverId, stopPolling, detach, cancelActive],
  );

  /** 用户手动点击"取消扫描"——这是唯一主动取消后端的入口。 */
  const cancel = useCallback(async () => {
    const id = activeScanIdRef.current;
    if (!id) return;
    await opsApi.projectScanCancel(id).catch((cause) => {
      console.error("[useScanTask] 取消扫描失败", cause);
    });
    activeScanIdRef.current = null;
    activeStateRef.current = null;
  }, []);

  /**
   * 立即回填上次扫描的快照缓存，让用户一进页面就看到结果，不必等重扫。
   * 标记 `incremental: true` 让视图知道这是缓存、后台复核仍在进行；
   * 真正的扫描会覆盖这份结果。
   *
   * 快照加载完成后，若 SSH 已连接，自动跑一次增量扫描（discover(true)）在后台
   * 复核。用 `autoRanRef` 防 React StrictMode 双调用导致重复扫描。
   */
  const autoRanRef = useRef(false);
  const loadSnapshot = useCallback(async () => {
    if (!serverId) return;
    try {
      const cached = await opsApi.projectInventoryLoad(serverId);
      if (cached) setResult({ ...cached, incremental: true });
    } catch (cause) {
      console.warn("[useScanTask] 读取项目快照缓存失败", cause);
    }
    if (ready && serverId && !autoRanRef.current) {
      autoRanRef.current = true;
      void discover(true);
    }
  }, [serverId, ready, discover]);

  // 清理只在**卸载**或**服务器/会话切换**时执行。依赖里绝不能有 `scan`：
  // 轮询每次 setScan 都会改变它，从而把正在运行的扫描取消掉。
  useEffect(
    () => {
      const key = `${serverId ?? ""}::${sessionId}`;
      if (targetKeyRef.current !== key) {
        // 换了服务器/会话：旧结果不再描述屏幕上的内容。
        targetKeyRef.current = key;
        setScan(null);
        setResult(null);
        setError(null);
        setLoading(false);
        // 新服务器允许重新触发一次后台自动复核。
        autoRanRef.current = false;
      }
      return () => {
        stopPolling();
        detach();
        cancelActive();
      };
    },
    [serverId, sessionId, stopPolling, detach, cancelActive],
  );

  return { scan, result, loading, error, discover, cancel, loadSnapshot };
}
