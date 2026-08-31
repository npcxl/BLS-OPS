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
      host: string;
      port: number;
      hop: string;
      fingerprint: string;
      fingerprint_type: string;
    }
  | {
      status: "host_key_changed";
      session_id: string;
      host: string;
      port: number;
      hop: string;
      fingerprint: string;
      fingerprint_type: string;
      known_fingerprint: string;
    };

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
    cols?: number;
    rows?: number;
  }) =>
    invoke<SshConnectResult>("ssh_connect", {
      sessionId: args.sessionId,
      serverId: args.serverId ?? null,
      target: args.target ?? null,
      credentialId: args.credentialId ?? null,
      cols: args.cols ?? 120,
      rows: args.rows ?? 32,
    }),
  sshInput: (sessionId: string, data: string) => invoke<void>("ssh_input", { sessionId, data }),
  sshResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("ssh_resize", { sessionId, cols, rows }),
  sshKeepalive: (sessionId: string) => invoke<void>("ssh_keepalive", { sessionId }),
  sshStatus: (sessionId: string) => invoke<boolean>("ssh_status", { sessionId }),
  sshDisconnect: (sessionId: string) => invoke<void>("ssh_disconnect", { sessionId }),
};
