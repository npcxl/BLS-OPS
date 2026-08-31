import type { LucideIcon } from "lucide-react";
import { Boxes, Container, FileText, Globe, House, Rocket, Server, SquareTerminal, Workflow } from "lucide-react";
import type { WorkspaceTab, WorkspaceTabType } from "@/workbench/types";

/** Generic placeholder for tab types that land in later phases. */
const META: Record<WorkspaceTabType, { icon: LucideIcon; phase: string }> = {
  home: { icon: House, phase: "阶段 1" },
  terminal: { icon: SquareTerminal, phase: "阶段 2" },
  server: { icon: Server, phase: "阶段 2" },
  file: { icon: FileText, phase: "阶段 3" },
  project: { icon: Boxes, phase: "阶段 5" },
  docker: { icon: Container, phase: "阶段 4" },
  nginx: { icon: Globe, phase: "阶段 4" },
  workflow: { icon: Workflow, phase: "阶段 6" },
  deployment: { icon: Rocket, phase: "阶段 6" },
};

export function PlaceholderView({ tab }: { tab: WorkspaceTab }) {
  const meta = META[tab.type];
  const Icon = meta.icon;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-app">
      <div className="flex h-12 w-12 items-center justify-center rounded-[10px] border border-line bg-surface-1 text-fg-subtle">
        <Icon size={20} strokeWidth={1.5} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-14 font-medium text-fg">{tab.title}</span>
        <span className="rounded-control border border-line bg-surface-1 px-1.5 py-0.5 text-11 text-fg-subtle">{meta.phase}</span>
      </div>
      <p className="text-12 text-fg-muted">
        该视图尚未实现。文件、容器、网关、项目、部署类功能在 P0（真实 SSH 终端与主机密钥校验）验收通过前暂停开发。
      </p>
    </div>
  );
}
