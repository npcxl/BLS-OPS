//! App diagnostics + tray menu labels.

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
        app_name: "Ops Workbench".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        db_path: state.db.path().to_string_lossy().to_string(),
        schema_version: db::SCHEMA_VERSION,
        keepalive_secs: crate::ssh::DEFAULT_KEEPALIVE_SECS,
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

/// 在独立窗口里打开设置。
///
/// 对照着主界面调设置时，来回切标签会丢掉上下文；独立窗口更顺手。
/// 已存在就聚焦，不重复开第二个 —— 多开只会让"改的是哪份设置"变得含糊。
#[tauri::command]
pub fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App("index.html?view=settings".into()),
    )
    .title("Settings")
    .inner_size(720.0, 700.0)
    .min_inner_size(560.0, 480.0)
    .build()
    .map(|_| ())
    .map_err(|error| format!("无法打开设置窗口：{error}"))
}

/// 在独立窗口里打开快捷键一览（对照操作时不用来回切设置）。
#[tauri::command]
pub fn open_shortcuts_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if let Some(window) = app.get_webview_window("shortcuts") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        "shortcuts",
        WebviewUrl::App("index.html?view=shortcuts".into()),
    )
    .title("Keyboard shortcuts")
    .inner_size(640.0, 560.0)
    .min_inner_size(460.0, 360.0)
    .build()
    .map(|_| ())
    .map_err(|error| format!("无法打开快捷键窗口：{error}"))
}

/// 托盘菜单文案随前端语言（i18n 只在前端做，见 `crate::tray`）。
/// 纯展示文本，无安全面；托盘未创建时静默成功。
#[tauri::command]
pub fn tray_set_labels(app: tauri::AppHandle, show: String, quit: String) -> Result<(), String> {
    crate::tray::set_labels(&app, &show, &quit).map_err(|e| e.to_string())
}
