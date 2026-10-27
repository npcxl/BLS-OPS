/**
 * 每个数据库标签页的 SQL 编辑器 / 结果状态。
 *
 * 内存上限（前端也有，不只靠后端）：
 * - 单标签最多保留 `MAX_RESULT_SETS` 个结果集；
 * - 累计最多 `MAX_RESULT_ROWS` 行；超出丢弃**最早**的结果集并给出提示。
 * 后端已经按 1,000 行 / 8 MiB 截断单个结果集，这里防的是"脚本连跑 50 条
 * SELECT"这种累计膨胀。
 *
 * 拉取循环是**串行**的：一直接 `db_query_next` 直到终态。Rust 端的
 * `mpsc::channel(2)` 因此只保留两批，前端不拉就停读 —— 真正的背压。
 */
import { create } from "zustand";

import { databaseApi } from "@/api/ops-api";
import type {
  DbColumn,
  DbErrorInfo,
  DbQueryState,
  DbValue,
} from "@/api/types/database";
import { toDbError } from "@/stores/database-store";

export const MAX_RESULT_SETS = 8;
export const MAX_RESULT_ROWS = 4_000;

const TERMINAL: DbQueryState[] = [
  "completed",
  "cancelled",
  "failed",
  "outcome_unknown",
];

export interface StatementResult {
  key: string;
  statementIndex: number;
  resultSetIndex: number;
  statement: string;
  columns: DbColumn[];
  rows: DbValue[][];
  affectedRows: number;
  lastInsertId: string | null;
  warnings: number;
  info: string;
  elapsedMs: number;
  receivedRows: number;
  bytes: number;
  truncated: boolean;
  truncationReason: string | null;
  error: DbErrorInfo | null;
}

export type TabRunState =
  | "idle"
  | "ready"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "outcome_unknown";

export interface DatabaseTabState {
  profileId: string;
  sql: string;
  results: StatementResult[];
  activeResultKey: string | null;
  runState: TabRunState;
  queryId: string | null;
  currentStatement: number;
  totalStatements: number;
  error: DbErrorInfo | null;
  elapsedMs: number;
  receivedRows: number;
  bytes: number;
  truncated: boolean;
  truncationReason: string | null;
  /** 结果缓存裁剪提示（前端内存上限触发）。 */
  cacheWarning: string | null;
  lastRunAt: number | null;
}

const draftKey = (profileId: string) => `ops.db.sql.${profileId}`;
const historyFlagKey = "ops.db.history.enabled";

function loadDraft(profileId: string): string {
  try {
    return localStorage.getItem(draftKey(profileId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(profileId: string, sql: string): void {
  try {
    localStorage.setItem(draftKey(profileId), sql);
  } catch {
    // 存不进去只影响"下次恢复"，不阻塞编辑。
  }
}

export function clearDraft(profileId: string): void {
  try {
    localStorage.removeItem(draftKey(profileId));
  } catch {
    // ignore
  }
}

function emptyTab(profileId: string): DatabaseTabState {
  return {
    profileId,
    sql: loadDraft(profileId),
    results: [],
    activeResultKey: null,
    runState: "idle",
    queryId: null,
    currentStatement: 0,
    totalStatements: 0,
    error: null,
    elapsedMs: 0,
    receivedRows: 0,
    bytes: 0,
    truncated: false,
    truncationReason: null,
    cacheWarning: null,
    lastRunAt: null,
  };
}

interface WorkbenchDbState {
  tabs: Record<string, DatabaseTabState>;
  historyEnabled: boolean;
  ensureTab: (tabId: string, profileId: string) => void;
  setSql: (tabId: string, sql: string) => void;
  clearResults: (tabId: string) => void;
  setActiveResult: (tabId: string, key: string) => void;
  runStatements: (args: {
    tabId: string;
    profileId: string;
    sessionId: string;
    statements: string[];
  }) => Promise<void>;
  cancel: (tabId: string) => Promise<void>;
  dispose: (tabId: string) => void;
  setHistoryEnabled: (enabled: boolean) => void;
}

export const useDatabaseWorkbenchStore = create<WorkbenchDbState>()((set, get) => ({
  tabs: {},
  historyEnabled: (() => {
    try {
      return localStorage.getItem(historyFlagKey) !== "false";
    } catch {
      return true;
    }
  })(),

  ensureTab: (tabId, profileId) =>
    set((state) => {
      const existing = state.tabs[tabId];
      if (existing && existing.profileId === profileId) return state;
      return { tabs: { ...state.tabs, [tabId]: emptyTab(profileId) } };
    }),

  setSql: (tabId, sql) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return { tabs: { ...state.tabs, [tabId]: { ...tab, sql } } };
    }),

  clearResults: (tabId) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            results: [],
            activeResultKey: null,
            runState: "ready",
            error: null,
            elapsedMs: 0,
            receivedRows: 0,
            bytes: 0,
            truncated: false,
            truncationReason: null,
            cacheWarning: null,
          },
        },
      };
    }),

  setActiveResult: (tabId, key) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return { tabs: { ...state.tabs, [tabId]: { ...tab, activeResultKey: key } } };
    }),

  setHistoryEnabled: (enabled) => {
    try {
      localStorage.setItem(historyFlagKey, String(enabled));
    } catch {
      // ignore
    }
    set({ historyEnabled: enabled });
  },

  runStatements: async ({ tabId, profileId, sessionId, statements }) => {
    const filtered = statements.map((statement) => statement.trim()).filter(Boolean);
    if (filtered.length === 0) return;

    const reset: DatabaseTabState = {
      ...emptyTab(profileId),
      sql: get().tabs[tabId]?.sql ?? "",
      runState: "running",
      totalStatements: filtered.length,
      currentStatement: 0,
      lastRunAt: Date.now(),
    };
    set((state) => ({ tabs: { ...state.tabs, [tabId]: reset } }));

    let firstError: DbErrorInfo | null = null;
    let stopped = false;
    let finalState: DbQueryState = "running";

    for (let index = 0; index < filtered.length; index += 1) {
      if (stopped) break;
      const statement = filtered[index];

      set((state) => {
        const tab = state.tabs[tabId];
        if (!tab) return state;
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...tab, currentStatement: index },
          },
        };
      });

      let started;
      try {
        started = await startWithRetry(sessionId, statement);
      } catch (error) {
        const info = toDbError(error);
        firstError = firstError ?? info;
        set((state) => {
          const tab = state.tabs[tabId];
          if (!tab) return state;
          return {
            tabs: {
              ...state.tabs,
              [tabId]: {
                ...tab,
                runState: "failed",
                error: info,
                results: [
                  ...tab.results,
                  statementErrorResult(tabId, index, 0, statement, info),
                ],
                activeResultKey: `${index}:0`,
              },
            },
          };
        });
        stopped = true;
        break;
      }

      set((state) => {
        const tab = state.tabs[tabId];
        if (!tab) return state;
        return {
          tabs: { ...state.tabs, [tabId]: { ...tab, queryId: started.query_id } },
        };
      });

      const statementResult = await drainQuery({
        tabId,
        profileId,
        statementIndex: index,
        statement,
        queryId: started.query_id,
        onUpdate: (updater) =>
          set((state) => {
            const tab = state.tabs[tabId];
            if (!tab) return state;
            return { tabs: { ...state.tabs, [tabId]: updater(tab) } };
          }),
      });

      if (get().historyEnabled) {
        void databaseApi
          .historyRecord({
            profile_id: profileId,
            session_id: sessionId,
            sql: statement,
            succeeded: !statementResult.error && statementResult.state === "completed",
            rows: statementResult.rows,
            elapsed_ms: statementResult.elapsedMs,
            error: statementResult.error?.message ?? null,
          })
          .catch(() => undefined);
      }

      finalState = statementResult.state;
      if (statementResult.error) {
        firstError = firstError ?? statementResult.error;
      }
      if (
        statementResult.state === "failed" ||
        statementResult.state === "cancelled" ||
        statementResult.state === "outcome_unknown"
      ) {
        // 脚本按顺序执行：出错就停在这里，不继续跑后面的语句。
        stopped = true;
      }

      await databaseApi.queryRelease(started.query_id).catch(() => undefined);
    }

    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            queryId: null,
            runState:
              finalState === "cancelled"
                ? "cancelled"
                : firstError
                  ? "failed"
                  : "completed",
            error: firstError,
          },
        },
      };
    });
  },

  cancel: async (tabId) => {
    const tab = get().tabs[tabId];
    if (!tab?.queryId) return;
    set((state) => {
      const current = state.tabs[tabId];
      if (!current) return state;
      return { tabs: { ...state.tabs, [tabId]: { ...current, runState: "cancelling" } } };
    });
    try {
      await databaseApi.queryCancel(tab.queryId);
    } catch (error) {
      set((state) => {
        const current = state.tabs[tabId];
        if (!current) return state;
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...current, error: toDbError(error) },
          },
        };
      });
    }
  },

  dispose: (tabId) => {
    const tab = get().tabs[tabId];
    if (tab?.queryId) {
      void databaseApi.queryRelease(tab.queryId).catch(() => undefined);
    }
    set((state) => {
      const tabs = { ...state.tabs };
      delete tabs[tabId];
      return { tabs };
    });
  },
}));

function toTabRunState(state: DbQueryState): TabRunState {
  switch (state) {
    case "queued":
    case "running":
    case "streaming":
      return "running";
    case "cancelling":
      return "cancelling";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "outcome_unknown":
      return "outcome_unknown";
  }
}

function statementErrorResult(
  _tabId: string,
  statementIndex: number,
  resultSetIndex: number,
  statement: string,
  error: DbErrorInfo,
): StatementResult {
  return {
    key: `${statementIndex}:${resultSetIndex}`,
    statementIndex,
    resultSetIndex,
    statement,
    columns: [],
    rows: [],
    affectedRows: 0,
    lastInsertId: null,
    warnings: 0,
    info: "",
    elapsedMs: 0,
    receivedRows: 0,
    bytes: 0,
    truncated: false,
    truncationReason: null,
    error,
  };
}

async function startWithRetry(sessionId: string, statement: string) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await databaseApi.queryStart(sessionId, statement);
    } catch (error) {
      lastError = error;
      const info = toDbError(error);
      // 会话正忙 = 上一条的连接还没归还；等一小会儿重试。
      if (info.stage !== "query" || !info.message.includes("正在执行")) break;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
  throw lastError ?? new Error("无法启动查询");
}

interface DrainArgs {
  tabId: string;
  profileId: string;
  statementIndex: number;
  statement: string;
  queryId: string;
  onUpdate: (updater: (tab: DatabaseTabState) => DatabaseTabState) => void;
}

async function drainQuery(args: DrainArgs): Promise<{
  state: DbQueryState;
  error: DbErrorInfo | null;
  rows: number;
  elapsedMs: number;
}> {
  let state: DbQueryState = "running";
  let error: DbErrorInfo | null = null;
  let rows = 0;
  let elapsedMs = 0;

  for (let guard = 0; guard < 100_000; guard += 1) {
    let batch;
    try {
      batch = await databaseApi.queryNext(args.queryId);
    } catch (failure) {
      error = toDbError(failure);
      break;
    }

    state = batch.state;
    if (batch.batch) {
      const payload = batch.batch;
      if (payload.kind === "result_set") {
        args.onUpdate((tab) => {
          const merged = upsertResultSet(tab.results, {
            key: `${args.statementIndex}:${payload.index}`,
            statementIndex: args.statementIndex,
            resultSetIndex: payload.index,
            statement: payload.statement || args.statement,
            columns: payload.columns,
            rows: [],
            affectedRows: 0,
            lastInsertId: null,
            warnings: 0,
            info: "",
            elapsedMs: 0,
            receivedRows: 0,
            bytes: 0,
            truncated: false,
            truncationReason: null,
            error: null,
          });
          return {
            ...tab,
            results: merged.results,
            activeResultKey: tab.activeResultKey ?? `${args.statementIndex}:${payload.index}`,
            cacheWarning: merged.warning ?? tab.cacheWarning,
          };
        });
      } else if (payload.kind === "rows") {
        args.onUpdate((tab) => ({
          ...tab,
          results: tab.results.map((result) =>
            result.key === payload.result_set_id
              ? { ...result, rows: result.rows.concat(payload.rows) }
              : result,
          ),
        }));
      } else if (payload.kind === "result_set_end") {
        args.onUpdate((tab) => ({
          ...tab,
          results: tab.results.map((result) =>
            result.key === payload.result_set_id
              ? {
                  ...result,
                  affectedRows: payload.affected_rows,
                  lastInsertId: payload.last_insert_id,
                  warnings: payload.warnings,
                  info: payload.info,
                  elapsedMs: payload.elapsed_ms,
                  receivedRows: payload.rows,
                  bytes: payload.bytes,
                }
              : result,
          ),
        }));
      } else if (payload.kind === "error") {
        error = payload.error;
        args.onUpdate((tab) => {
          const key = `${args.statementIndex}:0`;
          const existing = tab.results.find((result) => result.key === key);
          if (existing) {
            return {
              ...tab,
              results: tab.results.map((result) =>
                result.key === key ? { ...result, error: payload.error } : result,
              ),
            };
          }
          return {
            ...tab,
            results: [
              ...tab.results,
              statementErrorResult(args.tabId, args.statementIndex, 0, args.statement, payload.error),
            ],
            activeResultKey: tab.activeResultKey ?? key,
          };
        });
      } else if (payload.kind === "finished") {
        rows = payload.rows;
        elapsedMs = payload.elapsed_ms;
        args.onUpdate((tab) => ({
          ...tab,
          runState: toTabRunState(payload.state),
          elapsedMs: tab.elapsedMs + payload.elapsed_ms,
          receivedRows: tab.receivedRows + payload.rows,
          bytes: tab.bytes + payload.bytes,
          truncated: tab.truncated || payload.truncated,
          truncationReason: payload.truncation_reason ?? tab.truncationReason,
        }));
      }
    }

    if (TERMINAL.includes(state)) break;
    // 服务端还在跑但暂时没有数据：`queryNext` 20 秒后返回空批次，继续拉。
  }

  return { state, error, rows, elapsedMs };
}

function upsertResultSet(
  results: StatementResult[],
  next: StatementResult,
): { results: StatementResult[]; warning: string | null } {
  const existing = results.findIndex((result) => result.key === next.key);
  const merged =
    existing >= 0
      ? results.map((result) => (result.key === next.key ? { ...next, rows: result.rows } : result))
      : [...results, next];

  // 前端缓存上限：结果集数量 + 累计行数。淘汰最早的，不静默无界增长。
  let trimmed = merged;
  let warning: string | null = null;
  if (trimmed.length > MAX_RESULT_SETS) {
    trimmed = trimmed.slice(trimmed.length - MAX_RESULT_SETS);
    warning = "结果集过多，已丢弃更早的结果（仅保留最近 8 个）";
  }
  let total = trimmed.reduce((sum, result) => sum + result.rows.length, 0);
  while (total > MAX_RESULT_ROWS && trimmed.length > 1) {
    const removed = trimmed[0];
    trimmed = trimmed.slice(1);
    total -= removed.rows.length;
    warning = "结果累计超过 4,000 行，已丢弃更早的结果集";
  }
  return { results: trimmed, warning };
}
