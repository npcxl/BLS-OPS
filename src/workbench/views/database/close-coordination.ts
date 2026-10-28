/**
 * 关闭工作项前的统一风险判断。
 *
 * 单项关闭和“关闭其他”必须使用同一套规则，不能在批量路径里漏掉事务/草稿。
 * 这里只做纯判断，不执行关闭、不弹窗，便于测试和复用。
 */
import type { DbSessionInfo } from "@/api/types/database";
import type { WorkItem } from "@/stores/database-workspace-store";

export interface CloseRisk {
  item: WorkItem;
  running: boolean;
  pending: number;
  dirty: boolean;
  inTransaction: boolean;
}

export interface CloseBatch {
  items: WorkItem[];
  risks: CloseRisk[];
  running: number;
  pending: number;
  dirty: number;
  inTransaction: number;
}

export function isInTransaction(
  session: DbSessionInfo | undefined | null,
): boolean {
  const transaction = session?.transaction;
  return (
    transaction === "in_transaction" ||
    transaction === "in_transaction_read_only"
  );
}

export function assessCloseRisk(
  item: WorkItem,
  session: DbSessionInfo | undefined | null,
): CloseRisk {
  return {
    item,
    running: item.running,
    pending: item.pendingCount,
    dirty: item.dirty,
    inTransaction: isInTransaction(session),
  };
}

export function hasCloseRisk(risk: CloseRisk): boolean {
  return risk.running || risk.pending > 0 || risk.dirty || risk.inTransaction;
}

export function buildCloseBatch(
  items: WorkItem[],
  sessions: Record<string, DbSessionInfo>,
): CloseBatch {
  const risks = items.map((item) =>
    assessCloseRisk(item, sessions[item.profileId]),
  );
  return {
    items,
    risks,
    running: risks.filter((risk) => risk.running).length,
    pending: risks.reduce((sum, risk) => sum + risk.pending, 0),
    dirty: risks.filter((risk) => risk.dirty).length,
    inTransaction: risks.filter((risk) => risk.inTransaction).length,
  };
}
