/**
 * SSH & Server domain — spec §8, §10, §25, §27.
 */

// ============================================================================
// Credentials
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

// ============================================================================
// Server & Groups
// ============================================================================

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

// ============================================================================
// Server Facts (Environment Inspector, spec §25)
// ============================================================================

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

// ============================================================================
// Capabilities (Capability Engine, spec §27)
// ============================================================================

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
