import { Suspense, lazy } from "react";
import { Loader2 } from "lucide-react";
import type { WorkspaceTab } from "@/workbench/types";
import { WorkbenchHome } from "@/workbench/views/WorkbenchHome";
import { PlaceholderView } from "@/workbench/views/PlaceholderView";

/**
 * xterm and its addons are ~400 KB of the bundle and are only needed once a
 * terminal is actually opened. Loading them lazily keeps the initial shell
 * (and therefore app start) small; the chunk is fetched on first use.
 */
const TerminalView = lazy(() =>
  import("@/workbench/views/TerminalView").then((module) => ({ default: module.TerminalView })),
);

function TerminalFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-app">
      <Loader2 size={16} className="animate-spin text-fg-subtle" />
    </div>
  );
}

/** Routes a workspace tab to its view (spec §12). */
export function TabContent({ tab }: { tab: WorkspaceTab }) {
  switch (tab.type) {
    case "home":
      return <WorkbenchHome />;
    case "terminal":
      return (
        <Suspense fallback={<TerminalFallback />}>
          <TerminalView tab={tab} />
        </Suspense>
      );
    default:
      return <PlaceholderView tab={tab} />;
  }
}
