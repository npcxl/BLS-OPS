/**
 * Platform / system-level domain — spec §10, §91, §109.
 * Settings, audit log, known hosts, and users.
 */

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
