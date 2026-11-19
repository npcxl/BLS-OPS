//! 极核右栏的内置浏览器。
//!
//! 网页由**独立的子 WebView** 渲染（不是 iframe）：站点兼容性与普通浏览器一致，
//! 也能正常工作在禁止 iframe 的站点上。前端只负责工具栏与占位区域，位置和尺寸
//! 每次布局变化都通过 `extreme_browser_bounds` 同步过来。
//!
//! # 安全边界
//!
//! * 只接受 `http` / `https`，拒绝带账号密码的 URL；
//! * 子 WebView 不写入任何 Tauri command 的 capability，且初始化脚本删掉
//!   `__TAURI_INTERNALS__` / `__TAURI__` —— 外部页面拿不到应用 IPC；
//! * 只允许子 WebView 打开 http(s)，其它协议一律拦下。

use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
};

use crate::ops_error::{OpsError, OpsResult};

/// 固定 label：同一时刻只保留一个浏览器视图，A / B 对话通过地址切换复用。
const LABEL: &str = "extreme-browser";
const NAV_EVENT: &str = "extreme-browser-navigated";

/// 最近一次由主窗口发起导航时的归属（workspaceId + 请求版本）。
/// 页面自己点链接不会改它，所以事件仍归当前对话；切对话时由 open 覆盖。
static SESSION: Mutex<String> = Mutex::new(String::new());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNavigated {
    url: String,
    session: String,
}

fn set_session(session: &str) {
    if let Ok(mut current) = SESSION.lock() {
        *current = session.to_string();
    }
}

fn bad_url(reason: &str) -> OpsError {
    OpsError::from_stage("input", reason.to_string())
}

fn parse_web_url(raw: &str) -> OpsResult<tauri::Url> {
    let url: tauri::Url = raw.trim().parse().map_err(|_| bad_url("不是合法的网址"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(bad_url("只支持 http / https 网址"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad_url("网址里不能带账号密码"));
    }
    Ok(url)
}

fn clamp_size(width: f64, height: f64) -> LogicalSize<f64> {
    LogicalSize::new(width.max(80.0), height.max(80.0))
}

/// 原生子视图必须落在主窗口客户区内：越界/太小一律拒绝，前端保持隐藏。
fn validate_bounds(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    inner: LogicalSize<f64>,
) -> OpsResult<()> {
    if !x.is_finite()
        || !y.is_finite()
        || !width.is_finite()
        || !height.is_finite()
        || width < 80.0
        || height < 80.0
    {
        return Err(bad_url("网页区域太小或坐标无效"));
    }
    if x < -0.5 || y < -0.5 || x + width > inner.width + 1.0 || y + height > inner.height + 1.0 {
        return Err(bad_url("网页区域超出窗口客户区"));
    }
    Ok(())
}

fn window_inner_logical(window: &tauri::Window) -> OpsResult<LogicalSize<f64>> {
    let scale = window
        .scale_factor()
        .map_err(|error| OpsError::from_stage("io", error.to_string()))?;
    let size = window
        .inner_size()
        .map_err(|error| OpsError::from_stage("io", error.to_string()))?;
    Ok(LogicalSize::new(
        size.width as f64 / scale,
        size.height as f64 / scale,
    ))
}

/// 打开（或复用）浏览器子 WebView，并落到指定位置。
#[tauri::command]
pub async fn extreme_browser_open(
    app: AppHandle,
    url: String,
    session: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> OpsResult<()> {
    let parsed = parse_web_url(&url)?;
    let window = app
        .get_window("main")
        .ok_or_else(|| OpsError::from_stage("io", "主窗口不存在"))?;
    validate_bounds(x, y, width, height, window_inner_logical(&window)?)?;
    set_session(&session);

    if let Some(webview) = app.get_webview(LABEL) {
        // 先隐藏再改 bounds / 导航：旧页面不能顺着新布局闪一下。
        let _ = webview.hide();
        let _ = webview.set_position(LogicalPosition::new(x, y));
        let _ = webview.set_size(clamp_size(width, height));
        webview
            .navigate(parsed)
            .map_err(|error| OpsError::from_stage("io", error.to_string()))?;
        return Ok(());
    }

    let emitter = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(parsed))
        // 外部页面不需要、也不应该拿到应用的 IPC。
        .initialization_script("delete window.__TAURI_INTERNALS__; delete window.__TAURI__;")
        .on_navigation(move |url| {
            let allowed = matches!(url.scheme(), "http" | "https") && url.username().is_empty();
            if allowed {
                let session = SESSION
                    .lock()
                    .map(|current| current.clone())
                    .unwrap_or_default();
                let _ = emitter.emit(
                    NAV_EVENT,
                    BrowserNavigated {
                        url: url.as_str().to_string(),
                        session,
                    },
                );
            }
            allowed
        });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            clamp_size(width, height),
        )
        .map_err(|error| OpsError::from_stage("io", error.to_string()))?;
    /*
     * 创建后先隐藏，再把 bounds 落一次；真正 show 由前端在 bounds 成功后调用。
     * 有的平台初始 bounds 晚一帧生效，先显示就会整块铺满窗口。
     */
    let _ = webview.hide();
    let _ = webview.set_position(LogicalPosition::new(x, y));
    let _ = webview.set_size(clamp_size(width, height));
    Ok(())
}

/// 同步子 WebView 的位置与尺寸（拖宽、展开、窗口缩放都走它）。
#[tauri::command]
pub fn extreme_browser_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> OpsResult<()> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    let window = app
        .get_window("main")
        .ok_or_else(|| OpsError::from_stage("io", "主窗口不存在"))?;
    validate_bounds(x, y, width, height, window_inner_logical(&window)?)?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .and_then(|_| webview.set_size(clamp_size(width, height)))
        .map_err(|error| OpsError::from_stage("io", error.to_string()))
}

/// 导航到新地址。
#[tauri::command]
pub fn extreme_browser_navigate(app: AppHandle, url: String, session: String) -> OpsResult<()> {
    let parsed = parse_web_url(&url)?;
    let webview = app
        .get_webview(LABEL)
        .ok_or_else(|| OpsError::from_stage("io", "浏览器还没打开"))?;
    set_session(&session);
    webview
        .navigate(parsed)
        .map_err(|error| OpsError::from_stage("io", error.to_string()))
}

/// 显示 / 隐藏（切标签、开 Modal、切对话都只隐藏，不销毁页面）。
#[tauri::command]
pub fn extreme_browser_show(app: AppHandle, shown: bool) -> OpsResult<()> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    if shown {
        webview
            .show()
            .map_err(|error| OpsError::from_stage("io", error.to_string()))
    } else {
        webview
            .hide()
            .map_err(|error| OpsError::from_stage("io", error.to_string()))
    }
}

/// 后退 / 前进：历史栈交给页面自己维护。
#[tauri::command]
pub fn extreme_browser_history(app: AppHandle, delta: i32) -> OpsResult<()> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    let script = if delta < 0 {
        "window.history.back()"
    } else {
        "window.history.forward()"
    };
    webview
        .eval(script)
        .map_err(|error| OpsError::from_stage("io", error.to_string()))
}

#[tauri::command]
pub fn extreme_browser_reload(app: AppHandle) -> OpsResult<()> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    webview
        .reload()
        .map_err(|error| OpsError::from_stage("io", error.to_string()))
}

/// 关掉子 WebView（退出超能 / 应用关闭时）。
#[tauri::command]
pub fn extreme_browser_close(app: AppHandle) -> OpsResult<()> {
    if let Some(webview) = app.get_webview(LABEL) {
        webview
            .close()
            .map_err(|error| OpsError::from_stage("io", error.to_string()))?;
    }
    set_session("");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_bounds;
    use tauri::LogicalSize;

    /// 输入已是逻辑像素：100% / 125% / 150% 都在调用前除过 scale，
    /// 这里只验证“必须落在客户区内、不能太小”。
    #[test]
    fn bounds_must_fit_inside_the_client_area() {
        let inner = LogicalSize::new(1200.0, 800.0);
        assert!(validate_bounds(0.0, 0.0, 400.0, 600.0, inner).is_ok());
        assert!(validate_bounds(900.0, 100.0, 400.0, 700.0, inner).is_err());
        assert!(validate_bounds(0.0, 0.0, 40.0, 600.0, inner).is_err());
        assert!(validate_bounds(f64::NAN, 0.0, 400.0, 600.0, inner).is_err());
    }
}
