//! 配置备份 / 预览 / 导入的 Tauri 入口。
//!
//! 这里只做路径校验与状态读取，真正的格式、事务与脱敏都在 `crate::backup`。
//! 文件路径由前端用系统保存/打开对话框选取（用户明确意图），因此接受任意绝对
//! 路径；相对路径一律拒绝 —— 那会让文件落到进程的当前目录，用户找不到。

use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

use crate::state::AppState;

fn absolute(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("请选择备份文件路径".to_string());
    }
    if !target.is_absolute() {
        return Err("备份路径必须是绝对路径".to_string());
    }
    Ok(target)
}

/// 导出：服务器 / 分组 / 凭据元数据 / 指纹 / 项目 / 设置。
///
/// `settings` 是前端从 localStorage 收集的偏好，原样写进 JSON。
#[tauri::command]
pub async fn backup_export(
    state: State<'_, AppState>,
    path: String,
    settings: Option<Value>,
) -> Result<crate::backup::BackupSummary, String> {
    let target = absolute(&path)?;
    let conn = state.db.open().map_err(|error| error.to_string())?;
    let file = crate::backup::collect(&conn, env!("CARGO_PKG_VERSION"), settings)
        .map_err(|error| error.to_string())?;
    let summary = crate::backup::BackupSummary {
        path: target.to_string_lossy().to_string(),
        bytes: 0,
        exported_at: file.exported_at,
        servers: file.servers.len(),
        groups: file.groups.len(),
        credentials: file.credentials.len(),
        known_hosts: file.known_hosts.len(),
        projects: file.projects.len(),
        settings_included: file.settings.is_some(),
    };
    let bytes = crate::backup::write_file(&target, &file).map_err(|error| error.to_string())?;
    Ok(crate::backup::BackupSummary { bytes, ..summary })
}

/// 预览：读文件并算出新增 / 冲突，**不写库**。
#[tauri::command]
pub async fn backup_preview(
    state: State<'_, AppState>,
    path: String,
) -> Result<crate::backup::BackupPreview, String> {
    let target = absolute(&path)?;
    let file = crate::backup::read_file(&target).map_err(|error| error.to_string())?;
    let conn = state.db.open().map_err(|error| error.to_string())?;
    crate::backup::preview(&conn, &file).map_err(|error| error.to_string())
}

/// 导入：在**一个事务**里合并；失败整批回滚。
///
/// `overwrite = true` 覆盖同名行，`false` 只导入新增（冲突项原样保留）。
#[tauri::command]
pub async fn backup_import(
    state: State<'_, AppState>,
    path: String,
    overwrite: bool,
) -> Result<crate::backup::BackupImportResult, String> {
    let target = absolute(&path)?;
    let file = crate::backup::read_file(&target).map_err(|error| error.to_string())?;
    let mut conn = state.db.open().map_err(|error| error.to_string())?;
    crate::backup::apply(&mut conn, &file, overwrite).map_err(|error| error.to_string())
}
