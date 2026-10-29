/**
 * 非活动工作项的结果缓存预算。
 *
 * 页面组件为保留滚动/筛选/草稿而常驻，但结果集不应无限占用内存。
 * 预算按“当前页行数”控制（后端本身有 page_size 上限），可通过
 * localStorage 调整：`ops.db.inactiveResultRows`。
 */
export const DEFAULT_INACTIVE_RESULT_ROWS = 500;

export function inactiveResultRowBudget(): number {
  try {
    const raw = Number(localStorage.getItem("ops.db.inactiveResultRows"));
    if (!Number.isFinite(raw)) return DEFAULT_INACTIVE_RESULT_ROWS;
    return Math.min(20_000, Math.max(50, Math.trunc(raw)));
  } catch {
    return DEFAULT_INACTIVE_RESULT_ROWS;
  }
}

export function shouldEvictInactiveResult(args: {
  active: boolean;
  rowCount: number;
  pendingChanges: number;
  budget?: number;
}): boolean {
  if (args.active) return false;
  // 有暂存修改时保留页面，避免用户切回来丢失行定位/编辑上下文。
  if (args.pendingChanges > 0) return false;
  const budget = args.budget ?? DEFAULT_INACTIVE_RESULT_ROWS;
  return args.rowCount > budget;
}
