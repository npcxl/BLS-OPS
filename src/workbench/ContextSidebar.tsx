import { useCallback, useRef, useState } from "react";
import { ChevronsLeft, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { NavModule } from "@/workbench/types";
import { cn } from "@/lib/cn";

import { SshContextSidebar } from "./ssh-context-sidebar";
import { ModulePlaceholderSidebar } from "./module-placeholder";

const MODULE_TITLES: Record<NavModule, string> = {
  ssh: "SSH",
  servers: "Servers",
  files: "Files",
  projects: "Projects",
  deploy: "Deploy",
  docker: "Docker",
  nginx: "Nginx",
  tasks: "Tasks",
  ai: "AI",
  settings: "Settings",
};

/**
 * Context Sidebar — spec §8, §9.
 * 244px default, resizable (180–400px), collapsible.
 * Content is dynamic per active Navigation module.
 */
export function ContextSidebar() {
  const activeModule = useWorkbenchStore((s) => s.activeModule);
  const collapsed = useWorkbenchStore((s) => s.sidebarCollapsed);
  const width = useWorkbenchStore((s) => s.sidebarWidth);
  const setWidth = useWorkbenchStore((s) => s.setSidebarWidth);
  const setCollapsed = useWorkbenchStore((s) => s.setSidebarCollapsed);

  const dragRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = true;
      setDragging(true);

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        setWidth(Math.min(400, Math.max(180, ev.clientX - 48)));
      };
      const onUp = () => {
        dragRef.current = false;
        setDragging(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setWidth],
  );

  const renderModuleContent = () => {
    if (activeModule === "ssh") return <SshContextSidebar />;
    return <ModulePlaceholderSidebar module={activeModule} />;
  };

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface-1 transition-[width] duration-150",
        collapsed && "w-0 border-r-0",
      )}
      style={{ width: collapsed ? 0 : width }}
      aria-hidden={collapsed}
    >
      {!collapsed && (
        <>
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-2.5">
            <h2 className="text-12 font-semibold tracking-wide text-fg">{MODULE_TITLES[activeModule]}</h2>
            <Button variant="ghost" size="xs" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar">
              <ChevronsLeft size={14} />
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">{renderModuleContent()}</div>

          {/* resize handle */}
          <div
            className={cn(
              "absolute right-0 top-0 flex h-full w-[5px] cursor-col-resize items-center justify-center",
              dragging ? "bg-accent/25" : "hover:bg-accent/15",
            )}
            onMouseDown={onResizeStart}
            onDoubleClick={() => setWidth(244)}
          >
            <GripVertical size={12} className="text-fg-subtle" />
          </div>
        </>
      )}
    </aside>
  );
}
