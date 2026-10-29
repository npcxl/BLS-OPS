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
  /** P4 命令智能中心 — per-server, session-driven. */
  | "command_center"
  | "workflow"
  | "deployment"
  /** 数据库工作台：一个标签管理一个数据库连接（SQL + 表数据）。 */
  | "database";

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
  /** 数据库标签绑定的连接配置（`type === "database"`）。 */
  profileId?: string;
  /**
   * 「新建连接」的草稿标签：内容就是连接表单，保存成功后标签自动关闭并跳到
   * 该连接。用标签页而不是弹窗 —— 弹窗盖住列表，填完还要重新找位置。
   */
  draftNewConnection?: boolean;
  /** `user@host[:port]` typed into quick connect (no saved server). */
  quickTarget?: string;
  /** Credential chosen for a quick connect. */
  credentialId?: string;
  /**
   * Password typed for this one connection only. Held just long enough to open
   * the session; Rust discards it and never persists it.
   */
  oneTimePassword?: string;
  /**
   * 打开后自动 `cd` 到的远程目录（项目卡片右键「在命令面板中打开」）。
   * `nonce` 用来允许对同一个目录重复触发 —— 只看路径的话，第二次右键
   * 会因为依赖没变而不执行。
   */
  initialPath?: { path: string; nonce: number };
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
  /** P4 命令智能中心 — 命令知识库 + 检索 + 结构化结果。 */
  | "commands"
  /** 数据库工作台 — 左侧数据库资产，右侧每个标签一个连接。 */
  | "database"
  | "deploy"
  | "tasks"
  | "ai"
  | "settings";

export type SplitDirection = "horizontal" | "vertical";

export function isLeafPane(pane: WorkbenchPane): boolean {
  return !pane.children || pane.children.length === 0;
}
