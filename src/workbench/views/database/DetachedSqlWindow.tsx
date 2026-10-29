/**
 * 独立 SQL 窗口：只承载一份查询，不渲染整个工作台。
 *
 * 它与主窗口共用后端会话（同一个 profileId），结果保存在本窗口自己的
 * store 里；执行完成通过 `detached-sql` 事件通知主窗口。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, X } from "@/components/icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading";
import { copyText } from "@/lib/clipboard";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
import { DdlCode } from "./DdlCode";
import { SqlWorkspace } from "./SqlWorkspace";
import {
  consumeDetachedSqlPayload,
  detachedSqlId,
  emitDetachedSqlEvent,
  type DetachedPayload,
} from "./detached-sql";

const TERMINAL_STATES = ["completed", "failed", "cancelled", "outcome_unknown"];

export function DetachedSqlWindow() {
  const { t } = useTranslation();
  const id = detachedSqlId();
  const [payload] = useState<DetachedPayload | null>(() =>
    id ? consumeDetachedSqlPayload(id) : null,
  );
  const [tabId, setTabId] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const initialized = useRef(false);

  const sqlPayload = payload && payload.kind !== "ddl" ? payload : null;
  const profile = useDatabaseStore(
    (state) =>
      sqlPayload
        ? state.profiles.find((entry) => entry.id === sqlPayload.profileId) ?? null
        : null,
  );
  const session = useDatabaseStore(
    (state) =>
      sqlPayload ? state.sessions[sqlPayload.profileId] ?? null : null,
  );
  const refreshProfiles = useDatabaseStore((state) => state.refreshProfiles);
  const ensureSession = useDatabaseStore((state) => state.ensureSession);

  useEffect(() => {
    if (!payload) {
      setSetupError(t("缺少 SQL 参数：请从主窗口重新全屏运行"));
      return;
    }
    // DDL 窗口只读：不建查询 tab，也不需要数据库会话。
    if (!sqlPayload) return;
    if (initialized.current) return;
    initialized.current = true;

    const workbench = useDatabaseWorkbenchStore.getState();
    const workspace = useDatabaseWorkspaceStore.getState();
    const nextId = workspace.newQuery({
      profileId: sqlPayload.profileId,
      connectionName: sqlPayload.connectionName,
      database: sqlPayload.database,
      sql: sqlPayload.sql,
      title: sqlPayload.title,
    });
    workbench.ensureTab(nextId, sqlPayload.profileId);
    workbench.setSql(nextId, sqlPayload.sql);
    setTabId(nextId);

    void refreshProfiles();
    void ensureSession(sqlPayload.profileId);
    void emitDetachedSqlEvent({
      action: "opened",
      id: id ?? nextId,
      title: payload.title,
    });

    return () => {
      void emitDetachedSqlEvent({
        action: "closed",
        id: id ?? nextId,
        title: payload.title,
      });
      useDatabaseWorkbenchStore.getState().dispose(nextId);
    };
    // 只依赖一次性 payload/id；语言或 action 引用变化不能触发清理，
    // 否则会把已打开的查询 tab dispose 掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, payload]);

  const runState = useDatabaseWorkbenchStore((state) =>
    tabId ? state.tabs[tabId]?.runState : undefined,
  );
  const lastTerminal = useRef<string | null>(null);

  useEffect(() => {
    if (!tabId || !payload || !runState) return;
    if (runState === "running" || runState === "cancelling") {
      lastTerminal.current = null;
      return;
    }
    if (
      !TERMINAL_STATES.includes(runState) ||
      lastTerminal.current === runState
    ) {
      return;
    }
    lastTerminal.current = runState;
    const tab = useDatabaseWorkbenchStore.getState().tabs[tabId];
    const rows =
      tab?.results.reduce((sum, result) => sum + result.rows.length, 0) ?? 0;
    const elapsedMs = tab?.elapsedMs ?? 0;
    void emitDetachedSqlEvent({
      action: "finished",
      id: id ?? tabId,
      title: payload.title,
      state: runState,
      rows,
      elapsedMs,
    });
  }, [id, payload, runState, tabId]);

  const closeWindow = () => {
    try {
      void getCurrentWindow()
        .close()
        .catch(() => window.close());
    } catch {
      window.close();
    }
  };

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (setupError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-surface-1 px-6 text-center">
        <p className="text-13 text-fg">{setupError}</p>
        <Button variant="ghost" size="sm" onClick={closeWindow}>
          {t("关闭窗口")}
        </Button>
      </div>
    );
  }

  // 只读 DDL 窗口：没有会话、没有执行，只有一段可复制可折行的建表语句。
  if (payload?.kind === "ddl") {
    return (
      <div className="flex h-screen min-h-0 flex-col bg-surface-1">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
          <span
            className="min-w-0 flex-1 truncate text-12 font-medium text-fg"
            title={payload.title}
          >
            {payload.title}
          </span>
          {payload.database && (
            <span className="shrink-0 text-11 text-fg-subtle">{payload.database}</span>
          )}
          <Button
            variant={wrap ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setWrap((value) => !value)}
            title={t("长行自动换行")}
          >
            {t("折行")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 w-6 px-0"
            onClick={() => {
              void copyText(payload.sql).then((ok) => {
                if (ok) setCopied(true);
              });
            }}
            title={copied ? t("已复制") : t("复制 DDL")}
            aria-label={copied ? t("已复制") : t("复制 DDL")}
          >
            <Copy size={12} />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 w-6 px-0"
            onClick={closeWindow}
            title={t("关闭窗口")}
          >
            <X size={12} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 p-2">
          <DdlCode sql={payload.sql} wrap={wrap} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-surface-1">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate text-12 font-medium text-fg">
          {payload?.title ?? t("SQL 查询")}
        </span>
        <span className="shrink-0 text-11 text-fg-subtle">
          {t("独立窗口")}
        </span>
        <span
          className="shrink-0 rounded bg-surface-2 px-1 text-10 text-fg-subtle"
          title={t("与主窗口共用数据库会话：事务和临时表会互相影响")}
        >
          {t("共享会话")}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={closeWindow}
          title={t("关闭窗口")}
        >
          <X size={12} />
        </Button>
      </div>

      {!session && (
        <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-11 text-warning">
          {t("正在建立数据库连接…执行按钮在连接完成后可用")}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {profile && tabId ? (
          <SqlWorkspace
            tabId={tabId}
            profile={profile}
            session={session}
            connectionName={payload?.connectionName}
            database={payload?.database}
            detached
            onOpenTable={() => undefined}
          />
        ) : (
          <LoadingState className="h-full" />
        )}
      </div>
    </div>
  );
}
