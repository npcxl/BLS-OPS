/**
 * 左侧"数据库资产"：连接 → 数据库 → 表/视图 → 字段/索引。
 *
 * 与服务器面板相同的布局与交互：单击打开/展开，行尾按钮编辑，顶部新建 +
 * 刷新 + 搜索。**按需加载**：展开连接才查库，展开库才查表，展开表才查
 * 字段/索引；未展开的节点不会产生任何查询。
 */
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  Database as DatabaseIcon,
  Eye,
  FileCode2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { DatabaseProfile, DbErrorInfo } from "@/api/types/database";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import {
  useDatabaseWorkspaceStore,
  type SavedQuery,
} from "@/stores/database-workspace-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { ConnectionDialog } from "./ConnectionDialog";
import { useObjectMenuBuilder } from "./object-menu";

const indent = (level: number) => ({ paddingLeft: `${8 + level * 12}px` });

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
      className="flex items-start gap-1.5 py-1 pr-2 text-11 leading-snug text-danger"
      style={indent(level)}
    >
      <TriangleAlert size={11} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{error.message}</span>
      <button
        type="button"
        className="shrink-0 rounded px-1 text-11 text-accent hover:bg-surface-hover"
        onClick={(event) => {
          event.stopPropagation();
          onRetry();
        }}
      >
        {t("重试")}
      </button>
    </div>
  );
}

function LoadingRow({ level }: { level: number }) {
  return (
    <div className="flex items-center gap-1.5 py-1 text-11 text-fg-subtle" style={indent(level)}>
      <Loader2 size={10} className="animate-spin" />
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
  onEdit,
  onDelete,
  onRefresh,
  onContextMenu,
}: {
  profile: DatabaseProfile;
  expanded: boolean;
  connected: boolean;
  error: DbErrorInfo | null;
  onToggle: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="group flex cursor-default items-center gap-1.5 rounded-[6px] py-[4px] pr-1 hover:bg-surface-hover"
      style={indent(0)}
      onDoubleClick={onOpen}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      title={`${profile.username}@${profile.host}:${profile.port}`}
    >
      <button
        type="button"
        aria-label={t("展开")}
        className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-subtle hover:text-fg"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <ChevronRight
          size={12}
          className={cn("transition-transform", expanded && "rotate-90")}
        />
      </button>
      <DatabaseIcon size={13} className="shrink-0 text-fg-subtle" />
      <span className="min-w-0 flex-1 truncate text-12 text-fg">{profile.name}</span>
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          connected ? "bg-success" : "bg-line-strong",
        )}
        title={connected ? t("已连接") : t("未连接")}
      />
      <button
        type="button"
        aria-label={t("刷新")}
        className="hidden h-4 w-4 items-center justify-center rounded text-fg-subtle hover:text-fg group-hover:flex"
        onClick={(event) => {
          event.stopPropagation();
          onRefresh();
        }}
      >
        <RefreshCw size={10} />
      </button>
      <button
        type="button"
        aria-label={t("编辑连接")}
        className="hidden h-4 w-4 items-center justify-center rounded text-fg-subtle hover:text-fg group-hover:flex"
        onClick={(event) => {
          event.stopPropagation();
          onEdit();
        }}
      >
        <Pencil size={10} />
      </button>
      <button
        type="button"
        aria-label={t("删除连接")}
        className="hidden h-4 w-4 items-center justify-center rounded text-fg-subtle hover:text-danger group-hover:flex"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 size={10} />
      </button>
      {error && <TriangleAlert size={10} className="shrink-0 text-danger" />}
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
  const expandedTables = useDatabaseStore((state) => state.expandedTables);
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
  const refreshDatabases = useDatabaseStore((state) => state.refreshDatabases);
  const refreshTables = useDatabaseStore((state) => state.refreshTables);
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);
  const deleteProfile = useDatabaseStore((state) => state.deleteProfile);

  const openDatabaseTab = useWorkbenchStore((state) => state.openDatabaseTab);
  const closeTabById = useWorkbenchStore((state) => state.closeTabById);
  const rootPane = useWorkbenchStore((state) => state.rootPane);

  const openTable = useDatabaseWorkspaceStore((state) => state.openTable);
  const openStructure = useDatabaseWorkspaceStore((state) => state.openStructure);
  const openDatabaseObjects = useDatabaseWorkspaceStore(
    (state) => state.openDatabaseObjects,
  );
  const newQuery = useDatabaseWorkspaceStore((state) => state.newQuery);
  const savedQueries = useDatabaseWorkspaceStore((state) => state.savedQueries);

  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; profile: DatabaseProfile } | null
  >(null);
  const menu = useContextMenu();
  const objectMenu = useObjectMenuBuilder();
  const closeSession = useDatabaseStore((state) => state.closeSession);

  useEffect(() => {
    if (profiles.length === 0) void refreshProfiles();
  }, [profiles.length, refreshProfiles]);

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

  const connectionMenu = (profile: DatabaseProfile) => [
    {
      id: "open",
      label: t("打开连接"),
      onSelect: () => open(profile),
    },
    {
      id: "new-query",
      label: t("新建查询"),
      onSelect: () => {
        open(profile);
        newQuery({
          profileId: profile.id,
          connectionName: profile.name,
          database: null,
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
      id: "disconnect",
      label: t("断开连接"),
      danger: true,
      onSelect: () => void closeSession(profile.id),
    },
  ];

  const databaseMenu = (
    profile: DatabaseProfile,
    database: { name: string },
  ) => {
    const key = `${profile.id}\u0001${database.name}`;
    return [
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
        id: "toggle",
        label: expandedDatabases[key] ? t("收起") : t("展开"),
        onSelect: () => void toggleDatabase(profile.id, database.name),
      },
      {
        id: "copy-name",
        label: t("复制库名"),
        onSelect: () => void copyText(database.name),
      },
    ];
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="min-w-0 flex-1 truncate text-12 font-medium text-fg-muted">
          {t("数据库资产")}
        </span>
        <button
          type="button"
          aria-label={t("新建连接")}
          className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg"
          onClick={() => setDialog({ mode: "create" })}
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          aria-label={t("刷新")}
          className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg"
          onClick={() => void refreshProfiles()}
        >
          <RefreshCw size={11} className={cn(loadingProfiles && "animate-spin")} />
        </button>
      </div>

      <div className="shrink-0 px-2 py-1.5">
        <div className="relative">
          <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("搜索连接…")}
            className="h-[28px] w-full rounded-[6px] border border-line bg-surface-2 pl-6 pr-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          />
        </div>
      </div>

      {profileError && (
        <ErrorRow error={profileError} onRetry={() => void refreshProfiles()} level={1} />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {visibleProfiles.length === 0 && !loadingProfiles && (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-fg-subtle">
            {t("还没有数据库连接。点击右上角 + 新建一个 MySQL 连接。")}
          </p>
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
                connected={!!sessions[profile.id]}
                error={profileLoadError}
                onToggle={() => void toggleProfile(profile.id)}
                onOpen={() => open(profile)}
                onEdit={() => setDialog({ mode: "edit", profile })}
                onDelete={() => void remove(profile)}
                onRefresh={() => {
                  open(profile);
                  void refreshDatabases(profile.id);
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
                    const dbTables = tables[key] ?? [];
                    const dbLoading = loading[key];
                    const dbError = errors[key] ?? null;
                    return (
                      <div key={key}>
                        <div
                          className="group flex cursor-default items-center gap-1 rounded-[6px] py-[4px] pr-1 hover:bg-surface-hover"
                          style={indent(1)}
                          onClick={() => {
                            // 点数据库名称：打开该库全部表的搜索列表；
                            // 展开/收起仍由左侧箭头负责。
                            open(profile);
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
                          <button
                            type="button"
                            aria-label={t("展开")}
                            className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-subtle"
                            onClick={(event) => {
                              event.stopPropagation();
                              void toggleDatabase(profile.id, database.name);
                            }}
                          >
                            <ChevronRight
                              size={11}
                              className={cn("transition-transform", dbOpen && "rotate-90")}
                            />
                          </button>
                          <DatabaseIcon size={11} className="shrink-0 text-fg-subtle" />
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-12",
                              database.system ? "text-fg-subtle" : "text-fg",
                            )}
                          >
                            {database.name}
                          </span>
                          {dbError && <TriangleAlert size={10} className="shrink-0 text-danger" />}
                          <button
                            type="button"
                            aria-label={t("刷新")}
                            className="hidden h-4 w-4 items-center justify-center rounded text-fg-subtle hover:text-fg group-hover:flex"
                            onClick={(event) => {
                              event.stopPropagation();
                              void refreshTables(profile.id, database.name);
                            }}
                          >
                            <RefreshCw size={9} />
                          </button>
                        </div>

                        {dbOpen && dbLoading && <LoadingRow level={2} />}
                        {dbOpen && dbError && (
                          <ErrorRow
                            error={dbError}
                            level={2}
                            onRetry={() => void refreshTables(profile.id, database.name)}
                          />
                        )}
                        {dbOpen &&
                          dbTables
                            .filter((table) => {
                              const needle = filter.trim().toLowerCase();
                              return !needle || table.name.toLowerCase().includes(needle);
                            })
                            .map((table) => {
                              const tableKey = `${profile.id}\u0001${database.name}\u0001${table.name}`;
                              const detail = details[tableKey];
                              const tableOpen = !!expandedTables[tableKey];
                              const tableLoading = loading[tableKey];
                              const tableError = errors[tableKey] ?? null;
                              return (
                                <div key={tableKey}>
                                  <div
                                    className={cn(
                                      "group flex cursor-default items-center gap-1 rounded-[6px] py-[4px] pr-1 hover:bg-surface-hover",
                                      selectedKey === tableKey &&
                                        "bg-accent/10 ring-1 ring-inset ring-accent/20",
                                    )}
                                    style={indent(2)}
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
                                    <button
                                      type="button"
                                      aria-label={t("展开")}
                                      className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-subtle"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void toggleTable(profile.id, database.name, table.name);
                                      }}
                                    >
                                      <ChevronRight
                                        size={10}
                                        className={cn(
                                          "transition-transform",
                                          tableOpen && "rotate-90",
                                        )}
                                      />
                                    </button>
                                    {table.kind === "view" ? (
                                      <Eye size={11} className="shrink-0 text-fg-subtle" />
                                    ) : (
                                      <Table2 size={11} className="shrink-0 text-fg-subtle" />
                                    )}
                                    <span className="min-w-0 flex-1 truncate text-12 text-fg">
                                      {table.name}
                                    </span>
                                    {tableError && (
                                      <TriangleAlert size={10} className="shrink-0 text-danger" />
                                    )}
                                  </div>

                                  {tableOpen && tableLoading && <LoadingRow level={3} />}
                                  {tableOpen && tableError && (
                                    <ErrorRow
                                      error={tableError}
                                      level={3}
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
                                          className="flex items-center gap-1 py-[3px] pr-1 text-11 text-fg-subtle"
                                          style={indent(3)}
                                          title={`${column.column_type}${column.nullable ? "" : " NOT NULL"}`}
                                        >
                                          {column.primary_key ? (
                                            <KeyRound size={9} className="shrink-0 text-accent" />
                                          ) : (
                                            <span className="h-[9px] w-[9px] shrink-0" />
                                          )}
                                          <span className="min-w-0 flex-1 truncate text-fg-muted">
                                            {column.name}
                                          </span>
                                          <span className="shrink-0 text-10">
                                            {column.data_type}
                                          </span>
                                        </div>
                                      ))}
                                      {detail.columns.length > 80 && (
                                        <div
                                          className="py-[3px] text-11 text-fg-subtle"
                                          style={indent(3)}
                                        >
                                          {t("…另有 {{count}} 列", {
                                            count: detail.columns.length - 80,
                                          })}
                                        </div>
                                      )}
                                      <button
                                        type="button"
                                        className="mt-1 rounded px-1 text-11 text-accent hover:bg-surface-hover"
                                        style={indent(3)}
                                        onClick={() => {
                                          open(profile);
                                          openStructure({
                                            profileId: profile.id,
                                            connectionName: profile.name,
                                            database: database.name,
                                            table: table.name,
                                          });
                                        }}
                                      >
                                        {t("查看表结构 / 索引")}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                        {dbOpen && !dbLoading && !dbError && dbTables.length === 0 && (
                          <p className="py-1 text-11 text-fg-subtle" style={indent(2)}>
                            {t("没有表或视图")}
                          </p>
                        )}
                      </div>
                    );
                  })}
            </div>
          );
        })}

        {savedQueries.filter((query) =>
          profiles.some((profile) => profile.id === query.profileId),
        ).length > 0 && (
          <div className="mt-2 border-t border-line pt-1">
            <div className="px-2 py-1 text-11 font-medium text-fg-subtle">
              {t("保存的查询")}
            </div>
            {savedQueries
              .filter((query) =>
                profiles.some((profile) => profile.id === query.profileId),
              )
              .map((query) => (
                <div
                  key={query.id}
                  className="group flex cursor-default items-center gap-1 rounded-[6px] py-[4px] pl-2 pr-1 hover:bg-surface-hover"
                  tabIndex={0}
                  onDoubleClick={() => openSavedQuery(query)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") openSavedQuery(query);
                  }}
                  title={`${query.connectionName}${
                    query.database ? ` / ${query.database}` : ""
                  }\n${t("双击打开这份查询")}`}
                >
                  <FileCode2 size={11} className="shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate text-12 text-fg">
                    {query.name}
                  </span>
                  <span className="shrink-0 text-10 text-fg-subtle">
                    {query.connectionName}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>

      <ContextMenu {...menu.props} />

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
