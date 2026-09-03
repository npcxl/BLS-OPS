import { cn } from "@/lib/cn";

/**
 * 通用树视图 —— `tree` / `pstree` / nginx 配置嵌套 / 进程父子关系共用。
 *
 * 行契约：`{label, depth, detail?}`（**扁平列表 + 缩进层级**，不是嵌套结构：
 * 更好做滚动与筛选，也避免递归深度问题）。
 */
export function TreeView({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return <p className="px-3 py-6 text-center text-11 text-fg-subtle">没有节点。</p>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {rows.map((row, index) => {
        const depth = Number(row.depth ?? 0);
        const detail = String(row.detail ?? "");
        return (
          <div
            key={index}
            className="flex items-center gap-2 px-3 py-1 transition-colors hover:bg-surface-hover/40"
            // 每级缩进 14px；层级异常（负数/过大）时夹到 0..12，避免布局炸开。
            style={{ paddingLeft: 12 + clamp(depth) * 14 }}
          >
            {clamp(depth) > 0 && (
              <span className="shrink-0 text-10 text-fg-subtle">└</span>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-11 text-fg" title={String(row.label ?? "")}>
              {String(row.label ?? "")}
            </span>
            {detail && (
              <span
                className={cn("shrink-0 truncate text-10 text-fg-subtle")}
                title={detail}
              >
                {detail}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function clamp(depth: number): number {
  if (!Number.isFinite(depth) || depth < 0) return 0;
  return Math.min(depth, 12);
}
