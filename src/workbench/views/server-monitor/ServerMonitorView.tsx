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
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading";
import { Select } from "@/components/ui/select";
import { useTranslation } from "react-i18next";
import { opsApi, toErrorMessage, type DiskMetrics } from "@/api/ops-api";
import { i18n } from "@/i18n";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import {
  MONITOR_INTERVALS,
  useMonitorStore,
  totalThroughput,
  type MonitorEntry,
} from "@/stores/monitor-store";
import {
  PageNotice,
  PageScroll,
  PageStatusBar,
  PageSurface,
  PageTabs,
  PageToolbar,
  PageToolbarDivider,
} from "@/workbench/page-layout";
import type { WorkspaceTab } from "@/workbench/types";
import { cn } from "@/lib/cn";
import { formatBytes, formatSpeed, formatUptime } from "@/lib/format";
import { sshClosedEvent } from "@/lib/events";
import { TrendChart } from "./TrendChart";
import { MetricCard } from "./MetricCard";
import { DiskTable, NetworkTable, ProcessTable } from "./tables";
import { MonitorPicker } from "./MonitorPicker";
import { isTabVisibleInPanes, usePageVisible } from "./hooks";

function formatClock(timestamp: number | null): string {
  if (!timestamp) return i18n.t("Not collected yet");
  return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
}

// ---------------------------------------------------------------------------

type DetailTab = "disk" | "network" | "process";

/** 明细 tab 名存英文 key，渲染处 t()（模块级常量不能调 hook）。 */
const DETAIL_TABS: { id: DetailTab; labelKey: string; icon: React.ElementType }[] = [
  { id: "disk", labelKey: "Disk", icon: HardDrive },
  { id: "network", labelKey: "Network", icon: Network },
  { id: "process", labelKey: "Processes", icon: ListOrdered },
];

/**
 * Read-only Linux server monitoring.
 *
 * Metrics come from `monitor_snapshot` over the live session: fixed read-only
 * commands on their own exec channels, never a PTY. Nothing on this page is
 * simulated — if a value could not be read, its card says so.
 */
export function ServerMonitorView({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
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
          ? t("Host fingerprint of {{host}} changed — confirm before connecting", { host: challengeLabel })
          : t("First connection to {{host}} — confirm the host fingerprint", { host: challengeLabel });
      setStatus(sessionId, "error", { error: t("Waiting for host fingerprint confirmation") });
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
            .setPhase(tab.id, "closed", { error: t("Host fingerprint rejected; monitoring canceled") });
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
    t,
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
    const unlistenClosed = listen<string>(sshClosedEvent(sessionId), () => {
      if (disposed) return;
      setStatus(sessionId, "closed");
      useMonitorStore
        .getState()
        .setPhase(tab.id, "closed", { error: i18n.t("SSH connection closed; monitoring stopped") });
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
      ? t("Collecting")
      : phase === "connecting"
        ? t("Connecting")
        : phase === "closed"
          ? t("Closed")
          : phase === "unsupported"
            ? t("Unsupported OS")
            : phase === "error"
              ? t("Collection failed")
              : t("Disconnected");

  const statusTone =
    phase === "connected"
      ? "bg-success"
      : phase === "error" || phase === "closed"
        ? "bg-danger"
        : phase === "unsupported"
          ? "bg-warning"
          : "bg-fg-subtle";

  return (
    <PageSurface>
      {/* One control row. The server name lives on the work tab; host identity
          lives in the status bar, so nothing is repeated here. */}
      <PageToolbar>
        <Button
          variant="ghost"
          size="xs"
          disabled={!canCollect}
          onClick={() => setPaused(tab.id, !entry?.paused)}
          title={entry?.paused ? t("Resume collection") : t("Pause collection")}
        >
          {entry?.paused ? <Play size={12} /> : <Pause size={12} />}
          {entry?.paused ? t("Resume") : t("Pause")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!canCollect}
          onClick={() => void refresh(tab.id)}
        >
          <RefreshCw size={12} />
          {t("Refresh")}
        </Button>
        <PageToolbarDivider />
        <span className="flex items-center gap-1 text-11 text-fg-subtle">
          {t("Interval")}
          <Select
            size="xs"
            className="w-[74px]"
            ariaLabel={t("采集间隔")}
            value={String(intervalMs)}
            onChange={(value) => setIntervalMs(tab.id, Number(value))}
            options={MONITOR_INTERVALS.map((option) => ({
              value: String(option.value),
              label: t("{{count}}s", { count: option.value / 1000 }),
            }))}
          />
        </span>
        <PageToolbarDivider />
        {phase === "connected" || phase === "connecting" ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              void opsApi.sshDisconnect(sessionId).catch(() => undefined);
              setStatus(sessionId, "closed");
              useMonitorStore.getState().setPhase(tab.id, "closed", { error: t("Connection closed") });
            }}
          >
            <Unplug size={12} />
            {t("Disconnect")}
          </Button>
        ) : (
          <Button variant="ghost" size="xs" onClick={() => void connect()}>
            <PlugZap size={12} />
            {t("Reconnect")}
          </Button>
        )}
      </PageToolbar>

      {/* One notice slot per state; the page itself never stacks banners. */}
      {phase === "unsupported" && (
        <PageNotice tone="warning" icon={<TriangleAlert size={13} />}>
          {entry?.unsupportedReason ?? t("Unsupported operating system")}
          <span className="ml-1 text-fg-subtle">
            {t("Ops Workbench only provides read-only monitoring for Linux servers; collection has stopped.")}
          </span>
        </PageNotice>
      )}
      {phase === "error" && entry?.error && (
        <PageNotice
          tone="danger"
          icon={<WifiOff size={13} />}
          action={
            <Button variant="ghost" size="xs" onClick={() => void connect()}>
              {t("Retry")}
            </Button>
          }
        >
          {entry.error}
        </PageNotice>
      )}
      {phase === "closed" && (
        <PageNotice
          icon={<WifiOff size={13} />}
          action={
            <Button variant="ghost" size="xs" onClick={() => void connect()}>
              {t("Reconnect")}
            </Button>
          }
        >
          {entry?.error ?? t("SSH connection closed; monitoring stopped")}
        </PageNotice>
      )}
      {phase === "connecting" && (
        <PageNotice icon={<Activity size={13} className="animate-pulse text-accent" />}>
          {t("Establishing monitoring connection (no interactive terminal allocated)…")}
        </PageNotice>
      )}

      <PageScroll>
        {!snapshot && phase === "connecting" ? (
          <LoadingState className="h-full" label={t("Collecting the first sample…")} />
        ) : !snapshot && phase !== "unsupported" ? (
          <EmptyState
            icon={<Activity size={18} strokeWidth={1.5} />}
            title={t("No data collected yet")}
            description={t("The first collection starts right after connecting.")}
            action={
              <Button variant="ghost" size="sm" disabled={!canCollect} onClick={() => void refresh(tab.id)}>
                <RefreshCw size={12} />
                {t("Collect now")}
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {/* Metric cards */}
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <MetricCard
                icon={Cpu}
                label={t("CPU usage")}
                value={cpu ? cpu.usage_percent.toFixed(1) : "—"}
                unit="%"
                percent={cpu?.usage_percent}
                detail={cpu ? t("{{count}} logical cores", { count: cpu.logical_cores }) : t("Waiting for data")}
              />
              <MetricCard
                icon={MemoryStick}
                label={t("Memory usage")}
                value={memory ? memory.usage_percent.toFixed(1) : "—"}
                unit="%"
                percent={memory?.usage_percent}
                detail={
                  memory
                    ? `${t("{{used}} / {{total}}", {
                        used: formatBytes(memory.used),
                        total: formatBytes(memory.total),
                      })}${
                        memory.swap_total > 0
                          ? t(" · swap {{size}}", { size: formatBytes(memory.swap_used) })
                          : ""
                      }`
                    : t("Waiting for data")
                }
              />
              <MetricCard
                icon={HardDrive}
                label={t("Disk usage")}
                value={fullestDisk ? fullestDisk.usage_percent.toFixed(1) : "—"}
                unit="%"
                percent={fullestDisk?.usage_percent}
                detail={
                  fullestDisk
                    ? t("Highest: {{mount}} · {{count}} filesystems", {
                        mount: fullestDisk.mount_point,
                        count: snapshot?.disks.length ?? 0,
                      })
                    : snapshot
                      ? t("No filesystems detected")
                      : t("Waiting for data")
                }
              />
              <MetricCard
                icon={Gauge}
                label={t("Load average")}
                value={cpu ? cpu.load_1.toFixed(2) : "—"}
                unit={t("1 min")}
                percent={
                  cpu && cpu.logical_cores > 0 ? (cpu.load_1 / cpu.logical_cores) * 100 : undefined
                }
                detail={
                  cpu
                    ? t("5m {{five}} · 15m {{fifteen}} · {{count}} cores", {
                        five: cpu.load_5.toFixed(2),
                        fifteen: cpu.load_15.toFixed(2),
                        count: cpu.logical_cores,
                      })
                    : t("Waiting for data")
                }
              />
            </div>

            {/* Trends — 30 minutes */}
            <div className="flex flex-wrap gap-3">
              <TrendChart
                title={t("CPU usage")}
                value={`${(cpu?.usage_percent ?? 0).toFixed(1)}%`}
                detail={t("{{count}} samples", { count: entry?.history.length ?? 0 })}
                points={entry?.history ?? []}
                pick={(point) => point.cpu}
                max={100}
                tone="text-accent"
              />
              <TrendChart
                title={t("Memory usage")}
                value={`${(memory?.usage_percent ?? 0).toFixed(1)}%`}
                detail={memory ? t("{{size}} available", { size: formatBytes(memory.available) }) : ""}
                points={entry?.history ?? []}
                pick={(point) => point.memory}
                max={100}
                tone="text-success"
              />
              <TrendChart
                title={t("Download")}
                value={formatSpeed(throughput.download)}
                detail={t("All non-loopback interfaces")}
                points={entry?.history ?? []}
                pick={(point) => point.download}
                max={1}
                tone="text-ai"
              />
              <TrendChart
                title={t("Upload")}
                value={formatSpeed(throughput.upload)}
                detail={t("All non-loopback interfaces")}
                points={entry?.history ?? []}
                pick={(point) => point.upload}
                max={1}
                tone="text-warning"
              />
            </div>

            {/* Detail categories: object tabs, not work tabs. */}
            <div className="overflow-hidden rounded-[12px] border border-line bg-content">
              <PageTabs
                value={detail}
                onChange={setDetail}
                label={t("Detail categories")}
                panelId={`monitor-${tab.id}-detail`}
                items={DETAIL_TABS.map((item) => {
                  const Icon = item.icon;
                  return {
                    id: item.id,
                    icon: <Icon size={12} strokeWidth={1.75} />,
                    label: t(item.labelKey),
                    count:
                      item.id === "disk"
                        ? (snapshot?.disks.length ?? 0)
                        : item.id === "network"
                          ? (snapshot?.network.length ?? 0)
                          : (snapshot?.processes.length ?? 0),
                  };
                })}
              />
              <div role="tabpanel" id={`monitor-${tab.id}-detail`}>
                {detail === "disk" && <DiskTable disks={snapshot?.disks ?? []} />}
                {detail === "network" && <NetworkTable network={snapshot?.network ?? []} />}
                {detail === "process" && <ProcessTable processes={snapshot?.processes ?? []} />}
              </div>
            </div>
          </div>
        )}
      </PageScroll>

      <PageStatusBar>
        <span className="page-statusbar__group">
          <span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", statusTone)} />
          <span>{statusLabel}</span>
        </span>
        {snapshot?.system.hostname && (
          <>
            <span className="text-line-strong">|</span>
            <span className="font-mono">{snapshot.system.hostname}</span>
          </>
        )}
        {snapshot && (
          <>
            <span className="text-line-strong">|</span>
            <span title={`${snapshot.system.kernel} ${snapshot.system.architecture}`}>
              {snapshot.system.os_name}
              {snapshot.system.os_version ? ` ${snapshot.system.os_version}` : ""}
            </span>
          </>
        )}
        {snapshot && (
          <>
            <span className="text-line-strong">|</span>
            <span>{t("Up {{time}}", { time: formatUptime(snapshot.system.uptime_seconds) })}</span>
          </>
        )}
        {server?.proxy_jump_id && <span>{t("via jump host")}</span>}
        <span className="page-statusbar__spacer" />
        {entry?.collecting && <span className="h-[5px] w-[5px] animate-pulse rounded-full bg-accent" />}
        <span>{formatClock(entry?.lastUpdatedAt ?? null)}</span>
      </PageStatusBar>
    </PageSurface>
  );
}
