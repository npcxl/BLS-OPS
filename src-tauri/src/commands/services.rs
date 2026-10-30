//! Service management (systemd) and the journald log centre.

use tauri::{AppHandle, Emitter, State};

use super::record_audit;
use crate::ops_error::{OpsError, OpsResult};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Service management — systemd (P3-1.1)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn service_list(
    state: State<'_, AppState>,
    session_id: String,
) -> OpsResult<Vec<crate::systemd::ServiceUnit>> {
    crate::systemd::collect_services(&state.ssh, &session_id)
        .await
        .map_err(|error| OpsError::from_stage("systemd", error).retryable())
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
) -> OpsResult<String> {
    let action = parse_service_action(&action).map_err(|error| OpsError::new("systemd", error))?;
    let outcome = crate::systemd::service_action(&state.ssh, &session_id, action, &unit)
        .await
        .map_err(|error| OpsError::from_stage("systemd", error))?;

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
) -> OpsResult<String> {
    crate::systemd::service_status(&state.ssh, &session_id, &unit)
        .await
        .map_err(|error| OpsError::from_stage("systemd", error).retryable())
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
) -> OpsResult<Vec<crate::journal::JournalEntry>> {
    let query = crate::journal::JournalQuery {
        unit: unit.filter(|value| !value.trim().is_empty()),
        lines,
        priority,
    };
    crate::journal::collect_journal(&state.ssh, &session_id, &query)
        .await
        .map_err(|error| OpsError::from_stage("journal", error).retryable())
}

#[tauri::command]
pub async fn journal_disk_usage(
    state: State<'_, AppState>,
    session_id: String,
) -> OpsResult<crate::journal::JournalDiskUsage> {
    crate::journal::collect_disk_usage(&state.ssh, &session_id)
        .await
        .map_err(|error| OpsError::from_stage("journal", error).retryable())
}
