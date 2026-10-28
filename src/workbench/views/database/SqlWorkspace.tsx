/**
 * SQL 工作区：编辑器 + 执行 + 结果 + 历史 + 导出。
 *
 * 执行语义对齐 Navicat：
 * - 有选区 → 只运行选区（选区里若有多条语句，逐条执行）；
 * - 无选区 → 运行编辑器里的全部 SQL；
 * - 多语句按顺序执行，遇到错误/取消就停在该语句。
 *
 * 另可把当前 SQL 放进独立窗口运行；窗口之间用 Tauri 事件同步执行状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { MySQL, sql as sqlLanguage } from "@codemirror/lang-sql";
import {
  Eraser,
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
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { useEditorTheme } from "@/lib/cm-theme";
import { databaseApi } from "@/api/ops-api";
import type { DatabaseProfile, DbDatabase, DbSessionInfo } from "@/api/types/database";
import { toDbError, useDatabaseStore } from "@/stores/database-store";
import { saveDraft, useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { ResultsPanel } from "./ResultsPanel";
import { ExportDialog } from "./ExportDialog";
import { HistoryDialog } from "./HistoryDialog";
import { SaveQueryDialog } from "./SaveQueryDialog";
import { splitSqlStatements } from "./sql-split";
import { openDetachedSqlWindow } from "./detached-sql";

const EMPTY_DATABASES: DbDatabase[] = [];

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
  const tables = useDatabaseStore((state) => state.tables);
  const details = useDatabaseStore((state) => state.details);

  const sqlText = tab?.sql ?? "";
  const running = tab?.runState === "running";
  const cancelling = tab?.runState === "cancelling";
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
    const timer = window.setTimeout(() => saveDraft(tabId, sqlText), 500);
    return () => window.clearTimeout(timer);
  }, [sqlText, tabId]);

  // 编辑器补全：已加载的库/表/字段。没展开的对象不会出现在补全里，
  // 这比"猜一份元数据"诚实。
  const schema = useMemo(() => {
    const namespace: Record<string, Record<string, string[]>> = {};
    for (const database of databases) {
      const key = `${profile.id}\u0001${database.name}`;
      const list = tables[key] ?? [];
      const tableMap: Record<string, string[]> = {};
      for (const table of list) {
        const detailKey = `${profile.id}\u0001${database.name}\u0001${table.name}`;
        tableMap[table.name] =
          details[detailKey]?.columns.map((column) => column.name) ?? [];
      }
      namespace[database.name] = tableMap;
    }
    return namespace;
  }, [databases, details, profile.id, tables]);

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

  const execute = useCallback(async () => {
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
    // Navicat 行为：有选区运行选区，没有选区运行全部。
    const parsed = splitSqlStatements(selection || sqlText);
    if (parsed.warnings.length > 0) setNotice(parsed.warnings[0]);
    if (parsed.statements.length === 0) {
      setNotice(t("没有可执行的语句"));
      return;
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
      statements: parsed.statements,
    });
  }, [
    contextDatabase,
    profile.id,
    runStatements,
    session,
    sqlText,
    switchDatabase,
    tabId,
    t,
  ]);

  const handleClearResults = () => {
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
    const current = session?.current_database ?? contextDatabase;
    if (current && !list.some((entry) => entry.value === current)) {
      list.unshift({ value: current, label: current });
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
    openDatabaseTab({
      id: target.id,
      name: target.name,
      host: target.host,
      port: target.port,
    });
    newQuery({
      profileId: target.id,
      connectionName: target.name,
      database: target.default_database ?? contextDatabase ?? null,
      sql: sqlText,
      title: item?.title ?? `${target.name} · SQL`,
    });
  };

  const handleDetach = async () => {
    if (!sqlText.trim()) return;
    try {
      await openDetachedSqlWindow({
        profileId: profile.id,
        connectionName: connectionName ?? profile.name,
        database: database ?? null,
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
        dialect: MySQL,
        schema,
        upperCaseKeywords: true,
      }),
    ],
    [schema],
  );

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
      database: item.database ?? database ?? null,
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
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
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
          value={session?.current_database ?? contextDatabase ?? ""}
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
        <span className="mx-1 h-5 w-px bg-line" />
        <Button
          variant="primary"
          size="xs"
          disabled={!session || running || cancelling || switchingDb}
          onClick={() => void execute()}
          title={t("有选区运行选区，无选区运行全部（Ctrl+Enter）")}
        >
          <Play size={12} />
          {t("运行")}
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
            disabled={cancelling}
            onClick={() => void cancel(tabId)}
            title={t("发送 KILL QUERY 并在服务器确认前不复用连接")}
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
            disabled={!session || !sqlText.trim()}
            onClick={() => setExportOpen(true)}
            title={t("导出会重新执行这条只读 SQL")}
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
            void execute();
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
            autocompletion: true,
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
            className={cn(
              "h-[4px] shrink-0 cursor-row-resize",
              dragging ? "bg-accent/40" : "bg-transparent hover:bg-accent/20",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
          />

          <div className="min-h-0 flex-1">
            <ResultsPanel tabId={tabId} canResolveRows={false} />
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
    </div>
  );
}
