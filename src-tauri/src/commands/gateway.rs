//! Nginx gateway commands (P3-1.4).

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::record_audit;
use crate::state::AppState;

#[tauri::command]
pub async fn nginx_sites(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<crate::nginx::NginxSite>, String> {
    crate::nginx::collect_sites_with_summary(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn nginx_config(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    crate::nginx::read_config(&state.ssh, &session_id, &path)
        .await
        .map_err(|error| error.to_string())
}

/// Writes a config file, validates it, and only then reloads.
///
/// The order matters: saving an invalid config and reloading would take the
/// site offline, so the reload is skipped when `nginx -t` fails and the error
/// is returned for the UI to show.
#[derive(Debug, Clone, Serialize)]
pub struct NginxSaveResult {
    pub saved: bool,
    pub test: crate::nginx::NginxTestResult,
    pub reloaded: bool,
    /// Where the pre-edit copy went, so a mistake is recoverable.
    pub backup_path: Option<String>,
}

#[tauri::command]
pub async fn nginx_save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<NginxSaveResult, String> {
    // Back up first: an edit that fails validation still leaves the original
    // recoverable, and the operator is told where it is.
    let backup_path = crate::nginx::backup_config(&state.ssh, &session_id, &path)
        .await
        .ok();

    state
        .ssh
        .sftp_write_file(&session_id, &path, &content)
        .await
        .map_err(|error| error.to_string())?;

    let test = crate::nginx::test_config(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())?;

    let reloaded = if test.success {
        crate::nginx::reload(&state.ssh, &session_id).await.is_ok()
    } else {
        false
    };

    record_audit(
        &state,
        "nginx_save_config",
        None,
        None,
        &format!(
            "{{\"session\":\"{session_id}\",\"path\":\"{path}\",\"ok\":{}}}",
            test.success
        ),
    );
    let _ = app.emit(&format!("nginx-changed-{session_id}"), &path);

    Ok(NginxSaveResult {
        saved: true,
        test,
        reloaded,
        backup_path,
    })
}

#[tauri::command]
pub async fn nginx_test(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<crate::nginx::NginxTestResult, String> {
    crate::nginx::test_config(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn nginx_reload(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let outcome = crate::nginx::reload(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "nginx_reload",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\"}}"),
    );
    let _ = app.emit(&format!("nginx-changed-{session_id}"), "reload");
    Ok(outcome)
}

#[tauri::command]
pub async fn nginx_set_site_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    site: String,
    enable: bool,
) -> Result<String, String> {
    let outcome = crate::nginx::set_site_enabled(&state.ssh, &session_id, &site, enable)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "nginx_set_site_enabled",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\",\"site\":\"{site}\",\"enable\":{enable}}}"),
    );
    let _ = app.emit(&format!("nginx-changed-{session_id}"), &site);
    Ok(outcome)
}
