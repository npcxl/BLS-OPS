/**
 * The single bridge between the WebView and the Tauri backend.
 *
 * During the modularisation pass (docs/模块化重构分析.md §阶段 B) the domain
 * types moved to `src/api/types/*.ts` grouped by domain. They are re-exported
 * here unchanged so every existing `from "@/api/ops-api"` import keeps
 * working. New code may import from either place; keep the re-exports in sync
 * when adding types.
 */
import { invoke } from "@tauri-apps/api/core";

import {
  type CommandCatalogMeta,
  type CommandExecutionResult,
  type CommandParams,
  type CommandSearchHit,
} from "@/api/types/command";
import {
  type CascadeResult,
  type CredentialDeleteResult,
  type CredentialRecord,
  type KnownHostRecord,
  type ServerGroupRecord,
  type ServerRecord,
} from "@/api/types/servers";
import {
  type AppInfo,
  type AuditLogRecord,
  type CommandHistoryRecord,
  type SessionRecord,
  type SessionStats,
} from "@/api/types/sessions";
import { type SshConnectResult } from "@/api/types/ssh";
import {
  type DirectorySizeResult,
  type RemoteBinaryContent,
  type RemoteFileEntry,
  type SftpListResult,
} from "@/api/types/sftp";
import {
  type CpuMetrics,
  type DiskMetrics,
  type MemoryMetrics,
  type MonitorSnapshot,
  type NetworkMetrics,
  type ProcessInfo,
  type SystemInfo,
} from "@/api/types/monitor";
import {
  type JournalDiskUsage,
  type JournalEntry,
  type ServiceActionName,
  type ServiceUnit,
} from "@/api/types/services";
import {
  type ContainerActionName,
  type DockerSnapshot,
} from "@/api/types/containers";
import {
  type NginxSaveResult,
  type NginxSite,
  type NginxTestResult,
} from "@/api/types/gateway";
import {
  type ConfirmedProject,
  type DeploymentRecord,
  type ProjectRecord,
  type ProjectReadinessReport,
  type ProjectReviewRecord,
  type ProjectScanResult,
  type ProjectScanStatus,
  type ReviewState,
} from "@/api/types/project";

// -- Domain types (re-exported; previously defined in this file) ------------
export {
  CREDENTIAL_TYPES,
  type CascadeResult,
  type CredentialDeleteResult,
  type CredentialRecord,
  type KnownHostRecord,
  type ServerGroupRecord,
  type ServerRecord,
} from "@/api/types/servers";
export {
  type AppInfo,
  type AuditLogRecord,
  type CommandHistoryRecord,
  type SessionRecord,
  type SessionStats,
} from "@/api/types/sessions";
export { parseSshTarget, type SshConnectResult } from "@/api/types/ssh";
export {
  DIRECTORY_SIZE_EVENT,
  type DirectorySizeResult,
  type DirectorySizeStatus,
  type RemoteBinaryContent,
  type RemoteFileEntry,
  type SftpListResult,
} from "@/api/types/sftp";
export {
  type CpuMetrics,
  type DiskMetrics,
  type MemoryMetrics,
  type MonitorSnapshot,
  type NetworkMetrics,
  type ProcessInfo,
  type SystemInfo,
} from "@/api/types/monitor";
export {
  JOURNAL_PRIORITIES,
  priorityLabel,
  type JournalDiskUsage,
  type JournalEntry,
  type ServiceActionName,
  type ServiceUnit,
} from "@/api/types/services";
export {
  type ContainerActionName,
  type ContainerInfo,
  type ContainerStats,
  type DockerSnapshot,
  type ImageInfo,
} from "@/api/types/containers";
export {
  type NginxSaveResult,
  type NginxSite,
  type NginxSource,
  type NginxTestResult,
} from "@/api/types/gateway";
export {
  DEPLOY_STATUSES,
  deployStatusLabel,
  projectSteps,
  type ClassificationConfidence,
  type ClassificationEvidence,
  type ComponentRole,
  type ConfirmedProject,
  type ConfirmedScanState,
  type CandidateCategory,
  type CandidateInstance,
  type ConfidenceLevel,
  type DeploymentInstance,
  type DeploymentReadiness,
  type DeploymentRecord,
  type DetectedService,
  type DetectedTechnology,
  type GatewayRoute,
  type InfrastructureCategory,
  type InstanceOwnership,
  type InstanceRuntime,
  type ProjectCandidate,
  type ProjectEvidence,
  type ProjectKind,
  type ProjectModule,
  type ProjectPenalty,
  type ProjectRecord,
  type ProjectScanResult,
  type ProjectScanStatus,
  type ProjectReadinessReport,
  type DiscoveryStatus,
  type ProjectReviewRecord,
  type ReadinessCheck,
  type ReadinessConclusion,
  type ReviewState,
  type RuntimeKind,
  type RuntimeLink,
  type ScanProgress,
  type ScanState,
  type ServerCapabilityProfile,
  type ServiceGroup,
  type WorkloadRole,
} from "@/api/types/project";

function message(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}

export {
  MUTABILITY_LABELS,
  RISK_META,
  type CommandCatalogMeta,
  type CommandCategory,
  type CommandExecutionResult,
  type CommandParams,
  type CommandRawOutput,
  type CommandSearchHit,
  type CommandStructuredOutput,
  type DiskRow,
  type DockerContainerRow,
  type JournalEntryRow,
  type ListenerRow,
  type Mutability,
  type NginxSiteRow,
  type ProcessRow,
  type RiskLevel,
  type SystemdUnitRow,
} from "@/api/types/command";

export { message as toErrorMessage };

export const opsApi = {
  appInfo: () => invoke<AppInfo>("app_info"),

  listServers: () => invoke<ServerRecord[]>("server_list"),
  getServer: (id: string) => invoke<ServerRecord | null>("server_get", { id }),
  saveServer: (server: ServerRecord) => invoke<ServerRecord>("server_save", { server }),
  deleteServer: (id: string) => invoke<CascadeResult>("server_delete", { id }),
  setServerFavorite: (id: string, favorite: boolean) =>
    invoke<void>("server_set_favorite", { id, favorite }),
  testConnection: (serverId: string) =>
    invoke<SshConnectResult>("server_test_connection", { serverId }),

  listGroups: () => invoke<ServerGroupRecord[]>("group_list"),
  saveGroup: (group: ServerGroupRecord) => invoke<ServerGroupRecord>("group_save", { group }),
  deleteGroup: (id: string) => invoke<void>("group_delete", { id }),

  listCredentials: () => invoke<CredentialRecord[]>("credential_list"),
  saveCredential: (
    credential: CredentialRecord,
    secret?: string,
    passphrase?: string,
  ) => invoke<CredentialRecord>("credential_save", { credential, secret, passphrase }),
  deleteCredential: (id: string, force = false) =>
    invoke<CredentialDeleteResult>("credential_delete", { id, force }),

  listKnownHosts: () => invoke<KnownHostRecord[]>("known_host_list"),
  getKnownHost: (host: string, port: number) =>
    invoke<KnownHostRecord | null>("known_host_get", { host, port }),
  deleteKnownHost: (id: string) => invoke<boolean>("known_host_delete", { id }),
  trustKnownHost: (
    host: string,
    port: number,
    fingerprint: string,
    fingerprintType: string,
    trust: boolean,
  ) =>
    invoke<KnownHostRecord | null>("known_host_trust", {
      host,
      port,
      fingerprint,
      fingerprintType,
      trust,
    }),

  listSessions: (limit = 20) => invoke<SessionRecord[]>("session_list", { limit }),
  sessionStats: () => invoke<SessionStats>("session_stats"),

  recordHistory: (sessionId: string, serverId: string, serverName: string, command: string) =>
    invoke<void>("history_record", { sessionId, serverId, serverName, command }),
  listHistory: (limit = 100) => invoke<CommandHistoryRecord[]>("history_list", { limit }),
  listAuditLogs: (limit = 100) => invoke<AuditLogRecord[]>("audit_log_list", { limit }),

  sshConnect: (args: {
    sessionId: string;
    serverId?: string;
    target?: string;
    credentialId?: string;
    /** One-time password: used for this connection, never persisted by Rust. */
    password?: string;
    cols?: number;
    rows?: number;
  }) =>
    invoke<SshConnectResult>("ssh_connect", {
      sessionId: args.sessionId,
      serverId: args.serverId ?? null,
      target: args.target ?? null,
      credentialId: args.credentialId ?? null,
      password: args.password ?? null,
      cols: args.cols ?? 120,
      rows: args.rows ?? 32,
    }),
  /**
   * Opens a session for monitoring: authenticated, but without a PTY or shell.
   * Metrics are read with fixed read-only commands on short-lived exec
   * channels, so nothing occupies a shell on the server.
   */
  sshConnectMonitor: (args: {
    sessionId: string;
    serverId?: string;
    target?: string;
    credentialId?: string;
    password?: string;
  }) =>
    invoke<SshConnectResult>("ssh_connect_monitor", {
      sessionId: args.sessionId,
      serverId: args.serverId ?? null,
      target: args.target ?? null,
      credentialId: args.credentialId ?? null,
      password: args.password ?? null,
    }),
  sshInput: (sessionId: string, data: string) => invoke<void>("ssh_input", { sessionId, data }),
  sshResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("ssh_resize", { sessionId, cols, rows }),
  sshKeepalive: (sessionId: string) => invoke<void>("ssh_keepalive", { sessionId }),
  sshStatus: (sessionId: string) => invoke<boolean>("ssh_status", { sessionId }),
  sshDisconnect: (sessionId: string) => invoke<void>("ssh_disconnect", { sessionId }),

  // SFTP — remote file browsing + management over the live session. Each
  // session owns its own SFTP client, so tabs never share directory state.
  sftpOpen: (sessionId: string) => invoke<string>("sftp_open", { sessionId }),
  sftpListDir: (sessionId: string, path?: string) =>
    invoke<SftpListResult>("sftp_list_dir", { sessionId, path: path ?? null }),
  sftpRealpath: (sessionId: string, path: string) =>
    invoke<string>("sftp_realpath", { sessionId, path }),
  sftpStat: (sessionId: string, path: string) =>
    invoke<RemoteFileEntry>("sftp_stat", { sessionId, path }),
  sftpUpload: (sessionId: string, localPaths: string[], remoteDir: string) =>
    invoke<RemoteFileEntry[]>("sftp_upload", {
      sessionId,
      localPaths,
      remoteDir,
    }),
  sftpRemove: (sessionId: string, path: string) =>
    invoke<void>("sftp_remove", { sessionId, path }),
  sftpRename: (sessionId: string, path: string, newName: string) =>
    invoke<string>("sftp_rename", { sessionId, path, newName }),
  sftpCopy: (sessionId: string, path: string, newName: string) =>
    invoke<string>("sftp_copy", { sessionId, path, newName }),
  sftpMkdir: (sessionId: string, path: string) =>
    invoke<string>("sftp_mkdir", { sessionId, path }),
  sftpTouch: (sessionId: string, path: string) =>
    invoke<string>("sftp_touch", { sessionId, path }),
  /** Reads a remote file for the in-app editor (text files, size-capped). */
  sftpReadFile: (sessionId: string, path: string) =>
    invoke<{ path: string; size: number; binary: boolean; content: string | null }>(
      "sftp_read_file",
      { sessionId, path },
    ),
  /** Overwrites a remote text file (editor save). */
  sftpWriteFile: (sessionId: string, path: string, content: string) =>
    invoke<void>("sftp_write_file", { sessionId, path, content }),
  sftpClose: (sessionId: string) => invoke<void>("sftp_close", { sessionId }),
  /** Reads any remote file as base64 bytes for the in-app preview. */
  sftpReadBinary: (sessionId: string, path: string, maxLen?: number) =>
    invoke<RemoteBinaryContent>("sftp_read_binary", {
      sessionId,
      path,
      maxLen: maxLen ?? null,
    }),
  /** Streams a remote file to a local path (preview dialog's 下载 action). */
  sftpDownloadFile: (sessionId: string, path: string, localPath: string) =>
    invoke<number>("sftp_download_file", { sessionId, path, localPath }),

  // Monitoring — read-only Linux metrics. `monitor_snapshot` is the one the
  // page polls: every headline metric in a single round trip.
  monitorSystemInfo: (sessionId: string) =>
    invoke<SystemInfo>("monitor_system_info", { sessionId }),
  monitorCpu: (sessionId: string) => invoke<CpuMetrics>("monitor_cpu", { sessionId }),
  monitorMemory: (sessionId: string) => invoke<MemoryMetrics>("monitor_memory", { sessionId }),
  monitorDisks: (sessionId: string) => invoke<DiskMetrics[]>("monitor_disks", { sessionId }),
  monitorNetwork: (sessionId: string) => invoke<NetworkMetrics[]>("monitor_network", { sessionId }),
  monitorProcesses: (sessionId: string) => invoke<ProcessInfo[]>("monitor_processes", { sessionId }),
  monitorSnapshot: (sessionId: string) =>
    invoke<MonitorSnapshot>("monitor_snapshot", { sessionId }),

  // -- Command centre (P4) ----------------------------------------------------
  commandSearch: (query: string, limit = 12) =>
    invoke<CommandSearchHit[]>("command_search", { query, limit: limit ?? undefined }),
  commandExecute: (sessionId: string, knowledgeId: string, params?: CommandParams) =>
    invoke<CommandExecutionResult>("command_execute", {
      sessionId,
      knowledgeId,
      params: params ?? null,
    }),
  /** 探测服务器上真实存在的工具（返回入参的存在子集，用于置灰提示）。 */
  commandProbeTools: (sessionId: string, tools: string[]) =>
    invoke<string[]>("command_probe_tools", { sessionId, tools }),
  commandToggleFavorite: (knowledgeId: string) =>
    invoke<boolean>("command_toggle_favorite", { knowledgeId }),
  commandFavorites: () => invoke<string[]>("command_favorites"),
  commandCatalogMeta: () => invoke<CommandCatalogMeta>("command_catalog_meta"),

  // -- Project discovery ----------------------------------------------------
  projectScanStart: (sessionId: string, serverId: string, incremental = false) =>
    invoke<ProjectScanStatus>("project_scan_start", { sessionId, serverId, incremental }),  projectScanCancel: (scanId: string) => invoke<boolean>("project_scan_cancel", { scanId }),
  projectScanStatus: (scanId: string) =>
    invoke<ProjectScanStatus | null>("project_scan_status", { scanId }),
  projectScanResult: (scanId: string) =>
    invoke<ProjectScanResult | null>("project_scan_result", { scanId }),
  /** 写入一条人工复核结论（确认项目 / 忽略目录），按 (serverId, path) 存库。
   *  确认时必须随附当前 `ProjectCandidate` 的完整快照，以便后续扫描即使没再
   *  发现该路径也能继续保留项目。 */
  projectReviewSet: (
    serverId: string,
    path: string,
    review: ReviewState,
    name?: string,
    projectType?: string,
    note?: string,
    candidatePayload?: string,
  ) =>
    invoke<ProjectReviewRecord>("project_review_set", {
      serverId,
      path,
      review,
      name,
      projectType,
      note,
      candidatePayload,
    }),
  /** 列出某台服务器上全部人工复核结论。 */
  projectReviewList: (serverId: string) =>
    invoke<ProjectReviewRecord[]>("project_review_list", { serverId }),
  /** 列出某台服务器上全部持久化已确认项目（含完整快照与扫描状态）。 */
  projectConfirmedList: (serverId: string) =>
    invoke<ConfirmedProject[]>("confirmed_projects_list", { serverId }),
  /** 人工合并/拆分项目：parentPath 为 null 表示把 childPath 拆分回独立目录。 */
  projectMergeSet: (serverId: string, childPath: string, parentPath: string | null) =>
    invoke<void>("project_merge_set", {
      serverId,
      childPath,
      parentPath: parentPath ?? null,
    }),
  /** 针对单个项目做部署准备检查（项目级，替代全局可行性图谱）。 */
  projectReadinessCheck: (serverId: string, scanId: string, candidatePath: string) =>
    invoke<ProjectReadinessReport>("project_readiness_check", {
      serverId,
      scanId,
      candidatePath,
    }),
  /** 打开"服务器项目"时立即返回上次扫描快照，不依赖实时连接。 */
  projectInventoryLoad: (serverId: string) =>
    invoke<ProjectScanResult | null>("project_inventory_load", { serverId }),

  // -- Services (systemd) ---------------------------------------------------
  serviceList: (sessionId: string) => invoke<ServiceUnit[]>("service_list", { sessionId }),
  /**
   * Start / stop / restart / reload / enable / disable.
   *
   * Only the fixed verb and a validated unit name are sent — the command
   * string itself is built in Rust.
   */
  serviceAction: (sessionId: string, action: ServiceActionName, unit: string) =>
    invoke<string>("service_action", { sessionId, action, unit }),
  serviceStatus: (sessionId: string, unit: string) =>
    invoke<string>("service_status", { sessionId, unit }),

  // -- Log centre (journald) ------------------------------------------------
  journalQuery: (args: {
    sessionId: string;
    unit?: string | null;
    lines: number;
    priority?: number | null;
  }) =>
    invoke<JournalEntry[]>("journal_query", {
      sessionId: args.sessionId,
      unit: args.unit ?? null,
      lines: args.lines,
      priority: args.priority ?? null,
    }),
  journalDiskUsage: (sessionId: string) =>
    invoke<JournalDiskUsage>("journal_disk_usage", { sessionId }),

  // -- Docker ---------------------------------------------------------------
  dockerSnapshot: (sessionId: string) => invoke<DockerSnapshot>("docker_snapshot", { sessionId }),
  dockerLogs: (sessionId: string, container: string, lines: number) =>
    invoke<string>("docker_logs", { sessionId, container, lines }),
  dockerContainerAction: (
    sessionId: string,
    action: ContainerActionName,
    container: string,
  ) => invoke<string>("docker_container_action", { sessionId, action, container }),
  dockerImageRemove: (sessionId: string, image: string) =>
    invoke<string>("docker_image_remove", { sessionId, image }),
  dockerPrune: (sessionId: string) => invoke<string>("docker_prune", { sessionId }),

  // -- Nginx ----------------------------------------------------------------
  nginxSites: (sessionId: string) => invoke<NginxSite[]>("nginx_sites", { sessionId }),
  nginxConfig: (sessionId: string, path: string) =>
    invoke<string>("nginx_config", { sessionId, path }),
  /** Writes, validates, and reloads only when the config tests clean. */
  nginxSaveConfig: (sessionId: string, path: string, content: string) =>
    invoke<NginxSaveResult>("nginx_save_config", { sessionId, path, content }),
  nginxTest: (sessionId: string) => invoke<NginxTestResult>("nginx_test", { sessionId }),
  nginxReload: (sessionId: string) => invoke<string>("nginx_reload", { sessionId }),
  nginxSetSiteEnabled: (sessionId: string, site: string, enable: boolean) =>
    invoke<string>("nginx_set_site_enabled", { sessionId, site, enable }),

  // -- Legacy project records (P5 foundation) -------------------------------
  projectList: () => invoke<ProjectRecord[]>("project_list"),
  projectGet: (id: string) => invoke<ProjectRecord | null>("project_get", { id }),
  projectSave: (project: ProjectRecord) => invoke<ProjectRecord>("project_save", { project }),
  projectDelete: (id: string) => invoke<number>("project_delete", { id }),

  deploymentList: (projectId?: string, limit = 50) =>
    invoke<DeploymentRecord[]>("deployment_list", { projectId: projectId ?? null, limit }),
  deploymentGet: (id: string) => invoke<DeploymentRecord | null>("deployment_get", { id }),
  /**
   * Runs a project's recorded steps. Only the project id crosses the bridge —
   * the steps themselves come from SQLite and are re-validated in Rust.
   *
   * Pass `deploymentId` to subscribe to `deploy-progress-<id>` before the run
   * starts, so no early output is missed.
   */
  deploymentExecute: (args: {
    projectId: string;
    sessionId: string;
    deploymentId?: string;
  }) =>
    invoke<DeploymentRecord>("deployment_execute", {
      projectId: args.projectId,
      sessionId: args.sessionId,
      deploymentId: args.deploymentId ?? null,
    }),

  // -- Directory size (on-demand, background) ------------------------------
  /**
   * Starts computing the size of a remote directory in the background.
   * Progress and the final result arrive via the `directory-size-update`
   * event; a second call for the same path replays the current state.
   */
  directorySizeStart: (sessionId: string, path: string, timeoutMs?: number, force = false) =>
    invoke<DirectorySizeResult>("directory_size_start", {
      sessionId,
      path,
      timeoutMs: timeoutMs ?? null,
      force,
    }),
  /** Asks a running computation to stop. */
  directorySizeCancel: (sessionId: string, path: string) =>
    invoke<void>("directory_size_cancel", { sessionId, path }),
  /** Current (or last) computation snapshot for a path, or `null`. */
  directorySizeStatus: (sessionId: string, path: string) =>
    invoke<DirectorySizeResult | null>("directory_size_status", { sessionId, path }),
  /**
   * Low-frequency watchdog fallback for the file panel: batched read-only
   * snapshot (max 20 paths) of computations that have not finished yet. Never
   * starts a computation — the `directory-size-update` event stays the primary
   * update channel.
   */
  directorySizeStatusMany: (sessionId: string, paths: string[]) =>
    invoke<DirectorySizeResult[]>("directory_size_status_many", { sessionId, paths }),
};
