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
import { Channel } from "@tauri-apps/api/core";
import type { ExtremeTaskFilter, ExtremeTaskRecord } from "@/api/types/extreme";
import type {
  McpRegistryResult,
  McpServerInput,
  McpServerView,
  McpTestResult,
} from "@/api/types/mcp";
import type { LogEvent, LogStartRequest } from "@/api/types/panel";
import type {
  AgentResumeRequest,
  AgentSnapshot,
  AgentStartRequest,
  FileChangeDetail,
  FileChangeSummary,
  NetChangeSet,
} from "@/api/types/agent";

import type {
  BrowseRequest,
  BrowseResult,
  ConnectionTestResult,
  DatabaseProfile,
  DbDatabase,
  DbErrorInfo,
  DbQueryState,
  DbSessionInfo,
  DbTable,
  DbTableDetail,
  DbValue,
  EngineDescriptor,
  ExportOutcome,
  ExportProgress,
  ExportRequest,
  ExportFormat,
  ExportStarted,
  HistoryWrite,
  MetadataCacheStatus,
  MutationResult,
  ProfileRuntimeStatus,
  QueryBatchResponse,
  QueryBudget,
  QueryHistoryEntry,
  QueryStarted,
  RedisKeyInfo,
  RedisListPage,
  RedisListWrite,
  RedisZSetPage,
  RedisPubSubEvent,
  RedisHashPage,
  RedisScanPage,
  RedisSetPage,
  RedisValuePayload,
  RowMutation,
  SaveProfileRequest,
  AlterTableRequest,
  SchemaChange,
  SchemaOutcome,
  SchemaPreview,
  TableOperationOutcome,
  TableOperationPreview,
  TableOperationRequest,
} from "@/api/types/database";

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
  type ImportedPrivateKey,
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
import { type TrashEntry } from "@/api/types/trash";
import { type ConflictPolicy, type TransferTask } from "@/api/types/transfer";
import {
  type DirectorySizeResult,
  type EditorHistoryEntry,
  type RemoteBinaryContent,
  type RemoteFileEntry,
  type RemoteFileVersion,
  type SaveFileOutcome,
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
  type ContainerConfig,
  type DockerSnapshot,
} from "@/api/types/containers";
import {
  type BackupImportResult,
  type BackupPreview,
  type BackupSummary,
} from "@/api/types/backup";
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
  type ConfirmOutcome,
  type DeploymentMemory,
  type DeploymentSession,
  type DeploymentSessionEvent,
  type ImportedMarkdown,
  type KnowledgeDocument,
  type MemoryKey,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
  type SessionQuestion,
  type KnowledgeHit,
  type KnowledgeMetaUpdate,
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
  type ImportedPrivateKey,
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
export {
  type AgentApproval,
  type AgentEvent,
  type AgentEventKind,
  type AgentResumeRequest,
  type AgentRunStatus,
  type AgentSnapshot,
  type AgentStartRequest,
  type AgentStep,
  type AgentStepState,
  type AgentToolRisk,
} from "@/api/types/agent";
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
  type EditorHistoryEntry,
  type RemoteBinaryContent,
  type RemoteFileEntry,
  type RemoteFileVersion,
  type SaveFileOutcome,
  type SftpListResult,
} from "@/api/types/sftp";
export { type TrashEntry } from "@/api/types/trash";
export {
  TRANSFER_EVENT,
  type ConflictPolicy,
  type TransferKind,
  type TransferState,
  type TransferTask,
} from "@/api/types/transfer";
export {
  type CpuMetrics,
  type DiskMetrics,
  type GpuMetrics,
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
  type ContainerConfig,
  type ContainerInfo,
  type ContainerMount,
  type ContainerPort,
  type ContainerStats,
  type DockerSnapshot,
  type ImageInfo,
} from "@/api/types/containers";
export {
  type BackupImportResult,
  type BackupPreview,
  type BackupSection,
  type BackupSummary,
} from "@/api/types/backup";
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
import { toAppError } from "@/lib/app-error";
import { type VscodeOpenResult } from "@/api/types/vscode";
import { type EditorInfo, type SyncSessionInfo } from "@/api/types/editor-sync";

/**
 * 历史 API：把任意异常压成一行字符串。
 *
 * 内部走 `toAppError`：Rust 的 `OpsError` / `DbErrorInfo` 是**对象**，
 * 以前这里 `String(cause)` 会输出 `[object Object]`。新代码请直接用
 * `error` + `<ErrorState>` / `pushErrorToast`，别再把错误压成字符串。
 */
function message(cause: unknown): string {
  return toAppError(cause).message;
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
  type ImportedMarkdown,
  type KnowledgeCategory,
  type KnowledgeDocStatus,
  type KnowledgeDocument,
  type KnowledgeHit,
  type KnowledgeMetaUpdate,
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
  /**
   * 读取本地私钥文件（**受限**：≤64 KiB、必须是 UTF-8、内容必须真的是私钥）。
   *
   * 只把内容交给表单，**不落库** —— 用户确认后才会写进系统凭据管理器。
   * 前端始终没有"任意读文件"的能力：路径只能来自系统文件选择器。
   */
  credentialReadPrivateKeyFile: (path: string) =>
    invoke<ImportedPrivateKey>("credential_read_private_key_file", { path }),

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
  listHistory: (limit = 100, filter?: { sessionId?: string; serverId?: string; quickTarget?: string; query?: string }) =>
    invoke<CommandHistoryRecord[]>("history_list", { limit, filter }),
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
  /**
   * 一次性执行一条命令（独立 exec channel），拿到 stdout / stderr / 退出码。
   *
   * 与 `sshInput` 的区别：不经过交互式 shell，不污染终端画面，也不需要提示符
   * 标记解析。超能模式的只读预检与部署步骤用它。输出超过上限时 `truncated`
   * 为真 —— 调用方必须把这个告诉用户，不能把半截输出当完整结果。
   */
  sshExec: (sessionId: string, command: string, timeoutMs = 15_000) =>
    invoke<{ stdout: string; stderr: string; exit_code: number | null; truncated: boolean }>(
      "ssh_exec",
      { sessionId, command, timeoutMs },
    ),
  /**
   * 在已连接的交互终端里 `cd` 到某个绝对目录，返回后端实际写入的那一行。
   *
   * 命令串由后端拼（`validate_abs_path` + `shell_quote`），前端只给路径；
   * 返回值供终端登记 cwd 跟踪，文件面板才能跟着走。
   */
  sshCd: (sessionId: string, path: string) =>
    invoke<string>("ssh_cd", { sessionId, path }),
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

  /*
   * 右栏手动终端：在**同一连接**上开一条独立的 PTY shell。
   *
   * 不是 `sshExec`：`cd` 会延续、有提示符、支持交互式命令；也不影响主终端
   * 的 shell 通道，两边输出互不串。
   */
  sshShellOpen: (sessionId: string, shellId: string, cols: number, rows: number) =>
    invoke<void>("ssh_shell_open", { sessionId, shellId, cols, rows }),
  sshShellInput: (shellId: string, data: string) =>
    invoke<void>("ssh_shell_input", { shellId, data }),
  sshShellResize: (shellId: string, cols: number, rows: number) =>
    invoke<void>("ssh_shell_resize", { shellId, cols, rows }),
  sshShellClose: (shellId: string) => invoke<void>("ssh_shell_close", { shellId }),
  /** 读手动终端最近输出（给 AI 做上下文）。 */
  sshShellTail: (shellId: string, lines?: number) =>
    invoke<string>("ssh_shell_tail", { shellId, lines: lines ?? null }),

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
    invoke<{
      path: string;
      size: number;
      binary: boolean;
      content: string | null;
      version: RemoteFileVersion;
    }>("sftp_read_file", { sessionId, path }),
  /** Overwrites a remote text file (editor save). */
  sftpWriteFile: (sessionId: string, path: string, content: string) =>
    invoke<void>("sftp_write_file", { sessionId, path, content }),
  /**
   * 写入二进制文件（图片 / 字体 / jar / 归档）。
   *
   * WebView 里的 `File` 没有本地路径，`sftpUpload` 的路径通道用不上，所以内容
   * 以 base64 走 IPC。后端解码后走同一条原子写路径（临时文件 + 重命名）。
   */
  sftpWriteBytes: (sessionId: string, path: string, contentBase64: string) =>
    invoke<void>("sftp_write_bytes", { sessionId, path, contentBase64 }),
  /**
   * 编辑器保存：带版本校验。`expected` 与远程当前内容不一致时后端**不写**，
   * 返回 `conflict` 与当前版本，由用户决定重新加载 / 另存 / 覆盖。
   */
  sftpSaveEditorFile: (
    sessionId: string,
    path: string,
    content: string,
    expected?: RemoteFileVersion | null,
    /**
     * 归属：编辑器保存也算一次文件变更，右栏要能按对话筛选。
     *
     * 不传（例如独立远程面板）就只按会话归属 —— 记录仍然生成，只是在
     * 超能右栏里看不到。
     */
    owner?: { workspaceId?: string | null; server?: string | null; serverId?: string | null },
  ) =>
    invoke<SaveFileOutcome>("sftp_save_editor_file", {
      sessionId,
      path,
      content,
      expected: expected ?? null,
      workspaceId: owner?.workspaceId ?? null,
      server: owner?.server ?? null,
      serverId: owner?.serverId ?? null,
    }),
  /** 某个远程文件在本机的历史版本（最近的在前）。 */
  editorHistoryList: (path: string) =>
    invoke<EditorHistoryEntry[]>("editor_history_list", { path }),
  /** 读取一份历史版本的内容。 */
  editorHistoryRead: (path: string, id: string) =>
    invoke<string>("editor_history_read", { path, id }),

  /** 在独立窗口里打开快捷键一览。 */
  openShortcutsWindow: () => invoke<void>("open_shortcuts_window"),

  // -- 文件传输任务中心 -------------------------------------------------------
  /**
   * 上传本地文件 / 目录（目录递归展开成多个任务）。
   * 立刻返回任务列表，真正的传输在后台队列里跑。
   */
  transferUpload: (
    sessionId: string,
    localPaths: string[],
    remoteDir: string,
    conflict?: ConflictPolicy,
  ) =>
    invoke<TransferTask[]>("transfer_upload", {
      sessionId,
      localPaths,
      remoteDir,
      conflict: conflict ?? "rename",
    }),
  transferDownload: (
    sessionId: string,
    path: string,
    localPath: string,
    conflict?: ConflictPolicy,
  ) =>
    invoke<TransferTask>("transfer_download", {
      sessionId,
      path,
      localPath,
      conflict: conflict ?? "rename",
    }),
  transferList: () => invoke<TransferTask[]>("transfer_list"),
  transferCancel: (id: string) => invoke<TransferTask>("transfer_cancel", { id }),
  transferRetry: (id: string) => invoke<TransferTask>("transfer_retry", { id }),
  transferClearFinished: () => invoke<number>("transfer_clear_finished"),

  // -- 回收站（删除先移动，可恢复）--------------------------------------------
  /** 移入回收区；跨文件系统 / 无权限时**报错**，不会退化成永久删除。 */
  trashMove: (sessionId: string, path: string) =>
    invoke<TrashEntry>("trash_move", { sessionId, path }),
  trashList: (sessionId: string) => invoke<TrashEntry[]>("trash_list", { sessionId }),
  /** 恢复到原路径；原路径已有同名条目时拒绝。 */
  trashRestore: (sessionId: string, id: string) =>
    invoke<string>("trash_restore", { sessionId, id }),
  /** 永久删除一条（不可撤销）。 */
  trashPurge: (sessionId: string, id: string) =>
    invoke<void>("trash_purge", { sessionId, id }),
  trashEmpty: (sessionId: string) => invoke<number>("trash_empty", { sessionId }),
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

  // -- 配置备份 / 恢复 -------------------------------------------------------
  /**
   * 导出整机配置到 `path`。`settings` 是 WebView 里 localStorage 的内容，
   * 由前端收集后随文件一起写入 —— 密钥永远不会出现在这里。
   */
  backupExport: (path: string, settings?: Record<string, string>) =>
    invoke<BackupSummary>("backup_export", { path, settings: settings ?? null }),
  /** 只读预览：新增 / 冲突，不写库。 */
  backupPreview: (path: string) => invoke<BackupPreview>("backup_preview", { path }),
  /** 合并导入；`overwrite` 决定冲突项是覆盖还是跳过（整批一个事务）。 */
  backupImport: (path: string, overwrite: boolean) =>
    invoke<BackupImportResult>("backup_import", { path, overwrite }),

  // -- Docker ---------------------------------------------------------------
  dockerSnapshot: (sessionId: string) => invoke<DockerSnapshot>("docker_snapshot", { sessionId }),
  dockerLogs: (sessionId: string, container: string, lines: number) =>
    invoke<string>("docker_logs", { sessionId, container, lines }),
  /** 容器配置摘要（只读）。后端只给安全字段，不含 Env 与启动命令。 */
  dockerInspectContainer: (sessionId: string, container: string) =>
    invoke<ContainerConfig>("docker_inspect_container", { sessionId, container }),
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
  /** 未保存配置的连接测试：表单里先测再存，不落库、不写钥匙串。 */
  aiProviderTestDraft: (request: AiProviderSaveRequest) =>
    invoke<AiProviderTestResult>("ai_provider_test_draft", { request }),

  // -- MCP 服务 -------------------------------------------------------------
  mcpServerList: () => invoke<McpServerView[]>("mcp_server_list"),
  mcpServerSave: (request: McpServerInput) =>
    invoke<McpServerView>("mcp_server_save", { request }),
  mcpServerDelete: (id: string) => invoke<void>("mcp_server_delete", { id }),
  /** 测试连接并刷新能力（会更新服务状态与工具列表）。 */
  mcpServerTest: (id: string) => invoke<McpTestResult>("mcp_server_test", { id }),
  /** 未保存配置的连接测试：表单里先测再存。 */
  mcpServerTestDraft: (request: McpServerInput) =>
    invoke<McpTestResult>("mcp_server_test_draft", { request }),
  /** 官方 MCP Registry 搜索。 */
  mcpRegistrySearch: (query: string, cursor?: string | null, limit?: number) =>
    invoke<McpRegistryResult>("mcp_registry_search", {
      query,
      cursor: cursor ?? null,
      limit: limit ?? 20,
    }),
  mcpToolSetEnabled: (id: string, tool: string, enabled: boolean) =>
    invoke<void>("mcp_tool_set_enabled", { id, tool, enabled }),
  /**
   * 超能模式的对话入口：走**默认** AI 提供方（Key 由后端从钥匙串读）。
   *
   * 只回正文与模型名，不做任何执行动作；未配置 / 认证失败 / 超时都会以
   * 可读错误抛回（`未配置 AI 模型` / `认证失败` / `请求超时`）。
   */
  aiChat: (
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    taskId: string,
  ) => invoke<{ content: string; model: string }>("ai_chat", { messages, taskId }),
  /** 取消进行中的对话：让后端真的断开请求，而不是只丢掉界面上的结果。 */
  /**
   * **流式**对话：后端每收到一段就 `emit("ai-chat-delta", { taskId, delta })`，
   * 调用方需要自己监听该事件并按 `taskId` 过滤。返回值是完整正文，用于兜底
   * 覆盖（防止网络抖动丢块）。
   */
  aiChatStream: (
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    taskId: string,
  ) => invoke<{ content: string; model: string }>("ai_chat_stream", { messages, taskId }),
  /**
   * **带工具循环**的对话：模型可以提出只读检查，后端校验参数后在绑定会话上
   * 执行，把结构化的输出回给模型继续判断（最多 4 轮）。
   *
   * 返回里 `tools` 是每一步实际执行的命令与输出 —— 界面展开看证据，
   * 也用来证明"确实查过"而不是模型自己编的。
   */
  aiAgent: (
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    taskId: string,
    sessionId: string,
    maxRounds = 4,
  ) =>
    invoke<{
      content: string;
      model: string;
      hitRoundLimit: boolean;
      tools: {
        tool: string;
        args: Record<string, unknown>;
        command: string;
        exitCode: number | null;
        output: string;
        truncated: boolean;
        elapsedMs: number;
      }[];
    }>("ai_chat_agent", { messages, taskId, sessionId, maxRounds }),
  /**
   * 超能 Agent：**循环在 Rust 侧**跑，这里立刻返回初始快照。
   *
   * 之后通过 `agent-event` 事件看进度，用 `aiAgentSnapshot`（重进 / 轮询）
   * 恢复卡片，用 `aiAgentApprove` 对写 / 危险操作表态。
   */
  /**
   * 实时日志：独立于问答任务的 SSH 长连接。
   *
   * 返回时流已经建好，但内容通过 `onEvent` 陆续到达；`extreme_log_stop` 会
   * **杀掉远端进程**（不是只关界面）。同一 `streamId` 只能有一条。
   */
  extremeLogStart: (request: LogStartRequest, onEvent: (event: LogEvent) => void) =>
    invoke<void>("extreme_log_start", {
      request,
      onEvent: new Channel<LogEvent>(onEvent),
    }),
  extremeLogStop: (streamId: string) => invoke<void>("extreme_log_stop", { streamId }),
  /**
   * 右栏开关时调整外框：普通窗口向外扩一个右栏宽度，收起时只撤回自己加的那段。
   *
   * 最大化 / 全屏 / 右侧空间不足时返回 `widened: false`，界面改为内部分栏。
   */
  extremePanelWiden: (panelWidth: number, open: boolean) =>
    invoke<{ widened: boolean; added: number; reason?: string | null }>(
      "extreme_panel_widen",
      { panelWidth, open },
    ),
  /** 外缘拖拽：目标客户区宽度（逻辑像素），每帧传绝对目标。 */
  extremePanelResize: (width: number, allowShrink = false) =>
    invoke<{ widened: boolean; added: number; reason?: string | null }>(
      "extreme_panel_resize",
      { width, allowShrink },
    ),
  aiAgentRun: (request: AgentStartRequest) =>
    invoke<AgentSnapshot>("agent_start", { request }),
  aiAgentSnapshot: (taskId: string) =>
    invoke<AgentSnapshot | null>("agent_snapshot", { taskId }),
  aiAgentApprove: (taskId: string, callId: string, allow: boolean) =>
    invoke<boolean>("agent_approve", { taskId, callId, allow }),
  /** 回答 AI 挂起的选择题：选项 ID + 可选自定义文字。 */
  aiAgentAnswer: (
    taskId: string,
    questionId: string,
    selected: string[],
    custom: string | null,
  ) =>
    invoke<boolean>("agent_answer_question", {
      taskId,
      questionId,
      selected,
      custom,
    }),
  /**
   * 运行中补一句要求（「更新当前任务」）：下一步开始前生效。
   *
   * 正在等确认的那一步会被撤回（按新要求重新评估），不会执行旧命令。
   * `false` = 这条任务已经结束，前端应改为新发一条消息。
   */
  aiAgentSteer: (taskId: string, text: string) =>
    invoke<boolean>("agent_steer", { taskId, text }),
  /**
   * 从检查点恢复一条被中断的任务：先只读核对已完成步骤，再从第一条未完成处继续。
   * 用的是**当前** SSH 会话（重连后和记录里的 session 不同）。
   */
  aiAgentResume: (request: AgentResumeRequest) =>
    invoke<AgentSnapshot>("agent_resume", { request }),
  /** 停止：当前命令跑完再停（与 `aiChatCancel` 同一套取消令牌）。 */
  aiAgentCancel: (taskId: string) => invoke<boolean>("agent_cancel", { taskId }),
  /**
   * 文件变更列表：只返回标识与摘要，Diff 正文另取。
   *
   * `workspaceId` 单独给 = 这条对话的全部记录（界面用来做"运行"下拉）；
   * 两个都给 = 某一次运行。记录在内存里，应用重启后为空。
   */
  aiAgentFileChanges: (workspaceId?: string | null, taskId?: string | null) =>
    invoke<FileChangeSummary[]>("agent_file_changes", {
      workspaceId: workspaceId ?? null,
      taskId: taskId ?? null,
    }),
  /**
   * 本轮**净变化**：同一路径只留一条（首次操作前 → 最后一次验证后）。
   *
   * 返回 `available` 与 `rows` 两个字段：空数组只代表"本轮真的没变"，
   * 没有本轮记录时 `available=false`，界面才回落到逐条历史。
   */
  aiAgentFileChangesNet: (workspaceId: string | null, taskId: string) =>
    invoke<NetChangeSet>("agent_file_changes_net", {
      workspaceId,
      taskId,
    }),
  /**
   * 登记一条变更（计划执行器 / 手工写入用）。
   *
   * Agent 的 `write_file` 有前后回读；计划里的上传由前端知道目标与正文，
   * 把 `before` / `after` 交回来即可生成同样的 Diff。
   */
  aiAgentFileChangeRecord: (request: {
    taskId: string;
    workspaceId?: string | null;
    server: string;
    serverId?: string | null;
    tool?: string;
    path: string;
    before?: string | null;
    after?: string | null;
    status?: string;
    note?: string | null;
    stepIndex?: number;
  }) => invoke<FileChangeSummary>("agent_file_change_record", { request }),
  /** 取一条变更的实际 Diff（用的是记录当时保存的快照，不随服务器再变）。 */
  aiAgentFileChangeDetail: (changeId: string) =>
    invoke<FileChangeDetail>("agent_file_change_detail", { changeId }),
  /**
   * 把这轮运行的变更（摘要 + 脱敏 Diff）写进任务历史。
   *
   * 终态时调用一次：重启后右栏仍能打开当时的结果。
   */
  aiAgentTaskChangesSave: (taskId: string) =>
    invoke<number>("agent_task_changes_save", { taskId }),
  /**
   * 强制结束：后端迟迟不确认停止时的最后手段。
   *
   * 只停止跟踪，**撤回不了**已经发到服务器上的命令；返回的快照里带着这条
   * 说明。`null` = 后端已经没有这条运行，界面按本地"已停止"收尾。
   */
  aiAgentAbandon: (taskId: string) => invoke<AgentSnapshot | null>("agent_abandon", { taskId }),
  aiChatCancel: (taskId: string) => invoke<boolean>("ai_chat_cancel", { taskId }),
  /**
   * 超能模式的**任务历史**：每次部署落一条，重启后还能查。
   *
   * 只存任务（步骤 + 每步真实输出 + 结果），不存对话内容。
   */
  extremeTaskSave: (task: ExtremeTaskRecord) => invoke<void>("extreme_task_save", { task }),
  /** 对话正文 / 草稿 / 上下文的完整快照（数据库是长期来源）。 */
  extremeWorkspaceList: () =>
    invoke<Record<string, unknown>[]>("extreme_workspace_list"),
  /** 用当前全量快照覆盖对话表（事务内先清后写）。 */
  extremeWorkspaceSync: (workspaces: Record<string, unknown>[]) =>
    invoke<void>("extreme_workspace_sync", { workspaces }),
  /** 任务历史：按类型 / 状态 / 服务器筛选（不传即全部），新的在前。 */
  extremeTaskList: (filter: ExtremeTaskFilter = {}) =>
    invoke<ExtremeTaskRecord[]>("extreme_task_list", {
      limit: filter.limit ?? 50,
      kind: filter.kind ?? null,
      status: filter.status ?? null,
      server: filter.server ?? null,
      serverId: filter.serverId ?? null,
      workspaceId: filter.workspaceId ?? null,
    }),
  /** 改名（空串 = 恢复显示执行摘要）。 */
  extremeTaskRename: (id: string, name: string) =>
    invoke<void>("extreme_task_rename", { id, name }),
  /** 删除一条历史；执行中 / 等待确认的任务返回 false（拒绝删除）。 */
  extremeTaskDelete: (id: string) => invoke<boolean>("extreme_task_delete", { id }),

  /* ---------------- 右栏内置浏览器（独立子 WebView） ---------------- */
  extremeBrowserOpen: (input: {
    url: string;
    /** workspaceId + 请求版本：导航事件按它校验归属。 */
    session: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }) => invoke<void>("extreme_browser_open", input),
  extremeBrowserBounds: (input: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => invoke<void>("extreme_browser_bounds", input),
  extremeBrowserNavigate: (url: string, session: string) =>
    invoke<void>("extreme_browser_navigate", { url, session }),
  extremeBrowserShow: (shown: boolean) => invoke<void>("extreme_browser_show", { shown }),
  extremeBrowserHistory: (delta: number) =>
    invoke<void>("extreme_browser_history", { delta }),
  extremeBrowserReload: () => invoke<void>("extreme_browser_reload"),
  extremeBrowserClose: () => invoke<void>("extreme_browser_close"),

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
  /** 只改元数据（启用 / 状态 / 核对时间 / 备注）：不改内容、不产生新版本。 */
  deploymentKnowledgeUpdateMeta: (id: string, update: KnowledgeMetaUpdate) =>
    invoke<KnowledgeDocument>("deployment_knowledge_update_meta", { id, update }),
  /** 受限读取本地 Markdown（扩展名白名单 / 2 MiB / 必须 UTF-8）：只返回内容，不落库。 */
  deploymentKnowledgeImportMarkdown: (path: string) =>
    invoke<ImportedMarkdown>("deployment_knowledge_import_markdown", { path }),

  // -- P5.6 统一部署会话（"确认并开始部署"的唯一入口）------------------------
  /** 新建会话（什么都不部署，只记录意图与目标）。 */
  deploymentSessionCreate: (input: {
    applicationId?: string | null;
    environmentId?: string | null;
    serverId?: string | null;
    userDescription: string;
  }) =>
    invoke<DeploymentSession>("deployment_session_create", {
      applicationId: input.applicationId ?? null,
      environmentId: input.environmentId ?? null,
      serverId: input.serverId ?? null,
      userDescription: input.userDescription,
    }),
  deploymentSessionGet: (id: string) =>
    invoke<DeploymentSession | null>("deployment_session_get", { id }),
  deploymentSessionList: (limit?: number) =>
    invoke<DeploymentSession[]>("deployment_session_list", { limit: limit ?? null }),
  deploymentSessionEvents: (id: string) =>
    invoke<DeploymentSessionEvent[]>("deployment_session_events", { id }),
  deploymentSessionAsk: (id: string, question: SessionQuestion) =>
    invoke<DeploymentSession>("deployment_session_ask", { id, question }),
  /** 回答阻塞问题（回答后回到分析）。 */
  deploymentSessionAnswer: (id: string, questionId: string, answer: string) =>
    invoke<DeploymentSession>("deployment_session_answer", { id, questionId, answer }),
  /**
   * 确认并开始部署。
   *
   * `idempotencyKey` 防双击：同键第二次直接回放上次结果，不产生第二次部署。
   * `currentFingerprint` 必须与界面看到的草案一致，否则旧草案作废。
   */
  deploymentSessionConfirmAndStart: (input: {
    id: string;
    planId: string;
    currentFingerprint: string;
    sessionId: string;
    idempotencyKey: string;
    approveHighRisk: boolean;
  }) =>
    invoke<ConfirmOutcome>("deployment_session_confirm_and_start", {
      id: input.id,
      planId: input.planId,
      currentFingerprint: input.currentFingerprint,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      approveHighRisk: input.approveHighRisk,
    }),
  /**
   * 分析会话：组装提示词 → 七道校验 → 确定性计划图。
   *
   * **不部署任何东西** —— 产出的是一份待确认的计划图；真正启动必须另走
   * `deploymentSessionConfirmAndStart`（含指纹校验与幂等键）。
   */
  deploymentSessionAnalyze: (id: string) =>
    invoke<DeploymentSession>("deployment_session_analyze", { id }),

  // -- P5.6 用户 Memory（主界面以它为主，Knowledge 在高级管理）----------------
  deploymentMemoryList: (includeInactive?: boolean) =>
    invoke<DeploymentMemory[]>("deployment_memory_list", {
      includeInactive: includeInactive ?? false,
    }),
  /** 新建 / 更新一条 Memory（后端按 key 做类型校验）。 */
  deploymentMemoryUpsert: (input: {
    id?: string | null;
    kind: MemoryKind;
    scope: MemoryScope;
    scopeId?: string | null;
    key: MemoryKey;
    valueJson: unknown;
    explicit?: boolean;
  }) =>
    invoke<DeploymentMemory>("deployment_memory_upsert", {
      id: input.id ?? null,
      kind: input.kind,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      key: input.key,
      valueJson: input.valueJson,
      explicit: input.explicit ?? false,
    }),
  deploymentMemorySetStatus: (id: string, status: MemoryStatus) =>
    invoke<DeploymentMemory>("deployment_memory_set_status", { id, status }),
  deploymentMemoryDelete: (id: string) => invoke<void>("deployment_memory_delete", { id }),
  /** 清空；默认不动生效中的条目。 */
  deploymentMemoryClear: (includeActive?: boolean) =>
    invoke<number>("deployment_memory_clear", { includeActive: includeActive ?? false }),
  /** 部署结束后按结果更新计数与置信度（确定性规则）。 */
  deploymentMemoryRecordResult: (memoryIds: string[], succeeded: boolean) =>
    invoke<DeploymentMemory[]>("deployment_memory_record_result", { memoryIds, succeeded }),

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

/** SQL 文件内容：路径由 Rust 侧系统对话框返回，前端不自行拼接。 */
export interface SqlFilePayload {
  path: string;
  content: string;
}

/**
 * 数据库工作台 API。
 *
 * 独立对象而不是塞进 `opsApi`：数据库模块有 30 个方法，混进已有一个 800 行
 * 的对象里会让"这条命令属于哪个模块"更难查。命令名统一以 `db_` 开头。
 */
export const databaseApi = {
  // -- 连接配置 ------------------------------------------------------------
  listProfiles: () => invoke<DatabaseProfile[]>("db_profile_list"),
  getProfile: (id: string) => invoke<DatabaseProfile | null>("db_profile_get", { id }),
  saveProfile: (request: SaveProfileRequest) =>
    invoke<DatabaseProfile>("db_profile_save", { request }),
  deleteProfile: (id: string) => invoke<void>("db_profile_delete", { id }),
  testConnection: (profile: DatabaseProfile, password: string | null) =>
    invoke<ConnectionTestResult>("db_test_connection", {
      request: { profile, password },
    }),

  // -- 运行时 / 会话 --------------------------------------------------------
  connect: (profileId: string, sessionId: string) =>
    invoke<DbSessionInfo>("db_connect", { profileId, sessionId }),
  sessionInfo: (sessionId: string) => invoke<DbSessionInfo>("db_session_info", { sessionId }),
  disconnect: (sessionId: string) => invoke<void>("db_disconnect", { sessionId }),
  profileStatus: (profileId: string) =>
    invoke<ProfileRuntimeStatus>("db_profile_status", { profileId }),
  profileClose: (profileId: string) => invoke<void>("db_profile_close", { profileId }),
  useDatabase: (sessionId: string, database: string) =>
    invoke<DbSessionInfo>("db_use_database", { sessionId, database }),

  // -- 元数据 --------------------------------------------------------------
  databases: (profileId: string) =>
    invoke<DbDatabase[]>("db_metadata_databases", { profileId }),
  tables: (profileId: string, database: string) =>
    invoke<DbTable[]>("db_metadata_tables", { profileId, database }),
  tableDetail: (profileId: string, database: string, table: string) =>
    invoke<DbTableDetail>("db_metadata_table", { profileId, database, table }),
  previewTableSchema: (sessionId: string, request: AlterTableRequest) =>
    invoke<SchemaPreview>("db_table_schema_preview", { sessionId, request }),
  applyTableSchema: (
    sessionId: string,
    request: AlterTableRequest,
    expectedSql: string,
  ) =>
    invoke<SchemaOutcome>("db_table_schema_apply", {
      sessionId,
      request,
      expectedSql,
    }),
  previewSchemaChange: (sessionId: string, request: SchemaChange) =>
    invoke<SchemaPreview>("db_schema_change_preview", { sessionId, request }),
  applySchemaChange: (
    sessionId: string,
    request: SchemaChange,
    expectedSql: string,
  ) =>
    invoke<SchemaOutcome>("db_schema_change_apply", {
      sessionId,
      request,
      expectedSql,
    }),
  previewTableOperation: (
    sessionId: string,
    request: TableOperationRequest,
  ) =>
    invoke<TableOperationPreview>("db_table_operation_preview", {
      sessionId,
      request,
    }),
  applyTableOperation: (
    sessionId: string,
    request: TableOperationRequest,
    expectedSql: string,
  ) =>
    invoke<TableOperationOutcome>("db_table_operation_apply", {
      sessionId,
      request,
      expectedSql,
    }),
  invalidateMetadata: (profileId: string | null) =>
    invoke<MetadataCacheStatus>("db_metadata_invalidate", { profileId }),

  // -- 表数据 --------------------------------------------------------------
  browse: (request: BrowseRequest) => invoke<BrowseResult>("db_table_browse", { request }),
  readCell: (args: {
    profileId: string;
    database: string;
    table: string;
    keyValues: (string | null)[];
    column: string;
    maxBytes?: number;
  }) =>
    invoke<DbValue>("db_read_cell", {
      profileId: args.profileId,
      database: args.database,
      table: args.table,
      keyValues: args.keyValues,
      column: args.column,
      maxBytes: args.maxBytes ?? null,
    }),

  // -- 查询任务 ------------------------------------------------------------
  queryStart: (sessionId: string, sql: string, budget?: QueryBudget) =>
    invoke<QueryStarted>("db_query_start", { sessionId, sql, budget: budget ?? null }),
  queryNext: (queryId: string) =>
    invoke<QueryBatchResponse>("db_query_next", { queryId }),
  queryCancel: (queryId: string) => invoke<string>("db_query_cancel", { queryId }),
  queryRelease: (queryId: string) => invoke<void>("db_query_release", { queryId }),
  queryState: (queryId: string) =>
    invoke<DbQueryState | null>("db_query_state", { queryId }),

  // -- 数据修改 ------------------------------------------------------------
  mutate: (args: {
    sessionId: string;
    database: string;
    table: string;
    rows: RowMutation[];
    allowNonTransactional?: boolean;
  }) =>
    invoke<MutationResult>("db_mutate_apply", {
      sessionId: args.sessionId,
      database: args.database,
      table: args.table,
      rows: args.rows,
      allowNonTransactional: args.allowNonTransactional ?? null,
    }),

  // -- 导出 ----------------------------------------------------------------
  pickExportPath: (suggestedName: string, format: ExportFormat = "csv") =>
    invoke<string | null>("db_pick_export_path", { suggestedName, format }),
  exportStart: (profileId: string, request: ExportRequest) =>
    invoke<ExportStarted>("db_export_start", { profileId, request }),
  exportStatus: (exportId: string) =>
    invoke<ExportProgress>("db_export_status", { exportId }),
  exportOutcome: (exportId: string) =>
    invoke<ExportOutcome>("db_export_outcome", { exportId }),
  exportCancel: (exportId: string) => invoke<void>("db_export_cancel", { exportId }),
  exportRemove: (exportId: string) => invoke<void>("db_export_remove", { exportId }),

  // -- 历史 ----------------------------------------------------------------
  historyList: (profileId: string) =>
    invoke<QueryHistoryEntry[]>("db_history_list", { profileId }),
  historyRecord: (request: HistoryWrite) =>
    invoke<QueryHistoryEntry>("db_history_record", { request }),
  historyClear: (profileId: string | null) =>
    invoke<void>("db_history_clear", { profileId }),

  // -- SQL 文件（对话框和读写都在 Rust 侧完成） ----------------------------
  openSqlFile: () => invoke<SqlFilePayload | null>("db_open_sql_file"),
  saveSqlFile: (sql: string, suggestedName: string) =>
    invoke<string | null>("db_save_sql_file", { sql, suggestedName }),

  moduleInfo: () => invoke<Record<string, unknown>>("db_module_info"),

  /** 引擎目录：连接表单、能力门与方言规则的唯一事实来源。 */
  enginesCatalog: () => invoke<EngineDescriptor[]>("db_engines_catalog"),

  // -- Redis 引擎（键浏览器，独立于 SQL 管线） -----------------------------
  redisConnect: (profileId: string) =>
    invoke<ProfileRuntimeStatus>("db_redis_connect", { profileId }),
  redisScan: (
    profileId: string,
    dbIndex: number,
    pattern: string,
    cursor: number,
    count: number,
  ) =>
    invoke<RedisScanPage>("db_redis_scan", {
      profileId,
      dbIndex,
      pattern,
      cursor,
      count,
    }),
  /** list 按索引分页：超大 list 也能一页页看完（以前只能看前 5000 条）。 */
  redisListPage: (
    profileId: string,
    dbIndex: number,
    key: string,
    start: number,
    count = 500,
  ) =>
    invoke<RedisListPage>("db_redis_list_page", { profileId, dbIndex, key, start, count }),
  redisZsetPage: (
    profileId: string,
    dbIndex: number,
    key: string,
    start: number,
    count = 500,
  ) =>
    invoke<RedisZSetPage>("db_redis_zset_page", { profileId, dbIndex, key, start, count }),
  redisKeyInfo: (profileId: string, dbIndex: number, key: string) =>
    invoke<RedisKeyInfo>("db_redis_key_info", { profileId, dbIndex, key }),
  /** `full = false` 只取预览（大 string 会被截断并带 truncated 标记）。 */
  redisReadValue: (
    profileId: string,
    dbIndex: number,
    key: string,
    full = false,
  ) =>
    invoke<RedisValuePayload>("db_redis_read_value", {
      profileId,
      dbIndex,
      key,
      full,
    }),
  /** HSCAN 续扫一页：hash 一律分页读取，绝不 HGETALL。 */
  redisHashScan: (
    profileId: string,
    dbIndex: number,
    key: string,
    cursor: number,
    count: number,
  ) =>
    invoke<RedisHashPage>("db_redis_hash_scan", {
      profileId,
      dbIndex,
      key,
      cursor,
      count,
    }),
  /** SSCAN 续扫一页：set 一律游标分页，不用 SMEMBERS / SRANDMEMBER。 */
  redisSetScan: (
    profileId: string,
    dbIndex: number,
    key: string,
    cursor: number,
    count: number,
  ) =>
    invoke<RedisSetPage>("db_redis_set_scan", {
      profileId,
      dbIndex,
      key,
      cursor,
      count,
    }),
  /** 新建 string 键：SET NX 原子写入，键已存在时报错、不覆盖。 */
  redisCreateString: (profileId: string, dbIndex: number, key: string, value: string) =>
    invoke<void>("db_redis_key_create", { profileId, dbIndex, key, value }),
  /** binary = true 时 value 是 Base64，后端解码后写入（二进制无损往返）。 */
  redisWriteString: (
    profileId: string,
    dbIndex: number,
    key: string,
    value: string,
    binary?: boolean,
  ) =>
    invoke<void>("db_redis_write_string", {
      profileId,
      dbIndex,
      key,
      value,
      binary,
    }),
  redisWriteHashField: (
    profileId: string,
    dbIndex: number,
    key: string,
    field: string,
    /** null = 删除字段。 */
    value: string | null,
  ) =>
    invoke<void>("db_redis_write_hash_field", {
      profileId,
      dbIndex,
      key,
      field,
      value,
    }),
  redisWriteList: (
    profileId: string,
    dbIndex: number,
    key: string,
    action: RedisListWrite,
  ) => invoke<void>("db_redis_write_list", { profileId, dbIndex, key, action }),
  redisWriteSet: (
    profileId: string,
    dbIndex: number,
    key: string,
    member: string,
    add: boolean,
  ) => invoke<void>("db_redis_write_set", { profileId, dbIndex, key, member, add }),
  redisWriteZset: (
    profileId: string,
    dbIndex: number,
    key: string,
    member: string,
    /** null = 移除成员。 */
    score: number | null,
  ) =>
    invoke<void>("db_redis_write_zset", {
      profileId,
      dbIndex,
      key,
      member,
      score,
    }),
  redisKeyDelete: (profileId: string, dbIndex: number, key: string) =>
    invoke<void>("db_redis_key_delete", { profileId, dbIndex, key }),
  redisKeyExpire: (
    profileId: string,
    dbIndex: number,
    key: string,
    /** null = PERSIST（永久）。 */
    ttlMs: number | null,
  ) => invoke<void>("db_redis_key_expire", { profileId, dbIndex, key, ttlMs }),
  /** 默认 RENAMENX：目标已存在会报错；`overwrite = true` 才覆盖。 */
  redisKeyRename: (
    profileId: string,
    dbIndex: number,
    oldKey: string,
    newKey: string,
    overwrite = false,
  ) =>
    invoke<void>("db_redis_key_rename", {
      profileId,
      dbIndex,
      oldKey,
      newKey,
      overwrite,
    }),
  redisPublish: (profileId: string, dbIndex: number, channel: string, message: string) =>
    invoke<number>("db_redis_publish", { profileId, dbIndex, channel, message }),
  redisSubscribe: (
    profileId: string,
    dbIndex: number,
    channel: string,
    onMessage: (event: RedisPubSubEvent) => void,
  ) =>
    invoke<string>("db_redis_subscribe", {
      profileId,
      dbIndex,
      channel,
      onMessage: new Channel<RedisPubSubEvent>(onMessage),
    }),
  redisUnsubscribe: (subId: string) =>
    invoke<void>("db_redis_unsubscribe", { subId }),
};

export type DatabaseApiError = DbErrorInfo;
