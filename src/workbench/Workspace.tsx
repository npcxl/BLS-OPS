import { useWorkbenchStore } from "@/stores/workbench-store";
import { WorkbenchPane } from "./WorkbenchPane";

/** Workspace — the primary work area (spec §10). */
export function Workspace() {
  const rootPane = useWorkbenchStore((s) => s.rootPane);
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
      <div className="flex min-h-0 flex-1">
        <WorkbenchPane pane={rootPane} />
      </div>
    </main>
  );
}
