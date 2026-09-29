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
import { type SshConnectResult, type TerminalEncoding } from "@/api/types/ssh";
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
import type { NginxEnvironment } from "@/api/types/environment";
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
import {
  type ArtifactConfirmOutcome,
  type ArtifactImportConfirmation,
  type ArtifactImportStartRequest,
  type ArtifactImportTask,
  type ArtifactRecord,
  type CapacityProfile,
  type ConfigDefinition,
  type DeploymentApplication,
  type DeploymentCascadeResult,
  type DeploymentEnvironment,
  type DeploymentPlan,
  type DeploymentPlanGraph,
  type DeploymentProposal,
  type DeploymentRun,
  type DeploymentRunDetail,
  type DeploymentSecurityPolicy,
  type DeploymentServiceUnit,
  type DomainBinding,
  type ProposalOutcome,
  type ReleaseRecord,
  type SecretRef,
  type ServiceRelation,
} from "@/api/types/deployment";

// P5.3 / P5.4 / P5.5 的载荷类型：既要在本文件里用于 `invoke<T>()` 的泛型，
// 也要再导出给页面用，所以这里单独 import 一次（下面那一段是 re-export）。
import {
  type CertificatePlan,
  type DnsGuidance,
  type PreflightOutcome,
  type AiProviderSaveRequest,
  type AiProviderTestResult,
  type AiProviderView,
  type AiReviewTask,
  type KnowledgeDocument,
  type KnowledgeHit,
  type KnowledgeQueryInput,
  type KnowledgeUsageRecord,
  type KnowledgeVersion,
} from "@/api/types/deployment";

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
export type { VscodeOpenResult } from "@/api/types/vscode";
export {
  type EditorInfo,
  type EditorSyncEventPayload,
  type EditorSyncScope,
  type EditorSyncStatus,
  type SyncSessionInfo,
} from "@/api/types/editor-sync";
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
  NGINX_KIND_LABELS,
  configMounts,
  describeContainer,
  publishedPorts,
  type ComposeRef,
  type MountInfo,
  type NginxContainer,
  type NginxEnvironment,
  type NginxFlavor,
  type NginxKind,
  type PortBinding,
  type SuggestedCommand,
  type SuggestedRisk,
} from "@/api/types/environment";
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
import { type VscodeOpenResult } from "@/api/types/vscode";
import { type EditorInfo, type SyncSessionInfo } from "@/api/types/editor-sync";

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
  type ResultColumn,
  type ResultSection,
  type ResultSummary,
  type ResultView,
  type StructuredCommandResult,
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

// P5.0 智能部署中心（结构化模型；`ServiceUnit` 在此重命名为
// `DeploymentServiceUnit`，避免与 systemd 的 `ServiceUnit` 撞名）。
export {
  type ApplicationKind,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactSourceKind,
  type ArtifactStatus,
  type CapacityProfile,
  type ConfigDataType,
  type ConfigDefinition,
  type ConfigScope,
  type ConfigSourceKind,
  type DeploymentApplication,
  type DeploymentCascadeResult,
  type DeploymentEnvironment,
  type DeploymentPlan,
  type DeploymentPlanGraph,
  type DeploymentRun,
  type DeploymentRunDetail,
  type DeploymentServiceUnit,
  type DnsStatus,
  type DomainBinding,
  type EdgeCondition,
  type EnvironmentKind,
  type EstimationBasis,
  type FailurePolicy,
  type PlanActionKind,
  type PlanEdge,
  type PlanNode,
  type PlanRiskLevel,
  type PlanStatus,
  type PortMapping,
  type PortProtocol,
  type ProposalSource,
  type ReleaseRecord,
  type ReleaseStatus,
  type RunNode,
  type RunNodeStatus,
  type RunStatus,
  type RunTrigger,
  type SecretRef,
  type SecretStoreKind,
  type ServiceKind,
  type ServiceRelation,
  type ServiceRelationKind,
  type ServiceRole,
  type ServiceRuntime,
  type SslMode,
  type SslStatus,
  type SourceKind,
  // -- P5.1 制品导入（前缀 `Artifact` 避免与项目识别/监控等模块撞名）--
  type ArtifactBuildStep,
  type ArtifactCheckState,
  type ArtifactConfirmOutcome,
  type ArtifactDependencyGuess,
  type ArtifactDependencyKind,
  type ArtifactEnvKeyGuess,
  type ArtifactFindingKind,
  type ArtifactFindingSeverity,
  type ArtifactFingerprint,
  type ArtifactFingerprintBasis,
  type ArtifactHealthGuess,
  type ArtifactHealthKind,
  type ArtifactImportConfirmation,
  type ArtifactImportProgress,
  type ArtifactImportSource,
  type ArtifactImportStage,
  type ArtifactImportStartRequest,
  type ArtifactImportStatus,
  type ArtifactImportTask,
  type ArtifactInspection,
  type ArtifactInspectionCheck,
  type ArtifactPackageManager,
  type ArtifactPortGuess,
  type ArtifactRedactedEvidence,
  type ArtifactSecurityFinding,
  type ArtifactSecurityReport,
  type ArtifactServiceCandidate,
  type ArtifactStackLanguage,
  type ArtifactStackProfile,
  type ArtifactStartOption,
  // -- P5.2 部署方案（前缀 `Proposal` / `Deployment` 避免撞名）--
  type DeploymentProposal,
  type DeploymentSecurityPolicy,
  type ProposalAiReview,
  type ProposalCapacity,
  type ProposalDependency,
  type ProposalDomain,
  type ProposalEvidence,
  type ProposalEvidenceClass,
  type ProposalEvidenceSource,
  type ProposalFingerprint,
  type ProposalInputSnapshot,
  type ProposalKnowledgeConflict,
  type ProposalKnowledgeReference,
  type ProposalOutcome,
  type ProposalRisk,
  type ProposalRollback,
  type ProposalService,
  type ProposalStatement,
  type ProposalStatus,
  type ProposalSummary,
  type ProposalTopologyKind,
  type ProposalTopologyOption,
  type ProposalUnknown,
  type ProposalUnknownSeverity,
  type ProposalValidation,
  type ProposalViolation,
  type ProposalViolationKind,
  type ProposalWorkflow,
  // -- P5.3 / P5.4 执行与 DNS·SSL 指导 --
  type CertificatePlan,
  type DnsGuidance,
  type PreflightOutcome,
  type RunActionKind,
  type RunActionPhase,
  // -- P5.5 AI 提供方与知识库（供页面 import）--
  type AiProviderKind,
  type AiProviderSaveRequest,
  type AiProviderTestResult,
  type AiProviderView,
  type AiReviewTask,
  type AiTaskStatus,
  type KnowledgeCategory,
  type KnowledgeDocStatus,
  type KnowledgeDocument,
  type KnowledgeHit,
  type KnowledgeQueryInput,
  type KnowledgeScope,
  type KnowledgeSourceType,
  type KnowledgeUsageRecord,
  type KnowledgeVersion,
} from "@/api/types/deployment";

export const opsApi = {
  appInfo: () => invoke<AppInfo>("app_info"),

  /** 托盘菜单文案跟随当前语言（i18n 只在前端，见 hooks/use-tray-labels.ts）。 */
  traySetLabels: (show: string, quit: string) =>
    invoke<void>("tray_set_labels", { show, quit }),

  listServers: () => invoke<ServerRecord[]>("server_list"),
  getServer: (id: string) => invoke<ServerRecord | null>("server_get", { id }),
  saveServer: (server: ServerRecord) => invoke<ServerRecord>("server_save", { server }),
  deleteServer: (id: string) => invoke<CascadeResult>("server_delete", { id }),
  setServerFavorite: (id: string, favorite: boolean) =>
    invoke<ServerRecord>("server_set_favorite", { id, favorite }),
  /** Direct "移动到分组" action — `null` moves the server back to 未分组. */
  moveServerToGroup: (id: string, groupId: string | null) =>
    invoke<ServerRecord>("server_move_to_group", { id, groupId }),
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
  /**
   * 切换会话的**输出编码**（`auto` / `utf8` / `gb18030` / `big5`）。
   * 返回**实际生效**的值（后端认不出编码名会直接报错，绝不猜）。
   */
  sshSetEncoding: (sessionId: string, encoding: TerminalEncoding) =>
    invoke<TerminalEncoding>("ssh_set_encoding", { sessionId, encoding }),
  sshGetEncoding: (sessionId: string) =>
    invoke<TerminalEncoding | null>("ssh_get_encoding", { sessionId }),
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

  /**
   * Open a remote folder in the user's VSCode via Remote-SSH. Registers a
   * marked Host block in `~/.ssh/config` first (key credentials get an
   * exported IdentityFile), then spawns `code --remote ssh-remote+<alias>`.
   * VSCode owns the SSH connection, so the folder is the live remote FS.
   */
  vscodeOpenRemoteFolder: (serverId: string, path: string) =>
    invoke<VscodeOpenResult>("vscode_open_remote_folder", { serverId, path }),

  // Local-editor sync (editor_sync domain): a copy of the remote file is
  // opened in a locally installed editor; every save syncs back over the
  // session's own SFTP. Frontend only ever passes structured identifiers.
  /** Probes locally installed editors (VSCode / Cursor / …). */
  editorListAvailable: () => invoke<EditorInfo[]>("editor_list_available"),
  /** Opens a sync session for a remote file (or directory) in an editor. */
  editorSyncOpen: (sessionId: string, remotePath: string, editorId: string) =>
    invoke<SyncSessionInfo>("editor_sync_open", { sessionId, remotePath, editorId }),
  /** Closes a sync session (stops watching + removes the local copy). */
  editorSyncClose: (syncId: string) =>
    invoke<SyncSessionInfo>("editor_sync_close", { syncId }),
  /** Lists sync sessions (optionally just one SSH session's). */
  editorSyncList: (sessionId?: string) =>
    invoke<SyncSessionInfo[]>("editor_sync_list", { sessionId: sessionId ?? null }),

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
  /**
   * 命令文本 → 知识库命中（终端手动输入命令的识别入口）。
   * 两级匹配（精确 + 同命令家族），认不出返回 null —— 该命令继续走原始终端。
   * 返回完整命中：终端结果抽屉用真实 risk / mutability / can_execute 做门控。
   */
  commandMatchText: (text: string) =>
    invoke<CommandSearchHit | null>("command_match_text", { text }),
  /**
   * 二级参数补全的真实取值：`unit` = 服务器上的 systemd 服务单元，
   * `container` = Docker 容器名，`path` = 远程目录。
   * 用于把 `<unit>` 这类占位符替换成真值 —— 占位符绝不能原样进 shell。
   */
  commandParamValues: (sessionId: string, param: "unit" | "container" | "path") =>
    invoke<string[]>("command_param_values", { sessionId, param }),

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

  // -- Server environment (read-only probing) --------------------------------
  /**
   * 探测当前会话所在服务器的 Nginx 运行环境（宿主机 / Docker / Compose /
   * 多个容器）。只读：只列容器、只在候选容器里问一句有没有 nginx 可执行文件。
   *
   * 调用方负责缓存 —— 绝不在用户每敲一个字符时跑一次 `docker ps`。
   */
  probeNginxEnvironment: (sessionId: string) =>
    invoke<NginxEnvironment>("probe_nginx_environment", { sessionId }),

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

  // -- P5.0 智能部署中心（结构化模型 CRUD） ---------------------------------
  //
  // 这一组命令只读写本机 SQLite：**不连 SSH、不跑远程命令、不产生运行记录**。
  // 传的都是结构化实体或 id；名字里带 `save` 的是 upsert（id 为空时后端生成）。
  // `deploymentRun*` / `deploymentRelease*` 只读（执行留给后续阶段）。

  deploymentApplicationList: (serverId?: string) =>
    invoke<DeploymentApplication[]>("deployment_application_list", {
      serverId: serverId ?? null,
    }),
  deploymentApplicationGet: (id: string) =>
    invoke<DeploymentApplication | null>("deployment_application_get", { id }),
  deploymentApplicationSave: (application: DeploymentApplication) =>
    invoke<DeploymentApplication>("deployment_application_save", { application }),
  deploymentApplicationDelete: (id: string) =>
    invoke<DeploymentCascadeResult>("deployment_application_delete", { id }),

  deploymentEnvironmentList: (applicationId?: string) =>
    invoke<DeploymentEnvironment[]>("deployment_environment_list", {
      applicationId: applicationId ?? null,
    }),
  deploymentEnvironmentGet: (id: string) =>
    invoke<DeploymentEnvironment | null>("deployment_environment_get", { id }),
  deploymentEnvironmentSave: (environment: DeploymentEnvironment) =>
    invoke<DeploymentEnvironment>("deployment_environment_save", { environment }),
  deploymentEnvironmentDelete: (id: string) =>
    invoke<DeploymentCascadeResult>("deployment_environment_delete", { id }),

  deploymentServiceUnitList: (applicationId?: string, environmentId?: string) =>
    invoke<DeploymentServiceUnit[]>("deployment_service_unit_list", {
      applicationId: applicationId ?? null,
      environmentId: environmentId ?? null,
    }),
  deploymentServiceUnitGet: (id: string) =>
    invoke<DeploymentServiceUnit | null>("deployment_service_unit_get", { id }),
  deploymentServiceUnitSave: (unit: DeploymentServiceUnit) =>
    invoke<DeploymentServiceUnit>("deployment_service_unit_save", { unit }),
  /** 返回被连带删除的关系数量。 */
  deploymentServiceUnitDelete: (id: string) =>
    invoke<number>("deployment_service_unit_delete", { id }),
  /** 把 P3.8 的已确认项目挂到服务上（`projectId` 可空 = 只记路径）。 */
  deploymentServiceUnitLinkProject: (unitId: string, projectPath: string, projectId?: string) =>
    invoke<DeploymentServiceUnit>("deployment_service_unit_link_project", {
      unitId,
      projectId: projectId ?? null,
      projectPath,
    }),
  deploymentServiceUnitUnlinkProject: (unitId: string) =>
    invoke<DeploymentServiceUnit>("deployment_service_unit_unlink_project", { unitId }),
  /** 反查：某个已确认项目被哪些服务引用。 */
  deploymentServiceUnitsForProject: (projectId: string) =>
    invoke<string[]>("deployment_service_units_for_project", { projectId }),

  deploymentServiceRelationList: (applicationId?: string) =>
    invoke<ServiceRelation[]>("deployment_service_relation_list", {
      applicationId: applicationId ?? null,
    }),
  deploymentServiceRelationSave: (relation: ServiceRelation) =>
    invoke<ServiceRelation>("deployment_service_relation_save", { relation }),
  deploymentServiceRelationDelete: (id: string) =>
    invoke<void>("deployment_service_relation_delete", { id }),

  deploymentCapacityGet: (environmentId: string) =>
    invoke<CapacityProfile | null>("deployment_capacity_get", { environmentId }),
  deploymentCapacitySave: (profile: CapacityProfile) =>
    invoke<CapacityProfile>("deployment_capacity_save", { profile }),

  deploymentDomainList: (environmentId?: string) =>
    invoke<DomainBinding[]>("deployment_domain_list", {
      environmentId: environmentId ?? null,
    }),
  deploymentDomainSave: (binding: DomainBinding) =>
    invoke<DomainBinding>("deployment_domain_save", { binding }),
  deploymentDomainDelete: (id: string) => invoke<void>("deployment_domain_delete", { id }),

  deploymentConfigList: (applicationId?: string) =>
    invoke<ConfigDefinition[]>("deployment_config_list", {
      applicationId: applicationId ?? null,
    }),
  deploymentConfigSave: (config: ConfigDefinition) =>
    invoke<ConfigDefinition>("deployment_config_save", { config }),
  deploymentConfigDelete: (id: string) => invoke<void>("deployment_config_delete", { id }),

  /** 只返回密钥**引用**，永远没有明文。 */
  deploymentSecretList: (applicationId?: string) =>
    invoke<SecretRef[]>("deployment_secret_list", { applicationId: applicationId ?? null }),
  deploymentSecretSave: (reference: SecretRef) =>
    invoke<SecretRef>("deployment_secret_save", { reference }),
  deploymentSecretDelete: (id: string) => invoke<void>("deployment_secret_delete", { id }),

  deploymentArtifactList: (applicationId?: string, serviceUnitId?: string) =>
    invoke<ArtifactRecord[]>("deployment_artifact_list", {
      applicationId: applicationId ?? null,
      serviceUnitId: serviceUnitId ?? null,
    }),
  deploymentArtifactSave: (artifact: ArtifactRecord) =>
    invoke<ArtifactRecord>("deployment_artifact_save", { artifact }),
  deploymentArtifactDelete: (id: string) => invoke<void>("deployment_artifact_delete", { id }),

  deploymentPlanList: (applicationId?: string, environmentId?: string) =>
    invoke<DeploymentPlan[]>("deployment_plan_list", {
      applicationId: applicationId ?? null,
      environmentId: environmentId ?? null,
    }),
  deploymentPlanGet: (id: string) =>
    invoke<DeploymentPlanGraph | null>("deployment_plan_get", { id }),
  /** 保存整个方案图：Rust 侧校验图合法性（唯一 key / 无环 / 风险不下调）后整体替换。 */
  deploymentPlanSave: (graph: DeploymentPlanGraph) =>
    invoke<DeploymentPlanGraph>("deployment_plan_save", { graph }),
  /** 返回被连带删除的运行记录数量。 */
  deploymentPlanDelete: (id: string) => invoke<number>("deployment_plan_delete", { id }),

  deploymentRunList: (applicationId?: string, planId?: string, limit = 50) =>
    invoke<DeploymentRun[]>("deployment_run_list", {
      applicationId: applicationId ?? null,
      planId: planId ?? null,
      limit,
    }),
  deploymentRunGet: (id: string) =>
    invoke<DeploymentRunDetail | null>("deployment_run_get", { id }),

  deploymentReleaseList: (environmentId?: string, serviceUnitId?: string) =>
    invoke<ReleaseRecord[]>("deployment_release_list", {
      environmentId: environmentId ?? null,
      serviceUnitId: serviceUnitId ?? null,
    }),
  deploymentReleaseGet: (id: string) =>
    invoke<ReleaseRecord | null>("deployment_release_get", { id }),
  deploymentReleaseSave: (release: ReleaseRecord) =>
    invoke<ReleaseRecord>("deployment_release_save", { release }),
  deploymentReleaseDelete: (id: string) => invoke<void>("deployment_release_delete", { id }),
  /** 某个服务当前生效的版本（没有则 null）。 */
  deploymentReleaseActive: (serviceUnitId: string) =>
    invoke<ReleaseRecord | null>("deployment_release_active", { serviceUnitId }),

  // -- P5.1 制品导入与多服务识别 ---------------------------------------------
  //
  // 分析阶段只读本地文件（+ 服务器目录的只读清单），**不执行任何上传内容**。
  // 上传只在用户点"上传"时发生，且走 `.part` + 哈希校验 + 原子改名。
  // 进度通过 `artifactImportEvent(taskId)` 推给前端。

  /** 发起一次导入，立即返回任务（分析在后台跑）。 */
  deploymentArtifactImportStart: (request: ArtifactImportStartRequest) =>
    invoke<ArtifactImportTask>("deployment_artifact_import_start", { request }),
  deploymentArtifactImportStatus: (taskId: string) =>
    invoke<ArtifactImportTask | null>("deployment_artifact_import_status", { taskId }),
  deploymentArtifactImportList: (applicationId?: string) =>
    invoke<ArtifactImportTask[]>("deployment_artifact_import_list", {
      applicationId: applicationId ?? null,
    }),
  deploymentArtifactImportCancel: (taskId: string) =>
    invoke<boolean>("deployment_artifact_import_cancel", { taskId }),
  deploymentArtifactImportRetry: (taskId: string) =>
    invoke<ArtifactImportTask>("deployment_artifact_import_retry", { taskId }),
  /** 用户确认：把识别结果落成多个服务 + 各自独立的制品。 */
  deploymentArtifactImportConfirm: (confirmation: ArtifactImportConfirmation) =>
    invoke<ArtifactConfirmOutcome>("deployment_artifact_import_confirm", { confirmation }),
  deploymentArtifactImportDelete: (taskId: string) =>
    invoke<void>("deployment_artifact_import_delete", { taskId }),
  /** 上传制品到服务器；哈希不符会删掉已传文件并报错。 */
  deploymentArtifactUpload: (artifactId: string, sessionId: string, remoteDir: string) =>
    invoke<ArtifactRecord>("deployment_artifact_upload", { artifactId, sessionId, remoteDir }),

  // -- P5.3 类型化 Workflow Engine -------------------------------------------
  //
  // 执行入口。动作是类型化枚举（没有命令字符串），所有远程命令经
  // `safe::Capability` 构造；进度通过 `deploymentRunEvent(environmentId)` 推送，
  // 轮询 `deploymentRunGet` 是兜底。

  /** 执行前预检：本地能判定的都判掉，不能判定的如实标 unknown。 */
  deploymentRunPreflight: (planId: string, sessionId?: string) =>
    invoke<PreflightOutcome>("deployment_run_preflight", {
      planId,
      sessionId: sessionId ?? null,
    }),
  /** 开始一次部署。`approveHighRisk` = 预先批准所有需要确认的节点。 */
  deploymentRunStart: (planId: string, sessionId: string, approveHighRisk = false) =>
    invoke<DeploymentRunDetail>("deployment_run_start", {
      planId,
      sessionId,
      approveHighRisk,
    }),
  /** 批准一个高风险节点；运行处于暂停时会自动从这个节点继续。 */
  deploymentRunApproveNode: (runId: string, nodeKey: string, sessionId?: string) =>
    invoke<DeploymentRunDetail>("deployment_run_approve_node", {
      runId,
      nodeKey,
      sessionId: sessionId ?? null,
    }),
  /** 重试失败节点，或从指定节点继续（不指定就从未完成的那个继续）。 */
  deploymentRunResume: (runId: string, sessionId: string, fromNodeKey?: string) =>
    invoke<DeploymentRunDetail>("deployment_run_resume", {
      runId,
      sessionId,
      fromNodeKey: fromNodeKey ?? null,
    }),
  /** 取消（协作式：当前动作跑完才停）。 */
  deploymentRunCancel: (runId: string) =>
    invoke<boolean>("deployment_run_cancel", { runId }),
  /** 回滚到上一版本（独立入口，同样需要审批）。 */
  deploymentRunRollback: (runId: string, sessionId: string) =>
    invoke<DeploymentRunDetail>("deployment_run_rollback", { runId, sessionId }),

  // -- P5.4 DNS / SSL 指导（V1：指引 + 验证，不调服务商 API）-----------------
  deploymentDnsGuidance: (bindingId: string) =>
    invoke<DnsGuidance>("deployment_dns_guidance", { bindingId }),
  deploymentSslPlan: (bindingId: string, sessionId?: string) =>
    invoke<CertificatePlan>("deployment_ssl_plan", {
      bindingId,
      sessionId: sessionId ?? null,
    }),

  // -- P5.5 AI 提供方 -------------------------------------------------------
  //
  // 密钥只进系统凭据管理器：这里没有任何"读取 API Key"的方法，
  // 前端拿到的永远是 `has_api_key` 这一个布尔值。
  aiProviderList: () => invoke<AiProviderView[]>("ai_provider_list"),
  aiProviderGet: (id: string) => invoke<AiProviderView | null>("ai_provider_get", { id }),
  aiProviderSave: (request: AiProviderSaveRequest) =>
    invoke<AiProviderView>("ai_provider_save", { request }),
  aiProviderDelete: (id: string, deleteSecret: boolean) =>
    invoke<void>("ai_provider_delete", { id, deleteSecret }),
  aiProviderSetDefault: (id: string) => invoke<void>("ai_provider_set_default", { id }),
  /** 连接测试：只回状态 / 耗时 / 脱敏错误。 */
  aiProviderTest: (id: string) => invoke<AiProviderTestResult>("ai_provider_test", { id }),

  // -- P5.5 用户知识库 -------------------------------------------------------
  deploymentKnowledgeList: (
    applicationId?: string,
    environmentId?: string,
    includeArchived?: boolean,
  ) =>
    invoke<KnowledgeDocument[]>("deployment_knowledge_list", {
      applicationId: applicationId ?? null,
      environmentId: environmentId ?? null,
      includeArchived: includeArchived ?? false,
    }),
  deploymentKnowledgeGet: (id: string) =>
    invoke<KnowledgeDocument | null>("deployment_knowledge_get", { id }),
  /** 保存 = 产生新版本（旧版本永不覆盖）。 */
  deploymentKnowledgeSave: (document: KnowledgeDocument, note?: string) =>
    invoke<KnowledgeDocument>("deployment_knowledge_save", { document, note: note ?? null }),
  deploymentKnowledgeVersions: (id: string) =>
    invoke<KnowledgeVersion[]>("deployment_knowledge_versions", { id }),
  /** 恢复旧版本 —— 作为**新版本**写入。 */
  deploymentKnowledgeRestore: (id: string, version: number) =>
    invoke<KnowledgeDocument>("deployment_knowledge_restore", { id, version }),
  deploymentKnowledgeArchive: (id: string) =>
    invoke<void>("deployment_knowledge_archive", { id }),
  deploymentKnowledgeUsage: (id: string) =>
    invoke<KnowledgeUsageRecord[]>("deployment_knowledge_usage", { id }),
  /** 检索测试：与 AI 复核同一函数、同一预算。 */
  deploymentKnowledgeSearchTest: (query: KnowledgeQueryInput) =>
    invoke<KnowledgeHit[]>("deployment_knowledge_search_test", { query }),

  // -- P5.5 AI 复核（后台任务 + 事件；不阻塞方案）----------------------------
  deploymentProposalAiReview: (proposalId: string) =>
    invoke<AiReviewTask>("deployment_proposal_ai_review", { proposalId }),
  deploymentProposalAiReviewStatus: (proposalId: string) =>
    invoke<AiReviewTask | null>("deployment_proposal_ai_review_status", { proposalId }),
  deploymentProposalAiReviewCancel: (proposalId: string) =>
    invoke<boolean>("deployment_proposal_ai_review_cancel", { proposalId }),

  // -- P5.2 部署方案生成（确定性规则引擎 + 知识库；AI 可选）------------------
  //
  // 生成只读输入、只写本机 SQLite；`confirm` 落成的是一份 **draft** 计划
  // （审批标记原样保留），批准与执行属于后续阶段。

  /** 生成方案。`ready = false` 时没有可执行工作流，只有必须回答的问题。 */
  deploymentProposalGenerate: (applicationId: string, environmentId?: string, sessionId?: string) =>
    invoke<ProposalOutcome>("deployment_proposal_generate", {
      applicationId,
      environmentId: environmentId ?? null,
      sessionId: sessionId ?? null,
    }),
  deploymentProposalList: (applicationId?: string, limit = 20) =>
    invoke<DeploymentProposal[]>("deployment_proposal_list", {
      applicationId: applicationId ?? null,
      limit,
    }),
  deploymentProposalGet: (id: string) =>
    invoke<DeploymentProposal | null>("deployment_proposal_get", { id }),
  /** 用户确认方案 → 落成草案计划（**不是批准**）。 */
  deploymentProposalConfirm: (id: string) =>
    invoke<DeploymentPlanGraph>("deployment_proposal_confirm", { id }),
  deploymentProposalReject: (id: string) =>
    invoke<DeploymentProposal>("deployment_proposal_reject", { id }),
  deploymentProposalDelete: (id: string) => invoke<void>("deployment_proposal_delete", { id }),
  deploymentPolicyGet: (applicationId: string) =>
    invoke<DeploymentSecurityPolicy>("deployment_policy_get", { applicationId }),
  /** 返回的是**被钉硬之后**的策略（某几项不允许关掉）。 */
  deploymentPolicySave: (applicationId: string, policy: DeploymentSecurityPolicy) =>
    invoke<DeploymentSecurityPolicy>("deployment_policy_save", { applicationId, policy }),

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
