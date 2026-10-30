//! App diagnostics + tray menu labels.

use serde::Serialize;
use tauri::State;

use crate::ops_error::{OpsError, OpsResult};
use crate::{db, state::AppState};

/// 应用级操作（开窗、托盘文案）失败都在本机：阶段 `local`。
fn local_error(error: impl ToString) -> OpsError {
    OpsError::from_stage("local", error)
}

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
pub async fn app_info(state: State<'_, AppState>) -> OpsResult<AppInfo> {
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

/// 独立窗口的视图标识怎么传给前端。
///
/// **不用 URL 查询参数**：`WebviewUrl::App("index.html?view=…")` 在部分平台上会被
/// 当成路径的一部分处理，前端读不到 `view`，窗口就渲染出一个空壳（白屏）。
/// 初始化脚本在页面脚本之前执行，变量一定存在。
const VIEW_SCRIPT_PREFIX: &str = "window.__BLS_VIEW__=";

fn view_script(view: &str) -> String {
    format!("{VIEW_SCRIPT_PREFIX}'{view}';")
}

/// 开（或聚焦）一个独立窗口。
///
/// 命令是 `async` 的：同步命令会在主线程上执行，而创建 WebView 窗口本身要把
/// 任务派回事件循环 —— 两者撞在一起会卡死（表现为"新窗口白屏 + 整个应用无响应"）。
async fn open_view_window(
    app: tauri::AppHandle,
    label: &'static str,
    view: &'static str,
    title: &'static str,
    size: (f64, f64),
    min_size: (f64, f64),
) -> OpsResult<()> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(min_size.0, min_size.1)
        .initialization_script(&view_script(view))
        .build()
        .map(|_| ())
        .map_err(|error| OpsError::new("local", format!("无法打开窗口：{error}")))
}

/// 在独立窗口里打开快捷键一览（对照操作时不用来回切设置）。
#[tauri::command]
pub async fn open_shortcuts_window(app: tauri::AppHandle) -> OpsResult<()> {
    open_view_window(
        app,
        "shortcuts",
        "shortcuts",
        "Keyboard shortcuts",
        (640.0, 620.0),
        (460.0, 360.0),
    )
    .await
}

/// 托盘菜单文案随前端语言（i18n 只在前端做，见 `crate::tray`）。
/// 纯展示文本，无安全面；托盘未创建时静默成功。
#[tauri::command]
pub fn tray_set_labels(app: tauri::AppHandle, show: String, quit: String) -> OpsResult<()> {
    crate::tray::set_labels(&app, &show, &quit).map_err(local_error)
}
