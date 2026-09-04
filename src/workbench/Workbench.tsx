import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { useDomainStore } from "@/stores/domain-store";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { AppTopBar } from "./AppTopBar";
import { NavigationRail } from "./NavigationRail";
import { ContextSidebar } from "./ContextSidebar";
import { Workspace } from "./Workspace";
import { HostKeyDialog } from "./host-key-dialog";
import { CommandPalette, type PaletteAction } from "./command-palette";
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
  const { t } = useTranslation();

  const openTab = useWorkbenchStore((s) => s.openTab);
  const openOrFocusServerTab = useWorkbenchStore((s) => s.openOrFocusServerTab);
  const openModuleTab = useWorkbenchStore((s) => s.openModuleTab);
  const setCommandPaletteOpen = useWorkbenchStore((s) => s.setCommandPaletteOpen);
  const commandPaletteOpen = useWorkbenchStore((s) => s.commandPaletteOpen);

  const refreshAll = useDomainStore((s) => s.refreshAll);
  const servers = useDomainStore((s) => s.servers);
  const sessions = useDomainStore((s) => s.sessions);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

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

    return [
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
  }, [openTab, openModuleTab, servers, sessions, t]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app text-fg">
      <AppTopBar />
      <div className="flex min-h-0 flex-1">
        <NavigationRail />
        <ContextSidebar />
        <Workspace />
      </div>
      <CommandPalette open={commandPaletteOpen} actions={actions} onClose={() => setCommandPaletteOpen(false)} />
      <HostKeyDialog />
    </div>
  );
}
