/**
 * 文件传输任务中心。
 *
 * 每个文件一个任务；任务表在后端内存里，面板关掉不会丢，重开面板能看到
 * 全量状态。进度通过 `transfer-progress` 事件推送（后端按时间节流，约 250ms
 * 一次），事件与列表快照都带 `attempt` / `revision`：
 *
 * - `attempt`：第几次尝试。重试 +1，新一轮允许从 0 重新开始；
 * - `revision`：同一任务内单调递增。前端据此丢弃**迟到的旧事件 / 旧快照**，
 *   进度与终态都只能往前走。
 */
export type TransferKind = "upload" | "download";

export type TransferState =
  | "queued"
  | "running"
  /** 字节已传完，正在关闭句柄 / 原子改名 —— 还不是成功。 */
  | "finalizing"
  /** 已请求取消，等执行器给出最终结果。 */
  | "cancelling"
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
  /** 总大小是否已知。空文件是「已知的 0」，不是未知。 */
  size_known: boolean;
  state: TransferState;
  error?: string;
  /** 同一批多文件上传共用一个批次号（界面折叠成摘要）。 */
  batch_id: string;
  /** 第几次尝试，重试 +1。 */
  attempt: number;
  /** 单调递增的版本号。 */
  revision: number;
  created_at: number;
  updated_at: number;
}

/** 后端事件名（与 `transfer.rs` 的 `TRANSFER_EVENT` 保持一致）。 */
export const TRANSFER_EVENT = "transfer-progress";
