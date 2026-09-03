import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import type {
  DiskRow,
  JournalEntryRow,
  ListenerRow,
  NginxSiteRow,
  ProcessRow,
  SystemdUnitRow,
} from "@/api/ops-api";

/**
 * P4.3.2 结构化表格：systemd 服务 / 进程 / 磁盘 / 端口监听 / Nginx 站点 /
 * journald 日志。全部只读展示，紧凑共享样式；数据一律来自后端适配器，
 * 原始输出仍在"原始输出"Tab 永久保留。
 */

const CELL = "px-3 py-1.5 align-top";

function Wrap({ children, max }: { children: React.ReactNode; max?: number }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-left text-11">
        <thead className="sticky top-0 z-10 bg-surface-2/90 backdrop-blur">
          {children}
        </thead>
      </table>
      {max !== undefined && max > 0 && (
        <p className="px-3 py-1 text-10 text-fg-subtle">仅显示前 {max} 条。</p>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-3 py-6 text-center text-11 text-fg-subtle">{text}</p>;
}

// ---------------------------------------------------------------------------
// systemd 服务表
// ---------------------------------------------------------------------------

/** 服务行的状态语义色：active/running 绿，failed 红，其余弱化。 */
function unitTone(unit: SystemdUnitRow): string {
  if (unit.active === "failed" || unit.sub === "failed") return "text-danger";
  if (unit.active === "active") return "text-success";
  return "text-fg-subtle";
}

export function UnitTable({ units }: { units: SystemdUnitRow[] }) {
  const [filter, setFilter] = useState<"all" | "active" | "failed">("all");
  const visible = useMemo(() => {
    if (filter === "active") return units.filter((u) => u.active === "active");
    if (filter === "failed") return units.filter((u) => u.active === "failed" || u.sub === "failed");
    return units;
  }, [units, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-3 py-1.5">
        <span className="mr-auto text-11 text-fg-muted">共 {units.length} 个服务</span>
        {(["all", "active", "failed"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cn(
              "rounded-full px-2 py-0.5 text-10 transition-colors",
              filter === key ? "bg-accent/12 text-accent" : "text-fg-subtle hover:text-fg",
            )}
          >
            {key === "all" ? "全部" : key === "active" ? "运行中" : "失败"}
          </button>
        ))}
      </div>
      <Wrap>
        <tr>
          <th className={CELL}>状态</th>
          <th className={CELL}>服务</th>
          <th className={CELL}>说明</th>
        </tr>
        {visible.map((unit) => (
          <tr
            key={unit.unit}
            className="border-t border-line/60 transition-colors hover:bg-surface-hover/60"
            title={`${unit.unit} · load=${unit.load} · active=${unit.active}/${unit.sub}`}
          >
            <td className={cn(CELL, "whitespace-nowrap", unitTone(unit))}>
              {unit.active === "active" ? "运行中" : unit.active === "failed" ? "失败" : unit.sub}
            </td>
            <td className={cn(CELL, "font-mono text-fg")}>{unit.unit}</td>
            <td className={cn(CELL, "max-w-[360px] truncate text-fg-muted")} title={unit.description}>
              {unit.description}
            </td>
          </tr>
        ))}
        {visible.length === 0 && (
          <tr>
            <td colSpan={3}>
              <Empty text="该筛选下没有服务。" />
            </td>
          </tr>
        )}
      </Wrap>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 进程表
// ---------------------------------------------------------------------------

export function ProcessTable({ processes }: { processes: ProcessRow[] }) {
  return (
    <Wrap max={processes.length}>
      <tr>
        <th className={CELL}>PID</th>
        <th className={CELL}>进程</th>
        <th className={CELL}>CPU%</th>
        <th className={CELL}>内存%</th>
        <th className={CELL}>运行时长</th>
      </tr>
      {processes.map((row) => (
        <tr
          key={`${row.pid}-${row.comm}`}
          className="border-t border-line/60 transition-colors hover:bg-surface-hover/60"
        >
          <td className={cn(CELL, "font-mono text-fg-subtle")}>{row.pid}</td>
          <td className={cn(CELL, "font-mono text-fg")}>{row.comm}</td>
          <td className={cn(CELL, "tabular-nums", Number(row.pcpu) > 50 ? "text-warning" : "text-fg-muted")}>
            {row.pcpu}
          </td>
          <td className={cn(CELL, "tabular-nums text-fg-muted")}>{row.pmem}</td>
          <td className={cn(CELL, "tabular-nums text-fg-subtle")}>{formatUptime(row.etimes)}</td>
        </tr>
      ))}
      {processes.length === 0 && (
        <tr>
          <td colSpan={5}>
            <Empty text="没有进程数据。" />
          </td>
        </tr>
      )}
    </Wrap>
  );
}

function formatUptime(seconds: string): string {
  const total = Number(seconds);
  if (!Number.isFinite(total)) return seconds;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}天${hours}时`;
  if (hours > 0) return `${hours}时${minutes}分`;
  return `${minutes}分`;
}

// ---------------------------------------------------------------------------
// 磁盘表
// ---------------------------------------------------------------------------

export function DiskTable({ filesystems }: { filesystems: DiskRow[] }) {
  return (
    <Wrap>
      <tr>
        <th className={CELL}>文件系统</th>
        <th className={CELL}>容量</th>
        <th className={CELL}>已用</th>
        <th className={CELL}>可用</th>
        <th className={CELL}>使用率</th>
        <th className={CELL}>挂载点</th>
      </tr>
      {filesystems.map((row) => {
        const percent = Number.parseFloat(row.use_percent);
        return (
          <tr
            key={`${row.filesystem}-${row.mounted_on}`}
            className="border-t border-line/60 transition-colors hover:bg-surface-hover/60"
          >
            <td className={cn(CELL, "font-mono text-fg-muted")}>{row.filesystem}</td>
            <td className={cn(CELL, "tabular-nums text-fg-muted")}>{row.size}</td>
            <td className={cn(CELL, "tabular-nums text-fg-muted")}>{row.used}</td>
            <td className={cn(CELL, "tabular-nums text-fg-muted")}>{row.avail}</td>
            <td
              className={cn(
                CELL,
                "tabular-nums",
                percent >= 90 ? "text-danger" : percent >= 75 ? "text-warning" : "text-fg",
              )}
            >
              {row.use_percent}
            </td>
            <td className={cn(CELL, "font-mono text-fg")}>{row.mounted_on}</td>
          </tr>
        );
      })}
      {filesystems.length === 0 && (
        <tr>
          <td colSpan={6}>
            <Empty text="没有文件系统数据。" />
          </td>
        </tr>
      )}
    </Wrap>
  );
}

// ---------------------------------------------------------------------------
// 端口监听表
// ---------------------------------------------------------------------------

export function ListenerTable({ listeners }: { listeners: ListenerRow[] }) {
  return (
    <Wrap>
      <tr>
        <th className={CELL}>端口</th>
        <th className={CELL}>监听地址</th>
        <th className={CELL}>进程</th>
        <th className={CELL}>PID</th>
      </tr>
      {listeners.map((row, index) => (
        <tr
          key={`${row.local}-${index}`}
          className="border-t border-line/60 transition-colors hover:bg-surface-hover/60"
        >
          <td className={cn(CELL, "font-mono text-fg")}>{row.port}</td>
          <td className={cn(CELL, "font-mono text-fg-muted")}>{row.local}</td>
          <td className={cn(CELL, "font-mono text-fg")}>{row.process || "—"}</td>
          <td className={cn(CELL, "font-mono text-fg-subtle")}>{row.pid || "—"}</td>
        </tr>
      ))}
      {listeners.length === 0 && (
        <tr>
          <td colSpan={4}>
            <Empty text="没有 TCP 监听端口。" />
          </td>
        </tr>
      )}
    </Wrap>
  );
}

// ---------------------------------------------------------------------------
// Nginx 站点表
// ---------------------------------------------------------------------------

export function NginxSiteTable({ sites }: { sites: NginxSiteRow[] }) {
  return (
    <Wrap>
      <tr>
        <th className={CELL}>server_name</th>
        <th className={CELL}>listen</th>
        <th className={CELL}>root（静态站点）</th>
        <th className={CELL}>proxy_pass（代理目标）</th>
        <th className={CELL}>配置文件</th>
      </tr>
      {sites.map((site, index) => (
        <tr
          key={`${site.server_name}-${index}`}
          className="border-t border-line/60 transition-colors hover:bg-surface-hover/60"
        >
          <td className={cn(CELL, "font-mono text-fg")}>{site.server_name}</td>
          <td className={cn(CELL, "font-mono text-fg-muted")}>
            {site.listen_ports.join("/") || "—"}
          </td>
          <td className={cn(CELL, "max-w-[220px] truncate font-mono text-fg-muted")} title={site.root ?? undefined}>
            {site.root || "—"}
          </td>
          <td className={cn(CELL, "max-w-[240px] truncate font-mono text-fg-muted")} title={site.proxy_targets.join(", ")}>
            {site.proxy_targets.join(", ") || "—"}
          </td>
          <td className={cn(CELL, "max-w-[200px] truncate font-mono text-fg-subtle")} title={site.config_file ?? undefined}>
            {site.config_file || "—"}
          </td>
        </tr>
      ))}
      {sites.length === 0 && (
        <tr>
          <td colSpan={5}>
            <Empty text="没有解析出站点（可能只有全局配置）。" />
          </td>
        </tr>
      )}
    </Wrap>
  );
}

// ---------------------------------------------------------------------------
// journald 日志查看器
// ---------------------------------------------------------------------------

const LEVEL_TONES: Record<string, { label: string; tone: string }> = {
  "0": { label: "emerg", tone: "bg-danger/20 text-danger" },
  "1": { label: "alert", tone: "bg-danger/20 text-danger" },
  "2": { label: "crit", tone: "bg-danger/15 text-danger" },
  "3": { label: "err", tone: "bg-danger/12 text-danger" },
  "4": { label: "warn", tone: "bg-warning/12 text-warning" },
  "5": { label: "notice", tone: "bg-accent/12 text-accent" },
  "6": { label: "info", tone: "bg-surface-3 text-fg-subtle" },
  "7": { label: "debug", tone: "bg-surface-3 text-fg-subtle" },
};

/** journald 时间戳是微秒 epoch → 本地时间展示。 */
function formatJournalTime(micros: string): string {
  const value = Number(micros);
  if (!Number.isFinite(value) || value <= 0) return micros || "—";
  return new Date(value / 1000).toLocaleString();
}

export function JournalViewer({ entries }: { entries: JournalEntryRow[] }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const visible = useMemo(
    () => (errorsOnly ? entries.filter((entry) => Number(entry.level) <= 4) : entries),
    [entries, errorsOnly],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-11 text-fg-muted">{entries.length} 条日志</span>
        <button
          type="button"
          onClick={() => setErrorsOnly((current) => !current)}
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-10 transition-colors",
            errorsOnly ? "bg-danger/12 text-danger" : "text-fg-subtle hover:text-fg",
          )}
        >
          只看错误与警告
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.map((entry, index) => {
          const level = LEVEL_TONES[entry.level] ?? LEVEL_TONES["6"];
          return (
            <div
              key={`${entry.timestamp}-${index}`}
              className="flex gap-2 border-b border-line/40 px-3 py-1.5 transition-colors hover:bg-surface-hover/40"
            >
              <span className="w-14 shrink-0">
                <span className={cn("rounded px-1 py-0.5 text-9", level.tone)}>{level.label}</span>
              </span>
              <span className="w-40 shrink-0 text-10 tabular-nums text-fg-subtle">
                {formatJournalTime(entry.timestamp)}
              </span>
              <span className="w-32 shrink-0 truncate font-mono text-10 text-fg-muted" title={entry.unit}>
                {entry.unit}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-11 text-fg-muted">
                {entry.message}
              </span>
            </div>
          );
        })}
        {visible.length === 0 && <Empty text={errorsOnly ? "没有错误与警告。" : "没有日志。"} />}
      </div>
    </div>
  );
}
