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
import { cn } from "@/lib/cn";
import { useDatabaseStore } from "@/stores/database-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { ConnectionDialog } from "./ConnectionDialog";

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
      className="flex items-start gap-1.5 py-1 pr-2 text-[10px] leading-snug text-danger"
      style={indent(level)}
    >
      <TriangleAlert size={11} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{error.message}</span>
      <button
        type="button"
        className="shrink-0 rounded px-1 text-[10px] text-accent hover:bg-surface-hover"
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
    <div className="flex items-center gap-1.5 py-1 text-[10px] text-fg-subtle" style={indent(level)}>
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
}) {
  const { t } = useTranslation();
  return (
    <div
      className="group flex cursor-default items-center gap-1.5 rounded-[6px] py-[3px] pr-1 hover:bg-surface-hover"
      style={indent(0)}
      onDoubleClick={onOpen}
      onClick={onOpen}
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
      {profile.read_only && (
        <span className="shrink-0 rounded bg-surface-2 px-1 text-[9px] text-fg-subtle">
          {t("只读")}
        </span>
      )}
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
  const requestTable = useDatabaseStore((state) => state.requestTable);

  const openDatabaseTab = useWorkbenchStore((state) => state.openDatabaseTab);
  const closeTabById = useWorkbenchStore((state) => state.closeTabById);
  const rootPane = useWorkbenchStore((state) => state.rootPane);

  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; profile: DatabaseProfile } | null
  >(null);

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="min-w-0 flex-1 truncate text-11 font-medium text-fg-muted">
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
            className="h-[26px] w-full rounded-[6px] border border-line bg-surface-2 pl-6 pr-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
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
                          className="group flex cursor-default items-center gap-1 rounded-[6px] py-[3px] pr-1 hover:bg-surface-hover"
                          style={indent(1)}
                          onClick={() => {
                            open(profile);
                            void toggleDatabase(profile.id, database.name);
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
                              "min-w-0 flex-1 truncate text-11",
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
                                    className="group flex cursor-default items-center gap-1 rounded-[6px] py-[3px] pr-1 hover:bg-surface-hover"
                                    style={indent(2)}
                                    onClick={() => {
                                      open(profile);
                                      requestTable(profile.id, database.name, table.name);
                                    }}
                                    title={
                                      table.estimated_rows !== null
                                        ? t("约 {{count}} 行（估算值）", {
                                            count: table.estimated_rows.toLocaleString(),
                                          })
                                        : undefined
                                    }
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
                                    <span className="min-w-0 flex-1 truncate text-11 text-fg">
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
                                          className="flex items-center gap-1 py-[2px] pr-1 text-[10px] text-fg-subtle"
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
                                          <span className="shrink-0 text-[9px]">
                                            {column.data_type}
                                          </span>
                                        </div>
                                      ))}
                                      {detail.columns.length > 80 && (
                                        <div
                                          className="py-[2px] text-[10px] text-fg-subtle"
                                          style={indent(3)}
                                        >
                                          {t("…另有 {{count}} 列", {
                                            count: detail.columns.length - 80,
                                          })}
                                        </div>
                                      )}
                                      <button
                                        type="button"
                                        className="mt-1 rounded px-1 text-[10px] text-accent hover:bg-surface-hover"
                                        style={indent(3)}
                                        onClick={() => {
                                          open(profile);
                                          requestTable(
                                            profile.id,
                                            database.name,
                                            table.name,
                                            "structure",
                                          );
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
                          <p className="py-1 text-[10px] text-fg-subtle" style={indent(2)}>
                            {t("没有表或视图")}
                          </p>
                        )}
                      </div>
                    );
                  })}
            </div>
          );
        })}
      </div>

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
