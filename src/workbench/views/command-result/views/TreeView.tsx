import { cn } from "@/lib/cn";
import { useTranslation } from "react-i18next";
import { COPYABLE, CopyNotice, clickCopyProps, useCopyFeedback } from "@/components/ui/copy-feedback";

/**
 * 通用树视图 —— `tree` / `pstree` / nginx 配置嵌套 / 进程父子关系共用。
 *
 * 行契约：`{label, depth, detail?}`（**扁平列表 + 缩进层级**，不是嵌套结构：
 * 更好做滚动与筛选，也避免递归深度问题）。
 *
 * 点击节点 → 复制它的值：有 `detail` 的行（叶子）复制 detail，其余复制 label。
 */
export function TreeView({ rows }: { rows: Record<string, unknown>[] }) {
  const { t } = useTranslation();
  const { status, copy } = useCopyFeedback();

  if (rows.length === 0) {
    return <p className="px-3 py-6 text-center text-11 text-fg-subtle">{t("No nodes.")}</p>;
  }
  return (
    <div className="relative min-h-0 flex-1 overflow-auto py-1">
      {rows.map((row, index) => {
        const depth = Number(row.depth ?? 0);
        const detail = String(row.detail ?? "");
        const label = String(row.label ?? "");
        // 叶子的"值"就是 detail；分支行没有 detail，复制 label。
        const copyTarget = detail !== "" ? detail : label;
        return (
          <button
            key={index}
            type="button"
            data-testid="tree-node"
            {...clickCopyProps(() => void copy(copyTarget))}
            className={cn(COPYABLE, "flex w-full items-center gap-2 px-3 py-1 text-left")}
            // 每级缩进 14px；层级异常（负数/过大）时夹到 0..12，避免布局炸开。
            style={{ paddingLeft: 12 + clamp(depth) * 14 }}
            title={t("Click to copy this node's value")}
          >
            {clamp(depth) > 0 && (
              <span className="shrink-0 text-10 text-fg-subtle">└</span>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-11 text-fg" title={label}>
              {label}
            </span>
            {detail && (
              <span className={cn("shrink-0 truncate text-10 text-fg-subtle")} title={detail}>
                {detail}
              </span>
            )}
          </button>
        );
      })}
      <CopyNotice status={status} />
    </div>
  );
}

function clamp(depth: number): number {
  if (!Number.isFinite(depth) || depth < 0) return 0;
  return Math.min(depth, 12);
}
