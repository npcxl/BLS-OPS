/**
 * Single source of truth for Tauri event names on the frontend.
 *
 * The Rust side builds the same names (e.g. `dirsize::DIR_SIZE_EVENT`,
 * `format!("ssh-output-{id}")` in `commands::ssh`); the templates here mirror
 * them exactly. Never change a string without the matching Rust emitter.
 */

/** Terminal stdout chunks for a session. Payload: `string`. */
export const sshOutputEvent = (sessionId: string) => `ssh-output-${sessionId}`;

/** Emitted when the transport for a session drops. Payload: `string` reason. */
export const sshClosedEvent = (sessionId: string) => `ssh-closed-${sessionId}`;

/** A service action ran; subscribers re-read the unit list. Payload: `string`. */
export const servicesChangedEvent = (sessionId: string) => `services-changed-${sessionId}`;

/** Final (and incremental, if ever) result of a project scan. Payload: `ProjectScanResult`. */
export const projectScanResultEvent = (scanId: string) => `project-scan-result-${scanId}`;

export { DIRECTORY_SIZE_EVENT } from "@/api/ops-api";
