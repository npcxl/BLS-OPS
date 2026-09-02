/** Session / history / audit-log domain types. */

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
