import { cn } from "@/lib/cn";
import { COPYABLE, CopyNotice, clickCopyProps, useCopyFeedback } from "@/components/ui/copy-feedback";

/**
 * 通用指标卡 —— `free` / `uptime` / `vmstat` / `iostat` 共用。
 * 行契约：`{label, value, unit?, tone?}`。
 *
 * 点击卡片 → 复制"名称 + 数值 + 单位"（三个部分用空格连接）。
 */
export function MetricsView({ rows }: { rows: Record<string, unknown>[] }) {
  const { status, copy } = useCopyFeedback();

  if (rows.length === 0) {
    return <p className="px-3 py-6 text-center text-11 text-fg-subtle">没有指标数据。</p>;
  }
  return (
    <div className="relative min-h-0 flex-1 overflow-auto p-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {rows.map((row, index) => {
          const label = String(row.label ?? "");
          const value = String(row.value ?? "");
          const unit = String(row.unit ?? "");
          const summary = [label, value, unit].filter((part) => part !== "").join(" ");
          return (
            <button
              key={`${label}-${index}`}
              type="button"
              data-testid="metric-card"
              {...clickCopyProps(() => void copy(summary))}
              className={cn(
                COPYABLE,
                "block rounded-[8px] border border-line bg-surface-2/60 px-2.5 py-2",
              )}
              title="点击复制：名称 + 数值 + 单位"
            >
              <span className="block truncate text-10 text-fg-subtle" title={label}>
                {label}
              </span>
              <span
                className={cn(
                  "mt-0.5 block truncate font-mono text-13",
                  row.tone === "danger"
                    ? "text-danger"
                    : row.tone === "warning"
                      ? "text-warning"
                      : row.tone === "success"
                        ? "text-success"
                        : "text-fg",
                )}
                title={value}
              >
                {value}
                {unit ? <span className="ml-0.5 text-10 text-fg-subtle">{unit}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <CopyNotice status={status} />
    </div>
  );
}
