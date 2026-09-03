import type { LucideIcon } from "lucide-react";
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
import { SshContextSidebar } from "./ssh-context-sidebar";
import { SettingsContextSidebar } from "./settings-context-sidebar";

interface ModuleSpec {
  title: string;
  icon: LucideIcon;
  description: string;
  sections: string[];
}

const MODULES: Record<NavModule, ModuleSpec> = {
  ssh: { title: "终端", icon: SquareTerminal, description: "", sections: [] },
  servers: { title: "服务器", icon: Server, description: "", sections: [] },
  services: { title: "服务", icon: Server, description: "", sections: [] },
  logs: { title: "日志", icon: ScrollText, description: "", sections: [] },
  projects: { title: "项目", icon: Boxes, description: "项目与分组管理", sections: ["最近项目", "分组", "关联关系"] },
  deploy: { title: "部署", icon: Rocket, description: "部署目标与工作流", sections: ["目标环境", "工作流", "历史记录"] },
  tasks: { title: "任务", icon: ListTodo, description: "构建与上传任务", sections: ["构建", "上传", "部署", "历史"] },
  ai: { title: "智能助手", icon: Sparkles, description: "AI 辅助运维", sections: ["上下文", "模型提供方", "历史记录"] },
  settings: { title: "设置", icon: Settings, description: "", sections: [] },
};

function ModulePlaceholder({ module }: { module: NavModule }) {
  const spec = MODULES[module];
  const Icon = spec.icon;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-line bg-surface-2 text-fg-subtle">
          <Icon size={20} strokeWidth={1.75} />
        </div>
        <div>
          <div className="text-15 font-semibold text-fg">{spec.title}</div>
          <div className="text-12 text-fg-subtle">{spec.description}</div>
        </div>
      </div>
      <div className="overflow-hidden rounded-[12px] border border-line bg-surface-1/70">
        <div className="divide-y divide-line/60">
          {spec.sections.map((section) => (
            <div key={section} className="flex h-9 items-center px-3 text-12 text-fg-subtle">
              {section}
            </div>
          ))}
          <div className="px-3 py-3 text-11 leading-relaxed text-fg-subtle">
            本模块尚未实现。在 P0（真实 SSH 终端、Host Key 校验、凭据绑定）验收通过之前不进入开发。
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
  const spec = MODULES[module];

  return (
    <div className="relative z-0 h-full overflow-y-auto bg-app" data-selectable>
      <div className="mx-auto flex max-w-[620px] flex-col gap-5 px-6 py-6">
        <div>
          <h1 className="text-20 font-semibold text-fg">{spec.title}</h1>
          {spec.description && <p className="mt-0.5 text-12 text-fg-muted">{spec.description}</p>}
        </div>

        {module === "ssh" || module === "servers" ? (
          <SshContextSidebar />
        ) : module === "settings" ? (
          <SettingsContextSidebar />
        ) : (
          <ModulePlaceholder module={module} />
        )}
      </div>
    </div>
  );
}
