/**
 * Domain Types — spec §8, §35–§102.
 * All core business entities for the Ops Workbench.
 */

// ============================================================================
// SSH & Server
// ============================================================================

export type CredentialType = "password" | "private-key" | "ssh-agent" | "keyboard-interactive";

export interface Credential {
  id: string;
  name: string;
  type: CredentialType;
  username: string;
  // For password type
  password?: string;
  // For private-key type
  privateKeyPath?: string;
  passphrase?: string;
  createdAt: number;
  updatedAt: number;
}

export type ServerStatus = "connected" | "idle" | "reconnecting" | "error" | "unknown";

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  credentialId?: string;
  groupId?: string;
  tags: string[];
  proxyJumpId?: string;
  status: ServerStatus;
  // Auto-detected facts (spec §25)
  facts?: ServerFacts;
  capabilities?: ServerCapabilities;
  createdAt: number;
  updatedAt: number;
}

export interface ServerGroup {
  id: string;
  name: string;
  description?: string;
  color?: string;
  createdAt: number;
}

// Server Facts from Environment Inspector (spec §25)
export interface ServerFacts {
  os?: {
    name: string;
    version: string;
    arch: string;
    kernel: string;
  };
  cpu?: {
    arch: string;
    cores: number;
    model: string;
  };
  memory?: {
    total: number;
    used: number;
    free: number;
  };
  disk?: Array<{
    device: string;
    mount: string;
    total: number;
    used: number;
    free: number;
    usePercent: number;
  }>;
  packageManager?: {
    name: string;
    version: string;
  };
  initSystem?: {
    name: string;
    version: string;
  };
  shell?: string;
  privilege?: "root" | "sudo" | "user";
  docker?: {
    installed: boolean;
    version?: string;
    daemonRunning?: boolean;
    composeVersion?: string;
  };
  nginx?: {
    installed: boolean;
    version?: string;
    running?: boolean;
  };
  languages?: {
    node?: string;
    java?: string;
    go?: string;
    python?: string;
    rust?: string;
  };
  ports?: number[];
  firewall?: {
    enabled: boolean;
    tool?: string;
  };
  selinux?: {
    enabled: boolean;
    mode?: string;
  };
  appArmor?: {
    enabled: boolean;
  };
  lastInspectedAt?: number;
}

// Capability Engine results (spec §27)
export type CapabilityStatus = "supported" | "unsupported" | "requires-install" | "requires-privilege" | "unverified";

export interface ServerCapabilities {
  dockerRun: CapabilityStatus;
  dockerInstall: CapabilityStatus;
  dockerCompose: CapabilityStatus;
  nginxInstall: CapabilityStatus;
  nginxReload: CapabilityStatus;
  systemd: CapabilityStatus;
  nativeNode: CapabilityStatus;
  nativeJava: CapabilityStatus;
  nativeGo: CapabilityStatus;
  nativePython: CapabilityStatus;
}

// ============================================================================
// SSH Sessions
// ============================================================================

export type SessionStatus = "connected" | "connecting" | "disconnected" | "reconnecting" | "error";

export interface SshSession {
  id: string;
  serverId: string;
  serverName: string;
  serverHost: string;
  serverPort: number;
  username: string;
  status: SessionStatus;
  connectedAt?: number;
  disconnectedAt?: number;
  errorMessage?: string;
  keepAliveInterval: number;
  reconnectPolicy: "disabled" | "manual" | "auto";
  // Terminal state
  terminal?: {
    rows: number;
    cols: number;
    pty: boolean;
  };
  // SFTP channel
  sftpEnabled: boolean;
  // Port forwarding
  portForwards: PortForward[];
}

export type PortForwardType = "local" | "remote" | "dynamic";

export interface PortForward {
  id: string;
  sessionId: string;
  type: PortForwardType;
  sourceHost: string;
  sourcePort: number;
  targetHost: string;
  targetPort: number;
  status: "active" | "inactive" | "error";
  createdAt: number;
}

// ============================================================================
// Command History (spec §18)
// ============================================================================

export type CommandSource = "user" | "quick-command" | "ai" | "script";

export interface CommandHistory {
  id: string;
  sessionId: string;
  serverId: string;
  serverName: string;
  command: string;
  timestamp: number;
  exitCode?: number;
  source: CommandSource;
  output?: string;
}

export interface QuickCommand {
  id: string;
  name: string;
  command: string;
  description?: string;
  groupId?: string;
  serverId?: string;
  createdAt: number;
}

// ============================================================================
// Files & SFTP (spec §21)
// ============================================================================

export type FileType = "file" | "directory" | "symlink" | "socket" | "block" | "char" | "fifo";

export interface RemoteFile {
  id: string;
  serverId: string;
  path: string;
  name: string;
  fileType: FileType;
  size: number;
  permissions: string;
  owner: string;
  group: string;
  modifiedAt: number;
  accessedAt: number;
  createdAt: number;
  children?: RemoteFile[];
}

// Transfer Task (spec §22)
export type TransferStatus = "pending" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export type TransferDirection = "upload" | "download";

export interface TransferTask {
  id: string;
  serverId: string;
  serverName: string;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  status: TransferStatus;
  progress: number; // 0-100
  speed: number; // bytes per second
  totalBytes: number;
  transferredBytes: number;
  eta?: number; // seconds
  startedAt: number;
  completedAt?: number;
  errorMessage?: string;
  retryCount: number;
}

// Remote Edit (spec §23)
export interface RemoteEditSession {
  id: string;
  serverId: string;
  filePath: string;
  localTempPath: string;
  originalContent: string;
  currentContent: string;
  status: "editing" | "saved" | "discarded";
  backupCreated: boolean;
  backupPath?: string;
  openedAt: number;
  savedAt?: number;
}

// ============================================================================
// Projects (spec §35)
// ============================================================================

export type ProjectType =
  | "frontend"
  | "backend"
  | "fullstack"
  | "worker"
  | "scheduled-task"
  | "docker"
  | "docker-compose"
  | "static"
  | "infrastructure"
  | "custom";

export type ProjectStatus = "active" | "inactive" | "archived";

export interface Project {
  id: string;
  name: string;
  description?: string;
  type: ProjectType;
  status: ProjectStatus;
  // Source (spec §37)
  sourceType: "git" | "local-directory" | "remote-directory" | "existing-artifact" | "docker-registry" | "none";
  gitUrl?: string;
  gitBranch?: string;
  localPath?: string;
  remotePath?: string;
  // Relations (spec §42)
  relations: ProjectRelation[];
  // Environments (spec §39)
  environments: ProjectEnvironment[];
  // Config (spec §40)
  configs: ProjectConfig[];
  // Dependencies (spec §47)
  dependencies: ProjectDependency[];
  createdAt: number;
  updatedAt: number;
}

export type RelationType =
  | "api"
  | "database"
  | "redis"
  | "mq"
  | "search"
  | "storage"
  | "websocket"
  | "custom";

export interface ProjectRelation {
  id: string;
  projectId: string;
  targetProjectId: string;
  targetProjectName: string;
  relationType: RelationType;
  description?: string;
}

export type EnvironmentType = "development" | "test" | "staging" | "production" | "custom";

export interface ProjectEnvironment {
  id: string;
  projectId: string;
  name: string;
  type: EnvironmentType;
  serverIds: string[];
  serverGroupId?: string;
  configOverrides: Record<string, string>;
  domain?: string;
  deploymentProfileId?: string;
}

// Config (spec §40, §41)
export type ConfigTime = "build-time" | "runtime" | "reload" | "restart";

export type ConfigSource =
  | "literal"
  | "secret"
  | "project-reference"
  | "dependency-reference"
  | "environment-reference"
  | "file"
  | "generated"
  | "ai-proposed";

export interface ProjectConfig {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  configTime: ConfigTime;
  source: ConfigSource;
  value?: string;
  secretReference?: string; // Reference to secret in OS keyring
  filePath?: string;
  required: boolean;
}

// Dependencies (spec §47)
export type DependencyType =
  | "postgresql"
  | "mysql"
  | "mariadb"
  | "mongodb"
  | "redis"
  | "elasticsearch"
  | "rabbitmq"
  | "kafka"
  | "nats"
  | "minio"
  | "s3"
  | "external-api"
  | "other-project"
  | "custom";

export type DependencyManagedBy = "native" | "docker" | "docker-compose" | "external";

export interface ProjectDependency {
  id: string;
  projectId: string;
  name: string;
  type: DependencyType;
  managedBy: DependencyManagedBy;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  passwordReference?: string; // Secret reference
  // Connection info
  connectionString?: string;
  // Health check
  healthCheckEnabled: boolean;
  healthCheckUrl?: string;
  healthCheckCommand?: string;
}

// ============================================================================
// Git (spec §38)
// ============================================================================

export type GitProvider = "github" | "gitlab" | "gitea" | "generic" | "local";

export interface GitSource {
  id: string;
  projectId: string;
  url: string;
  provider: GitProvider;
  branch: string;
  tag?: string;
  commit?: string;
  username?: string;
  tokenReference?: string; // Secret reference for auth
}

export interface GitSnapshot {
  id: string;
  gitSourceId: string;
  commit: string;
  message: string;
  author: string;
  timestamp: number;
}

// ============================================================================
// Workflows (spec §53–§59)
// ============================================================================

export type WorkflowNodeType =
  | "git-clone"
  | "git-fetch"
  | "git-pull"
  | "git-checkout"
  | "install-dependencies"
  | "build"
  | "test"
  | "use-existing-artifact"
  | "create-artifact"
  | "upload"
  | "download"
  | "resolve-config"
  | "check-dependencies"
  | "docker-build"
  | "docker-push"
  | "docker-pull"
  | "docker-run"
  | "docker-compose"
  | "nginx-generate"
  | "nginx-validate"
  | "nginx-reload"
  | "release-create"
  | "release-switch"
  | "systemd-start"
  | "systemd-stop"
  | "systemd-restart"
  | "systemd-reload"
  | "database-migration"
  | "health-check"
  | "approval"
  | "rollback-point"
  | "local-command"
  | "remote-command"
  | "custom-script";

export type WorkflowNodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "disabled";

export interface WorkflowNode {
  id: string;
  workflowId: string;
  type: WorkflowNodeType;
  name: string;
  description?: string;
  x: number;
  y: number;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  conditions?: {
    skipIf?: string; // Expression to evaluate for skipping
    disabledIf?: string;
  };
  timeout?: number; // seconds
  retryCount?: number;
}

export interface WorkflowEdge {
  id: string;
  workflowId: string;
  sourceId: string;
  targetId: string;
  condition?: string; // Optional edge condition
}

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  version: number;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowVersion: number;
  projectId: string;
  environmentId?: string;
  status: WorkflowNodeStatus;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  errorMessage?: string;
}

export interface WorkflowNodeRun {
  id: string;
  workflowRunId: string;
  nodeId: string;
  status: WorkflowNodeStatus;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  output?: string;
  errorMessage?: string;
  inputSnapshot: Record<string, string>;
  outputSnapshot: Record<string, string>;
}

// ============================================================================
// Build & Artifacts (spec §60–§62)
// ============================================================================

export type BuildType = "local" | "remote" | "docker" | "external-ci" | "no-build";

export type ArtifactType =
  | "static-directory"
  | "zip"
  | "tar"
  | "jar"
  | "binary"
  | "docker-image"
  | "docker-digest"
  | "custom";

export interface BuildProfile {
  id: string;
  projectId: string;
  name: string;
  buildType: BuildType;
  buildCommand?: string;
  outputPath?: string;
  dockerfile?: string;
  dockerContext?: string;
  dockerTag?: string;
  externalCiUrl?: string;
  createdAt: number;
}

export interface Build {
  id: string;
  projectId: string;
  buildProfileId: string;
  gitCommit?: string;
  gitBranch?: string;
  artifactId?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  duration?: number;
  output?: string;
  errorMessage?: string;
}

export interface Artifact {
  id: string;
  buildId: string;
  projectId: string;
  artifactType: ArtifactType;
  path: string;
  checksum: string;
  size: number;
  gitCommit?: string;
  buildId: string;
  createdAt: number;
  metadata?: Record<string, string>;
}

// ============================================================================
// Deployments (spec §63–§80)
// ============================================================================

export type DeploymentStrategy =
  | "restart"
  | "graceful-reload"
  | "atomic-switch"
  | "rolling"
  | "blue-green";

export type DeploymentType =
  | "nginx-static"
  | "docker"
  | "docker-compose"
  | "native-service"
  | "custom";

export type DeploymentStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "rolling-back" | "rolled-back";

export interface DeploymentProfile {
  id: string;
  projectId: string;
  name: string;
  deploymentType: DeploymentType;
  deploymentStrategy: DeploymentStrategy;
  targetServerIds: string[];
  targetServerGroupId?: string;
  // Nginx specific
  nginxConfigTemplate?: string;
  nginxSites?: string[];
  // Docker specific
  dockerImage?: string;
  dockerTag?: string;
  dockerComposeFile?: string;
  dockerRunArgs?: string[];
  // Native service specific
  systemdServiceName?: string;
  systemdServiceFile?: string;
  // Health check
  healthCheckType?: "process" | "port" | "http" | "https" | "docker-health" | "command" | "database" | "redis" | "composite";
  healthCheckUrl?: string;
  healthCheckPort?: number;
  healthCheckCommand?: string;
  healthCheckInterval?: number;
  healthCheckTimeout?: number;
  // Rollback
  autoRollbackOnHealthFailure: boolean;
  rollbackStrategy?: DeploymentStrategy;
  // Config
  configOverrides: Record<string, string>;
  createdAt: number;
}

export interface Deployment {
  id: string;
  projectId: string;
  deploymentProfileId: string;
  environmentId?: string;
  artifactId?: string;
  gitCommit?: string;
  workflowId?: string;
  workflowVersion?: number;
  status: DeploymentStatus;
  statusMessage?: string;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  // Snapshot data (spec §79)
  snapshot?: DeploymentSnapshot;
}

export interface DeploymentSnapshot {
  id: string;
  deploymentId: string;
  projectId: string;
  environmentId?: string;
  gitCommit?: string;
  artifactId?: string;
  workflowVersion: number;
  resolvedConfig: Record<string, string>;
  dependencySnapshot: Record<string, any>;
  serverFingerprint: string;
  dockerDigest?: string;
  nginxConfig?: string;
  composeSnapshot?: string;
  systemdSnapshot?: string;
  migrationState?: string;
  healthResult?: HealthResult;
  createdAt: number;
}

// Health Check (spec §76)
export interface HealthResult {
  id: string;
  deploymentId?: string;
  workflowRunId?: string;
  type: "process" | "port" | "http" | "https" | "docker-health" | "command" | "database" | "redis" | "composite";
  status: "healthy" | "unhealthy" | "degraded" | "unknown";
  checkedAt: number;
  responseTime?: number;
  details?: Record<string, any>;
  errorMessage?: string;
}

// ============================================================================
// Docker (spec §32–§33)
// ============================================================================

export type DockerStatus = "not-installed" | "cli-missing" | "daemon-down" | "permission-denied" | "ready";

export interface DockerHost {
  id: string;
  serverId: string;
  status: DockerStatus;
  version?: string;
  daemonInfo?: Record<string, any>;
  composeVersion?: string;
  lastCheckedAt: number;
}

export type ContainerStatus = "created" | "restarting" | "running" | "removing" | "paused" | "exited" | "dead";

export interface DockerContainer {
  id: string;
  dockerHostId: string;
  name: string;
  image: string;
  status: ContainerStatus;
  ports: Array<{
    hostPort: number;
    containerPort: number;
    protocol: string;
  }>;
  volumes: string[];
  networks: string[];
  createdAt: number;
  startedAt?: number;
  health?: string;
}

export interface DockerImage {
  id: string;
  dockerHostId: string;
  repository: string;
  tag: string;
  digest: string;
  size: number;
  createdAt: number;
}

export interface DockerCompose {
  id: string;
  dockerHostId: string;
  filePath: string;
  projectName: string;
  services: string[];
  status: "up" | "down" | "partially-up" | "error";
  lastChangedAt: number;
}

// ============================================================================
// Nginx (spec §34)
// ============================================================================

export type NginxStatus = "not-installed" | "installed" | "running" | "stopped" | "error";

export interface NginxInstance {
  id: string;
  serverId: string;
  status: NginxStatus;
  version?: string;
  configPath?: string;
  lastCheckedAt: number;
}

export type NginxSiteStatus = "enabled" | "disabled" | "error";

export interface NginxSite {
  id: string;
  nginxInstanceId: string;
  name: string;
  configPath: string;
  status: NginxSiteStatus;
  domains: string[];
  root?: string;
  proxyPass?: string;
  sslEnabled: boolean;
  sslCertPath?: string;
  sslKeyPath?: string;
  lastReloadedAt?: number;
}

export interface NginxConfigSnapshot {
  id: string;
  nginxInstanceId: string;
  configContent: string;
  createdAt: number;
  description?: string;
}

export interface NginxUpstream {
  id: string;
  nginxInstanceId: string;
  name: string;
  servers: Array<{
    address: string;
    port: number;
    weight?: number;
    maxFails?: number;
    failTimeout?: number;
  }>;
  method?: string; // round-robin, least-conn, ip-hash, etc.
}

// ============================================================================
// Tasks (spec §107–§108)
// ============================================================================

export type TaskType =
  | "transfer"
  | "build"
  | "deploy"
  | "rollback"
  | "docker-pull"
  | "docker-build"
  | "git-clone"
  | "git-pull"
  | "command"
  | "health-check"
  | "custom";

export type TaskStatus = "pending" | "running" | "waiting-approval" | "paused" | "succeeded" | "failed" | "cancelled" | "rolling-back";

export interface Task {
  id: string;
  type: TaskType;
  title: string;
  description?: string;
  status: TaskStatus;
  progress: number; // 0-100
  serverId?: string;
  projectId?: string;
  deploymentId?: string;
  buildId?: string;
  transferId?: string;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  errorMessage?: string;
  metadata?: Record<string, any>;
}

// ============================================================================
// AI (spec §84–§90)
// ============================================================================

export type AiProvider = "local" | "openai" | "anthropic" | "azure" | "custom";

export interface AiProviderConfig {
  id: string;
  name: string;
  type: AiProvider;
  apiUrl?: string;
  apiKeyReference?: string; // Secret reference
  model: string;
  enabled: boolean;
  timeout: number;
  maxTokens: number;
}

export type AiConversationRole = "user" | "assistant" | "system";

export interface AiMessage {
  id: string;
  conversationId: string;
  role: AiConversationRole;
  content: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export interface AiConversation {
  id: string;
  providerId: string;
  title: string;
  messages: AiMessage[];
  context?: {
    serverId?: string;
    projectId?: string;
    filePath?: string;
    command?: string;
    logContent?: string;
  };
  createdAt: number;
  updatedAt: number;
}

export interface AiProposal {
  id: string;
  type: "command" | "config" | "workflow" | "deployment" | "diagnosis";
  content: string;
  explanation?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  riskExplanation?: string;
  suggestedActions: string[];
  createdAt: number;
}

// ============================================================================
// Settings
// ============================================================================

export interface AppSettings {
  id: string;
  // UI
  theme: "dark" | "light" | "system";
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  // Terminal
  terminalFont: string;
  terminalFontSize: number;
  terminalTheme: string;
  terminalShell: string;
  // SSH
  defaultUsername: string;
  defaultPort: number;
  keepAliveInterval: number;
  reconnectPolicy: "disabled" | "manual" | "auto";
  connectionTimeout: number;
  maxReconnectAttempts: number;
  // AI
  aiEnabled: boolean;
  aiProviderId?: string;
  aiModel: string;
  // Security
  autoTrustHostKeys: boolean;
  // Notifications
  notificationsEnabled: boolean;
  // Update
  autoCheckUpdates: boolean;
}

// ============================================================================
// Audit (spec §109)
// ============================================================================

export type AuditAction =
  | "ssh-login"
  | "command"
  | "file-upload"
  | "file-edit"
  | "docker-operation"
  | "nginx-change"
  | "build"
  | "deploy"
  | "rollback"
  | "ai-proposed-action"
  | "server-create"
  | "server-update"
  | "server-delete"
  | "project-create"
  | "project-update"
  | "project-delete";

export interface AuditLog {
  id: string;
  action: AuditAction;
  timestamp: number;
  userId?: string;
  serverId?: string;
  serverName?: string;
  projectId?: string;
  projectName?: string;
  details: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

// ============================================================================
// Known Hosts (spec §10)
// ============================================================================

export interface KnownHost {
  id: string;
  host: string;
  port: number;
  fingerprint: string;
  fingerprintType: "sha256" | "md5" | "sha1";
  status: "trusted" | "untrusted" | "revoked";
  firstSeenAt: number;
  lastSeenAt: number;
}

// ============================================================================
// Users (spec §91)
// ============================================================================

export interface User {
  id: string;
  username: string;
  displayName?: string;
  passwordHash: string; // Argon2id
  role: "admin" | "user";
  createdAt: number;
  updatedAt: number;
}
