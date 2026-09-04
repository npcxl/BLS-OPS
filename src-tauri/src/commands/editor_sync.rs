//! 本地编辑器同步命令：探测编辑器、打开/列出/关闭同步会话。
//!
//! 前端只传结构化标识（session_id、远程路径、editor_id）——路径只进 SFTP
//! 通道，绝不拼 shell 命令，与 `sftp.rs` 同一安全定位。

use tauri::{AppHandle, Emitter, State};

use super::record_audit;
use crate::editor_sync::{
    close_sync_session, find_editor, list_editors, open_sync_session, EditorSyncEventPayload,
    SyncSessionInfo, EDITOR_SYNC_EVENT,
};
use crate::state::AppState;

/// 探测本机可用的编辑器（VS Code / Cursor / Windsurf / Trae / CodeBuddy）。
/// 未安装的返回 `available: false`，前端不展示。
#[tauri::command]
pub async fn editor_list_available() -> Vec<crate::editor_sync::EditorInfo> {
    // 探测是纯文件存在性检查（微秒级），直接同步算完。
    list_editors()
}

/// 打开同步会话：下载远程文件/目录到本地工作区并用指定编辑器打开。
/// 之后编辑器每次保存都会自动回传服务器。
#[tauri::command]
pub async fn editor_sync_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    editor_id: String,
) -> Result<SyncSessionInfo, String> {
    // 网络 I/O 之前完成所有校验。
    crate::editor_sync::validate_remote_path(&remote_path).map_err(|error| error.to_string())?;
    let editor = find_editor(&editor_id)
        .map(|(name, path)| (editor_id.clone(), name, path))
        .ok_or_else(|| format!("未检测到编辑器 {editor_id}，无法打开"))?;

    let info = open_sync_session(&app, &state.editor_syncs, &state.ssh, &session_id, &remote_path, editor)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "editor_sync_open", None, None, &format!("{} → {}", info.remote_path, info.editor_name));
    Ok(info)
}

/// 关闭同步会话：停止监听与上传、清理本地临时工作区。
#[tauri::command]
pub async fn editor_sync_close(
    app: AppHandle,
    state: State<'_, AppState>,
    sync_id: String,
) -> Result<SyncSessionInfo, String> {
    let closed = close_sync_session(&state.editor_syncs, &sync_id)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "editor_sync_close", None, None, &closed.remote_path);
    let _ = app.emit(EDITOR_SYNC_EVENT, EditorSyncEventPayload::upsert(closed.clone()));
    Ok(closed)
}

/// 列出同步会话（`session_id` 提供时只返回该 SSH 会话的）。
/// 面板打开/重挂载时调用，恢复状态条的显示。
#[tauri::command]
pub async fn editor_sync_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<SyncSessionInfo>, String> {
    Ok(match session_id {
        Some(id) if !id.is_empty() => state.editor_syncs.snapshot_for_session(&id).await,
        _ => state.editor_syncs.snapshot().await,
    })
}
