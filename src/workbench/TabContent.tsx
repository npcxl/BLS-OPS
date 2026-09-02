import { Suspense, lazy } from "react";
import { Loader2 } from "lucide-react";
import type { WorkspaceTab } from "@/workbench/types";
import { WorkbenchHome } from "@/workbench/views/WorkbenchHome";
import { ModulePage } from "@/workbench/ModulePage";
import { PlaceholderView } from "@/workbench/views/PlaceholderView";

/**
 * xterm and its addons are ~400 KB of the bundle and are only needed once a
 * terminal is actually opened. Loading them lazily keeps the initial shell
 * (and therefore app start) small; the chunk is fetched on first use.
 */
const TerminalView = lazy(() =>
  import("@/workbench/views/terminal/TerminalView").then((module) => ({
    default: module.TerminalView,
  })),
);

const ServerMonitorView = lazy(() =>
  import("@/workbench/views/server-monitor/ServerMonitorView").then((module) => ({
    default: module.ServerMonitorView,
  })),
);

/** The P3 management modules — each one is session-driven and command-backed. */
const ServiceManagerView = lazy(() =>
  import("@/workbench/views/ServiceManagerView").then((module) => ({
    default: module.ServiceManagerView,
  })),
);

const LogCenterView = lazy(() =>
  import("@/workbench/views/LogCenterView").then((module) => ({
    default: module.LogCenterView,
  })),
);

const ProjectView = lazy(() =>
  import("@/workbench/views/project/ProjectView").then((module) => ({
    default: module.ProjectView,
  })),
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
    case "module":
      return tab.module ? <ModulePage module={tab.module} /> : null;
    case "terminal":
      return (
        <Suspense fallback={<TerminalFallback />}>
          <TerminalView tab={tab} />
        </Suspense>
      );
    case "monitor":
      return (
        <Suspense fallback={<TerminalFallback />}>
          <ServerMonitorView tab={tab} />
        </Suspense>
      );
    case "service":
      return (
        <Suspense fallback={<TerminalFallback />}>
          <ServiceManagerView tab={tab} />
        </Suspense>
      );
    case "logs":
      return (
        <Suspense fallback={<TerminalFallback />}>
          <LogCenterView tab={tab} />
        </Suspense>
      );
    case "project":
      return (
        <Suspense fallback={<TerminalFallback />}>
          <ProjectView tab={tab} />
        </Suspense>
      );
    default:
      return <PlaceholderView tab={tab} />;
  }
}
