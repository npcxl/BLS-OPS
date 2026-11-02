import type { IconComponent } from "@/components/icons";
import { useTranslation } from "react-i18next";
import { Activity, Boxes, House, LayoutGrid, Rocket, ScrollText, Server, SquareCheckBig, SquareTerminal, Table2, Workflow } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSurface, PageWorkspace } from "@/workbench/page-layout";
import type { WorkspaceTab, WorkspaceTabType } from "@/workbench/types";

/** Fallback chrome for tab types that are not routed to a view yet. */
const META: Record<WorkspaceTabType, { icon: IconComponent }> = {
  home: { icon: House },
  module: { icon: LayoutGrid },
  terminal: { icon: SquareTerminal },
  server: { icon: Server },
  monitor: { icon: Activity },
  service: { icon: SquareCheckBig },
  logs: { icon: ScrollText },
  project: { icon: Boxes },
  command_center: { icon: Boxes },
  workflow: { icon: Workflow },
  deployment: { icon: Rocket },
  database: { icon: Table2 },
};

export function PlaceholderView({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  const Icon = META[tab.type].icon;
  return (
    <PageSurface>
      <PageWorkspace className="items-center justify-center">
        <EmptyState
          icon={<Icon size={18} strokeWidth={1.5} />}
          title={t(tab.title)}
          description={t("This view is not implemented yet.")}
        />
      </PageWorkspace>
    </PageSurface>
  );
}
