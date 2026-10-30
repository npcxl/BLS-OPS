/**
 * 资产区：服务器 / 数据库 / 项目三类真实资产，可切换浏览与搜索。
 *
 * 每一行的操作都复用既有能力：
 * - 服务器：终端标签、收藏、编辑/删除（同服务器列表的右键菜单）；
 * - 数据库：打开既有数据库标签（连接由标签自己建立），没有收藏字段就不给收藏；
 * - 项目：打开该项目所属服务器的项目标签（项目本来就是"按服务器发现"的）。
 */
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  Copy,
  Database as DatabaseIcon,
  Loader2,
  Plus,
  RefreshCw,
  Stack3Icon,
  TriangleAlert,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { MacSearchField, MacSegmentedControl } from "@/components/ui/mac-controls";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import type { DatabaseProfile } from "@/api/types/database";
import type { ServerRecord } from "@/api/ops-api";
import { engineMeta } from "@/workbench/views/database/db-engines";
import { DbEngineIcon } from "@/workbench/views/database/DbEngineIcon";
import { ListPanel, SectionHeading, SectionLink } from "./section";
import { ServerHomeRow } from "./server-row";
import type { ProjectAsset } from "./use-project-assets";
import { relativeTime, timestampTitle } from "./utils";

export type AssetTabId = "servers" | "databases" | "projects";

export interface AssetsSectionProps {
  servers: ServerRecord[];
  profiles: DatabaseProfile[];
  /** 连接配置是否已成功读取；未读取时不给"0 个连接"这种假数字。 */
  profilesKnown: boolean;
  /** 读取连接配置失败的原因（有值时资产区显示失败说明，而不是一直转圈）。 */
  profilesError: string | null;
  /**
   * 每个连接的实时状态：`true` 已连接、`false` 明确未连接、缺键 = 还没读到
   * 运行时状态（此时不显示"未连接"，那是猜测）。
   */
  connectionStates: ReadonlyMap<string, boolean>;
  projects: ProjectAsset[];
  projectsLoading: boolean;
  projectsFailed: boolean;
  projectsError: string | null;
  onOpenServer: (server: ServerRecord) => void;
  onToggleFavorite: (server: ServerRecord) => void;
  onEditServer: (server: ServerRecord) => void;
  onDeleteServer: (server: ServerRecord) => void;
  onOpenDatabase: (profile: DatabaseProfile) => void;
  onNewConnection: () => void;
  onOpenProject: (project: ProjectAsset) => void;
  onReloadProjects: () => void;
  onAddServer: () => void;
  onManageServers: () => void;
  onManageDatabases: () => void;
  onManageProjects: () => void;
}

const SCAN_STATE_TONE: Record<string, string | null> = {
  active: null,
  missing: "text-warning",
  inaccessible: "text-danger",
  changed: "text-accent",
};

const SCAN_STATE_LABEL: Record<string, string | null> = {
  active: null,
  missing: "Not found this scan",
  inaccessible: "Server unreachable",
  changed: "Details changed",
};

export function AssetsSection({
  servers,
  profiles,
  profilesKnown,
  profilesError,
  connectionStates,
  projects,
  projectsLoading,
  projectsFailed,
  projectsError,
  onOpenServer,
  onToggleFavorite,
  onEditServer,
  onDeleteServer,
  onOpenDatabase,
  onNewConnection,
  onOpenProject,
  onReloadProjects,
  onAddServer,
  onManageServers,
  onManageDatabases,
  onManageProjects,
}: AssetsSectionProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<AssetTabId>("servers");
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const match = (value: string) => !needle || value.toLowerCase().includes(needle);

  const visibleServers = useMemo(
    () =>
      servers.filter(
        (server) =>
          match(server.name) ||
          match(server.host) ||
          match(server.username) ||
          server.tags.some((tag) => match(tag)),
      ),
    // `match` 依赖 needle，用 needle 作为依赖即可。
    [servers, needle],
  );

  const visibleProfiles = useMemo(
    () =>
      profiles.filter(
        (profile) =>
          match(profile.name) ||
          match(profile.host) ||
          match(profile.username) ||
          match(engineMeta(profile.engine).label),
      ),
    [profiles, needle],
  );

  const visibleProjects = useMemo(
    () => projects.filter((project) => match(project.name) || match(project.path) || match(project.serverName)),
    [projects, needle],
  );

  const counts: Record<AssetTabId, number> = {
    servers: servers.length,
    databases: profiles.length,
    projects: projects.length,
  };
  const visibleCounts: Record<AssetTabId, number> = {
    servers: visibleServers.length,
    databases: visibleProfiles.length,
    projects: visibleProjects.length,
  };

  const countsKnown: Record<AssetTabId, boolean> = {
    servers: true,
    databases: profilesKnown,
    projects: !projectsFailed,
  };

  const manage = () => {
    if (tab === "servers") onManageServers();
    else if (tab === "databases") onManageDatabases();
    else onManageProjects();
  };

  return (
    <section className="flex flex-col gap-2.5">
      <SectionHeading
        title={t("Assets")}
        count={countsKnown[tab] ? counts[tab] : undefined}
        actions={
          <span className="flex items-center gap-2">
            {tab === "servers" && (
              <Button variant="ghost" size="xs" className="h-6 px-2" onClick={onAddServer}>
                <Plus size={12} />
                {t("Add server")}
              </Button>
            )}
            <SectionLink label={t("Manage →")} onClick={manage} />
          </span>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <MacSegmentedControl
          value={tab}
          onChange={(value) => {
            setTab(value as AssetTabId);
            setQuery("");
          }}
          options={[
            { value: "servers", label: assetTabLabel(t("Servers"), counts.servers) },
            {
              value: "databases",
              label: assetTabLabel(t("Database"), countsKnown.databases ? counts.databases : undefined),
            },
            {
              value: "projects",
              label: assetTabLabel(t("Projects"), countsKnown.projects ? counts.projects : undefined),
            },
          ]}
        />
        <MacSearchField
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          placeholder={t(SEARCH_PLACEHOLDER[tab])}
          className="ml-auto w-56"
        />
        {tab === "databases" && (
          <Button variant="ghost" size="xs" onClick={onNewConnection}>
            <Plus size={12} />
            {t("新建连接")}
          </Button>
        )}
        {tab === "projects" && (
          <Button variant="ghost" size="xs" disabled={projectsLoading} onClick={onReloadProjects}>
            {projectsLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {t("Refresh")}
          </Button>
        )}
      </div>

      <ListPanel>
        {tab === "servers" &&
          (visibleServers.length === 0 ? (
            <EmptyRow
              text={needle ? t("No matching servers") : t("No servers yet")}
              hint={needle ? undefined : t("Add a server to start connecting and managing.")}
              action={
                needle ? undefined : (
                  <Button variant="ghost" size="xs" onClick={onAddServer}>
                    <Plus size={12} />
                    {t("Add server")}
                  </Button>
                )
              }
            />
          ) : (
            visibleServers.map((server) => (
              <ServerHomeRow
                key={server.id}
                server={server}
                onOpen={() => onOpenServer(server)}
                onToggleFavorite={() => onToggleFavorite(server)}
                onEdit={() => onEditServer(server)}
                onDelete={() => onDeleteServer(server)}
              />
            ))
          ))}

        {tab === "databases" &&
          (visibleProfiles.length === 0 ? (
            profilesError ? (
              <EmptyRow
                text={t("Could not read database connections")}
                hint={profilesError}
                action={
                  <Button variant="ghost" size="xs" onClick={onManageDatabases}>
                    {t("Manage connections")}
                  </Button>
                }
              />
            ) : profilesKnown ? (
              <EmptyRow
                text={
                  needle
                    ? t("No matching connections")
                    : t("还没有数据库连接。点击右上角 + 新建一个 MySQL 连接。")
                }
              />
            ) : (
              <div className="flex items-center justify-center gap-2 px-3 py-8 text-12 text-fg-subtle">
                <Loader2 size={13} className="animate-spin" />
                {t("Loading")}
              </div>
            )
          ) : (
            visibleProfiles.map((profile) => (
              <DatabaseRow
                key={profile.id}
                profile={profile}
                connected={connectionStates.get(profile.id)}
                onOpen={() => onOpenDatabase(profile)}
                onManage={onManageDatabases}
              />
            ))
          ))}

        {tab === "projects" &&
          (projectsFailed && projects.length === 0 ? (
            <EmptyRow
              text={t("Could not read confirmed projects")}
              hint={projectsError ?? undefined}
              action={
                <Button variant="ghost" size="xs" onClick={onReloadProjects}>
                  {t("Retry")}
                </Button>
              }
            />
          ) : projectsLoading && projects.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-12 text-fg-subtle">
              <Loader2 size={13} className="animate-spin" />
              {t("Loading")}
            </div>
          ) : visibleProjects.length === 0 ? (
            <EmptyRow
              text={needle ? t("No matching projects") : t("No confirmed projects yet")}
              hint={
                needle
                  ? undefined
                  : t("Confirm a project in the Projects module and it appears here.")
              }
            />
          ) : (
            visibleProjects.map((project) => (
              <ProjectRow
                key={project.key}
                project={project}
                onOpen={() => onOpenProject(project)}
              />
            ))
          ))}
      </ListPanel>

      {tab === "projects" && projectsFailed && projects.length > 0 && (
        <p className="flex items-center gap-1 text-11 text-warning">
          <TriangleAlert size={11} />
          {t("Some servers could not be read; the project count is incomplete.")}
        </p>
      )}

      {tab === "projects" && visibleCounts.projects > 0 && needle && (
        <p className="text-11 text-fg-subtle">
          {t("{{visible}} of {{total}} shown", {
            visible: visibleCounts.projects,
            total: counts.projects,
          })}
        </p>
      )}
    </section>
  );
}

const SEARCH_PLACEHOLDER: Record<AssetTabId, string> = {
  servers: "Search servers…",
  databases: "搜索连接…",
  projects: "Search projects…",
};

function assetTabLabel(label: string, count: number | undefined): string {
  return typeof count === "number" ? `${label} ${count}` : label;
}

function EmptyRow({ text, hint, action }: { text: string; hint?: string; action?: ReactNode }) {
  return (
    <EmptyState title={text} description={hint} action={action} className="min-h-28" />
  );
}

function DatabaseRow({
  profile,
  connected,
  onOpen,
  onManage,
}: {
  profile: DatabaseProfile;
  /** `undefined` = 运行时状态还没读到，不显示"未连接"。 */
  connected: boolean | undefined;
  onOpen: () => void;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const menu = useContextMenu();
  const address = `${profile.username}@${profile.host}:${profile.port}`;
  const meta = engineMeta(profile.engine);

  return (
    <div
      data-testid={`home-database-row-${profile.id}`}
      className="group flex h-11 w-full items-center gap-2.5 px-3 transition-colors hover:bg-surface-hover/60"
      onContextMenu={menu.onContextMenu(() => [
        { id: "open", label: t("打开连接"), onSelect: onOpen },
        {
          id: "copy-address",
          label: t("Copy connection address"),
          icon: Copy,
          onSelect: () => void copyText(address),
        },
        { id: "sep-manage", separator: true },
        { id: "manage", label: t("Manage connections"), icon: DatabaseIcon, onSelect: onManage },
      ])}
    >
      <DbEngineIcon engine={profile.engine} connected={connected === true} size={16} />
      <button type="button" className="min-w-0 flex-1 truncate text-left text-13 text-fg" onClick={onOpen}>
        {profile.name}
        <span className="ml-2 text-11 text-fg-subtle">{address}</span>
      </button>
      <span className="hidden shrink-0 text-11 text-fg-subtle md:inline">{meta.label}</span>
      {connected === true ? (
        <span className="flex shrink-0 items-center gap-1 text-10 text-success">
          <span className="h-1 w-1 rounded-full bg-current" />
          {t("Connected")}
        </span>
      ) : connected === false ? (
        <span className="shrink-0 text-10 text-fg-subtle">{t("Disconnected")}</span>
      ) : null}
      {profile.updated_at ? (
        <span
          className="hidden shrink-0 text-11 text-fg-subtle lg:inline"
          title={timestampTitle(profile.updated_at)}
        >
          {t("Edited {{time}}", { time: relativeTime(profile.updated_at, t) })}
        </span>
      ) : null}
      <ContextMenu {...menu.props} title={profile.name} />
    </div>
  );
}

function ProjectRow({ project, onOpen }: { project: ProjectAsset; onOpen: () => void }) {
  const { t } = useTranslation();
  const tone = SCAN_STATE_TONE[project.scanState];
  const label = SCAN_STATE_LABEL[project.scanState];

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`home-project-row-${project.key}`}
      className="group flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover/60"
      title={project.path}
    >
      <Stack3Icon size={14} className="shrink-0 text-fg-subtle" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-13 text-fg">{project.name}</span>
          {label && (
            <span className={cn("shrink-0 text-10", tone)}>{t(label)}</span>
          )}
        </span>
        <span className="min-w-0 truncate font-mono text-11 text-fg-subtle">{project.path}</span>
      </span>
      <span className="max-w-[160px] shrink-0 truncate text-11 text-fg-subtle">{project.serverName}</span>
      <ChevronRight size={13} className="shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
