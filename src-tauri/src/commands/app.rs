//! App diagnostics.

use serde::Serialize;
use tauri::State;

use crate::{db, state::AppState};

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub app_name: String,
    pub version: String,
    pub db_path: String,
    pub schema_version: u32,
    pub keepalive_secs: u64,
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> Result<AppInfo, String> {
    Ok(AppInfo {
        app_name: "运维工作台".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        db_path: state.db.path().to_string_lossy().to_string(),
        schema_version: db::SCHEMA_VERSION,
        keepalive_secs: crate::ssh::DEFAULT_KEEPALIVE_SECS,
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}
