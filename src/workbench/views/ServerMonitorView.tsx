import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  Cpu,
  Gauge,
  HardDrive,
  ListOrdered,
  MemoryStick,
  Network,
  Pause,
  Play,
  PlugZap,
  RefreshCw,
  TriangleAlert,
  Unplug,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { opsApi, toErrorMessage, type DiskMetrics, type NetworkMetrics, type ProcessInfo } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import {
  MONITOR_INTERVALS,
  useMonitorStore,
  totalThroughput,
  type MonitorEntry,
  type MonitorSample,
} from "@/stores/monitor-store";
import { ToolbarStat, ToolbarStatus } from "@/workbench/views/module-frame";
import type { WorkbenchPane, WorkspaceTab } from "@/workbench/types";
import { cn } from "@/lib/cn";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[exponent]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

function formatClock(timestamp: number | null): string {
  if (!timestamp) return "尚未采集";
  return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
}

/** True when `tabId` is the visible tab of any pane (tabs stay mounted when hidden). */
function isTabVisibleInPanes(tabId: string, pane: WorkbenchPane): boolean {
  if (!pane.children || pane.children.length === 0) return pane.activeTabId === tabId;
  return pane.children.some((child) => isTabVisibleInPanes(tabId, child));
}

/** Polling stops when the window is hidden — no point measuring a hidden page. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/**
 * A 30-minute sparkline. Every point is a real measurement; with fewer than
 * two points there is nothing to draw and the chart says so instead of
 * inventing a curve.
 */
function TrendChart({
  title,
  value,
  detail,
  points,
  pick,
  max,
  tone,
}: {
  title: string;
  value: string;
  detail: string;
  points: MonitorSample[];
  pick: (point: MonitorSample) => number;
  max: number;
  tone: string;
}) {
  const values = useMemo(() => points.map(pick), [pick, points]);
  const width = 100;
  const height = 34;
  const ceiling = Math.max(max, ...values, 0.0001);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const coords = values.map((value, index) => {
    const x = values.length > 1 ? index * step : width;
    const y = height - (Math.min(Math.max(value, 0), ceiling) / ceiling) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-[10px] border border-line bg-surface-1 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-11 text-fg-subtle">{title}</span>
        <span className="font-mono text-12 text-fg">{value}</span>
      </div>
      <div className="h-[34px] w-full">
        {values.length < 2 ? (
          <div className="flex h-full items-center text-10 text-fg-subtle">等待第二次采集…</div>
        ) : (
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn("h-full w-full", tone)}>
            <polygon
              points={`0,${height} ${coords.join(" ")} ${width},${height}`}
              fill="currentColor"
              opacity={0.14}
            />
            <polyline
              points={coords.join(" ")}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
      <div className="flex items-center justify-between text-10 text-fg-subtle">
        <span>最近 30 分钟</span>
        <span>{detail}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric cards
// ---------------------------------------------------------------------------

function usageTone(percent: number): string {
  if (percent >= 90) return "bg-danger";
  if (percent >= 75) return "bg-warning";
  return "bg-accent";
}

function MetricCard({
  icon: Icon,
  label,
  value,
  unit,
  detail,
  percent,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  unit?: string;
  detail: string;
  percent?: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-line bg-surface-1 p-3">
      <div className="flex items-center gap-1.5 text-fg-subtle">
        <Icon size={13} strokeWidth={1.75} />
        <span className="text-11">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-mono text-20 text-fg">{value}</span>
        {unit && <span className="text-11 text-fg-subtle">{unit}</span>}
      </div>
      {percent !== undefined && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className={cn("h-full rounded-full transition-[width] duration-300 ease-out", usageTone(percent))}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      )}
      <span className="truncate text-11 text-fg-subtle">{detail}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail tabs
// ---------------------------------------------------------------------------

function DiskTable({ disks }: { disks: DiskMetrics[] }) {
  if (disks.length === 0) {
    return <p className="px-3 py-4 text-12 text-fg-subtle">没有读到任何文件系统（可能该主机不支持，或命令失败）。</p>;
  }
  return (
    <table className="w-full text-11">
      <thead className="sticky top-0 bg-surface-2 text-fg-subtle">
        <tr>
          {["挂载点", "设备", "类型", "容量", "已用", "可用", "使用率"].map((head) => (
            <th key={head} className="px-3 py-1.5 text-left font-semibold">
              {head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {disks.map((disk) => (
          <tr key={`${disk.device}-${disk.mount_point}`} className="border-t border-line hover:bg-surface-hover">
            <td className="px-3 py-1.5 font-mono text-fg">{disk.mount_point}</td>
            <td className="px-3 py-1.5 font-mono text-fg-muted">{disk.device}</td>
            <td className="px-3 py-1.5 text-fg-muted">{disk.filesystem}</td>
            <td className="px-3 py-1.5 text-fg-muted">{formatBytes(disk.total)}</td>
            <td className="px-3 py-1.5 text-fg-muted">{formatBytes(disk.used)}</td>
            <td className="px-3 py-1.5 text-fg-muted">{formatBytes(disk.available)}</td>
            <td className="px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className={cn("h-full rounded-full", usageTone(disk.usage_percent))}
                    style={{ width: `${Math.min(100, Math.max(0, disk.usage_percent))}%` }}
                  />
                </div>
                <span className="font-mono text-fg">{disk.usage_percent.toFixed(1)}%</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NetworkTable({ network }: { network: NetworkMetrics[] }) {
  if (network.length === 0) {
    return <p className="px-3 py-4 text-12 text-fg-subtle">没有读到任何网络接口（已排除回环接口 lo）。</p>;
  }
  return (
    <table className="w-full text-11">
      <thead className="sticky top-0 bg-surface-2 text-fg-subtle">
        <tr>
          {["接口", "累计接收", "累计发送", "下载速度", "上传速度"].map((head) => (
            <th key={head} className="px-3 py-1.5 text-left font-semibold">
              {head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {network.map((nic) => (
          <tr key={nic.interface} className="border-t border-line hover:bg-surface-hover">
            <td className="px-3 py-1.5 font-mono text-fg">{nic.interface}</td>
            <td className="px-3 py-1.5 text-fg-muted">{formatBytes(nic.received_bytes)}</td>
            <td className="px-3 py-1.5 text-fg-muted">{formatBytes(nic.transmitted_bytes)}</td>
            <td className="px-3 py-1.5 font-mono text-fg">{formatSpeed(nic.receive_speed)}</td>
            <td className="px-3 py-1.5 font-mono text-fg">{formatSpeed(nic.transmit_speed)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProcessTable({ processes }: { processes: ProcessInfo[] }) {
  if (processes.length === 0) {
    return <p className="px-3 py-4 text-12 text-fg-subtle">没有读到进程列表。</p>;
  }
  return (
    <table className="w-full text-11">
      <thead className="sticky top-0 bg-surface-2 text-fg-subtle">
        <tr>
          {["PID", "用户", "CPU", "内存", "状态", "启动时间", "命令"].map((head) => (
            <th key={head} className="px-3 py-1.5 text-left font-semibold">
              {head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {processes.map((process) => (
          <tr key={process.pid} className="border-t border-line hover:bg-surface-hover">
            <td className="px-3 py-1.5 font-mono text-fg">{process.pid}</td>
            <td className="px-3 py-1.5 text-fg-muted">{process.user}</td>
            <td className="px-3 py-1.5 font-mono text-fg">{process.cpu_percent.toFixed(1)}%</td>
            <td className="px-3 py-1.5 font-mono text-fg-muted">{process.memory_percent.toFixed(1)}%</td>
            <td className="px-3 py-1.5 text-fg-muted">{process.status}</td>
            <td className="px-3 py-1.5 whitespace-nowrap text-fg-muted">{process.started_at}</td>
            <td className="max-w-0 truncate px-3 py-1.5 font-mono text-fg-muted" title={process.command}>
              {process.command}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

type DetailTab = "disk" | "network" | "process";

const DETAIL_TABS: { id: DetailTab; label: string; icon: React.ElementType }[] = [
  { id: "disk", label: "磁盘", icon: HardDrive },
  { id: "network", label: "网络", icon: Network },
  { id: "process", label: "进程", icon: ListOrdered },
];

/**
 * Read-only Linux server monitoring.
 *
 * Metrics come from `monitor_snapshot` over the live session: fixed read-only
 * commands on their own exec channels, never a PTY. Nothing on this page is
 * simulated — if a value could not be read, its card says so.
 */
export function ServerMonitorView({ tab }: { tab: WorkspaceTab }) {
  const fallbackSessionRef = useRef<string | null>(null);
  if (!fallbackSessionRef.current) fallbackSessionRef.current = crypto.randomUUID();
  const sessionId = tab.sessionId ?? fallbackSessionRef.current;

  const [detail, setDetail] = useState<DetailTab>("disk");
  const connectingRef = useRef(false);

  const entry = useMonitorStore((s) => s.entries[tab.id]) as MonitorEntry | undefined;
  const refresh = useMonitorStore((s) => s.refresh);
  const setPaused = useMonitorStore((s) => s.setPaused);
  const setIntervalMs = useMonitorStore((s) => s.setInterval);

  const register = useSessionStore((s) => s.register);
  const setStatus = useSessionStore((s) => s.setStatus);
  const removeSession = useSessionStore((s) => s.remove);
  const raiseChallenge = useSessionStore((s) => s.raiseChallenge);
  const updateTab = useWorkbenchStore((s) => s.updateTab);
  const servers = useDomainStore((s) => s.servers);

  const pageVisible = usePageVisible();
  const isActiveTab = useWorkbenchStore((s) => isTabVisibleInPanes(tab.id, s.rootPane));

  const hasTarget = Boolean(tab.serverId || tab.quickTarget);
  const server = useMemo(
    () => servers.find((item) => item.id === tab.serverId),
    [servers, tab.serverId],
  );

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;

    const store = useMonitorStore.getState();
    store.attach(tab.id, sessionId, tab.serverId);
    // A reconnect starts from a clean slate: rates are deltas, so samples
    // from the previous connection must not be diffed against new ones.
    store.reset(tab.id);
    store.setPhase(tab.id, "connecting", { error: null, unsupportedReason: null });

    register({
      sessionId,
      tabId: tab.id,
      title: tab.title,
      subtitle: tab.subtitle,
      serverId: tab.serverId,
    });

    try {
      const result = await opsApi.sshConnectMonitor({
        sessionId,
        serverId: tab.serverId,
        target: tab.quickTarget,
        credentialId: tab.credentialId,
        password: tab.oneTimePassword,
      });

      if (result.status === "connected") {
        setStatus(sessionId, "connected", { connectMs: 0, connectedAt: Date.now() });
        useMonitorStore.getState().setPhase(tab.id, "connected", { error: null });
        if (tab.oneTimePassword) updateTab(tab.id, { oneTimePassword: undefined });
        return;
      }

      // Host keys are never accepted silently — with ProxyJump the challenge
      // belongs to a jump host, so the copy names that endpoint.
      const challengeLabel = `${result.challenge_host}:${result.challenge_port}`;
      const isJumpHop = challengeLabel !== `${result.host}:${result.port}`;
      const message =
        result.status === "host_key_changed"
          ? `${challengeLabel} 的主机指纹已变化，请确认后再连接`
          : `首次连接 ${challengeLabel}，请确认主机指纹`;
      setStatus(sessionId, "error", { error: "等待主机指纹确认" });
      useMonitorStore.getState().setPhase(tab.id, "error", { error: message });
      raiseChallenge({
        sessionId,
        kind: result.status === "host_key_changed" ? "changed" : "unknown",
        challengeHost: result.challenge_host,
        challengePort: result.challenge_port,
        targetHost: result.host,
        targetPort: result.port,
        isJumpHop,
        fingerprint: result.fingerprint,
        fingerprintType: result.fingerprint_type,
        knownFingerprint: "known_fingerprint" in result ? result.known_fingerprint : undefined,
        retry: () => void connect(),
        cancel: () => {
          setStatus(sessionId, "closed");
          useMonitorStore
            .getState()
            .setPhase(tab.id, "closed", { error: "已拒绝该主机指纹，监控已取消" });
        },
      });
    } catch (cause) {
      const message = toErrorMessage(cause);
      setStatus(sessionId, "error", { error: message });
      useMonitorStore.getState().setPhase(tab.id, "error", { error: message });
    } finally {
      connectingRef.current = false;
    }
  }, [
    raiseChallenge,
    register,
    sessionId,
    setStatus,
    tab.credentialId,
    tab.id,
    tab.oneTimePassword,
    tab.quickTarget,
    tab.serverId,
    tab.subtitle,
    tab.title,
    updateTab,
  ]);

  // Connect once per mount, and stop everything when the tab goes away.
  useEffect(() => {
    if (!hasTarget) return;
    let disposed = false;

    useMonitorStore.getState().attach(tab.id, sessionId, tab.serverId);
    useMonitorStore.getState().setPhase(tab.id, "connecting", { error: null });

    // A dropped connection stops the page immediately.
    const unlistenClosed = listen<string>(`ssh-closed-${sessionId}`, () => {
      if (disposed) return;
      setStatus(sessionId, "closed");
      useMonitorStore.getState().setPhase(tab.id, "closed", { error: "SSH 连接已断开，监控已停止" });
    });

    void connect();

    return () => {
      disposed = true;
      void unlistenClosed.then((fn) => fn());
      void opsApi.sshDisconnect(sessionId).catch(() => undefined);
      removeSession(sessionId);
      useMonitorStore.getState().detach(tab.id);
    };
    // Connecting on target change is intentional; `connect` is stable per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTarget, sessionId, tab.id, tab.serverId]);

  // Polling: only while connected, unpaused, visible and the active tab.
  //
  // The session status is checked too: a session waiting on a host-key
  // decision is not connected, and polling it would replace the challenge
  // message with a misleading "connection lost" one.
  const sessionStatus = useSessionStore((s) => s.sessions[sessionId]?.status);
  const phase = entry?.phase ?? "idle";
  const canCollect =
    sessionStatus === "connected" && (phase === "connected" || phase === "error");
  const pollingEnabled = canCollect && !entry?.paused && isActiveTab && pageVisible;
  const intervalMs = entry?.intervalMs ?? 5_000;

  useEffect(() => {
    if (!pollingEnabled) return;

    void refresh(tab.id);
    const timer = window.setInterval(() => void refresh(tab.id), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, pollingEnabled, refresh, tab.id]);

  if (!hasTarget) {
    return <MonitorPicker tabId={tab.id} servers={servers} />;
  }

  const snapshot = entry?.snapshot ?? null;
  const throughput = totalThroughput(snapshot);
  const memory = snapshot?.memory;
  const cpu = snapshot?.cpu;

  // The disk card shows the fullest filesystem: that is the one that matters.
  const fullestDisk = useMemo(() => {
    if (!snapshot) return null;
    return snapshot.disks.reduce<DiskMetrics | null>(
      (worst, disk) => (worst === null || disk.usage_percent > worst.usage_percent ? disk : worst),
      null,
    );
  }, [snapshot]);

  const statusLabel =
    phase === "connected"
      ? "采集中"
      : phase === "connecting"
        ? "连接中"
        : phase === "closed"
          ? "已断开"
          : phase === "unsupported"
            ? "系统不支持"
            : phase === "error"
              ? "采集失败"
              : "未连接";

  const statusTone =
    phase === "connected"
      ? "bg-success"
      : phase === "error" || phase === "closed"
        ? "bg-danger"
        : phase === "unsupported"
          ? "bg-warning"
          : "bg-fg-subtle";

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      {/* Host info + connection status */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
        <span className={cn("h-[6px] w-[6px] rounded-full", statusTone)} />
        <span className="text-12 font-semibold text-fg">{tab.title}</span>
        {tab.subtitle && <span className="truncate text-11 text-fg-subtle">{tab.subtitle}</span>}
        <span className="ml-auto flex items-center gap-2 truncate text-11 text-fg-subtle">
          {snapshot && snapshot.system.hostname && (
            <>
              <span className="font-mono text-fg-muted">{snapshot.system.hostname}</span>
              <span className="text-line-strong">|</span>
            </>
          )}
          {snapshot && (
            <span title={`${snapshot.system.kernel} ${snapshot.system.architecture}`}>
              {snapshot.system.os_name}
              {snapshot.system.os_version ? ` ${snapshot.system.os_version}` : ""}
            </span>
          )}
          {snapshot && (
            <>
              <span className="text-line-strong">|</span>
              <span>运行 {formatUptime(snapshot.system.uptime_seconds)}</span>
            </>
          )}
          {server?.proxy_jump_id && <span className="shrink-0">经跳板机</span>}
        </span>
      </div>

      {/* Toolbar */}
      {/* One row, always: the status text gives up space instead of wrapping
          out of sight behind the fixed 40px height. */}
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-hidden border-b border-line bg-surface-1/60 px-2 backdrop-blur-xl">
        <Button
          variant="ghost"
          size="xs"
          disabled={!canCollect}
          onClick={() => setPaused(tab.id, !entry?.paused)}
          title={entry?.paused ? "继续采集" : "暂停采集"}
        >
          {entry?.paused ? <Play size={12} /> : <Pause size={12} />}
          {entry?.paused ? "继续" : "暂停"}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!canCollect}
          onClick={() => void refresh(tab.id)}
        >
          <RefreshCw size={12} />
          刷新
        </Button>
        <div className="mx-1 h-4 w-px bg-line" />
        <label className="flex items-center gap-1 text-11 text-fg-subtle">
          间隔
          <select
            value={intervalMs}
            onChange={(event) => setIntervalMs(tab.id, Number(event.target.value))}
            className="h-[24px] rounded-[6px] border border-line bg-surface-2 px-1.5 text-11 text-fg outline-none focus:border-accent"
          >
            {MONITOR_INTERVALS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="mx-1 h-4 w-px bg-line" />
        {phase === "connected" || phase === "connecting" ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              void opsApi.sshDisconnect(sessionId).catch(() => undefined);
              setStatus(sessionId, "closed");
              useMonitorStore.getState().setPhase(tab.id, "closed", { error: "已断开连接" });
            }}
          >
            <Unplug size={12} />
            断开
          </Button>
        ) : (
          <Button variant="ghost" size="xs" onClick={() => void connect()}>
            <PlugZap size={12} />
            重新连接
          </Button>
        )}
        <ToolbarStatus className="gap-1.5">
          {entry?.collecting && (
            <span className="h-[5px] w-[5px] shrink-0 animate-pulse rounded-full bg-accent" />
          )}
          <ToolbarStat>{statusLabel}</ToolbarStat>
          <span className="shrink-0 text-line-strong">|</span>
          {/* The last collection time is what the user checks, so it stays whole. */}
          <ToolbarStat className="shrink-0">{formatClock(entry?.lastUpdatedAt ?? null)}</ToolbarStat>
        </ToolbarStatus>
      </div>

      {/* Banners */}
      {phase === "unsupported" && (
        <div className="flex shrink-0 items-start gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-12 text-fg">
          <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            {entry?.unsupportedReason ?? "不支持的操作系统"}
            <span className="ml-1 text-fg-subtle">BLS-OPS 目前只提供 Linux 服务器的只读监控，采集已停止。</span>
          </span>
        </div>
      )}
      {phase === "error" && entry?.error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
          <WifiOff size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{entry.error}</span>
        </div>
      )}
      {phase === "closed" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-2 text-12 text-fg-muted">
          <WifiOff size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{entry?.error ?? "SSH 连接已断开，监控已停止"}</span>
          <Button variant="ghost" size="xs" onClick={() => void connect()}>
            重新连接
          </Button>
        </div>
      )}
      {phase === "connecting" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-2 text-12 text-fg-muted">
          <Activity size={13} className="shrink-0 animate-pulse text-accent" />
          <span>正在建立监控连接（不分配交互式终端）…</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!snapshot && phase !== "unsupported" ? (
          <p className="px-1 py-6 text-12 text-fg-subtle">
            还没有采集到任何数据。连接成功后会立即开始第一次采集。
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Metric cards */}
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <MetricCard
                icon={Cpu}
                label="CPU 使用率"
                value={cpu ? cpu.usage_percent.toFixed(1) : "—"}
                unit="%"
                percent={cpu?.usage_percent}
                detail={cpu ? `${cpu.logical_cores} 逻辑核心` : "等待采集"}
              />
              <MetricCard
                icon={MemoryStick}
                label="内存使用率"
                value={memory ? memory.usage_percent.toFixed(1) : "—"}
                unit="%"
                percent={memory?.usage_percent}
                detail={
                  memory
                    ? `${formatBytes(memory.used)} / ${formatBytes(memory.total)}${
                        memory.swap_total > 0 ? ` · 交换 ${formatBytes(memory.swap_used)}` : ""
                      }`
                    : "等待采集"
                }
              />
              <MetricCard
                icon={HardDrive}
                label="磁盘使用率"
                value={fullestDisk ? fullestDisk.usage_percent.toFixed(1) : "—"}
                unit="%"
                percent={fullestDisk?.usage_percent}
                detail={
                  fullestDisk
                    ? `最高：${fullestDisk.mount_point} · 共 ${snapshot?.disks.length ?? 0} 个文件系统`
                    : snapshot
                      ? "未检测到文件系统"
                      : "等待采集"
                }
              />
              <MetricCard
                icon={Gauge}
                label="系统负载"
                value={cpu ? cpu.load_1.toFixed(2) : "—"}
                unit="1 分钟"
                percent={
                  cpu && cpu.logical_cores > 0 ? (cpu.load_1 / cpu.logical_cores) * 100 : undefined
                }
                detail={
                  cpu
                    ? `5 分钟 ${cpu.load_5.toFixed(2)} · 15 分钟 ${cpu.load_15.toFixed(2)} · ${cpu.logical_cores} 核`
                    : "等待采集"
                }
              />
            </div>

            {/* Trends — 30 minutes */}
            <div className="flex flex-wrap gap-3">
              <TrendChart
                title="CPU 使用率"
                value={`${(cpu?.usage_percent ?? 0).toFixed(1)}%`}
                detail={`${entry?.history.length ?? 0} 个采样点`}
                points={entry?.history ?? []}
                pick={(point) => point.cpu}
                max={100}
                tone="text-accent"
              />
              <TrendChart
                title="内存使用率"
                value={`${(memory?.usage_percent ?? 0).toFixed(1)}%`}
                detail={memory ? `可用 ${formatBytes(memory.available)}` : ""}
                points={entry?.history ?? []}
                pick={(point) => point.memory}
                max={100}
                tone="text-success"
              />
              <TrendChart
                title="下载速度"
                value={formatSpeed(throughput.download)}
                detail="全部非回环接口合计"
                points={entry?.history ?? []}
                pick={(point) => point.download}
                max={1}
                tone="text-ai"
              />
              <TrendChart
                title="上传速度"
                value={formatSpeed(throughput.upload)}
                detail="全部非回环接口合计"
                points={entry?.history ?? []}
                pick={(point) => point.upload}
                max={1}
                tone="text-warning"
              />
            </div>

            {/* Detail tabs */}
            <div className="flex flex-col overflow-hidden rounded-[12px] border border-line bg-surface-1">
              <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
                {DETAIL_TABS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setDetail(item.id)}
                      className={cn(
                        "flex h-6 items-center gap-1.5 rounded-[7px] px-2 text-11 transition-colors",
                        detail === item.id
                          ? "bg-surface-active text-fg"
                          : "text-fg-muted hover:bg-surface-hover hover:text-fg",
                      )}
                    >
                      <Icon size={12} strokeWidth={1.75} />
                      {item.label}
                      <span className="text-fg-subtle">
                        {item.id === "disk"
                          ? (snapshot?.disks.length ?? 0)
                          : item.id === "network"
                            ? (snapshot?.network.length ?? 0)
                            : (snapshot?.processes.length ?? 0)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="max-h-[320px] min-h-0 overflow-auto">
                {detail === "disk" && <DiskTable disks={snapshot?.disks ?? []} />}
                {detail === "network" && <NetworkTable network={snapshot?.network ?? []} />}
                {detail === "process" && <ProcessTable processes={snapshot?.processes ?? []} />}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Shown when a monitor tab has no server attached yet. */
function MonitorPicker({ tabId, servers }: { tabId: string; servers: { id: string; name: string; username: string; host: string; port: number }[] }) {
  const updateTab = useWorkbenchStore((s) => s.updateTab);
  const closeTabById = useWorkbenchStore((s) => s.closeTabById);

  const attach = (server: { id: string; name: string; host: string; port: number }) =>
    updateTab(tabId, {
      title: `${server.name} · 监控`,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-app">
      <p className="text-13 text-fg-muted">选择一个服务器以开始监控</p>
      {servers.length === 0 ? (
        <p className="text-12 text-fg-subtle">左侧“服务器”中还没有任何条目，请先新增服务器。</p>
      ) : (
        <div className="flex max-h-[50vh] w-72 flex-col overflow-y-auto rounded-[8px] border border-line bg-surface-1">
          {servers.map((server) => (
            <button
              key={server.id}
              type="button"
              className="flex flex-col items-start gap-0.5 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-surface-hover"
              onClick={() => attach(server)}
            >
              <span className="text-12 text-fg">{server.name}</span>
              <span className="text-11 text-fg-subtle">
                {server.username}@{server.host}:{server.port}
              </span>
            </button>
          ))}
        </div>
      )}
      <Button variant="ghost" size="sm" onClick={() => closeTabById(tabId)}>
        关闭此标签
      </Button>
    </div>
  );
}
