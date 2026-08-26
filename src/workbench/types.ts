/**
 * Workbench core types — spec §10, §12, §14.
 *
 * Tab types are extensible: "home" is the Workbench landing view (§28),
 * the rest are the first-class workspace tab kinds (§12).
 */
export type WorkspaceTabType =
  | "home"
  | "terminal"
  | "server"
  | "file"
  | "project"
  | "docker"
  | "nginx"
  | "workflow"
  | "deployment";

export interface WorkspaceTab {
  id: string;
  type: WorkspaceTabType;
  title: string;
  subtitle?: string;
  /** Server/session context — wired from Phase 2 onward. */
  serverId?: string;
  sessionId?: string;
  /** Unsaved indicator (remote editor, config draft…). */
  dirty?: boolean;
  /** Terminal / server tabs can carry a live connection state. */
  connected?: boolean;
}

/**
 * Recursive split-pane tree (spec §14).
 * A leaf pane owns `tabs`; a branch pane owns `direction` + `children`.
 */
export interface WorkbenchPane {
  id: string;
  direction?: "horizontal" | "vertical";
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  children?: WorkbenchPane[];
}

/** Primary Navigation Rail modules (spec §7). */
export type NavModule =
  | "ssh"
  | "servers"
  | "files"
  | "projects"
  | "deploy"
  | "docker"
  | "nginx"
  | "tasks"
  | "ai"
  | "settings";

export type SplitDirection = "horizontal" | "vertical";

export function isLeafPane(pane: WorkbenchPane): boolean {
  return !pane.children || pane.children.length === 0;
}
