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

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 菜单窗口的 label；主窗口与来源窗口永远不能叫这个名字。
pub const MENU_LABEL: &str = "context-menu";

/// 来源窗口"还能用"的判定：可见且未最小化。
///
/// **不能用 `is_focused()`**：WebView2 把键盘焦点放在自己的子窗口里，含 WebView
/// 的顶层窗口从被激活那一瞬起就会收到 WM_KILLFOCUS，tao 的 `is_focused()`
/// （`is_active && is_focused`）因此几乎恒为 false。拿它做门禁会把每一次右键都
/// 判成"来源窗口已失焦"，菜单一次也不会显示 —— 表现为整个应用的右键全部失效。
fn source_usable(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false)
}

/// 窗口四周留给阴影与描边的逻辑像素；阴影画不出窗口，所以必须留出这一圈。
const WINDOW_PADDING: f64 = 16.0;
/// 子菜单翻到主菜单左侧时保留的一点重叠，看起来仍像挂在父项上。
const SUBMENU_OVERLAP: f64 = 6.0;
/// 一次菜单最多登记多少个动作（防止构造超大 payload）。
const MAX_ACTIONS: usize = 512;
/// `desktop_menu_show` 等页面开始测量的上限（毫秒）。超过就判定页面没响应。
const PAGE_RESPONSE_TIMEOUT: u64 = 400;

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

/// 一次菜单请求的生命周期。
///
/// * `Staged`：请求已接收、内容正在菜单窗口里staging（测量/迭代布局），窗口
///   还没显示。此时任何 layout 都不允许动原生窗口。
/// * `Visible`：几何与内容都已定稿并一次性提交，窗口已经显示。
///
/// 连续右键走的是"同一次请求表里的替换"：新请求把会话整体换掉并直接进入
/// `Staged`，旧菜单继续画在屏幕上，直到新内容量好尺寸，才用一次几何更新
/// 换掉它 —— 中途不隐藏窗口，所以看不到闪烁。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Staged,
    Visible,
}

/// 页面测出来的内容尺寸（CSS 像素）。`layout` 写入，`present` 复用。
#[derive(Debug, Clone, Copy)]
struct Measure {
    width: f64,
    height: f64,
    submenu: Option<SubmenuRect>,
}

struct Session {
    request_id: String,
    /// 最后一次被接受的布局 revision。迟到/乱序的 layout 用它挡掉。
    revision: u64,
    /// 最后一次被接受的测量结果；没量过就不允许显示。
    measure: Option<Measure>,
    source: String,
    payload: MenuShowPayload,
    actions: HashSet<String>,
    /// 打开时那一次原生材质的结果；layout 不再重复应用（每次重设窗口效果会闪）。
    material: String,
    phase: Phase,
    last_geometry: Option<((i32, i32), (u32, u32))>,
}

impl Session {
    /// 接受一个布局 revision。**必须严格递增**：同一个 requestId 下并发的
    /// 两次测量（例如子菜单收起又展开）返回顺序不可控，只校验 requestId
    /// 会让早发出的那次把窗口挪回旧位置。
    fn accept_revision(&mut self, revision: u64) -> bool {
        if revision <= self.revision {
            return false;
        }
        self.revision = revision;
        true
    }

    /// 提交（present）用的版本校验：允许与最后一次 layout 同版本（定稿就是
    /// 那次测量的结果），但不允许倒退 —— 迟到的旧 present 不能把新菜单挪回去。
    fn accept_present_revision(&mut self, revision: u64) -> bool {
        if revision < self.revision {
            return false;
        }
        self.revision = revision;
        true
    }
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// 用户点中的动作，等来源窗口来取。
///
/// 为什么要有这个"信箱"：`desktop-menu:select` 事件只要丢一次，菜单点了就
/// 没反应（菜单窗口已经把窗口藏了，用户只会看到"闪一下"）。事件照发，但
/// 动作同时放进这里，来源窗口在菜单打开期间轮询取走 —— 送达不再依赖事件。
#[derive(Debug, Clone)]
struct Selection {
    request_id: String,
    action_id: String,
}

static SELECTION: Mutex<Option<Selection>> = Mutex::new(None);

/// 临时调试日志：写 %TEMP%\desktop-menu-trace.log，便于在无人值守时定位链路。
fn trace(message: impl AsRef<str>) {
    use std::io::Write;
    let path = std::env::temp_dir().join("desktop-menu-trace.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{}", message.as_ref());
    }
}

fn lock_selection() -> Result<std::sync::MutexGuard<'static, Option<Selection>>, String> {
    SELECTION
        .lock()
        .map_err(|_| "右键菜单动作表已损坏".to_string())
}

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

/// 隐藏菜单窗口。复用窗口时普通 `hide()` 会走 tao 的可见性缓存，这里显式
/// 走 `ShowWindow(SW_HIDE)`，与 `set_geometry` 的显示路径对称。
fn hide_menu(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        #[link(name = "user32")]
        extern "system" {
            fn ShowWindow(hwnd: *mut c_void, command: i32) -> i32;
        }
        const SW_HIDE: i32 = 0;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
        window
            .run_on_main_thread(move || {
                // A newer show may have installed a session while this hide
                // waited in the UI queue. It must never hide that replacement.
                let Ok(guard) = lock_session() else { return; };
                if guard.is_some() { return; }
                drop(guard);
                // HWND 属于本应用的复用菜单窗口；仅在其 UI 线程修改可见性。
                unsafe {
                    ShowWindow(hwnd as *mut c_void, SW_HIDE);
                }
            })
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        window.hide().map_err(|error| error.to_string())
    }
}

/// 尺寸 + 位置 + 首次显示，**一次**原生调用提交。
///
/// 之前是 `set_size` 再 `set_position` 两次调用：两次 SetWindowPos 之间会有
/// 一帧"新尺寸 + 旧位置"，靠近屏幕底部/右侧时那一帧就是用户看到的抖动。
/// 这里合并成单个 `SetWindowPos`，并且把 `SWP_SHOWWINDOW` 一并带上，
/// 保证窗口第一次出现在屏幕上时几何已经是最终值（不先显示后翻转）。
#[cfg(target_os = "windows")]
fn set_geometry(
    window: &WebviewWindow,
    rect: ((i32, i32), (u32, u32)),
    show: bool,
) -> Result<(), String> {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hwnd: *mut c_void,
            after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;

    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
    let ((x, y), (width, height)) = rect;
    let flags = SWP_NOZORDER | SWP_NOACTIVATE | if show { SWP_SHOWWINDOW } else { 0 };
    window
        .run_on_main_thread(move || {
            // HWND 属于本应用的复用菜单窗口；只在该窗口的 UI 线程改几何。
            unsafe {
                SetWindowPos(
                    hwnd as *mut c_void,
                    std::ptr::null_mut(),
                    x,
                    y,
                    width as i32,
                    height as i32,
                    flags,
                );
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
fn set_geometry(
    window: &WebviewWindow,
    rect: ((i32, i32), (u32, u32)),
    show: bool,
) -> Result<(), String> {
    window
        .set_size(tauri::PhysicalSize::new(rect.1 .0, rect.1 .1))
        .and_then(|_| window.set_position(tauri::PhysicalPosition::new(rect.0 .0, rect.0 .1)))
        .and_then(|_| if show { window.show() } else { Ok(()) })
        .map_err(|error| error.to_string())
}

/// 把事件送到来源窗口。
///
/// **同时走两条路**：`emit_to(label)` 是精确投递，`emit` 是项目里其它事件
/// （SSH 输出、部署日志、docker 变更）一直在用的广播路径 —— 那条路是验证过
/// 能在主窗口拿到事件的。两路都发不会出问题：显示确认只清计时器，动作派发
/// 有 `executed` 与 `requestId` 双重去重，重复投递不会执行两次。
fn emit_to_source(app: &tauri::AppHandle, source: &str, event: &str, payload: serde_json::Value) {
    let _ = app.emit_to(source, event, payload.clone());
    let _ = app.emit(event, payload);
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
            .focusable(false)
            .visible(false)
            .parent(&main)
            .map_err(|error| format!("无法把菜单窗口挂到主窗口：{error}"))?
            .build()
            .map_err(|error| format!("无法创建菜单窗口：{error}"))?;

    // Acrylic affects the entire bounding rectangle, including transparent
    // gutters between submenus. Keep this window transparent; panels own tint.
    let _ = crate::window_material::apply(&window, theme, false);

    // 这里刻意不监听 `Focused(false)` 来收起菜单：WebView2 的子窗口拿到键盘
    // 焦点时，顶层窗口同样会收到 WM_KILLFOCUS，"失焦"和"内部焦点交接"无法区分，
    // 监听它只会在菜单刚显示时把它关掉。菜单不激活，点击别的应用由来源页面
    // 的 DOM blur 收起（见 desktop-menu/bridge.ts）。
    let app_handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            dismiss(&app_handle, None, "close");
        }
        _ => {}
    });
    eprintln!("[desktop-menu] menu window created");
    Ok(window)
}

/// 关闭菜单并清掉会话。
///
/// `only` 是**必须匹配**的 requestId：迟到的关闭/隐藏请求（例如新菜单已经
/// 打开后才到达的旧 Esc）只能收起它自己那一次菜单，不能把新菜单一起带走。
/// 传 `None` 表示"来源窗口没了/应用退出"，此时按当前会话处理。
pub fn dismiss(app: &tauri::AppHandle, only: Option<&str>, reason: &str) {
    let session = {
        let Ok(mut guard) = lock_session() else {
            return;
        };
        let matches = guard
            .as_ref()
            .is_some_and(|session| only.is_none_or(|request_id| session.request_id == request_id));
        if !matches {
            return;
        }
        guard.take()
    };
    let Some(session) = session else {
        return;
    };
    // 菜单不取得焦点，来源窗口始终保有键盘；关闭时也不用强制激活任何窗口。
    if let Some(window) = app.get_webview_window(MENU_LABEL) {
        let _ = hide_menu(&window);
    }
    let _ = app.emit_to(
        MENU_LABEL,
        "desktop-menu:reset",
        serde_json::json!({"requestId": session.request_id}),
    );
    emit_to_source(
        app,
        session.source.as_str(),
        "desktop-menu:closed",
        serde_json::json!({ "requestId": session.request_id, "reason": reason }),
    );
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
    // 不在这里处理 `Focused`：来源窗口的 WebView 子窗口拿到焦点时同样会触发它，
    // 用它收菜单等于每次右键都把菜单立刻关掉（见 `source_usable` 的说明）。
    if matches!(event, tauri::WindowEvent::Resized(_)) {
        if app
            .get_webview_window(label)
            .is_some_and(|window| window.is_minimized().unwrap_or(false))
        {
            dismiss(app, None, "source");
        }
    }
    if matches!(
        event,
        tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
    ) {
        dismiss(app, None, "source");
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
    // 预创建只保证第一次右键不用等 WebView 冷启动；创建失败不影响这次
    // show（真正的窗口在 present 前还会再确保一次），不能因此丢掉菜单。
    let _ = ensure_window(&app, &theme);

    let previous = {
        let mut guard = lock_session()?;
        guard.replace(Session {
            request_id: payload.request_id.clone(),
            revision: 0,
            measure: None,
            source: window.label().to_string(),
            payload: payload.clone(),
            actions,
            material: "solid".into(),
            phase: Phase::Staged,
            last_geometry: None,
        })
    };
    if let Some(previous) = previous {
        emit_to_source(
            &app,
            previous.source.as_str(),
            "desktop-menu:closed",
            serde_json::json!({"requestId": previous.request_id, "reason": "replace"}),
        );
    }

    // 这里**不动原生窗口**。连续右键时窗口正显示着上一条菜单：提前挪过去
    // 会让旧内容先滑到新位置、再被换成新内容（用户看到的就是"跳动"）。
    // 窗口还没显示时，唯一的定位时机是 present —— 那时的几何已经量好。
    app.emit_to(MENU_LABEL, "desktop-menu:show", &payload)
        .map_err(|error| format!("无法通知菜单窗口：{error}"))?;
    eprintln!(
        "[desktop-menu] show {} from {}",
        payload.request_id,
        window.label()
    );

    // **用 IPC 返回值确认页面活着**，不依赖 `desktop-menu:shown` 事件。
    //
    // 之前是"发完事件就返回、等页面回事件"，那条链路一旦丢一次事件，来源
    // 窗口的兜底计时器就会把刚显示的菜单收掉 —— 用户看到的是"闪一下、点了
    // 没反应"。现在这里等页面走到**测量**（present 前的最后一步）：等到了
    // 就说明它活着，立刻返回 Ok；等不到就销毁窗口并报错，调用方直接回退到
    // 页面内菜单。返回值比事件可靠，也没有时序竞争。
    //
    // 注意：这里在 async 命令里，不能跨 await 持有会话锁。
    let request_id = payload.request_id.clone();
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(PAGE_RESPONSE_TIMEOUT);
    loop {
        let measured = lock_session()?
            .as_ref()
            .is_some_and(|session| session.request_id == request_id && session.measure.is_some());
        if measured {
            break;
        }
        if std::time::Instant::now() >= deadline {
            eprintln!("[desktop-menu] menu page unresponsive; rebuilding window");
            if let Some(window) = app.get_webview_window(MENU_LABEL) {
                let _ = window.destroy();
            }
            dismiss(&app, Some(&request_id), "menu-dead");
            return Err("菜单窗口未响应".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
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

/// 菜单窗口把自身的运行时错误回报给来源窗口。
///
/// 这个窗口没有用户可见的界面，它的报错只出现在它自己的 DevTools 里 ——
/// 而用户只看得到"右键没反应"。把错误转发出去，来源窗口能弹一条带原因的
/// 提示，问题就不再是黑盒。
#[tauri::command]
pub fn desktop_menu_report(
    app: tauri::AppHandle,
    window: WebviewWindow,
    message: String,
) -> Result<(), String> {
    require_menu_window(&window)?;
    eprintln!("[desktop-menu] page error: {message}");
    let source = lock_session()
        .ok()
        .and_then(|guard| guard.as_ref().map(|session| session.source.clone()));
    if let Some(source) = source {
        emit_to_source(
            &app,
            source.as_str(),
            "desktop-menu:failed",
            serde_json::json!({ "message": message }),
        );
    }
    Ok(())
}

/// 这几个命令只给菜单窗口用：主窗口没有理由读取或改写菜单窗口的会话。
fn require_menu_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == MENU_LABEL {
        Ok(())
    } else {
        Err("该命令只对菜单窗口开放".into())
    }
}

/// 计算一次布局：锚点（来源窗口客户区 CSS 像素）→ 屏幕物理像素，再按锚点
/// 所在显示器的工作区与 DPI 得出窗口矩形、面板偏移与可用高度。
///
/// 只读会话、**不碰原生窗口**：`layout` 用它做显示前迭代，`present` 用同一份
/// 计算做最终提交，两条路径永远一致（页面拿到的偏移就是窗口最终的几何）。
fn resolve_plan(
    app: &tauri::AppHandle,
    request_id: &str,
    width: f64,
    height: f64,
    submenu: Option<SubmenuRect>,
) -> Result<(Plan, String), String> {
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

    let source = app
        .get_webview_window(&source_label)
        .ok_or("来源窗口已关闭")?;
    if !source_usable(&source) {
        return Err("来源窗口已不可用".into());
    }

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
    let plan = plan_layout(
        anchor_x,
        anchor_y,
        work_rect,
        monitor.scale_factor(),
        (width, height),
        submenu.map(|rect| (rect.left, rect.top, rect.width, rect.height)),
    );
    Ok((plan, material))
}

fn to_menu_layout(plan: &Plan, material: String) -> MenuLayout {
    MenuLayout {
        main: plan.main,
        submenu: plan.submenu,
        max_height: plan.max_height,
        material,
    }
}

/// 显示前测量：只算几何，**不动原生窗口**。
///
/// 页面按返回值应用 max-height 再测一次，尺寸稳定后才调用
/// [`desktop_menu_present`]；首次出现时尺寸/位置/翻转已是最终值，
/// 不存在"先显示再翻转"，也不需要靠动画掩盖位移。
#[tauri::command]
pub async fn desktop_menu_layout(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    revision: u64,
    width: f64,
    height: f64,
    submenu: Option<SubmenuRect>,
) -> Result<MenuLayout, String> {
    require_menu_window(&window)?;
    eprintln!(
        "[desktop-menu] layout {request_id} rev {revision} size {width}x{height} submenu={}",
        submenu.is_some()
    );
    let (plan, material) = resolve_plan(&app, &request_id, width, height, submenu)?;
    {
        let mut guard = lock_session()?;
        let session = guard.as_mut().ok_or("没有打开的菜单")?;
        if session.request_id != request_id {
            return Err("菜单已过期".into());
        }
        if !session.accept_revision(revision) {
            return Err(format!("布局请求已过期（revision {revision}）"));
        }
        session.measure = Some(Measure {
            width,
            height,
            submenu,
        });
    }
    Ok(to_menu_layout(&plan, material))
}

/// 定稿并显示：**一次**原生调用同时提交尺寸、位置与可见性。
///
/// 用最后一次被接受的测量重算几何（位置/DPI/边界只在原生侧算），所以页面
/// 拿到的 `layout` 偏移与窗口最终几何必然一致；窗口第一次出现在屏幕上时
/// 就已经是最终位置，不存在"先显示再翻转"。
#[tauri::command]
pub fn desktop_menu_present(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    revision: Option<u64>,
) -> Result<(), String> {
    require_menu_window(&window)?;
    // 显示用的是**最后一次被接受的测量**：页面不必把尺寸再传一遍，
    // 也就不存在"present 的尺寸和 layout 的尺寸不一致"这种中间状态。
    let measure = {
        let guard = lock_session()?;
        let session = guard.as_ref().ok_or("没有打开的菜单")?;
        if session.request_id != request_id {
            return Err("菜单已过期".into());
        }
        session.measure.ok_or("菜单还没有测量尺寸")?
    };
    // 原生侧重算几何：位置/DPI/边界一律自己算，页面只提供内容尺寸。
    let (plan, _material) = resolve_plan(
        &app,
        &request_id,
        measure.width,
        measure.height,
        measure.submenu,
    )?;
    let geometry = (plan.window_pos, plan.window_size);
    let (source, needs_show) = {
        let mut guard = lock_session()?;
        let session = guard.as_mut().ok_or("没有打开的菜单")?;
        if session.request_id != request_id {
            return Err("菜单已过期".into());
        }
        if let Some(revision) = revision {
            if !session.accept_present_revision(revision) {
                return Err(format!("布局请求已过期（revision {revision}）"));
            }
        }
        // 已经显示、几何也没变：**一次原生调用都不做**。
        // 重复的 SetWindowPos/ShowWindow 会让这个"透明 + 材质"的窗口整块重绘，
        // 连带着主窗口的 Acrylic 一起闪 —— 子菜单只是展开/收起时的高频路径。
        let needs_show = session.phase != Phase::Visible || session.last_geometry != Some(geometry);
        session.last_geometry = Some(geometry);
        (session.source.clone(), needs_show)
    };
    if needs_show {
        if let Err(error) = set_geometry(&window, geometry, true) {
            dismiss(&app, Some(&request_id), "layout-error");
            return Err(error);
        }
        let mut guard = lock_session()?;
        if let Some(session) = guard.as_mut() {
            if session.request_id == request_id {
                session.phase = Phase::Visible;
            }
        }
    }
    // 告诉来源窗口"菜单真的出现了"：它据此撤掉兜底计时器，
    // 也把"菜单已经可交互"这件事和 pending 的生命周期对齐。
    emit_to_source(
        &app,
        source.as_str(),
        "desktop-menu:shown",
        serde_json::json!({ "requestId": request_id }),
    );
    eprintln!("[desktop-menu] present {request_id} -> source {source:?} (shown emitted)");
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

    trace(format!("select {} {}", session.request_id, action_id));
    // 第一路：把选择放进信箱。来源窗口会轮询 `desktop_menu_take_selection`，
    // 这条路不依赖事件，事件丢了动作也不会丢。
    if let Ok(mut slot) = lock_selection() {
        *slot = Some(Selection {
            request_id: session.request_id.clone(),
            action_id: action_id.clone(),
        });
    }

    let _ = app.emit_to(
        MENU_LABEL,
        "desktop-menu:reset",
        serde_json::json!({"requestId": session.request_id}),
    );
    // 第二路：事件通知（快路径）。
    emit_to_source(
        &app,
        session.source.as_str(),
        "desktop-menu:select",
        serde_json::json!({ "requestId": session.request_id, "actionId": action_id }),
    );
    eprintln!(
        "[desktop-menu] select {} {action_id} -> source {:?} (emitted)",
        session.request_id, session.source
    );
    if let Some(window) = app.get_webview_window(MENU_LABEL) {
        let _ = hide_menu(&window);
    }
    emit_to_source(
        &app,
        session.source.as_str(),
        "desktop-menu:closed",
        serde_json::json!({ "requestId": session.request_id, "reason": "select" }),
    );
    Ok(())
}

/// 取走并清空信箱里的选择（来源窗口轮询）。只返回属于该 requestId 的那一条。
#[tauri::command]
pub fn desktop_menu_take_selection(window: WebviewWindow, request_id: String) -> Option<String> {
    if window.label() == MENU_LABEL {
        return None;
    }
    let mut guard = lock_selection().ok()?;
    let matches = guard
        .as_ref()
        .is_some_and(|selection| selection.request_id == request_id);
    if !matches {
        return None;
    }
    let taken = guard.take().map(|selection| selection.action_id);
    trace(format!("take {request_id} -> {taken:?}"));
    taken
}

/// Esc / 点击窗口内的透明区域时由菜单窗口调用。
///
/// 只收起**它自己那一次**菜单：新菜单已经打开后才到达的迟到 close
/// 不能把新菜单一起带走。
#[tauri::command]
pub fn desktop_menu_close(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    reason: String,
) -> Result<(), String> {
    require_menu_window(&window)?;
    trace(format!("close {request_id} reason={reason}"));
    dismiss(&app, Some(&request_id), &reason);
    Ok(())
}

#[tauri::command]
pub fn desktop_menu_key(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    key: String,
) -> Result<(), String> {
    if !matches!(
        key.as_str(),
        "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "Enter" | "Escape"
    ) {
        return Err("不支持的菜单按键".into());
    }
    let allowed = lock_session()?.as_ref().is_some_and(|session| {
        session.request_id == request_id && session.source == window.label()
    });
    if !allowed {
        return Ok(());
    }
    app.emit_to(
        MENU_LABEL,
        "desktop-menu:key",
        serde_json::json!({"requestId": request_id, "key": key}),
    )
    .map_err(|error| error.to_string())
}

/// 来源窗口明确要求收起菜单（左键点击 / Tab / 滚动）。
///
/// 只认**它自己那一次**请求：新菜单已经打开后才到达的迟到取消不会误伤。
#[tauri::command]
pub fn desktop_menu_cancel(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let owned = lock_session()?.as_ref().is_some_and(|session| {
        session.request_id == request_id && session.source == window.label()
    });
    let reason = reason.as_deref().unwrap_or("outside");
    eprintln!("[desktop-menu] cancel {request_id} owned={owned} reason={reason}");
    if owned {
        dismiss(&app, Some(&request_id), reason);
    }
    Ok(())
}

/// DOM blur is only a hint: WebView2 child windows can blur the source while
/// the same native app window is still foreground. Never consume its actions
/// or hide the popup until the OS foreground window actually belongs elsewhere.
#[tauri::command]
pub fn desktop_menu_blur(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
) -> Result<bool, String> {
    let owned = lock_session()?.as_ref().is_some_and(|session| {
        session.request_id == request_id && session.source == window.label()
    });
    if !owned { return Ok(false); }
    #[cfg(target_os = "windows")]
    let external = {
        use std::ffi::c_void;
        #[link(name = "user32")]
        extern "system" {
            fn GetForegroundWindow() -> *mut c_void;
            fn GetAncestor(hwnd: *mut c_void, flags: u32) -> *mut c_void;
        }
        let source = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
        let menu = app.get_webview_window(MENU_LABEL)
            .and_then(|menu| menu.hwnd().ok()).map(|hwnd| hwnd.0 as usize);
        // A null foreground occurs during activation transitions. It does not
        // establish that the user switched away, so leave this menu intact.
        unsafe {
            let foreground = GetForegroundWindow();
            let root = GetAncestor(foreground, 2) as usize; // GA_ROOT
            !foreground.is_null() && foreground_is_external(source, menu, root)
        }
    };
    #[cfg(not(target_os = "windows"))]
    let external = !window.is_focused().unwrap_or(true)
        && !app.get_webview_window(MENU_LABEL)
            .is_some_and(|menu| menu.is_focused().unwrap_or(false));
    eprintln!("[desktop-menu] blur {request_id} external={external}");
    if external { dismiss(&app, Some(&request_id), "blur"); }
    Ok(external)
}

fn foreground_is_external(source: usize, menu: Option<usize>, foreground: usize) -> bool {
    foreground != 0 && foreground != source && menu != Some(foreground)
}

#[cfg(test)]
mod tests {
    use super::plan_layout;

    #[test]
    fn blur_requires_an_external_native_foreground() {
        assert!(!super::foreground_is_external(10, Some(20), 10));
        assert!(!super::foreground_is_external(10, Some(20), 20));
        assert!(!super::foreground_is_external(10, Some(20), 0));
        assert!(super::foreground_is_external(10, Some(20), 30));
    }

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

    /// 面板在**屏幕**上的原点（物理像素）——子菜单展开/收起时必须保持不变。
    fn main_screen_origin(plan: &super::Plan, scale: f64) -> (f64, f64) {
        (
            plan.window_pos.0 as f64 + plan.main.x * scale,
            plan.window_pos.1 as f64 + plan.main.y * scale,
        )
    }

    /// 子菜单向右展开：窗口变大，主面板屏幕位置不动。
    #[test]
    fn opening_a_submenu_keeps_the_main_panel_in_place() {
        let collapsed = plan_layout(600.0, 300.0, WORK, 1.0, (220.0, 200.0), None);
        let expanded = plan_layout(
            600.0,
            300.0,
            WORK,
            1.0,
            (220.0, 200.0),
            Some((214.0, 40.0, 200.0, 160.0)),
        );
        assert_eq!(
            main_screen_origin(&collapsed, 1.0),
            main_screen_origin(&expanded, 1.0)
        );
        // 窗口向右变宽，主面板在窗口内的偏移保持 16px 边距。
        assert!(expanded.window_size.0 > collapsed.window_size.0);
        assert_eq!(expanded.main.x, collapsed.main.x);
    }

    /// 子菜单被迫翻到左侧：窗口原点左移，主面板偏移同步右移，
    /// 屏幕位置仍然不动 —— 用户看不到主菜单"被推开"。
    #[test]
    fn submenu_flipping_left_does_not_shift_the_main_panel() {
        let collapsed = plan_layout(1800.0, 300.0, WORK, 1.0, (220.0, 200.0), None);
        let expanded = plan_layout(
            1800.0,
            300.0,
            WORK,
            1.0,
            (220.0, 200.0),
            Some((214.0, 40.0, 260.0, 160.0)),
        );
        assert_eq!(
            main_screen_origin(&collapsed, 1.0),
            main_screen_origin(&expanded, 1.0)
        );
        assert!(expanded.window_pos.0 < collapsed.window_pos.0);
        assert!(expanded.main.x > collapsed.main.x);
    }

    /// 高 DPI 下同一条约束同样成立（窗口尺寸与偏移都按 scale 放大）。
    #[test]
    fn submenu_keeps_the_main_panel_place_at_hidpi() {
        let collapsed = plan_layout(600.0, 300.0, WORK, 1.5, (220.0, 200.0), None);
        let expanded = plan_layout(
            600.0,
            300.0,
            WORK,
            1.5,
            (220.0, 200.0),
            Some((214.0, 40.0, 200.0, 160.0)),
        );
        assert_eq!(
            main_screen_origin(&collapsed, 1.5),
            main_screen_origin(&expanded, 1.5)
        );
    }

    /// 底部：窗口整体留在工作区内，且 max_height 是"内容可用高度"，
    /// 页面据此在**显示前**截断，不会出现"先显示再压扁"。
    #[test]
    fn bottom_anchor_never_leaves_the_work_area() {
        let plan = plan_layout(800.0, 1035.0, WORK, 1.0, (220.0, 400.0), None);
        let bottom = plan.window_pos.1 as f64 + plan.window_size.1 as f64;
        assert!(bottom <= WORK.3, "窗口底边 {bottom} 超出工作区");
        assert!(plan.window_pos.1 >= 0);
        assert!(plan.max_height > 0.0);
        // 面板高度已经被压到可用高度以内：present 时不需要二次改高。
        assert!(plan.window_size.1 as f64 <= WORK.3);
    }

    // ── 显示状态机 ─────────────────────────────────────────────────────────
    //
    // `Session` 依赖窗口与会话表，这里只覆盖纯逻辑：revision 的接受规则。

    fn session_with_revision(revision: u64) -> super::Session {
        super::Session {
            request_id: "req".into(),
            revision,
            measure: None,
            source: "main".into(),
            payload: super::MenuShowPayload {
                request_id: "req".into(),
                theme: "light".into(),
                anchor: super::MenuAnchor { x: 0.0, y: 0.0 },
                width: 220.0,
                items: serde_json::json!([]),
            },
            actions: Default::default(),
            material: "solid".into(),
            phase: super::Phase::Staged,
            last_geometry: None,
        }
    }

    #[test]
    fn layout_revisions_must_increase() {
        let mut session = session_with_revision(0);
        assert!(session.accept_revision(1));
        assert!(session.accept_revision(2));
        // 迟到的旧测量不能把窗口挪回旧位置。
        assert!(!session.accept_revision(2));
        assert!(!session.accept_revision(1));
        assert_eq!(session.revision, 2);
    }

    #[test]
    fn present_accepts_the_final_revision_but_never_goes_backwards() {
        let mut session = session_with_revision(3);
        // 定稿用的就是最后一次测量的 revision：相等允许。
        assert!(session.accept_present_revision(3));
        // 更旧的 present 迟到（例如两次测量都没返回就显示完了）直接拒绝。
        assert!(!session.accept_present_revision(2));
        assert_eq!(session.revision, 3);
    }

    #[test]
    fn a_replaced_menu_starts_from_revision_zero() {
        // 新请求的 revision 从头开始；旧请求的 revision 不会把它卡住。
        let mut session = session_with_revision(0);
        assert!(session.accept_revision(1));
        assert_eq!(session.phase, super::Phase::Staged);
    }
}
