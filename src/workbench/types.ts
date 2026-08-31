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
  /** Server/session context. */
  serverId?: string;
  sessionId?: string;
  /** `user@host[:port]` typed into quick connect (no saved server). */
  quickTarget?: string;
  /** Credential chosen for a quick connect. */
  credentialId?: string;
  /**
   * Password typed for this one connection only. Held just long enough to open
   * the session; Rust discards it and never persists it.
   */
  oneTimePassword?: string;
  /** Unsaved indicator (remote editor, config draft…). */
  dirty?: boolean;
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
