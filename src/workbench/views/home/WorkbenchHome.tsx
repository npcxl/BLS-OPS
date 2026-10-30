/**
 * 工作台首页 —— 服务器 / 数据库 / 项目三类资产的统一入口。
 *
 * 数据边界（全部来自既有 Store 或本地 SQLite，页面挂载时零远端请求）：
 * - 服务器资产 / 会话历史：`useDomainStore`（SQLite）；
 * - 实时 SSH 会话数：`useSessionStore`（当前工作区的会话注册表）；
 * - 数据库连接与实时状态：`useDatabaseStore` 的 `profiles` / `sessions` / `statuses`
 *   （`statuses` 来自 Rust 运行时状态，只读，不建连）；
 * - 最近查询：`db_history_list`（本地 SQLite，按 created_at 倒序）；
 * - 项目资产：`confirmed_projects_list`（按服务器读取本地已确认项目）。
 *
 * 所有入口都走既有导航：`openModuleTab` / `openModuleTabForServer` /
 * `openDatabaseTab` / `openOrFocusServerTab`。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Database as DatabaseIcon,
  FileDescriptionIcon,
  PlugZap,
  Server as ServerIcon,
  Stack3Icon,
  Terminal as TerminalIcon,
  WorldIcon,
} from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { DatabaseProfile } from "@/api/types/database";
import type { ServerRecord } from "@/api/ops-api";
import { emptyServer, useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useDatabaseStore } from "@/stores/database-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { ServerForm } from "@/workbench/server-list";
import { AssetsSection } from "./assets";
import { FavoritesSection } from "./favorites";
import { OverviewSection, type OverviewStat } from "./overview";
import { QuickActions, type QuickAction } from "./quick-actions";
import { QuickConnectDialog, type QuickConnectAuth, type QuickConnectTarget } from "./quick-connect";
import { RecentSection, type RecentDatabaseItem, type RecentServerItem } from "./recent";
import { SectionHeading } from "./section";
import { useDatabaseActivity } from "./use-database-activity";
import { useProjectAssets } from "./use-project-assets";

export function WorkbenchHome() {
  const { t } = useTranslation();
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServerRecord | null>(null);

  const servers = useDomainStore((s) => s.servers);
  const groups = useDomainStore((s) => s.groups);
  const history = useDomainStore((s) => s.sessions);
  const domainLoading = useDomainStore((s) => s.loading);
  const domainError = useDomainStore((s) => s.error);
  const deleteServer = useDomainStore((s) => s.deleteServer);
  const setFavorite = useDomainStore((s) => s.setFavorite);

  const liveSessions = useSessionStore((s) => s.sessions);

  const profiles = useDatabaseStore((s) => s.profiles);
  const dbSessions = useDatabaseStore((s) => s.sessions);
  const dbStatuses = useDatabaseStore((s) => s.statuses);
  const dbSessionErrors = useDatabaseStore((s) => s.sessionErrors);

  const openTab = useWorkbenchStore((s) => s.openTab);
  const openOrFocusServerTab = useWorkbenchStore((s) => s.openOrFocusServerTab);
  const openModuleTab = useWorkbenchStore((s) => s.openModuleTab);
  const openModuleTabForServer = useWorkbenchStore((s) => s.openModuleTabForServer);
  const openDatabaseTab = useWorkbenchStore((s) => s.openDatabaseTab);
  const openNewConnectionTab = useWorkbenchStore((s) => s.openNewConnectionTab);

  const projectAssets = useProjectAssets(servers);
  const databaseActivity = useDatabaseActivity(profiles);

  const favorites = useMemo(() => servers.filter((server) => server.favorite), [servers]);

  /**
   * 实时连接状态：SQL 会话存在，或 Rust 运行时报告 connected（Redis 只走后者）。
   * 两者都没有记录的连接不写入（= 未知），避免把"没读到"显示成"未连接"。
   */
  const connectionStates = useMemo(() => {
    const states = new Map<string, boolean>();
    for (const profile of profiles) {
      if (dbSessions[profile.id]) states.set(profile.id, true);
      else if (dbStatuses[profile.id]) states.set(profile.id, dbStatuses[profile.id].connected);
    }
    return states;
  }, [profiles, dbSessions, dbStatuses]);

  const connectedCount = [...connectionStates.values()].filter(Boolean).length;

  const live = Object.values(liveSessions);
  const liveConnected = live.filter((session) => session.status === "connected").length;
  const liveConnecting = live.filter((session) => session.status === "connecting").length;
  const liveFailed = live.filter((session) => session.status === "error").length;
  const dbFailed = Object.values(dbSessionErrors).filter(Boolean).length;

  const recentServers = useMemo<RecentServerItem[]>(() => {
    const seen = new Set<string>();
    const items: RecentServerItem[] = [];
    for (const session of history) {
      if (!session.server_id || seen.has(session.server_id)) continue;
      seen.add(session.server_id);
      items.push({
        key: session.id,
        serverId: session.server_id,
        name: session.server_name,
        username: session.username,
        host: session.server_host,
        port: session.server_port,
        at: session.connected_at ?? session.disconnected_at ?? null,
      });
      if (items.length === 5) break;
    }
    return items;
  }, [history]);

  const recentDatabases = useMemo<RecentDatabaseItem[]>(() => {
    const items: RecentDatabaseItem[] = [];
    for (const entry of databaseActivity.recent) {
      const profile = profiles.find((item) => item.id === entry.profileId);
      if (!profile) continue;
      items.push({
        key: profile.id,
        profileId: profile.id,
        name: profile.name,
        target: `${profile.username}@${profile.host}:${profile.port}`,
        at: entry.at,
        sql: entry.sql,
        connected: connectionStates.get(profile.id) === true,
      });
      if (items.length === 5) break;
    }
    return items;
  }, [databaseActivity.recent, profiles, connectionStates]);

  const serversKnown = servers.length > 0 || (!domainLoading && !domainError);
  const projectsKnown = !projectAssets.loading && !projectAssets.failed;
  const serversWithProjects = new Set(projectAssets.projects.map((project) => project.serverId)).size;

  const openServer = (server: Pick<ServerRecord, "id" | "name" | "host" | "port">) =>
    openOrFocusServerTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  const openDatabase = (profile: DatabaseProfile) =>
    openDatabaseTab({
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
    });

  const connectQuick = (
    target: QuickConnectTarget,
    auth: QuickConnectAuth,
    saveAsServer: boolean,
  ) => {
    const { username, host, port } = target;
    const open = (serverId?: string) =>
      openTab({
        id: crypto.randomUUID(),
        type: "terminal",
        title: serverId ? (servers.find((server) => server.id === serverId)?.name ?? host) : host,
        subtitle: `${host}:${port}`,
        serverId,
        quickTarget: serverId ? undefined : `${username}@${host}:${port}`,
        credentialId: auth.credentialId,
        oneTimePassword: auth.password,
        sessionId: crypto.randomUUID(),
      });

    if (saveAsServer) {
      void useDomainStore
        .getState()
        .saveServer({ ...emptyServer(), name: host, host, port, username, credential_id: auth.credentialId ?? null })
        .then((saved) => open(saved.id))
        .catch(() => open());
    } else {
      open();
    }
    setQuickConnectOpen(false);
  };

  const overview: OverviewStat[] = [
    {
      id: "servers",
      label: t("Servers"),
      value: serversKnown ? String(servers.length) : "—",
      icon: ServerIcon,
      hint: t("{{count}} favorites · {{groups}} groups", { count: favorites.length, groups: groups.length }),
      onOpen: () => openModuleTab("ssh"),
    },
    {
      id: "sessions",
      label: t("Live sessions"),
      value: String(liveConnected),
      icon: TerminalIcon,
      live: true,
      hint: liveConnecting > 0 ? t("{{count}} connecting", { count: liveConnecting }) : t("Counted from open tabs"),
      alert: liveFailed > 0 ? t("{{count}} sessions failed", { count: liveFailed }) : null,
      onOpen: () => openModuleTab("ssh"),
    },
    {
      id: "databases",
      label: t("Database connections"),
      value: databaseActivity.profilesReady ? String(profiles.length) : "—",
      icon: DatabaseIcon,
      hint: t("{{count}} connected now", { count: connectedCount }),
      alert:
        databaseActivity.profilesError !== null
          ? t("Could not read database connections")
          : dbFailed > 0
            ? t("{{count}} connections failed", { count: dbFailed })
            : null,
      onOpen: () => openModuleTab("database"),
    },
    {
      id: "projects",
      label: t("Project assets"),
      value: projectsKnown ? String(projectAssets.projects.length) : "—",
      icon: Stack3Icon,
      hint: t("{{count}} servers · confirmed", { count: serversWithProjects }),
      alert: projectAssets.failed ? t("Some servers could not be read") : null,
      onOpen: () => openModuleTab("projects"),
    },
  ];

  const quickActions: QuickAction[] = [
    {
      id: "quick-connect",
      label: t("Quick connect"),
      hint: t("Connect once without saving a server"),
      icon: PlugZap,
      onSelect: () => setQuickConnectOpen(true),
    },
    {
      id: "terminal",
      label: t("Terminal"),
      hint: t("Server list and live sessions"),
      icon: TerminalIcon,
      onSelect: () => openModuleTab("ssh"),
    },
    {
      id: "database",
      label: t("Database"),
      hint: t("Open connections and queries"),
      icon: DatabaseIcon,
      onSelect: () => openModuleTab("database"),
    },
    {
      id: "projects",
      label: t("Projects"),
      hint: t("Discover projects on a server"),
      icon: Stack3Icon,
      onSelect: () => openModuleTab("projects"),
    },
    {
      id: "services",
      label: t("Services"),
      hint: t("systemd services: start, stop, restart, enable"),
      icon: WorldIcon,
      onSelect: () => openModuleTab("services"),
    },
    {
      id: "logs",
      label: t("Logs"),
      hint: t("journalctl log query and filtering"),
      icon: FileDescriptionIcon,
      onSelect: () => openModuleTab("logs"),
    },
  ];

  return (
    <div className="h-full overflow-y-auto bg-surface-1" data-selectable>
      <div className="mx-auto flex max-w-[1000px] flex-col gap-6 p-7">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] text-fg">{t("Workbench")}</h1>
          <p className="mt-1 text-12 text-fg-muted">{t("Servers, databases and projects in one place")}</p>
        </div>

        <section className="flex flex-col gap-2.5">
          <SectionHeading
            title={t("Overview")}
            actions={
              <span className="hidden max-w-[62%] truncate text-11 text-fg-subtle md:block">
                {t("Live figures come from the current workspace; everything else is read from local data.")}
              </span>
            }
          />
          <OverviewSection stats={overview} liveLabel={t("Live")} />
        </section>

        <section className="flex flex-col gap-2.5">
          <SectionHeading title={t("Quick actions")} />
          <QuickActions actions={quickActions} />
        </section>

        <RecentSection
          servers={recentServers}
          databases={recentDatabases}
          databasesLoading={databaseActivity.loading}
          onOpenServer={(item) =>
            openServer({
              id: item.serverId,
              name: item.name,
              host: item.host,
              port: item.port,
            })
          }
          onOpenDatabase={(item) => {
            const profile = profiles.find((entry) => entry.id === item.profileId);
            if (profile) openDatabase(profile);
          }}
          onOpenProjects={() => openModuleTab("projects")}
        />

        <AssetsSection
          servers={servers}
          profiles={profiles}
          profilesKnown={databaseActivity.profilesReady}
          profilesError={databaseActivity.profilesError}
          connectionStates={connectionStates}
          projects={projectAssets.projects}
          projectsLoading={projectAssets.loading}
          projectsFailed={projectAssets.failed}
          projectsError={projectAssets.error}
          onOpenServer={openServer}
          onToggleFavorite={(server) => void setFavorite(server.id, !server.favorite)}
          onEditServer={setEditingServer}
          onDeleteServer={setDeleteTarget}
          onOpenDatabase={openDatabase}
          onNewConnection={openNewConnectionTab}
          onOpenProject={(project) => openModuleTabForServer("projects", project.serverId)}
          onReloadProjects={projectAssets.reload}
          onAddServer={() => setEditingServer(emptyServer())}
          onManageServers={() => openModuleTab("ssh")}
          onManageDatabases={() => openModuleTab("database")}
          onManageProjects={() => openModuleTab("projects")}
        />

        <FavoritesSection
          favorites={favorites}
          onOpen={openServer}
          onManage={() => openModuleTab("ssh")}
        />
      </div>

      {quickConnectOpen && (
        <QuickConnectDialog onClose={() => setQuickConnectOpen(false)} onConnect={connectQuick} />
      )}

      {editingServer && <ServerForm server={editingServer} onClose={() => setEditingServer(null)} />}

      {deleteTarget && (
        <ConfirmDialog
          open
          title={t("Delete server")}
          description={t(
            "Deleting \"{{name}}\" will also delete its sessions and command history. This action cannot be undone.",
            { name: deleteTarget.name },
          )}
          confirmLabel={t("Confirm delete")}
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void deleteServer(deleteTarget.id).then(() => setDeleteTarget(null))}
        />
      )}
    </div>
  );
}
