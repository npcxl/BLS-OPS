import { Fragment } from "react";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkbenchPane as WorkbenchPaneModel } from "@/workbench/types";
import { isLeafPane } from "@/workbench/types";
import { cn } from "@/lib/cn";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { TabContent } from "./TabContent";
import { EmptyPaneState } from "./empty-pane-state";

/** Recursive split-pane renderer — spec §13, §14. */
export function WorkbenchPane({ pane }: { pane: WorkbenchPaneModel }) {
  const focusPane = useWorkbenchStore((s) => s.focusPane);

  if (!isLeafPane(pane)) {
    const vertical = pane.direction === "vertical";
    return (
      <div className={cn("flex min-h-0 min-w-0 flex-1", vertical ? "flex-col" : "flex-row")}>
        {pane.children!.map((child, index) => (
          <Fragment key={child.id}>
            {index > 0 && <div className={cn("shrink-0 bg-line", vertical ? "h-px w-full" : "h-full w-px")} />}
            <WorkbenchPane pane={child} />
          </Fragment>
        ))}
      </div>
    );
  }

  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app" onMouseDown={() => focusPane(pane.id)}>
      <WorkspaceTabs pane={pane} />
      <div className="min-h-0 flex-1">{activeTab ? <TabContent tab={activeTab} /> : <EmptyPaneState paneId={pane.id} />}</div>
    </div>
  );
}
