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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app" onMouseDown={() => focusPane(pane.id)}>
      <WorkspaceTabs pane={pane} />
      <div className="relative min-h-0 flex-1">
        {pane.tabs.length === 0 ? (
          <EmptyPaneState paneId={pane.id} />
        ) : (
          pane.tabs.map((tab) => {
            const active = tab.id === pane.activeTabId;
            return (
              <div
                key={tab.id}
                className={cn("absolute inset-0", active ? "block" : "hidden")}
                aria-hidden={active ? undefined : true}
                // Keep focusable elements in inactive (hidden) tabs out of the
                // tab order and away from assistive tech — otherwise a lingering
                // focus inside an aria-hidden container throws a11y warnings and
                // can interfere with the active terminal's focus.
                {...(!active ? { inert: "" as unknown as boolean } : {})}
              >
                <TabContent tab={tab} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
