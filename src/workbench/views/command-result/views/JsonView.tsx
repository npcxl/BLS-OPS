import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * 通用 JSON 查看器 —— `docker inspect` / `kubectl -o json` / API 返回共用。
 *
 * 优先按**表格**渲染（对象数组列稳定时更好读），否则退回格式化 JSON。
 * 任何时候都不修改原始数据。
 */
export function JsonView({ value }: { value: unknown }) {
  const [mode, setMode] = useState<"auto" | "json">("auto");
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);

  // 对象数组且 key 稳定 → 用表格展示（更紧凑、可扫读）。
  const tableable = useMemo(() => {
    if (mode === "json") return null;
    if (!Array.isArray(value) || value.length === 0) return null;
    const objects = value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
    if (objects.length !== value.length) return null;
    const keys = new Set<string>();
    for (const item of objects) {
      for (const key of Object.keys(item)) keys.add(key);
    }
    if (keys.size === 0 || keys.size > 12) return null;
    return { columns: [...keys], rows: objects };
  }, [value, mode]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-11 text-fg-muted">
          {Array.isArray(value) ? `${value.length} 条记录` : "JSON"}
        </span>
        {tableable && (
          <button
            type="button"
            onClick={() => setMode(mode === "auto" ? "json" : "auto")}
            className="ml-auto rounded-full px-2 py-0.5 text-10 text-fg-subtle transition-colors hover:text-fg"
          >
            {mode === "auto" ? "查看原始 JSON" : "查看表格"}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tableable ? (
          <table className="w-full border-collapse text-left text-11">
            <thead className="sticky top-0 z-10 bg-surface-2/90 backdrop-blur">
              <tr>
                {tableable.columns.map((key) => (
                  <th key={key} className="px-3 py-1.5">
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableable.rows.map((row, index) => (
                <tr
                  key={index}
                  className="border-t border-line/60 transition-colors hover:bg-surface-hover/60"
                >
                  {tableable.columns.map((key) => {
                    const cell = row[key];
                    const text =
                      typeof cell === "object" && cell !== null
                        ? JSON.stringify(cell)
                        : String(cell ?? "");
                    return (
                      <td
                        key={key}
                        className={cn("max-w-[300px] truncate px-3 py-1.5 font-mono text-fg-muted")}
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
        ) : (
          <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-11 leading-[1.55] text-fg-muted">
            {pretty}
          </pre>
        )}
      </div>
    </div>
  );
}
