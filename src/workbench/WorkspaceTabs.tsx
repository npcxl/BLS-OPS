import { useEffect, useRef } from "react";
import {
  Activity,
  House,
  Plus,
  Rows2,
  Columns2,
  Server,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  CommandCenterIcon,
  FileDescriptionIcon,
  GearIcon,
  RocketIcon,
  SparklesIcon,
  Stack3Icon,
  TerminalIcon,
  UnorderedListIcon,
  WorldIcon,
} from "@/components/its-hover";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";
import type { NavModule, WorkbenchPane, WorkspaceTab, WorkspaceTabType } from "@/workbench/types";

/** 页签图标 = 左侧菜单同一套（its-hover），保证"页签和菜单图标一致"。 */
type TabIcon = LucideIcon | typeof TerminalIcon;

const MODULE_ICONS: Record<NavModule, TabIcon> = {
  ssh: TerminalIcon,
  servers: Server,
  services: WorldIcon,
  logs: FileDescriptionIcon,
  projects: Stack3Icon,
  commands: CommandCenterIcon,
  deploy: RocketIcon,
  tasks: UnorderedListIcon,
  ai: SparklesIcon,
  settings: GearIcon,
};

function tabIcon(tab: WorkspaceTab): TabIcon {
  const byType: Partial<Record<WorkspaceTabType, TabIcon>> = {
    home: House,
    terminal: TerminalIcon,
    server: Server,
    // 监控不在左侧菜单里，用 lucide Activity。
    monitor: Activity,
    service: WorldIcon,
    logs: FileDescriptionIcon,
    project: Stack3Icon,
    command_center: CommandCenterIcon,
    workflow: UnorderedListIcon,
    deployment: RocketIcon,
  };
  if (tab.type === "module") {
    return tab.module ? MODULE_ICONS[tab.module] : GearIcon;
  }
  return byType[tab.type] ?? TerminalIcon;
}

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

  const menu = useContextMenu();
  const tabStripRef = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when a new tab is opened or the active pane changes.
  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const activeTab = strip.querySelector<HTMLElement>('[aria-selected="true"]');
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pane.activeTabId, pane.tabs.length]);

  // Translate vertical wheel / trackpad horizontal gesture into horizontal
  // scroll so the strip scrolls even when its scrollbar is intentionally hidden.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    // Trackpads emit deltaX for sideways swipes; mouse wheels emit deltaY.
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta === 0) return;
    e.preventDefault();
    el.scrollLeft += delta;
  };

  // Drag-to-scroll: grab the strip and fling it sideways. Uses document-level
  // listeners (NOT setPointerCapture, which would hijack the whole pointer
  // route and can leave the terminal unable to receive focus/keystrokes).
  const dragRef = useRef<{ el: HTMLDivElement; startX: number; startLeft: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    dragRef.current = { el, startX: e.clientX, startLeft: el.scrollLeft, moved: false };
  };
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) > 2) drag.moved = true;
      drag.el.scrollLeft = drag.startLeft - dx;
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      const moved = drag.moved;
      dragRef.current = null;
      // Suppress the click that follows a drag so we don't switch tabs.
      if (moved) {
        const target = drag.el;
        const swallow = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
          target.removeEventListener("click", swallow, true);
        };
        target.addEventListener("click", swallow, true);
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, []);

  const tabMenu = (tab: WorkspaceTab) =>
    menu.onContextMenu(() => [
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
    ]);

  return (
    <div className="flex h-[38px] shrink-0 items-center gap-1.5 border-b border-line bg-transparent px-2">
      <div
        ref={tabStripRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-1 overflow-x-auto overscroll-x-contain active:cursor-grabbing [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {pane.tabs.map((tab) => {
          const active = tab.id === pane.activeTabId;
          const Icon = tabIcon(tab);
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              className={cn(
                "group relative flex h-[26px] max-w-[200px] shrink-0 cursor-default items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] select-none transition-colors duration-100",
                active
                  ? "bg-surface-active text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.55),0_1px_2px_rgb(15_23_42/0.06)]"
                  : "text-fg-muted hover:bg-surface-hover hover:text-fg",
              )}
              onClick={() => setActiveTab(pane.id, tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(pane.id, tab.id);
              }}
              onContextMenu={tabMenu(tab)}
            >
              <Icon size={11} className="shrink-0 opacity-80" />
              <span className="truncate">{tab.title}</span>
              <button
                type="button"
                aria-label={`关闭 ${tab.title}`}
                className={cn(
                  "ml-0.5 shrink-0 rounded-[4px] p-0.5 text-fg-subtle hover:bg-surface-hover hover:text-fg",
                  active ? "opacity-70 group-hover:opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
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
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-fg-subtle hover:bg-surface-hover hover:text-fg"
        onClick={() => openTab({ id: crypto.randomUUID(), type: "terminal", title: "New Terminal" })}
      >
        <Plus size={14} />
      </button>

      <ContextMenu {...menu.props} />
    </div>
  );
}
