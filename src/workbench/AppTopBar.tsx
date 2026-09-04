import { PanelLeftOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";
import { isMacOS } from "@/lib/platform";
import { hasContextSidebar } from "./module-server-sidebar";
import { WindowControls } from "./window-controls";

/** macOS Sonoma System Settings — titlebar is just traffic lights; the
 *  current section title appears centered only while hovering the bar. */
/** 值是 i18n key（模块级常量不能用 hook），渲染处统一 `t(...)`。 */
const MODULE_TITLES: Record<string, string> = {
  ssh: "Module: Terminal",
  servers: "Module: Servers",
  services: "Module: Services",
  logs: "Module: Logs",
  projects: "Module: Projects",
  commands: "Module: Commands",
  deploy: "Module: Deploy",
  tasks: "Module: Tasks",
  ai: "Module: AI",
  settings: "Module: Settings",
};

/** macOS keeps native decorations (see src-tauri/tauri.macos.conf.json): the
 *  traffic lights are real system controls, so the bar draws none of its own. */
export function AppTopBar() {
  const { t } = useTranslation();
  const activeModule = useWorkbenchStore((s) => s.activeModule);
  const collapsed = useWorkbenchStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useWorkbenchStore((s) => s.setSidebarCollapsed);

  const mac = isMacOS();

  // Only offer the way back for modules that actually have a rail. Collapsing
  // the sidebar hides its own 收起 button, so without this the rail would be
  // unreachable until the module was switched away and back.
  const canExpand = collapsed && hasContextSidebar(activeModule);

  return (
    <header
      data-tauri-drag-region
      className={cn(
        // Windows caption buttons sit flush against the right edge, like the
        // real ones; macOS only needs room for the native traffic lights.
        "group relative flex h-9 shrink-0 select-none items-center gap-2",
        mac ? "pl-[76px] pr-3" : "pl-3",
      )}
    >
      {/* 应用 Logo（public/logo.png，与 exe/任务栏/网页图标同源）：最左侧常驻。
          pointer-events-none 让点击穿透到整条拖拽栏 —— 点 Logo = 拖动窗口。 */}
      <img
        src="/logo.png"
        alt="BLS-OPS"
        data-tauri-drag-region="false"
        className="pointer-events-none h-[24px] w-[24px] shrink-0 rounded-[5px]"
        draggable={false}
      />
      {canExpand && (
        <button
          type="button"
          aria-label={t("Expand sidebar")}
          title={t("Expand sidebar")}
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
        {t(MODULE_TITLES[activeModule] ?? "BLS-OPS")}
      </span>
      {!mac && <WindowControls />}
    </header>
  );
}
