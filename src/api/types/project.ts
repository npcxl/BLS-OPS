/** Project discovery / capability graph / deployment types. */

// -- Project discovery ------------------------------------------------------

export type ConfidenceLevel = "high" | "likely" | "possible";

/**
 * 最终发现结论（证据等级），界面按它输出，不只用分数。
 * - `confirmed`：用户已人工确认（最高优先级，评分不再覆盖）。
 * - `high_confidence`：清单 + 精确运行实例关联 / Git 根 + 源码结构 / Compose·systemd 工作目录。
 * - `needs_confirm`：有完整项目清单但没运行关联；或有精确运行目录但缺源码清单。
 * - `possible_dir`：只有 Nginx root、静态文件或弱目录特征。
 * - `running_service`：只有容器/进程、没有宿主源码路径。
 * - `not_project`：仅 Docker/Nginx 已安装信息、数据/缓存/日志目录。
 */
export type DiscoveryStatus =
  | "confirmed"
  | "high_confidence"
  | "needs_confirm"
  | "possible_dir"
  | "running_service"
  | "not_project";
export interface ProjectEvidence { id: string; kind: string; source: string; summary: string; weight: number; verified_at: string; sensitive: boolean; }
export interface ProjectPenalty { kind: string; summary: string; weight: number; }
export type RuntimeKind = "process" | "systemd" | "docker" | "nginx" | "k8s";

/** 实例跑在哪里 —— 宿主机进程 / Docker 容器 / Kubernetes Pod。 */
export type InstanceRuntime = "host" | "container" | "kubernetes";

/**
 * 识别出的服务（MySQL / Redis / Nginx …）。
 *
 * `group` 决定它算不算"业务应用"：`application` 之外的一律是基础设施
 * （数据库、缓存、网关、监控、CI …），它们是依赖而不是要部署的项目。
 */
export interface DetectedService {
  id: string;
  label: string;
  group: ServiceGroup;
}

export type ServiceGroup =
  | "application"
  | "database"
  | "cache"
  | "messaging"
  | "search"
  | "gateway"
  | "storage"
  | "coordination"
  | "observability"
  | "devops"
  | "infrastructure"
  | "security"
  | "ai_runtime";

/** 顶层互斥业务角色：应用服务 / 基础设施 / 系统组件 / 待归类。后端判定，前端只展示。 */
export type WorkloadRole = "application" | "infrastructure" | "system" | "unknown";

/** 基础设施的稳定类别（只枚举类别，不枚举具体产品）。 */
export type InfrastructureCategory =
  | "database"
  | "cache"
  | "object_storage"
  | "messaging"
  | "search"
  | "gateway"
  | "coordination"
  | "observability"
  | "devops"
  | "container_platform"
  | "security"
  | "ai_runtime"
  | "unknown";

/** 实例在业务架构里承担的组件角色。 */
export type ComponentRole =
  | "frontend"
  | "backend"
  | "worker"
  | "scheduled_job"
  | "database"
  | "cache"
  | "object_storage"
  | "message_queue"
  | "search"
  | "gateway"
  | "observability"
  | "ai_inference"
  | "unknown";

/** 识别出的具体技术产品（字符串 ID，新增产品无需改核心枚举）。 */
export interface DetectedTechnology {
  id: string;
  label: string;
}

/** 实例归属：共享基础设施 / 项目专属 / 未知。 */
export type InstanceOwnership = "shared" | "project_scoped" | "unknown";

/** 分类所依据的一条证据。 */
export interface ClassificationEvidence {
  source: string;
  detail: string;
}

/** 分类置信度。 */
export type ClassificationConfidence = "high" | "medium" | "low";

/** 候选项目性质：业务应用 / 基础设施 / 未确定。 */
export type ProjectKind = "application" | "infrastructure" | "unknown";

export interface RuntimeLink {
  kind: RuntimeKind;
  name: string;
  status?: string;
  ports: number[];
  source: string;
  /** 实例跑在哪里。缺省视为 `host`（历史数据的语义）。 */
  runtime?: InstanceRuntime;
  /** 识别出的服务；`undefined` = 没认出来，不是"业务应用"。 */
  service?: DetectedService;
}

/**
 * 候选关联到的一个部署实例。UI 用它提供"查看项目文件 / Docker 配置 /
 * Nginx 配置 / unit 文件"的跳转入口。
 */
export interface CandidateInstance {
  id: string;
  /** docker / systemd / nginx / k8s */
  kind: string;
  name: string;
  status: string;
  runtime: InstanceRuntime;
  image?: string;
  service?: DetectedService;
  ports: number[];
  /**
   * 宿主机上的配置文件。镜像运行的实例**没有**宿主机配置文件，此时为空 ——
   * 前端要如实说"没有配置文件"，而不是给一个假入口。
   */
  config_files: string[];
  working_directories: string[];
  detail: string;
}

export interface ProjectModule { id: string; name: string; path: string; project_type: string; deployable: boolean; children: ProjectModule[]; }
export interface DeploymentReadiness { score: number; blockers: string[]; warnings: string[]; confirmed_facts: string[]; unknown_facts: string[]; }
export interface ProjectCandidate {
  id: string;
  server_id: string;
  name: string;
  path: string;
  project_type: string;
  score: number;
  confidence: ConfidenceLevel;
  /** 最终发现结论（证据等级），界面按它输出，确认覆盖一切。 */
  status: DiscoveryStatus;
  category: CandidateCategory;
  /** 业务应用 / 基础设施 / 未确定。MySQL、Redis、Nginx 是依赖，不是项目。 */
  project_kind?: ProjectKind;
  /** 关联到的部署实例（含配置文件路径，供跳转查看）。 */
  deploy_instances?: CandidateInstance[];
  /** 所有关联实例的配置文件汇总。 */
  config_files?: string[];
  evidence: ProjectEvidence[];
  penalties: ProjectPenalty[];
  runtime_links: RuntimeLink[];
  modules: ProjectModule[];
  detected_ports: number[];
  required_environment_names: string[];
  blockers: string[];
  warnings: string[];
  readiness: DeploymentReadiness;
  /** 人工复核结论（确认/忽略），从数据库读出随候选返回。 */
  review?: ReviewState;
  /** 人工合并标注：该目录被并入哪个父项目（扫描/操作后回填；undefined = 独立项目）。 */
  merged_into?: string;
  updated_at: string;
}
export type ScanState = "queued" | "running" | "completed" | "cancelled" | "failed";
export interface ScanProgress { phase: string; progress: number; checked_directories: number; discovered_candidates: number; current_path: string | null; warnings: number; }
export interface ProjectScanStatus { id: string; server_id: string; state: ScanState; progress: ScanProgress; error: string | null; started_at: number; finished_at: number | null; }

// -- P3 server capability graph (first/second layer) ----------------------

export interface SystemProfile {
  family: string;
  os: string;
  arch: string;
  kernel: string;
  init_system: string;
  user: string;
  sudo: boolean | null;
  package_manager: string;
  security_module: string;
  cgroup_version: string;
}
export interface RuntimeProfile {
  java: string | null; node: string | null; python: string | null; go: string | null;
  rust: string | null; php: string | null; dotnet: string | null; ruby: string | null;
}
export interface VersionManagerProfile {
  nvm: string | null; fnm: string | null; pyenv: string | null; uv: string | null;
  sdkman: string | null; rustup: string | null;
}
export interface BuildToolProfile {
  maven: string | null; gradle: string | null; npm: string | null; pnpm: string | null;
  yarn: string | null; cargo: string | null; pip: string | null; poetry: string | null; composer: string | null;
}
export interface DeploymentCapabilities {
  systemd: boolean | null; openrc: boolean | null; supervisor: boolean | null; pm2: boolean | null;
  runit: boolean | null; windows_service: boolean | null;
  docker: boolean | null; docker_compose: boolean | null; podman: boolean | null; containerd: boolean | null;
  kubernetes: boolean | null; k3s: boolean | null; helm: boolean | null; nomad: boolean | null;
  nginx: boolean | null; apache: boolean | null; caddy: boolean | null; traefik: boolean | null;
  haproxy: boolean | null; iis: boolean | null;
  mysql: boolean | null; postgresql: boolean | null; redis: boolean | null; mongodb: boolean | null;
  elasticsearch: boolean | null; rabbitmq: boolean | null; kafka: boolean | null;
}
export interface ServerCapabilityProfile {
  system: SystemProfile;
  runtimes: RuntimeProfile;
  version_managers: VersionManagerProfile;
  build_tools: BuildToolProfile;
  deployment: DeploymentCapabilities;
  warnings: string[];
}

// -- 人工复核结论（确认项目 / 忽略目录，持久化到数据库） -------------------

/** 复核状态：待处理 / 已确认 / 已忽略。与后端 `ReviewState` 一一对应。 */
export type ReviewState = "pending" | "confirmed" | "ignored";

/** 一条人工复核结论：按 (server_id, path) 存库，下次扫描沿用。 */
export interface ProjectReviewRecord {
  server_id: string;
  path: string;
  review: ReviewState;
  name: string;
  project_type: string;
  note: string;
  created_at: number;
  updated_at: number;
}

/** 扫描对某已确认项目的态度（持久化，跨扫描保留）。 */
export type ConfirmedScanState = "active" | "missing" | "inaccessible" | "changed";

/**
 * 持久化的已确认项目资产：即使最新扫描没有再次发现某个路径也要继续存在。
 * `candidate_payload` 是 `ProjectCandidate` 的 JSON 快照，前端解析后当候选渲染。
 */
export interface ConfirmedProject {
  id: string;
  server_id: string;
  /** 统一规范化后的路径（末尾斜杠去掉、重复斜杠合并）。 */
  canonical_path: string;
  name: string;
  project_type: string;
  /** `ProjectCandidate` 的完整 JSON 快照。 */
  candidate_payload: string;
  scan_state: ConfirmedScanState;
  confirmed_at: number;
  updated_at: number;
  last_seen_at: number;
  missing_since: number | null;
  /** 解析后的候选快照（前端填充，便于渲染）。 */
  candidate?: ProjectCandidate;
}

/** 第一轮产物：服务器上真实存在的部署实例（容器/服务/站点）。 */
export interface DeploymentInstance {
  id: string;
  kind: string;
  name: string;
  status: string;
  /** 实例跑在哪里：宿主机 / 容器 / Kubernetes。 */
  runtime: InstanceRuntime;
  /** 容器镜像（仅容器与 k8s 实例有）。 */
  image?: string;
  /** 识别出的服务；`undefined` = 没认出来。仅用于 UI 徽标，分类看 workload_role。 */
  service?: DetectedService;
  /** true = 操作系统自带（sshd / cron / containerd / k8s 沙箱容器）。 */
  system_owned: boolean;
  ports: number[];
  working_directories: string[];
  config_files: string[];
  source_paths: string[];
  /** false = 只有运行实例，源码未知（后端绝不伪造路径）。 */
  source_known: boolean;
  detail: string;
  /** 顶层互斥分类：应用服务 / 基础设施 / 系统组件 / 待归类。后端判定。 */
  workload_role: WorkloadRole;
  /** 基础设施类别（仅 workload_role=infrastructure 时有值）。 */
  infrastructure_category?: InfrastructureCategory;
  /** 组件角色（frontend / backend / database / …）。 */
  component_role: ComponentRole;
  /** 识别出的具体技术产品（mysql / node / ollama…）。 */
  technology?: DetectedTechnology;
  /** 共享基础设施 / 项目专属 / 未知。 */
  ownership: InstanceOwnership;
  /** 关联的项目路径。 */
  linked_project_ids: string[];
  /** 分类依据。 */
  classification_evidence: ClassificationEvidence[];
  /** 分类置信度。 */
  classification_confidence: ClassificationConfidence;
}

/** Nginx 网关路由（server block）。网关实例与路由分离，路由在项目详情展示。 */
export interface GatewayRoute {
  id: string;
  /** 所属网关实例 ID（nginx:gateway）。 */
  gateway_instance_id: string;
  server_names: string[];
  listen_ports: number[];
  /** 静态站点 root（可关联前端项目）。 */
  root?: string;
  /** proxy_pass 目标（原样 URL）。 */
  proxy_targets: string[];
  config_file?: string;
  /** 关联的项目路径。 */
  linked_project_id?: string;
}

/** 候选项目分类：已部署（关联实例）或仅源码。 */
export type CandidateCategory = "deployed" | "source_only";

export interface ProjectScanResult {
  scan_id: string;
  server_id: string;
  candidates: ProjectCandidate[];
  warnings: string[];
  completed_at: number;
  incremental: boolean;
  /** 第一/二层产物：服务器能力图谱。 */
  capability: ServerCapabilityProfile | null;
  /** 第一轮产物：部署实例列表（含"源码未知"的实例）。 */
  instances: DeploymentInstance[];
  /** Nginx 网关路由（网关实例与路由分离后的产物；旧快照无此字段）。 */
  gateway_routes?: GatewayRoute[];
}

// -- 项目级部署准备检查（针对单个项目，替代全局可行性图谱） ----------------

/** 单项检查的三种结论：已就绪 / 未确认（证据不足）/ 阻塞。 */
export type CheckState = "ready" | "unknown" | "blocked";
export interface ReadinessCheck {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}
/** 三选一结论：可生成方案 / 需确认 / 阻塞。 */
export type ReadinessConclusion = "ready" | "needs_confirm" | "blocked";
export interface ProjectReadinessReport {
  path: string;
  verdict: ReadinessConclusion;
  checks: ReadinessCheck[];
  /** 推荐的部署方式（基础设施项目为 null）。 */
  recommended: { method: string; reason: string } | null;
  open_questions: string[];
}

// -- Projects & deployments (legacy P5 foundation) -------------------------

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  server_id: string;
  repo_url: string;
  branch: string;
  /** Absolute directory on the server; steps may not write outside it. */
  deploy_path: string;
  /** JSON array of deployment steps, each validated by Rust before saving. */
  commands_json: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface DeploymentRecord {
  id: string;
  project_id: string;
  project_name: string;
  server_id: string;
  server_name: string;
  status: string;
  trigger_source: string;
  branch: string;
  commit_sha: string;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  log: string;
  error_message: string | null;
  created_at: number;
}

export const DEPLOY_STATUSES = {
  running: { label: "进行中", tone: "text-accent" },
  success: { label: "成功", tone: "text-success" },
  failed: { label: "失败", tone: "text-danger" },
} as const;

export function deployStatusLabel(status: string): string {
  return DEPLOY_STATUSES[status as keyof typeof DEPLOY_STATUSES]?.label ?? status;
}

/** Parses the stored JSON steps. Returns `[]` when the record is malformed. */
export function projectSteps(project: ProjectRecord): string[] {
  try {
    const parsed: unknown = JSON.parse(project.commands_json);
    return Array.isArray(parsed) ? parsed.filter((step): step is string => typeof step === "string") : [];
  } catch {
    return [];
  }
}
