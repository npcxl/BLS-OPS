import type { IconComponent } from "@/components/icons";
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
} from "@/components/icons";
import type { NavModule } from "@/workbench/types";
import { AiPlaceholder } from "@/workbench/views/ai/AiPlaceholder";
import { PageHeader, PageScroll, PageSection, PageSurface } from "./page-layout";
import { SshContextSidebar } from "./ssh-context-sidebar";
import { SettingsPage } from "./SettingsPage";

interface ModuleSpec {
  title: string;
  icon: IconComponent;
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
  database: {
    title: "Module: Database",
    icon: SquareTerminal,
    description: "Database workbench: browse, query, edit, export",
    sections: ["Connections", "SQL editor", "Table data"],
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
  return (
    <PageSection title={t("Planned sections")}>
      <div className="page-form-list">
        {spec.sections.map((section) => (
          <div key={section} className="page-form-row text-12 text-fg-subtle">
            {t(section)}
          </div>
        ))}
        <p className="page-form-row text-11 leading-relaxed text-fg-subtle">
          {/* No phase references: this text outlives individual milestones. */}
          {t("This module is not implemented yet.")}
        </p>
      </div>
    </PageSection>
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

  if (module === "settings") return <SettingsPage />;

  return (
    <PageSurface data-selectable>
      <PageHeader
        title={t(spec.title)}
        description={spec.description ? t(spec.description) : undefined}
      />
      <PageScroll width="reading">
        {module === "ssh" || module === "servers" ? (
          <SshContextSidebar />

        ) : module === "ai" ? (
          // P4 不开发 AI：只保留菜单入口 + feature flag + 接口类型占位。
          <AiPlaceholder />
        ) : (
          <ModulePlaceholder module={module} />
        )}
      </PageScroll>
    </PageSurface>
  );
}
