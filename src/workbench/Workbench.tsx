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
        title: "Connect API-01",
        category: "SSH",
        description: "Open a terminal session on 10.0.0.11",
        shortcut: "Enter",
        keywords: ["server", "ssh", "terminal"],
        onSelect: () => openTab({ id: crypto.randomUUID(), type: "terminal", title: "API-01", subtitle: "10.0.0.11", connected: true }),
      },
      {
        id: "open-ne-web",
        title: "Open NE Web",
        category: "SSH",
        description: "Open the web session",
        onSelect: () => openTab({ id: crypto.randomUUID(), type: "terminal", title: "WEB-01", subtitle: "10.0.0.21", connected: true }),
      },
      {
        id: "open-docker",
        title: "Open Docker",
        category: "Workspace",
        description: "Switch to Docker module",
        onSelect: () => setModule("docker"),
      },
      {
        id: "ask-ai",
        title: "Ask AI",
        category: "AI",
        description: "Open the AI context panel",
        onSelect: () => setModule("ai"),
      },
      {
        id: "quick-connect",
        title: "Quick Connect",
        category: "SSH",
        description: "Focus the quick connect field",
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
