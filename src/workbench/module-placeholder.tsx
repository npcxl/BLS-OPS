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
 * Placeholder sidebar bodies for modules that land in later phases.
 * Each entry lists the real planned context sections from the spec.
 */

interface ModuleSpec {
  title: string;
  icon: LucideIcon;
  phase: string;
  sections: string[];
}

const MODULES: Record<NavModule, ModuleSpec> = {
  ssh: { title: "终端", icon: SquareTerminal, phase: "阶段 1", sections: [] },
  servers: {
    title: "服务器",
    icon: Server,
    phase: "阶段 2",
    sections: ["服务器列表", "分组", "状态", "搜索"],
  },
  files: {
    title: "文件",
    icon: Files,
    phase: "阶段 3",
    sections: ["远程浏览", "传输队列"],
  },
  projects: {
    title: "项目",
    icon: Boxes,
    phase: "阶段 5",
    sections: ["最近项目", "分组", "关联关系"],
  },
  deploy: {
    title: "部署",
    icon: Rocket,
    phase: "阶段 6",
    sections: ["目标环境", "工作流", "历史记录"],
  },
  docker: {
    title: "容器",
    icon: Container,
    phase: "阶段 4",
    sections: ["服务器", "容器", "镜像", "编排"],
  },
  nginx: {
    title: "网关",
    icon: Globe,
    phase: "阶段 4",
    sections: ["实例", "站点", "上游服务", "证书"],
  },
  tasks: {
    title: "任务",
    icon: ListTodo,
    phase: "阶段 2",
    sections: ["构建", "上传", "部署", "历史"],
  },
  ai: {
    title: "智能助手",
    icon: Sparkles,
    phase: "阶段 7",
    sections: ["上下文", "模型提供方", "历史记录"],
  },
  settings: {
    title: "设置",
    icon: Settings,
    phase: "阶段 1",
    sections: ["通用", "凭据", "已知主机", "密钥环"],
  },
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
          <div className="text-11 text-fg-subtle">{spec.phase}</div>
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        {spec.sections.map((section) => (
          <div
            key={section}
            className="flex h-7 items-center rounded-[6px] px-2.5 text-12 text-fg-muted hover:bg-surface-hover hover:text-fg"
          >
            {section}
          </div>
        ))}
      </div>
      <p className="mt-1 border-t border-line pt-2 text-11 leading-relaxed text-fg-subtle">
        {spec.title} 模块将在 {spec.phase} 上线。
      </p>
    </div>
  );
}
