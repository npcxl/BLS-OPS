/**
 * Single source of truth for Tauri event names on the frontend.
 *
 * The Rust side builds the same names (e.g. `dirsize::DIR_SIZE_EVENT`,
 * `format!("ssh-output-{id}")` in `commands::ssh`); the templates here mirror
 * them exactly. Never change a string without the matching Rust emitter.
 */

/** Terminal stdout chunks for a session. Payload: `string`. */
export const sshOutputEvent = (sessionId: string) => `ssh-output-${sessionId}`;

/**
 * Terminal **stderr** chunks for a session. Payload: `string`.
 *
 * 与 stdout 分开：两条流在 Rust 侧各有独立的流式解码器（字节边界互不
 * 相干），事件也必须分开，否则命令结果里的 stderr 永远是空的。
 */
export const sshStderrEvent = (sessionId: string) => `ssh-stderr-${sessionId}`;

/** Emitted when the transport for a session drops. Payload: `string` reason. */
export const sshClosedEvent = (sessionId: string) => `ssh-closed-${sessionId}`;

/** A service action ran; subscribers re-read the unit list. Payload: `string`. */
export const servicesChangedEvent = (sessionId: string) => `services-changed-${sessionId}`;

/** Final (and incremental, if ever) result of a project scan. Payload: `ProjectScanResult`. */
export const projectScanResultEvent = (scanId: string) => `project-scan-result-${scanId}`;

/**
 * Local-editor sync session status change (open/save/close/error).
 * Payload: `EditorSyncEventPayload`. Rust emitter: `editor_sync::EDITOR_SYNC_EVENT`.
 */
export const editorSyncEvent = "editor-sync-update";

/**
 * P5.1 制品导入任务的进度 / 结果。Payload: `ArtifactImportTask`。
 *
 * Rust 侧由 `commands::deployment_center::artifact_import_event` 拼同一个名字。
 * 每条任务一个事件名（任务 id 进名字），因此并发导入互不干扰。
 */
export const artifactImportEvent = (taskId: string) => `deployment-artifact-import-${taskId}`;

/**
 * P5.3 部署运行的进度 / 结果。Payload: `DeploymentRunDetail`。
 *
 * **按环境订阅**（不是按运行 id）：用户盯的是"这个环境现在怎么样"，而不是
 * 某一次运行的 id。Rust 侧由 `commands::deployment_run::deployment_run_event`
 * 拼同一个名字。
 */
export const deploymentRunEvent = (environmentId: string) => `deployment-run-env-${environmentId}`;

export { DIRECTORY_SIZE_EVENT } from "@/api/ops-api";
