/**
 * 一个数据库标签 = 一个连接的大视图。
 *
 * 顶部是连接状态条（真实版本 / TLS / 当前库 / 只读 / 事务），下面在
 * "SQL 工作区"与"表数据"之间切换。连接使用左侧资产树选中的配置，
 * 切换标签不会重连（会话在 `database-store` 中按连接共享）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Database as DatabaseIcon,
  Loader2,
  RefreshCw,
  Table2,
  TerminalSquare,
  TriangleAlert,
  Lock,
  Unlock,
  PlugZap,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { databaseApi } from "@/api/ops-api";
import { toDbError, useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkspaceTab } from "@/workbench/types";
import { SqlWorkspace } from "./SqlWorkspace";
import { TableBrowser } from "./TableBrowser";

function StageBadge({ stage }: { stage: string }) {
  return (
    <span className="rounded bg-danger/15 px-1 py-0.5 text-[9px] font-medium text-danger">
      {stage}
    </span>
  );
}

export function DatabaseView({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  const profileId = tab.profileId ?? null;

  const profiles = useDatabaseStore((state) => state.profiles);
  const sessions = useDatabaseStore((state) => state.sessions);
  const sessionErrors = useDatabaseStore((state) => state.sessionErrors);
  const databases = useDatabaseStore((state) => state.databases);
  const refreshDatabases = useDatabaseStore((state) => state.refreshDatabases);
  const ensureSession = useDatabaseStore((state) => state.ensureSession);
  const refreshStatus = useDatabaseStore((state) => state.refreshStatus);
  const invalidate = useDatabaseStore((state) => state.invalidate);
  const openTableRequest = useDatabaseStore((state) => state.openTableRequest);
  const closeTabById = useWorkbenchStore((state) => state.closeTabById);

  const ensureTab = useDatabaseWorkbenchStore((state) => state.ensureTab);
  const tabState = useDatabaseWorkbenchStore((state) =>
    tab.id ? state.tabs[tab.id] : undefined,
  );
  const clearResults = useDatabaseWorkbenchStore((state) => state.clearResults);

  const [view, setView] = useState<"sql" | "table">("sql");
  const [tableTarget, setTableTarget] = useState<{
    database: string;
    table: string;
  } | null>(null);
  const [structureOnly, setStructureOnly] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const profile = useMemo(
    () => profiles.find((item) => item.id === profileId) ?? null,
    [profileId, profiles],
  );
  const session = profileId ? sessions[profileId] : undefined;
  const sessionError = profileId ? sessionErrors[profileId] : null;

  useEffect(() => {
    if (!profileId) return;
    ensureTab(tab.id, profileId);
    if (!session) void ensureSession(profileId);
    if (!databases[profileId]) void refreshDatabases(profileId);
    void refreshStatus(profileId);
    // session 变化时不要重复调用：`ensureSession` 内部会复用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, tab.id]);

  // 会话重连（generation 变化）→ 旧结果不再属于这条连接，清空并提示。
  const generation = session?.generation ?? 0;
  useEffect(() => {
    if (!tabState) return;
    if (tabState.results.length > 0 && tabState.runState !== "running") {
      clearResults(tab.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  useEffect(() => {
    if (!openTableRequest || openTableRequest.profileId !== profileId) return;
    setTableTarget({
      database: openTableRequest.database,
      table: openTableRequest.table,
    });
    setStructureOnly(openTableRequest.view === "structure");
    setView("table");
  }, [openTableRequest, profileId]);

  const switchDatabase = useCallback(
    async (database: string) => {
      if (!session) return;
      setSwitching(true);
      setSwitchError(null);
      try {
        await databaseApi.useDatabase(session.session_id, database);
        await useDatabaseStore.getState().refreshStatus(session.profile_id);
        const refreshed = await databaseApi.sessionInfo(session.session_id);
        useDatabaseStore.setState((state) => ({
          sessions: { ...state.sessions, [session.profile_id]: refreshed },
        }));
      } catch (failure) {
        setSwitchError(toDbError(failure).message);
      } finally {
        setSwitching(false);
      }
    },
    [session],
  );

  if (!profileId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-1 px-6">
        <DatabaseIcon size={26} className="text-fg-subtle" />
        <p className="text-13 text-fg">{t("从左侧选择一个数据库连接")}</p>
        <p className="max-w-sm text-center text-11 leading-relaxed text-fg-subtle">
          {t(
            "左侧「数据库资产」按需加载连接、库和表。每个连接在右侧拥有自己的标签、编辑器和结果。",
          )}
        </p>
        <Button variant="ghost" size="sm" onClick={() => closeTabById(tab.id)}>
          {t("关闭标签")}
        </Button>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface-1 px-6">
        <TriangleAlert size={20} className="text-danger" />
        <p className="text-12 text-fg">{t("连接配置已删除或不存在")}</p>
        <Button variant="ghost" size="sm" onClick={() => closeTabById(tab.id)}>
          {t("关闭标签")}
        </Button>
      </div>
    );
  }

  const currentDatabase = session?.current_database ?? profile.default_database;
  const dbList = databases[profileId] ?? [];
  const busy =
    tabState?.runState === "running" ||
    tabState?.runState === "cancelling" ||
    switching;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      {/* connection status bar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
        <DatabaseIcon size={13} className="shrink-0 text-fg-subtle" />
        <span className="max-w-[180px] truncate text-12 font-medium text-fg">
          {profile.name}
        </span>

        {!session && !sessionError && (
          <span className="flex items-center gap-1 text-11 text-fg-muted">
            <Loader2 size={11} className="animate-spin text-accent" />
            {t("连接中…（SSH / TLS / 认证）")}
          </span>
        )}

        {!session && sessionError && (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-11 text-danger">
            <StageBadge stage={sessionError.stage} />
            <span className="truncate" title={sessionError.message}>
              {sessionError.message}
            </span>
            {sessionError.detail && (
              <span className="hidden truncate text-fg-subtle lg:inline" title={sessionError.detail}>
                {sessionError.detail}
              </span>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void ensureSession(profileId)}
            >
              <RefreshCw size={10} />
              {t("重试")}
            </Button>
          </span>
        )}

        {session && (
          <>
            <span
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
                session.tls_active
                  ? "bg-success/10 text-success"
                  : "bg-surface-2 text-fg-subtle",
              )}
              title={
                session.tls_active
                  ? `${session.tls_cipher ?? ""} ${session.tls_version ?? ""}`
                  : t("TLS 未启用：连接为明文")
              }
            >
              {session.tls_active ? <Lock size={9} /> : <Unlock size={9} />}
              {session.tls_active ? t("TLS") : t("明文")}
            </span>
            <span className="text-[10px] text-fg-subtle">
              MySQL {session.server_version ?? "?"}
            </span>
            <span className="text-[10px] text-fg-subtle">#{session.connection_id}</span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px]",
                session.read_only
                  ? "bg-surface-2 text-fg-subtle"
                  : "bg-warning/15 text-warning",
              )}
              title={
                session.read_only
                  ? t("服务器已设置只读事务")
                  : t("可写连接：修改会真正落库")
              }
            >
              {session.read_only ? t("只读") : t("可写")}
            </span>
            {session.transaction !== "none" && session.transaction !== "unknown" && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                {session.transaction === "in_transaction_read_only"
                  ? t("只读事务中")
                  : t("事务未提交")}
              </span>
            )}

            <Select
              className="w-[190px]"
              size="sm"
              value={currentDatabase ?? ""}
              ariaLabel={t("切换当前数据库（USE）")}
              title={t("切换当前数据库（USE）")}
              onChange={(value) => {
                if (value) void switchDatabase(value);
              }}
              options={[
                { value: "", label: t("（未选择数据库）") },
                ...dbList
                  .filter((database) => !database.system)
                  .map((database) => ({
                    value: database.name,
                    label: database.name,
                  })),
              ]}
            />
            {switching && <Loader2 size={11} className="animate-spin text-accent" />}
            {switchError && (
              <span className="max-w-[220px] truncate text-[10px] text-danger" title={switchError}>
                {switchError}
              </span>
            )}
          </>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant={view === "sql" ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setView("sql")}
          >
            <TerminalSquare size={11} />
            SQL
          </Button>
          <Button
            variant={view === "table" ? "secondary" : "ghost"}
            size="xs"
            disabled={!tableTarget}
            onClick={() => setView("table")}
          >
            <Table2 size={11} />
            {tableTarget ? `${tableTarget.table}` : t("表数据")}
          </Button>
          {view === "table" && tableTarget && (
            <button
              type="button"
              aria-label={t("关闭表")}
              className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg"
              onClick={() => {
                setTableTarget(null);
                setView("sql");
              }}
            >
              <X size={11} />
            </button>
          )}
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => {
              if (!profileId) return;
              void invalidate(profileId);
            }}
            title={t("失效元数据缓存并重新加载库列表")}
          >
            <RefreshCw size={11} />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!session}
            onClick={() => void ensureSession(profileId)}
            title={t("重新连接（会丢弃原事务与临时表）")}
          >
            <PlugZap size={11} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {view === "sql" ? (
          <SqlWorkspace
            tabId={tab.id}
            profile={profile}
            session={session ?? null}
            onOpenTable={(database, table) => {
              setTableTarget({ database, table });
              setStructureOnly(false);
              setView("table");
            }}
          />
        ) : tableTarget ? (
          <TableBrowser
            tabId={tab.id}
            profile={profile}
            session={session ?? null}
            database={tableTarget.database}
            table={tableTarget.table}
            initialView={structureOnly ? "structure" : "data"}
            onClose={() => {
              setTableTarget(null);
              setView("sql");
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-12 text-fg-subtle">
            {t("从左侧选择一个表")}
          </div>
        )}
      </div>
    </div>
  );
}
