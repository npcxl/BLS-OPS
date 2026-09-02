//! Legacy project records and deployment execution (retained for P5).
//!
//! The steps come from the project record, **not** from the caller: the
//! WebView passes only a project id, so it cannot smuggle in a command.

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, State};

use super::{open_db, record_audit};
use crate::{db, state::AppState};

// ---------------------------------------------------------------------------
// Projects & deployments (legacy records retained for P5)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn project_list(state: State<'_, AppState>) -> Result<Vec<db::ProjectRecord>, String> {
    let conn = open_db(&state)?;
    db::list_projects(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn project_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<db::ProjectRecord>, String> {
    let conn = open_db(&state)?;
    db::get_project(&conn, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn project_save(
    state: State<'_, AppState>,
    project: db::ProjectRecord,
) -> Result<db::ProjectRecord, String> {
    let conn = open_db(&state)?;
    validate_project(&conn, &project)?;
    db::insert_or_replace_project(&conn, &project).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "project_save",
        Some(&project.server_id),
        None,
        &format!(
            "{{\"id\":\"{}\",\"name\":\"{}\"}}",
            project.id, project.name
        ),
    );
    Ok(project)
}

#[tauri::command]
pub async fn project_delete(state: State<'_, AppState>, id: String) -> Result<i64, String> {
    let conn = open_db(&state)?;
    let removed = db::delete_project_cascade(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "project_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\",\"deployments_removed\":{removed}}}"),
    );
    Ok(removed)
}

#[tauri::command]
pub async fn deployment_list(
    state: State<'_, AppState>,
    project_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<db::DeploymentRecord>, String> {
    let conn = open_db(&state)?;
    db::list_deployments(
        &conn,
        project_id.as_deref(),
        limit.unwrap_or(50).min(500) as i64,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<db::DeploymentRecord>, String> {
    let conn = open_db(&state)?;
    db::get_deployment(&conn, &id).map_err(|error| error.to_string())
}

/// Runs a project's deployment steps on a live session.
///
/// Each step is re-validated here even though it was validated on save,
/// because the record could have been edited since.
#[tauri::command]
pub async fn deployment_execute(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    session_id: String,
    // Supplying the id lets the caller subscribe to `deploy-progress-<id>`
    // *before* the run starts, so nothing emitted early is missed.
    // (A doc comment is not allowed on a command parameter.)
    deployment_id: Option<String>,
) -> Result<db::DeploymentRecord, String> {
    let conn = open_db(&state)?;

    let project = db::get_project(&conn, &project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;

    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".to_string());
    }

    let steps: Vec<String> = serde_json::from_str(&project.commands_json)
        .map_err(|error| format!("项目的部署步骤不是合法的 JSON：{error}"))?;

    // Validate before anything runs: a project with one bad step should fail
    // immediately, not halfway through a deploy.
    for step in &steps {
        crate::safe::validate_deploy_step(step, &project.deploy_path)
            .map_err(|error| error.to_string())?;
    }

    let server_name = db::get_server(&conn, &project.server_id)
        .map_err(|error| error.to_string())?
        .map(|server| server.name)
        .unwrap_or_default();

    let now = db::AppDb::now();
    let deployment_id = deployment_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut record = db::DeploymentRecord {
        id: deployment_id,
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        server_id: project.server_id.clone(),
        server_name: server_name.clone(),
        status: db::DEPLOY_RUNNING.to_string(),
        trigger_source: "manual".to_string(),
        branch: project.branch.clone(),
        commit_sha: String::new(),
        started_at: Some(now),
        finished_at: None,
        duration_ms: None,
        log: String::new(),
        error_message: None,
        created_at: now,
    };
    db::insert_deployment(&conn, &record).map_err(|error| error.to_string())?;
    db::set_project_status(&conn, &project.id, db::DEPLOY_RUNNING)
        .map_err(|error| error.to_string())?;

    let event = format!("deploy-progress-{}", record.id);
    let mut log = String::new();
    let mut failure: Option<String> = None;

    for (index, step) in steps.iter().enumerate() {
        let header = format!("[{}/{}] $ {}\n", index + 1, steps.len(), step);
        log.push_str(&header);
        let _ = app.emit(&event, log.clone());

        match crate::remote::run_capability(
            &state.ssh,
            &session_id,
            &crate::safe::Capability::DeployStep {
                step: step.clone(),
                root: project.deploy_path.clone(),
            },
        )
        .await
        {
            Ok(output) => {
                if !output.trim().is_empty() {
                    log.push_str(output.trim_end());
                    log.push('\n');
                }
            }
            Err(error) => {
                // The failing step's output is what makes the failure
                // diagnosable, so it is kept in the log.
                log.push_str(&format!("失败：{error}\n"));
                failure = Some(error.to_string());
            }
        }

        let _ = app.emit(&event, log.clone());
        if failure.is_some() {
            break;
        }
    }

    let finished = db::AppDb::now();
    let status = if failure.is_some() {
        db::DEPLOY_FAILED
    } else {
        db::DEPLOY_SUCCESS
    };
    record.status = status.to_string();
    record.finished_at = Some(finished);
    record.started_at = Some(record.started_at.unwrap_or(finished));
    record.duration_ms = Some((finished - record.started_at.unwrap_or(finished)).max(0));
    record.log = log.clone();
    record.error_message = failure.clone();

    db::update_deployment_progress(
        &conn,
        &record.id,
        status,
        &log,
        record.started_at,
        record.finished_at,
        failure.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    db::set_project_status(&conn, &project.id, status).map_err(|error| error.to_string())?;

    record_audit(
        &state,
        "deployment_execute",
        Some(&project.server_id),
        Some(&server_name),
        &format!(
            "{{\"project\":\"{}\",\"status\":\"{status}\",\"deployment\":\"{}\"}}",
            project.name, record.id
        ),
    );
    let _ = app.emit(&event, log);

    Ok(record)
}

/// Project validation kept free of Tauri types so it can be unit-tested.
pub(crate) fn validate_project(
    conn: &Connection,
    project: &db::ProjectRecord,
) -> Result<(), String> {
    if project.name.trim().is_empty() {
        return Err("项目名称不能为空".to_string());
    }
    if project.server_id.trim().is_empty() {
        return Err("请选择部署服务器".to_string());
    }
    db::get_server(conn, &project.server_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "所选服务器不存在，请重新选择".to_string())?;

    let path = project.deploy_path.trim();
    if !path.starts_with('/') {
        return Err("部署路径必须是绝对路径".to_string());
    }
    crate::safe::validate_abs_path(path, "部署路径").map_err(|error| error.to_string())?;

    if !project.branch.trim().is_empty() {
        crate::safe::validate_git_ref(project.branch.trim()).map_err(|error| error.to_string())?;
    }
    if !project.repo_url.trim().is_empty() {
        crate::safe::validate_repo_url(project.repo_url.trim())
            .map_err(|error| error.to_string())?;
    }

    // The important one: a deployment step is a command, so it is held to the
    // allowlist and confined to the project directory.
    let steps: Vec<String> = serde_json::from_str(&project.commands_json)
        .map_err(|error| format!("部署步骤不是合法的 JSON 数组：{error}"))?;
    if steps.is_empty() {
        return Err("至少需要一个部署步骤".to_string());
    }
    for step in &steps {
        crate::safe::validate_deploy_step(step, path).map_err(|error| error.to_string())?;
    }

    Ok(())
}
