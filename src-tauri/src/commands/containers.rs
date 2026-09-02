//! Docker container/image commands (P3-1.3).

use tauri::{AppHandle, Emitter, State};

use super::record_audit;
use crate::state::AppState;

#[tauri::command]
pub async fn docker_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<crate::docker::DockerSnapshot, String> {
    crate::docker::collect_snapshot(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn docker_logs(
    state: State<'_, AppState>,
    session_id: String,
    container: String,
    lines: u32,
) -> Result<String, String> {
    crate::docker::collect_logs(&state.ssh, &session_id, &container, lines)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn docker_container_action(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    action: String,
    container: String,
) -> Result<String, String> {
    let action = match action.as_str() {
        "start" => crate::safe::ContainerAction::Start,
        "stop" => crate::safe::ContainerAction::Stop,
        "restart" => crate::safe::ContainerAction::Restart,
        "remove" => crate::safe::ContainerAction::Remove,
        other => return Err(format!("不支持的容器操作：{other}")),
    };

    let outcome = crate::docker::container_action(&state.ssh, &session_id, action, &container)
        .await
        .map_err(|error| error.to_string())?;

    record_audit(
        &state,
        "docker_container_action",
        None,
        None,
        &format!(
            "{{\"session\":\"{session_id}\",\"action\":\"{}\",\"container\":\"{container}\"}}",
            action.label()
        ),
    );
    let _ = app.emit(&format!("docker-changed-{session_id}"), &container);

    Ok(outcome)
}

#[tauri::command]
pub async fn docker_image_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    image: String,
) -> Result<String, String> {
    let outcome = crate::docker::image_remove(&state.ssh, &session_id, &image)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "docker_image_remove",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\",\"image\":\"{image}\"}}"),
    );
    let _ = app.emit(&format!("docker-changed-{session_id}"), &image);
    Ok(outcome)
}

/// Drops stopped containers and dangling images. Destructive, so it is audited
/// and the frontend confirms before calling.
#[tauri::command]
pub async fn docker_prune(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let outcome = crate::docker::system_prune(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "docker_prune",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\"}}"),
    );
    let _ = app.emit(&format!("docker-changed-{session_id}"), "prune");
    Ok(outcome)
}
