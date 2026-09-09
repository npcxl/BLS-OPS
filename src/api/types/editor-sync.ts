/**
 * 本地编辑器同步域类型 —— 远程文件副本 → 本地编辑器（VSCode 等）打开 →
 * 保存自动 SFTP 回传。命令：`editor_sync_open/close/list`、
 * `editor_list_available`；事件：`editor-sync-update`
 * （src-tauri/src/editor_sync/，字段 camelCase、枚举值 snake_case 逐字一致）。
 */

/** 一个本机探测到的编辑器（未安装时 `available: false`）。 */
export interface EditorInfo {
  id: string;
  name: string;
  available: boolean;
  path: string | null;
}

/** 同步范围：单文件或整个目录。 */
export type EditorSyncScope = "file" | "directory";

/**
 * 会话状态：`starting` 极短窗口；`error` = 最近一次保存未同步（下一次保存
 * 成功自动回 active）；`closed` = 用户主动关闭后的终态。
 */
export type EditorSyncStatus = "starting" | "active" | "error" | "closed";

/** 一条同步会话的完整状态（事件载荷与命令返回共用）。 */
export interface SyncSessionInfo {
  id: string;
  /** 所属 SSH 会话。 */
  sessionId: string;
  scope: EditorSyncScope;
  /** 服务器上的根（文件或目录的绝对路径）。 */
  remotePath: string;
  /** 本地工作区绝对路径（单文件模式下是文件自身）。 */
  localPath: string;
  editorId: string;
  editorName: string;
  status: EditorSyncStatus;
  /** `error` 状态下的失败原因；其余状态为 null。 */
  message: string | null;
  /** 累计成功同步次数。 */
  syncCount: number;
  /** 最近一次成功同步的毫秒时间戳；0 = 从未。 */
  lastSyncAt: number;
  openedAt: number;
}

/** `editor-sync-update` 事件载荷。 */
export interface EditorSyncEventPayload {
  kind: string;
  session: SyncSessionInfo;
}
