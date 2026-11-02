import { useCallback, useRef, useState, type ReactNode } from "react";
import { GripVertical } from "@/components/icons";
import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";
import { SshContextSidebar } from "./ssh-context-sidebar";
import { ModuleServerSidebar, hasContextSidebar, isServerListModule } from "./module-server-sidebar";
import { DatabaseAssetSidebar } from "./views/database/DatabaseAssetSidebar";

/** 值是 i18n key，渲染处 `t(...)`。 */
const MODULE_TITLES: Record<string, string> = {
  ssh: "Module: Terminal",
};

/** 侧栏宽度与拖拽范围：一个手柄、一套键盘步长，服务器树与数据库树共用。 */
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
const RESET_WIDTH = 280;

function ResizeHandle({
  width,
  dragging,
  onResizeStart,
}: {
  width: number;
  dragging: boolean;
  onResizeStart: (event: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const setWidth = useWorkbenchStore((s) => s.setSidebarWidth);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("Resize sidebar")}
      aria-valuenow={width}
      tabIndex={0}
      className={cn(
        "page-resizer absolute right-0 top-0 flex h-full w-[5px] cursor-col-resize items-center justify-center",
        dragging ? "bg-accent/25" : "hover:bg-accent/15",
      )}
      onMouseDown={onResizeStart}
      onDoubleClick={() => setWidth(RESET_WIDTH)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          setWidth(Math.max(MIN_WIDTH, width - 16));
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          setWidth(Math.min(MAX_WIDTH, width + 16));
        }
      }}
    >
      <GripVertical size={12} className="text-fg-subtle" />
    </div>
  );
}

function SidebarShell({
  width,
  label,
  dragging,
  onResizeStart,
  children,
}: {
  width: number;
  label: string;
  dragging: boolean;
  onResizeStart: (event: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <aside
      className="relative flex shrink-0 flex-col overflow-hidden"
      style={{ width }}
      aria-label={label}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      <ResizeHandle width={width} dragging={dragging} onResizeStart={onResizeStart} />
    </aside>
  );
}

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
    (event: React.MouseEvent) => {
      event.preventDefault();
      dragRef.current = true;
      setDragging(true);

      const onMove = (moveEvent: MouseEvent) => {
        if (!dragRef.current) return;
        // 52 = NavigationRail width.
        setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, moveEvent.clientX - 52)));
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

  if (collapsed) return <div className="w-0 shrink-0" aria-hidden="true" />;

  // 数据库有独立的资产树（连接 → 库 → 表），布局与服务器面板一致：
  // 同一个宽度、同一个拖拽手柄、同一套页面外壳。
  if (activeModule === "database") {
    return (
      <SidebarShell
        width={width}
        label={t("数据库资产")}
        dragging={dragging}
        onResizeStart={onResizeStart}
      >
        <DatabaseAssetSidebar />
      </SidebarShell>
    );
  }

  // Session-driven modules (日志 / 服务 / 项目) operate on a chosen server, so
  // the left rail shows the same server list as the terminal — same blur, header
  // buttons and rows — and clicking a server loads that module bound to it.
  if (isServerListModule(activeModule)) {
    return (
      <SidebarShell
        width={width}
        label={t("{{module}} server list", { module: activeModule })}
        dragging={dragging}
        onResizeStart={onResizeStart}
      >
        <ModuleServerSidebar module={activeModule} />
      </SidebarShell>
    );
  }

  return (
    <SidebarShell
      width={width}
      label={t(MODULE_TITLES.ssh)}
      dragging={dragging}
      onResizeStart={onResizeStart}
    >
      <SshContextSidebar />
    </SidebarShell>
  );
}
