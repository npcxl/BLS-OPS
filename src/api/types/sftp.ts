/** SFTP listings and on-demand directory-size computation types. */

/** One entry of a remote directory listing, read over the SFTP subsystem. */
export interface RemoteFileEntry {
  name: string;
  /** Absolute remote POSIX path. */
  path: string;
  /** `directory` | `file` | `symlink` | `other`. */
  kind: string;
  size: number;
  modified_at?: number | null;
  /** `rwxr-xr-x` style, as reported by the server. */
  permissions?: string | null;
  hidden: boolean;
}

/**
 * Payload of `sftp_read_binary`: the raw bytes of any remote file, base64
 * encoded, used by the file preview. Not limited to text — images, PDFs,
 * Office files and archives all travel through here.
 */
export interface RemoteBinaryContent {
  /** Canonical remote path the bytes came from. */
  path: string;
  /** Full remote size, even when the payload was truncated. */
  size: number;
  /** MIME type guessed from the file name by the backend. */
  mime: string;
  /** Base64 of the returned bytes. */
  data: string;
  /** True when the file exceeded the requested budget. */
  truncated: boolean;
}

export interface SftpListResult {
  /** The canonical path that was actually read (server-resolved). */
  path: string;
  entries: RemoteFileEntry[];
}

/**
 * 文件的版本指纹。
 *
 * 冲突判断**只看 `sha256`**：`modified_at` 会被 `touch`、部署脚本、rsync
 * 随手改写，单看时间戳既会误报也会漏报。
 */
export interface RemoteFileVersion {
  size: number;
  modified_at?: number | null;
  sha256: string;
}

/** `sftp_save_editor_file` 的结果：写入成功，或发现文件已被别人改过。 */
export type SaveFileOutcome =
  | { status: "saved"; version: RemoteFileVersion }
  | { status: "conflict"; current?: RemoteFileVersion | null };

/** 一份本机保存的历史版本（保存前被覆盖的内容）。 */
export interface EditorHistoryEntry {
  id: string;
  saved_at: number;
  size: number;
}

/** Lifecycle of a single directory-size computation. */
export type DirectorySizeStatus =
  | "pending"
  | "computing"
  | "completed"
  | "partial"
  | "permission_denied"
  | "cancelled"
  | "timed_out"
  | "session_gone"
  | "failed";

/**
 * Result of an on-demand directory-size computation. Pushed over the
 * `directory-size-update` event as it progresses, and returned by
 * `directorySizeStatus`. Folders do not report a size via SFTP (only their
 * own metadata, ~4096 B), so this is the only honest way to learn a folder's
 * total content size.
 */
export interface DirectorySizeResult {
  sessionId: string;
  path: string;
  /** Total bytes of regular files under `path` (symlink targets excluded). */
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  /** Entries skipped because of an error (permission denied, unreadable, …). */
  skippedCount: number;
  status: DirectorySizeStatus;
  /** `true` once the computation has reached a terminal state. */
  complete: boolean;
  calculatedAt: number;
}

/** Tauri event name carrying `DirectorySizeResult` updates. */
export const DIRECTORY_SIZE_EVENT = "directory-size-update";
