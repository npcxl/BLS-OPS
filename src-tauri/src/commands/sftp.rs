//! SFTP commands (remote file browsing over the live session) and the
//! on-demand directory-size service.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use super::record_audit;
use crate::{dirsize::DirectorySizeResult, state::AppState};

/// One directory listing: the canonical path actually read, plus its entries.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SftpListResult {
    pub path: String,
    pub entries: Vec<crate::ssh::RemoteFileEntry>,
}

#[tauri::command]
pub async fn sftp_open(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    state
        .ssh
        .sftp_open(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    session_id: String,
    path: Option<String>,
) -> Result<SftpListResult, String> {
    let (path, entries) = state
        .ssh
        .sftp_list_dir(&session_id, path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(SftpListResult { path, entries })
}

// -- Directory size (on-demand, background) -------------------------------

/// Starts computing the size of a remote directory in the background and
/// begins emitting `directory-size-update` events as it progresses. A second
/// call for the same session + path replays the current (possibly finished)
/// state instead of launching a duplicate scan.
#[tauri::command]
pub async fn directory_size_start(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    timeout_ms: Option<u64>,
    force: Option<bool>,
) -> Result<DirectorySizeResult, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5 * 60_000).max(1_000));
    let initial = state.dir_sizes.start(
        Some(Arc::new(move |result| {
            let _ = app.emit(crate::dirsize::DIR_SIZE_EVENT, &result);
        })),
        Arc::new(state.ssh.clone()),
        session_id,
        path,
        timeout,
        force.unwrap_or(false),
    );
    Ok(initial)
}

/// Asks a running computation to stop. The result, once cancelled, is
/// reported with status `cancelled` through the event stream.
#[tauri::command]
pub async fn directory_size_cancel(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    state.dir_sizes.cancel(&session_id, &path);
    Ok(())
}

/// Snapshot of the current (or last) computation for a path, or `None` if it
/// was never requested.
#[tauri::command]
pub async fn directory_size_status(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Option<DirectorySizeResult>, String> {
    Ok(state.dir_sizes.status(&session_id, &path))
}

#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    state
        .ssh
        .sftp_realpath(&session_id, &path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sftp_stat(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<crate::ssh::RemoteFileEntry, String> {
    state
        .ssh
        .sftp_stat(&session_id, &path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sftp_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state
        .ssh
        .sftp_close(&session_id)
        .await
        .map_err(|error| error.to_string())
}

/// Uploads local files/directories (paths handed over by a drag & drop) into
/// `remote_dir`. Emits `sftp-upload-{session_id}` once per finished file so
/// the UI can show progress without polling.
#[tauri::command]
pub async fn sftp_upload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<Vec<crate::ssh::RemoteFileEntry>, String> {
    let session_id_for_cb = session_id.clone();
    let uploaded = state
        .ssh
        .sftp_upload(&session_id, &local_paths, &remote_dir, &|name| {
            let _ = app.emit(
                &format!("sftp-upload-{session_id_for_cb}"),
                name.to_string(),
            );
        })
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "sftp_upload",
        None,
        None,
        &format!("{} file(s) → {remote_dir}", uploaded.len()),
    );
    Ok(uploaded)
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    state
        .ssh
        .sftp_remove(&session_id, &path)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "sftp_remove", None, None, &path);
    Ok(())
}

/// Renames `path` to `new_name` (plain name, stays in the same directory).
#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let new_path = state
        .ssh
        .sftp_rename(&session_id, &path, &new_name)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "sftp_rename",
        None,
        None,
        &format!("{path} → {new_path}"),
    );
    Ok(new_path)
}

/// Copies a file or directory within its own directory under `new_name`.
#[tauri::command]
pub async fn sftp_copy(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let new_path = state
        .ssh
        .sftp_copy(&session_id, &path, &new_name)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "sftp_copy",
        None,
        None,
        &format!("{path} → {new_path}"),
    );
    Ok(new_path)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let created = state
        .ssh
        .sftp_mkdir(&session_id, &path)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "sftp_mkdir", None, None, &created);
    Ok(created)
}

/// Creates an empty remote file (the "新建文件" action).
#[tauri::command]
pub async fn sftp_touch(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let created = state
        .ssh
        .sftp_touch(&session_id, &path)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "sftp_touch", None, None, &created);
    Ok(created)
}

/// Reads a remote file for the in-app editor (text files only, size-capped).
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<crate::ssh::RemoteFileContent, String> {
    const MAX_EDIT_SIZE: u64 = 2 * 1024 * 1024;
    let content = state
        .ssh
        .sftp_read_file(&session_id, &path, MAX_EDIT_SIZE)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "sftp_read_file", None, None, &path);
    Ok(content)
}

/// Saves editor content back to the remote file.
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    state
        .ssh
        .sftp_write_file(&session_id, &path, &content)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "sftp_write_file", None, None, &path);
    Ok(())
}
