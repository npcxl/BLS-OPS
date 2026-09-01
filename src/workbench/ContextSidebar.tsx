import { useCallback, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";
import { SshContextSidebar } from "./ssh-context-sidebar";

const MODULE_TITLES: Record<string, string> = {
  ssh: "终端",
  servers: "服务器",
};

/**
 * Context Sidebar — left panel for the 终端/服务器 modules (server list).
 * Other modules render as centered ModulePage tabs instead, so this returns
 * null when they are active.
 */
export function ContextSidebar() {
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

  if (activeModule !== "ssh" && activeModule !== "servers") return null;

  if (collapsed) {
    return <div className="w-0 shrink-0" aria-hidden="true" />;
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface-1/60 backdrop-blur-xl"
      style={{ width }}
      aria-label={MODULE_TITLES[activeModule]}
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
