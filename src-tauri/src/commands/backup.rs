//! 配置备份 / 预览 / 导入的 Tauri 入口。
//!
//! 这里只做路径校验与状态读取，真正的格式、事务与脱敏都在 `crate::backup`。
//! 文件路径由前端用系统保存/打开对话框选取（用户明确意图），因此接受任意绝对
//! 路径；相对路径一律拒绝 —— 那会让文件落到进程的当前目录，用户找不到。

use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

use crate::ops_error::{OpsError, OpsResult};
use crate::state::AppState;

/// 备份文件读写失败：本机文件问题，用 `io` 阶段（"检查文件是否存在、是否有
/// 读写权限"）。写库失败也归这一层 —— 用户能做的动作是一样的。
fn backup_error(error: impl ToString) -> OpsError {
    OpsError::from_stage("io", error)
}

fn absolute(path: &str) -> OpsResult<PathBuf> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err(OpsError::new("config", "请选择备份文件路径"));
    }
    if !target.is_absolute() {
        return Err(OpsError::new("config", "备份路径必须是绝对路径"));
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
) -> OpsResult<crate::backup::BackupSummary> {
    let target = absolute(&path)?;
    let conn = state.db.open().map_err(backup_error)?;
    let file =
        crate::backup::collect(&conn, env!("CARGO_PKG_VERSION"), settings).map_err(backup_error)?;
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
    let bytes = crate::backup::write_file(&target, &file).map_err(backup_error)?;
    Ok(crate::backup::BackupSummary { bytes, ..summary })
}

/// 预览：读文件并算出新增 / 冲突，**不写库**。
#[tauri::command]
pub async fn backup_preview(
    state: State<'_, AppState>,
    path: String,
) -> OpsResult<crate::backup::BackupPreview> {
    let target = absolute(&path)?;
    let file = crate::backup::read_file(&target).map_err(backup_error)?;
    let conn = state.db.open().map_err(backup_error)?;
    crate::backup::preview(&conn, &file).map_err(backup_error)
}

/// 导入：在**一个事务**里合并；失败整批回滚。
///
/// `overwrite = true` 覆盖同名行，`false` 只导入新增（冲突项原样保留）。
#[tauri::command]
pub async fn backup_import(
    state: State<'_, AppState>,
    path: String,
    overwrite: bool,
) -> OpsResult<crate::backup::BackupImportResult> {
    let target = absolute(&path)?;
    let file = crate::backup::read_file(&target).map_err(backup_error)?;
    let mut conn = state.db.open().map_err(backup_error)?;
    crate::backup::apply(&mut conn, &file, overwrite).map_err(backup_error)
}
