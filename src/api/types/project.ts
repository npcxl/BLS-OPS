/** Project discovery / capability graph / deployment types. */

// -- Project discovery ------------------------------------------------------

export type ConfidenceLevel = "high" | "likely" | "possible";
export interface ProjectEvidence { id: string; kind: string; source: string; summary: string; weight: number; verified_at: string; sensitive: boolean; }
export interface ProjectPenalty { kind: string; summary: string; weight: number; }
export type RuntimeKind = "process" | "systemd" | "docker" | "nginx";
export interface RuntimeLink { kind: RuntimeKind; name: string; status?: string; ports: number[]; source: string; }
export interface ProjectModule { id: string; name: string; path: string; project_type: string; deployable: boolean; children: ProjectModule[]; }
export interface DeploymentReadiness { score: number; blockers: string[]; warnings: string[]; confirmed_facts: string[]; unknown_facts: string[]; }
export interface ProjectCandidate { id: string; server_id: string; name: string; path: string; project_type: string; score: number; confidence: ConfidenceLevel; category: CandidateCategory; evidence: ProjectEvidence[]; penalties: ProjectPenalty[]; runtime_links: RuntimeLink[]; modules: ProjectModule[]; detected_ports: number[]; required_environment_names: string[]; blockers: string[]; warnings: string[]; readiness: DeploymentReadiness; updated_at: string; }
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
