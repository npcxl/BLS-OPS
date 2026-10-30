/**
 * 左侧"数据库资产"：连接 → 数据库 → 表/视图 → 字段/索引。
 *
 * 与服务器面板相同的布局与交互：单击打开/展开，行尾按钮编辑，顶部新建 +
 * 刷新 + 搜索。**按需加载**：展开连接才查库，展开库才查表，展开表才查
 * 字段/索引；未展开的节点不会产生任何查询。
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
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
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  TriangleAlert,
  X,
} from "@/components/icons";
import type {
  DatabaseProfile,
  DbErrorInfo,
  DbTableColumn,
} from "@/api/types/database";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { MacSearchField } from "@/components/ui/mac-controls";
import { pushToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { redisDbIndexes, redisDefaultDb } from "./redis/redis-shared";
import {
  categoryKey,
  detailKey,
  tablesKey,
  toDbError,
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
import {
  SchemaChangeDialog,
  type SchemaDialogTarget,
} from "./SchemaChangeDialog";
import {
  CreateTableDialog,
  type CreateTableTarget,
} from "./CreateTableDialog";

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
      aria-expanded={open}
      className="mt-1 flex cursor-default items-center gap-1 rounded-[6px] py-1.5 pr-2.5 text-12 font-medium text-fg-subtle hover:bg-surface-hover hover:text-fg"
      style={indent(level)}
      {...rowKeyboardProps({
        expanded: open,
        onToggle,
        onOpen: onToggle,
        onSelect: onToggle,
      })}
      onClick={onToggle}
    >
      {content}
    </div>
  );
}

/** 树行键盘导航：↑↓ 换行、→← 展开收起、Enter 打开、Space 选中。 */
function moveRowFocus(current: HTMLElement, delta: number) {
  const container = current.closest<HTMLElement>("[data-tree-scroll]");
  if (!container) return;
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-tree-row]"));
  const index = rows.indexOf(current);
  if (index < 0) return;
  const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
  next?.focus();
}

function rowKeyboardProps({
  expanded,
  onToggle,
  onOpen,
  onSelect,
}: {
  expanded?: boolean;
  onToggle?: () => void;
  onOpen: () => void;
  onSelect?: () => void;
}) {
  return {
    tabIndex: 0,
    "data-tree-row": true,
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onOpen();
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        onSelect?.();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveRowFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && onToggle) {
        event.preventDefault();
        if (Boolean(expanded) !== (event.key === "ArrowRight")) onToggle();
      }
    },
  };
}

/** 搜索命中的第一个片段高亮，配合 `data-tree-scroll` 里的 mark 做定位。 */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[3px] bg-accent/25 px-0.5 text-fg">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}

function ErrorRow({
  error,
  onRetry,
  level,
  onDismiss,
}: {
  error: DbErrorInfo;
  onRetry: () => void;
  /** 常驻的错误行必须关得掉，否则树里一直挂着一条红字。 */
  onDismiss?: () => void;
  level: number;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-start gap-1.5 py-1.5 pr-2.5 text-12 leading-snug text-danger"
      style={indent(level)}
    >
      <TriangleAlert size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="break-words">{error.message}</p>
        {error.detail && (
          <p className="mt-0.5 break-words text-11 text-fg-subtle">{error.detail}</p>
        )}
      </div>
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
      {onDismiss && (
        <Button
          variant="ghost"
          size="xs"
          className="h-auto shrink-0 px-1"
          aria-label={t("关闭")}
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
        >
          <X size={11} />
        </Button>
      )}
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
  connecting,
  error,
  query,
  selected,
  onToggle,
  onOpen,
  onSelect,
  onEdit,
  onDelete,
  onRefresh,
  onConnect,
  onDisconnect,
  onContextMenu,
}: {
  profile: DatabaseProfile;
  expanded: boolean;
  connected: boolean;
  /** Redis 建连进行中：按钮显示转圈，且不接受第二次点击。 */
  connecting: boolean;
  error: DbErrorInfo | null;
  query: string;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "group flex cursor-default items-center gap-1.5 rounded-[6px] py-1.5 pr-2.5 hover:bg-surface-hover",
        selected && "bg-accent/10 ring-1 ring-inset ring-accent/20",
      )}
      style={indent(0)}
      {...rowKeyboardProps({ expanded, onToggle, onOpen, onSelect })}
      onFocus={onSelect}
      // 单击只选中，双击才打开连接（与表的交互保持一致）。
      onClick={onSelect}
      onDoubleClick={onOpen}
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
        <Highlight text={profile.name} query={query} />
      </span>
      {/* 行内快捷操作：悬浮才出现，避免连接列表变成按钮墙。 */}
      <Tooltip label={connected ? t("关闭连接") : t("打开连接")} side="left">
        <Button
          variant="ghost"
          size="xs"
          className="hidden h-5 w-5 shrink-0 px-0 group-hover:flex"
          aria-label={connected ? t("关闭连接") : t("打开连接")}
          disabled={connecting}
          onClick={(event) => {
            event.stopPropagation();
            if (connected) onDisconnect();
            else onConnect();
          }}
        >
          {connecting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <PlugZap size={12} className={connected ? "text-fg" : "text-fg-subtle"} />
          )}
        </Button>
      </Tooltip>
      <Tooltip label={t("刷新")} side="left">
        <Button
          variant="ghost"
          size="xs"
          className="hidden h-5 w-5 shrink-0 px-0 group-hover:flex"
          aria-label={t("刷新")}
          onClick={(event) => {
            event.stopPropagation();
            onRefresh();
          }}
        >
          <RefreshCw size={12} />
        </Button>
      </Tooltip>
      <Tooltip label={t("编辑连接")} side="left">
        <Button
          variant="ghost"
          size="xs"
          className="hidden h-5 w-5 shrink-0 px-0 group-hover:flex"
          aria-label={t("编辑连接")}
          onClick={(event) => {
            event.stopPropagation();
            onEdit();
          }}
        >
          <Pencil size={12} />
        </Button>
      </Tooltip>
      <Tooltip label={t("删除连接")} side="left">
        <Button
          variant="ghost"
          size="xs"
          className="hidden h-5 w-5 shrink-0 px-0 hover:text-danger group-hover:flex"
          aria-label={t("删除连接")}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 size={12} />
        </Button>
      </Tooltip>
      {error && (
        <Tooltip label={error.message} side="left">
          <TriangleAlert size={12} className="shrink-0 text-danger" />
        </Tooltip>
      )}
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
  const sessionErrors = useDatabaseStore((state) => state.sessionErrors);

  const refreshProfiles = useDatabaseStore((state) => state.refreshProfiles);
  const toggleProfile = useDatabaseStore((state) => state.toggleProfile);
  const redisConnect = useDatabaseStore((state) => state.redisConnect);
  const redisConnecting = useDatabaseStore((state) => state.redisConnecting);
  const redisReconnect = useDatabaseStore((state) => state.redisReconnect);
  const redisDbIndex = useDatabaseStore((state) => state.redisDbIndex);
  const selectRedisDb = useDatabaseStore((state) => state.selectRedisDb);
  const clearSessionError = useDatabaseStore((state) => state.clearSessionError);
  const toggleDatabase = useDatabaseStore((state) => state.toggleDatabase);
  const toggleTable = useDatabaseStore((state) => state.toggleTable);
  const toggleCategory = useDatabaseStore((state) => state.toggleCategory);
  const refreshDatabases = useDatabaseStore((state) => state.refreshDatabases);
  const refreshTables = useDatabaseStore((state) => state.refreshTables);
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);
  const deleteProfile = useDatabaseStore((state) => state.deleteProfile);

  const openDatabaseTab = useWorkbenchStore((state) => state.openDatabaseTab);
  // 新建连接走标签页（不再弹窗）：表单填完直接落在数据库列表里。
  const openNewConnectionTab = useWorkbenchStore((state) => state.openNewConnectionTab);
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
  const showFieldCard = useDatabaseWorkspaceStore((state) => state.showFieldCard);
  const newQuery = useDatabaseWorkspaceStore((state) => state.newQuery);
  const savedQueries = useDatabaseWorkspaceStore((state) => state.savedQueries);
  const deleteSavedQuery = useDatabaseWorkspaceStore(
    (state) => state.deleteSavedQuery,
  );

  const [filter, setFilter] = useState("");
  // 选中与"已打开"分开：选中只是当前焦点行，不改变任何打开状态。
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
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
  const [schemaDialog, setSchemaDialog] = useState<SchemaDialogTarget | null>(
    null,
  );
  const [createTableTarget, setCreateTableTarget] =
    useState<CreateTableTarget | null>(null);
  const menu = useContextMenu();
  const objectMenu = useObjectMenuBuilder(
    (context, table, kind) =>
      setTableOperation({
        target: { ...context, table },
        kind,
      }),
    (context, table) => {
      setSchemaDialog({
        mode: "save_view",
        profileId: context.profileId,
        database: context.database,
        name: table.name,
        orReplace: true,
      });
      if (!sessions[context.profileId]) {
        void ensureSession(context.profileId);
      }
    },
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

  // 搜索时把第一个命中滚进视口：过滤后命中项可能被上方节点挤出可视区。
  useEffect(() => {
    if (!filter.trim()) return;
    const hit = treeRef.current?.querySelector("mark");
    hit?.scrollIntoView({ block: "nearest" });
  }, [filter]);

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
    try {
      await deleteProfile(profile.id);
    } catch (failure) {
      // 删配置失败以前是没人接的 promise rejection：界面毫无反应。
      const info = toDbError(failure);
      pushToast(info.message, "error", {
        title: t("{{name}} · 删除失败", { name: profile.name }),
        label: info.stage,
        detail: info.detail ?? undefined,
        persist: true,
      });
    }
  };

  const connectionMenu = (profile: DatabaseProfile) => {
    const isRedis = profile.engine === "redis";
    // Redis 没有 SQL 会话，连接与否只看 Rust 运行时状态（statuses）。
    const connected = isRedis
      ? !!statuses[profile.id]?.connected
      : !!sessions[profile.id];
    return [
      {
        id: "open",
        label: t("打开连接"),
        onSelect: () => {
          open(profile);
          if (isRedis) void redisConnect(profile.id);
          else void ensureSession(profile.id);
        },
      },
      ...(connected
        ? [
          {
            id: "reconnect",
            label: t("重新连接"),
            onSelect: () => {
              // Redis 的 db_redis_connect 会复用已有运行时，重连必须先关掉旧的。
              if (isRedis) void redisReconnect(profile.id);
              else void reconnect(profile.id);
            },
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
      // Redis 标签整块是键浏览器，没有可挂连接信息面板的右侧区域，
      // 留一个点了没反应的菜单项比不给更糟。
      ...(isRedis
        ? []
        : [
            {
              id: "info",
              label: t("连接信息"),
              onSelect: () => showConnectionInfo(profile.id),
            },
          ]),
      // Redis 没有 SQL 查询与库/表目录：新建查询、新建库、刷新库列表只对 SQL 引擎出现。
      ...(isRedis
        ? []
        : [
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
              id: "new-database",
              label: t("新建数据库"),
              onSelect: () => {
                open(profile);
                setSchemaDialog({
                  mode: "create_database",
                  profileId: profile.id,
                  database: null,
                });
                if (!sessions[profile.id]) void ensureSession(profile.id);
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
          ]),
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

  /** 字段行右键：只读展示，改字段请到结构页。 */
  const fieldMenu = (
    profile: DatabaseProfile,
    database: string,
    table: string,
    column: DbTableColumn,
  ) => [
    {
      id: "copy-field-name",
      label: t("复制字段名"),
      onSelect: () => void copyText(column.name),
    },
    {
      id: "copy-field-type",
      label: t("复制字段类型"),
      onSelect: () => void copyText(column.column_type),
    },
    { separator: true as const },
    {
      id: "field-info",
      label: t("查看字段信息"),
      onSelect: () => {
        // 字段卡片挂在数据库标签上，先确保那个标签在。
        open(profile);
        showFieldCard({
          profileId: profile.id,
          database,
          table,
          column: column.name,
        });
      },
    },
  ];

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
        id: "new-table",
        label: t("新建表"),
        onSelect: () => {
          open(profile);
          void openDatabase(profile.id, database.name);
          setCreateTableTarget({
            profileId: profile.id,
            database: database.name,
          });
          if (!sessions[profile.id]) void ensureSession(profile.id);
        },
      },
      {
        id: "new-view",
        label: t("新建视图"),
        onSelect: () => {
          open(profile);
          void openDatabase(profile.id, database.name);
          setSchemaDialog({
            mode: "save_view",
            profileId: profile.id,
            database: database.name,
          });
          if (!sessions[profile.id]) void ensureSession(profile.id);
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
      {
        id: "drop-database",
        label: t("删除数据库"),
        danger: true,
        onSelect: () => {
          setSchemaDialog({
            mode: "drop_database",
            profileId: profile.id,
            database: database.name,
            name: database.name,
          });
          if (!sessions[profile.id]) void ensureSession(profile.id);
        },
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
              onClick={() => openNewConnectionTab()}
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

      <div ref={treeRef} data-tree-scroll className="min-h-0 flex-1 overflow-y-auto pb-3">
        {visibleProfiles.length === 0 && !loadingProfiles && (
          <EmptyState
            className="px-2.5 py-6"
            title={t("还没有数据库连接。点击右上角 + 新建一个 MySQL 连接。")}
          />
        )}

        {visibleProfiles.map((profile) => {
          const isRedis = profile.engine === "redis";
          const profileOpen = !!expandedProfiles[profile.id];
          const profileDatabases = databases[profile.id] ?? [];
          const profileLoading = loading[profile.id];
          const profileLoadError = errors[profile.id] ?? null;
          // Redis 的连接状态只认 statuses（它根本没有 SQL 会话）；
          // SQL 引擎保留会话兜底，避免状态回读慢时绿灯闪一下。
          const profileConnected = isRedis
            ? !!statuses[profile.id]?.connected
            : (statuses[profile.id]?.connected ?? !!sessions[profile.id]);
          // Redis 建连失败必须在树里看得见，不能只躺在 sessionErrors 里。
          const profileSessionError = isRedis
            ? (sessionErrors[profile.id] ?? null)
            : null;
          return (
            <div key={profile.id}>
              <ProfileRow
                profile={profile}
                expanded={profileOpen}
                connected={profileConnected}
                connecting={isRedis && !!redisConnecting[profile.id]}
                error={profileSessionError ?? profileLoadError}
                query={filter}
                selected={selectedKey === `conn:${profile.id}`}
                onSelect={() => setSelectedKey(`conn:${profile.id}`)}
                onToggle={() => void toggleProfile(profile.id)}
                onOpen={() => {
                  open(profile);
                  // Redis 标签整块是键浏览器：双击就是"打开并连接"。
                  if (isRedis) void redisConnect(profile.id);
                  else showConnectionInfo(profile.id);
                }}
                onEdit={() => setDialog({ mode: "edit", profile })}
                onDelete={() => setDeleteTarget(profile)}
                onRefresh={() => {
                  open(profile);
                  // Redis 没有库/表目录，"刷新"只回读连接状态。
                  if (isRedis) void refreshStatus(profile.id);
                  else void refreshDatabases(profile.id);
                }}
                onConnect={() => {
                  open(profile);
                  // Redis 只能走 db_redis_connect：db_connect 只接受 SQL 引擎。
                  if (isRedis) void redisConnect(profile.id);
                  else void ensureSession(profile.id);
                }}
                onDisconnect={() => setDisconnectTarget(profile)}
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
              {/* Redis 的库节点：standalone/sentinel 16 个，cluster 只有 db 0。
                  双击 = 打开连接标签并切到这个库（与工作区的库选择器同一份状态）。 */}
              {profileOpen &&
                isRedis &&
                redisDbIndexes(profile)
                  .filter((index) => {
                    const needle = filter.trim().toLowerCase();
                    return !needle || `db ${index}`.includes(needle);
                  })
                  .map((index) => {
                    const selectionKey = `redis-db:${profile.id}:${index}`;
                    const active =
                      (redisDbIndex[profile.id] ?? redisDefaultDb(profile)) === index;
                    const openDb = () => {
                      open(profile);
                      if (!profileConnected) void redisConnect(profile.id);
                      selectRedisDb(profile.id, index);
                    };
                    return (
                      <div
                        key={selectionKey}
                        className={cn(
                          "flex cursor-default items-center gap-1 rounded-[6px] py-1.5 pl-6 pr-2.5 text-12 hover:bg-surface-hover",
                          selectedKey === selectionKey && "bg-accent/10",
                          active ? "text-fg" : "text-fg-muted",
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedKey(selectionKey);
                          selectRedisDb(profile.id, index);
                        }}
                        onDoubleClick={openDb}
                        onContextMenu={menu.onContextMenu(() => [
                          {
                            id: "open",
                            label: t("打开 db {{index}}", { index }),
                            onSelect: openDb,
                          },
                          {
                            id: "copy",
                            label: t("复制库名"),
                            onSelect: () => void copyText(`db ${index}`),
                          },
                        ])}
                      >
                        <DatabaseIcon size={12} className="shrink-0 text-fg-subtle" />
                        <span className="min-w-0 flex-1 truncate">db {index}</span>
                        {active && (
                          <span className="shrink-0 text-9 text-accent" aria-label={t("当前库")}>
                            ●
                          </span>
                        )}
                      </div>
                    );
                  })}

              {/* Redis 建连失败：展开连接时把原话贴出来，而不是只留一个红三角。 */}
              {profileOpen && profileSessionError && (
                <ErrorRow
                  error={profileSessionError}
                  onRetry={() => void redisConnect(profile.id)}
                  onDismiss={() => clearSessionError(profile.id)}
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
                    const selectionKey = `db:${key}`;
                    // 双击数据库 = 连上 + 标记已打开 + 展开 + 打开对象列表。
                    const openDb = () => {
                      open(profile);
                      void ensureSession(profile.id);
                      void openDatabase(profile.id, database.name);
                      openDatabaseObjects({
                        profileId: profile.id,
                        connectionName: profile.name,
                        database: database.name,
                      });
                    };
                    return (
                      <div key={key}>
                        <div
                          className={cn(
                            "group flex cursor-default items-center gap-1 rounded-[6px] py-1.5 pr-2.5 hover:bg-surface-hover",
                            selectedKey === selectionKey &&
                              "bg-accent/10 ring-1 ring-inset ring-accent/20",
                          )}
                          style={indent(1)}
                          {...rowKeyboardProps({
                            expanded: dbOpen,
                            onToggle: () => void toggleDatabase(profile.id, database.name),
                            onSelect: () => setSelectedKey(selectionKey),
                            onOpen: openDb,
                          })}
                          onFocus={() => setSelectedKey(selectionKey)}
                          onClick={() => setSelectedKey(selectionKey)}
                          onDoubleClick={openDb}
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
                              // 箭头只控制展开，不把库标成"已打开"。
                              event.stopPropagation();
                              void toggleDatabase(profile.id, database.name);
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
                            <Highlight text={database.name} query={filter} />
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
                                    {...rowKeyboardProps({
                                      expanded: tableOpen,
                                      onToggle: () =>
                                        void toggleTable(
                                          profile.id,
                                          database.name,
                                          table.name,
                                        ),
                                      onSelect: () => setSelectedKey(tableKey),
                                      onOpen: () =>
                                        openTableItem(profile, database.name, table.name),
                                    })}
                                    onFocus={() => setSelectedKey(tableKey)}
                                    onClick={() => setSelectedKey(tableKey)}
                                    onDoubleClick={() =>
                                      openTableItem(profile, database.name, table.name)
                                    }
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
                                      <Highlight text={table.name} query={filter} />
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
                                          className="flex items-center gap-1 rounded-[6px] py-1.5 pr-2.5 text-12 text-fg-muted hover:bg-surface-hover"
                                          style={indent(4)}
                                          title={`${column.column_type}${column.nullable ? "" : " NOT NULL"}`}
                                          onContextMenu={(event) => {
                                            event.stopPropagation();
                                            menu.onContextMenu(() =>
                                              fieldMenu(
                                                profile,
                                                database.name,
                                                table.name,
                                                column,
                                              ),
                                            )(event);
                                          }}
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

      <SchemaChangeDialog
        target={schemaDialog}
        sessionId={
          schemaDialog
            ? (sessions[schemaDialog.profileId]?.session_id ?? null)
            : null
        }
        onClose={() => setSchemaDialog(null)}
        onApplied={() => undefined}
      />

      <CreateTableDialog
        target={createTableTarget}
        sessionId={
          createTableTarget
            ? (sessions[createTableTarget.profileId]?.session_id ?? null)
            : null
        }
        onClose={() => setCreateTableTarget(null)}
        onApplied={(table) => {
          if (!createTableTarget) return;
          openTable({
            profileId: createTableTarget.profileId,
            connectionName:
              profiles.find((entry) => entry.id === createTableTarget.profileId)
                ?.name ?? "",
            database: createTableTarget.database,
            table,
          });
        }}
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
          // 改过配置的 Redis 连接：Rust 侧运行时还握着旧主机/密码/TLS，
          // 不重建会继续连旧配置（db_redis_connect 只会复用运行时）。
          if (dialog?.mode === "edit" && saved.engine === "redis") {
            void redisReconnect(saved.id);
          }
        }}
      />
    </div>
  );
}
