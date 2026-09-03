import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { numericTone, type ColumnDefinition, type SummaryItem } from "../model";

const CELL = "px-3 py-1.5 align-top";

/**
 * 通用表格视图 —— `ps` / `df` / `ss` / `docker ps` / `systemctl list-units`
 * 共用这一个组件。列定义由后端给出（前端不猜列名与含义）。
 *
 * 支持本地筛选（表头输入框）与数值阈值着色。空结果是有效结果。
 */
export function TableView({
  columns,
  rows,
  summary,
}: {
  columns: ColumnDefinition[];
  rows: Record<string, unknown>[];
  summary?: SummaryItem[];
}) {
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      columns.some((column) =>
        String(row[column.key] ?? "").toLowerCase().includes(needle),
      ),
    );
  }, [rows, columns, filter]);

  if (columns.length === 0) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        {summary && summary.length > 0 && (
          <span className="flex items-center gap-2 text-11 text-fg-muted">
            {summary.map((item, index) => (
              <span key={`${item.label}-${index}`}>
                {item.label}{" "}
                <b className={cn("font-medium", item.tone ? toneClass(item.tone) : "text-fg")}>
                  {item.value}
                </b>
              </span>
            ))}
          </span>
        )}
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="筛选…"
          spellCheck={false}
          className="ml-auto h-[22px] w-40 rounded-[5px] border border-line bg-surface-2 px-1.5 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left text-11">
          <thead className="sticky top-0 z-10 bg-surface-2/90 backdrop-blur">
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={cn(CELL, column.numeric && "text-right")}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr
                key={index}
                className="border-t border-line/60 transition-colors hover:bg-surface-hover/60"
              >
                {columns.map((column) => {
                  const value = row[column.key];
                  const tone = numericTone(value, column);
                  const text = String(value ?? "");
                  return (
                    <td
                      key={column.key}
                      className={cn(
                        CELL,
                        "max-w-[380px] truncate",
                        column.numeric ? "text-right tabular-nums" : "font-mono",
                        tone ?? (column.numeric ? "text-fg-muted" : "text-fg"),
                      )}
                      title={text}
                    >
                      {text || "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="px-3 py-6 text-center text-11 text-fg-subtle">
            {rows.length === 0 ? "没有数据。" : "没有匹配的记录。"}
          </p>
        )}
      </div>
    </div>
  );
}

function toneClass(tone: string): string {
  return (
    { success: "text-success", warning: "text-warning", danger: "text-danger", accent: "text-accent" }[
      tone
    ] ?? "text-fg"
  );
}
