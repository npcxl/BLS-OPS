//! Known-host commands (host key trust store).

use tauri::State;

use super::{open_db, record_audit};
use crate::ops_error::{OpsError, OpsResult};
use crate::{db, state::AppState};

/// 主机密钥相关失败属于 SSH 信任链问题。
fn known_host_error(error: impl ToString) -> OpsError {
    OpsError::from_stage("ssh", error)
}

#[tauri::command]
pub fn known_host_list(state: State<'_, AppState>) -> OpsResult<Vec<db::KnownHostRecord>> {
    let conn = open_db(&state)?;
    db::list_known_hosts(&conn).map_err(|error| known_host_error(error).retryable())
}

#[tauri::command]
pub fn known_host_get(
    state: State<'_, AppState>,
    host: String,
    port: i64,
) -> OpsResult<Option<db::KnownHostRecord>> {
    let conn = open_db(&state)?;
    db::get_known_host(&conn, &host, port).map_err(|error| known_host_error(error).retryable())
}

#[tauri::command]
pub fn known_host_delete(state: State<'_, AppState>, id: String) -> OpsResult<bool> {
    let conn = open_db(&state)?;
    let removed = db::delete_known_host(&conn, &id).map_err(known_host_error)?;
    if removed {
        record_audit(&state, "known_host_delete", None, None, &id);
    }
    Ok(removed)
}

/// Records the user's decision for a host key shown during the handshake.
/// `trust = false` explicitly refuses the key; the connection stays closed.
#[tauri::command]
pub fn known_host_trust(
    state: State<'_, AppState>,
    host: String,
    port: i64,
    fingerprint: String,
    fingerprint_type: Option<String>,
    trust: bool,
) -> OpsResult<Option<db::KnownHostRecord>> {
    if !(1..=65535).contains(&port) {
        return Err(OpsError::new("config", "端口必须在 1 到 65535 之间"));
    }
    if !trust {
        record_audit(
            &state,
            "known_host_reject",
            None,
            None,
            &format!("{host}:{port}"),
        );
        return Ok(None);
    }
    if fingerprint.trim().is_empty() {
        return Err(OpsError::new("config", "主机指纹不能为空"));
    }
    let conn = open_db(&state)?;
    let record = db::trust_known_host(
        &conn,
        host.trim(),
        port,
        fingerprint.trim(),
        fingerprint_type.as_deref().unwrap_or("ssh-rsa"),
    )
    .map_err(known_host_error)?;
    record_audit(
        &state,
        "known_host_confirm",
        None,
        None,
        &format!("{host}:{port}"),
    );
    Ok(Some(record))
}
