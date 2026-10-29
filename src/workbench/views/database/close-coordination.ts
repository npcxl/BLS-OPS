/**
 * 关闭工作项前的统一风险判断。
 *
 * 单项关闭和“关闭其他”必须使用同一套规则，不能在批量路径里漏掉事务/草稿。
 * 这里只做纯判断，不执行关闭、不弹窗，便于测试和复用。
 */
import type { DbSessionInfo } from "@/api/types/database";
import type { TabRunState } from "@/stores/database-workbench-store";
import type { WorkItem } from "@/stores/database-workspace-store";

const SAFE_TERMINAL: ReadonlySet<TabRunState> = new Set([
  "idle",
  "ready",
  "completed",
  "cancelled",
  "failed",
]);

export function isSafeQueryTerminal(state: TabRunState | undefined): boolean {
  return state === undefined || SAFE_TERMINAL.has(state);
}

export class QuerySettlementError extends Error {
  constructor(
    readonly queryState: TabRunState | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "QuerySettlementError";
  }
}

/** 等待查询进入可安全关闭的终态；超时和 outcome_unknown 一律拒绝静默关闭。 */
export async function waitForSafeQueryTerminal(
  readState: () => TabRunState | undefined,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<TabRunState> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = readState();
    if (isSafeQueryTerminal(state)) return state ?? "idle";
    if (state === "outcome_unknown") {
      throw new QuerySettlementError(
        state,
        "查询结果未知：不能静默关闭，请先重新连接并确认服务器状态",
      );
    }
    await sleep(intervalMs);
  }
  const state = readState();
  if (isSafeQueryTerminal(state)) return state ?? "idle";
  throw new QuerySettlementError(
    state === "outcome_unknown" ? "outcome_unknown" : "timeout",
    state === "outcome_unknown"
      ? "查询结果未知：不能静默关闭，请先重新连接并确认服务器状态"
      : `查询取消超时（${state ?? "unknown"}）：工作项保持打开，未执行回滚/关闭`,
  );
}

export async function settleQueriesBeforeClose(
  itemIds: string[],
  actions: {
    cancel: (id: string) => Promise<void>;
    readState: (id: string) => TabRunState | undefined;
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  // 先对所有运行中的查询发取消，再并行等待终态；避免串行 5s × N。
  for (const id of itemIds) {
    const state = actions.readState(id);
    if (state === "running" || state === "cancelling") {
      await actions.cancel(id).catch(() => undefined);
    }
  }
  await Promise.all(
    itemIds.map((id) =>
      waitForSafeQueryTerminal(() => actions.readState(id), {
        timeoutMs: actions.timeoutMs,
        intervalMs: actions.intervalMs,
        sleep: actions.sleep,
      }),
    ),
  );
}

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
