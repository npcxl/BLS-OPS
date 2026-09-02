//! Row types — one struct per table, mirroring the schema column for column.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerRecord {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub credential_id: Option<String>,
    pub group_id: Option<String>,
    pub tags: Vec<String>,
    pub proxy_jump_id: Option<String>,
    pub favorite: bool,
    pub last_connected_at: Option<i64>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerGroupRecord {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialRecord {
    pub id: String,
    pub name: String,
    pub credential_type: String,
    pub username: String,
    /// Keyring reference only — the secret itself never lives in SQLite.
    pub secret_ref: Option<String>,
    pub passphrase_ref: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHostRecord {
    pub id: String,
    pub host: String,
    pub port: i64,
    pub fingerprint: String,
    pub fingerprint_type: String,
    pub status: String,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub server_id: String,
    pub server_name: String,
    pub server_host: String,
    pub server_port: i64,
    pub username: String,
    pub status: String,
    pub connected_at: Option<i64>,
    pub disconnected_at: Option<i64>,
    pub error_message: Option<String>,
    pub keep_alive_interval: i64,
    pub reconnect_policy: String,
    pub terminal_rows: Option<i64>,
    pub terminal_cols: Option<i64>,
    pub terminal_pty: Option<bool>,
    pub sftp_enabled: bool,
    pub port_forwards_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandHistoryRecord {
    pub id: String,
    pub session_id: String,
    pub server_id: String,
    pub server_name: String,
    pub command: String,
    pub timestamp: i64,
    pub exit_code: Option<i64>,
    pub source: String,
    pub output: Option<String>,
}

/// A deployment target: one project on one server (P3-2.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub server_id: String,
    pub repo_url: String,
    pub branch: String,
    /// Absolute directory on the server. Deployment steps may not reference
    /// paths outside it — enforced on save *and* on every run.
    pub deploy_path: String,
    /// JSON array of deployment steps. Each one is validated against the
    /// allowlist in `safe::validate_deploy_step` before it is stored.
    pub commands_json: String,
    /// Mirrors the last deployment: `idle` | `success` | `failed` | `running`.
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One deployment run (P3-2.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentRecord {
    pub id: String,
    pub project_id: String,
    /// Denormalised so history stays readable after a project is renamed.
    pub project_name: String,
    pub server_id: String,
    pub server_name: String,
    /// `pending` | `running` | `success` | `failed`
    pub status: String,
    /// What started it: `manual` today.
    pub trigger_source: String,
    pub branch: String,
    pub commit_sha: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
    /// Step-by-step output, appended as the run proceeds.
    pub log: String,
    pub error_message: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLogRecord {
    pub id: String,
    pub action: String,
    pub timestamp: i64,
    pub user_id: Option<String>,
    pub server_id: Option<String>,
    pub server_name: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub details_json: String,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
}

/// How many dependent rows were removed alongside a server.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct CascadeResult {
    pub sessions: i64,
    pub history: i64,
}
