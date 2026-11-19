//! 桌面右下角通知：**一条可见通知一个原生窗口**，玻璃用 WGC 实时画面。
//!
//! # 为什么拆窗口
//!
//! - 卡片之间是桌面，空隙必须能点到底下的东西 → 窗口只包住一张卡片；
//! - 关闭中间一条时，其余通知只做位置补位：内容、计时、可点击状态都不重建；
//! - 每条通知的坐标、纹理各自独立，一条失败不影响其它条。
//!
//! # 窗口池
//!
//! 同时最多 [`MAX_VISIBLE`] 条。窗口固定创建这么多个（label
//! `desktop-notification-0..N`），之后只复用不新建 —— 连续弹十条也不会创建
//! 十个 WebView。超出的进队列，关掉一条再放出来。
//!
//! # 材质
//!
//! GlassSurface 需要一张**纹理**才能折射。这里不再用静态截图，而是交给
//! [`crate::notification_capture`]：WGC 持续采集显示器，按每个窗口的物理
//! 矩形裁剪出各自那块桌面，15 FPS 更新。前端用 canvas 当纹理源，
//! `desktop_notification_frame` 以二进制响应拉取。
//!
//! 帧是实时的，所以窗口移动/补位/换屏都不存在"旧图错位"：裁剪目标跟着几何
//! 更新，下一帧就是新位置。没有帧（采集未就绪 / 失败）时卡片保持主题底色。
//!
//! 通知窗口创建时设置了 `WDA_EXCLUDEFROMCAPTURE`：WGC 的帧里不应出现通知
//! 自己。这一点需要在真机上验证（见验收步骤）。
//!
//! # 几何
//!
//! 右下角堆叠、间距、补位全部在这里算：最新的在最底部，旧的往上排。窗口与
//! 卡片严丝合缝，卡片之间的空隙就是桌面，不需要额外做点击穿透。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::desktop_surface;
use crate::notification_capture as capture;

pub const LABEL_PREFIX: &str = "desktop-notification";

/// 同时可见的通知上限，同时也是窗口池的大小。
const MAX_VISIBLE: usize = 3;
/// 卡片宽度（CSS 像素），与前端卡片的 `w-[360px]` 一致。
const PANEL_WIDTH: f64 = 360.0;
/// 距工作区右边/底边的间距（CSS 像素）。
const SCREEN_MARGIN: f64 = 16.0;
/// 卡片之间的空隙（CSS 像素）：留空即桌面，可以点到下面的窗口。
const CARD_GAP: f64 = 8.0;
/// 前端还没测出内容高度时的占位高度（CSS 像素）。
const ESTIMATED_HEIGHT: f64 = 96.0;
/// 单张卡片高度上限（CSS 像素）。
const MAX_CARD_HEIGHT: f64 = 720.0;
/// 补位动画时长（毫秒）。与前端 200ms 的进出场同量级。
const MOVE_DURATION_MS: f64 = 200.0;
/// 补位动画帧间隔（约 60 fps）。
const MOVE_FRAME_MS: u64 = 16;

/// 系统是否开启了"减少动画"：位置直接更新，不做补位补间。
static REDUCED_MOTION: AtomicBool = AtomicBool::new(false);
/// 补位动画代数：连续增删时旧的补间自行退出，新的从窗口当前位置接着算。
static MOVE_EPOCH: AtomicU64 = AtomicU64::new(1);

/// 一次补位：从窗口**当前**几何平滑移到布局目标。
struct MovePlan {
    index: usize,
    label: String,
    from: PresentGeometry,
    to: PresentGeometry,
    /// 生成这次补位时的布局版本：迟到的帧不再写状态。
    version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub meta: Option<String>,
    #[serde(default)]
    pub time: Option<String>,
    /// info / success / warning / danger：只做文字强调，不影响材质。
    #[serde(default)]
    pub tone: Option<String>,
    /// 停留时长（毫秒）；`None` 用前端默认值，`0` 表示常驻。
    #[serde(default)]
    pub duration_ms: Option<u64>,
    /// 点击通知时主窗口要执行的动作，Rust 不解释、原样透传。
    #[serde(default)]
    pub action: Option<serde_json::Value>,
    /// 通知里的操作按钮（审批用）：`key` 由主窗口解释，Rust 只负责转回去。
    #[serde(default)]
    pub buttons: Vec<NotificationButton>,
}

/// 通知上的一个按钮：点下去把 `key` 转给主窗口。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationButton {
    pub key: String,
    pub label: String,
}

/// 一次提交的窗口几何（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

struct Slot {
    label: String,
    notification: Option<NotificationPayload>,
    /// 卡片高度（CSS 像素），由前端测量后上报。
    height: f64,
    visible: bool,
    geometry: Option<PresentGeometry>,
    /**
     * 布局版本：每次 commit 处理到这个槽就 +1。
     *
     * 原生调用都在锁外执行，回来时布局可能已经被下一次增删改过；只把结果
     * 写回**同一版本**的槽，迟到的移动/隐藏不会覆盖新状态。
     */
    version: u64,
}

struct NotificationManager {
    slots: Vec<Slot>,
    queue: VecDeque<NotificationPayload>,
    /// 可见通知的槽序号，**从新到旧**（index 0 = 最新 = 最底部）。
    order: Vec<usize>,
}

static MANAGER: Mutex<Option<NotificationManager>> = Mutex::new(None);
/// 窗口池是否已经建好（`MANAGER` 里有 slots）。
static SLOTS_READY: AtomicBool = AtomicBool::new(false);
/// 窗口池初始化的串行门：多个后台线程同时 push 时只建一批，其它人等待。
static SLOTS_INIT: Mutex<()> = Mutex::new(());

fn label_for(index: usize) -> String {
    format!("{LABEL_PREFIX}-{index}")
}

/// `desktop-notification-2` → `2`。
fn slot_index_of(window: &WebviewWindow) -> Option<usize> {
    window
        .label()
        .strip_prefix(LABEL_PREFIX)?
        .strip_prefix('-')?
        .parse()
        .ok()
}

/// 让屏幕捕获忽略这个窗口（Windows 10 2004+）。
///
/// WGC 的 monitor 采集会遵守这个标记：帧里不会出现通知自己，裁出来的是它
/// 背后的真实画面。返回是否生效。
#[cfg(target_os = "windows")]
fn exclude_from_capture(window: &WebviewWindow) -> bool {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowDisplayAffinity(hwnd: *mut c_void, affinity: u32) -> i32;
    }
    /// 窗口不出现在任何屏幕捕获里，但用户仍然看得见。
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x0000_0011;

    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    unsafe { SetWindowDisplayAffinity(hwnd.0 as *mut c_void, WDA_EXCLUDEFROMCAPTURE) != 0 }
}

#[cfg(not(target_os = "windows"))]
fn exclude_from_capture(_window: &WebviewWindow) -> bool {
    false
}

fn create_slot_window(app: &tauri::AppHandle, label: &str) -> Result<WebviewWindow, String> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("")
        .initialization_script("window.__BLS_VIEW__='desktop-notification';")
        .inner_size(PANEL_WIDTH, ESTIMATED_HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .always_on_top(true)
        .visible(false)
        .build()
        .map_err(|error| format!("无法创建通知窗口：{error}"))
}

/// 创建（或复用）窗口池。只建 [`MAX_VISIBLE`] 个，之后永不增长。
///
/// **建窗全程不持 `MANAGER` 锁**：`WebviewWindowBuilder::build` 与
/// `window.hwnd()` 都要等 UI 线程，而新窗口加载后会立刻调
/// `desktop_notification_pending`（也要这把锁）—— 持锁建窗就是
/// "后台等 UI、UI 等锁" 的死锁。
fn ensure_slots(app: &tauri::AppHandle) -> Result<(), String> {
    if SLOTS_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    // 串行化初始化：其它线程在这里等，不占 MANAGER。
    let _init = SLOTS_INIT
        .lock()
        .map_err(|_| "通知初始化已损坏".to_string())?;
    if SLOTS_READY.load(Ordering::Acquire) {
        return Ok(());
    }

    // 锁外：创建窗口 + 设置捕获排除（都会触碰 HWND / UI 线程）。
    let mut labels = Vec::with_capacity(MAX_VISIBLE);
    for index in 0..MAX_VISIBLE {
        let label = label_for(index);
        let window = create_slot_window(app, &label)?;
        // 采集排除必须在窗口显示前设置，第一帧才是干净的。
        let _ = exclude_from_capture(&window);
        labels.push(label);
    }

    // 锁内只写内存状态。
    {
        let mut guard = MANAGER.lock().map_err(|_| "通知状态已损坏".to_string())?;
        if guard.is_none() {
            *guard = Some(NotificationManager {
                slots: labels
                    .into_iter()
                    .map(|label| Slot {
                        label,
                        notification: None,
                        height: ESTIMATED_HEIGHT,
                        visible: false,
                        geometry: None,
                        version: 0,
                    })
                    .collect(),
                queue: VecDeque::new(),
                order: Vec::new(),
            });
        }
    }
    SLOTS_READY.store(true, Ordering::Release);
    Ok(())
}

fn current_monitor(app: &tauri::AppHandle) -> Result<(tauri::Monitor, f64), String> {
    // 通知跟着**用户正在用的那块屏幕**走：主窗口所在显示器，而不是主显示器。
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("无法确定通知所在的显示器")?;
    let scale = monitor.scale_factor();
    Ok((monitor, scale))
}

/// 纯几何：从右下角往上排。最新（order[0]）在最底部。
fn plan_layout(
    order: &[usize],
    slots: &[Slot],
    work: (i32, i32, u32, u32),
    scale: f64,
) -> Vec<(usize, PresentGeometry)> {
    let width = (PANEL_WIDTH * scale).round().max(1.0) as u32;
    let margin = (SCREEN_MARGIN * scale).round() as i32;
    let gap = (CARD_GAP * scale).round() as i32;
    let right = work.0 + work.2 as i32;
    let mut cursor = work.1 + work.3 as i32 - margin;

    let mut plans = Vec::with_capacity(order.len());
    for index in order {
        let slot = &slots[*index];
        let height = (slot.height.clamp(1.0, MAX_CARD_HEIGHT) * scale)
            .round()
            .max(1.0) as u32;
        let y = cursor - height as i32;
        let x = right - width as i32 - margin;
        plans.push((
            *index,
            PresentGeometry {
                x,
                y,
                width,
                height,
                scale,
            },
        ));
        cursor = y - gap;
    }
    plans
}

fn rect_of(geometry: &PresentGeometry) -> ((i32, i32), (u32, u32)) {
    ((geometry.x, geometry.y), (geometry.width, geometry.height))
}

/// 一次采集同步：目标矩形 + 会话要跑在哪块屏。
struct CapturePlan {
    targets: Vec<capture::CaptureTarget>,
    monitor_name: String,
    monitor_x: i32,
    monitor_y: i32,
    scale: f64,
}

/// 只读状态：把可见槽的几何翻译成采集目标。
fn build_capture_targets(
    manager: &NotificationManager,
    monitor_x: i32,
    monitor_y: i32,
    scale: f64,
) -> Vec<capture::CaptureTarget> {
    manager
        .order
        .iter()
        .filter_map(|index| manager.slots.get(*index))
        .filter(|slot| slot.visible && slot.notification.is_some())
        .filter_map(|slot| {
            let geometry = slot.geometry?;
            let notification = slot.notification.as_ref()?;
            Some(capture::CaptureTarget {
                label: slot.label.clone(),
                notification_id: notification.id.clone(),
                monitor_x,
                monitor_y,
                x: geometry.x,
                y: geometry.y,
                width: geometry.width,
                height: geometry.height,
                out_width: (geometry.width as f64 / scale).round().max(1.0) as u32,
                out_height: (geometry.height as f64 / scale).round().max(1.0) as u32,
            })
        })
        .collect()
}

/// 锁外查显示器 → 锁内收集目标 → 释放。
///
/// `current_monitor` 会跨线程问主窗口，绝不能放在 `MANAGER` 锁里。
fn capture_plan(app: &tauri::AppHandle) -> Option<CapturePlan> {
    let (monitor, scale) = current_monitor(app).ok()?;
    let position = monitor.position();
    let monitor_name = monitor.name().cloned().unwrap_or_default();

    let targets = {
        let guard = MANAGER.lock().ok()?;
        let manager = guard.as_ref()?;
        build_capture_targets(manager, position.x, position.y, scale)
    };

    Some(CapturePlan {
        targets,
        monitor_name,
        monitor_x: position.x,
        monitor_y: position.y,
        scale,
    })
}

fn apply_capture_plan(plan: CapturePlan) {
    if plan.targets.is_empty() {
        capture::stop();
        capture::set_targets(Vec::new());
        return;
    }
    capture::set_targets(plan.targets);
    capture::ensure_started(
        &plan.monitor_name,
        plan.monitor_x,
        plan.monitor_y,
        plan.scale,
    );
}

/// 读当前布局状态刷新采集裁剪目标（补位动画的每一帧都会调）。
fn refresh_capture(app: &tauri::AppHandle) {
    if let Some(plan) = capture_plan(app) {
        apply_capture_plan(plan);
    }
}

/// 首次显示：锁外提交原生几何，回来后按版本写状态。
struct PendingShow {
    index: usize,
    label: String,
    geometry: PresentGeometry,
    version: u64,
}

/// 提交当前布局并同步采集目标。
///
/// 分三段，**锁只在中段**：
/// 1. 锁外查显示器、算工作区（`current_monitor` 要问主窗口）；
/// 2. 锁内只算布局、递增版本、收集要提交的窗口；
/// 3. 锁外做 `set_geometry`（取 HWND / 投递 UI 线程），再按版本写回状态。
///
/// 已显示且几何没变的窗口**一次原生调用都不做**：重复的 `SetWindowPos`
/// 会让透明窗口整块重绘，WebGL 的 drawing buffer 跟着丢。
fn commit(app: &tauri::AppHandle) -> Result<Vec<MovePlan>, String> {
    let (monitor, scale) = current_monitor(app)?;
    let work = monitor.work_area();

    let (shows, moves) = {
        let mut guard = MANAGER.lock().map_err(|_| "通知状态已损坏".to_string())?;
        let manager = guard.as_mut().ok_or("通知管理器未初始化")?;
        let plans = plan_layout(
            &manager.order,
            &manager.slots,
            (
                work.position.x,
                work.position.y,
                work.size.width,
                work.size.height,
            ),
            scale,
        );

        let mut shows = Vec::new();
        let mut moves = Vec::new();
        for (index, geometry) in plans {
            let slot = &mut manager.slots[index];
            slot.version += 1;
            let version = slot.version;

            if slot.visible && slot.geometry == Some(geometry) {
                continue;
            }
            if slot.visible {
                // 已经显示：从当前位置平滑移到目标，只动受影响的窗口。
                if let Some(from) = slot.geometry {
                    moves.push(MovePlan {
                        index,
                        label: slot.label.clone(),
                        from,
                        to: geometry,
                        version,
                    });
                }
                continue;
            }
            shows.push(PendingShow {
                index,
                label: slot.label.clone(),
                geometry,
                version,
            });
        }
        (shows, moves)
    };

    // 锁外：首次显示。`set_geometry` 会取 HWND 并投递到 UI 线程。
    for item in shows {
        let applied = app.get_webview_window(&item.label).is_some_and(|window| {
            desktop_surface::set_geometry(&window, rect_of(&item.geometry), true).is_ok()
        });
        if !applied {
            continue;
        }
        // 只写回同一版本：期间若有新的增删，这次结果作废。
        if let Ok(mut guard) = MANAGER.lock() {
            if let Some(manager) = guard.as_mut() {
                if let Some(slot) = manager.slots.get_mut(item.index) {
                    if slot.version == item.version {
                        slot.visible = true;
                        slot.geometry = Some(item.geometry);
                    }
                }
            }
        }
    }

    refresh_capture(app);
    Ok(moves)
}

fn lerp(from: i32, to: i32, progress: f64) -> i32 {
    (from as f64 + (to - from) as f64 * progress).round() as i32
}

/// 补位动画：把窗口逐帧移到目标位置。
///
/// - 只动 `moves` 里的窗口，其它窗口一个原生调用都不做；
/// - 每帧按**当前**几何刷新采集目标，玻璃背景跟着窗口走，不会滑移；
/// - `MOVE_EPOCH` 让连续增删时旧补间自行退出，新补间从窗口当前位置接着算；
/// - "减少动画"时直接落到目标。
fn start_move_animation(app: &tauri::AppHandle, moves: Vec<MovePlan>) {
    if moves.is_empty() {
        return;
    }

    // 先递增代数：无论走补间还是直接落位，旧补间都必须立刻让位。
    let epoch = MOVE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;

    if REDUCED_MOTION.load(Ordering::Relaxed) {
        for plan in &moves {
            if let Some(window) = app.get_webview_window(&plan.label) {
                let _ = desktop_surface::set_geometry(&window, rect_of(&plan.to), false);
            }
            if let Ok(mut guard) = MANAGER.lock() {
                if let Some(manager) = guard.as_mut() {
                    if let Some(slot) = manager.slots.get_mut(plan.index) {
                        if slot.version == plan.version {
                            slot.geometry = Some(plan.to);
                        }
                    }
                }
            }
        }
        refresh_capture(app);
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            if MOVE_EPOCH.load(Ordering::Relaxed) != epoch {
                break;
            }
            let progress = (started.elapsed().as_secs_f64() * 1000.0 / MOVE_DURATION_MS).min(1.0);
            // ease-out cubic：起步快、收尾稳，和前端淡入是同一观感。
            let eased = 1.0 - (1.0 - progress).powi(3);

            for plan in &moves {
                let geometry = PresentGeometry {
                    x: lerp(plan.from.x, plan.to.x, eased),
                    y: lerp(plan.from.y, plan.to.y, eased),
                    width: plan.to.width,
                    height: plan.to.height,
                    scale: plan.to.scale,
                };
                if let Some(window) = app.get_webview_window(&plan.label) {
                    let _ = desktop_surface::set_geometry(&window, rect_of(&geometry), false);
                }
                // 采集按这一帧的位置裁背景：否则玻璃会带着旧纹理一起滑。
                // 版本对不上说明布局已经变了，这一帧直接丢弃。
                if let Ok(mut guard) = MANAGER.lock() {
                    if let Some(manager) = guard.as_mut() {
                        if let Some(slot) = manager.slots.get_mut(plan.index) {
                            if slot.notification.is_some() && slot.version == plan.version {
                                slot.geometry = Some(geometry);
                            }
                        }
                    }
                }
            }
            refresh_capture(&app);

            if progress >= 1.0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(MOVE_FRAME_MS));
        }
    });
}

/// 预创建窗口池（隐藏）。主窗口启动后调一次，第一条通知不用等 WebView 冷启动。
#[tauri::command]
pub async fn desktop_notification_prepare(app: tauri::AppHandle) -> Result<(), String> {
    // 采集线程发"有新帧"事件时需要 AppHandle。
    capture::set_app_handle(app.clone());
    ensure_slots(&app)
}

/// 还没建完窗口池时先攒在这里，建好后一次性补发。
static PENDING_PUSH: Mutex<Vec<NotificationPayload>> = Mutex::new(Vec::new());
/// 保证同一时刻只有一个线程在建窗。
static SLOTS_BUILDING: AtomicBool = AtomicBool::new(false);

/// 推一条通知：有空槽就显示，没有就排队。
///
/// **窗口池没建好时先入队、立刻返回**：`WebviewWindowBuilder::build` 要等 UI
/// 线程，在这里同步建窗会把调用的 runtime 线程占住，后续的 push / 审批更新
/// 只能排队 —— 主窗口那边表现为"点了确认，通知半天不动"。
#[tauri::command]
pub async fn desktop_notification_push(
    app: tauri::AppHandle,
    payload: NotificationPayload,
) -> Result<(), String> {
    if !SLOTS_READY.load(Ordering::Acquire) {
        if let Ok(mut queue) = PENDING_PUSH.lock() {
            queue.retain(|queued| queued.id != payload.id);
            queue.push(payload);
        }
        build_in_background(app);
        return Ok(());
    }
    push_ready(&app, payload)
}

/// 后台建窗，再补发排队中的通知。重复调用只会有一次真正建窗。
fn build_in_background(app: tauri::AppHandle) {
    if SLOTS_BUILDING.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = ensure_slots(&app);
        SLOTS_BUILDING.store(false, Ordering::Release);
        if result.is_err() {
            return;
        }
        let queued: Vec<NotificationPayload> = PENDING_PUSH
            .lock()
            .map(|mut queue| queue.drain(..).collect())
            .unwrap_or_default();
        for payload in queued {
            let _ = push_ready(&app, payload);
        }
    });
}

/// 窗口池就绪后的推送：先改内存，锁外再通知窗口。
fn push_ready(app: &tauri::AppHandle, payload: NotificationPayload) -> Result<(), String> {
    let mut emit: Option<(String, NotificationPayload)> = None;
    {
        let mut guard = MANAGER.lock().map_err(|_| "通知状态已损坏".to_string())?;
        let manager = guard.as_mut().ok_or("通知管理器未初始化")?;

        // 同一 id 重复弹出：复用原槽，内容就地替换（位置不变、不重建窗口）。
        let existing = manager.order.iter().copied().find(|index| {
            manager.slots[*index]
                .notification
                .as_ref()
                .is_some_and(|current| current.id == payload.id)
        });
        if let Some(index) = existing {
            let slot = &mut manager.slots[index];
            slot.notification = Some(payload.clone());
            emit = Some((slot.label.clone(), payload));
        } else {
            let free = manager
                .slots
                .iter()
                .position(|slot| slot.notification.is_none());
            match (free, manager.order.len() < MAX_VISIBLE) {
                (Some(index), true) => {
                    let slot = &mut manager.slots[index];
                    slot.notification = Some(payload.clone());
                    // 高度未知：先占位，前端测量后 present 再统一排。
                    slot.height = ESTIMATED_HEIGHT;
                    slot.visible = false;
                    slot.geometry = None;
                    manager.order.insert(0, index);
                    emit = Some((slot.label.clone(), payload));
                }
                _ => {
                    // 队列里同一 id 也去重：连续推送同一件事只留最新一条。
                    manager.queue.retain(|queued| queued.id != payload.id);
                    manager.queue.push_back(payload);
                }
            }
        }
    }

    if let Some((label, payload)) = emit {
        app.emit_to(&label, "desktop-notification:show", &payload)
            .map_err(|error| format!("无法通知通知窗口：{error}"))?;
    }
    Ok(())
}

/// 槽窗口拉取自己当前的通知（事件可能早于页面就绪）。
#[tauri::command]
pub fn desktop_notification_pending(window: WebviewWindow) -> Option<NotificationPayload> {
    let index = slot_index_of(&window)?;
    let guard = MANAGER.lock().ok()?;
    let manager = guard.as_ref()?;
    manager.slots.get(index)?.notification.clone()
}

/// 槽窗口测出卡片高度后上报：重排整列并同步采集目标。
#[tauri::command]
pub async fn desktop_notification_present(
    app: tauri::AppHandle,
    window: WebviewWindow,
    height: f64,
) -> Result<PresentGeometry, String> {
    let index = slot_index_of(&window).ok_or("不是通知窗口")?;

    // 第一段：只更新内存状态。
    {
        let mut guard = MANAGER.lock().map_err(|_| "通知状态已损坏".to_string())?;
        let manager = guard.as_mut().ok_or("通知管理器未初始化")?;
        let slot = manager.slots.get_mut(index).ok_or("槽位不存在")?;
        if slot.notification.is_none() {
            return Err("槽位空闲".into());
        }
        slot.height = height.clamp(1.0, MAX_CARD_HEIGHT);
    }

    // 第二段：锁外查显示器、提交几何、同步采集。
    let moves = commit(&app)?;
    start_move_animation(&app, moves);

    // 第三段：读回最终几何（轻量）。
    let geometry = {
        let guard = MANAGER.lock().map_err(|_| "通知状态已损坏".to_string())?;
        let manager = guard.as_ref().ok_or("通知管理器未初始化")?;
        manager
            .slots
            .get(index)
            .and_then(|slot| slot.geometry)
            .ok_or_else(|| "布局中没有这个槽".to_string())?
    };
    Ok(geometry)
}

/// 拉取本槽最新一帧。
///
/// 二进制响应：`seq(u64 LE) + width(u32 LE) + height(u32 LE) + RGBA`；
/// 没有新帧/帧不属于当前通知或当前几何时返回 16 字节全 0 的空头 —— 前端
/// 据此跳过重复像素拷贝。
#[tauri::command]
pub fn desktop_notification_frame(
    window: WebviewWindow,
    last_seq: Option<u64>,
) -> tauri::ipc::Response {
    let empty = || tauri::ipc::Response::new(vec![0u8; 16]);
    let label = window.label().to_string();

    let Some(frame) = capture::latest_frame(&label) else {
        return empty();
    };
    if last_seq == Some(frame.seq) {
        return empty();
    }

    // 帧必须属于**当前通知、当前几何**：槽被复用/补位后，旧帧不能画到新位置。
    let valid = {
        let Ok(guard) = MANAGER.lock() else {
            return empty();
        };
        let Some(manager) = guard.as_ref() else {
            return empty();
        };
        let Some(slot) = manager.slots.iter().find(|slot| slot.label == label) else {
            return empty();
        };
        let (Some(notification), Some(geometry)) = (slot.notification.as_ref(), slot.geometry)
        else {
            return empty();
        };
        // 位置不要求严格相等：补位动画期间窗口每帧都在动，采集帧会落后
        // 一两个采样点。只要还是同一条通知、尺寸没变，这一帧就是"附近的
        // 真实画面"，比继续用上一张更像跟着卡片走。
        frame.notification_id == notification.id
            && frame.geometry.2 == geometry.width
            && frame.geometry.3 == geometry.height
    };
    if !valid {
        return empty();
    }

    let mut payload = Vec::with_capacity(16 + frame.pixels.len());
    payload.extend_from_slice(&frame.seq.to_le_bytes());
    payload.extend_from_slice(&frame.width.to_le_bytes());
    payload.extend_from_slice(&frame.height.to_le_bytes());
    payload.extend_from_slice(&frame.pixels);
    tauri::ipc::Response::new(payload)
}

/// 点击一条通知：把它的 `action` 转给主窗口执行（跳转/安装更新等）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationActivation {
    id: String,
    action: Option<serde_json::Value>,
}

#[tauri::command]
pub fn desktop_notification_activate(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let activation = {
        let guard = MANAGER.lock().map_err(|_| "通知状态已损坏".to_string())?;
        let manager = guard.as_ref().ok_or("通知管理器未初始化")?;
        let slot = manager
            .slots
            .iter()
            .find(|slot| {
                slot.notification
                    .as_ref()
                    .is_some_and(|current| current.id == id)
            })
            .ok_or("通知已关闭")?;
        let notification = slot.notification.as_ref().ok_or("通知已关闭")?;
        NotificationActivation {
            id: id.clone(),
            action: notification.action.clone(),
        }
    };

    app.emit_to("main", "desktop-notification:activate", &activation)
        .map_err(|error| format!("无法通知主窗口：{error}"))
}

//// 通知上的按钮被按下：把 `key` 原样转给主窗口，由它执行同一个审批流程。
///
/// 通知窗口是独立 WebView，没有超能模式的状态与 IPC 权限；这里只做**转发**，
/// 真正的 approve 仍由主窗口调用（与点确认条走同一条 `agent_approve`）。
#[tauri::command]
pub fn desktop_notification_decide(
    app: tauri::AppHandle,
    id: String,
    key: String,
) -> Result<(), String> {
    let payload = serde_json::json!({ "id": id, "key": key });
    app.emit_to("main", "desktop-notification:decide", payload)
        .map_err(|error| format!("无法通知主窗口：{error}"))
}

/// 系统"减少动画"开关：位置直接更新，不做补位补间。
#[tauri::command]
pub fn desktop_notification_set_motion(reduced: bool) {
    REDUCED_MOTION.store(reduced, Ordering::Relaxed);
}

/// 验收用：给所有可见槽写一张合成图（不同位置的竖线），不启动采集。
///
/// 连续调用 `step = 0`、`step = 1`，验证"同一位置换图，纹理更新且玻璃不消失"。
#[tauri::command]
pub fn desktop_notification_debug_texture(step: u32) {
    capture::debug_texture(step);
}

/// 关掉一条：其余通知只补位，队列里的补上来。
#[tauri::command]
pub fn desktop_notification_dismiss(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut emit: Option<(String, NotificationPayload)> = None;
    let hidden: Option<String>;

    // 第一段：锁内只改内存状态，不碰窗口。
    {
        let mut guard = MANAGER.lock().map_err(|_| "通知状态已损坏".to_string())?;
        let manager = guard.as_mut().ok_or("通知管理器未初始化")?;

        let Some(index) = manager.order.iter().copied().find(|index| {
            manager.slots[*index]
                .notification
                .as_ref()
                .is_some_and(|current| current.id == id)
        }) else {
            return Ok(());
        };

        manager.order.retain(|slot_index| *slot_index != index);
        let label = {
            let slot = &mut manager.slots[index];
            slot.notification = None;
            slot.height = ESTIMATED_HEIGHT;
            slot.visible = false;
            slot.geometry = None;
            slot.version += 1;
            slot.label.clone()
        };
        hidden = Some(label);

        // 队列里还有：占用刚空出来的槽，等它 present 时统一排。
        if let Some(next) = manager.queue.pop_front() {
            let slot = &mut manager.slots[index];
            slot.notification = Some(next.clone());
            slot.height = ESTIMATED_HEIGHT;
            slot.visible = false;
            slot.geometry = None;
            manager.order.insert(0, index);
            emit = Some((slot.label.clone(), next));
        }
    }

    // 第二段：锁外隐藏窗口、通知页面、清帧。
    if let Some(label) = hidden {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = desktop_surface::hide(&window);
        }
        let _ = app.emit_to(&label, "desktop-notification:reset", ());
        // 槽会被下一条通知复用：旧帧必须清掉，否则新通知会先看到上一条的画面。
        capture::clear_frame(&label);
    }

    // 第三段：锁外补位（commit 内部再分阶段拿锁），只移动受影响的窗口。
    let moves = commit(&app)?;
    start_move_animation(&app, moves);

    if let Some((label, payload)) = emit {
        app.emit_to(&label, "desktop-notification:show", &payload)
            .map_err(|error| format!("无法通知通知窗口：{error}"))?;
    }
    Ok(())
}

/**
 * 主窗口回到前台：撤下所有超能通知，并清掉仍在等待显示的队列。
 *
 * 只按 id 前缀清理（`extreme-`：任务结果、审批、后台运行提醒），不碰应用
 * 其他模块的通知。**队列也要清**：`dismiss` 只处理已占槽的那条，槽位一空
 * 队列里的旧结果就会补上来 —— 用户会看到"关了一条又冒出一条"。
 */
#[tauri::command]
pub fn desktop_notification_clear_extreme(app: tauri::AppHandle) -> Result<(), String> {
    const PREFIX: &str = "extreme-";

    if let Ok(mut pending) = PENDING_PUSH.lock() {
        pending.retain(|payload| !payload.id.starts_with(PREFIX));
    }

    let mut hidden_labels: Vec<String> = Vec::new();
    {
        let mut guard = MANAGER.lock().map_err(|_| "通知状态已损坏".to_string())?;
        let Some(manager) = guard.as_mut() else {
            return Ok(());
        };

        manager
            .queue
            .retain(|payload| !payload.id.starts_with(PREFIX));

        let order = std::mem::take(&mut manager.order);
        for index in order {
            let is_extreme = manager
                .slots
                .get(index)
                .and_then(|slot| slot.notification.as_ref())
                .is_some_and(|payload| payload.id.starts_with(PREFIX));
            if is_extreme {
                let slot = &mut manager.slots[index];
                slot.notification = None;
                slot.height = ESTIMATED_HEIGHT;
                slot.visible = false;
                slot.geometry = None;
                slot.version += 1;
                hidden_labels.push(slot.label.clone());
            } else {
                manager.order.push(index);
            }
        }
    }

    for label in &hidden_labels {
        if let Some(window) = app.get_webview_window(label) {
            let _ = desktop_surface::hide(&window);
        }
        let _ = app.emit_to(label, "desktop-notification:reset", ());
        capture::clear_frame(label);
    }

    let moves = commit(&app)?;
    start_move_animation(&app, moves);
    Ok(())
}
