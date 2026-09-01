import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronsLeft } from "lucide-react";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";

/** macOS Sonoma System Settings — titlebar is just traffic lights; the
 *  current section title appears centered only while hovering the bar. */
const MODULE_TITLES: Record<string, string> = {
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

function WindowButton({ kind }: { kind: "close" | "minimize" | "maximize" }) {
  return (
    <button
      type="button"
      aria-label={kind}
      onClick={() => {
        const win = getCurrentWindow();
        void (kind === "close" ? win.close() : kind === "minimize" ? win.minimize() : win.toggleMaximize());
      }}
      className={cn(
        "group flex h-3 w-3 items-center justify-center rounded-full transition-colors",
        kind === "close" && "bg-[#ff5f57] hover:bg-[#e0453d]",
        kind === "minimize" && "bg-[#febc2e] hover:bg-[#df9f1c]",
        kind === "maximize" && "bg-[#28c840] hover:bg-[#1fa832]",
      )}
    >
      <span className="text-[8px] font-bold leading-none text-black/55 opacity-0 group-hover:opacity-100">
        {kind === "close" ? "×" : kind === "minimize" ? "–" : "＋"}
      </span>
    </button>
  );
}

export function AppTopBar() {
  const activeModule = useWorkbenchStore((s) => s.activeModule);
  const collapsed = useWorkbenchStore((s) => s.sidebarCollapsed);
  const setCollapsed = useWorkbenchStore((s) => s.setSidebarCollapsed);
  const canToggleSidebar = activeModule === "ssh" || activeModule === "servers";

  return (
    <header
      data-tauri-drag-region
      className="group relative flex h-9 shrink-0 select-none items-center gap-2 px-3"
    >
      {canToggleSidebar && (
        <button
          type="button"
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
          className="flex h-3 w-3 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
          onClick={() => setCollapsed(!collapsed)}
          data-tauri-drag-region="false"
        >
          <ChevronsLeft size={10} className={collapsed ? "rotate-180" : ""} />
        </button>
      )}
      <WindowButton kind="close" />
      <WindowButton kind="minimize" />
      <WindowButton kind="maximize" />
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-11 font-medium text-fg-subtle opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {MODULE_TITLES[activeModule] ?? "BLS-OPS"}
      </span>
    </header>
  );
}
