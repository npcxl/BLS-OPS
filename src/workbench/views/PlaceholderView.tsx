import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Activity, Boxes, House, LayoutGrid, Rocket, ScrollText, Server, SquareCheckBig, SquareTerminal, Workflow } from "lucide-react";
import type { WorkspaceTab, WorkspaceTabType } from "@/workbench/types";

/** Generic placeholder for tab types that land in later phases. phase 存 i18n key。 */
const META: Record<WorkspaceTabType, { icon: LucideIcon; phase: string }> = {
  home: { icon: House, phase: "Phase 1" },
  module: { icon: LayoutGrid, phase: "In progress" },
  terminal: { icon: SquareTerminal, phase: "Phase 2" },
  server: { icon: Server, phase: "Phase 2" },
  monitor: { icon: Activity, phase: "Phase 2" },
  // P3 — all four are real, session-driven views now.
  service: { icon: SquareCheckBig, phase: "Phase 3" },
  logs: { icon: ScrollText, phase: "Phase 3" },
  project: { icon: Boxes, phase: "Phase 3" },
  command_center: { icon: Boxes, phase: "Phase 4" },
  workflow: { icon: Workflow, phase: "Phase 6" },
  deployment: { icon: Rocket, phase: "Phase 6" },
};

export function PlaceholderView({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  const meta = META[tab.type];
  const Icon = meta.icon;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-1">
      <div className="flex h-12 w-12 items-center justify-center rounded-[10px] border border-line bg-surface-1 text-fg-subtle">
        <Icon size={20} strokeWidth={1.5} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-14 font-medium text-fg">{tab.title}</span>
        <span className="rounded-control border border-line bg-surface-1 px-1.5 py-0.5 text-11 text-fg-subtle">
          {t(meta.phase)}
        </span>
      </div>
      <p className="text-12 text-fg-muted">
        {t(
          "This view is not implemented yet. Files, containers, gateways, projects and deployment features are on hold until P0 (real SSH terminal and host key verification) passes acceptance.",
        )}
      </p>
    </div>
  );
}
