//! Tauri command layer, split by domain (阶段 E of docs/模块化重构分析.md).
//!
//! Each child module owns one domain's `#[tauri::command]` functions. The
//! re-exports below keep every path `commands::server_list`-style working, so
//! `lib.rs`'s `invoke_handler` list is untouched by this refactor.

mod app;
mod containers;
mod credentials;
mod deployment;
mod gateway;
mod known_hosts;
mod monitor;
mod project;
mod servers;
mod services;
mod sessions;
mod sftp;
mod ssh;

pub use app::*;
pub use containers::*;
pub use credentials::*;
pub use deployment::*;
pub use gateway::*;
pub use known_hosts::*;
pub use monitor::*;
pub use project::*;
pub use servers::*;
pub use services::*;
pub use sessions::*;
pub use sftp::*;
pub use ssh::*;

use rusqlite::Connection;

use crate::{db, state::AppState};

pub(crate) const DEFAULT_SSH_PORT: u16 = 22;

pub(crate) fn open_db(state: &AppState) -> Result<Connection, String> {
    state.db.open().map_err(|error| error.to_string())
}

pub(crate) fn record_audit(
    state: &AppState,
    action: &str,
    server_id: Option<&str>,
    server_name: Option<&str>,
    details: &str,
) {
    let Ok(conn) = state.db.open() else { return };
    let _ = db::insert_audit_log(
        &conn,
        &db::AuditLogRecord {
            id: uuid::Uuid::new_v4().to_string(),
            action: action.to_string(),
            timestamp: db::AppDb::now(),
            user_id: None,
            server_id: server_id.map(str::to_string),
            server_name: server_name.map(str::to_string),
            project_id: None,
            project_name: None,
            details_json: details.to_string(),
            ip_address: None,
            user_agent: Some("ops-workbench".to_string()),
        },
    );
}

pub(crate) fn require_existing_credential(
    conn: &Connection,
    id: &str,
) -> Result<db::CredentialRecord, String> {
    db::get_credential(conn, id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "所选凭据不存在，请重新选择".to_string())
}

#[cfg(test)]
pub(crate) mod test_support {
    use rusqlite::Connection;

    /// Mirrors `AppDb::init` without touching the filesystem.
    pub(crate) fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE servers (
                id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL,
                port INTEGER NOT NULL, username TEXT NOT NULL, credential_id TEXT,
                group_id TEXT, tags TEXT NOT NULL DEFAULT '[]', proxy_jump_id TEXT,
                favorite INTEGER NOT NULL DEFAULT 0, last_connected_at INTEGER,
                status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE server_groups (
                id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE credentials (
                id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
                username TEXT NOT NULL, secret_ref TEXT, passphrase_ref TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            "#,
        )
        .unwrap();
        conn
    }
}

#[cfg(test)]
mod tests;
