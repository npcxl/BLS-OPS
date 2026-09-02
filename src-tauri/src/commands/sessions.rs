//! Session records, command history and audit-log queries.

use serde::Serialize;
use tauri::State;

use super::open_db;
use crate::{db, state::AppState};

#[tauri::command]
pub fn session_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<db::SessionRecord>, String> {
    let conn = open_db(&state)?;
    db::list_recent_sessions(&conn, limit.unwrap_or(20).clamp(1, 200))
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionStats {
    /// Live sessions tracked by `SshSessionManager` — the source of truth for
    /// the status bar, never a hard-coded number.
    pub active: usize,
    pub keepalive_secs: u64,
}

#[tauri::command]
pub async fn session_stats(state: State<'_, AppState>) -> Result<SessionStats, String> {
    Ok(SessionStats {
        active: state.ssh.active_count().await,
        keepalive_secs: crate::ssh::DEFAULT_KEEPALIVE_SECS,
    })
}

#[tauri::command]
pub fn history_record(
    state: State<'_, AppState>,
    session_id: String,
    server_id: String,
    server_name: String,
    command: String,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Ok(());
    }
    let conn = open_db(&state)?;
    db::insert_command_history(
        &conn,
        &db::CommandHistoryRecord {
            id: uuid::Uuid::new_v4().to_string(),
            session_id,
            server_id,
            server_name,
            command,
            timestamp: db::AppDb::now(),
            exit_code: None,
            source: "terminal".to_string(),
            output: None,
        },
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn history_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<db::CommandHistoryRecord>, String> {
    let conn = open_db(&state)?;
    db::list_command_history(&conn, limit.unwrap_or(100).clamp(1, 500))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn audit_log_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<db::AuditLogRecord>, String> {
    let conn = open_db(&state)?;
    db::list_audit_logs(&conn, limit.unwrap_or(100).clamp(1, 500))
        .map_err(|error| error.to_string())
}
