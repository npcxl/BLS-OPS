/** 首页的分区外壳：标题行 + 分组列表卡片（与页面分区标题共用样式）。 */
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
    <div className="page-section-header">
      <div className="page-section-heading">
        <h2 className="page-section-title flex items-center gap-2">
          {title}
          {typeof count === "number" && <span className="page-tab-count">{count}</span>}
        </h2>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

/** macOS-style grouped list — a rounded panel whose rows are divided. */
export function ListPanel({ children }: { children: ReactNode }) {
  return (
    <div className="home-list-panel">
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
