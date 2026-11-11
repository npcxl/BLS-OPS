import { useTranslation } from "react-i18next";
import { HardDrive } from "@/components/icons";
import type { DiskMetrics, NetworkMetrics, ProcessInfo } from "@/api/ops-api";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBytes, formatSpeed } from "@/lib/format";
import { cn } from "@/lib/cn";
import { usageTone } from "./MetricCard";

/** 常见挂载点的用途说明：只映射**确定语义**的路径，其余留空，不猜。 */
function mountHint(path: string, t: (key: string) => string): string | undefined {
  if (path === "/") return t("System root");
  if (path === "/boot" || path === "/boot/efi") return t("Boot partition");
  if (path === "/home") return t("Home directory");
  return undefined;
}

export function DiskTable({ disks }: { disks: DiskMetrics[] }) {
  const { t } = useTranslation();
  if (disks.length === 0) {
    return (
      <EmptyState
        className="min-h-24 py-4"
        title={t("No filesystems reported")}
        description={t("The host may be unsupported, or the command failed.")}
      />
    );
  }
  return (
    <table className="page-table text-11">
      <thead>
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
            <th key={head} className="whitespace-nowrap">
              {head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {disks.map((disk) => {
          const hint = mountHint(disk.mount_point, t);
          return (
            <tr key={`${disk.device}-${disk.mount_point}`} className="border-t border-line/70">
              <td className="whitespace-nowrap">
                <div className="flex items-center gap-1.5">
                  <HardDrive size={11} strokeWidth={1.75} className="shrink-0 text-fg-subtle" />
                  <span className="font-mono text-fg">{disk.mount_point}</span>
                  {hint && <span className="text-10 text-fg-subtle">({hint})</span>}
                </div>
              </td>
              <td className="whitespace-nowrap font-mono text-fg-muted">{disk.device}</td>
              <td className="text-fg-muted">{disk.filesystem}</td>
              <td className="whitespace-nowrap font-mono text-fg-muted">{formatBytes(disk.total)}</td>
              <td className="whitespace-nowrap font-mono text-fg-muted">{formatBytes(disk.used)}</td>
              <td className="whitespace-nowrap font-mono text-fg-muted">
                {formatBytes(disk.available)}
              </td>
              <td>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-3">
                    <div
                      className={cn("h-full rounded-full", usageTone(disk.usage_percent))}
                      style={{ width: `${Math.min(100, Math.max(0, disk.usage_percent))}%` }}
                    />
                  </div>
                  <span className="w-11 shrink-0 text-right font-mono text-fg">
                    {disk.usage_percent.toFixed(1)}%
                  </span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function NetworkTable({ network }: { network: NetworkMetrics[] }) {
  const { t } = useTranslation();
  if (network.length === 0) {
    return (
      <EmptyState
        className="min-h-24 py-4"
        title={t("No network interfaces reported")}
        description={t("Loopback interfaces are excluded.")}
      />
    );
  }
  return (
    <table className="page-table text-11">
      <thead>
        <tr>
          {[
            t("Interface"),
            t("Total received"),
            t("Total sent"),
            t("Download"),
            t("Upload"),
          ].map((head) => (
            <th key={head}>{head}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {network.map((nic) => (
          <tr key={nic.interface} className="border-t border-line/70">
            <td className="font-mono text-fg">{nic.interface}</td>
            <td className="text-fg-muted">{formatBytes(nic.received_bytes)}</td>
            <td className="text-fg-muted">{formatBytes(nic.transmitted_bytes)}</td>
            <td className="font-mono text-fg">{formatSpeed(nic.receive_speed)}</td>
            <td className="font-mono text-fg">{formatSpeed(nic.transmit_speed)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProcessTable({ processes }: { processes: ProcessInfo[] }) {
  const { t } = useTranslation();
  if (processes.length === 0) {
    return (
      <EmptyState
        className="min-h-24 py-4"
        title={t("No process list reported")}
        description={t("The host may be unsupported, or the command failed.")}
      />
    );
  }
  return (
    <table className="page-table text-11">
      <thead>
        <tr>
          {[t("PID"), t("User"), t("CPU"), t("Memory"), t("Status"), t("Started"), t("Command")].map(
            (head) => (
              <th key={head}>{head}</th>
            ),
          )}
        </tr>
      </thead>
      <tbody>
        {processes.map((process) => (
          <tr key={process.pid} className="border-t border-line/70">
            <td className="font-mono text-fg">{process.pid}</td>
            <td className="text-fg-muted">{process.user}</td>
            <td className="font-mono text-fg">{process.cpu_percent.toFixed(1)}%</td>
            <td className="font-mono text-fg-muted">{process.memory_percent.toFixed(1)}%</td>
            <td className="text-fg-muted">{process.status}</td>
            <td className="whitespace-nowrap text-fg-muted">{process.started_at}</td>
            <td className="max-w-0 truncate font-mono text-fg-muted" title={process.command}>
              {process.command}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
