/**
 * P5.1 auto-update domain types.
 *
 * Only the official Tauri updater plugin is used: the frontend never downloads
 * an installer itself and never runs one — `downloadAndInstall` is the single
 * place where bytes land on disk and where the signature is verified.
 */

/**
 * The update state machine.
 *
 * `idle → checking → (up_to_date | available)`
 * `available → downloading → installing → restart_required`
 * any in-flight step → `cancelled` (user) or `error` (failure).
 *
 * There is no "downloaded" state: on Windows the installer is launched as soon
 * as the package is verified, and on macOS/Linux the binary is replaced in
 * place, so the only meaningful terminal states are "restart required" or
 * "failed".
 */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "installing"
  | "restart_required"
  | "cancelled"
  | "error";

/** A release the updater offered us. */
export interface UpdateRelease {
  version: string;
  /** Installed version, as reported by the backend — never guessed. */
  currentVersion: string;
  /** Release notes; `null` when the release carries none. */
  notes: string | null;
  /** ISO-8601 publish date; `null` when the release carries none. */
  date: string | null;
}

/**
 * Download progress.
 *
 * `total` is `null` when the server did not send a `Content-Length` — the UI
 * must then show bytes only instead of inventing a 100% bar.
 */
export interface UpdateProgress {
  received: number;
  total: number | null;
}

/** Why an update attempt failed. Each code maps to one user-facing message. */
export type UpdateErrorCode =
  | "network"
  | "timeout"
  | "malformed_manifest"
  | "no_platform_asset"
  | "signature_missing"
  | "signature_invalid"
  | "download_interrupted"
  | "disk_full"
  | "install_failed"
  | "cancelled"
  | "restart_failed"
  | "unsupported_build"
  | "unknown";

/** A classified failure: user-facing code plus the sanitised dev log line. */
export interface UpdateError {
  code: UpdateErrorCode;
  /** Raw message for the console only — already stripped of local paths. */
  detail: string;
}
