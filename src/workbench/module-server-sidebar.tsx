import { useTranslation } from "react-i18next";
import type { NavModule } from "@/workbench/types";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { ServerListTree } from "./server-list";

/** Modules that, when opened from the rail, show a left server list instead of
 *  a placeholder — picking a server opens that module bound to that server. */
export const SERVER_LIST_MODULES: NavModule[] = ["services", "logs", "projects"];

/** 模块标题存 i18n key（natural keys）：模块级常量不能用 hook，渲染处 t()。 */
const MODULE_TITLE: Record<NavModule, string> = {
  ssh: "Server list",
  servers: "Servers",
  services: "Services",
  logs: "Logs",
  projects: "Projects",
  commands: "Commands",
  deploy: "Deploy",
  tasks: "Tasks",
  ai: "AI assistant",
  settings: "Settings",
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
  const { t } = useTranslation();

  return (
    <ServerListTree
      title={t(MODULE_TITLE[module] ?? module)}
      onOpenServer={(server) => openModuleTabForServer(module, server.id)}
    />
  );
}
