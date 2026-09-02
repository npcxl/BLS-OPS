//! Service management (systemd) and the journald log centre.

use tauri::{AppHandle, Emitter, State};

use super::record_audit;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Service management — systemd (P3-1.1)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn service_list(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<crate::systemd::ServiceUnit>, String> {
    crate::systemd::collect_services(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

/// Start / stop / restart / reload / enable / disable a unit.
///
/// `action` is one of the fixed verbs in [`crate::safe::ServiceAction`]; an
/// unknown verb never reaches the shell.
#[tauri::command]
pub async fn service_action(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    action: String,
    unit: String,
) -> Result<String, String> {
    let action = parse_service_action(&action)?;
    let outcome = crate::systemd::service_action(&state.ssh, &session_id, action, &unit)
        .await
        .map_err(|error| error.to_string())?;

    record_audit(
        &state,
        "service_action",
        None,
        None,
        &format!(
            "{{\"session\":\"{session_id}\",\"action\":\"{}\",\"unit\":\"{unit}\"}}",
            action.label()
        ),
    );
    // The list page reloads on this event so the new state shows immediately.
    let _ = app.emit(&format!("services-changed-{session_id}"), &unit);

    Ok(outcome)
}

pub(crate) fn parse_service_action(action: &str) -> Result<crate::safe::ServiceAction, String> {
    use crate::safe::ServiceAction;
    match action {
        "start" => Ok(ServiceAction::Start),
        "stop" => Ok(ServiceAction::Stop),
        "restart" => Ok(ServiceAction::Restart),
        "reload" => Ok(ServiceAction::Reload),
        "enable" => Ok(ServiceAction::Enable),
        "disable" => Ok(ServiceAction::Disable),
        other => Err(format!("不支持的服务操作：{other}")),
    }
}

#[tauri::command]
pub async fn service_status(
    state: State<'_, AppState>,
    session_id: String,
    unit: String,
) -> Result<String, String> {
    crate::systemd::service_status(&state.ssh, &session_id, &unit)
        .await
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Log centre — journald (P3-1.2)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn journal_query(
    state: State<'_, AppState>,
    session_id: String,
    unit: Option<String>,
    lines: u32,
    priority: Option<u8>,
) -> Result<Vec<crate::journal::JournalEntry>, String> {
    let query = crate::journal::JournalQuery {
        unit: unit.filter(|value| !value.trim().is_empty()),
        lines,
        priority,
    };
    crate::journal::collect_journal(&state.ssh, &session_id, &query)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn journal_disk_usage(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<crate::journal::JournalDiskUsage, String> {
    crate::journal::collect_disk_usage(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}
