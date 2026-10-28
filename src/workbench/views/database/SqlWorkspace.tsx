/**
 * SQL 工作区：编辑器 + 执行 + 结果 + 历史 + 导出。
 *
 * 执行语义（明确区分，不假装是 mysql CLI）：
 * - 有选区 → 只执行选区（选区里若有多条语句，逐条执行）；
 * - 无选区 → 执行光标所在语句；
 * - "执行脚本" → 按顺序执行整段（拆分器处理引号/注释，不支持 DELIMITER）。
 *
 * 多语句脚本按顺序执行，遇到错误/取消就停在该语句，前面的结果显示在
 * 各自的结果集标签里。
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
  Play,
  Save,
  ScrollText,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useEditorTheme } from "@/lib/cm-theme";
import { databaseApi } from "@/api/ops-api";
import type { DatabaseProfile, DbDatabase, DbSessionInfo } from "@/api/types/database";
import { toDbError, useDatabaseStore } from "@/stores/database-store";
import { saveDraft, useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
import { ResultsPanel } from "./ResultsPanel";
import { ExportDialog } from "./ExportDialog";
import { HistoryDialog } from "./HistoryDialog";
import { splitSqlStatements, statementAtCursor } from "./sql-split";

const EMPTY_DATABASES: DbDatabase[] = [];

export function SqlWorkspace({
  tabId,
  profile,
  session,
  connectionName,
  database,
  onNewQuery,
  onOpenTable: _onOpenTable,
}: {
  tabId: string;
  profile: DatabaseProfile;
  session: DbSessionInfo | null;
  connectionName?: string;
  database?: string | null;
  onNewQuery?: () => void;
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

  const execute = useCallback(
    (mode: "current" | "script") => {
      if (!session) return;
      const view = viewRef.current;
      const selection = view
        ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to).trim()
        : "";

      let statements: string[] = [];
      if (mode === "script") {
        const parsed = splitSqlStatements(sqlText);
        statements = parsed.statements;
        if (parsed.warnings.length > 0) setNotice(parsed.warnings[0]);
      } else if (selection) {
        const parsed = splitSqlStatements(selection);
        statements = parsed.statements;
        if (parsed.warnings.length > 0) setNotice(parsed.warnings[0]);
      } else {
        const cursor = view?.state.selection.main.head ?? sqlText.length;
        const statement = statementAtCursor(sqlText, cursor);
        if (statement) statements = [statement];
      }

      if (statements.length === 0) {
        setNotice(t("没有可执行的语句"));
        return;
      }
      setNotice(null);
      void runStatements({
        tabId,
        profileId: profile.id,
        sessionId: session.session_id,
        statements,
      });
    },
    [profile.id, runStatements, session, sqlText, tabId, t],
  );

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
    saveQuery({
      itemId: tabId,
      profileId: profile.id,
      connectionName: item.connectionName || connectionName || profile.name,
      database: item.database ?? database ?? null,
      name: item.title,
      sql: sqlText,
    });
    setNotice(t("查询已保存，可在左侧「保存的查询」中找到"));
  };

  const handleOpenSqlFile = async () => {
    try {
      const { open: openFileDialog } = await import("@tauri-apps/plugin-dialog");
      const path = await openFileDialog({
        multiple: false,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (typeof path !== "string") return;
      const content = await databaseApi.readSqlFile(path);
      setSql(tabId, content);
      setItemStatus(tabId, { dirty: true });
      setNotice(t("已打开 {{path}}", { path }));
    } catch (failure) {
      setNotice(toDbError(failure).message);
    }
  };

  const handleSaveSqlFile = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        title: t("保存 SQL 文件"),
        defaultPath: `${item?.title || "query"}.sql`,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (!path) return;
      await databaseApi.writeSqlFile(path, sqlText);
      setNotice(t("已保存到 {{path}}", { path }));
    } catch (failure) {
      setNotice(toDbError(failure).message);
    }
  };

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
        <Button
          variant="primary"
          size="xs"
          onClick={onNewQuery}
          disabled={!onNewQuery}
          title={t("新建一份独立的 SQL 查询")}
        >
          <SquareTerminal size={12} />
          {t("新建查询")}
        </Button>
        <span className="mx-1 h-5 w-px bg-line" />
        <Button
          variant="ghost"
          size="xs"
          disabled={!sqlText.trim()}
          onClick={handleSaveQuery}
          title={t("保存查询（不执行 SQL）")}
        >
          <Save size={12} />
          {t("保存查询")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void handleOpenSqlFile()}
          title={t("打开本地 .sql 文件")}
        >
          <FolderOpen size={12} />
          {t("打开")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!sqlText.trim()}
          onClick={() => void handleSaveSqlFile()}
          title={t("另存为 .sql 文件")}
        >
          <FileDown size={12} />
          {t("保存 .sql")}
        </Button>
        <span className="mx-1 h-5 w-px bg-line" />
        <Button
          variant="primary"
          size="xs"
          disabled={!session || running || cancelling}
          onClick={() => execute("current")}
          title={t("执行选中 SQL 或光标所在语句（Ctrl+Enter）")}
        >
          <Play size={12} />
          {t("执行")}
        </Button>
        <Button
          variant="secondary"
          size="xs"
          disabled={!session || running || cancelling}
          onClick={() => execute("script")}
          title={t("按顺序执行整段脚本（Ctrl+Shift+Enter）")}
        >
          <ScrollText size={12} />
          {t("执行脚本")}
        </Button>
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

        <Button
          variant="ghost"
          size="xs"
          onClick={() => clearResults(tabId)}
          title={t("清空当前结果（不会重新执行）")}
        >
          <Eraser size={12} />
          {t("清空结果")}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => setHistoryOpen(true)}>
          <History size={12} />
          {t("历史")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!session || !sqlText.trim()}
          onClick={() => setExportOpen(true)}
          title={t("导出会重新执行这条只读 SQL")}
        >
          <FileDown size={12} />
          {t("导出 CSV")}
        </Button>
      </div>

      <div
        className="relative min-h-0 shrink-0 overflow-hidden border-b border-line"
        style={{ height: editorHeight }}
        onKeyDownCapture={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            execute(event.shiftKey ? "script" : "current");
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

      {notice && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-2 py-1 text-[10px] text-warning">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t("关闭")}>
            <X size={10} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <ResultsPanel tabId={tabId} canResolveRows={false} />
      </div>

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
