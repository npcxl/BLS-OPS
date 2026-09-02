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
