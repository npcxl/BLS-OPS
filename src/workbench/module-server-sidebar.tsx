import { useMemo } from "react";
import { Boxes, Container, Globe, ScrollText, SquareCheckBig } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { NavModule, WorkbenchPane, WorkspaceTab } from "@/workbench/types";
import { useDomainStore } from "@/stores/domain-store";
import { useWorkbenchStore } from "@/stores/workbench-store";

/** Modules that, when opened from the rail, show a left server list instead of
 *  a placeholder — picking a server opens that module bound to that server. */
export const SERVER_LIST_MODULES: NavModule[] = ["services", "logs", "docker", "nginx", "projects"];

const MODULE_ICON: Partial<Record<NavModule, LucideIcon>> = {
  services: SquareCheckBig,
  logs: ScrollText,
  docker: Container,
  nginx: Globe,
  projects: Boxes,
};

export function isServerListModule(module: NavModule): boolean {
  return SERVER_LIST_MODULES.includes(module);
}

function findLeafWithTab(pane: WorkbenchPane, tabId: string | null): WorkspaceTab | null {
  if (tabId && Array.isArray(pane.tabs)) {
    const t = pane.tabs.find((x) => x.id === tabId);
    if (t) return t;
  }
  if (pane.children) {
    for (const child of pane.children) {
      const found = findLeafWithTab(child, tabId);
      if (found) return found;
    }
  }
  return null;
}

function findPaneById(pane: WorkbenchPane, paneId: string | null): WorkbenchPane | null {
  if (pane.id === paneId) return pane;
  if (pane.children) {
    for (const child of pane.children) {
      const found = findPaneById(child, paneId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Left server-list sidebar for a session-driven module (日志 / 服务 / 容器 / 网关 / 项目).
 *
 * These modules operate on a chosen server, so instead of the "未实现" placeholder
 * the rail page shows the server list — exactly like the terminal/server module —
 * and clicking a server loads that module bound to that server. This keeps the
 * left rail content consistent with the active tab's module and the rail highlight.
 */
export function ModuleServerSidebar({ module }: { module: NavModule }) {
  const servers = useDomainStore((s) => s.servers);
  const openModuleTabForServer = useWorkbenchStore((s) => s.openModuleTabForServer);
  const focusedPaneId = useWorkbenchStore((s) => s.focusedPaneId);
  const rootPane = useWorkbenchStore((s) => s.rootPane);

  const activeServerId = useMemo(() => {
    const pane = findPaneById(rootPane, focusedPaneId);
    if (!pane) return null;
    const tab = findLeafWithTab(pane, pane.activeTabId);
    return tab?.serverId ?? null;
  }, [rootPane, focusedPaneId]);

  const Icon = MODULE_ICON[module];

  return (
    <div className="flex h-full w-[210px] shrink-0 flex-col border-r border-line bg-app">
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
        {Icon && <Icon size={13} strokeWidth={2} />}
        服务器
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {servers.length === 0 ? (
          <div className="px-3 py-4 text-11 leading-relaxed text-fg-subtle">
            还没有服务器。先到「服务器」里添加一台。
          </div>
        ) : (
          servers.map((server) => {
            const active = activeServerId === server.id;
            return (
              <button
                key={server.id}
                type="button"
                onClick={() => openModuleTabForServer(module, server.id)}
                className={[
                  "flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left",
                  active ? "bg-surface-hover" : "hover:bg-surface-hover/60",
                ].join(" ")}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  {active && <span className="h-3 w-[3px] shrink-0 rounded-full bg-accent" />}
                  <span className="truncate text-12 font-medium text-fg">{server.name}</span>
                </div>
                <span className="truncate pl-[7px] text-11 text-fg-subtle">
                  {server.host}:{server.port}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
