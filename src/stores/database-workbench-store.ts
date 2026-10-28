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

function loadDraft(tabId: string, profileId: string): string {
  try {
    const own = localStorage.getItem(draftKey(tabId));
    if (own !== null) return own;
    // 兼容旧版本：草稿曾经按连接存。第一次打开新工作项时迁移一次，
    // 避免升级后用户发现草稿"消失"。
    const legacyKey = draftKey(profileId);
    const legacy = localStorage.getItem(legacyKey);
    if (legacy) {
      localStorage.removeItem(legacyKey);
      localStorage.setItem(draftKey(tabId), legacy);
      return legacy;
    }
    return "";
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

function emptyTab(tabId: string, profileId: string): DatabaseTabState {
  return {
    profileId,
    // 草稿按**工作项**隔离：一份查询一个草稿，不会互相覆盖。
    sql: loadDraft(tabId, profileId),
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
      return { tabs: { ...state.tabs, [tabId]: emptyTab(tabId, profileId) } };
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
      ...emptyTab(tabId, profileId),
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
                  statementErrorResult(`error:${index}`, index, 0, statement, info),
                ],
                activeResultKey: `error:${index}`,
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
    // 工作项关闭 → 丢弃它的临时草稿；长期保存走“保存查询”。
    clearDraft(tabId);
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
  key: string,
  statementIndex: number,
  resultSetIndex: number,
  statement: string,
  error: DbErrorInfo,
): StatementResult {
  return {
    key,
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
    let finished = false;
    if (batch.batch) {
      const payload = batch.batch;
      if (payload.kind === "result_set") {
        args.onUpdate((tab) => {
          const merged = upsertResultSet(tab.results, {
            // **必须**用后端 ID：rows / result_set_end 都按它匹配。
            // 以前这里用 `${statementIndex}:${index}`，和后端
            // `${queryId}:${index}` 不一致，行数据全部被丢掉 —— 显示 0 行。
            key: payload.result_set_id,
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
            activeResultKey: tab.activeResultKey ?? payload.result_set_id,
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
          // 错误不是结果集：用独立前缀，避免和后端 result_set_id 撞车。
          const key = `error:${args.statementIndex}`;
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
              statementErrorResult(key, args.statementIndex, 0, args.statement, payload.error),
            ],
            activeResultKey: tab.activeResultKey ?? key,
          };
        });
      } else if (payload.kind === "finished") {
        finished = true;
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

    // 只有"收到 Finished"或"终态且没有批次"才算结束：
    // 否则状态先变终态时会把 Finished 里的行数/截断信息丢掉。
    if (finished) break;
    if (!batch.batch && TERMINAL.includes(state)) break;
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
