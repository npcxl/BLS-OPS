import { useState } from "react";
import { Columns2, Plus, Rows2, X } from "lucide-react";
import { ContextMenu, type ContextMenuState, contextMenuStateAt } from "@/components/ui/context-menu";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkbenchPane, WorkspaceTab } from "@/workbench/types";
import { cn } from "@/lib/cn";

/**
 * Per-pane tab strip — spec §10, §12.
 */
export function WorkspaceTabs({ pane }: { pane: WorkbenchPane }) {
  const setActiveTab = useWorkbenchStore((s) => s.setActiveTab);
  const closeTab = useWorkbenchStore((s) => s.closeTab);
  const closeOtherTabs = useWorkbenchStore((s) => s.closeOtherTabs);
  const closeAllTabs = useWorkbenchStore((s) => s.closeAllTabs);
  const splitPane = useWorkbenchStore((s) => s.splitPane);
  const openTab = useWorkbenchStore((s) => s.openTab);

  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const openTabMenu = (e: React.MouseEvent, tab: WorkspaceTab) => {
    e.preventDefault();
    setMenu(
      contextMenuStateAt(e, [
        { id: "close", label: "关闭", onSelect: () => closeTab(pane.id, tab.id) },
        {
          id: "close-others",
          label: "关闭其他",
          disabled: pane.tabs.length <= 1,
          onSelect: () => closeOtherTabs(pane.id, tab.id),
        },
        {
          id: "close-all",
          label: "全部关闭",
          disabled: pane.tabs.length <= 1,
          onSelect: () => closeAllTabs(pane.id),
        },
        { id: "sep-1", separator: true },
        { id: "split-v", label: "垂直分栏", icon: Columns2, onSelect: () => splitPane(pane.id, "horizontal") },
        { id: "split-h", label: "水平分栏", icon: Rows2, onSelect: () => splitPane(pane.id, "vertical") },
      ]),
    );
  };

  return (
    <div className="flex h-[34px] shrink-0 items-stretch border-b border-line bg-surface-1">
      <div className="flex min-w-0 flex-1 items-stretch overflow-hidden">
        {pane.tabs.map((tab) => {
          const active = tab.id === pane.activeTabId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              className={cn(
                "group relative flex h-full max-w-[200px] shrink-0 cursor-default items-center gap-1.5 border-r border-line px-3 text-12 select-none",
                active ? "border-t-2 border-t-accent bg-app text-fg" : "border-t-2 border-t-transparent text-fg-muted hover:bg-surface-hover hover:text-fg",
              )}
              onClick={() => setActiveTab(pane.id, tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(pane.id, tab.id);
              }}
              onContextMenu={(e) => openTabMenu(e, tab)}
            >
              {tab.connected && <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-success" />}
              <span className="truncate">{tab.title}</span>
              <button
                type="button"
                aria-label={`关闭 ${tab.title}`}
                className="ml-0.5 shrink-0 rounded-[4px] p-0.5 text-fg-subtle opacity-0 hover:bg-surface-hover hover:text-fg group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(pane.id, tab.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="新建终端标签"
        className="flex w-[34px] shrink-0 items-center justify-center text-fg-subtle hover:bg-surface-hover hover:text-fg"
        onClick={() => openTab({ id: crypto.randomUUID(), type: "terminal", title: "New Terminal" })}
      >
        <Plus size={14} />
      </button>

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
