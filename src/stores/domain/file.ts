/**
 * Files & SFTP domain — spec §21–§23.
 */

export type FileType = "file" | "directory" | "symlink" | "socket" | "block" | "char" | "fifo";

export interface RemoteFile {
  id: string;
  serverId: string;
  path: string;
  name: string;
  fileType: FileType;
  size: number;
  permissions: string;
  owner: string;
  group: string;
  modifiedAt: number;
  accessedAt: number;
  createdAt: number;
  children?: RemoteFile[];
}

// ============================================================================
// Transfer Task (spec §22)
// ============================================================================

export type TransferStatus = "pending" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export type TransferDirection = "upload" | "download";

export interface TransferTask {
  id: string;
  serverId: string;
  serverName: string;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  status: TransferStatus;
  progress: number; // 0-100
  speed: number; // bytes per second
  totalBytes: number;
  transferredBytes: number;
  eta?: number; // seconds
  startedAt: number;
  completedAt?: number;
  errorMessage?: string;
  retryCount: number;
}

// ============================================================================
// Remote Edit (spec §23)
// ============================================================================

export interface RemoteEditSession {
  id: string;
  serverId: string;
  filePath: string;
  localTempPath: string;
  originalContent: string;
  currentContent: string;
  status: "editing" | "saved" | "discarded";
  backupCreated: boolean;
  backupPath?: string;
  openedAt: number;
  savedAt?: number;
}
