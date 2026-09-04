import { useTranslation } from "react-i18next";
import type { DiskMetrics, NetworkMetrics, ProcessInfo } from "@/api/ops-api";
import { formatBytes, formatSpeed } from "@/lib/format";
import { cn } from "@/lib/cn";
import { usageTone } from "./MetricCard";

export function DiskTable({ disks }: { disks: DiskMetrics[] }) {
  const { t } = useTranslation();
  if (disks.length === 0) {
    return (
      <p className="px-3 py-4 text-12 text-fg-subtle">
        {t("No filesystems reported (the host may be unsupported, or a command failed).")}
      </p>
    );
  }
  return (
    <table className="w-full text-11">
      <thead className="sticky top-0 bg-surface-2 text-fg-subtle">
        <tr>
          {[
            t("Mount point"),
            t("Device"),
            t("Type"),
            t("Size"),
            t("Used"),
            t("Avail"),
            t("Usage"),
          ].map((head) => (
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

export function NetworkTable({ network }: { network: NetworkMetrics[] }) {
  const { t } = useTranslation();
  if (network.length === 0) {
    return (
      <p className="px-3 py-4 text-12 text-fg-subtle">
        {t("No network interfaces reported (loopback lo excluded).")}
      </p>
    );
  }
  return (
    <table className="w-full text-11">
      <thead className="sticky top-0 bg-surface-2 text-fg-subtle">
        <tr>
          {[
            t("Interface"),
            t("Total received"),
            t("Total sent"),
            t("Download"),
            t("Upload"),
          ].map((head) => (
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

export function ProcessTable({ processes }: { processes: ProcessInfo[] }) {
  const { t } = useTranslation();
  if (processes.length === 0) {
    return <p className="px-3 py-4 text-12 text-fg-subtle">{t("No process list reported.")}</p>;
  }
  return (
    <table className="w-full text-11">
      <thead className="sticky top-0 bg-surface-2 text-fg-subtle">
        <tr>
          {[
            t("PID"),
            t("User"),
            t("CPU"),
            t("Memory"),
            t("Status"),
            t("Started"),
            t("Command"),
          ].map((head) => (
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
