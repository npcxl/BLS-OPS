import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { useDomainStore } from "@/stores/domain-store";
import { tablesKey, useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
import { staleWorkbenchTabIds } from "./views/database/workspace-cleanup";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { useAutoUpdateCheck } from "@/hooks/use-updater";
import { UpdateNotification } from "./updater/UpdateNotification";
import { AppTopBar } from "./AppTopBar";
import { NavigationRail } from "./NavigationRail";
import { ContextSidebar } from "./ContextSidebar";
import { Workspace } from "./Workspace";
import { HostKeyDialog } from "./host-key-dialog";
import { CommandPalette, type PaletteAction } from "./command-palette";
import { ToastHost } from "@/components/ui/toast";
import type { WorkspaceTabType } from "./types";

/** The P3 management modules, as command-palette entries. label/description 存 i18n key。 */
const MANAGE_KINDS: {
  id: string;
  labelKey: string;
  tabType: WorkspaceTabType;
  descriptionKey: string;
}[] = [
  {
    id: "service",
    labelKey: "Services",
    tabType: "service",
    descriptionKey: "systemd services: start, stop, restart, enable",
  },
  {
    id: "logs",
    labelKey: "Logs",
    tabType: "logs",
    descriptionKey: "journalctl log query and filtering",
  },
];

/**
 * Workbench shell — spec §6.
 */
export function Workbench() {
  useGlobalShortcuts();
  // One delayed, once-per-launch update check for the whole app.
  useAutoUpdateCheck();
  const { t } = useTranslation();

  const openTab = useWorkbenchStore((s) => s.openTab);
  const openOrFocusServerTab = useWorkbenchStore((s) => s.openOrFocusServerTab);
  const openModuleTab = useWorkbenchStore((s) => s.openModuleTab);
  const setCommandPaletteOpen = useWorkbenchStore((s) => s.setCommandPaletteOpen);
  const commandPaletteOpen = useWorkbenchStore((s) => s.commandPaletteOpen);

  const refreshAll = useDomainStore((s) => s.refreshAll);
  const servers = useDomainStore((s) => s.servers);
  const sessions = useDomainStore((s) => s.sessions);
  const rootPane = useWorkbenchStore((s) => s.rootPane);

  // 命令面板里的数据库命令需要"当前连接 + 当前库"：取数据库标签的活动工作项。
  const dbProfiles = useDatabaseStore((s) => s.profiles);
  const dbTables = useDatabaseStore((s) => s.tables);
  const dbItems = useDatabaseWorkspaceStore((s) => s.items);
  const dbActiveId = useDatabaseWorkspaceStore((s) => s.activeId);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  /**
   * 关闭数据库标签时清理它拥有的资源：
   * 1. `dispose` → 释放仍在运行的查询（Rust 端会 KILL + 丢弃连接）；
   * 2. `pruneSessions` → 断开已经没有任何标签引用的连接。
   *
   * 切换标签不会触发断开：标签还在，连接就还在。
   */
  useEffect(() => {
    const tabs: { id: string; type: string; profileId?: string }[] = [];
    const walk = (pane: typeof rootPane) => {
      tabs.push(...pane.tabs);
      for (const child of pane.children ?? []) walk(child);
    };
    walk(rootPane);

    const dbTabs = tabs.filter((tab) => tab.type === "database");
    const activeProfiles = new Set(
      dbTabs
        .map((tab) => tab.profileId)
        .filter((id): id is string => !!id),
    );
    const workbench = useDatabaseWorkbenchStore.getState();
    const items = useDatabaseWorkspaceStore.getState().items;
    const stale = staleWorkbenchTabIds(
      Object.keys(workbench.tabs),
      items,
      activeProfiles,
    );
    // 只释放失去所属连接的工作项；切换标签不能误杀 SQL 工作项。
    for (const tabId of stale) workbench.dispose(tabId);
    void useDatabaseStore.getState().pruneSessions([...activeProfiles]);
  }, [rootPane]);

  const actions = useMemo<PaletteAction[]>(() => {
    const connectActions: PaletteAction[] = servers.map((server) => ({
      id: `connect-${server.id}`,
      title: t("Connect to {{name}}", { name: server.name }),
      category: t("Terminal"),
      description: `${server.username}@${server.host}:${server.port}`,
      keywords: ["connect", server.host, server.username, ...server.tags],
      onSelect: () =>
        openOrFocusServerTab({
          id: crypto.randomUUID(),
          type: "terminal",
          title: server.name,
          subtitle: `${server.host}:${server.port}`,
          serverId: server.id,
          sessionId: crypto.randomUUID(),
        }),
    }));

    // Read-only monitoring gets its own tab per server, keyed by tab id, so
    // each one keeps its own history and pause state.
    const monitorActions: PaletteAction[] = servers.map((server) => ({
      id: `monitor-${server.id}`,
      title: t("Monitor {{name}}", { name: server.name }),
      category: t("Monitor"),
      description: t("Read-only metrics: CPU, memory, disk, network, processes"),
      keywords: ["monitor", server.host, server.name],
      onSelect: () =>
        openTab({
          id: crypto.randomUUID(),
          type: "monitor",
          title: server.name,
          subtitle: `${server.host}:${server.port}`,
          serverId: server.id,
          sessionId: crypto.randomUUID(),
        }),
    }));

    // One entry per server × management module. Each opens its own
    // non-interactive session, so a module never shares a shell with a terminal.
    const managerActions: PaletteAction[] = servers.flatMap((server) =>
      MANAGE_KINDS.map((kind) => ({
        id: `${kind.id}-${server.id}`,
        title: t("{{label}} {{name}}", { label: t(kind.labelKey), name: server.name }),
        category: t(kind.labelKey),
        description: t(kind.descriptionKey),
        keywords: [kind.labelKey, kind.id, server.host, server.name],
        onSelect: () =>
          openTab({
            id: crypto.randomUUID(),
            type: kind.tabType,
            title: server.name,
            subtitle: `${server.host}:${server.port}`,
            serverId: server.id,
            sessionId: crypto.randomUUID(),
          }),
      })),
    );

    const recentActions: PaletteAction[] = sessions
      .filter((session, index, all) => session.server_id && all.findIndex((s) => s.server_id === session.server_id) === index)
      .slice(0, 5)
      .map((session) => ({
        id: `recent-${session.id}`,
        title: t("Reconnect {{name}}", { name: session.server_name }),
        category: t("Recent sessions"),
        description: `${session.username}@${session.server_host}:${session.server_port}`,
        keywords: ["recent", session.server_host],
        onSelect: () =>
          openOrFocusServerTab({
            id: crypto.randomUUID(),
            type: "terminal",
            title: session.server_name,
            subtitle: `${session.server_host}:${session.server_port}`,
            serverId: session.server_id,
            sessionId: crypto.randomUUID(),
          }),
      }));

    // 数据库命令：需要"当前连接 + 当前库"，因此只在数据库标签有活动工作项时出现。
    const databaseActions: PaletteAction[] = [];
    const activeDbItem = dbItems.find((item) => item.id === dbActiveId) ?? null;
    const dbProfile = activeDbItem
      ? dbProfiles.find((profile) => profile.id === activeDbItem.profileId) ?? null
      : null;
    if (activeDbItem?.database && dbProfile) {
      const context = {
        profileId: activeDbItem.profileId,
        connectionName: dbProfile.name,
        database: activeDbItem.database,
      };
      databaseActions.push(
        {
          id: "db-new-query",
          title: t("新建 SQL 查询（{{database}}）", { database: context.database }),
          category: t("Module: Database"),
          description: `${dbProfile.name} · ${context.database}`,
          keywords: ["sql", "query", "database", context.database, dbProfile.name],
          onSelect: () => useDatabaseWorkspaceStore.getState().newQuery(context),
        },
        {
          id: "db-refresh-tables",
          title: t("刷新表列表（{{database}}）", { database: context.database }),
          category: t("Module: Database"),
          description: `${dbProfile.name} · ${context.database}`,
          keywords: ["refresh", "tables", context.database, dbProfile.name],
          onSelect: () =>
            void useDatabaseStore
              .getState()
              .refreshTables(context.profileId, context.database),
        },
      );
      if (activeDbItem.objectName) {
        const table = activeDbItem.objectName;
        databaseActions.push({
          id: "db-open-structure",
          title: t("打开表结构（{{table}}）", { table }),
          category: t("Module: Database"),
          description: context.database,
          keywords: ["structure", "ddl", table, context.database],
          onSelect: () =>
            useDatabaseWorkspaceStore.getState().openStructure({ ...context, table }),
        });
      }
      const cachedTables = dbTables[tablesKey(context.profileId, context.database)] ?? [];
      for (const table of cachedTables.slice(0, 50)) {
        databaseActions.push({
          id: `db-open-table-${table.name}`,
          title: t("打开表数据（{{table}}）", { table: table.name }),
          category: t("Module: Database"),
          description: context.database,
          keywords: ["table", "data", table.name, context.database],
          onSelect: () =>
            useDatabaseWorkspaceStore
              .getState()
              .openTable({ ...context, table: table.name }),
        });
      }
    }

    return [
      ...databaseActions,
      ...connectActions,
      ...monitorActions,
      ...managerActions,
      ...recentActions,
      {
        id: "manage-credentials",
        title: t("Manage credentials"),
        category: t("Settings"),
        description: t("Open credentials and known hosts"),
        onSelect: () => openModuleTab("settings"),
      },
      {
        id: "open-home",
        title: t("Back to home"),
        category: t("Workspace"),
        description: t("Open the workbench home"),
        onSelect: () =>
          openTab({ id: crypto.randomUUID(), type: "home", title: t("Home") }),
      },
    ];
  }, [
    dbActiveId,
    dbItems,
    dbProfiles,
    dbTables,
    openTab,
    openModuleTab,
    servers,
    sessions,
    t,
  ]);

  // 外层外壳半透明磨砂；内层白卡片与命令面板保持实色（见 `.app-shell`）。
  return (
    <div className="app-shell flex h-full min-h-0 flex-col text-fg">
      <AppTopBar />
      <div className="flex min-h-0 flex-1">
        <NavigationRail />
        <ContextSidebar />
        <Workspace />
      </div>
      <CommandPalette open={commandPaletteOpen} actions={actions} onClose={() => setCommandPaletteOpen(false)} />
      <HostKeyDialog />
      <UpdateNotification />
      <ToastHost />
    </div>
  );
}
