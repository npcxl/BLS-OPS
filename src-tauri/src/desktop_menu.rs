//! 桌面级右键菜单。
//!
//! # 为什么必须有独立窗口
//!
//! 主 WebView 的绘制被裁在自己的原生窗口里：`createPortal` 到 `document.body`
//! 也好、把 z-index 提到天上也好，菜单一旦越过窗口边界就会被 WebView 自身裁掉。
//! 所以菜单内容必须画在**另一个透明 WebView 窗口**里，由这个窗口自己贴到屏幕
//! 坐标上。
//!
//! # 结构
//!
//! - 只有一个菜单窗口（label `context-menu`），首次创建后一直复用；菜单内容
//!   通过事件下发，窗口本身不销毁、不重建。
//! - 窗口是主窗口的 **owned window**：不占任务栏、跟随主窗口最小化、永远不
//!   覆盖无关应用（不是全局置顶）。
//! - 尺寸与位置由 [`plan_layout`] 用**物理像素**算：锚点来自来源窗口客户区
//!   坐标 + `inner_position`，菜单尺寸由菜单窗口用 CSS 测量后上报，再乘目标
//!   显示器的 scale factor。所有边界判断都用显示器 `work_area`（不含任务栏）。
//! - 动作不跨进程序列化函数：来源窗口按 `requestId` 保存回调表，菜单窗口只
//!   回传 `actionId`；[`desktop_menu_select`] 校验该 id 属于当前菜单后才转发。

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// 菜单窗口的 label；主窗口与来源窗口永远不能叫这个名字。
pub const MENU_LABEL: &str = "context-menu";

/// Show/focus may briefly emit Focused(false). Defer and re-check focus instead
/// of dropping this event (dropping the only blur leaves a stuck menu).
const FOCUS_GRACE: Duration = Duration::from_millis(180);

/// 窗口四周留给阴影与描边的逻辑像素；阴影画不出窗口，所以必须留出这一圈。
const WINDOW_PADDING: f64 = 16.0;
/// 子菜单翻到主菜单左侧时保留的一点重叠，看起来仍像挂在父项上。
const SUBMENU_OVERLAP: f64 = 6.0;
/// 一次菜单最多登记多少个动作（防止构造超大 payload）。
const MAX_ACTIONS: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuAnchor {
    pub x: f64,
    pub y: f64,
}

/// 来源窗口 → 菜单窗口的打开请求。`items` 保持为 JSON：菜单项的渲染结构属于
/// 前端，Rust 只负责登记动作 id 与屏幕几何。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuShowPayload {
    pub request_id: String,
    /// "light" | "dark"
    pub theme: String,
    /// 来源窗口客户区内的 CSS 像素坐标（右键点或工具栏按钮位置）。
    pub anchor: MenuAnchor,
    /// 主面板宽度（CSS 像素），定位时用。
    pub width: f64,
    pub items: serde_json::Value,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuPoint {
    pub x: f64,
    pub y: f64,
}

/// 子菜单相对主面板左上角的矩形（CSS 像素）。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmenuRect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuLayout {
    /// 主面板在菜单窗口内的位置（CSS 像素）。
    pub main: MenuPoint,
    pub submenu: Option<MenuPoint>,
    /// 面板可用的最大高度（CSS 像素）；超出时面板内部滚动。
    pub max_height: f64,
    /// "acrylic" | "solid"，菜单窗口据此选择染色层的遮蔽度。
    pub material: String,
}

struct Session {
    request_id: String,
    source: String,
    payload: MenuShowPayload,
    actions: HashSet<String>,
    shown_at: Instant,
    /// 打开时那一次原生材质的结果；layout 不再重复应用（每次重设窗口效果会闪）。
    material: String,
    visible: bool,
    last_geometry: Option<((i32, i32), (u32, u32))>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn normalize_theme(theme: &str) -> String {
    if theme == "dark" {
        "dark".into()
    } else {
        "light".into()
    }
}

fn lock_session() -> Result<std::sync::MutexGuard<'static, Option<Session>>, String> {
    SESSION.lock().map_err(|_| "右键菜单状态已损坏".to_string())
}

fn collect_actions(items: &serde_json::Value, actions: &mut HashSet<String>) -> Result<(), String> {
    fn walk(list: &[serde_json::Value], actions: &mut HashSet<String>) -> Result<(), String> {
        for item in list {
            if let Some(children) = item.get("children").and_then(|value| value.as_array()) {
                walk(children, actions)?;
            }
            if let Some(id) = item.get("actionId").and_then(|value| value.as_str()) {
                if !actions.insert(id.to_string()) {
                    return Err("菜单动作 id 重复".into());
                }
                if actions.len() > MAX_ACTIONS {
                    return Err("菜单动作过多".into());
                }
            }
        }
        Ok(())
    }
    let list = items.as_array().ok_or("菜单项必须是数组")?;
    if list.is_empty() {
        return Err("菜单没有可执行项".into());
    }
    walk(list, actions)
}

fn ensure_window(app: &tauri::AppHandle, theme: &str) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(MENU_LABEL) {
        return Ok(window);
    }
    let main = app.get_webview_window("main").ok_or("主窗口不存在")?;
    // `async` 命令 + 隐藏构建：创建 WebView 必须回到事件循环，同步命令会和它
    // 抢主线程（表现为整应用卡住）。
    let window =
        WebviewWindowBuilder::new(app, MENU_LABEL, WebviewUrl::App("desktop-menu.html".into()))
            .title("")
            .initialization_script("window.__BLS_VIEW__='context-menu';")
            .inner_size(260.0, 120.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .parent(&main)
            .map_err(|error| format!("无法把菜单窗口挂到主窗口：{error}"))?
            .build()
            .map_err(|error| format!("无法创建菜单窗口：{error}"))?;

    // Acrylic affects the entire bounding rectangle, including transparent
    // gutters between submenus. Keep this window transparent; panels own tint.
    let _ = crate::window_material::apply(&window, theme, false);

    let handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(false) => dismiss_on_blur(&handle),
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            dismiss(&handle, "close");
        }
        _ => {}
    });
    eprintln!("[desktop-menu] menu window created");
    Ok(window)
}

fn dismiss_on_blur(app: &tauri::AppHandle) {
    let check = lock_session().ok().and_then(|guard| {
        guard.as_ref().and_then(|session| {
            session.visible.then(|| {
                (
                    session.request_id.clone(),
                    FOCUS_GRACE.saturating_sub(session.shown_at.elapsed()),
                )
            })
        })
    });
    let Some((request_id, wait)) = check else {
        return;
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Do not discard an early blur: re-check after the normal focus handoff.
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        let current = lock_session()
            .ok()
            .map(|guard| {
                guard
                    .as_ref()
                    .is_some_and(|session| session.request_id == request_id && session.visible)
            })
            .unwrap_or(false);
        if !current {
            return;
        }
        if let Some(menu) = handle.get_webview_window(MENU_LABEL) {
            if !menu.is_focused().unwrap_or(false) {
                dismiss(&handle, "blur");
            }
        }
    });
}

/// 关闭菜单并清掉会话。`blur` 意味着用户已经点到别处，此时不能抢焦点。
pub fn dismiss(app: &tauri::AppHandle, reason: &str) {
    let session = lock_session().ok().and_then(|mut guard| guard.take());
    let Some(session) = session else {
        return;
    };
    let restore_focus = reason == "escape"
        && app
            .get_webview_window(MENU_LABEL)
            .is_some_and(|window| window.is_focused().unwrap_or(false));
    if let Some(window) = app.get_webview_window(MENU_LABEL) {
        let _ = window.hide();
    }
    let _ = app.emit_to(
        MENU_LABEL,
        "desktop-menu:reset",
        serde_json::json!({"requestId": session.request_id}),
    );
    let _ = app.emit_to(
        session.source.as_str(),
        "desktop-menu:closed",
        serde_json::json!({ "requestId": session.request_id, "reason": reason }),
    );
    if restore_focus {
        if let Some(source) = app.get_webview_window(&session.source) {
            let _ = source.set_focus();
        }
    }
}

/// 来源窗口关闭 / 销毁时收起菜单，避免留下一个没有主人的浮窗。
pub fn on_source_event(app: &tauri::AppHandle, label: &str, event: &tauri::WindowEvent) {
    let owns_menu = lock_session()
        .ok()
        .and_then(|guard| guard.as_ref().map(|session| session.source == label))
        .unwrap_or(false);
    if !owns_menu {
        return;
    }
    if matches!(
        event,
        tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Focused(true)
    ) {
        dismiss_on_blur(app);
    }
    if matches!(event, tauri::WindowEvent::Resized(_)) {
        if app
            .get_webview_window(label)
            .is_some_and(|window| window.is_minimized().unwrap_or(false))
        {
            dismiss(app, "source");
        }
    }
    if matches!(
        event,
        tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
    ) {
        dismiss(app, "source");
    }
}

struct Plan {
    window_pos: (i32, i32),
    window_size: (u32, u32),
    main: MenuPoint,
    submenu: Option<MenuPoint>,
    max_height: f64,
}

/// 纯几何：锚点 + 工作区 + 缩放 + 面板尺寸 → 窗口矩形与面板在窗口内的位置。
///
/// 全部使用物理像素计算；返回值里的面板坐标再除以 `scale` 变回 CSS 像素。
/// 抽成纯函数是为了能在没有窗口的测试里覆盖翻转与 clamp。
fn plan_layout(
    anchor_x: f64,
    anchor_y: f64,
    work: (f64, f64, f64, f64),
    scale: f64,
    main_size: (f64, f64),
    submenu: Option<(f64, f64, f64, f64)>,
) -> Plan {
    let (work_x, work_y, work_w, work_h) = work;
    let pad = WINDOW_PADDING * scale;
    let work_right = work_x + work_w;
    let work_bottom = work_y + work_h;

    let main_w = (main_size.0 * scale).max(1.0);
    let usable_h = (work_h - pad * 2.0).max(1.0);
    let main_h = (main_size.1 * scale).min(usable_h).max(1.0);
    let max_height = usable_h / scale;

    // 默认在锚点右下；右侧/下方放不下就翻到左侧/上方。
    let mut main_x = anchor_x;
    let mut main_y = anchor_y;
    if main_x + main_w + pad > work_right {
        main_x = anchor_x - main_w;
    }
    if main_y + main_h + pad > work_bottom {
        main_y = anchor_y - main_h;
    }
    main_x = main_x
        .max(work_x + pad)
        .min((work_right - main_w - pad).max(work_x + pad));
    main_y = main_y
        .max(work_y + pad)
        .min((work_bottom - main_h - pad).max(work_y + pad));

    let mut min_x = main_x;
    let mut min_y = main_y;
    let mut max_x = main_x + main_w;
    let mut max_y = main_y + main_h;

    let submenu_point = submenu.map(|(left, top, width, height)| {
        let sub_w = (width * scale).max(1.0);
        let sub_h = (height * scale).max(1.0);
        let mut sub_x = main_x + left * scale;
        if sub_x + sub_w + pad > work_right {
            sub_x = main_x - sub_w + SUBMENU_OVERLAP * scale;
        }
        let mut sub_y = main_y + top * scale;
        if sub_y + sub_h + pad > work_bottom {
            sub_y = main_y + main_h - sub_h;
        }
        sub_x = sub_x
            .max(work_x + pad)
            .min((work_right - sub_w - pad).max(work_x + pad));
        sub_y = sub_y
            .max(work_y + pad)
            .min((work_bottom - sub_h - pad).max(work_y + pad));
        min_x = min_x.min(sub_x);
        min_y = min_y.min(sub_y);
        max_x = max_x.max(sub_x + sub_w);
        max_y = max_y.max(sub_y + sub_h);
        (sub_x, sub_y)
    });

    let win_x = (min_x - pad).floor() as i32;
    let win_y = (min_y - pad).floor() as i32;
    let win_w = ((max_x + pad) - (min_x - pad)).ceil().max(1.0) as u32;
    let win_h = ((max_y + pad) - (min_y - pad)).ceil().max(1.0) as u32;

    Plan {
        window_pos: (win_x, win_y),
        window_size: (win_w, win_h),
        main: MenuPoint {
            x: (main_x - win_x as f64) / scale,
            y: (main_y - win_y as f64) / scale,
        },
        submenu: submenu_point.map(|(x, y)| MenuPoint {
            x: (x - win_x as f64) / scale,
            y: (y - win_y as f64) / scale,
        }),
        max_height,
    }
}

/// 预创建菜单窗口（隐藏）。应用启动后调一次，第一次右键就不用等 WebView 初始化。
#[tauri::command]
pub async fn desktop_menu_prepare(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    ensure_window(&app, &normalize_theme(&theme))
        .map(|_| ())
        .map_err(|error| {
            eprintln!("[desktop-menu] prepare failed: {error}");
            error
        })
}

/// 打开（或就地替换）菜单。
#[tauri::command]
pub async fn desktop_menu_show(
    app: tauri::AppHandle,
    window: WebviewWindow,
    payload: MenuShowPayload,
) -> Result<(), String> {
    // 菜单窗口自己不能当来源：否则菜单里再右键会递归。
    if window.label() == MENU_LABEL {
        return Err("菜单窗口不能打开菜单".into());
    }
    let mut actions = HashSet::new();
    collect_actions(&payload.items, &mut actions)?;

    let theme = normalize_theme(&payload.theme);
    let menu = ensure_window(&app, &theme)?;
    let previous = {
        let mut guard = lock_session()?;
        guard.replace(Session {
            request_id: payload.request_id.clone(),
            source: window.label().to_string(),
            payload: payload.clone(),
            actions,
            shown_at: Instant::now(),
            material: "solid".into(),
            visible: false,
            last_geometry: None,
        })
    };
    if let Some(previous) = previous {
        let _ = app.emit_to(
            previous.source.as_str(),
            "desktop-menu:closed",
            serde_json::json!({"requestId": previous.request_id, "reason": "replace"}),
        );
    }
    // 先把窗口挪到锚点附近：上一次的旧位置在事件到达前会露一帧。
    // 窗口已经可见时（换一处右键）不预移动，交给 layout 一次性完成位移。
    if !menu.is_visible().unwrap_or(false) {
        if let (Ok(scale), Ok(inner)) = (window.scale_factor(), window.inner_position()) {
            let x = inner.x + (payload.anchor.x * scale).round() as i32;
            let y = inner.y + (payload.anchor.y * scale).round() as i32;
            let _ = menu.set_position(PhysicalPosition::new(x, y));
        }
    }

    app.emit_to(MENU_LABEL, "desktop-menu:show", &payload)
        .map_err(|error| format!("无法通知菜单窗口：{error}"))?;
    eprintln!(
        "[desktop-menu] show {} from {}",
        payload.request_id,
        window.label()
    );
    Ok(())
}

/// 菜单窗口加载完成后拉取当前请求（事件可能早于页面就绪）。
#[tauri::command]
pub fn desktop_menu_pending(window: WebviewWindow) -> Option<MenuShowPayload> {
    require_menu_window(&window).ok()?;
    lock_session()
        .ok()
        .and_then(|guard| guard.as_ref().map(|session| session.payload.clone()))
}

/// 这几个命令只给菜单窗口用：主窗口没有理由读取或改写菜单窗口的会话。
fn require_menu_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == MENU_LABEL {
        Ok(())
    } else {
        Err("该命令只对菜单窗口开放".into())
    }
}

/// 菜单内容测量完成后定位窗口，并回报面板在窗口内的位置。
#[tauri::command]
pub async fn desktop_menu_layout(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    width: f64,
    height: f64,
    submenu: Option<SubmenuRect>,
) -> Result<MenuLayout, String> {
    require_menu_window(&window)?;
    let (source_label, material, anchor) = {
        let guard = lock_session()?;
        let session = guard.as_ref().ok_or("没有打开的菜单")?;
        if session.request_id != request_id {
            return Err("菜单已过期".into());
        }
        (
            session.source.clone(),
            session.material.clone(),
            session.payload.anchor.clone(),
        )
    };

    let menu = app.get_webview_window(MENU_LABEL).ok_or("菜单窗口不存在")?;
    let source = app
        .get_webview_window(&source_label)
        .ok_or("来源窗口已关闭")?;

    let source_scale = source.scale_factor().unwrap_or(1.0);
    let inner = source
        .inner_position()
        .map_err(|error| format!("无法读取来源窗口位置：{error}"))?;
    let anchor_x = inner.x as f64 + anchor.x * source_scale;
    let anchor_y = inner.y as f64 + anchor.y * source_scale;

    let monitor = source
        .monitor_from_point(anchor_x, anchor_y)
        .ok()
        .flatten()
        .or_else(|| source.current_monitor().ok().flatten())
        .ok_or("无法确定菜单所在的显示器")?;
    let work = monitor.work_area();
    let work_rect = (
        work.position.x as f64,
        work.position.y as f64,
        work.size.width as f64,
        work.size.height as f64,
    );

    // 用**锚点所在显示器**的缩放：菜单窗口接着会被移到那里。用窗口当前的
    // scale 会拿到上一次所在屏幕的 DPI，多显示器不同缩放时尺寸就不对了。
    let scale = monitor.scale_factor();
    let plan = plan_layout(
        anchor_x,
        anchor_y,
        work_rect,
        scale,
        (width, height),
        submenu.map(|rect| (rect.left, rect.top, rect.width, rect.height)),
    );

    let (first_show, geometry_changed) = {
        let mut guard = lock_session()?;
        let session = guard.as_mut().ok_or("没有打开的菜单")?;
        if session.request_id != request_id {
            return Err("菜单已过期".into());
        }
        let first = !session.visible;
        let geometry = (plan.window_pos, plan.window_size);
        let changed = session.last_geometry != Some(geometry);
        session.last_geometry = Some(geometry);
        (first, changed)
    };
    if first_show && !source.is_focused().unwrap_or(false) && !menu.is_focused().unwrap_or(false) {
        dismiss(&app, "blur");
        return Err("来源窗口已失焦".into());
    }
    if geometry_changed {
        menu.set_size(PhysicalSize::new(plan.window_size.0, plan.window_size.1))
            .map_err(|error| format!("无法调整菜单窗口大小：{error}"))?;
        menu.set_position(PhysicalPosition::new(plan.window_pos.0, plan.window_pos.1))
            .map_err(|error| format!("无法移动菜单窗口：{error}"))?;
    }

    Ok(MenuLayout {
        main: plan.main,
        submenu: plan.submenu,
        max_height: plan.max_height,
        material,
    })
}

/// The renderer calls this after the measured content has been committed.
#[tauri::command]
pub fn desktop_menu_present(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    require_menu_window(&window)?;
    let source_label = {
        let guard = lock_session()?;
        let session = guard.as_ref().ok_or("没有打开的菜单")?;
        if session.request_id != request_id {
            return Err("菜单已过期".into());
        }
        if session.visible {
            return Ok(());
        }
        session.source.clone()
    };
    let source = app
        .get_webview_window(&source_label)
        .ok_or("来源窗口已关闭")?;
    if !source.is_focused().unwrap_or(false) && !window.is_focused().unwrap_or(false) {
        dismiss(&app, "blur");
        return Err("来源窗口已失焦".into());
    }
    {
        let mut guard = lock_session()?;
        let session = guard.as_mut().ok_or("没有打开的菜单")?;
        if session.request_id != request_id {
            return Err("菜单已过期".into());
        }
        session.visible = true;
        session.shown_at = Instant::now();
    }
    if let Err(error) = window.show().and_then(|_| window.set_focus()) {
        dismiss(&app, "layout-error");
        return Err(error.to_string());
    }
    Ok(())
}

/// 菜单窗口回传被选中的动作。只认当前 `requestId` 下登记过的 `actionId`。
#[tauri::command]
pub fn desktop_menu_select(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    action_id: String,
) -> Result<(), String> {
    require_menu_window(&window)?;
    let mut guard = lock_session()?;
    let session = guard.as_ref().ok_or("没有打开的菜单")?;
    if session.request_id != request_id {
        // 旧菜单的迟到事件：既不执行、也不影响新菜单的会话。
        return Err("菜单已过期".into());
    }
    if !session.actions.contains(&action_id) {
        return Err("未登记的动作".into());
    }
    let session = guard.take().ok_or("没有打开的菜单")?;
    drop(guard);

    let _ = app.emit_to(
        MENU_LABEL,
        "desktop-menu:reset",
        serde_json::json!({"requestId": session.request_id}),
    );
    let _ = app.emit_to(
        session.source.as_str(),
        "desktop-menu:select",
        serde_json::json!({ "requestId": session.request_id, "actionId": action_id }),
    );
    if let Some(window) = app.get_webview_window(MENU_LABEL) {
        let _ = window.hide();
    }
    if let Some(source) = app.get_webview_window(&session.source) {
        let _ = source.set_focus();
    }
    let _ = app.emit_to(
        session.source.as_str(),
        "desktop-menu:closed",
        serde_json::json!({ "requestId": session.request_id, "reason": "select" }),
    );
    Ok(())
}

/// Esc / 点击窗口内的透明区域时由菜单窗口调用。
#[tauri::command]
pub fn desktop_menu_close(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    reason: String,
) -> Result<(), String> {
    require_menu_window(&window)?;
    if !lock_session()?
        .as_ref()
        .is_some_and(|session| session.request_id == request_id)
    {
        return Ok(());
    }
    dismiss(&app, &reason);
    Ok(())
}

#[tauri::command]
pub fn desktop_menu_cancel(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    if lock_session()?
        .as_ref()
        .is_some_and(|session| session.source == window.label() && session.request_id == request_id)
    {
        dismiss(&app, "outside");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::plan_layout;

    const WORK: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1040.0);

    #[test]
    fn menu_opens_at_anchor_when_it_fits() {
        let plan = plan_layout(100.0, 100.0, WORK, 1.0, (220.0, 180.0), None);
        assert_eq!(plan.main.x, 16.0);
        assert_eq!(plan.main.y, 16.0);
        assert_eq!(plan.window_size, (252, 212));
    }

    #[test]
    fn menu_flips_left_and_up_near_bottom_right() {
        let plan = plan_layout(1910.0, 1030.0, WORK, 1.0, (220.0, 180.0), None);
        assert_eq!(plan.main.x, 16.0);
        assert_eq!(plan.main.y, 16.0);
        assert_eq!(plan.window_size, (252, 212));
    }

    #[test]
    fn submenu_beyond_right_edge_flips_left_of_main() {
        let plan = plan_layout(
            1500.0,
            100.0,
            WORK,
            1.0,
            (220.0, 200.0),
            Some((214.0, 0.0, 200.0, 160.0)),
        );
        // 主菜单在 x=1500，子菜单翻到主菜单左侧并整体进入工作区。
        assert!(plan.submenu.unwrap().x < plan.main.x);
        assert_eq!(plan.window_pos, (1290, 84));
        assert_eq!(plan.window_size, (446, 232));
    }

    #[test]
    fn tall_menu_is_clamped_and_reports_scrollable_height() {
        let plan = plan_layout(20.0, 20.0, WORK, 1.0, (220.0, 4000.0), None);
        assert_eq!(plan.window_size, (252, 1040));
        assert!((plan.max_height - 1008.0).abs() < 0.001);
    }

    #[test]
    fn negative_monitor_origin_is_respected() {
        let work = (-1920.0, -200.0, 1920.0, 1040.0);
        let plan = plan_layout(-100.0, -50.0, work, 1.0, (220.0, 180.0), None);
        assert_eq!(plan.window_pos, (-336, -66));
        assert_eq!(plan.main.x, 16.0);
        assert_eq!(plan.main.y, 16.0);
    }

    #[test]
    fn hidpi_scales_panel_and_window() {
        let plan = plan_layout(100.0, 100.0, WORK, 1.5, (220.0, 180.0), None);
        assert_eq!(plan.window_size, (378, 318));
        assert_eq!(plan.main.x, 16.0);
        assert_eq!(plan.main.y, 16.0);
    }
}
