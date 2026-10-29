/**
 * 中央工作区：把每个工作项渲染成一个**常驻**的页面。
 *
 * 非活动项用 `display:none` 隐藏而不是卸载：分页、筛选、滚动位置、
 * SQL 草稿、结果集和待提交修改都留在原来的组件实例里，切换回来即恢复。
 * 这也是"切换不能清空待提交修改"的实现方式。
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Database as DatabaseIcon,
  PlugZap,
  SquareTerminal,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { databaseApi } from "@/api/ops-api";
import type { DbSessionInfo } from "@/api/types/database";
import { cn } from "@/lib/cn";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import {
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";
import { DatabaseObjects } from "./DatabaseObjects";
import { SqlWorkspace } from "./SqlWorkspace";
import { TableBrowser } from "./TableBrowser";
import { TableStructure } from "./TableStructure";

function QueryStatusSync({
  itemId,
  profileId,
}: {
  itemId: string;
  profileId: string;
}) {
  const runState = useDatabaseWorkbenchStore((state) => state.tabs[itemId]?.runState);
  const sessionId = useDatabaseStore(
    (state) => state.sessions[profileId]?.session_id,
  );
  const setStatus = useDatabaseWorkspaceStore((state) => state.setStatus);
  useEffect(() => {
    setStatus(itemId, {
      running: runState === "running" || runState === "cancelling",
    });
  }, [itemId, runState, setStatus]);

  // 查询结束后重新读会话信息：事务状态（BEGIN/COMMIT）与会话丢失
  // （transaction=Unknown）必须同步到界面，不能只靠用户手动刷新。
  useEffect(() => {
    if (!sessionId) return;
    if (
      runState !== "completed" &&
      runState !== "failed" &&
      runState !== "cancelled" &&
      runState !== "outcome_unknown"
    ) {
      return;
    }
    void databaseApi
      .sessionInfo(sessionId)
      .then((info) => {
        useDatabaseStore.setState((state) => ({
          sessions: { ...state.sessions, [profileId]: info },
        }));
      })
      .catch(() => undefined);
  }, [profileId, runState, sessionId]);

  return null;
}

function QueryHost({
  item,
  profileId,
  connectionName,
  session,
}: {
  item: WorkItem;
  profileId: string;
  connectionName: string;
  session: DbSessionInfo | null;
}) {
  const profile = useDatabaseStore(
    (state) => state.profiles.find((entry) => entry.id === profileId) ?? null,
  );
  const ensureTab = useDatabaseWorkbenchStore((state) => state.ensureTab);
  const openTable = useDatabaseWorkspaceStore((state) => state.openTable);

  useEffect(() => {
    if (profile) ensureTab(item.id, profileId);
  }, [ensureTab, item.id, profile, profileId]);

  if (!profile) return null;
  return (
    <>
      <QueryStatusSync itemId={item.id} profileId={profileId} />
      <SqlWorkspace
        tabId={item.id}
        profile={profile}
        session={session}
        connectionName={connectionName}
        database={item.database}
        onOpenTable={(database, table) =>
          openTable({ profileId, connectionName, database, table })
        }
      />
    </>
  );
}

function StructureHost({
  item,
  profileId,
  session,
  onRequestClose,
}: {
  item: WorkItem;
  profileId: string;
  session: DbSessionInfo | null;
  onRequestClose: (item: WorkItem) => void;
}) {
  const profile = useDatabaseStore(
    (state) => state.profiles.find((entry) => entry.id === profileId) ?? null,
  );
  const detailKey =
    item.database ? `${profileId}\u0001${item.database}\u0001${item.objectName}` : "";
  const detail = useDatabaseStore((state) =>
    detailKey ? state.details[detailKey] ?? null : null,
  );
  const loading = useDatabaseStore((state) =>
    detailKey ? state.loading[detailKey] ?? false : false,
  );
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);
  const fieldCard = useDatabaseWorkspaceStore((state) => state.fieldCard);
  const showFieldCard = useDatabaseWorkspaceStore((state) => state.showFieldCard);

  useEffect(() => {
    if (profile && item.database && !detail) {
      void refreshTableDetail(profileId, item.database, item.objectName);
    }
  }, [detail, item.database, item.objectName, profile, profileId, refreshTableDetail]);

  if (!profile || !item.database) return null;

  return (
    // 结构页自己画单行头部（保存 / 撤销 / 新增 + 页签 + 表名 / 刷新 / 关闭），
    // 这里不再叠一行工具条。
    <div className="h-full min-h-0 overflow-hidden">
      <TableStructure
        detail={detail}
        loading={loading}
        section="all"
        title={item.objectName}
        refreshing={loading}
        onRefresh={() => void refreshTableDetail(profileId, item.database!, item.objectName)}
        onClose={() => onRequestClose(item)}
        profileId={profileId}
        sessionId={session?.session_id ?? null}
        selectedColumn={
          fieldCard?.profileId === profileId &&
          fieldCard.database === item.database &&
          fieldCard.table === item.objectName
            ? fieldCard.column
            : null
        }
        onSelectColumn={(column) =>
          showFieldCard({
            profileId,
            database: item.database!,
            table: item.objectName,
            column: column.name,
          })
        }
      />
    </div>
  );
}

function TableHost({
  item,
  profileId,
  connectionName,
  session,
  onRequestClose,
  onNewQuery,
  footer,
  active,
}: {
  item: WorkItem;
  profileId: string;
  connectionName: string;
  session: DbSessionInfo | null;
  onRequestClose: (item: WorkItem) => void;
  onNewQuery: (database?: string | null) => void;
  footer?: ReactNode;
  active: boolean;
}) {
  const profile = useDatabaseStore(
    (state) => state.profiles.find((entry) => entry.id === profileId) ?? null,
  );
  const setStatus = useDatabaseWorkspaceStore((state) => state.setStatus);
  if (!profile || !item.database) return null;
  return (
    <TableBrowser
      tabId={item.id}
      profile={profile}
      session={session}
      database={item.database}
      table={item.objectName}
      connectionName={connectionName}
      initialView="data"
      onClose={() => onRequestClose(item)}
      onPendingChange={(count) => setStatus(item.id, { pendingCount: count })}
      onNewQuery={() => onNewQuery(item.database)}
      footer={footer}
      active={active}
    />
  );
}

export function WorkItemHost({
  profileId,
  connectionName,
  session,
  onRequestClose,
  onNewQuery,
  footer,
}: {
  profileId: string;
  connectionName: string;
  session: DbSessionInfo | null;
  onRequestClose: (item: WorkItem) => void;
  onNewQuery: (database?: string | null) => void;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const allItems = useDatabaseWorkspaceStore((state) => state.items);
  const activeId = useDatabaseWorkspaceStore((state) => state.activeId);
  const setActive = useDatabaseWorkspaceStore((state) => state.setActive);
  const reconnect = useDatabaseStore((state) => state.reconnect);
  const items = useMemo(
    () => allItems.filter((item) => item.profileId === profileId),
    [allItems, profileId],
  );
  // activeId 是全局的；切回另一个连接标签时它可能指向别的连接的工作项。
  // 每个连接显示自己最近打开的那一项。
  const effectiveActiveId = items.some((item) => item.id === activeId)
    ? activeId
    : (items[items.length - 1]?.id ?? null);
  const activeItem = items.find((item) => item.id === effectiveActiveId) ?? null;
  useEffect(() => {
    if (items.length > 0 && effectiveActiveId && effectiveActiveId !== activeId) {
      setActive(effectiveActiveId);
    }
  }, [activeId, effectiveActiveId, items.length, setActive]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {!session && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-11 text-warning">
          <span className="min-w-0 flex-1">
            {t("连接已断开：工作项保留，但查询与修改已暂停。事务/临时表不会被恢复。")}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void reconnect(profileId)}
          >
            <PlugZap size={11} />
            {t("重新连接")}
          </Button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <DatabaseIcon size={24} className="text-fg-subtle" />
            <p className="text-13 text-fg">{t("还没有打开的工作项")}</p>
            <p className="max-w-sm text-11 leading-relaxed text-fg-subtle">
              {t("左侧双击表打开数据页；或新建一份独立 SQL 查询。")}
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onNewQuery()}
              disabled={!session}
            >
              <SquareTerminal size={12} />
              {t("新建查询")}
            </Button>
          </div>
        )}

        {items.map((item) => {
          const active = item.id === effectiveActiveId;
          return (
            <div
              key={item.id}
              className={cn("absolute inset-0 min-h-0", !active && "hidden")}
              aria-hidden={!active}
            >
              {item.kind === "table" ? (
                <TableHost
                  item={item}
                  profileId={profileId}
                  connectionName={connectionName}
                  session={session}
                  onRequestClose={onRequestClose}
                  onNewQuery={onNewQuery}
                  footer={footer}
                  active={active}
                />
              ) : item.kind === "structure" ? (
                <StructureHost
                  item={item}
                  profileId={profileId}
                  session={session}
                  onRequestClose={onRequestClose}
                />
              ) : item.kind === "objects" ? (
                <DatabaseObjects
                  item={item}
                  profileId={profileId}
                  connectionName={connectionName}
                  onNewQuery={onNewQuery}
                  onRequestClose={onRequestClose}
                />
              ) : (
                <QueryHost
                  item={item}
                  profileId={profileId}
                  connectionName={connectionName}
                  session={session}
                />
              )}
            </div>
          );
        })}
      </div>

      {footer && activeItem?.kind !== "table" && (
        <footer className="flex h-8 shrink-0 items-center justify-end gap-3 overflow-hidden border-t border-line px-3 text-11 text-fg-subtle">
          {footer}
        </footer>
      )}
    </div>
  );
}
