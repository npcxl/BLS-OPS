import { PanelLeftOpen } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";
import { hasContextSidebar } from "./module-server-sidebar";

/** macOS Sonoma System Settings — titlebar is just traffic lights; the
 *  current section title appears centered only while hovering the bar. */
const MODULE_TITLES: Record<string, string> = {
  ssh: "终端",
  servers: "服务器",
  services: "服务",
  logs: "日志",
  projects: "项目",
  commands: "命令",
  deploy: "部署",
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
        void (kind === "close"
          ? win.close()
          : kind === "minimize"
            ? win.minimize()
            : win.toggleMaximize());
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
  const setSidebarCollapsed = useWorkbenchStore((s) => s.setSidebarCollapsed);

  // Only offer the way back for modules that actually have a rail. Collapsing
  // the sidebar hides its own 收起 button, so without this the rail would be
  // unreachable until the module was switched away and back.
  const canExpand = collapsed && hasContextSidebar(activeModule);

  return (
    <header
      data-tauri-drag-region
      className="group relative flex h-9 shrink-0 select-none items-center gap-2 px-3"
    >
      <WindowButton kind="close" />
      <WindowButton kind="minimize" />
      <WindowButton kind="maximize" />
      {canExpand && (
        <button
          type="button"
          aria-label="展开侧边栏"
          title="展开侧边栏"
          // The whole bar is the window drag region; without this the click
          // is swallowed by the drag handler.
          data-tauri-drag-region="false"
          onClick={() => setSidebarCollapsed(false)}
          className="ml-1 flex h-[18px] w-[18px] items-center justify-center rounded-[5px] text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
        >
          <PanelLeftOpen size={13} strokeWidth={1.8} />
        </button>
      )}
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-11 font-medium text-fg-subtle opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {MODULE_TITLES[activeModule] ?? "BLS-OPS"}
      </span>
    </header>
  );
}
