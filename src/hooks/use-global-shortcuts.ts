import { useEffect } from "react";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { useDomainStore } from "@/stores/domain-store";

/**
 * Global keyboard shortcuts — spec §26.
 *
 * Ctrl + K       Command Palette
 * Ctrl + Shift + P  Action Palette
 * Ctrl + T       New SSH Tab
 * Ctrl + Shift + T  Reopen Session
 * Ctrl + W       Close Tab
 * Ctrl + \        Split
 * Ctrl + J       AI Panel
 * Ctrl + B       Sidebar
 * Ctrl + `       Terminal
 */
export function useGlobalShortcuts() {
  const setCommandPaletteOpen = useWorkbenchStore((s) => s.setCommandPaletteOpen);
  const toggleSidebar = useWorkbenchStore((s) => s.toggleSidebar);
  const openTab = useWorkbenchStore((s) => s.openTab);
  const closeTab = useWorkbenchStore((s) => s.closeTab);
  const focusedPaneId = useWorkbenchStore((s) => s.focusedPaneId);
  const rootPane = useWorkbenchStore((s) => s.rootPane);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key === "k" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          setCommandPaletteOpen(true);
        }
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      if (ctrl && !shift && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }

      if (ctrl && shift && e.key === "P") {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }

      if (ctrl && !shift && e.key === "t") {
        e.preventDefault();
        openTab({ id: crypto.randomUUID(), type: "terminal", title: "新建终端" });
      }

      if (ctrl && shift && e.key === "T") {
        e.preventDefault();
        // Reopen the most recent session recorded in SQLite.
        const last = useDomainStore.getState().sessions.find((session) => session.server_id);
        if (!last) return;
        openTab({
          id: crypto.randomUUID(),
          type: "terminal",
          title: last.server_name,
          subtitle: `${last.server_host}:${last.server_port}`,
          serverId: last.server_id,
          sessionId: crypto.randomUUID(),
        });
      }

      if (ctrl && !shift && e.key === "w") {
        e.preventDefault();
        if (focusedPaneId) {
          const pane = findPane(rootPane, focusedPaneId);
          if (pane && pane.activeTabId) {
            closeTab(focusedPaneId, pane.activeTabId);
          }
        }
      }

      if (ctrl && !shift && e.key === "\\") {
        e.preventDefault();
        if (focusedPaneId) {
          useWorkbenchStore.getState().splitPane(focusedPaneId, "vertical");
        }
      }

      if (ctrl && !shift && e.key === "j") {
        e.preventDefault();
        useWorkbenchStore.getState().openModuleTab("ai");
      }

      if (ctrl && !shift && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }

      if (ctrl && !shift && e.key === "`") {
        e.preventDefault();
        openTab({ id: crypto.randomUUID(), type: "terminal", title: "终端" });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setCommandPaletteOpen, toggleSidebar, openTab, closeTab, focusedPaneId, rootPane]);
}

function findPane(root: any, id: string): any {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findPane(child, id);
    if (found) return found;
  }
  return null;
}
