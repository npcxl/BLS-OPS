import { invoke } from "@tauri-apps/api/core";

export interface ServerRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  credential_id?: string | null;
  group_id?: string | null;
  tags: string[];
  proxy_jump_id?: string | null;
  favorite: boolean;
  last_connected_at?: number | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ServerGroupRecord {
  
  id: string;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface CredentialRecord {
  id: string;
  name: string;
  credential_type: "password" | "private_key" | string;
  username: string;
  /** Keyring reference only — the secret itself never leaves Rust. */
  secret_ref?: string | null;
  passphrase_ref?: string | null;
  created_at: number;
  updated_at: number;
}

export interface KnownHostRecord {
  id: string;
  host: string;
  port: number;
  fingerprint: string;
  fingerprint_type: string;
  status: string;
  first_seen_at: number;
  last_seen_at: number;
}

export interface SessionRecord {
  id: string;
  server_id: string;
  server_name: string;
  server_host: string;
  server_port: number;
  username: string;
  status: string;
  connected_at?: number | null;
  disconnected_at?: number | null;
  error_message?: string | null;
  keep_alive_interval: number;
  reconnect_policy: string;
  terminal_rows?: number | null;
  terminal_cols?: number | null;
  terminal_pty?: boolean | null;
  sftp_enabled: boolean;
  port_forwards_json: string;
}

export interface CommandHistoryRecord {
  id: string;
  session_id: string;
  server_id: string;
  server_name: string;
  command: string;
  timestamp: number;
  exit_code?: number | null;
  source: string;
  output?: string | null;
}

export interface AuditLogRecord {
  id: string;
  action: string;
  timestamp: number;
  user_id?: string | null;
  server_id?: string | null;
  server_name?: string | null;
  project_id?: string | null;
  project_name?: string | null;
  details_json: string;
  ip_address?: string | null;
  user_agent?: string | null;
}

export interface CascadeResult {
  sessions: number;
  history: number;
}

export interface CredentialDeleteResult {
  deleted: boolean;
  references: number;
}

export interface SessionStats {
  active: number;
  keepalive_secs: number;
}

export interface AppInfo {
  app_name: string;
  version: string;
  db_path: string;
  schema_version: number;
  keepalive_secs: number;
  os: string;
  arch: string;
}

/**
 * Result of a connect attempt.
 *
 * `host` / `port` are the final destination (what the tab shows).
 * `challenge_host` / `challenge_port` are the endpoint whose key must be
 * trusted — with ProxyJump that is a jump host. The fingerprint MUST be saved
 * under the challenge endpoint; saving it under `host` loops forever on a
 * two-hop connection.
 */
/** One entry of a remote directory listing, read over the SFTP subsystem. */
export interface RemoteFileEntry {
  name: string;
  /** Absolute remote POSIX path. */
  path: string;
  /** `directory` | `file` | `symlink` | `other`. */
  kind: string;
  size: number;
  modified_at?: number | null;
  /** `rwxr-xr-x` style, as reported by the server. */
  permissions?: string | null;
  hidden: boolean;
}

export interface SftpListResult {
  /** The canonical path that was actually read (server-resolved). */
  path: string;
  entries: RemoteFileEntry[];
}

/** Lifecycle of a single directory-size computation. */
export type DirectorySizeStatus =
  | "pending"
  | "computing"
  | "completed"
  | "partial"
  | "permission_denied"
  | "cancelled"
  | "timed_out"
  | "session_gone"
  | "failed";

/**
 * Result of an on-demand directory-size computation. Pushed over the
 * `directory-size-update` event as it progresses, and returned by
 * `directorySizeStatus`. Folders do not report a size via SFTP (only their
 * own metadata, ~4096 B), so this is the only honest way to learn a folder's
 * total content size.
 */
export interface DirectorySizeResult {
  sessionId: string;
  path: string;
  /** Total bytes of regular files under `path` (symlink targets excluded). */
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  /** Entries skipped because of an error (permission denied, unreadable, …). */
  skippedCount: number;
  status: DirectorySizeStatus;
  /** `true` once the computation has reached a terminal state. */
  complete: boolean;
  calculatedAt: number;
}

/** Tauri event name carrying `DirectorySizeResult` updates. */
export const DIRECTORY_SIZE_EVENT = "directory-size-update";

export type SshConnectResult =
  | {
      status: "connected";
      session_id: string;
      host: string;
      port: number;
      fingerprint: string;
      fingerprint_type: string;
    }
  | {
      status: "host_key_unknown";
      session_id: string;
      /** Endpoint to trust — the jump host when ProxyJump is in play. */
      challenge_host: string;
      challenge_port: number;
      /** Final destination, for display only. */
      host: string;
      port: number;
      fingerprint: string;
      fingerprint_type: string;
    }
  | {
      status: "host_key_changed";
      session_id: string;
      /** Endpoint to re-trust — the jump host when ProxyJump is in play. */
      challenge_host: string;
      challenge_port: number;
      /** Final destination, for display only. */
      host: string;
      port: number;
      fingerprint: string;
      fingerprint_type: string;
      known_fingerprint: string;
    };

// ---------------------------------------------------------------------------
// Server monitoring — read-only Linux metrics over the live session.
//
// The commands run on the server are a fixed table inside Rust: these calls
// take only a `session_id`, so the WebView can never pass a shell string.
// ---------------------------------------------------------------------------

export interface SystemInfo {
  hostname: string;
  os_name: string;
  os_version: string;
  kernel: string;
  architecture: string;
  uptime_seconds: number;
}

export interface CpuMetrics {
  usage_percent: number;
  load_1: number;
  load_5: number;
  load_15: number;
  logical_cores: number;
}

/** Memory and swap, in bytes. */
export interface MemoryMetrics {
  total: number;
  used: number;
  available: number;
  swap_total: number;
  swap_used: number;
  usage_percent: number;
}

export interface DiskMetrics {
  device: string;
  mount_point: string;
  filesystem: string;
  total: number;
  used: number;
  available: number;
  usage_percent: number;
}

export interface NetworkMetrics {
  interface: string;
  received_bytes: number;
  transmitted_bytes: number;
  /** Bytes per second, measured against the previous sample. */
  receive_speed: number;
  transmit_speed: number;
}

export interface ProcessInfo {
  pid: number;
  user: string;
  cpu_percent: number;
  memory_percent: number;
  status: string;
  started_at: string;
  /** Executable name only (`ps … comm`). Startup arguments never leave the server. */
  command: string;
}

export interface MonitorSnapshot {
  session_id: string;
  /** Unix seconds of the collection. */
  collected_at: number;
  /** `false` when the remote OS is not Linux — no metrics are invented. */
  supported: boolean;
  unsupported_reason: string | null;
  system: SystemInfo;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disks: DiskMetrics[];
  network: NetworkMetrics[];
  processes: ProcessInfo[];
}

// ---------------------------------------------------------------------------
// P3 — service / log / container / gateway management, projects & deployments
//
// These calls never accept a command string. They take a `sessionId` plus
// structured identifiers, and Rust turns those into fixed commands after
// validating every parameter (see `src-tauri/src/safe.rs`).
// ---------------------------------------------------------------------------

// -- systemd ----------------------------------------------------------------

export interface ServiceUnit {
  /** Unit name, e.g. `nginx.service`. */
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  /**
   * Enabled at boot. `null` when systemd reports a state with no on/off
   * meaning (`static`, `indirect`, `masked`) — never a guessed `false`.
   */
  enabled: boolean | null;
  enabled_state: string | null;
}

export type ServiceActionName =
  | "start"
  | "stop"
  | "restart"
  | "reload"
  | "enable"
  | "disable";

// -- journald ---------------------------------------------------------------

export interface JournalEntry {
  /** ISO 8601 in UTC. */
  timestamp: string;
  unit: string;
  /** syslog priority, 0 (emerg) … 7 (debug). */
  priority: number;
  message: string;
}

export interface JournalDiskUsage {
  raw: string;
  bytes: number | null;
}

/** Maximum syslog priority to include. `null` means "everything". */
export const JOURNAL_PRIORITIES = [
  { value: null, label: "全部级别" },
  { value: 0, label: "紧急" },
  { value: 1, label: "警报" },
  { value: 2, label: "严重" },
  { value: 3, label: "错误" },
  { value: 4, label: "警告" },
  { value: 5, label: "通知" },
  { value: 6, label: "信息" },
  { value: 7, label: "调试" },
] as const;

/** Chinese label for a journald priority. */
export function priorityLabel(priority: number): string {
  return JOURNAL_PRIORITIES.find((item) => item.value === priority)?.label ?? "其他";
}

// -- Docker -----------------------------------------------------------------

export interface ContainerInfo {
  id: string;
  short_id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created_at: string;
}

export interface ImageInfo {
  id: string;
  short_id: string;
  repository: string;
  tag: string;
  size: string;
  created_since: string;
  display_name: string;
}

export interface ContainerStats {
  name: string;
  cpu_percent: number;
  memory_usage: string;
  memory_percent: number;
  net_io: string;
  block_io: string;
}

export interface DockerSnapshot {
  available: boolean;
  containers: ContainerInfo[];
  images: ImageInfo[];
  stats: ContainerStats[];
  /** Set when Docker is missing or the daemon is unreachable. */
  unavailable_reason: string | null;
}

export type ContainerActionName = "start" | "stop" | "restart" | "remove";

// -- Nginx ------------------------------------------------------------------

export type NginxSource = "sites_available" | "conf_d";

export interface NginxSite {
  name: string;
  enabled: boolean;
  path: string;
  source: NginxSource;
  server_names: string[];
  listen_ports: number[];
  is_default: boolean;
}

export interface NginxTestResult {
  success: boolean;
  output: string;
}

export interface NginxSaveResult {
  saved: boolean;
  test: NginxTestResult;
  reloaded: boolean;
  backup_path: string | null;
}

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

export const CREDENTIAL_TYPES = [
  { value: "password", label: "密码" },
  { value: "private_key", label: "私钥" },
] as const;

/** `user@host[:port]` — mirrors `ssh::parse_ssh_target` in Rust. */
export function parseSshTarget(
  input: string,
  defaultPort = 22,
): { username: string; host: string; port: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return null;
  const username = trimmed.slice(0, at).trim();
  const rest = trimmed.slice(at + 1);
  if (!username || !rest) return null;

  let host = rest;
  let port = defaultPort;

  const bracket = rest.lastIndexOf("]:");
  if (bracket >= 0) {
    host = rest.slice(0, bracket).replace(/^\[/, "");
    port = Number(rest.slice(bracket + 2));
  } else if (rest.split(":").length - 1 > 1) {
    host = rest;
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon > 0) {
      const candidate = rest.slice(colon + 1);
      if (candidate && /^\d+$/.test(candidate)) {
        host = rest.slice(0, colon);
        port = Number(candidate);
      }
    }
  }

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { username, host, port };
}

function message(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}

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

  // -- Project discovery ----------------------------------------------------
  projectScanStart: (sessionId: string, serverId: string, incremental = false) =>
    invoke<ProjectScanStatus>("project_scan_start", { sessionId, serverId, incremental }),
  projectScanCancel: (scanId: string) => invoke<boolean>("project_scan_cancel", { scanId }),
  projectScanStatus: (scanId: string) =>
    invoke<ProjectScanStatus | null>("project_scan_status", { scanId }),
  projectScanResult: (scanId: string) =>
    invoke<ProjectScanResult | null>("project_scan_result", { scanId }),

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
};
