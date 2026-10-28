/**
 * 左侧"数据库资产"：连接 → 数据库 → 表/视图 → 字段/索引。
 *
 * 与服务器面板相同的布局与交互：单击打开/展开，行尾按钮编辑，顶部新建 +
 * 刷新 + 搜索。**按需加载**：展开连接才查库，展开库才查表，展开表才查
 * 字段/索引；未展开的节点不会产生任何查询。
 */
import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  ChevronRight,
  ChevronsLeft,
  Database as DatabaseIcon,
  Eye,
  FileCode2,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Table2,
  TriangleAlert,
} from "@/components/icons";
import type { DatabaseProfile, DbErrorInfo } from "@/api/types/database";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { MacSearchField } from "@/components/ui/mac-controls";
import { Tooltip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import {
  categoryKey,
  detailKey,
  tablesKey,
  useDatabaseStore,
} from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import {
  useDatabaseWorkspaceStore,
  type SavedQuery,
} from "@/stores/database-workspace-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { ConnectionDialog } from "./ConnectionDialog";
import { DbEngineIcon } from "./DbEngineIcon";
import { useObjectMenuBuilder } from "./object-menu";
import {
  TableOperationDialog,
  type TableOperationRequestTarget,
} from "./TableOperationDialog";

/** 10px 起点与服务器侧栏的 px-2.5 对齐，每层再缩进 12px。 */
const indent = (level: number) => ({ paddingLeft: `${10 + level * 12}px` });

/**
 * 数据库下的固定分类（表/视图/函数/查询/备份），不因空数据消失。
 *
 * 传了 `onToggle` 就是可收起的分组头：展开态由 store 记住（重启后保持上次的样子），
 * 不传则是纯标签。
 */
function CategoryRow({
  label,
  count,
  icon,
  level = 2,
  open,
  onToggle,
}: {
  label: string;
  count?: number;
  icon: React.ReactNode;
  level?: number;
  open?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      {onToggle && (
        <ChevronRight
          size={14}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
      )}
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="shrink-0">{count}</span>}
    </>
  );

  if (!onToggle) {
    return (
      <div
        className="mt-1 flex items-center gap-1 py-1.5 pr-2.5 text-13 font-medium text-fg-subtle"
        style={indent(level)}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      className="mt-1 flex cursor-default items-center gap-1 rounded-[6px] py-1.5 pr-2.5 text-12 font-medium text-fg-subtle hover:bg-surface-hover hover:text-fg"
      style={indent(level)}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      {content}
    </div>
  );
}

function ErrorRow({
  error,
  onRetry,
  level,
}: {
  error: DbErrorInfo;
  onRetry: () => void;
  level: number;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-start gap-1.5 py-1.5 pr-2.5 text-12 leading-snug text-danger"
      style={indent(level)}
    >
      <TriangleAlert size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{error.message}</span>
      <Button
        variant="ghost"
        size="xs"
        className="h-auto shrink-0 px-1 text-12 text-accent"
        onClick={(event) => {
          event.stopPropagation();
          onRetry();
        }}
      >
        {t("重试")}
      </Button>
    </div>
  );
}

function LoadingRow({ level }: { level: number }) {
  return (
    <div className="flex items-center gap-1.5 py-1.5 text-12 text-fg-subtle" style={indent(level)}>
      <Loader2 size={12} className="animate-spin" />
    </div>
  );
}

const ProfileRow = memo(function ProfileRow({
  profile,
  expanded,
  connected,
  error,
  onToggle,
  onOpen,
  onContextMenu,
}: {
  profile: DatabaseProfile;
  expanded: boolean;
  connected: boolean;
  error: DbErrorInfo | null;
  onToggle: () => void;
  onOpen: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="group flex cursor-default items-center gap-1.5 rounded-[6px] py-1.5 pr-2.5 hover:bg-surface-hover"
      style={indent(0)}
      onDoubleClick={onOpen}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      title={`${profile.username}@${profile.host}:${profile.port}`}
    >
      <Tooltip label={t("展开")} side="right">
        <Button
          variant="ghost"
          size="xs"
          className="h-5 w-5 shrink-0 px-0"
          aria-label={t("展开")}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <ChevronRight
            size={14}
            className={cn("transition-transform", expanded && "rotate-90")}
          />
        </Button>
      </Tooltip>
      <DbEngineIcon
        engine={profile.engine}
        connected={connected}
        size={20}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-14",
          connected ? "text-fg" : "text-fg-muted",
        )}
      >
        {profile.name}
      </span>
      {error && <TriangleAlert size={12} className="shrink-0 text-danger" />}
    </div>
  );
});

export function DatabaseAssetSidebar() {
  const { t } = useTranslation();
  const profiles = useDatabaseStore((state) => state.profiles);
  const loadingProfiles = useDatabaseStore((state) => state.loadingProfiles);
  const profileError = useDatabaseStore((state) => state.profileError);
  const expandedProfiles = useDatabaseStore((state) => state.expandedProfiles);
  const expandedDatabases = useDatabaseStore((state) => state.expandedDatabases);
  const openedDatabases = useDatabaseStore((state) => state.openedDatabases);
  const openDatabase = useDatabaseStore((state) => state.openDatabase);
  const closeDatabase = useDatabaseStore((state) => state.closeDatabase);
  const expandedTables = useDatabaseStore((state) => state.expandedTables);
  const expandedCategories = useDatabaseStore((state) => state.expandedCategories);
  const databases = useDatabaseStore((state) => state.databases);
  const tables = useDatabaseStore((state) => state.tables);
  const details = useDatabaseStore((state) => state.details);
  const loading = useDatabaseStore((state) => state.loading);
  const errors = useDatabaseStore((state) => state.errors);
  const sessions = useDatabaseStore((state) => state.sessions);

  const refreshProfiles = useDatabaseStore((state) => state.refreshProfiles);
  const toggleProfile = useDatabaseStore((state) => state.toggleProfile);
  const toggleDatabase = useDatabaseStore((state) => state.toggleDatabase);
  const toggleTable = useDatabaseStore((state) => state.toggleTable);
  const toggleCategory = useDatabaseStore((state) => state.toggleCategory);
  const refreshDatabases = useDatabaseStore((state) => state.refreshDatabases);
  const refreshTables = useDatabaseStore((state) => state.refreshTables);
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);
  const deleteProfile = useDatabaseStore((state) => state.deleteProfile);

  const openDatabaseTab = useWorkbenchStore((state) => state.openDatabaseTab);
  const closeTabById = useWorkbenchStore((state) => state.closeTabById);
  const rootPane = useWorkbenchStore((state) => state.rootPane);
  const setSidebarCollapsed = useWorkbenchStore(
    (state) => state.setSidebarCollapsed,
  );

  const openTable = useDatabaseWorkspaceStore((state) => state.openTable);
  const openDatabaseObjects = useDatabaseWorkspaceStore(
    (state) => state.openDatabaseObjects,
  );
  const showConnectionInfo = useDatabaseWorkspaceStore(
    (state) => state.showConnectionInfo,
  );
  const newQuery = useDatabaseWorkspaceStore((state) => state.newQuery);
  const savedQueries = useDatabaseWorkspaceStore((state) => state.savedQueries);
  const deleteSavedQuery = useDatabaseWorkspaceStore(
    (state) => state.deleteSavedQuery,
  );

  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; profile: DatabaseProfile } | null
  >(null);
  const [disconnectTarget, setDisconnectTarget] =
    useState<DatabaseProfile | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<DatabaseProfile | null>(null);
  const [deleteQueryTarget, setDeleteQueryTarget] =
    useState<SavedQuery | null>(null);
  const [tableOperation, setTableOperation] =
    useState<TableOperationRequestTarget | null>(null);
  const menu = useContextMenu();
  const objectMenu = useObjectMenuBuilder((context, table, kind) =>
    setTableOperation({
      target: { ...context, table },
      kind,
    }),
  );
  const statuses = useDatabaseStore((state) => state.statuses);
  const refreshStatus = useDatabaseStore((state) => state.refreshStatus);
  const disconnectProfile = useDatabaseStore((state) => state.disconnectProfile);
  const ensureSession = useDatabaseStore((state) => state.ensureSession);
  const reconnect = useDatabaseStore((state) => state.reconnect);

  useEffect(() => {
    if (profiles.length === 0) void refreshProfiles();
  }, [profiles.length, refreshProfiles]);

  useEffect(() => {
    // 拉取每个连接的 Rust 侧运行状态，驱动连接图标上的绿色状态点。
    for (const profile of profiles) void refreshStatus(profile.id);
  }, [profiles, refreshStatus]);

  /*
   * 恢复上次的展开态：localStorage 只记「哪些节点是打开的」，数据不跨进程缓存，
   * 所以按 连接 → 库 → 表 一层层把被记住的节点重新查出来。
   * 每一层只补 `undefined` 的（真缓存/正在加载/已报错都不碰），不会自己触发自己。
   */
  useEffect(() => {
    if (profiles.length === 0) return;
    const state = useDatabaseStore.getState();
    for (const profile of profiles) {
      if (!state.expandedProfiles[profile.id]) continue;
      if (
        state.databases[profile.id] === undefined &&
        !state.loading[profile.id] &&
        !state.errors[profile.id]
      ) {
        void state.refreshDatabases(profile.id);
      }
    }
  }, [profiles]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const [profileId, list] of Object.entries(databases)) {
        for (const database of list) {
          if (cancelled) return;
          const state = useDatabaseStore.getState();
          const key = tablesKey(profileId, database.name);
          if (!state.expandedDatabases[key]) continue;
          if (
            state.tables[key] !== undefined ||
            state.loading[key] ||
            state.errors[key]
          ) {
            continue;
          }
          // 串行：展开的库一多，并发请求会挤爆同一个连接池。
          await state.refreshTables(profileId, database.name);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [databases]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const [key, list] of Object.entries(tables)) {
        const [profileId, database] = key.split("\u0001");
        if (!profileId || !database) continue;
        for (const table of list) {
          if (cancelled) return;
          const state = useDatabaseStore.getState();
          const tableKey = detailKey(profileId, database, table.name);
          if (!state.expandedTables[tableKey]) continue;
          if (
            state.details[tableKey] !== undefined ||
            state.loading[tableKey] ||
            state.errors[tableKey]
          ) {
            continue;
          }
          await state.refreshTableDetail(profileId, database, table.name);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tables]);

  const visibleProfiles = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter(
      (profile) =>
        profile.name.toLowerCase().includes(needle) ||
        profile.host.toLowerCase().includes(needle) ||
        profile.username.toLowerCase().includes(needle),
    );
  }, [filter, profiles]);

  const open = (profile: DatabaseProfile) => {
    openDatabaseTab({
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
    });
  };

  /** 双击表：打开连接标签，并在其中打开一个独立表工作项。 */
  const openTableItem = (profile: DatabaseProfile, database: string, table: string) => {
    open(profile);
    openTable({
      profileId: profile.id,
      connectionName: profile.name,
      database,
      table,
    });
  };

  const openSavedQuery = (query: SavedQuery) => {
    const profile = profiles.find((entry) => entry.id === query.profileId);
    if (!profile) return;
    open(profile);

    const existing = useDatabaseWorkspaceStore
      .getState()
      .items.find((item) => item.savedQueryId === query.id);
    if (existing) {
      useDatabaseWorkspaceStore.getState().setActive(existing.id);
      // 已有工作项可能还没挂载过，确保它的编辑器 tab 存在；
      // 但绝不把 SQL 重置为保存版本，避免覆盖未保存修改。
      useDatabaseWorkbenchStore
        .getState()
        .ensureTab(existing.id, query.profileId);
      return;
    }

    const id = newQuery({
      profileId: query.profileId,
      connectionName: query.connectionName,
      database: query.database,
      sql: query.sql,
      savedQueryId: query.id,
      title: query.name,
    });
    const workbench = useDatabaseWorkbenchStore.getState();
    workbench.ensureTab(id, query.profileId);
    workbench.setSql(id, query.sql);
  };

  const remove = async (profile: DatabaseProfile) => {
    // 关闭这个连接的所有标签，再删配置。
    const ids: string[] = [];
    const walk = (pane: typeof rootPane) => {
      for (const tab of pane.tabs) {
        if (tab.type === "database" && tab.profileId === profile.id) ids.push(tab.id);
      }
      for (const child of pane.children ?? []) walk(child);
    };
    walk(rootPane);
    for (const id of ids) closeTabById(id);
    await deleteProfile(profile.id);
  };

  const connectionMenu = (profile: DatabaseProfile) => {
    const connected = !!sessions[profile.id];
    return [
      {
        id: "open",
        label: t("打开连接"),
        onSelect: () => {
          open(profile);
          void ensureSession(profile.id);
        },
      },
      ...(connected
        ? [
          {
            id: "reconnect",
            label: t("重新连接"),
            onSelect: () => void reconnect(profile.id),
          },
          { separator: true as const },
          {
            id: "close",
            label: t("关闭连接"),
            danger: true,
            onSelect: () => setDisconnectTarget(profile),
          },
        ]
        : []),
      {
        id: "info",
        label: t("连接信息"),
        onSelect: () => showConnectionInfo(profile.id),
      },
      {
        id: "new-query",
        label: t("新建查询"),
        onSelect: () => {
          open(profile);
          newQuery({
            profileId: profile.id,
            connectionName: profile.name,
            database:
              sessions[profile.id]?.current_database ??
              profile.default_database ??
              null,
          });
        },
      },
      {
        id: "refresh",
        label: t("刷新数据库"),
        onSelect: () => {
          open(profile);
          void refreshDatabases(profile.id);
        },
      },
      { separator: true },
      {
        id: "edit",
        label: t("编辑连接"),
        onSelect: () => setDialog({ mode: "edit", profile }),
      },
      {
        id: "copy-name",
        label: t("复制连接名"),
        onSelect: () => void copyText(profile.name),
      },
      { separator: true },
      {
        id: "delete",
        label: t("删除连接"),
        danger: true,
        onSelect: () => setDeleteTarget(profile),
      },
    ];
  };

  const savedQueryMenu = (query: SavedQuery) => [
    {
      id: "open",
      label: t("打开查询"),
      onSelect: () => openSavedQuery(query),
    },
    { separator: true },
    {
      id: "delete",
      label: t("删除保存的查询"),
      danger: true,
      onSelect: () => setDeleteQueryTarget(query),
    },
  ];

  const databaseMenu = (
    profile: DatabaseProfile,
    database: { name: string },
  ) => {
    const key = `${profile.id}\u0001${database.name}`;
    const opened = !!openedDatabases[key];
    return [
      {
        id: "open-close",
        label: opened ? t("关闭数据库") : t("打开数据库"),
        onSelect: () => {
          if (opened) {
            closeDatabase(profile.id, database.name);
            return;
          }
          open(profile);
          void openDatabase(profile.id, database.name);
        },
      },
      {
        id: "objects",
        label: t("打开对象列表"),
        onSelect: () => {
          open(profile);
          openDatabaseObjects({
            profileId: profile.id,
            connectionName: profile.name,
            database: database.name,
          });
        },
      },
      {
        id: "new-query",
        label: t("新建查询"),
        onSelect: () => {
          open(profile);
          newQuery({
            profileId: profile.id,
            connectionName: profile.name,
            database: database.name,
          });
        },
      },
      {
        id: "refresh",
        label: t("刷新表列表"),
        onSelect: () => void refreshTables(profile.id, database.name),
      },
      { separator: true },
      {
        id: "copy-name",
        label: t("复制库名"),
        onSelect: () => void copyText(database.name),
      },
    ];
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 标题栏与服务器侧栏的 SectionTitle 同款：h-7 / px-2.5 / 11px 大写浅色。 */}
      <div className="flex h-7 shrink-0 items-center gap-1 px-2.5">
        <span className="min-w-0 flex-1 truncate text-12 font-semibold uppercase tracking-[0.08em] text-fg-subtle">
          {t("数据库资产")}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip label={t("刷新")} side="bottom">
            <Button
              variant="ghost"
              size="xs"
              className="h-5 w-5 px-0"
              aria-label={t("刷新")}
              onClick={() => void refreshProfiles()}
            >
              <RefreshCw
                size={12}
                className={cn(loadingProfiles && "animate-spin")}
              />
            </Button>
          </Tooltip>
          <Tooltip label={t("折叠侧栏")} side="bottom">
            <Button
              variant="ghost"
              size="xs"
              className="h-5 w-5 px-0"
              aria-label={t("折叠侧栏")}
              onClick={() => setSidebarCollapsed(true)}
            >
              <ChevronsLeft size={12} />
            </Button>
          </Tooltip>
          <Tooltip label={t("新建连接")} side="bottom">
            <Button
              variant="ghost"
              size="xs"
              className="h-5 w-5 px-0"
              aria-label={t("新建连接")}
              onClick={() => setDialog({ mode: "create" })}
            >
              <Plus size={12} />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="shrink-0 px-2.5 pb-1.5 pt-0.5">
        <MacSearchField
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onClear={() => setFilter("")}
          placeholder={t("搜索连接…")}
          className="h-[30px] text-13"
        />
      </div>

      {profileError && (
        <ErrorRow error={profileError} onRetry={() => void refreshProfiles()} level={1} />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {visibleProfiles.length === 0 && !loadingProfiles && (
          <EmptyState
            className="px-2.5 py-6"
            title={t("还没有数据库连接。点击右上角 + 新建一个 MySQL 连接。")}
          />
        )}

        {visibleProfiles.map((profile) => {
          const profileOpen = !!expandedProfiles[profile.id];
          const profileDatabases = databases[profile.id] ?? [];
          const profileLoading = loading[profile.id];
          const profileLoadError = errors[profile.id] ?? null;
          return (
            <div key={profile.id}>
              <ProfileRow
                profile={profile}
                expanded={profileOpen}
                connected={
                  statuses[profile.id]?.connected ?? !!sessions[profile.id]
                }
                error={profileLoadError}
                onToggle={() => void toggleProfile(profile.id)}
                onOpen={() => {
                  open(profile);
                  showConnectionInfo(profile.id);
                }}
                onContextMenu={(event) =>
                  menu.onContextMenu(() => connectionMenu(profile))(event)
                }
              />
              {profileOpen && profileLoading && <LoadingRow level={1} />}
              {profileOpen && profileLoadError && (
                <ErrorRow
                  error={profileLoadError}
                  onRetry={() => void refreshDatabases(profile.id)}
                  level={1}
                />
              )}
              {profileOpen &&
                profileDatabases
                  .filter((database) => {
                    const needle = filter.trim().toLowerCase();
                    return !needle || database.name.toLowerCase().includes(needle);
                  })
                  .map((database) => {
                    const key = `${profile.id}\u0001${database.name}`;
                    const dbOpen = !!expandedDatabases[key];
                    const dbOpened = !!openedDatabases[key];
                    const dbTables = tables[key] ?? [];
                    const dbLoading = loading[key];
                    const dbError = errors[key] ?? null;
                    return (
                      <div key={key}>
                        <div
                          className="group flex cursor-default items-center gap-1 rounded-[6px] py-1.5 pr-2.5 hover:bg-surface-hover"
                          style={indent(1)}
                          onClick={() => {
                            // 点数据库 = 连接 + 打开 + 展开 + 打开对象列表。
                            // 打开状态独立于展开态，切换当前库不会把它变灰。
                            open(profile);
                            void ensureSession(profile.id);
                            if (!dbOpened || !dbOpen) {
                              void openDatabase(profile.id, database.name);
                            }
                            openDatabaseObjects({
                              profileId: profile.id,
                              connectionName: profile.name,
                              database: database.name,
                            });
                          }}
                          onContextMenu={(event) => {
                            event.stopPropagation();
                            menu.onContextMenu(() =>
                              databaseMenu(profile, database),
                            )(event);
                          }}
                        >
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-5 w-5 shrink-0 px-0"
                            aria-label={t("展开")}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!dbOpen) {
                                void openDatabase(profile.id, database.name);
                              } else {
                                void toggleDatabase(profile.id, database.name);
                              }
                            }}
                          >
                            <ChevronRight
                              size={14}
                              className={cn("transition-transform", dbOpen && "rotate-90")}
                            />
                          </Button>
                          <DatabaseIcon
                            size={14}
                            className={cn(
                              "shrink-0",
                              dbOpened ? "text-fg" : "text-fg-muted",
                            )}
                          />
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-14",
                              dbOpened
                                ? "font-medium text-fg"
                                : "text-fg-muted",
                            )}
                          >
                            {database.name}
                          </span>
                          {dbError && <TriangleAlert size={12} className="shrink-0 text-danger" />}
                          <Tooltip label={t("刷新表列表")} side="left">
                            <Button
                              variant="ghost"
                              size="xs"
                              className="hidden h-5 w-5 px-0 group-hover:flex"
                              aria-label={t("刷新表列表")}
                              onClick={(event) => {
                                event.stopPropagation();
                                void refreshTables(profile.id, database.name);
                              }}
                            >
                              <RefreshCw size={12} />
                            </Button>
                          </Tooltip>
                        </div>

                        {dbOpen && dbLoading && <LoadingRow level={2} />}
                        {dbOpen && dbError && (
                          <ErrorRow
                            error={dbError}
                            level={2}
                            onRetry={() => void refreshTables(profile.id, database.name)}
                          />
                        )}
                        {dbOpen && (() => {
                          const needle = filter.trim().toLowerCase();
                          const visibleTables = dbTables.filter((table) =>
                            !needle || table.name.toLowerCase().includes(needle),
                          );
                          const groups = [
                            {
                              id: "tables",
                              label: t("表"),
                              icon: <Table2 size={14} className="shrink-0" />,
                              items: visibleTables.filter(
                                (table) => table.kind === "table",
                              ),
                            },
                            {
                              id: "views",
                              label: t("视图"),
                              icon: <Eye size={14} className="shrink-0" />,
                              items: visibleTables.filter(
                                (table) => table.kind === "view",
                              ),
                            },
                          ];
                          const databaseQueries = savedQueries.filter(
                            (query) =>
                              query.profileId === profile.id &&
                              query.database === database.name,
                          );
                          // 分类展开态：缺省展开，收起的记录在 store 里（跨重启保留）。
                          const categoryOpen = (id: string) =>
                            expandedCategories[
                            categoryKey(profile.id, database.name, id)
                            ] !== false;
                          const toggleCat = (id: string) =>
                            toggleCategory(
                              categoryKey(profile.id, database.name, id),
                            );
                          return (
                            <>
                              {groups.map((group) => {
                                const groupOpen = categoryOpen(group.id);
                                return (
                                <Fragment key={group.id}>
                                  <CategoryRow
                                label={group.label}
                                count={group.items.length}
                                icon={group.icon}
                                open={groupOpen}
                                onToggle={() => toggleCat(group.id)}
                              />
                                  {groupOpen && group.items.map((table) => {
                              const tableKey = detailKey(
                                profile.id,
                                database.name,
                                table.name,
                              );
                              const detail = details[tableKey];
                              const tableOpen = !!expandedTables[tableKey];
                              const tableLoading = loading[tableKey];
                              const tableError = errors[tableKey] ?? null;
                              return (
                                <div key={tableKey}>
                                  <div
                                    className={cn(
                                      "group flex cursor-default items-center gap-1 rounded-[6px] py-1.5 pr-2.5 hover:bg-surface-hover",
                                      selectedKey === tableKey &&
                                        "bg-accent/10 ring-1 ring-inset ring-accent/20",
                                    )}
                                    style={indent(3)}
                                    tabIndex={0}
                                    onClick={() => setSelectedKey(tableKey)}
                                    onDoubleClick={() =>
                                      openTableItem(profile, database.name, table.name)
                                    }
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        openTableItem(profile, database.name, table.name);
                                      }
                                    }}
                                    onContextMenu={(event) => {
                                      event.stopPropagation();
                                      menu.onContextMenu(() =>
                                        objectMenu(
                                          {
                                            profileId: profile.id,
                                            connectionName: profile.name,
                                            database: database.name,
                                          },
                                          table,
                                        ),
                                      )(event);
                                    }}
                                    title={`${database.name}.${table.name}`}
                                  >
                                    <Button
                                      variant="ghost"
                                      size="xs"
                                      className="h-5 w-5 shrink-0 px-0"
                                      aria-label={t("展开")}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void toggleTable(profile.id, database.name, table.name);
                                      }}
                                    >
                                      <ChevronRight
                                        size={14}
                                        className={cn(
                                          "transition-transform",
                                          tableOpen && "rotate-90",
                                        )}
                                      />
                                    </Button>
                                    {table.kind === "view" ? (
                                      <Eye
                                        size={14}
                                        className={cn(
                                          "shrink-0",
                                          tableOpen ? "text-fg" : "text-fg-muted",
                                        )}
                                      />
                                    ) : (
                                      <Table2
                                        size={14}
                                        className={cn(
                                          "shrink-0",
                                          tableOpen ? "text-fg" : "text-fg-muted",
                                        )}
                                      />
                                    )}
                                    <span
                                      className={cn(
                                        "min-w-0 flex-1 truncate text-14",
                                        tableOpen
                                          ? "font-medium text-fg"
                                          : "text-fg-muted",
                                      )}
                                    >
                                      {table.name}
                                    </span>
                                    {tableError && (
                                      <TriangleAlert size={12} className="shrink-0 text-danger" />
                                    )}
                                  </div>

                                  {tableOpen && tableLoading && <LoadingRow level={4} />}
                                  {tableOpen && tableError && (
                                    <ErrorRow
                                      error={tableError}
                                      level={4}
                                      onRetry={() =>
                                        void refreshTableDetail(
                                          profile.id,
                                          database.name,
                                          table.name,
                                        )
                                      }
                                    />
                                  )}
                                  {tableOpen && detail && (
                                    <div className="pb-1">
                                      {detail.columns.slice(0, 80).map((column) => (
                                        <div
                                          key={column.name}
                                          className="flex items-center gap-1 py-1.5 pr-2.5 text-12 text-fg-muted"
                                          style={indent(4)}
                                          title={`${column.column_type}${column.nullable ? "" : " NOT NULL"}`}
                                        >
                                          {column.primary_key ? (
                                            <KeyRound size={12} className="shrink-0 text-accent" />
                                          ) : (
                                            <span className="h-[10px] w-[10px] shrink-0" />
                                          )}
                                          <span className="min-w-0 flex-1 truncate text-fg-muted">
                                            {column.name}
                                          </span>
                                          <span className="shrink-0 text-11">
                                            {column.data_type}
                                          </span>
                                        </div>
                                      ))}
                                      {detail.columns.length > 80 && (
                                        <div
                                          className="py-1.5 text-12 text-fg-subtle"
                                          style={indent(4)}
                                        >
                                          {t("…另有 {{count}} 列", {
                                            count: detail.columns.length - 80,
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                                  })}
                                </Fragment>
                                );
                              })}
                              <CategoryRow
                                label={t("函数")}
                                count={0}
                                icon={<Boxes size={14} className="shrink-0" />}
                                open={categoryOpen("functions")}
                                onToggle={() => toggleCat("functions")}
                              />
                              <CategoryRow
                                label={t("查询")}
                                count={databaseQueries.length}
                                icon={<FileCode2 size={14} className="shrink-0" />}
                                open={categoryOpen("queries")}
                                onToggle={() => toggleCat("queries")}
                              />
                              {categoryOpen("queries") &&
                                databaseQueries.map((query) => (
                                <div
                                  key={query.id}
                                  className="flex cursor-default items-center gap-1 rounded-[6px] py-1.5 pr-2.5 text-13 text-fg hover:bg-surface-hover"
                                  style={indent(4)}
                                  onDoubleClick={() => openSavedQuery(query)}
                                  onContextMenu={(event) => {
                                    event.stopPropagation();
                                    menu.onContextMenu(() =>
                                      savedQueryMenu(query),
                                    )(event);
                                  }}
                                  title={query.name}
                                >
                                  <FileCode2 size={14} className="shrink-0 text-fg-subtle" />
                                  <span className="min-w-0 flex-1 truncate">
                                    {query.name}
                                  </span>
                                </div>
                              ))}
                              <CategoryRow
                                label={t("备份")}
                                count={0}
                                icon={<DatabaseIcon size={14} className="shrink-0" />}
                                open={categoryOpen("backups")}
                                onToggle={() => toggleCat("backups")}
                              />

                            </>
                          );
                        })()}
                      </div>
                    );
                  })}
            </div>
          );
        })}

        {savedQueries.filter(
          (query) =>
            query.database === null &&
            profiles.some((profile) => profile.id === query.profileId),
        ).length > 0 && (
          <div className="mt-2 border-t border-line pt-1">
            <div className="px-2.5 py-1.5 text-12 font-medium text-fg-subtle">
              {t("保存的查询")}
            </div>
            {savedQueries
              .filter(
                (query) =>
                  query.database === null &&
                  profiles.some((profile) => profile.id === query.profileId),
              )
              .map((query) => (
                <div
                  key={query.id}
                  className="group flex cursor-default items-center gap-1 rounded-[6px] py-1.5 pl-2.5 pr-2.5 hover:bg-surface-hover"
                  tabIndex={0}
                  onDoubleClick={() => openSavedQuery(query)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") openSavedQuery(query);
                  }}
                  onContextMenu={(event) => {
                    event.stopPropagation();
                    menu.onContextMenu(() => savedQueryMenu(query))(event);
                  }}
                  title={`${query.connectionName}${
                    query.database ? ` / ${query.database}` : ""
                  }\n${t("双击打开这份查询")}`}
                >
                  <FileCode2 size={14} className="shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate text-14 text-fg">
                    {query.name}
                  </span>
                  <span className="shrink-0 text-11 text-fg-subtle">
                    {query.connectionName}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>

      <ContextMenu {...menu.props} />

      <ConfirmDialog
        open={disconnectTarget !== null}
        danger
        title={t("关闭连接「{{name}}」？", { name: disconnectTarget?.name ?? "" })}
        description={t(
          "关闭后，该连接上未提交的事务会回滚，临时表会丢失；工作项和 SQL 草稿会保留。",
        )}
        confirmLabel={t("关闭连接")}
        onCancel={() => setDisconnectTarget(null)}
        onConfirm={() => {
          if (disconnectTarget) void disconnectProfile(disconnectTarget.id);
          setDisconnectTarget(null);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        title={t("删除连接「{{name}}」？", { name: deleteTarget?.name ?? "" })}
        description={t(
          "将关闭该连接的所有标签、删除已保存的密码和连接配置；SQL 草稿会保留。",
        )}
        confirmLabel={t("删除连接")}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void remove(deleteTarget);
          setDeleteTarget(null);
        }}
      />

      <ConfirmDialog
        open={deleteQueryTarget !== null}
        danger
        title={t("删除保存的查询「{{name}}」？", {
          name: deleteQueryTarget?.name ?? "",
        })}
        description={t("只删除本地保存的 SQL，不会删除数据库里的数据。")}
        confirmLabel={t("删除")}
        onCancel={() => setDeleteQueryTarget(null)}
        onConfirm={() => {
          if (deleteQueryTarget) deleteSavedQuery(deleteQueryTarget.id);
          setDeleteQueryTarget(null);
        }}
      />

      <TableOperationDialog
        pending={tableOperation}
        onClose={() => setTableOperation(null)}
        onApplied={() => undefined}
      />

      <ConnectionDialog
        open={dialog !== null}
        profile={dialog?.mode === "edit" ? dialog.profile : null}
        onClose={() => setDialog(null)}
        onSaved={(saved) => {
          open(saved);
          // 已经展开的不要因为保存再收起（toggle 会翻转）。
          if (!useDatabaseStore.getState().expandedProfiles[saved.id]) {
            void toggleProfile(saved.id);
          }
        }}
      />
    </div>
  );
}
