import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * 通用日志流 —— `journalctl` / `tail` / `dmesg` / `docker logs` / nginx 日志
 * 共用。行契约：`{timestamp?, level?, unit?, message}`。
 *
 * level 沿用 journald PRIORITY 数字（0-7）：≤3 错误、4 警告、其余常规。
 * 时间戳为空时不占位（认不出就不伪造时间）。
 */

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

/** 微秒 epoch → 本地时间；解析不出来就原样返回（不伪造）。 */
function formatTime(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const value = Number(text);
  if (Number.isFinite(value) && value > 0 && text.length >= 16) {
    return new Date(value / 1000).toLocaleString();
  }
  return text;
}

export function LogView({ rows }: { rows: Record<string, unknown>[] }) {
  const [severeOnly, setSevereOnly] = useState(false);

  const visible = useMemo(() => {
    if (!severeOnly) return rows;
    return rows.filter((row) => {
      const level = Number(row.level);
      return Number.isFinite(level) && level <= 4;
    });
  }, [rows, severeOnly]);

  const severeCount = useMemo(
    () =>
      rows.filter((row) => {
        const level = Number(row.level);
        return Number.isFinite(level) && level <= 4;
      }).length,
    [rows],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-11 text-fg-muted">{rows.length} 条</span>
        <button
          type="button"
          onClick={() => setSevereOnly((current) => !current)}
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-10 transition-colors",
            severeOnly ? "bg-danger/12 text-danger" : "text-fg-subtle hover:text-fg",
          )}
        >
          只看错误与警告（{severeCount}）
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.map((row, index) => {
          const level = LEVEL_TONES[String(row.level ?? "6")] ?? LEVEL_TONES["6"];
          const time = formatTime(row.timestamp);
          const unit = String(row.unit ?? "");
          return (
            <div
              key={index}
              className="flex gap-2 border-b border-line/40 px-3 py-1.5 transition-colors hover:bg-surface-hover/40"
            >
              <span className="w-12 shrink-0">
                <span className={cn("rounded px-1 py-0.5 text-9", level.tone)}>{level.label}</span>
              </span>
              {time && (
                <span className="w-40 shrink-0 text-10 tabular-nums text-fg-subtle">{time}</span>
              )}
              {unit && unit !== "—" && (
                <span
                  className="w-32 shrink-0 truncate font-mono text-10 text-fg-muted"
                  title={unit}
                >
                  {unit}
                </span>
              )}
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-11 text-fg-muted">
                {String(row.message ?? "")}
              </span>
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="px-3 py-6 text-center text-11 text-fg-subtle">
            {rows.length === 0 ? "没有日志。" : "没有错误与警告。"}
          </p>
        )}
      </div>
    </div>
  );
}
