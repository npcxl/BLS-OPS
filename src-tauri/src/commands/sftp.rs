//! SFTP commands (remote file browsing over the live session) and the
//! on-demand directory-size service.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use super::record_audit;
use crate::ops_error::{OpsError, OpsResult};
use crate::{dirsize::DirectorySizeResult, state::AppState};

/// One directory listing: the canonical path actually read, plus its entries.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SftpListResult {
    pub path: String,
    pub entries: Vec<crate::ssh::RemoteFileEntry>,
}

#[tauri::command]
pub async fn sftp_open(state: State<'_, AppState>, session_id: String) -> OpsResult<String> {
    state
        .ssh
        .sftp_open(&session_id)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    session_id: String,
    path: Option<String>,
) -> OpsResult<SftpListResult> {
    let (path, entries) = state
        .ssh
        .sftp_list_dir(&session_id, path)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
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
) -> OpsResult<DirectorySizeResult> {
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
) -> OpsResult<()> {
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
) -> OpsResult<Option<DirectorySizeResult>> {
    Ok(state.dir_sizes.status(&session_id, &path))
}

/// Batched read-only status snapshot for the file panel's low-frequency
/// watchdog (at most 20 paths, deduplicated, empty paths rejected). Reads only
/// the registry's existing state — never starts a computation, never touches
/// the SSH session.
#[tauri::command]
pub async fn directory_size_status_many(
    state: State<'_, AppState>,
    session_id: String,
    paths: Vec<String>,
) -> OpsResult<Vec<DirectorySizeResult>> {
    state
        .dir_sizes
        .status_many(&session_id, &paths)
        .map_err(|error| OpsError::from_stage("sftp", error).retryable())
}

#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> OpsResult<String> {
    state
        .ssh
        .sftp_realpath(&session_id, &path)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))
}

#[tauri::command]
pub async fn sftp_stat(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> OpsResult<crate::ssh::RemoteFileEntry> {
    state
        .ssh
        .sftp_stat(&session_id, &path)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))
}

#[tauri::command]
pub async fn sftp_close(state: State<'_, AppState>, session_id: String) -> OpsResult<()> {
    state
        .ssh
        .sftp_close(&session_id)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))
}

/// Reads any remote file as base64 bytes for the in-app preview (images, PDFs,
/// Office documents, archives — everything, not just text).
#[tauri::command]
pub async fn sftp_read_binary(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    max_len: Option<u64>,
) -> OpsResult<crate::ssh::RemoteBinaryContent> {
    // 20 MB covers a spreadsheet or a photo with room to spare; bigger files
    // are still downloadable, they just are not rendered in the window.
    const DEFAULT_MAX: u64 = 20 * 1024 * 1024;
    let content = state
        .ssh
        .sftp_read_binary(&session_id, &path, max_len.unwrap_or(DEFAULT_MAX))
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
    record_audit(&state, "sftp_read_binary", None, None, &path);
    Ok(content)
}

/// Saves a remote file to a local path (the preview dialog's "下载" action).
/// The caller gets the destination from the native save dialog.
#[tauri::command]
pub async fn sftp_download_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    local_path: String,
) -> OpsResult<u64> {
    let written = state
        .ssh
        .sftp_download_file(&session_id, &path, &local_path)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
    record_audit(
        &state,
        "sftp_download_file",
        None,
        None,
        &format!("{path} → {local_path}"),
    );
    Ok(written)
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
) -> OpsResult<Vec<crate::ssh::RemoteFileEntry>> {
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
        .map_err(|error| OpsError::from_stage("sftp", error))?;
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
) -> OpsResult<()> {
    state
        .ssh
        .sftp_remove(&session_id, &path)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
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
) -> OpsResult<String> {
    let new_path = state
        .ssh
        .sftp_rename(&session_id, &path, &new_name)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
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
) -> OpsResult<String> {
    let new_path = state
        .ssh
        .sftp_copy(&session_id, &path, &new_name)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
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
) -> OpsResult<String> {
    let created = state
        .ssh
        .sftp_mkdir(&session_id, &path)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
    record_audit(&state, "sftp_mkdir", None, None, &created);
    Ok(created)
}

/// Creates an empty remote file (the "新建文件" action).
#[tauri::command]
pub async fn sftp_touch(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> OpsResult<String> {
    let created = state
        .ssh
        .sftp_touch(&session_id, &path)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
    record_audit(&state, "sftp_touch", None, None, &created);
    Ok(created)
}

/// Reads a remote file for the in-app editor (text files only, size-capped).
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> OpsResult<crate::ssh::RemoteFileContent> {
    const MAX_EDIT_SIZE: u64 = 2 * 1024 * 1024;
    let content = state
        .ssh
        .sftp_read_file(&session_id, &path, MAX_EDIT_SIZE)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
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
) -> OpsResult<()> {
    state
        .ssh
        .sftp_write_file(&session_id, &path, &content)
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
    record_audit(&state, "sftp_write_file", None, None, &path);
    Ok(())
}

/// 编辑器保存：带版本冲突检测，并在覆盖前留一份本机历史。
///
/// `expected` 是打开文件时拿到的版本；不一致时**不写**，把当前版本回给前端，
/// 由用户选择重新加载 / 另存 / 明确覆盖。
#[tauri::command]
pub async fn sftp_save_editor_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
    expected: Option<crate::ssh::RemoteFileVersion>,
) -> OpsResult<crate::ssh::SaveFileOutcome> {
    const MAX_EDIT_SIZE: u64 = 2 * 1024 * 1024;
    // 覆盖之前先把**旧内容**存到本机：保存错了还能捞回来。
    // 读不到（二进制 / 没权限）就跳过历史，不能因此阻止保存。
    if let Some(root) = state.db.path().parent() {
        if let Ok(existing) = state
            .ssh
            .sftp_read_file(&session_id, &path, MAX_EDIT_SIZE)
            .await
        {
            if let Some(text) = existing.content {
                let _ = crate::editor_history::record(root, &path, &text);
            }
        }
    }
    let outcome = state
        .ssh
        .save_text_file(&session_id, &path, &content, expected.as_ref())
        .await
        .map_err(|error| OpsError::from_stage("sftp", error))?;
    // 冲突时并没有写入，但审计里记一条"尝试保存"没有意义 —— 只在真正落盘后记录。
    if matches!(outcome, crate::ssh::SaveFileOutcome::Saved { .. }) {
        record_audit(&state, "sftp_write_file", None, None, &path);
    }
    Ok(outcome)
}

/// 列出某个远程文件的本地历史版本（最近的在前）。
#[tauri::command]
pub async fn editor_history_list(
    state: State<'_, AppState>,
    path: String,
) -> OpsResult<Vec<crate::editor_history::EditorHistoryEntry>> {
    let root = state
        .db
        .path()
        .parent()
        .ok_or_else(|| "找不到应用数据目录".to_string())?;
    crate::editor_history::list(root, &path).map_err(|error| OpsError::from_stage("sftp", error))
}

/// 读取一份历史版本的内容（供编辑器预览 / 回填）。
#[tauri::command]
pub async fn editor_history_read(
    state: State<'_, AppState>,
    path: String,
    id: String,
) -> OpsResult<String> {
    let root = state
        .db
        .path()
        .parent()
        .ok_or_else(|| "找不到应用数据目录".to_string())?;
    crate::editor_history::read(root, &path, &id).map_err(|error| OpsError::from_stage("sftp", error))
}
