import { useState } from "react";
import { ChevronRight, SquareTerminal } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { ContextMenu, type ContextMenuState, contextMenuStateAt } from "@/components/ui/context-menu";
import { APP_NAME } from "@/app/app-meta";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkbenchPane, WorkspaceTab } from "@/workbench/types";
import { cn } from "@/lib/cn";

function findPane(root: WorkbenchPane, id: string): WorkbenchPane | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findPane(child, id);
    if (found) return found;
  }
  return null;
}

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
  const toggleSidebar = useWorkbenchStore((s) => s.toggleSidebar);
  const sidebarCollapsed = useWorkbenchStore((s) => s.sidebarCollapsed);
  const setModule = useWorkbenchStore((s) => s.setModule);
  const openTab = useWorkbenchStore((s) => s.openTab);
  const rootPane = useWorkbenchStore((s) => s.rootPane);
  const focusedPaneId = useWorkbenchStore((s) => s.focusedPaneId);

  const activePane = focusedPaneId ? findPane(rootPane, focusedPaneId) : null;
  const activeTabTitle = activePane?.tabs.find((t) => t.id === activePane.activeTabId)?.title ?? "首页";

  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const quickOpen = (type: WorkspaceTab["type"], title: string, subtitle?: string) => {
    openTab({ id: crypto.randomUUID(), type, title, subtitle });
  };

  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 select-none items-center gap-3 border-b border-line bg-surface-1/70 px-3 backdrop-blur-xl"
    >
      {/* macOS traffic lights + window title */}
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        <div data-tauri-drag-region className="flex shrink-0 items-center gap-2">
          <WindowButton kind="close" />
          <WindowButton kind="minimize" />
          <WindowButton kind="maximize" />
        </div>
        <div data-tauri-drag-region className="flex min-w-0 items-center gap-2 pl-0.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-accent-soft text-accent ring-1 ring-line-strong/60 shadow-[inset_0_1px_0_rgb(255_255_255/0.45)]">
            <SquareTerminal size={14} strokeWidth={2} />
          </div>
          <span className="truncate text-12 font-medium text-fg-muted">{APP_NAME}</span>
        </div>
      </div>

      {/* Global actions */}
      <div data-tauri-drag-region className="flex items-center gap-1">
        <Button variant="ghost" size="sm" className="px-2" onClick={toggleSidebar}>
          <span className="text-11">{sidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏"}</span>
        </Button>
        <Button variant={activeModule === "ssh" ? "secondary" : "ghost"} size="sm" className="px-2" onClick={() => setModule("ssh")}>
          终端
        </Button>
        <Button variant="ghost" size="sm" className="px-2" onClick={() => quickOpen("terminal", "新建终端")}>
          新建标签
        </Button>
      </div>

      {/* Current location / breadcrumb */}
      <div className="pointer-events-none mx-auto hidden min-w-0 items-center gap-1 rounded-control border border-line bg-surface-2/70 px-2.5 py-1 text-11 text-fg-muted lg:flex">
        <ChevronRight size={11} />
        <span className="max-w-[220px] truncate">{activeTabTitle}</span>
      </div>

      {/* Right cluster */}
      <div data-tauri-drag-region className="ml-auto flex min-w-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="px-2"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(
              contextMenuStateAt(e, [
                { label: "新建终端", onSelect: () => quickOpen("terminal", "新建终端") },
                { label: "管理服务器", onSelect: () => setModule("ssh") },
                { separator: true },
                { label: "凭据与已知主机", onSelect: () => setModule("settings") },
              ]),
            );
          }}
        >
          快捷操作
        </Button>
      </div>

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </header>
  );
}