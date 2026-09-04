import type { NavModule } from "@/workbench/types";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { ServerListTree } from "./server-list";

/** Modules that, when opened from the rail, show a left server list instead of
 *  a placeholder — picking a server opens that module bound to that server. */
export const SERVER_LIST_MODULES: NavModule[] = ["services", "logs", "projects"];

const MODULE_TITLE: Record<NavModule, string> = {
  ssh: "服务器列表",
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

export function isServerListModule(module: NavModule): boolean {
  return SERVER_LIST_MODULES.includes(module);
}

/**
 * Modules that own a left rail. The terminal has the canonical server list,
 * 项目 / 服务 / 日志 share it; 设置 / 命令 / 部署 / … have no rail at all and
 * must not offer an expand button for one.
 *
 * Single source of truth: `ContextSidebar` decides *what* to render, this
 * decides *whether* anything would be rendered. Keeping them on one list is
 * what stops the top bar from offering to expand a sidebar that does not exist.
 */
export const CONTEXT_SIDEBAR_MODULES: NavModule[] = ["ssh", ...SERVER_LIST_MODULES];

export function hasContextSidebar(module: NavModule): boolean {
  return CONTEXT_SIDEBAR_MODULES.includes(module);
}

/**
 * Left server-list rail for the session-driven modules (项目 / 服务 / 日志).
 *
 * It mounts the exact same tree as the terminal rail — same ordering, same
 * favorites, same group actions — so the only differences are the title and
 * the fact that clicking a server opens *this* module bound to it.
 */
export function ModuleServerSidebar({ module }: { module: NavModule }) {
  const openModuleTabForServer = useWorkbenchStore((s) => s.openModuleTabForServer);

  return (
    <ServerListTree
      title={MODULE_TITLE[module] ?? module}
      onOpenServer={(server) => openModuleTabForServer(module, server.id)}
    />
  );
}
