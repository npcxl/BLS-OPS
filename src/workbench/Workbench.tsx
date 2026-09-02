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
import type { WorkspaceTabType } from "./types";

/** The P3 management modules, as command-palette entries. */
const MANAGE_KINDS: {
  id: string;
  label: string;
  tabType: WorkspaceTabType;
  description: string;
}[] = [
  { id: "service", label: "服务", tabType: "service", description: "systemd 服务：启动、停止、重启、自启" },
  { id: "logs", label: "日志", tabType: "logs", description: "journalctl 日志查询与过滤" },
];

/**
 * Workbench shell — spec §6.
 */
export function Workbench() {
  useGlobalShortcuts();

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
      title: `连接 ${server.name}`,
      category: "终端",
      description: `${server.username}@${server.host}:${server.port}`,
      keywords: ["连接", server.host, server.username, ...server.tags],
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
      title: `监控 ${server.name}`,
      category: "监控",
      description: `只读指标：CPU、内存、磁盘、网络、进程`,
      keywords: ["监控", "monitor", server.host, server.name],
      onSelect: () =>
        openTab({
          id: crypto.randomUUID(),
          type: "monitor",
          title: `${server.name} · 监控`,
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
        title: `${kind.label} ${server.name}`,
        category: kind.label,
        description: kind.description,
        keywords: [kind.label, kind.id, server.host, server.name],
        onSelect: () =>
          openTab({
            id: crypto.randomUUID(),
            type: kind.tabType,
            title: `${server.name} · ${kind.label}`,
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
        title: `重新连接 ${session.server_name}`,
        category: "最近会话",
        description: `${session.username}@${session.server_host}:${session.server_port}`,
        keywords: ["最近", session.server_host],
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
        title: "管理凭据",
        category: "设置",
        description: "打开凭据与已知主机",
        onSelect: () => openModuleTab("settings"),
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
  }, [openTab, openModuleTab, servers, sessions]);

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
