//! 远程回收站命令：删除默认移入回收区，恢复 / 永久删除分开做。

use tauri::{AppHandle, Emitter, State};

use super::record_audit;
use crate::state::AppState;
use crate::trash::TrashEntry;

/// 删除 = 移入回收区（`~/.bls-ops-trash/<时间戳>/`）。
///
/// 回收失败（跨文件系统、无权限）会**如实报错**，不会退化成永久删除。
#[tauri::command]
pub async fn trash_move(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<TrashEntry, String> {
    let entry = state
        .ssh
        .trash_move(&session_id, &path)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "trash_move",
        None,
        None,
        &format!(
            "{{\"session\":\"{session_id}\",\"path\":\"{}\"}}",
            entry.original_path
        ),
    );
    let _ = app.emit(&format!("sftp-changed-{session_id}"), &entry.original_path);
    Ok(entry)
}

#[tauri::command]
pub async fn trash_list(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<TrashEntry>, String> {
    state
        .ssh
        .trash_list(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn trash_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    id: String,
) -> Result<String, String> {
    let restored = state
        .ssh
        .trash_restore(&session_id, &id)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "trash_restore",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\",\"path\":\"{restored}\"}}"),
    );
    let _ = app.emit(&format!("sftp-changed-{session_id}"), &restored);
    Ok(restored)
}

/// 永久删除一条回收站条目（不可撤销，前端必须二次确认）。
#[tauri::command]
pub async fn trash_purge(
    state: State<'_, AppState>,
    session_id: String,
    id: String,
) -> Result<(), String> {
    state
        .ssh
        .trash_purge(&session_id, &id)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "trash_purge",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\",\"id\":\"{id}\"}}"),
    );
    Ok(())
}

/// 清空回收站，返回清理条数。
#[tauri::command]
pub async fn trash_empty(state: State<'_, AppState>, session_id: String) -> Result<usize, String> {
    let removed = state
        .ssh
        .trash_empty(&session_id)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "trash_empty",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\",\"removed\":{removed}}}"),
    );
    Ok(removed)
}
