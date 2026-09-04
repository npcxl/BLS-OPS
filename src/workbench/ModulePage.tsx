import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  ListTodo,
  Rocket,
  ScrollText,
  Server,
  Settings,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import type { NavModule } from "@/workbench/types";
import { AiPlaceholder } from "@/workbench/views/ai/AiPlaceholder";
import { SshContextSidebar } from "./ssh-context-sidebar";
import { SettingsContextSidebar } from "./settings-context-sidebar";

interface ModuleSpec {
  title: string;
  icon: LucideIcon;
  description: string;
  sections: string[];
}

/** title/description/sections 存 i18n key（模块级常量不能用 hook），渲染处 `t(...)`。 */
const MODULES: Record<NavModule, ModuleSpec> = {
  ssh: { title: "Module: Terminal", icon: SquareTerminal, description: "", sections: [] },
  servers: { title: "Module: Servers", icon: Server, description: "", sections: [] },
  services: { title: "Module: Services", icon: Server, description: "", sections: [] },
  logs: { title: "Module: Logs", icon: ScrollText, description: "", sections: [] },
  projects: {
    title: "Module: Projects",
    icon: Boxes,
    description: "Projects and group management",
    sections: ["Recent projects", "Groups", "Relations"],
  },
  commands: {
    title: "Module: Commands",
    icon: SquareTerminal,
    description: "Linux command intelligence center",
    sections: ["Command knowledge base", "Structured results", "Raw output"],
  },
  deploy: {
    title: "Module: Deploy",
    icon: Rocket,
    description: "Deployment targets and workflows",
    sections: ["Target environments", "Workflows", "History"],
  },
  tasks: {
    title: "Module: Tasks",
    icon: ListTodo,
    description: "Build and upload tasks",
    sections: ["Build", "Upload", "Deploy", "History"],
  },
  ai: {
    title: "Module: AI",
    icon: Sparkles,
    description: "AI-assisted operations",
    sections: ["Context", "Model providers", "History"],
  },
  settings: { title: "Module: Settings", icon: Settings, description: "", sections: [] },
};

function ModulePlaceholder({ module }: { module: NavModule }) {
  const { t } = useTranslation();
  const spec = MODULES[module];
  const Icon = spec.icon;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-line bg-surface-2 text-fg-subtle">
          <Icon size={20} strokeWidth={1.75} />
        </div>
        <div>
          <div className="text-15 font-semibold text-fg">{t(spec.title)}</div>
          <div className="text-12 text-fg-subtle">{spec.description ? t(spec.description) : ""}</div>
        </div>
      </div>
      <div className="overflow-hidden rounded-[12px] border border-line bg-surface-1/70">
        <div className="divide-y divide-line/60">
          {spec.sections.map((section) => (
            <div key={section} className="flex h-9 items-center px-3 text-12 text-fg-subtle">
              {t(section)}
            </div>
          ))}
          <div className="px-3 py-3 text-11 leading-relaxed text-fg-subtle">
            {t(
              "This module is not implemented yet. Development starts after P0 (real SSH terminal, host key verification and credential binding) passes acceptance.",
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Module page — the rail modules' content rendered as a centered column in
 * the main area (System Settings style), instead of a full-height sidebar.
 *
 * The session-driven modules that operate on a server (日志 / 服务 / 容器 / 网关 / 项目)
 * render their own left server list inside their tab view, so here they fall back
 * to the placeholder only when reached via a plain `type: "module"` tab.
 */
export function ModulePage({ module }: { module: NavModule }) {
  const { t } = useTranslation();
  const spec = MODULES[module];

  return (
    <div className="relative z-0 h-full overflow-y-auto bg-surface-1" data-selectable>
      <div className="mx-auto flex max-w-[620px] flex-col gap-5 px-6 py-6">
        <div>
          <h1 className="text-20 font-semibold text-fg">{t(spec.title)}</h1>
          {spec.description && <p className="mt-0.5 text-12 text-fg-muted">{t(spec.description)}</p>}
        </div>

        {module === "ssh" || module === "servers" ? (
          <SshContextSidebar />
        ) : module === "settings" ? (
          <SettingsContextSidebar />
        ) : module === "ai" ? (
          // P4 不开发 AI：只保留菜单入口 + feature flag + 接口类型占位。
          <AiPlaceholder />
        ) : (
          <ModulePlaceholder module={module} />
        )}
      </div>
    </div>
  );
}
