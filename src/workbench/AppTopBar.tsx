import { useState } from "react";
import { ChevronRight, Command, PanelsTopLeft, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, type ContextMenuState, contextMenuStateAt } from "@/components/ui/context-menu";
import { APP_NAME, APP_VERSION } from "@/app/app-meta";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkbenchPane, WorkspaceTab } from "@/workbench/types";

function findPane(root: WorkbenchPane, id: string): WorkbenchPane | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findPane(child, id);
    if (found) return found;
  }
  return null;
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
    <header className="flex h-10 shrink-0 items-center border-b border-line bg-surface-1 px-3">
      {/* Brand */}
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-control border border-line bg-surface-2 text-accent">
          <SquareTerminal size={16} strokeWidth={2} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-13 font-semibold leading-4 text-fg">{APP_NAME}</div>
          <div className="truncate text-11 leading-3 text-fg-subtle">本地工作区 · v{APP_VERSION}</div>
        </div>
      </div>

      {/* Global actions */}
      <div className="ml-4 flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={toggleSidebar} className="px-2">
          <PanelsTopLeft size={14} />
          <span>{sidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏"}</span>
        </Button>
        <Button variant={activeModule === "ssh" ? "secondary" : "ghost"} size="sm" className="px-2" onClick={() => setModule("ssh")}>
          终端
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="px-2"
          onClick={() => quickOpen("terminal", "新建终端")}
        >
          <SquareTerminal size={14} />
          <span>新建标签</span>
        </Button>
      </div>

      {/* Right cluster */}
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <div className="hidden items-center gap-1 rounded-control border border-line bg-surface-2 px-2 py-1 text-11 text-fg-muted md:flex">
          <Command size={12} />
          <span>Ctrl + K</span>
        </div>
        <div className="hidden items-center gap-1 rounded-control border border-line bg-surface-2 px-2 py-1 text-11 text-fg-muted lg:flex">
          <ChevronRight size={12} />
          <span className="max-w-[140px] truncate">{activeTabTitle}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="px-2"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(
              contextMenuStateAt(e, [
                { label: "新建终端", onSelect: () => quickOpen("terminal", "新建终端") },
                { label: "打开容器", onSelect: () => quickOpen("docker", "容器") },
                { separator: true },
                { label: "智能助手", onSelect: () => setModule("ai") },
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
