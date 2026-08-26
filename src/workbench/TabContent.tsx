import type { WorkspaceTab } from "@/workbench/types";
import { WorkbenchHome } from "@/workbench/views/WorkbenchHome";
import { TerminalView } from "@/workbench/views/TerminalView";
import { PlaceholderView } from "@/workbench/views/PlaceholderView";

/** Routes a workspace tab to its view (spec §12). */
export function TabContent({ tab }: { tab: WorkspaceTab }) {
  switch (tab.type) {
    case "home":
      return <WorkbenchHome />;
    case "terminal":
      return <TerminalView tab={tab} />;
    default:
      return <PlaceholderView tab={tab} />;
  }
}
