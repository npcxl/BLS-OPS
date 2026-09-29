/**
 * 部署中心的枚举标签表。
 *
 * 约定：**值是英文 key**（natural keys），渲染处统一 `t(...)`；用
 * `Record<联合类型, string>` 声明，所以任何新增枚举取值都会在这里编译报错 ——
 * 这就是"标签不会漏"的机械保障（单测再补一层）。
 */

import type {
  ApplicationKind,
  ArtifactCheckState,
  ArtifactDependencyKind,
  ArtifactFindingKind,
  ArtifactFindingSeverity,
  ArtifactFingerprintBasis,
  ArtifactImportStage,
  ArtifactImportStatus,
  ArtifactKind,
  ArtifactSourceKind,
  ArtifactStatus,
  ConfigDataType,
  RunActionKind,
  RunActionPhase,
  ConfigScope,
  ConfigSourceKind,
  DnsStatus,
  EnvironmentKind,
  EstimationBasis,
  FailurePolicy,
  PlanActionKind,
  PlanRiskLevel,
  PlanStatus,
  ProposalConflictResolution,
  ProposalEvidenceClass,
  ProposalSource,
  ProposalTopologyKind,
  ProposalUnknownSeverity,
  ProposalViolationKind,
  ReleaseStatus,
  RunNodeStatus,
  RunStatus,
  SecretStoreKind,
  ServiceKind,
  ServiceRelationKind,
  ServiceRole,
  ServiceRuntime,
  SourceKind,
  SslMode,
  SslStatus,
} from "@/api/types/deployment";

export const APPLICATION_KIND_LABELS: Record<ApplicationKind, string> = {
  frontend: "Frontend",
  backend: "Backend",
  full_stack: "Full stack",
  static_site: "Static site",
  worker: "Worker",
  scheduled_task: "Scheduled task",
};

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  git: "Git repository",
  local_upload: "Upload from local",
  existing_remote_dir: "Existing server directory",
};

export const ENVIRONMENT_KIND_LABELS: Record<EnvironmentKind, string> = {
  development: "Development",
  testing: "Testing",
  staging: "Staging",
  production: "Production",
};

export const SERVICE_ROLE_LABELS: Record<ServiceRole, string> = {
  web: "Web",
  api: "Api",
  worker: "Worker",
  scheduler: "Scheduler",
  gateway: "Gateway",
  database: "Database",
  cache: "Cache",
  static: "Static",
  other: "Other",
};

export const SERVICE_KIND_LABELS: Record<ServiceKind, string> = {
  static_nginx: "Static site",
  systemd_unit: "systemd unit",
  docker_image: "Docker image",
  docker_compose: "Docker Compose",
  java_jar: "Java JAR",
  node_process: "Node process",
  python_venv: "Python venv",
  native_binary: "Native binary",
  external_managed: "External managed",
};

export const RUNTIME_KIND_LABELS: Record<ServiceRuntime["kind"], string> = {
  static_nginx: "Static site",
  systemd_unit: "systemd unit",
  docker_image: "Docker image",
  docker_compose: "Docker Compose",
  native_process: "Native binary",
  external: "External managed",
};

export const RELATION_KIND_LABELS: Record<ServiceRelationKind, string> = {
  depends_on: "Depends on",
  provides_to: "Provides to",
  shares_network: "Shares network",
  shares_volume: "Shares volume",
  order_before: "Order before",
};

export const FAILURE_POLICY_LABELS: Record<FailurePolicy, string> = {
  block: "Block",
  warn: "Warn",
  ignore: "Ignore",
};

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  approved: "Approved",
  rejected: "Rejected",
  archived: "Archived",
};

export const PROPOSAL_SOURCE_LABELS: Record<ProposalSource, string> = {
  manual: "Manual",
  template: "Template",
  ai_proposed: "AI suggested",
};

export const RISK_LABELS: Record<PlanRiskLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

/** 风险配色（低风险不抢注意力，高风险必须刺眼）。 */
export const RISK_TONES: Record<PlanRiskLevel, string> = {
  low: "border-line bg-surface-2 text-fg-muted",
  medium: "border-warning/40 bg-warning/12 text-warning",
  high: "border-danger/40 bg-danger/12 text-danger",
  critical: "border-danger bg-danger/18 text-danger",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  pending: "Pending",
  running: "Running",
  paused: "Paused",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  rolled_back: "Rolled back",
};

export const RUN_NODE_STATUS_LABELS: Record<RunNodeStatus, string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  active: "Active",
  superseded: "Superseded",
  rolled_back: "Rolled back",
  failed: "Failed",
};

export const DNS_STATUS_LABELS: Record<DnsStatus, string> = {
  unknown: "Unknown",
  unchecked: "Not checked",
  resolved: "Resolved",
  mismatched: "Mismatched",
};

export const SSL_MODE_LABELS: Record<SslMode, string> = {
  none: "No certificate",
  manual: "Manual certificate",
  acme: "ACME (automatic)",
};

export const SSL_STATUS_LABELS: Record<SslStatus, string> = {
  not_applicable: "Not applicable",
  pending: "Pending",
  issued: "Issued",
  expiring: "Expiring",
  expired: "Expired",
  failed: "Failed",
};

export const ESTIMATION_BASIS_LABELS: Record<EstimationBasis, string> = {
  user_provided: "Provided by me",
  estimated: "Estimated from assumptions",
  unknown: "Not known yet",
};

export const CONFIG_DATA_TYPE_LABELS: Record<ConfigDataType, string> = {
  string: "String",
  number: "Number",
  boolean: "Boolean",
  url: "URL",
  port: "Port",
  path: "Path",
  json: "JSON",
};

export const CONFIG_SCOPE_LABELS: Record<ConfigScope, string> = {
  build_time: "Build time",
  runtime: "Runtime value",
  reload: "Reload",
  restart: "Restart",
};

export const CONFIG_SOURCE_LABELS: Record<ConfigSourceKind, string> = {
  literal: "Literal value",
  secret_ref: "Secret reference",
  dependency_ref: "Dependency reference",
  environment_ref: "Environment reference",
  generated: "Generated",
  file: "From file",
  ai_proposed: "AI suggested",
};

export const SECRET_STORE_LABELS: Record<SecretStoreKind, string> = {
  keyring: "Keyring account",
  runtime_temp_file: "Runtime file path",
};

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  folder: "Folder",
  zip: "Zip",
  tar: "Tar",
  tar_gz: "Tar.gz",
  dist: "Dist",
  jar: "Java JAR",
  binary: "Native binary",
  docker_image: "Docker image",
  compose_file: "Docker Compose",
  // 刻意不写成 `Dockerfile`：值必须是**可翻译的 key**，而专有名词若原文即
  // 译文，`t(key) === key` 会被"有译文"的机械断言判为漏翻。
  dockerfile: "Dockerfile build",
  git_ref: "Git repository",
};

export const ARTIFACT_SOURCE_LABELS: Record<ArtifactSourceKind, string> = {
  local_path: "Upload from local",
  server_existing_dir: "Existing server directory",
  docker_registry: "Docker image",
  git_ref: "Git repository",
};

export const ARTIFACT_STATUS_LABELS: Record<ArtifactStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  uploaded: "Uploaded",
  active: "Active",
  archived: "Archived",
  failed: "Failed",
  missing: "Missing",
};

/**
 * 计划动作 → 展示标签。**每一项都必须有中文**（i18n 测试会检查 key 存在）。
 */
export const ACTION_LABELS: Record<PlanActionKind, string> = {
  fetch_source: "Fetch source",
  build_artifact: "Build artifact",
  package_artifact: "Package artifact",
  upload_artifact: "Upload artifact",
  extract_artifact: "Extract artifact",
  pull_image: "Pull image",
  build_image: "Build image",
  push_image: "Push image",
  resolve_config: "Resolve config",
  render_env_file: "Render env file",
  check_dependencies: "Check dependencies",
  database_migration: "Database migration",
  provision_service: "Provision service",
  start_service: "Start service",
  stop_service: "Stop service",
  restart_service: "Restart service",
  compose_up: "Compose up",
  compose_down: "Compose down",
  apply_nginx_site: "Apply Nginx site",
  test_nginx_config: "Test Nginx config",
  reload_nginx: "Reload Nginx",
  bind_domain: "Bind domain",
  request_certificate: "Request certificate",
  renew_certificate: "Renew certificate",
  http_health_check: "HTTP health check",
  tcp_health_check: "TCP health check",
  container_health_check: "Container health check",
  activate_release: "Activate release",
  restore_release: "Restore release",
  restore_nginx_backup: "Restore Nginx backup",
};

// -- P5.1 制品导入 -----------------------------------------------------------
//
// 同样"值是英文 key"：这些短标签全部走 i18n，`labels.test.ts` 会断言
// 取值清单与 Rust 枚举逐字一致、且在 zh-CN/zh-TW 下真的有译文。

export const IMPORT_STAGE_LABELS: Record<ArtifactImportStage, string> = {
  queued: "Queued",
  hashing: "Hashing content",
  security_scan: "Scanning for secrets",
  inspecting: "Inspecting files",
  awaiting_confirmation: "Awaiting confirmation",
  uploading: "Uploading",
  done: "Done",
};

export const IMPORT_STATUS_LABELS: Record<ArtifactImportStatus, string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const FINDING_SEVERITY_LABELS: Record<ArtifactFindingSeverity, string> = {
  info: "Note",
  low: "Low severity",
  medium: "Medium severity",
  high: "High severity",
  critical: "Blocking finding",
};

export const FINDING_KIND_LABELS: Record<ArtifactFindingKind, string> = {
  zip_slip: "Zip slip path",
  absolute_path: "Absolute path entry",
  parent_traversal: "Parent directory traversal",
  symlink: "Symlink entry",
  hardlink: "Hardlink entry",
  device_entry: "Device entry",
  encrypted_entry: "Encrypted entry",
  entry_count_limit: "Too many entries",
  file_size_limit: "File too large",
  total_size_limit: "Total size too large",
  compression_ratio_limit: "Suspicious compression ratio",
  depth_limit: "Directory nested too deep",
  path_length_limit: "Path too long",
  private_key: "Private key",
  access_token: "Access token",
  credential_file: "Credential file",
  cloud_credential: "Cloud credential",
  package_registry_token: "Package registry token",
  docker_registry_auth: "Docker registry credential",
  executable_bit: "Executable file",
  nested_archive: "Nested archive",
};

export const CHECK_STATE_LABELS: Record<ArtifactCheckState, string> = {
  ready: "Check passed",
  unknown: "Not verified",
  blocked: "Check blocked",
};

export const FINGERPRINT_BASIS_LABELS: Record<ArtifactFingerprintBasis, string> = {
  file_bytes: "File bytes",
  archive_bytes: "Archive bytes",
  directory_manifest: "Directory manifest",
  image_reference: "Image reference",
  remote_listing: "Remote directory listing",
};

export const DEPENDENCY_KIND_LABELS: Record<ArtifactDependencyKind, string> = {
  database: "Database",
  cache: "Cache",
  queue: "Message queue",
  search: "Search engine",
  object_storage: "Object storage",
  mail: "Mail",
  other: "Other",
};

// -- P5.3 / P5.4 执行 --------------------------------------------------------
//
// `RUN_ACTION_KIND_LABELS` 的键必须与 Rust `ActionKind::ALL` 逐字一致 ——
// `labels.test.ts` 会把两边都钉住（少一个动作就红）。

export const RUN_ACTION_KIND_LABELS: Record<RunActionKind, string> = {
  check_dependencies: "Check server dependencies",
  ensure_directory: "Create directory",
  prepare_release_directory: "Prepare release directory",
  upload_artifact: "Upload artifact",
  verify_checksum: "Verify artifact checksum",
  extract_archive: "Extract archive",
  build_docker_image: "Build image",
  pull_docker_image: "Pull image",
  write_runtime_config: "Write runtime config",
  write_compose_file: "Generate compose file",
  compose_up: "Start compose stack",
  compose_down: "Stop compose stack",
  wait_container_healthy: "Wait for container health",
  restart_systemd_unit: "Restart service unit",
  backup_nginx_config: "Back up nginx config",
  write_nginx_config: "Write nginx config",
  restore_nginx_backup: "Restore nginx backup",
  test_nginx_config: "Test nginx config",
  reload_nginx: "Reload nginx",
  verify_dns_record: "Verify DNS resolution",
  issue_certificate: "Issue certificate",
  renew_certificate: "Renew certificate",
  http_health_check: "HTTP health check",
  tcp_health_check: "TCP health check",
  switch_release_symlink: "Switch release symlink",
  promote_release: "Promote release",
  stop_previous_release: "Stop previous release",
  rollback_release: "Roll back release",
  require_manual_step: "Manual confirmation step",
};

export const RUN_ACTION_PHASE_LABELS: Record<RunActionPhase, string> = {
  preflight: "Preflight",
  prepare: "Prepare artifacts",
  configure: "Write configuration",
  provision: "Start services",
  gateway: "Gateway",
  certificate: "Domains and certificates",
  health: "Health checks",
  promote: "Promote",
  rollback: "Rollback",
};

// 预检状态直接用已有的 `CHECK_STATE_LABELS`（同一套三态词汇，没必要再定义一份）。

// -- P5.2 部署方案 -----------------------------------------------------------

export const TOPOLOGY_KIND_LABELS: Record<ProposalTopologyKind, string> = {
  static_nginx: "Static site behind Nginx",
  systemd_processes: "Long-running processes under systemd",
  docker_compose: "Docker Compose stack",
  docker_images: "One container per service",
  hybrid_gateway: "Hybrid: Nginx + systemd + containers",
};

export const EVIDENCE_CLASS_LABELS: Record<ProposalEvidenceClass, string> = {
  fact: "Fact",
  inference: "Inference",
  recommendation: "Recommendation",
  unknown: "Unknown",
};

export const UNKNOWN_SEVERITY_LABELS: Record<ProposalUnknownSeverity, string> = {
  info: "Just information",
  blocks_approval: "Blocks approval",
  blocks_plan: "Blocks the plan",
};

export const VIOLATION_KIND_LABELS: Record<ProposalViolationKind, string> = {
  schema: "Structure",
  capability: "Server capability",
  path: "Path",
  secret: "Secret exposure",
  permission: "Permission",
  risk: "Risk",
  shell: "Shell content",
};

export const CONFLICT_RESOLUTION_LABELS: Record<ProposalConflictResolution, string> = {
  unresolved: "Needs your decision",
  server_fact_wins: "Server facts decided",
  policy_wins: "Security policy decided",
  not_actually_conflicting: "Different scopes",
};
