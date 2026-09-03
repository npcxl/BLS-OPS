/**
 * Workbench core types — spec §10, §12, §14.
 *
 * Tab types are extensible: "home" is the Workbench landing view (§28),
 * the rest are the first-class workspace tab kinds (§12).
 */
export type WorkspaceTabType =
  | "home"
  | "module"
  | "terminal"
  | "server"
  /** Read-only Linux monitoring for one server — runs on its own session. */
  | "monitor"
  /** P3 management modules. Each opens its own non-interactive session. */
  | "service"
  | "logs"
  | "project"
  | "workflow"
  | "deployment";

export interface WorkspaceTab {
  id: string;
  type: WorkspaceTabType;
  title: string;
  subtitle?: string;
  /** Module page this tab shows, when `type === "module"`. */
  module?: NavModule;
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
  /** systemd 服务管家 — per-server, session-driven. */
  | "services"
  /** journald 日志中心 — per-server, session-driven. */
  | "logs"
  | "projects"
  | "deploy"
  | "tasks"
  | "ai"
  | "settings";

export type SplitDirection = "horizontal" | "vertical";

export function isLeafPane(pane: WorkbenchPane): boolean {
  return !pane.children || pane.children.length === 0;
}
