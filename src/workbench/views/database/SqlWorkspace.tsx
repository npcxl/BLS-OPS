/**
 * SQL 工作区：编辑器 + 执行 + 结果 + 历史 + 导出。
 *
 * 执行语义对齐 Navicat：
 * - 有选区 → 只运行选区（选区里若有多条语句，逐条执行）；
 * - 无选区 → 只运行光标所在的那条语句；
 * - Ctrl+Shift+Enter / 「运行脚本」→ 按顺序执行整段脚本；
 * - 多语句按顺序执行，遇到错误/取消就停在该语句。
 *
 * 另可把当前 SQL 放进独立窗口运行；窗口之间用 Tauri 事件同步执行状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { sql as sqlLanguage } from "@codemirror/lang-sql";
import { autocompletion } from "@codemirror/autocomplete";
import {
  Eraser,
  FileCode2,
  FileDown,
  FolderOpen,
  History,
  Loader2,
  Maximize2,
  Play,
  Save,
  Square,
  X,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { PageNotice } from "@/workbench/page-layout";
import { useEditorTheme } from "@/lib/cm-theme";
import { databaseApi } from "@/api/ops-api";
import type { DatabaseProfile, DbDatabase, DbSessionInfo } from "@/api/types/database";
import { detailKey, tablesKey, toDbError, useDatabaseStore } from "@/stores/database-store";
import { saveDraft, useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { ResultsPanel } from "./ResultsPanel";
import { ExportDialog } from "./ExportDialog";
import { HistoryDialog } from "./HistoryDialog";
import { SaveQueryDialog } from "./SaveQueryDialog";
import { capabilityAllows, capabilityReason, engineMeta } from "./db-engines";
import { splitSqlStatements, statementAtCursor, type SplitRules } from "./sql-split";
import {
  DESTRUCTIVE_LABEL,
  detectDestructive,
  shortSql,
  type DestructiveStatement,
} from "./sql-risk";
import { formatSql } from "./sql-format";
import { openDetachedSqlWindow } from "./detached-sql";
import { completionDialect, createSqlCompletion } from "./sql-completion";
import "./sql-completion.css";

const EMPTY_DATABASES: DbDatabase[] = [];

/** 一页行数。分页是 SQL 层的 `LIMIT/OFFSET`，与后端 10,000 行的展示预算无关。 */
const PAGE_SIZE = 1_000;

/**
 * 只有**单条只读 SELECT / WITH** 才能安全地用外层 `LIMIT n OFFSET m` 分页。
 *
 * 多语句、写操作、`FOR UPDATE`、`INTO OUTFILE` 都不能包进派生表；这些场景
 * 仍然一次性执行，靠展示预算兜底。
 */
export function pageableSql(statements: string[]): string | null {
  if (statements.length !== 1) return null;
  const statement = statements[0].trim().replace(/;\s*$/, "");
  const bare = statement
    .replace(/^(?:\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*/, "")
    .trim();
  if (!/^(select|with)\b/i.test(bare)) return null;
  if (/\bfor\s+update\b|\binto\s+(outfile|dumpfile)\b/i.test(bare)) return null;
  return statement;
}

/** 外层分页：`SELECT * FROM (<原语句>) AS __ops_page LIMIT n OFFSET m`。 */
export function wrapPageSql(baseSql: string, pageSize: number, offset: number): string {
  const bare = baseSql.trim().replace(/;\s*$/, "");
  return `SELECT * FROM (${bare}) AS __ops_page LIMIT ${pageSize} OFFSET ${offset}`;
}

export function SqlWorkspace({
  tabId,
  profile,
  session,
  connectionName,
  database,
  detached = false,
  onOpenTable: _onOpenTable,
}: {
  tabId: string;
  profile: DatabaseProfile;
  session: DbSessionInfo | null;
  connectionName?: string;
  database?: string | null;
  /** 独立窗口里隐藏“全屏”，避免再开一层。 */
  detached?: boolean;
  onOpenTable: (database: string, table: string) => void;
}) {
  const { t } = useTranslation();
  const theme = useEditorTheme();
  // 语句拆分必须按方言：`#` 注释、反斜杠转义、`$$`、`GO` 各引擎不同。
  const splitRules = useMemo<SplitRules | undefined>(
    () => engineMeta(profile.engine).descriptor?.dialect_rules,
    [profile.engine],
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [editorHeight, setEditorHeight] = useState(236);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveQueryOpen, setSaveQueryOpen] = useState(false);
  /** 首次运行后才显示结果区；未查询时编辑器占满高度。 */
  const [hasRun, setHasRun] = useState(false);
  /** 待确认的危险语句（DROP / TRUNCATE / 无 WHERE 的 DELETE）。 */
  const [riskyRun, setRiskyRun] = useState<{
    statements: string[];
    risky: DestructiveStatement[];
  } | null>(null);
  /**
   * 当前查询页使用的数据库。新建查询时从表/库/连接上下文带过来；
   * 用户切换下拉框只改变这个值，不会反过来被 item.database 覆盖。
   */
  const [contextDatabase, setContextDatabase] = useState<string | null>(
    database ?? null,
  );
  const [switchingDb, setSwitchingDb] = useState(false);

  const tab = useDatabaseWorkbenchStore((state) => state.tabs[tabId]);
  const setSql = useDatabaseWorkbenchStore((state) => state.setSql);
  const runStatements = useDatabaseWorkbenchStore((state) => state.runStatements);
  const cancel = useDatabaseWorkbenchStore((state) => state.cancel);
  const clearResults = useDatabaseWorkbenchStore((state) => state.clearResults);
  const item = useDatabaseWorkspaceStore(
    (state) => state.items.find((entry) => entry.id === tabId) ?? null,
  );
  const saveQuery = useDatabaseWorkspaceStore((state) => state.saveQuery);
  const setItemStatus = useDatabaseWorkspaceStore((state) => state.setStatus);
  const newQuery = useDatabaseWorkspaceStore((state) => state.newQuery);
  const profiles = useDatabaseStore((state) => state.profiles);
  const refreshDatabases = useDatabaseStore((state) => state.refreshDatabases);
  const openDatabaseTab = useWorkbenchStore((state) => state.openDatabaseTab);

  // **必须是稳定引用**：`?? []` 每次 selector 返回新数组，会让
  // useSyncExternalStore 认为快照一直在变，触发无限重渲染。
  const databases = useDatabaseStore(
    (state) => state.databases[profile.id] ?? EMPTY_DATABASES,
  );

  const sqlText = tab?.sql ?? "";
  const running = tab?.runState === "running";
  const cancelling = tab?.runState === "cancelling";

  // 事务：能力来自引擎目录，状态来自服务器的会话信息 —— 两者都不猜。
  const runSessionCommand = useDatabaseStore((state) => state.runSessionCommand);
  const [txnBusy, setTxnBusy] = useState(false);
  const descriptor = engineMeta(profile.engine).descriptor;
  const transactionCapable = capabilityAllows(descriptor, "transaction");
  const transactionLimitedReason = capabilityReason(descriptor, "transaction");
  // 这里导的是**自定义 SQL 的结果**，看 `export_sql` 而不是 `export`：
  // 按表导出（`export`）接通了不代表这段 SQL 能被重新执行并流式写盘。
  const exportBlocked = !capabilityAllows(descriptor, "export_sql");
  const exportReason = capabilityReason(descriptor, "export_sql");
  // 取消能力缺失（Doris/StarRocks 按 query id 取消，未接入）时不给一个点了
  // 只会报错的"停止"。只在**明确知道**不支持时禁用：目录还没加载完就挡住取消，
  // 会让一条卡住的查询彻底没法停。
  const cancelBlocked = !!descriptor && !capabilityAllows(descriptor, "cancel");
  const cancelReason = capabilityReason(descriptor, "cancel");
  const inTransaction =
    session?.transaction === "in_transaction" ||
    session?.transaction === "in_transaction_read_only";

  const runTxn = async (
    sql: "START TRANSACTION" | "COMMIT" | "ROLLBACK",
    label: string,
  ) => {
    setTxnBusy(true);
    setNotice(null);
    try {
      await runSessionCommand(profile.id, sql);
      setNotice(t("{{action}}已完成", { action: label }));
    } catch (failure) {
      setNotice(toDbError(failure).message);
    } finally {
      setTxnBusy(false);
    }
  };
  const resultCount = tab?.results.length ?? 0;
  const showResults = hasRun || resultCount > 0 || running || cancelling;

  // 清空结果/重连后 store 会把 runState 设回 ready；这时也要收起面板，
  // 不能因为本地的 hasRun 留下一个空白结果区。
  useEffect(() => {
    if (
      resultCount === 0 &&
      (tab?.runState === "ready" || tab?.runState === "idle")
    ) {
      setHasRun(false);
    }
  }, [resultCount, tab?.runState]);

  useEffect(() => {
    // 草稿按工作项隔离，多个查询互不覆盖。
    // 工作项状态还没建立时 `sqlText` 一定是空串：这时落盘会把已有草稿覆盖成空，
    // 所以先确认 tab 存在，再按"工作项 + 连接"各存一份。
    if (!useDatabaseWorkbenchStore.getState().tabs[tabId]) return;
    const timer = window.setTimeout(() => saveDraft(tabId, sqlText, profile.id), 500);
    return () => window.clearTimeout(timer);
  }, [profile.id, sqlText, tabId]);

  /*
   * 编辑器补全：按光标位置给表/字段/关键字，元数据**首次用到才查**。
   *
   * 先读资产树已经拉到的缓存（展开过就不再多一次 IPC），没有再走元数据接口；
   * 会话断了直接不补 —— 宁可没有提示，也不要给一份过期的字段名。
   */
  const completionSource = useMemo(
    () =>
      createSqlCompletion(profile.engine, contextDatabase, {
        valid: () => !!useDatabaseStore.getState().sessions[profile.id],
        tables: async (target) => {
          const cached = useDatabaseStore.getState().tables[tablesKey(profile.id, target)];
          if (cached) return cached;
          return databaseApi.tables(profile.id, target);
        },
        detail: async (target, table) => {
          const cached =
            useDatabaseStore.getState().details[detailKey(profile.id, target, table)];
          if (cached) return cached;
          return databaseApi.tableDetail(profile.id, target, table);
        },
      }),
    [contextDatabase, profile.engine, profile.id],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent) => {
      // 按**容器**坐标算，不用 window 底部：SQL 页只占中央区域，
      // 按窗口算会让分隔条和鼠标位置对不上。
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = event.clientY - rect.top;
      setEditorHeight(Math.max(120, Math.min(rect.height * 0.72, next)));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const switchDatabase = useCallback(
    async (name: string): Promise<boolean> => {
      if (!session || !name) return false;
      if (name === session.current_database) return true;
      setSwitchingDb(true);
      try {
        await databaseApi.useDatabase(session.session_id, name);
        const info = await databaseApi.sessionInfo(session.session_id);
        useDatabaseStore.setState((state) => ({
          sessions: { ...state.sessions, [profile.id]: info },
        }));
        return true;
      } catch (failure) {
        setContextDatabase(session.current_database ?? null);
        setNotice(toDbError(failure).message);
        return false;
      } finally {
        setSwitchingDb(false);
      }
    },
    [profile.id, session],
  );

  /** 真正执行：切库 + 提交语句。危险语句的确认在 `execute` 里先过一遍。 */
  const runParsed = useCallback(
    async (
      statements: string[],
      page?: { baseSql: string; pageSize: number; offset: number } | null,
    ) => {
      if (!session) return;
      if (useDatabaseWorkbenchStore.getState().tabs[tabId]?.pendingResultEdits) {
        setNotice(t("请先应用或还原结果修改，再重新运行查询"));return;
      }
      // 共享会话可能已被另一个查询页切库；执行前把当前页的库显式切回来。
      if (contextDatabase && session.current_database !== contextDatabase) {
        const switched = await switchDatabase(contextDatabase);
        if (!switched) return;
      }

      setNotice(null);
      setHasRun(true);
      await runStatements({
        tabId,
        profileId: profile.id,
        sessionId: session.session_id,
        statements,
        pagination: page
          ? {
              baseSql: page.baseSql,
              pageSize: page.pageSize,
              offset: page.offset,
              hasMore: false,
            }
          : null,
      });
    },
    [contextDatabase, profile.id, runStatements, session, switchDatabase, tabId],
  );

  /**
   * 执行入口。
   *
   * 会删数据的语句（DROP / TRUNCATE / 无 WHERE 的 DELETE）先弹确认 ——
   * 不管是 Ctrl+Enter 单条、还是"运行脚本"整段，都走这一道。
   */
  const execute = useCallback(
    async (scope: "auto" | "all" = "auto") => {
      if (!session) return;
      const view = viewRef.current;
      const selection = view
        ? view.state
            .sliceDoc(
              view.state.selection.main.from,
              view.state.selection.main.to,
            )
            .trim()
        : "";
      // Navicat 行为：有选区跑选区；没有选区时只跑光标所在语句。
      // `all` 是显式的"执行整段脚本"，由 Ctrl+Shift+Enter 或"运行脚本"触发。
      const source =
        scope === "all"
          ? sqlText
          : selection || statementAtCursor(sqlText, view?.state.selection.main.head ?? 0, splitRules);
      const parsed = splitSqlStatements(source, splitRules);
      if (parsed.warnings.length > 0) setNotice(parsed.warnings[0]);
      if (parsed.statements.length === 0) {
        setNotice(t("没有可执行的语句"));
        return;
      }

      const risky = detectDestructive(parsed.statements);
      if (risky.length > 0) {
        setRiskyRun({ statements: parsed.statements, risky });
        return;
      }

      // 单条只读 SELECT → 走分页（一页 1,000 行，翻页重新执行外层 LIMIT/OFFSET）；
      // 多语句/写操作保持原样，一次性执行完。
      const baseSql = pageableSql(parsed.statements);
      if (baseSql) {
        await runParsed([wrapPageSql(baseSql, PAGE_SIZE, 0)], {
          baseSql,
          pageSize: PAGE_SIZE,
          offset: 0,
        });
        return;
      }

      await runParsed(parsed.statements);
    },
    [runParsed, session, sqlText, t],
  );

  /** 结果区翻页：按 `LIMIT pageSize OFFSET offset` 重新执行原始语句。 */
  const goToPage = useCallback(
    async (offset: number) => {
      const page = useDatabaseWorkbenchStore.getState().tabs[tabId]?.pagination;
      if (!page || !session || offset < 0) return;
      await runParsed([wrapPageSql(page.baseSql, page.pageSize, offset)], {
        baseSql: page.baseSql,
        pageSize: page.pageSize,
        offset,
      });
    },
    [runParsed, session, tabId],
  );

  const handleClearResults = () => {
    if (useDatabaseWorkbenchStore.getState().tabs[tabId]?.pendingResultEdits) {
      setNotice(t("请先应用或还原结果修改，再清空结果"));return;
    }
    clearResults(tabId);
    setHasRun(false);
    viewRef.current?.focus();
  };

  const connectionOptions = useMemo(() => {
    const list = profiles.map((entry) => ({
      value: entry.id,
      label: entry.name,
      hint: `${entry.username}@${entry.host}`,
    }));
    if (!list.some((entry) => entry.value === profile.id)) {
      list.unshift({
        value: profile.id,
        label: profile.name,
        hint: `${profile.username}@${profile.host}`,
      });
    }
    return list;
  }, [profile, profiles]);

  // 当前页的库上下文只在“首次进入 / 用户改库”时应用一次；
  // 其他查询页切换共享会话的 current_database 时不能跟着来回抢占。
  const appliedContextRef = useRef<string | null>(null);
  const appliedSessionRef = useRef<string | null>(null);

  const databaseOptions = useMemo(() => {
    const list = databases
      .filter((entry) => !entry.system)
      .map((entry) => ({ value: entry.name, label: entry.name }));
    for (const current of [contextDatabase, session?.current_database]) {
      if (current && !list.some((entry) => entry.value === current)) {
        list.unshift({ value: current, label: current });
      }
    }
    return list;
  }, [contextDatabase, databases, session?.current_database]);

  useEffect(() => {
    if (!session || databases.length > 0) return;
    void refreshDatabases(profile.id);
  }, [databases.length, profile.id, refreshDatabases, session]);

  // 只在首次进入/用户改库时把会话切到该页上下文；
  // 其他查询页改共享会话时，这里的 ref 会阻止 effect 再切回去。
  useEffect(() => {
    if (!session || !contextDatabase) return;
    if (
      appliedSessionRef.current === session.session_id &&
      appliedContextRef.current === contextDatabase
    ) {
      return;
    }
    appliedSessionRef.current = session.session_id;
    appliedContextRef.current = contextDatabase;
    if (session.current_database === contextDatabase) return;
    void switchDatabase(contextDatabase);
  }, [contextDatabase, session?.session_id, switchDatabase]);

  const handleConnectionChange = (targetId: string) => {
    if (targetId === profile.id) return;
    const target = profiles.find((entry) => entry.id === targetId);
    if (!target) return;
    const nextId = newQuery({
      profileId: target.id,
      connectionName: target.name,
      // The new connection owns a different namespace. Never inherit the
      // source database (even when both connections happen to share its name).
      database: null,
      sql: sqlText,
      title: item?.title ?? `${target.name} · SQL`,
    });
    const workbench = useDatabaseWorkbenchStore.getState();
    workbench.ensureTab(nextId, target.id);
    workbench.setSql(nextId, sqlText);
    openDatabaseTab({ id: target.id, name: target.name, host: target.host, port: target.port });
  };

  const handleDetach = async () => {
    if (!sqlText.trim()) return;
    try {
      await openDetachedSqlWindow({
        profileId: profile.id,
        connectionName: connectionName ?? profile.name,
        database: contextDatabase,
        sql: sqlText,
        title: item?.title ?? `${profile.name} · SQL`,
      });
    } catch (failure) {
      setNotice(toDbError(failure).message);
    }
  };

  const extensions = useMemo(
    () => [
      sqlLanguage({
        // 方言决定关键字与类型名：PG 的 `SERIAL`、SQLite 的 `AUTOINCREMENT`
        // 必须跟着连接走，不能一律按 MySQL 提示。
        dialect: completionDialect(profile.engine),
        upperCaseKeywords: true,
      }),
      autocompletion({
        // override 会顶掉 lang-sql 自带的 schema/关键字源，避免同一个词出现两遍。
        override: [completionSource],
        activateOnTyping: true,
        selectOnOpen: true,
        icons: true,
        maxRenderedOptions: 80,
        optionClass: (item) => `sql-completion-option sql-completion-option--${item.type ?? "text"}`,
      }),
    ],
    [completionSource, profile.engine],
  );

  /** 格式化：有选区只排选区，否则排整段；写回编辑器后仍会走 onChange 落草稿。 */
  const handleFormatSql = () => {
    const view = viewRef.current;
    if (!view) {
      const next = formatSql(sqlText);
      if (next && next !== sqlText) {
        setSql(tabId, next);
        setItemStatus(tabId, { dirty: true });
      }
      return;
    }
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    if (selected.trim()) {
      view.dispatch({ changes: { from, to, insert: formatSql(selected) } });
    } else {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: formatSql(view.state.doc.toString()),
        },
      });
    }
    view.focus();
  };

  const handleSqlChange = (value: string) => {
    setSql(tabId, value);
    const current = useDatabaseWorkspaceStore
      .getState()
      .items.find((entry) => entry.id === tabId);
    if (current && !current.dirty) setItemStatus(tabId, { dirty: true });
  };

  const handleSaveQuery = () => {
    if (!item) return;
    setSaveQueryOpen(true);
  };

  const confirmSaveQuery = (name: string) => {
    if (!item) return;
    saveQuery({
      itemId: tabId,
      profileId: profile.id,
      connectionName: item.connectionName || connectionName || profile.name,
      database: contextDatabase,
      name,
      sql: sqlText,
    });
    setSaveQueryOpen(false);
    setNotice(t("查询已保存，可在左侧「查询」中找到"));
  };

  const handleOpenSqlFile = async () => {
    try {
      const file = await databaseApi.openSqlFile();
      if (!file) return;
      setSql(tabId, file.content);
      setItemStatus(tabId, { dirty: true });
      setNotice(t("已打开 {{path}}", { path: file.path }));
    } catch (failure) {
      setNotice(toDbError(failure).message);
    }
  };

  const handleSaveSqlFile = async () => {
    try {
      const path = await databaseApi.saveSqlFile(
        sqlText,
        item?.title || "query",
      );
      if (!path) return;
      setNotice(t("已保存到 {{path}}", { path }));
    } catch (failure) {
      setNotice(toDbError(failure).message);
    }
  };

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      {/*
       * 事务条：把"自动提交"与"手动事务"的当前状态放在最显眼处。
       * 这里只做真实存在的动作 —— START TRANSACTION / COMMIT / ROLLBACK，
       * 全部走同一条物理会话；不支持事务的引擎直接不显示，
       * 而不是给一个点了会报错的开关。
       */}
      {transactionCapable && session && (
        <PageNotice
          tone={inTransaction ? "warning" : "neutral"}
          action={
            inTransaction ? (
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={txnBusy || running || cancelling}
                  onClick={() => void runTxn("COMMIT", t("提交事务"))}
                >
                  {txnBusy ? <Loader2 size={11} className="animate-spin" /> : null}
                  {t("提交事务")}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={txnBusy || running || cancelling}
                  onClick={() => void runTxn("ROLLBACK", t("回滚事务"))}
                >
                  {t("回滚事务")}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                disabled={txnBusy || running || cancelling}
                onClick={() => void runTxn("START TRANSACTION", t("开启事务"))}
                title={t("开启后，本会话的语句要显式提交才生效")}
              >
                {txnBusy ? <Loader2 size={11} className="animate-spin" /> : null}
                {t("开启事务")}
              </Button>
            )
          }
        >
          <span className="font-medium">
            {inTransaction
              ? session?.transaction === "in_transaction_read_only"
                ? t("手动事务（只读）")
                : t("手动事务：未提交")
              : t("自动提交")}
          </span>
          <span className="ml-2 text-10">
            {inTransaction
              ? t("本标签的语句已在事务里，关闭标签前必须选择提交或回滚。")
              : transactionLimitedReason ??
                t("每条语句单独提交。需要多条语句一起生效时，开启事务。")}
          </span>
        </PageNotice>
      )}

      <div className="page-toolbar">
        <Select
          className="w-[140px]"
          size="sm"
          value={profile.id}
          ariaLabel={t("选择连接")}
          title={t("选择连接（会为新连接打开一份查询）")}
          onChange={handleConnectionChange}
          options={connectionOptions}
        />
        <Select
          className="w-[130px]"
          size="sm"
          value={contextDatabase ?? ""}
          placeholder={t("选择数据库")}
          ariaLabel={t("选择数据库")}
          title={t("选择当前查询使用的数据库")}
          disabled={!session}
          onChange={(value) => setContextDatabase(value)}
          options={databaseOptions}
        />
        {switchingDb && (
          <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
        )}
        <span className="mx-1 h-5 w-px bg-line" />
        <Button
          variant="ghost"
          size="xs"
          disabled={!sqlText.trim()}
          onClick={handleSaveQuery}
          title={t("保存查询（不执行 SQL）")}
        >
          <Save size={12} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void handleOpenSqlFile()}
          title={t("打开本地 .sql 文件")}
        >
          <FolderOpen size={12} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!sqlText.trim()}
          onClick={() => void handleSaveSqlFile()}
          title={t("另存为 .sql 文件")}
        >
          <FileDown size={12} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!sqlText.trim()}
          onClick={handleFormatSql}
          title={t("格式化 SQL（Ctrl+Shift+F）")}
        >
          <FileCode2 size={12} />
          {t("格式化")}
        </Button>
        <span className="mx-1 h-5 w-px bg-line" />
        <Button
          variant="primary"
          size="xs"
          disabled={!session || running || cancelling || switchingDb}
          onClick={() => void execute("auto")}
          title={t("有选区运行选区，无选区运行全部（Ctrl+Enter）")}
        >
          <Play size={12} />
          {t("运行")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!session || running || cancelling || switchingDb || !sqlText.trim()}
          onClick={() => void execute("all")}
          title={t("按顺序执行整段脚本（Ctrl+Shift+Enter）")}
        >
          {t("运行脚本")}
        </Button>
        {!detached && (
          <Button
            variant="ghost"
            size="xs"
            disabled={!sqlText.trim() || running || cancelling}
            onClick={() => void handleDetach()}
            title={t("在新窗口全屏运行这份 SQL")}
          >
            <Maximize2 size={12} />
          </Button>
        )}
        {(running || cancelling) && (
          <Button
            variant="ghost"
            size="xs"
            disabled={cancelling || cancelBlocked}
            onClick={() => void cancel(tabId)}
            title={
              cancelBlocked
                ? (cancelReason ?? t("该引擎不支持取消查询"))
                : t("发送 KILL QUERY 并在服务器确认前不复用连接")
            }
          >
            {cancelling ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Square size={12} />
            )}
            {cancelling ? t("取消中…") : t("停止")}
          </Button>
        )}
        <span className="mx-1 h-5 w-px bg-line" />
        {showResults && (
          <Button
            variant="ghost"
            size="xs"
            disabled={running || cancelling}
            onClick={handleClearResults}
            title={t("清空当前结果（不会重新执行）")}
          >
            <Eraser size={12} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setHistoryOpen(true)}
          title={t("执行历史")}
        >
          <History size={12} />
        </Button>
        {showResults && (
          <Button
            variant="ghost"
            size="xs"
            disabled={!session || !sqlText.trim() || exportBlocked}
            onClick={() => setExportOpen(true)}
            title={
              exportBlocked
                ? (exportReason ?? t("该引擎暂不支持导出"))
                : exportReason
                  ? t("导出会重新执行这条只读 SQL（{{reason}}）", {
                      reason: exportReason,
                    })
                  : t("导出会重新执行这条只读 SQL")
            }
          >
            <FileDown size={12} />
          </Button>
        )}
      </div>

      {notice && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-2 py-1 text-11 text-warning">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t("关闭")}>
            <X size={10} />
          </button>
        </div>
      )}

      <div
        className={cn(
          "relative min-h-0 overflow-hidden",
          showResults ? "shrink-0 border-b border-line" : "flex-1",
        )}
        style={showResults ? { height: editorHeight } : undefined}
        onKeyDownCapture={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            // Ctrl+Enter = 选区/当前语句；Ctrl+Shift+Enter = 整段脚本。
            void execute(event.shiftKey ? "all" : "auto");
            return;
          }
          if (
            (event.ctrlKey || event.metaKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === "f"
          ) {
            event.preventDefault();
            event.stopPropagation();
            handleFormatSql();
          }
        }}
      >
        <CodeMirror
          className="absolute inset-0"
          value={sqlText}
          height="100%"
          theme={theme}
          extensions={extensions}
          basicSetup={{
            foldGutter: false,
            highlightActiveLine: true,
            // 补全走下面 extensions 里的自定义源（override），这里再开一份会叠加。
            autocompletion: false,
            closeBrackets: true,
            lineNumbers: true,
          }}
          onChange={handleSqlChange}
          onCreateEditor={(view) => {
            viewRef.current = view;
          }}
        />
      </div>

      {showResults && (
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("Drag to resize")}
            className={cn(
              "page-resizer h-[5px] shrink-0 cursor-row-resize",
              dragging ? "bg-accent/40" : "bg-transparent hover:bg-accent/20",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
          />

          <div className="min-h-0 flex-1">
            <ResultsPanel tabId={tabId} onPage={goToPage} />
          </div>
        </>
      )}

      <SaveQueryDialog
        open={saveQueryOpen}
        initialName={item?.title ?? ""}
        onCancel={() => setSaveQueryOpen(false)}
        onConfirm={confirmSaveQuery}
      />

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        profileId={profile.id}
        sql={sqlText}
        table={null}
      />
      <HistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        profileId={profile.id}
        onPick={(statement) => {
          setSql(tabId, statement);
          setHistoryOpen(false);
        }}
      />

      <ConfirmDialog
        open={riskyRun !== null}
        risk="irreversible"
        title={t("确定执行这些删除语句？")}
        description={t("语句会直接删除数据库里的数据，执行后无法撤销。")}
        consequences={[
          ...(riskyRun?.risky ?? [])
            .slice(0, 3)
            .map((entry) => `${DESTRUCTIVE_LABEL[entry.kind]} · ${shortSql(entry.statement)}`),
          ...((riskyRun?.risky.length ?? 0) > 3
            ? [
                t("还有 {{count}} 条语句未展开", {
                  count: (riskyRun?.risky.length ?? 0) - 3,
                }),
              ]
            : []),
        ]}
        confirmLabel={t("执行")}
        onConfirm={() => {
          const pending = riskyRun;
          setRiskyRun(null);
          if (pending) void runParsed(pending.statements);
        }}
        onCancel={() => setRiskyRun(null)}
      />
    </div>
  );
}
