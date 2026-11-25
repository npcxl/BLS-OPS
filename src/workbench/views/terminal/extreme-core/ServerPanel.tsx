import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "@/components/icons";
import { cn } from "@/lib/cn";
import { formatBytes, formatSpeed, formatUptime } from "@/lib/format";
import { opsApi } from "@/api/ops-api";
import type { ContainerInfo, MonitorSnapshot } from "@/api/ops-api";
import type { ServiceUnit } from "@/api/types/services";
import type { PanelTab } from "./panel-target";
import { ExtremeIconButton } from "./ExtremeIconButton";

/**
 * 右栏：**服务器运行面板**。
 *
 * 和「远程文件」是两个独立面板（不是同一个面板的两个标签）：
 * 这里看的是这台服务器**现在在跑什么** —— CPU / 内存 / 磁盘 / 网络、服务与容器、
 * 实时日志、命令输出。
 *
 * 数据全部来自现有的监控能力（`monitor_snapshot` / `service_list` /
 * `docker_snapshot`），面板只在可见时轮询，断开连接就停下并如实显示未连接。
 */

const STATUS_POLL = 3000;
const SERVICE_POLL = 8000;

export function ServerPanel({
  sessionId,
  serverName,
  tab,
  shown,
  overlay = false,
  onTabChange,
  onClose,
  logs,
  output,
}: {
  /** 这台服务器的当前连接；`null` = 未连接（只显示状态，不轮询）。 */
  sessionId: string | null;
  serverName: string;
  tab: PanelTab;
  shown: boolean;
  /** 窗口太窄：临时覆盖聊天，而不是把聊天挤没。 */
  overlay?: boolean;
  onTabChange: (tab: PanelTab) => void;
  onClose: () => void;
  /** 实时日志标签（由页面注入，保持监听在页面级）。 */
  logs: ReactNode;
  output: ReactNode;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceUnit[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [serviceError, setServiceError] = useState<string | null>(null);

  const loadStatus = useCallback(async (id: string) => {
    try {
      const next = await opsApi.monitorSnapshot(id);
      setSnapshot(next);
      setSnapshotError(null);
    } catch (cause) {
      setSnapshotError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const loadServices = useCallback(async (id: string) => {
    try {
      const [units, docker] = await Promise.all([
        opsApi.serviceList(id),
        opsApi.dockerSnapshot(id).catch(() => null),
      ]);
      setServices(units);
      setContainers(docker?.containers ?? []);
      setServiceError(null);
    } catch (cause) {
      setServiceError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  // 只在这两个标签可见时轮询；切走就停，别拿没必要的 SSH 请求打扰服务器。
  useEffect(() => {
    if (!shown || !sessionId) return undefined;
    if (tab !== "status" && tab !== "services") return undefined;
    const load = tab === "status" ? loadStatus : loadServices;
    void load(sessionId);
    const timer = window.setInterval(
      () => void load(sessionId),
      tab === "status" ? STATUS_POLL : SERVICE_POLL,
    );
    return () => window.clearInterval(timer);
  }, [shown, sessionId, tab, loadStatus, loadServices]);

  const cpu = snapshot?.cpu;
  const memory = snapshot?.memory;
  const disk = useMemo(
    () =>
      [...(snapshot?.disks ?? [])].sort((a, b) => b.usage_percent - a.usage_percent)[0] ?? null,
    [snapshot?.disks],
  );
  const net = useMemo(() => {
    const list = snapshot?.network ?? [];
    return {
      rx: list.reduce((sum, item) => sum + item.receive_speed, 0),
      tx: list.reduce((sum, item) => sum + item.transmit_speed, 0),
    };
  }, [snapshot?.network]);
  const top = useMemo(
    () => [...(snapshot?.processes ?? [])].sort((a, b) => b.cpu_percent - a.cpu_percent).slice(0, 5),
    [snapshot?.processes],
  );
  const running = services.filter((unit) => unit.active === "active");

  if (!shown) return null;

  const tabs: [PanelTab, string][] = [
    ["status", t("运行状态")],
    ["services", t("服务与容器")],
    ["logs", t("实时日志")],
    ["output", t("命令输出")],
  ];

  return (
    <aside
      className={cn(
        "extreme-core-frosted flex w-[340px] flex-col overflow-hidden border-l border-line/70",
        overlay ? "absolute inset-y-0 right-0 z-20 shadow-2xl" : "extreme-core-remote-rail shrink-0",
      )}
      aria-label={t("服务器运行面板")}
    >
      <div className="flex items-center gap-1 border-b border-line/70 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-11 text-fg-muted" title={serverName}>
          {serverName}
        </span>
        <ExtremeIconButton
          label={t("收起面板")}
          icon={X}
          iconSize={12}
          className="size-6"
          onClick={onClose}
        />
      </div>

      <div className="flex items-center gap-1 border-b border-line/70 px-2 py-1">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => onTabChange(id)}
            className={cn(
              "rounded-[6px] px-1.5 py-0.5 text-11",
              tab === id ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-hover",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {!sessionId && (
        <p
          role="status"
          className="border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-11 text-warning"
        >
          {t("服务器未连接：重新连接后才能看到实时数据。")}
        </p>
      )}

      {tab === "status" && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
          {snapshotError && <p className="text-11 text-danger">{snapshotError}</p>}
          {snapshot && !snapshot.supported && (
            <p className="text-11 text-warning">
              {snapshot.unsupported_reason || t("这台系统不支持指标采集")}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Stat label={t("CPU")} value={cpu ? `${cpu.usage_percent.toFixed(0)}%` : "—"} />
            <Stat
              label={t("负载")}
              value={cpu ? `${cpu.load_1.toFixed(2)} / ${cpu.load_5.toFixed(2)}` : "—"}
            />
            <Stat
              label={t("内存")}
              value={memory ? `${memory.usage_percent.toFixed(0)}%` : "—"}
              detail={
                memory ? `${formatBytes(memory.used)} / ${formatBytes(memory.total)}` : undefined
              }
            />
            <Stat
              label={t("磁盘")}
              value={disk ? `${disk.usage_percent.toFixed(0)}%` : "—"}
              detail={disk ? `${disk.mount_point} · ${formatBytes(disk.available)} 可用` : undefined}
            />
            <Stat label={t("网络 ↓")} value={formatSpeed(net.rx)} />
            <Stat label={t("网络 ↑")} value={formatSpeed(net.tx)} />
          </div>
          {snapshot?.system && (
            <p className="truncate text-10 text-fg-subtle" title={snapshot.system.hostname}>
              {snapshot.system.os_name} {snapshot.system.os_version} · {t("已运行")}{" "}
              {formatUptime(snapshot.system.uptime_seconds)}
            </p>
          )}
          {top.length > 0 && (
            <div>
              <p className="mb-1 text-10 text-fg-subtle">{t("占用最高的进程")}</p>
              <ul className="space-y-0.5">
                {top.map((process) => (
                  <li
                    key={process.pid}
                    className="flex items-center gap-2 text-11 text-fg-muted"
                  >
                    <span className="min-w-0 flex-1 truncate" title={process.command}>
                      {process.command}
                    </span>
                    <span className="shrink-0 text-10 text-fg-subtle">{process.pid}</span>
                    <span className="w-12 shrink-0 text-right tabular-nums">
                      {process.cpu_percent.toFixed(1)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {tab === "services" && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
          {serviceError && <p className="text-11 text-danger">{serviceError}</p>}
          <section>
            <p className="mb-1 text-10 text-fg-subtle">
              {t("容器")} · {containers.length}
            </p>
            {containers.length === 0 ? (
              <p className="text-11 text-fg-subtle">{t("没有运行中的容器")}</p>
            ) : (
              <ul className="space-y-0.5">
                {containers.map((container) => (
                  <li key={container.id} className="flex items-center gap-2 text-11">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        container.state === "running" ? "bg-success" : "bg-fg-subtle",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate" title={container.image}>
                      {container.name}
                    </span>
                    <span className="shrink-0 text-10 text-fg-subtle">{container.state}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <p className="mb-1 text-10 text-fg-subtle">
              {t("运行中的服务")} · {running.length}
            </p>
            {running.length === 0 ? (
              <p className="text-11 text-fg-subtle">{t("没有运行中的 systemd 服务")}</p>
            ) : (
              <ul className="space-y-0.5">
                {running.slice(0, 30).map((unit) => (
                  <li key={unit.unit} className="flex items-center gap-2 text-11">
                    <span className="size-1.5 shrink-0 rounded-full bg-success" />
                    <span className="min-w-0 flex-1 truncate" title={unit.description}>
                      {unit.unit}
                    </span>
                    <span className="shrink-0 text-10 text-fg-subtle">{unit.sub}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === "logs" && logs}
      {tab === "output" && output}
    </aside>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 rounded-[10px] border border-line bg-surface-1 px-2 py-1.5">
      <p className="truncate text-10 text-fg-subtle">{label}</p>
      <p className="truncate text-13 font-medium tabular-nums text-fg">{value}</p>
      {detail && (
        <p className="truncate text-10 text-fg-subtle" title={detail}>
          {detail}
        </p>
      )}
    </div>
  );
}
