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
  status: string;
  created_at: number;
  updated_at: number;
}

export interface CredentialRecord {
  id: string;
  name: string;
  credential_type: string;
  username: string;
  secret_ref?: string | null;
  created_at: number;
  updated_at: number;
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

export const opsApi = {
  listServers: () => invoke<ServerRecord[]>("server_list"),
  getServer: (id: string) => invoke<ServerRecord | null>("server_get", { id }),
  saveServer: (server: ServerRecord) => invoke<ServerRecord>("server_save", { server }),
  deleteServer: (id: string) => invoke<void>("server_delete", { id }),
  listCredentials: () => invoke<CredentialRecord[]>("credential_list"),
  saveCredential: (credential: CredentialRecord, secret?: string) => invoke<CredentialRecord>("credential_save", { credential, secret }),
  deleteCredential: (id: string, secretRef?: string | null) => invoke<void>("credential_delete", { id, secretRef }),
  listKnownHosts: () => invoke<KnownHostRecord[]>("known_host_list"),
  saveKnownHost: (host: KnownHostRecord) => invoke<KnownHostRecord>("known_host_save", { host }),
  getKnownHost: (host: string, port: number) => invoke<KnownHostRecord | null>("known_host_get", { host, port }),
  confirmKnownHost: (host: KnownHostRecord) => invoke<KnownHostRecord>("known_host_confirm", { host }),
  listAuditLogs: (limit = 100) => invoke<AuditLogRecord[]>("audit_log_list", { limit }),
  recordAuditLog: (action: string, serverId: string | null, serverName: string | null, details: string) => invoke<void>("audit_log_record", { action, serverId, serverName, details }),
  saveCredentialSecret: (secretId: string, secret: string) => invoke<string>("credential_save_secret", { secretId, secret }),
  getCredentialSecret: (secretId: string) => invoke<string>("credential_get_secret", { secretId }),
  deleteCredentialSecret: (secretId: string) => invoke<void>("credential_delete_secret", { secretId }),
  recordHistory: (sessionId: string, serverId: string, serverName: string, command: string) => invoke<void>("history_record", { sessionId, serverId, serverName, command }),
  listHistory: (limit: number) => invoke<CommandHistoryRecord[]>("history_list", { limit }),
  sshConnect: (sessionId: string, serverId: string) => invoke<void>("ssh_connect", { sessionId, serverId }),
  sshInput: (sessionId: string, data: string) => invoke<void>("ssh_input", { sessionId, data }),
  sshResize: (sessionId: string, cols: number, rows: number) => invoke<void>("ssh_resize", { sessionId, cols, rows }),
  sshDisconnect: (sessionId: string) => invoke<void>("ssh_disconnect", { sessionId }),
};
