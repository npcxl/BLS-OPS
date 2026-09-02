/** Project discovery / capability graph / deployment types. */

// -- Project discovery ------------------------------------------------------

export type ConfidenceLevel = "high" | "likely" | "possible";
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
  | "infrastructure";

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
export type ReadinessVerdict = "ready" | "needs_install" | "conflict" | "unconfirmed";
export interface AdapterReadiness {
  adapter: string;
  verdict: ReadinessVerdict;
  note: string;
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
  /** 识别出的服务；`undefined` = 没认出来。 */
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
  /** 第三张图谱：部署可行性（每个已注册适配器的准备度）。 */
  deployment_readiness: AdapterReadiness[];
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
