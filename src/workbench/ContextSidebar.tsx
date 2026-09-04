import { useCallback, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";
import { SshContextSidebar } from "./ssh-context-sidebar";
import { ModuleServerSidebar, hasContextSidebar, isServerListModule } from "./module-server-sidebar";

/** 值是 i18n key，渲染处 `t(...)`。 */
const MODULE_TITLES: Record<string, string> = {
  ssh: "Module: Terminal",
};

/**
 * Context Sidebar — left panel for the terminal module (server list).
 * Other modules render as centered ModulePage tabs instead, so this returns
 * null when they are active.
 */
export function ContextSidebar() {
  const { t } = useTranslation();
  const activeModule = useWorkbenchStore((s) => s.activeModule);
  const collapsed = useWorkbenchStore((s) => s.sidebarCollapsed);
  const width = useWorkbenchStore((s) => s.sidebarWidth);
  const setWidth = useWorkbenchStore((s) => s.setSidebarWidth);

  const dragRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = true;
      setDragging(true);

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        // 52 = NavigationRail width.
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

  // No rail for 设置 / 命令 / 部署 / … — the top bar reads the same predicate,
  // so it will not offer to expand a sidebar that was never here.
  if (!hasContextSidebar(activeModule)) return null;

  if (isServerListModule(activeModule)) {
    // Session-driven modules (日志 / 服务 / 项目) operate on a chosen server, so
    // the left rail shows the same server list as the terminal — same blur, header
    // buttons and rows — and clicking a server loads that module bound to it.
    if (collapsed) return <div className="w-0 shrink-0" aria-hidden="true" />;
    return (
      <aside
        className="relative flex shrink-0 flex-col overflow-hidden"
        style={{ width }}
        aria-label={t("{{module}} server list", { module: activeModule })}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ModuleServerSidebar module={activeModule} />
        </div>

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
      </aside>
    );
  }

  if (collapsed) {
    return <div className="w-0 shrink-0" aria-hidden="true" />;
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col overflow-hidden"
      style={{ width }}
      aria-label={t(MODULE_TITLES.ssh)}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SshContextSidebar />
      </div>

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
    </aside>
  );
}
