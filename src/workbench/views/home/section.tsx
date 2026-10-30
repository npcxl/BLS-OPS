/** 首页的分区外壳：标题行 + 分组列表卡片（与既有首页视觉一致）。 */
import type { ReactNode } from "react";

export function SectionHeading({
  title,
  count,
  actions,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
}) {
  return (
    <div className="flex h-6 items-center justify-between gap-3">
      <h2 className="flex items-center gap-1.5 text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
        {title}
        {typeof count === "number" && (
          <span className="rounded-[6px] bg-surface-2 px-1.5 py-0.5 text-10 font-medium text-fg-muted">
            {count}
          </span>
        )}
      </h2>
      {actions}
    </div>
  );
}

/** macOS-style grouped list — a rounded panel whose rows are divided. */
export function ListPanel({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-surface-1/70 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
      <div className="divide-y divide-line/60">{children}</div>
    </div>
  );
}

/** 分区动作按钮（"全部 →" "管理 →"），与旧首页保持同一处样式。 */
export function SectionLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="text-11 text-fg-subtle transition-colors hover:text-accent"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
