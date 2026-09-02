//! Known-host commands (host key trust store).

use tauri::State;

use super::{open_db, record_audit};
use crate::{db, state::AppState};

#[tauri::command]
pub fn known_host_list(state: State<'_, AppState>) -> Result<Vec<db::KnownHostRecord>, String> {
    let conn = open_db(&state)?;
    db::list_known_hosts(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn known_host_get(
    state: State<'_, AppState>,
    host: String,
    port: i64,
) -> Result<Option<db::KnownHostRecord>, String> {
    let conn = open_db(&state)?;
    db::get_known_host(&conn, &host, port).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn known_host_delete(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let conn = open_db(&state)?;
    let removed = db::delete_known_host(&conn, &id).map_err(|error| error.to_string())?;
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
) -> Result<Option<db::KnownHostRecord>, String> {
    if !(1..=65535).contains(&port) {
        return Err("端口必须在 1 到 65535 之间".to_string());
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
        return Err("主机指纹不能为空".to_string());
    }
    let conn = open_db(&state)?;
    let record = db::trust_known_host(
        &conn,
        host.trim(),
        port,
        fingerprint.trim(),
        fingerprint_type.as_deref().unwrap_or("ssh-rsa"),
    )
    .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "known_host_confirm",
        None,
        None,
        &format!("{host}:{port}"),
    );
    Ok(Some(record))
}
