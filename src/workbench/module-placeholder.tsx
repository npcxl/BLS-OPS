import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  Container,
  Files,
  Globe,
  ListTodo,
  Rocket,
  Server,
  Settings,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import type { NavModule } from "@/workbench/types";

/**
 * Sidebar bodies for modules that are not implemented yet.
 *
 * These are deliberately inert: Docker / Nginx / 部署 / 项目 / AI development is
 * frozen until the P0 SSH core passes acceptance. Nothing here pretends to show
 * live data.
 */

interface ModuleSpec {
  title: string;
  icon: LucideIcon;
  sections: string[];
}

const MODULES: Record<NavModule, ModuleSpec> = {
  ssh: { title: "终端", icon: SquareTerminal, sections: [] },
  servers: { title: "服务器", icon: Server, sections: [] },
  files: { title: "文件", icon: Files, sections: ["远程浏览", "传输队列"] },
  projects: { title: "项目", icon: Boxes, sections: ["最近项目", "分组", "关联关系"] },
  deploy: { title: "部署", icon: Rocket, sections: ["目标环境", "工作流", "历史记录"] },
  docker: { title: "容器", icon: Container, sections: ["容器", "镜像", "编排"] },
  nginx: { title: "网关", icon: Globe, sections: ["实例", "站点", "上游服务", "证书"] },
  tasks: { title: "任务", icon: ListTodo, sections: ["构建", "上传", "部署", "历史"] },
  ai: { title: "智能助手", icon: Sparkles, sections: ["上下文", "模型提供方", "历史记录"] },
  settings: { title: "设置", icon: Settings, sections: ["通用", "凭据", "已知主机"] },
};

export function ModulePlaceholderSidebar({ module }: { module: NavModule }) {
  const spec = MODULES[module];
  const Icon = spec.icon;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-line bg-surface-2 text-fg-subtle">
          <Icon size={16} strokeWidth={1.75} />
        </div>
        <div>
          <div className="text-12 font-semibold text-fg">{spec.title}</div>
          <div className="text-11 text-fg-subtle">未实现</div>
        </div>
      </div>
      <p className="text-11 leading-relaxed text-fg-subtle">
        在 P0（真实 SSH 终端、Host Key 校验、凭据绑定）验收通过之前，本模块不进入开发。
      </p>
      {spec.sections.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-line pt-2">
          {spec.sections.map((section) => (
            <div key={section} className="flex h-7 items-center px-2.5 text-12 text-fg-subtle">
              {section}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
