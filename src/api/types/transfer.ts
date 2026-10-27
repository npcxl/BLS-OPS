/**
 * 文件传输任务中心。
 *
 * 每个文件一个任务；任务表在后端内存里，面板关掉不会丢，重开面板能看到
 * 全量状态。进度通过 `transfer-progress` 事件推送（约每 4 MB 一次）。
 */
export type TransferKind = "upload" | "download";

export type TransferState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  /** 同名且策略为 skip：没有传输，但不算失败。 */
  | "skipped";

/** 同名文件处理方式。默认 `rename`，绝不静默覆盖。 */
export type ConflictPolicy = "overwrite" | "skip" | "rename";

export interface TransferTask {
  id: string;
  session_id: string;
  kind: TransferKind;
  name: string;
  /** 上传：本地路径；下载：远程路径。 */
  source: string;
  /** 上传：远程路径；下载：本地路径。 */
  target: string;
  total: number;
  transferred: number;
  state: TransferState;
  error?: string;
  created_at: number;
  updated_at: number;
}

/** 后端事件名（与 `transfer.rs` 的 `TRANSFER_EVENT` 保持一致）。 */
export const TRANSFER_EVENT = "transfer-progress";
