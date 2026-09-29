/**
 * P5.0 智能部署中心 —— 与 Rust `crate::deployment::model` 一一对应的类型。
 *
 * 两条约定：
 *
 * 1. **全部 snake_case**（与 Rust/serde 完全一致，不做 camelCase 转换），
 *    与 `types/project.ts` 等既有领域类型保持同一风格。
 * 2. **没有任何字段能装下一条 shell 命令**：服务的启动方式是 `ServiceRuntime`
 *    判别联合（`kind` 标签），计划节点只有类型化的 `action` + 结构化
 *    `params_json`。Rust 侧保存时会拒绝含 shell 元字符的文本，所以这里也不需要
 *    "转义" —— 前端只要按类型填字段即可。
 *
 * 两个刻意的重命名（与 systemd 模块撞名）：
 * * `ServiceUnit` → [`DeploymentServiceUnit`]（`types/services.ts` 已有 systemd 的
 *   `ServiceUnit`，同一份 ops-api 导出里不能重名）；
 * * `RiskLevel` → [`PlanRiskLevel`]（命令中心已有自己的风险分级）。
 */

// -- 应用 -------------------------------------------------------------------

export type ApplicationKind =
  | "frontend"
  | "backend"
  | "full_stack"
  | "static_site"
  | "worker"
  | "scheduled_task";

export type SourceKind = "git" | "local_upload" | "existing_remote_dir";

/** 一个可部署的应用（部署中心的顶层实体）。 */
export interface DeploymentApplication {
  id: string;
  /** 归属服务器；P5.0 一应用一台服务器。 */
  server_id: string;
  name: string;
  description: string;
  application_kind: ApplicationKind;
  source_kind: SourceKind;
  /** Git 地址 / 服务器绝对路径 / 本地上传目录提示。不是命令。 */
  source_ref: string;
  default_branch: string;
  /** 关联的已确认项目路径（P3.8），可空。 */
  confirmed_project_path: string | null;
  /** `active` | `archived` */
  status: string;
  created_at: number;
  updated_at: number;
}

// -- 环境 -------------------------------------------------------------------

export type EnvironmentKind = "development" | "testing" | "staging" | "production";

export interface DeploymentEnvironment {
  id: string;
  application_id: string;
  server_id: string;
  name: string;
  kind: EnvironmentKind;
  /** 环境根目录；所有服务目录必须落在它下面。 */
  deploy_root: string;
  capacity_profile_id: string | null;
  notes: string;
  /** `active` | `archived` */
  status: string;
  created_at: number;
  updated_at: number;
}

// -- 服务 -------------------------------------------------------------------

export type ServiceRole =
  | "web"
  | "api"
  | "worker"
  | "scheduler"
  | "gateway"
  | "database"
  | "cache"
  | "static"
  | "other";

export type ServiceKind =
  | "static_nginx"
  | "systemd_unit"
  | "docker_image"
  | "docker_compose"
  | "java_jar"
  | "node_process"
  | "python_venv"
  | "native_binary"
  | "external_managed";

export type PortProtocol = "tcp" | "udp";

export interface PortMapping {
  host_port: number;
  container_port: number;
  protocol: PortProtocol;
}

/**
 * 服务怎么跑起来 —— 结构化判别联合（`kind` 为标签），**不是命令字符串**。
 * 后续阶段的编译器会把它翻成类型化的部署动作。
 */
export type ServiceRuntime =
  | { kind: "static_nginx"; site_name: string; root: string }
  | { kind: "systemd_unit"; unit: string }
  | {
      kind: "docker_image";
      image: string;
      tag: string;
      container_name: string;
      ports: PortMapping[];
    }
  | { kind: "docker_compose"; compose_path: string; project_name: string; service: string }
  | { kind: "native_process"; entry: string; args: string[] }
  /** 外部托管（数据库 / Redis / 云服务）：只声明与健康检查，不由本工具部署。 */
  | { kind: "external"; endpoint: string };

/** 一个应用在某环境里的一个可部署服务（Rust 里叫 `ServiceUnit`）。 */
export interface DeploymentServiceUnit {
  id: string;
  application_id: string;
  environment_id: string;
  name: string;
  role: ServiceRole;
  service_kind: ServiceKind;
  runtime: ServiceRuntime;
  deploy_path: string | null;
  /** 关联的已确认项目 id（`confirmed_projects.id`），可空。 */
  confirmed_project_id: string | null;
  confirmed_project_path: string | null;
  artifact_id: string | null;
  /** `configured` | `incomplete` | `disabled` */
  status: string;
  notes: string;
  created_at: number;
  updated_at: number;
}

export type ServiceRelationKind =
  | "depends_on"
  | "provides_to"
  | "shares_network"
  | "shares_volume"
  | "order_before";

export type FailurePolicy = "block" | "warn" | "ignore";

export interface ServiceRelation {
  id: string;
  application_id: string;
  from_service_id: string;
  to_service_id: string;
  relation_kind: ServiceRelationKind;
  required: boolean;
  failure_policy: FailurePolicy;
  notes: string;
  created_at: number;
  updated_at: number;
}

// -- 容量 -------------------------------------------------------------------

/** 容量数据是怎么来的：用户填的 / 估算的 / 还不知道。 */
export type EstimationBasis = "user_provided" | "estimated" | "unknown";

/** 容量问卷。空字段表示"未知"，绝不用 0 冒充。 */
export interface CapacityProfile {
  id: string;
  environment_id: string;
  expected_dau: number | null;
  concurrent_users: number | null;
  peak_qps: number | null;
  avg_qps: number | null;
  websocket_connections: number | null;
  /** 响应时间目标（毫秒）；填了就替代"平均响应 0.5 秒"这条估算假设。 */
  response_target_ms: number | null;
  monthly_bandwidth_gb: number | null;
  monthly_upload_gb: number | null;
  monthly_data_growth_gb: number | null;
  /** `99` / `99.9` / `99.95` / `99.99` */
  availability_target: string | null;
  rpo_minutes: number | null;
  rto_minutes: number | null;
  monthly_budget: number | null;
  budget_currency: string | null;
  estimation_basis: EstimationBasis;
  /** 估算假设 —— `estimated` 时必填，UI 必须展示。 */
  assumptions: string[];
  notes: string;
  created_at: number;
  updated_at: number;
}

// -- 域名与证书 -------------------------------------------------------------

export type DnsStatus = "unknown" | "unchecked" | "resolved" | "mismatched";
export type SslMode = "none" | "manual" | "acme";
export type SslStatus = "not_applicable" | "pending" | "issued" | "expiring" | "expired" | "failed";

export interface DomainBinding {
  id: string;
  environment_id: string;
  service_unit_id: string | null;
  domain: string;
  listen_port: number;
  path_prefix: string;
  dns_credential_ref: string | null;
  dns_status: DnsStatus;
  dns_checked_at: number | null;
  ssl_mode: SslMode;
  ssl_status: SslStatus;
  ssl_expires_at: number | null;
  notes: string;
  created_at: number;
  updated_at: number;
}

// -- 配置与密钥 -------------------------------------------------------------

export type ConfigDataType = "string" | "number" | "boolean" | "url" | "port" | "path" | "json";
export type ConfigScope = "build_time" | "runtime" | "reload" | "restart";
export type ConfigSourceKind =
  | "literal"
  | "secret_ref"
  | "dependency_ref"
  | "environment_ref"
  | "generated"
  | "file"
  | "ai_proposed";

export interface ConfigDefinition {
  id: string;
  application_id: string;
  service_unit_id: string | null;
  /** 环境变量名，如 `DATABASE_URL`。 */
  key: string;
  data_type: ConfigDataType;
  required: boolean;
  secret: boolean;
  scope: ConfigScope;
  source_kind: ConfigSourceKind;
  source_ref: string | null;
  /** 仅非密钥项允许。 */
  default_value: string | null;
  description: string;
  created_at: number;
  updated_at: number;
}

export type SecretStoreKind = "keyring" | "runtime_temp_file";

/**
 * 密钥**引用**（只有引用，没有明文）。
 *
 * `keyring_account` 对应系统 Keyring 里的条目名；`runtime_path` 是部署期写临时
 * 文件用的路径模板（只允许 `/run` 与 `/dev/shm`）。明文永远不进 SQLite，
 * 也永远不跨 IPC 回到前端。
 */
export interface SecretRef {
  id: string;
  application_id: string | null;
  name: string;
  store_kind: SecretStoreKind;
  keyring_service: string | null;
  keyring_account: string | null;
  runtime_path: string | null;
  description: string;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

// -- 制品 -------------------------------------------------------------------

export type ArtifactKind =
  | "folder"
  | "zip"
  /** P5.1 补：未压缩 tar 与构建配方（Dockerfile）是两类独立输入。 */
  | "tar"
  | "tar_gz"
  | "dist"
  | "jar"
  | "binary"
  | "docker_image"
  | "compose_file"
  | "dockerfile"
  | "git_ref";

export type ArtifactSourceKind = "local_path" | "server_existing_dir" | "docker_registry" | "git_ref";

export type ArtifactStatus =
  | "draft"
  | "ready"
  | "uploaded"
  | "active"
  | "archived"
  | "failed"
  | "missing";

/** 制品元数据（P5.0 只登记，不搬运）。 */
export interface ArtifactRecord {
  id: string;
  application_id: string;
  service_unit_id: string | null;
  kind: ArtifactKind;
  source_kind: ArtifactSourceKind;
  source_ref: string;
  file_name: string | null;
  size_bytes: number | null;
  /** 64 位小写十六进制。 */
  sha256: string | null;
  docker_digest: string | null;
  version_label: string | null;
  built_at: number | null;
  checksum_verified: boolean;
  status: ArtifactStatus;
  notes: string;
  created_at: number;
  updated_at: number;
}

// -- 方案（图） -------------------------------------------------------------

export type PlanStatus = "draft" | "ready" | "approved" | "rejected" | "archived";
export type ProposalSource = "manual" | "template" | "ai_proposed";
export type PlanRiskLevel = "low" | "medium" | "high" | "critical";

/** 计划节点能做的事 —— 封闭枚举（Rust `PlanActionKind`）。 */
export type PlanActionKind =
  | "fetch_source"
  | "build_artifact"
  | "package_artifact"
  | "upload_artifact"
  | "extract_artifact"
  | "pull_image"
  | "build_image"
  | "push_image"
  | "resolve_config"
  | "render_env_file"
  | "check_dependencies"
  | "database_migration"
  | "provision_service"
  | "start_service"
  | "stop_service"
  | "restart_service"
  | "compose_up"
  | "compose_down"
  | "apply_nginx_site"
  | "test_nginx_config"
  | "reload_nginx"
  | "bind_domain"
  | "request_certificate"
  | "renew_certificate"
  | "http_health_check"
  | "tcp_health_check"
  | "container_health_check"
  | "activate_release"
  | "restore_release"
  | "restore_nginx_backup";

export interface PlanNode {
  id: string;
  plan_id: string;
  /** 图内唯一标识（`[a-z0-9_]{1,64}`），边按它连。 */
  node_key: string;
  title: string;
  action: PlanActionKind;
  service_unit_id: string | null;
  risk_level: PlanRiskLevel;
  approval_required: boolean;
  skippable: boolean;
  /** 结构化参数（JSON 对象字符串）。Rust 侧拒绝 `command` 一类键。 */
  params_json: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export type EdgeCondition = "always" | "on_success" | "on_failure" | "manual";

export interface PlanEdge {
  id: string;
  plan_id: string;
  from_node_id: string;
  to_node_id: string;
  condition: EdgeCondition;
  created_at: number;
}

export interface DeploymentPlan {
  id: string;
  application_id: string;
  environment_id: string;
  name: string;
  /** 版本号：任何一次图结构变更都递增。 */
  version: number;
  status: PlanStatus;
  proposal_source: ProposalSource;
  risk_level: PlanRiskLevel;
  notes: string;
  created_at: number;
  updated_at: number;
}

/** 方案 + 图（一次读全）。 */
export interface DeploymentPlanGraph {
  plan: DeploymentPlan;
  nodes: PlanNode[];
  edges: PlanEdge[];
}

// -- 运行与版本 -------------------------------------------------------------

/**
 * 类型化部署动作（与 Rust `deployment::action::model::ActionKind` 一一对应）。
 *
 * 取值清单被 `labels.test.ts` 钉住 —— 加动作时两边必须同时改，
 * 否则"前端少一个标签"这种漂移会立刻暴露。
 */
export type RunActionKind =
  | "check_dependencies"
  | "ensure_directory"
  | "prepare_release_directory"
  | "upload_artifact"
  | "verify_checksum"
  | "extract_archive"
  | "build_docker_image"
  | "pull_docker_image"
  | "write_runtime_config"
  | "write_compose_file"
  | "compose_up"
  | "compose_down"
  | "wait_container_healthy"
  | "restart_systemd_unit"
  | "backup_nginx_config"
  | "write_nginx_config"
  | "restore_nginx_backup"
  | "test_nginx_config"
  | "reload_nginx"
  | "verify_dns_record"
  | "issue_certificate"
  | "renew_certificate"
  | "http_health_check"
  | "tcp_health_check"
  | "switch_release_symlink"
  | "promote_release"
  | "stop_previous_release"
  | "rollback_release"
  | "require_manual_step";

/** 动作所处的阶段（UI 按它分组展示步骤）。 */
export type RunActionPhase =
  | "preflight"
  | "prepare"
  | "configure"
  | "provision"
  | "gateway"
  | "certificate"
  | "health"
  | "promote"
  | "rollback";

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rolled_back";

export type RunTrigger = "manual" | "retry" | "rollback" | "schedule";

export interface DeploymentRun {
  id: string;
  plan_id: string;
  application_id: string;
  environment_id: string;
  server_id: string;
  server_name: string;
  status: RunStatus;
  trigger_source: RunTrigger;
  plan_version: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  log: string;
  error_message: string | null;
  /** 部署快照（后续阶段写入；现在恒为 null）。 */
  snapshot_json: string | null;
  release_id: string | null;
  created_at: number;
}

export type RunNodeStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "blocked";

export interface RunNode {
  id: string;
  run_id: string;
  node_id: string | null;
  node_key: string;
  title: string;
  /** 类型化动作标识（P5.3 起有值；P5.0 的历史记录是空串）。 */
  action: RunActionKind | "";
  /** 动作的风险级别（审批与展示用）。 */
  risk_level: PlanRiskLevel;
  status: RunNodeStatus;
  attempt: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  exit_code: number | null;
  output: string;
  error_message: string | null;
  created_at: number;
}

export interface DeploymentRunDetail {
  run: DeploymentRun;
  nodes: RunNode[];
}

// -- P5.3 预检与执行 ---------------------------------------------------------

export interface PreflightCheck {
  id: string;
  label: string;
  /** 复用项目识别的三态：passed / unknown / blocked。 */
  state: ArtifactCheckState;
  detail: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  /** 只要有一条 blocked 就不能开始。 */
  can_run: boolean;
  warnings: string[];
}

export interface PreflightOutcome {
  report: PreflightReport;
  environment_id: string;
  environment_kind: EnvironmentKind;
  version_label: string;
  /** 需要单独确认的高风险节点 key。 */
  approval_nodes: string[];
}

// -- P5.4 DNS / SSL 指导 -----------------------------------------------------

export interface DnsRecordInstruction {
  record_type: string;
  name: string;
  value: string;
  purpose: string;
}

export interface RegisteredDnsProvider {
  id: string;
  name: string;
  /** V1 恒为 false：没有服务商自动写入路径。 */
  automation_supported: boolean;
}

export interface DnsGuidance {
  domain: string;
  dns_status: DnsStatus;
  provider_id: string;
  provider_name: string;
  automation_supported: boolean;
  instructions: DnsRecordInstruction[];
  registered_providers: RegisteredDnsProvider[];
}

export interface CertificatePlan {
  domain: string;
  wildcard: boolean;
  challenge: "http01" | "dns01";
  manual_dns_required: boolean;
  preconditions: string[];
  blocked_reason: string | null;
  will_execute: boolean;
}

export type ReleaseStatus = "active" | "superseded" | "rolled_back" | "failed";

export interface ReleaseRecord {
  id: string;
  application_id: string;
  environment_id: string;
  service_unit_id: string | null;
  run_id: string | null;
  version_label: string;
  artifact_id: string | null;
  is_active: boolean;
  activated_at: number | null;
  /** 被它替换掉的版本 —— 回滚目标。 */
  replaced_release_id: string | null;
  nginx_backup_path: string | null;
  image_digest: string | null;
  config_snapshot_json: string | null;
  status: ReleaseStatus;
  notes: string;
  created_at: number;
  updated_at: number;
}

// -- 删除结果 ---------------------------------------------------------------

/** 级联删除的计数 —— UI 要如实告诉用户删掉了什么。 */
export interface DeploymentCascadeResult {
  environments: number;
  services: number;
  relations: number;
  plans: number;
  runs: number;
  releases: number;
  artifacts: number;
  configs: number;
  secrets: number;
  domains: number;
}

// ===========================================================================
// P5.5 AI 提供方与用户知识库
// ===========================================================================

/** 提供方类型。第一版只有 OpenAI 兼容协议。 */
export type AiProviderKind = "openai_compatible";

/** 前端可见的提供方 —— **密钥只有一个布尔值**。 */
export interface AiProviderView {
  id: string;
  name: string;
  provider_kind: AiProviderKind;
  base_url: string;
  model: string;
  /** 钥匙串里是否已保存密钥（不会给出 Key 本身，也不给长度）。 */
  has_api_key: boolean;
  enabled: boolean;
  is_default: boolean;
  allow_insecure_http: boolean;
  timeout_seconds: number;
  max_output_tokens: number;
  created_at: number;
  updated_at: number;
}

/** 保存入参。`api_key` 留空 = 保留原密钥。 */
export interface AiProviderSaveRequest {
  id?: string | null;
  name: string;
  provider_kind: AiProviderKind;
  base_url: string;
  model: string;
  api_key?: string | null;
  enabled: boolean;
  is_default: boolean;
  allow_insecure_http: boolean;
  timeout_seconds: number;
  max_output_tokens: number;
}

export interface AiProviderTestResult {
  ok: boolean;
  latency_ms: number;
  model: string;
  message: string;
  error_code: string | null;
}

export type AiTaskStatus = "idle" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AiReviewTask {
  id: string;
  proposal_id: string;
  provider_id: string | null;
  model: string | null;
  status: AiTaskStatus;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  attempts: number;
  error: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

// -- 知识库 ------------------------------------------------------------------

export type KnowledgeScope = "global" | "application" | "environment";

export type KnowledgeCategory =
  | "platform"
  | "deployment_pattern"
  | "sizing"
  | "dns"
  | "ssl"
  | "health_check"
  | "rollback"
  | "security"
  | "troubleshooting"
  | "project_context"
  | "custom";

export type KnowledgeSourceType = "manual" | "markdown_file" | "imported_text";

export type KnowledgeDocStatus = "draft" | "active" | "archived";

export interface KnowledgeDocument {
  id: string;
  title: string;
  scope: KnowledgeScope;
  application_id: string | null;
  environment_id: string | null;
  category: KnowledgeCategory;
  tags: string[];
  source_type: KnowledgeSourceType;
  source_name: string;
  version: number;
  status: KnowledgeDocStatus;
  content: string;
  content_hash: string;
  enabled: boolean;
  last_verified_at: number | null;
  note: string;
  created_at: number;
  updated_at: number;
}

export interface KnowledgeVersion {
  id: string;
  document_id: string;
  version: number;
  title: string;
  content: string;
  content_hash: string;
  source_type: KnowledgeSourceType;
  note: string;
  created_at: number;
}

export interface KnowledgeUsageRecord {
  id: string;
  document_id: string;
  version: number;
  proposal_id: string;
  used_by: string;
  created_at: number;
}

/** 任务是否还在跑（前端便利判断；Rust 侧是 `is_active()`）。 */
export function isAiTaskActive(task: AiReviewTask | null): boolean {
  return task?.status === "queued" || task?.status === "running";
}

export interface KnowledgeHit {
  document_id: string;
  version: number;
  title: string;
  excerpt: string;
  score: number;
  matched_terms: string[];
  source_name: string;
  last_verified_at: number | null;
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  conflicts_with: string[];
  /** 正文里有"忽略系统规则"这类文字 —— 只能当引用数据。 */
  suspicious: boolean;
  suspicious_markers: string[];
  /** 派生字段（前端算）：提示词里的条目 id。 */
  entry_id?: string;
}

export interface KnowledgeQueryInput {
  application_id?: string | null;
  environment_id?: string | null;
  terms?: string[];
  categories?: KnowledgeCategory[];
  tags?: string[];
  limit?: number;
}

// ===========================================================================
// P5.1 制品导入与多服务识别
// ===========================================================================
//
// 与 Rust `crate::deployment::artifact::model` 一一对应，同样**全部 snake_case**。
//
// 命名约定（与文件顶部说明同一套思路）：P5.1 的类型统一带 `Artifact` 前缀，
// 因为这些名字（`FindingKind` / `ImportStage` / `Severity`…）与项目识别、
// 监控等模块高度撞名，同一份 ops-api 导出里不能重名。

/** 用户从哪里把制品交给我们。 */
export type ArtifactImportSource =
  | { kind: "local_folder"; path: string }
  | { kind: "local_archive"; path: string }
  | { kind: "local_file"; path: string; artifact_kind: ArtifactKind }
  | { kind: "docker_image_ref"; reference: string }
  | { kind: "remote_directory"; server_id: string; path: string };

/** 导入流程的阶段（与确认过的流程一一对应）。 */
export type ArtifactImportStage =
  | "queued"
  | "hashing"
  | "security_scan"
  | "inspecting"
  | "awaiting_confirmation"
  | "uploading"
  | "done";

export type ArtifactImportStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface ArtifactImportProgress {
  stage: ArtifactImportStage;
  status: ArtifactImportStatus;
  processed_bytes: number;
  total_bytes: number;
  processed_entries: number;
  total_entries: number;
  /** 0-100；总量未知时按条目数估算，仍未知就是 0（绝不假装）。 */
  percent: number;
}

/** 指纹"哈希的是什么" —— UI 必须如实标注，别让用户以为都是全内容哈希。 */
export type ArtifactFingerprintBasis =
  | "file_bytes"
  | "archive_bytes"
  | "directory_manifest"
  | "image_reference"
  | "remote_listing";

export interface ArtifactFingerprint {
  sha256: string;
  size_bytes: number;
  entry_count: number;
  newest_mtime_ms: number | null;
  computed_at: number;
  algorithm: string;
  basis: ArtifactFingerprintBasis;
}

export type ArtifactFindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export type ArtifactFindingKind =
  | "zip_slip"
  | "absolute_path"
  | "parent_traversal"
  | "symlink"
  | "hardlink"
  | "device_entry"
  | "encrypted_entry"
  | "entry_count_limit"
  | "file_size_limit"
  | "total_size_limit"
  | "compression_ratio_limit"
  | "depth_limit"
  | "path_length_limit"
  | "private_key"
  | "access_token"
  | "credential_file"
  | "cloud_credential"
  | "package_registry_token"
  | "docker_registry_auth"
  | "executable_bit"
  | "nested_archive";

/** 掩码后的证据 —— **明文永远不会出现在这里**。 */
export interface ArtifactRedactedEvidence {
  preview: string;
  length: number;
  pattern: string;
}

export interface ArtifactSecurityFinding {
  kind: ArtifactFindingKind;
  severity: ArtifactFindingSeverity;
  location: string;
  detail: string;
  evidence: ArtifactRedactedEvidence | null;
  /** `true` = 一票否决，不允许确认导入。 */
  blocking: boolean;
}

export interface ArtifactSecurityReport {
  findings: ArtifactSecurityFinding[];
  entries_checked: number;
  files_scanned: number;
  bytes_scanned: number;
  /** 到达扫描预算提前结束 —— 如实标注，不说"已扫完"。 */
  truncated: boolean;
}

export type ArtifactStackLanguage =
  | "node"
  | "java"
  | "go"
  | "python"
  | "rust"
  | "php"
  | "dotnet"
  | "ruby"
  | "static"
  | "unknown";

export type ArtifactPackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "maven"
  | "gradle"
  | "cargo"
  | "pip"
  | "poetry"
  | "composer"
  | "bundler"
  | "nuget"
  | "unknown";

export interface ArtifactStackProfile {
  language: ArtifactStackLanguage;
  package_manager: ArtifactPackageManager | null;
  framework: string | null;
  markers: string[];
}

/** 构建步骤 —— **结构化**，字段都是受校验的短标识，没有命令字符串。 */
export type ArtifactBuildStep =
  | { kind: "npm_script"; manager: ArtifactPackageManager; script: string }
  | { kind: "maven"; goals: string[]; wrapper: boolean }
  | { kind: "gradle"; tasks: string[]; wrapper: boolean }
  | { kind: "cargo"; release: boolean; target: string | null }
  | { kind: "go_build"; package: string; output: string | null }
  | { kind: "python_venv"; requirements: string }
  | { kind: "composer"; script: string | null }
  | { kind: "docker_build"; dockerfile: string; context: string }
  | { kind: "none" };

/** 启动方式建议 —— 与 `ServiceRuntime` 一一对应，确认时直接映射。 */
export type ArtifactStartOption =
  | { kind: "static_site"; root: string }
  | { kind: "systemd_unit"; unit: string }
  | { kind: "jar"; jar: string }
  | { kind: "node"; entry: string; manager: ArtifactPackageManager }
  | { kind: "python"; entry: string; module: boolean }
  | { kind: "binary"; entry: string }
  | { kind: "nginx_site"; site_name: string; root: string }
  | { kind: "docker_image"; image: string; tag: string; ports: PortMapping[] }
  | { kind: "docker_compose"; compose_path: string; project_hint: string; services: string[] }
  | { kind: "external"; endpoint_hint: string };

export interface ArtifactPortGuess {
  port: number;
  protocol: string;
  evidence: string;
}

export type ArtifactHealthKind = "http" | "tcp" | "container";

export interface ArtifactHealthGuess {
  kind: ArtifactHealthKind;
  target: string;
  evidence: string;
}

/** 环境变量**名字**。值永远不进模型 —— 这里连字段都没有。 */
export interface ArtifactEnvKeyGuess {
  key: string;
  required: boolean;
  secret_like: boolean;
  evidence: string;
}

export type ArtifactDependencyKind =
  | "database"
  | "cache"
  | "queue"
  | "search"
  | "object_storage"
  | "mail"
  | "other";

export interface ArtifactDependencyGuess {
  name: string;
  kind: ArtifactDependencyKind;
  evidence: string;
}

/** 复用项目识别那套三态：`ready` / `unknown` / `blocked`。 */
export type ArtifactCheckState = "ready" | "unknown" | "blocked";

export interface ArtifactInspectionCheck {
  id: string;
  label: string;
  state: ArtifactCheckState;
  detail: string;
}

/**
 * 一个"可部署服务"的候选 —— 多服务项目的核心产物。
 *
 * 用户勾选若干候选 → 每个候选独立创建一个 ServiceUnit + 一个 ArtifactRecord，
 * 这就是"一个应用多个服务、每个服务独立制品"。
 */
export interface ArtifactServiceCandidate {
  id: string;
  name: string;
  role: ServiceRole;
  service_kind: ServiceKind;
  /** 直接可保存的运行时建议（`deploy_root` 由确认阶段补全）。 */
  runtime: ServiceRuntime;
  artifact_kind: ArtifactKind;
  /** 制品在包内的相对目录（空 = 包根）。 */
  source_path: string;
  ports: PortMapping[];
  env_keys: string[];
  dependencies: string[];
  health: ArtifactHealthGuess[];
  /** 置信度 0-100（只用证据算）。 */
  confidence: number;
  evidence: string[];
  selected_by_default: boolean;
}

export interface ArtifactInspection {
  artifact_kind: ArtifactKind;
  source_kind: ArtifactSourceKind;
  stack: ArtifactStackProfile;
  build: ArtifactBuildStep[];
  start: ArtifactStartOption[];
  ports: ArtifactPortGuess[];
  health: ArtifactHealthGuess[];
  env_keys: ArtifactEnvKeyGuess[];
  dependencies: ArtifactDependencyGuess[];
  services: ArtifactServiceCandidate[];
  checks: ArtifactInspectionCheck[];
  open_questions: string[];
  files_seen: number;
  /** 识别达到预算提前结束。 */
  truncated: boolean;
  inspected_at: number;
}

export interface ArtifactImportTask {
  id: string;
  application_id: string | null;
  service_unit_id: string | null;
  source: ArtifactImportSource;
  display_name: string;
  stage: ArtifactImportStage;
  status: ArtifactImportStatus;
  progress: ArtifactImportProgress;
  fingerprint: ArtifactFingerprint | null;
  security: ArtifactSecurityReport | null;
  inspection: ArtifactInspection | null;
  error: string | null;
  can_cancel: boolean;
  attempt: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  artifact_id: string | null;
}

/** 发起导入的请求。 */
export interface ArtifactImportStartRequest {
  application_id: string;
  service_unit_id: string | null;
  source: ArtifactImportSource;
  /** 服务器目录来源必填：已连接的 SSH 会话 id。 */
  session_id: string | null;
}

/** 用户勾选后回传的确认信息。 */
export interface ArtifactImportConfirmation {
  task_id: string;
  application_id: string;
  environment_id: string;
  /** 勾选的服务候选 id；空 = 只保存制品、不建服务。 */
  selected_service_ids: string[];
  version_label: string | null;
}

/** 确认结果：一个应用下多个服务，每个服务一个独立制品。 */
export interface ArtifactConfirmOutcome {
  artifacts: ArtifactRecord[];
  services: DeploymentServiceUnit[];
}

// ===========================================================================
// P5.2 部署方案生成（确定性规则引擎 + 知识库 + 可选的 AI 增强）
// ===========================================================================
//
// 与 Rust `crate::deployment::proposal::model` 一一对应，同样**全部 snake_case**。
// 命名统一带 `Proposal` 前缀，避免与 P5.1 的 `Artifact*`、命令中心的风险等级撞名。

/** 结论等级：事实 / 推断 / 建议 / 未知。**每条关键结论都必须落在其中一档。** */
export type ProposalEvidenceClass = "fact" | "inference" | "recommendation" | "unknown";

/** 证据来源：**谁说的**决定它能不能被覆盖。 */
export type ProposalEvidenceSource =
  | { kind: "server_fact"; field: string }
  | { kind: "artifact_fact"; path: string }
  | { kind: "user_input"; field: string }
  | { kind: "platform"; policy: string }
  | { kind: "knowledge"; entry_id: string; version: string }
  | { kind: "ai"; model: string; prompt_version: string }
  | { kind: "derived"; rule: string };

export interface ProposalEvidence {
  class: ProposalEvidenceClass;
  source: ProposalEvidenceSource;
  detail: string;
  reference: string | null;
}

export type ProposalStatementImpact = "info" | "decision" | "blocking";

export interface ProposalStatement {
  id: string;
  text: string;
  class: ProposalEvidenceClass;
  /** 0–100；事实恒为 100。 */
  confidence: number;
  impact: ProposalStatementImpact;
  evidence: ProposalEvidence[];
}

export interface ProposalAssumption {
  id: string;
  statement: string;
  class: ProposalEvidenceClass;
  evidence: ProposalEvidence[];
  /** 假设不成立会怎样 —— 必须写清，否则假设就是甩锅。 */
  if_wrong: string;
}

export type ProposalUnknownSeverity = "info" | "blocks_approval" | "blocks_plan";

export interface ProposalUnknown {
  id: string;
  question: string;
  why_it_matters: string;
  severity: ProposalUnknownSeverity;
  suggested_default: string | null;
  evidence: ProposalEvidence[];
}

export type ProposalTopologyKind =
  | "static_nginx"
  | "systemd_processes"
  | "docker_compose"
  | "docker_images"
  | "hybrid_gateway";

export interface ProposalTopologyOption {
  id: string;
  kind: ProposalTopologyKind;
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  /** 1–5，越大活动部件越多。 */
  complexity: number;
  monthly_cost_hint: number | null;
  feasible: boolean;
  blockers: string[];
  service_names: string[];
  evidence: ProposalEvidence[];
}

export interface ProposalResourceEstimate {
  cpu_cores: number;
  memory_mb: number;
  disk_mb: number;
  basis: ProposalEvidenceClass;
  evidence: ProposalEvidence[];
}

export interface ProposalHealthCheckPlan {
  kind: string;
  target: string;
  interval_seconds: number;
  timeout_seconds: number;
  failure_threshold: number;
  evidence: ProposalEvidence[];
}

export interface ProposalService {
  service_unit_id: string;
  name: string;
  role: ServiceRole;
  service_kind: ServiceKind;
  runtime: ServiceRuntime;
  artifact_id: string | null;
  artifact_kind: ArtifactKind | null;
  deploy_path: string | null;
  ports: PortMapping[];
  health_check: ProposalHealthCheckPlan | null;
  env_keys: string[];
  resource_estimate: ProposalResourceEstimate;
  evidence: ProposalEvidence[];
}

export interface ProposalDependency {
  id: string;
  from_service: string;
  to_service: string;
  relation_kind: ServiceRelationKind;
  required: boolean;
  failure_policy: FailurePolicy;
  evidence: ProposalEvidence[];
}

export interface ProposalDomain {
  domain: string;
  service_name: string | null;
  listen_port: number;
  path_prefix: string;
  ssl_mode: SslMode;
  certificate_required: boolean;
  evidence: ProposalEvidence[];
}

export interface ProposalCapacity {
  peak_qps: number | null;
  peak_qps_basis: ProposalEvidenceClass;
  concurrent_users: number | null;
  vcpu: number;
  memory_mb: number;
  disk_gb: number;
  bandwidth_mbps: number | null;
  headroom_percent: number;
  monthly_cost_hint: number | null;
  /** `null` = 没采集到服务器硬件，还没核对"够不够"。 */
  fits_on_server: boolean | null;
  assumptions: ProposalAssumption[];
  unknowns: ProposalUnknown[];
  evidence: ProposalEvidence[];
}

export interface ProposalWorkflow {
  /** **未就绪时必然为空数组**（后端有单测钉住）。 */
  nodes: PlanNode[];
  edges: PlanEdge[];
  notes: ProposalStatement[];
}

export type ProposalRiskLevel = PlanRiskLevel;

export interface ProposalRisk {
  id: string;
  title: string;
  severity: ProposalRiskLevel;
  likelihood: number;
  impact: string;
  mitigation: string;
  blocks_approval: boolean;
  evidence: ProposalEvidence[];
}

export interface ProposalApproval {
  id: string;
  node_key: string | null;
  reason: string;
  required_role: string;
  /** 恒为 true：审批只能被满足，不能被关掉。 */
  required: boolean;
  evidence: ProposalEvidence[];
}

export interface ProposalRollback {
  automatic: boolean;
  steps: ProposalStatement[];
  restores: string[];
  /** 数据侧能不能回滚；说不清就是"不能"，不给人错觉。 */
  data_rollback: string | null;
  trigger: string | null;
}

export interface ProposalKnowledgeReference {
  entry_id: string;
  title: string;
  version: string;
  source: string;
  applies: string;
}

export type ProposalConflictResolution =
  | "unresolved"
  | "server_fact_wins"
  | "policy_wins"
  | "not_actually_conflicting";

export interface ProposalKnowledgeConflict {
  topic: string;
  entries: string[];
  statements: string[];
  topologies: ProposalTopologyKind[];
  capability: string | null;
  resolution: ProposalConflictResolution;
  resolved_by: ProposalEvidence[];
  explanation: string;
}

/** P5.5：拒绝原因的分类（界面按它折叠展示）。 */
export type ProposalAiRejectionKind =
  | "markdown"
  | "command"
  | "shell_symbol"
  | "too_long"
  | "empty"
  | "invalid_json"
  | "unknown_field"
  | "fake_citation"
  | "modification_attempt"
  | "provider_error"
  | "other";

export interface ProposalAiRejection {
  text: string;
  reason: string;
  kind: ProposalAiRejectionKind;
}

export interface ProposalAiReview {
  model: string;
  prompt_version: string;
  prompt_hash: string;
  accepted: number;
  rejected: ProposalAiRejection[];
  notes: ProposalStatement[];
  /** P5.5：这次复核的最终状态。 */
  status: "idle" | "queued" | "running" | "succeeded" | "failed" | "rejected" | "cancelled";
  attempts: number;
  duration_ms: number | null;
  /** 本次发送给模型的知识条目（可跳转到对应版本）。 */
  knowledge_refs: ProposalKnowledgeReference[];
}

export type ProposalViolationKind =
  | "schema"
  | "capability"
  | "path"
  | "secret"
  | "permission"
  | "risk"
  | "shell";

export interface ProposalViolation {
  id: string;
  kind: ProposalViolationKind;
  severity: ProposalRiskLevel;
  source: string;
  location: string;
  detail: string;
  blocks_plan: boolean;
  blocks_approval: boolean;
}

export interface ProposalCheckItem {
  id: string;
  label: string;
  state: ArtifactCheckState;
  detail: string;
}

export interface ProposalValidation {
  checks: ProposalCheckItem[];
  violations: ProposalViolation[];
}

/** 方案指纹 —— 审计的全部依据。 */
export interface ProposalFingerprint {
  engine_version: string;
  schema_version: string;
  /** AI 模型名；未启用时为空。 */
  model: string | null;
  prompt_version: string;
  knowledge_version: string;
  input_hash: string;
  /** 不含时间戳，因此两次生成可以逐字节比对。 */
  output_hash: string;
  generated_at: number;
}

export interface ProposalServerResources {
  cpu_cores: number;
  memory_mb: number;
  disk_free_gb: number;
}

export interface ProposalInputSnapshot {
  application_id: string;
  application_kind: string;
  environment_id: string | null;
  environment_kind: string | null;
  server_id: string;
  service_count: number;
  domain_count: number;
  has_capability_profile: boolean;
  has_capacity_profile: boolean;
  domains: { binding_id: string; domain: string }[];
  observed_resources: ProposalServerResources | null;
}

export interface ProposalSummary {
  headline: string;
  statements: ProposalStatement[];
}

export type ProposalStatus = "draft" | "confirmed" | "rejected" | "superseded";

/** 一份完整的部署方案。 */
export interface DeploymentProposal {
  id: string;
  schema_version: string;
  application_id: string;
  environment_id: string | null;
  server_id: string;
  status: ProposalStatus;
  summary: ProposalSummary;
  assumptions: ProposalAssumption[];
  unknowns: ProposalUnknown[];
  recommended_topology: ProposalTopologyOption;
  alternative_topologies: ProposalTopologyOption[];
  services: ProposalService[];
  dependencies: ProposalDependency[];
  capacity_recommendation: ProposalCapacity;
  domains: ProposalDomain[];
  workflow: ProposalWorkflow;
  risks: ProposalRisk[];
  approvals: ProposalApproval[];
  rollback_strategy: ProposalRollback;
  knowledge_references: ProposalKnowledgeReference[];
  knowledge_conflicts: ProposalKnowledgeConflict[];
  validation: ProposalValidation;
  ai_review: ProposalAiReview | null;
  inputs: ProposalInputSnapshot;
  fingerprint: ProposalFingerprint;
  created_at: number;
}

/** 生成结果：`ready = false` 时 `workflow.nodes` 必然为空。 */
export interface ProposalOutcome {
  ready: boolean;
  approvable: boolean;
  open_questions: ProposalUnknown[];
  blockers: ProposalViolation[];
  proposal: DeploymentProposal;
}

/**
 * 安全策略。默认值就是最保守那一档；`production_requires_approval` 与
 * `forbid_secrets_in_artifact` **不允许关闭**（后端会钉回去）。
 */
export interface DeploymentSecurityPolicy {
  require_health_check: boolean;
  require_https: boolean;
  require_backup_for_production: boolean;
  forbid_secrets_in_artifact: boolean;
  allow_root_service: boolean;
  production_requires_approval: boolean;
  require_rollback_plan: boolean;
  min_headroom_percent: number;
  allowed_ports: number[];
  allow_privileged_containers: boolean;
  notes: string;
}
