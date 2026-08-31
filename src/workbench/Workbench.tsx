import { useEffect, useMemo } from "react";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { useDomainStore } from "@/stores/domain-store";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { AppTopBar } from "./AppTopBar";
import { NavigationRail } from "./NavigationRail";
import { ContextSidebar } from "./ContextSidebar";
import { Workspace } from "./Workspace";
import { StatusBar } from "./StatusBar";
import { HostKeyDialog } from "./host-key-dialog";
import { CommandPalette, type PaletteAction } from "./command-palette";

/**
 * Workbench shell — spec §6.
 */
export function Workbench() {
  useGlobalShortcuts();

  const openTab = useWorkbenchStore((s) => s.openTab);
  const setModule = useWorkbenchStore((s) => s.setModule);
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
      title: `连接 ${server.name}`,
      category: "终端",
      description: `${server.username}@${server.host}:${server.port}`,
      keywords: ["连接", server.host, server.username, ...server.tags],
      onSelect: () =>
        openTab({
          id: crypto.randomUUID(),
          type: "terminal",
          title: server.name,
          subtitle: `${server.host}:${server.port}`,
          serverId: server.id,
          sessionId: crypto.randomUUID(),
          connected: false,
        }),
    }));

    const recentActions: PaletteAction[] = sessions
      .filter((session, index, all) => session.server_id && all.findIndex((s) => s.server_id === session.server_id) === index)
      .slice(0, 5)
      .map((session) => ({
        id: `recent-${session.id}`,
        title: `重新连接 ${session.server_name}`,
        category: "最近会话",
        description: `${session.username}@${session.server_host}:${session.server_port}`,
        keywords: ["最近", session.server_host],
        onSelect: () =>
          openTab({
            id: crypto.randomUUID(),
            type: "terminal",
            title: session.server_name,
            subtitle: `${session.server_host}:${session.server_port}`,
            serverId: session.server_id,
            sessionId: crypto.randomUUID(),
            connected: false,
          }),
      }));

    return [
      ...connectActions,
      ...recentActions,
      {
        id: "manage-servers",
        title: "管理服务器",
        category: "服务器",
        description: "打开服务器列表",
        onSelect: () => setModule("ssh"),
      },
      {
        id: "manage-credentials",
        title: "管理凭据",
        category: "设置",
        description: "打开凭据与已知主机",
        onSelect: () => setModule("settings"),
      },
      {
        id: "open-home",
        title: "回到首页",
        category: "工作区",
        description: "打开工作台首页",
        onSelect: () =>
          openTab({ id: crypto.randomUUID(), type: "home", title: "首页" }),
      },
    ];
  }, [openTab, servers, sessions, setModule]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app text-fg">
      <AppTopBar />
      <div className="flex min-h-0 flex-1">
        <NavigationRail />
        <ContextSidebar />
        <Workspace />
      </div>
      <StatusBar />
      <CommandPalette open={commandPaletteOpen} actions={actions} onClose={() => setCommandPaletteOpen(false)} />
      <HostKeyDialog />
    </div>
  );
}
