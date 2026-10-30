//! 文件传输任务中心命令：入队、列表、取消、重试、清理。

use tauri::{AppHandle, State};

use crate::ops_error::{OpsError, OpsResult};
use crate::state::AppState;
use crate::transfer::{ConflictPolicy, TransferTask};

/// 传输失败按 `sftp` 阶段展示（同一套"路径 / 权限 / 磁盘"恢复建议）。
fn transfer_error(error: impl ToString) -> OpsError {
    OpsError::from_stage("sftp", error)
}

/// 上传本地文件 / 目录（目录递归展开为多个任务）。
#[tauri::command]
pub async fn transfer_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    conflict: Option<ConflictPolicy>,
) -> OpsResult<Vec<TransferTask>> {
    crate::transfer::enqueue_upload(
        state.inner(),
        &app,
        session_id,
        local_paths,
        remote_dir,
        conflict.unwrap_or(ConflictPolicy::Rename),
    )
    .await
    .map_err(transfer_error)
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
) -> OpsResult<TransferTask> {
    crate::transfer::enqueue_download(
        state.inner(),
        &app,
        session_id,
        path,
        local_path,
        conflict.unwrap_or(ConflictPolicy::Rename),
    )
    .await
    .map_err(transfer_error)
}

#[tauri::command]
pub async fn transfer_list(state: State<'_, AppState>) -> OpsResult<Vec<TransferTask>> {
    Ok(state.transfers.list())
}

#[tauri::command]
pub async fn transfer_cancel(
    state: State<'_, AppState>,
    id: String,
) -> OpsResult<TransferTask> {
    crate::transfer::cancel(state.inner(), &id).map_err(transfer_error)
}

/// 重试一个已结束的任务（沿用原路径与同名策略）。
#[tauri::command]
pub async fn transfer_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> OpsResult<TransferTask> {
    crate::transfer::retry(state.inner(), &app, &id).map_err(transfer_error)
}

/// 清掉已结束的任务（排队中 / 运行中的保留）。
#[tauri::command]
pub async fn transfer_clear_finished(state: State<'_, AppState>) -> OpsResult<usize> {
    Ok(crate::transfer::clear_finished(state.inner()))
}
