import { cn } from "@/lib/cn";

/**
 * 通用指标卡 —— `free` / `uptime` / `vmstat` / `iostat` 共用。
 * 行契约：`{label, value, unit?, tone?}`。
 */
export function MetricsView({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return <p className="px-3 py-6 text-center text-11 text-fg-subtle">没有指标数据。</p>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {rows.map((row, index) => (
          <div
            key={`${String(row.label ?? index)}-${index}`}
            className="rounded-[8px] border border-line bg-surface-2/60 px-2.5 py-2"
          >
            <div className="truncate text-10 text-fg-subtle" title={String(row.label ?? "")}>
              {String(row.label ?? "")}
            </div>
            <div
              className={cn(
                "mt-0.5 truncate font-mono text-13 text-fg",
                row.tone === "danger"
                  ? "text-danger"
                  : row.tone === "warning"
                    ? "text-warning"
                    : row.tone === "success"
                      ? "text-success"
                      : undefined,
              )}
              title={String(row.value ?? "")}
            >
              {String(row.value ?? "")}
              {row.unit ? <span className="ml-0.5 text-10 text-fg-subtle">{String(row.unit)}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
