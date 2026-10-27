//! 文件传输任务中心命令：入队、列表、取消、重试、清理。

use tauri::{AppHandle, State};

use crate::state::AppState;
use crate::transfer::{ConflictPolicy, TransferTask};

/// 上传本地文件 / 目录（目录递归展开为多个任务）。
#[tauri::command]
pub async fn transfer_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    conflict: Option<ConflictPolicy>,
) -> Result<Vec<TransferTask>, String> {
    crate::transfer::enqueue_upload(
        state.inner(),
        &app,
        session_id,
        local_paths,
        remote_dir,
        conflict.unwrap_or(ConflictPolicy::Rename),
    )
    .await
    .map_err(|error| error.to_string())
}

/// 下载远程文件到本地路径。
#[tauri::command]
pub async fn transfer_download(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    local_path: String,
    conflict: Option<ConflictPolicy>,
) -> Result<TransferTask, String> {
    crate::transfer::enqueue_download(
        state.inner(),
        &app,
        session_id,
        path,
        local_path,
        conflict.unwrap_or(ConflictPolicy::Rename),
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn transfer_list(state: State<'_, AppState>) -> Result<Vec<TransferTask>, String> {
    Ok(state.transfers.list())
}

#[tauri::command]
pub async fn transfer_cancel(
    state: State<'_, AppState>,
    id: String,
) -> Result<TransferTask, String> {
    crate::transfer::cancel(state.inner(), &id).map_err(|error| error.to_string())
}

/// 重试一个已结束的任务（沿用原路径与同名策略）。
#[tauri::command]
pub async fn transfer_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<TransferTask, String> {
    crate::transfer::retry(state.inner(), &app, &id).map_err(|error| error.to_string())
}

/// 清掉已结束的任务（排队中 / 运行中的保留）。
#[tauri::command]
pub async fn transfer_clear_finished(state: State<'_, AppState>) -> Result<usize, String> {
    Ok(crate::transfer::clear_finished(state.inner()))
}
