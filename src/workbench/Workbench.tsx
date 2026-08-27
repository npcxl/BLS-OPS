import { useMemo } from "react";
import { SHELL_TELEMETRY } from "@/app/app-meta";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { AppTopBar } from "./AppTopBar";
import { NavigationRail } from "./NavigationRail";
import { ContextSidebar } from "./ContextSidebar";
import { Workspace } from "./Workspace";
import { StatusBar } from "./StatusBar";
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

  const actions = useMemo<PaletteAction[]>(
    () => [
      {
        id: "connect-api-01",
        title: "连接 API-01",
        category: "终端",
        description: "在 10.0.0.11 上打开终端会话",
        shortcut: "回车",
        keywords: ["服务器", "终端", "连接"],
        onSelect: () => openTab({ id: crypto.randomUUID(), type: "terminal", title: "API-01", subtitle: "10.0.0.11", connected: true }),
      },
      {
        id: "open-ne-web",
        title: "打开 WEB 会话",
        category: "终端",
        description: "打开 WEB 会话",
        onSelect: () => openTab({ id: crypto.randomUUID(), type: "terminal", title: "WEB-01", subtitle: "10.0.0.21", connected: true }),
      },
      {
        id: "open-docker",
        title: "打开容器",
        category: "工作区",
        description: "切换到容器模块",
        onSelect: () => setModule("docker"),
      },
      {
        id: "ask-ai",
        title: "智能助手",
        category: "智能助手",
        description: "打开智能助手面板",
        onSelect: () => setModule("ai"),
      },
      {
        id: "quick-connect",
        title: "快速连接",
        category: "终端",
        description: "聚焦到快速连接输入框",
        onSelect: () => setModule("ssh"),
      },
    ],
    [openTab, setModule],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-app text-fg">
      <AppTopBar />
      <div className="flex min-h-0 flex-1">
        <NavigationRail />
        <ContextSidebar />
        <Workspace />
      </div>
      <StatusBar
        connectedSessions={SHELL_TELEMETRY.connectedSessions}
        runningTasks={SHELL_TELEMETRY.runningTasks}
        transferDown={SHELL_TELEMETRY.transferDown}
        transferUp={SHELL_TELEMETRY.transferUp}
        aiReady={SHELL_TELEMETRY.aiReady}
      />
      <CommandPalette open={commandPaletteOpen} actions={actions} onClose={() => setCommandPaletteOpen(false)} />
    </div>
  );
}
