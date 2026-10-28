/**
 * 独立 SQL 窗口：只承载一份查询，不渲染整个工作台。
 *
 * 它与主窗口共用后端会话（同一个 profileId），结果保存在本窗口自己的
 * store 里；执行完成通过 `detached-sql` 事件通知主窗口。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
import { SqlWorkspace } from "./SqlWorkspace";
import {
  consumeDetachedSqlPayload,
  detachedSqlId,
  emitDetachedSqlEvent,
  type DetachedSqlPayload,
} from "./detached-sql";

const TERMINAL_STATES = ["completed", "failed", "cancelled", "outcome_unknown"];

export function DetachedSqlWindow() {
  const { t } = useTranslation();
  const id = detachedSqlId();
  const [payload] = useState<DetachedSqlPayload | null>(() =>
    id ? consumeDetachedSqlPayload(id) : null,
  );
  const [tabId, setTabId] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const initialized = useRef(false);

  const profile = useDatabaseStore(
    (state) =>
      payload
        ? state.profiles.find((entry) => entry.id === payload.profileId) ?? null
        : null,
  );
  const session = useDatabaseStore(
    (state) =>
      payload ? state.sessions[payload.profileId] ?? null : null,
  );
  const refreshProfiles = useDatabaseStore((state) => state.refreshProfiles);
  const ensureSession = useDatabaseStore((state) => state.ensureSession);

  useEffect(() => {
    if (!payload) {
      setSetupError(t("缺少 SQL 参数：请从主窗口重新全屏运行"));
      return;
    }
    if (initialized.current) return;
    initialized.current = true;

    const workbench = useDatabaseWorkbenchStore.getState();
    const workspace = useDatabaseWorkspaceStore.getState();
    const nextId = workspace.newQuery({
      profileId: payload.profileId,
      connectionName: payload.connectionName,
      database: payload.database,
      sql: payload.sql,
      title: payload.title,
    });
    workbench.ensureTab(nextId, payload.profileId);
    workbench.setSql(nextId, payload.sql);
    setTabId(nextId);

    void refreshProfiles();
    void ensureSession(payload.profileId);
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
      void getCurrentWindow().close();
    } catch {
      window.close();
    }
  };

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
