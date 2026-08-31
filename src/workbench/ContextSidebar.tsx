import { useCallback, useRef, useState } from "react";
import { ChevronsLeft, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { NavModule } from "@/workbench/types";
import { cn } from "@/lib/cn";

import { SshContextSidebar } from "./ssh-context-sidebar";
import { SettingsContextSidebar } from "./settings-context-sidebar.tsx";
import { ModulePlaceholderSidebar } from "./module-placeholder";

const MODULE_TITLES: Record<NavModule, string> = {
  ssh: "终端",
  servers: "服务器",
  files: "文件",
  projects: "项目",
  deploy: "部署",
  docker: "容器",
  nginx: "网关",
  tasks: "任务",
  ai: "智能助手",
  settings: "设置",
};

/**
 * Context Sidebar — resizable content panel for the active module.
 * Renders the module's list/detail content (servers, settings, …).
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
        setWidth(Math.min(400, Math.max(200, ev.clientX - 52)));
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
    if (activeModule === "ssh" || activeModule === "servers") return <SshContextSidebar />;
    if (activeModule === "settings") return <SettingsContextSidebar />;
    return <ModulePlaceholderSidebar module={activeModule} />;
  };

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-line bg-surface-1/60 pt-2 backdrop-blur-xl">
        <button
          type="button"
          aria-label="展开侧边栏"
          title="展开侧边栏"
          className="flex h-8 w-8 items-center justify-center rounded-[8px] text-fg-subtle hover:bg-surface-hover hover:text-fg"
          onClick={() => setCollapsed(false)}
        >
          <ChevronsLeft size={16} className="rotate-180" />
        </button>
      </div>
    );
  }

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface-1/60 backdrop-blur-xl transition-[width] duration-150",
        collapsed && "w-0 border-r-0",
      )}
      style={{ width: collapsed ? 0 : width }}
      aria-hidden={collapsed}
    >
      {!collapsed && (
        <>
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-line/70 px-2.5">
            <h2 className="truncate text-12 font-semibold text-fg">{MODULE_TITLES[activeModule]}</h2>
            <Button variant="ghost" size="xs" className="h-6 w-6 px-0" onClick={() => setCollapsed(true)} aria-label="收起侧边栏">
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
            onDoubleClick={() => setWidth(280)}
          >
            <GripVertical size={12} className="text-fg-subtle" />
          </div>
        </>
      )}
    </aside>
  );
}
