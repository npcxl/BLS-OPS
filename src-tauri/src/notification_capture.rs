//! Windows Graphics Capture：给通知窗口持续提供"背后真实画面"。
//!
//! 静态截图只能折射旧画面。这里用 WGC 的 **monitor 采集**持续出帧，按每个
//! 通知窗口的物理矩形裁出各自那块桌面，约 30 FPS 更新到各槽的"最新帧"。
//!
//! # 读回量
//!
//! `frame.buffer()` 会把整屏读回 CPU（1080p 一帧 8 MB）。这里改成
//! [`Frame::buffer_crop`]：先算所有可见通知的**包围矩形**，只复制/读回这一块，
//! 再在 CPU 上分裁到各个槽 —— 三条通知靠得近时一次读回就够，靠得远时包围盒
//! 仍然比整屏小得多。
//!
//! 裁剪与缩放都在帧缓存锁**外**完成，锁只用于最后写入"最新帧"。
//!
//! # 排除通知自身
//!
//! 通知窗口创建时设置了 `WDA_EXCLUDEFROMCAPTURE`，WGC 的帧里不应包含它
//! 自己。若某个窗口裁出来是黑块/重影，前端会因为没有有效帧而退回主题底色。
//!
//! # 生命周期
//!
//! 有可见通知时 [`ensure_started`]；全部关闭后 [`stop`]。显示器换了会重启
//! 会话（只枚举一次显示器、按设备名直接取 `Monitor` 对象）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

/// 目标刷新率（约 30 FPS）。玻璃背后是模糊的，30 FPS 足够让折射跟手。
pub const TARGET_INTERVAL_MS: u64 = 33;

/// 一帧就绪时发给前端的轻量事件（不携带像素）。
pub const FRAME_EVENT: &str = "desktop-notification:frame";

/// 一个槽要裁的区域（全部是物理像素，坐标是虚拟桌面）。
#[derive(Debug, Clone)]
pub struct CaptureTarget {
    pub label: String,
    /// 该槽当前的通知 id：前端按它判断帧是不是属于本条通知。
    pub notification_id: String,
    /// 显示器左上角在虚拟桌面里的坐标：帧内坐标 = 窗口坐标 - 这个原点。
    pub monitor_x: i32,
    pub monitor_y: i32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// 裁剪后缩到这个尺寸（CSS 像素），前端 canvas 直接用它。
    pub out_width: u32,
    pub out_height: u32,
}

/// 一个槽的最新一帧（RGBA）。
#[derive(Debug, Clone)]
pub struct SlotFrame {
    pub seq: u64,
    /// 这一帧是按哪条通知、哪块几何裁的。
    pub notification_id: String,
    pub geometry: (i32, i32, u32, u32),
    pub width: u32,
    pub height: u32,
    pub pixels: Arc<Vec<u8>>,
}

static TARGETS: Mutex<Vec<CaptureTarget>> = Mutex::new(Vec::new());
static RUNNING: AtomicBool = AtomicBool::new(false);
static SEQ: AtomicU64 = AtomicU64::new(1);
/// 会话代数：换显示器/重启时 +1，旧会话在下一帧看到代数不匹配就自己退出。
/// 只靠 `RUNNING` 会有竞态：旧线程还没停、新会话已经置 true，两个会话会同时写帧。
static GENERATION: AtomicU64 = AtomicU64::new(1);
/// 当前采集会话对应的显示器原点 + 缩放；`None` 表示没有会话。
static ACTIVE_MONITOR: Mutex<Option<(i32, i32, f64)>> = Mutex::new(None);
/// 上次启动失败（显示器名 + 时间）。布局更新会频繁调 `ensure_started`，
/// 不冷却会在同一块屏上反复重试、反复刷同一条错误。
static START_FAILED: Mutex<Option<(String, Instant)>> = Mutex::new(None);
/// 启动失败后的冷却时间。
const START_BACKOFF: Duration = Duration::from_secs(5);
/// 有新帧时用来发轻量事件（前端收到后自己拉像素）。
static APP: OnceLock<AppHandle> = OnceLock::new();

fn frames() -> &'static Mutex<HashMap<String, SlotFrame>> {
    static FRAMES: OnceLock<Mutex<HashMap<String, SlotFrame>>> = OnceLock::new();
    FRAMES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn in_backoff(monitor_name: &str) -> bool {
    match START_FAILED.lock() {
        Ok(guard) => guard
            .as_ref()
            .is_some_and(|(name, at)| name == monitor_name && at.elapsed() < START_BACKOFF),
        Err(_) => false,
    }
}

fn mark_failure(monitor_name: &str) {
    if let Ok(mut guard) = START_FAILED.lock() {
        *guard = Some((monitor_name.to_string(), Instant::now()));
    }
}

fn clear_failure() {
    if let Ok(mut guard) = START_FAILED.lock() {
        *guard = None;
    }
}

/// 主窗口启动时注入 AppHandle：采集线程不能自己拿到它，用它发"有新帧"事件。
pub fn set_app_handle(app: AppHandle) {
    let _ = APP.set(app);
}

/// 更新裁剪目标（几何变化、补位、增删通知时调）。
pub fn set_targets(targets: Vec<CaptureTarget>) {
    if let Ok(mut guard) = TARGETS.lock() {
        *guard = targets;
    }
}

/// 该槽的最新帧。前端按帧序号决定要不要画。
pub fn latest_frame(label: &str) -> Option<SlotFrame> {
    frames().lock().ok()?.get(label).cloned()
}

/// 槽被回收时清掉它的帧：避免下一个通知复用上一条的旧画面。
pub fn clear_frame(label: &str) {
    if let Ok(mut store) = frames().lock() {
        store.remove(label);
    }
}

/// 停止采集会话（全部通知关闭、或换显示器前）。
pub fn stop() {
    RUNNING.store(false, Ordering::Relaxed);
    if let Ok(mut active) = ACTIVE_MONITOR.lock() {
        *active = None;
    }
}

/// 确保采集会话跑在指定显示器上；已经在采同一块屏就什么都不做。
///
/// 只枚举一次显示器，**直接使用匹配到的 `Monitor` 对象**：`Monitor::from_index`
/// 用的是另一套索引（不是 enumerate 的顺序），按位置反查会打不开目标显示器
/// （日志里表现为"无法打开显示器 \\.\DISPLAY1（index 0）"）。
pub fn ensure_started(monitor_name: &str, monitor_x: i32, monitor_y: i32, scale: f64) {
    let wanted = (monitor_x, monitor_y, scale);
    if RUNNING.load(Ordering::Relaxed) {
        if let Ok(active) = ACTIVE_MONITOR.lock() {
            if *active == Some(wanted) {
                return;
            }
        }
    }
    // 同一块屏刚失败过：先别再试，让布局更新不要每次都重扫显示器/刷错误。
    if in_backoff(monitor_name) {
        return;
    }

    let monitors = match Monitor::enumerate() {
        Ok(list) if list.is_empty() => {
            eprintln!("[notification-capture] 枚举显示器成功但列表为空");
            mark_failure(monitor_name);
            return;
        }
        Ok(list) => list,
        Err(error) => {
            eprintln!("[notification-capture] 枚举显示器失败：{error}");
            mark_failure(monitor_name);
            return;
        }
    };

    // 名字用来匹配；同时留一份清单，匹配不到时能看出到底有哪些屏。
    let mut available = Vec::with_capacity(monitors.len());
    let mut selected = None;
    for monitor in monitors {
        let name = monitor.device_name().unwrap_or_default();
        available.push(name.clone());
        if name == monitor_name && selected.is_none() {
            selected = Some(monitor);
        }
    }
    let Some(monitor) = selected else {
        eprintln!(
            "[notification-capture] 没有设备名匹配的显示器（目标 {monitor_name:?}，已枚举 {available:?}）"
        );
        mark_failure(monitor_name);
        return;
    };

    stop();
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    RUNNING.store(true, Ordering::Relaxed);
    if let Ok(mut active) = ACTIVE_MONITOR.lock() {
        *active = Some(wanted);
    }

    let name = monitor_name.to_string();
    std::thread::spawn(move || {
        eprintln!("[notification-capture] 启动采集（第 {generation} 代，{name}）");
        let settings = Settings::new(
            monitor,
            // 光标不属于"背景"，而且会在玻璃里来回折射，必须排除。
            CursorCaptureSettings::WithoutCursor,
            // WGC 默认会给被捕获的显示器画一圈黄色边框。
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(Duration::from_millis(TARGET_INTERVAL_MS)),
            DirtyRegionSettings::Default,
            ColorFormat::Rgba8,
            generation,
        );
        match FrameHandler::start(settings) {
            Ok(()) => {
                if GENERATION.load(Ordering::Relaxed) == generation {
                    eprintln!("[notification-capture] 采集会话结束（第 {generation} 代）");
                }
            }
            Err(error) => {
                eprintln!(
                    "[notification-capture] 采集会话启动失败（第 {generation} 代，{name}）：{error}"
                );
                mark_failure(&name);
            }
        }
        // 只清理**自己这一代**的运行状态：新会话可能已经启动，不能把它标停。
        if GENERATION.load(Ordering::Relaxed) == generation {
            RUNNING.store(false, Ordering::Relaxed);
            if let Ok(mut active) = ACTIVE_MONITOR.lock() {
                *active = None;
            }
        }
    });
}

struct FrameHandler {
    /// 帧缓冲复用：每帧都新分配太浪费。
    buffer: Vec<u8>,
    /// 本会话的代数；与全局不一致说明已经被更新的会话取代。
    generation: u64,
    /// 第一帧的时间，用于验证采集链路是否真的出帧。
    first_frame_at: Option<Instant>,
}

impl GraphicsCaptureApiHandler for FrameHandler {
    type Flags = u64;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            buffer: Vec::new(),
            generation: context.flags,
            first_frame_at: None,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if !RUNNING.load(Ordering::Relaxed) || GENERATION.load(Ordering::Relaxed) != self.generation
        {
            capture_control.stop();
            return Ok(());
        }
        if self.first_frame_at.is_none() {
            self.first_frame_at = Some(Instant::now());
            // 真的出帧了才解除冷却：启动成功但永远没有帧的情况仍然算失败。
            clear_failure();
            eprintln!(
                "[notification-capture] 第一帧 {}x{}",
                frame.width(),
                frame.height()
            );
        }

        let targets = match TARGETS.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => return Ok(()),
        };
        if targets.is_empty() {
            return Ok(());
        }

        let frame_width = frame.width();
        let frame_height = frame.height();

        // 所有可见通知的包围矩形（帧内坐标，clamp 到帧内）。
        let mut min_x = frame_width as i32;
        let mut min_y = frame_height as i32;
        let mut max_x = 0i32;
        let mut max_y = 0i32;
        for target in &targets {
            let left = (target.x - target.monitor_x).clamp(0, frame_width as i32);
            let top = (target.y - target.monitor_y).clamp(0, frame_height as i32);
            let right =
                (target.x - target.monitor_x + target.width as i32).clamp(0, frame_width as i32);
            let bottom =
                (target.y - target.monitor_y + target.height as i32).clamp(0, frame_height as i32);
            min_x = min_x.min(left);
            min_y = min_y.min(top);
            max_x = max_x.max(right);
            max_y = max_y.max(bottom);
        }
        if max_x <= min_x || max_y <= min_y {
            return Ok(());
        }

        // 只把这一块从 GPU 读回 CPU：三条通知靠得近时一次就够。
        let cropped = frame.buffer_crop(min_x as u32, min_y as u32, max_x as u32, max_y as u32)?;
        let data = cropped.as_nopadding_buffer(&mut self.buffer);
        dispatch_cropped(
            data,
            (max_x - min_x) as u32,
            (max_y - min_y) as u32,
            min_x,
            min_y,
            &targets,
        );
        Ok(())
    }
}

/// 从包围矩形里分裁每个目标，**锁外**缩放，最后一次性写缓存并通知前端。
fn dispatch_cropped(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    origin_x: i32,
    origin_y: i32,
    targets: &[CaptureTarget],
) {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut produced = Vec::with_capacity(targets.len());

    for target in targets {
        let relative_x = target.x - target.monitor_x - origin_x;
        let relative_y = target.y - target.monitor_y - origin_y;
        let Some(pixels) = crop_scale(
            source,
            source_width,
            source_height,
            relative_x,
            relative_y,
            target.width,
            target.height,
            target.out_width,
            target.out_height,
        ) else {
            continue;
        };
        produced.push((
            target.label.clone(),
            SlotFrame {
                seq,
                notification_id: target.notification_id.clone(),
                geometry: (target.x, target.y, target.width, target.height),
                width: target.out_width,
                height: target.out_height,
                pixels: Arc::new(pixels),
            },
        ));
    }

    if produced.is_empty() {
        return;
    }
    if let Ok(mut store) = frames().lock() {
        for (label, frame) in produced {
            store.insert(label, frame);
        }
    }
    // 轻量通知：像素留在 Rust 侧，前端按 seq 自己拉。
    if let Some(app) = APP.get() {
        let _ = app.emit(FRAME_EVENT, ());
    }
}

/// 从一块 RGBA 里裁一小块，最近邻缩放到 `out_*`。
///
/// 玻璃背后本来就是模糊的，最近邻的质量足够了；采样成本比双线性低一个量级。
#[allow(clippy::too_many_arguments)]
fn crop_scale(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    x: i32,
    y: i32,
    crop_width: u32,
    crop_height: u32,
    out_width: u32,
    out_height: u32,
) -> Option<Vec<u8>> {
    if crop_width == 0 || crop_height == 0 || out_width == 0 || out_height == 0 {
        return None;
    }
    let left = x.max(0) as u32;
    let top = y.max(0) as u32;
    let right = (x.saturating_add(crop_width as i32))
        .min(source_width as i32)
        .max(0) as u32;
    let bottom = (y.saturating_add(crop_height as i32))
        .min(source_height as i32)
        .max(0) as u32;
    if right <= left || bottom <= top {
        return None;
    }

    let span_w = right - left;
    let span_h = bottom - top;
    let source_stride = (source_width * 4) as usize;
    let mut out = vec![0u8; (out_width as usize) * (out_height as usize) * 4];

    for dy in 0..out_height {
        let sy = top + dy * span_h / out_height;
        if sy >= source_height {
            break;
        }
        let source_row = sy as usize * source_stride;
        let out_row = (dy * out_width * 4) as usize;
        for dx in 0..out_width {
            let sx = left + dx * span_w / out_width;
            if sx >= source_width {
                break;
            }
            let si = source_row + sx as usize * 4;
            let di = out_row + (dx * 4) as usize;
            out[di..di + 4].copy_from_slice(&source[si..si + 4]);
        }
    }
    Some(out)
}

/// 验收用：不启动采集，直接给所有可见槽写一张合成图（不同位置的竖线）。
///
/// 用来验证"同一位置换图，纹理更新且玻璃不消失"。调用两次（step 0 / 1）。
pub fn debug_texture(step: u32) {
    // 停掉真实采集：否则下一帧真实画面会立刻覆盖测试图，验收结果不可信。
    // 之后重新推送通知（或重启应用）会通过 `ensure_started` 恢复采集。
    stop();
    let targets = match TARGETS.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return,
    };
    if targets.is_empty() {
        return;
    }
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut store = match frames().lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    for target in targets {
        let pixels = debug_pixels(target.out_width, target.out_height, step);
        store.insert(
            target.label,
            SlotFrame {
                seq,
                notification_id: target.notification_id,
                geometry: (target.x, target.y, target.width, target.height),
                width: target.out_width,
                height: target.out_height,
                pixels: Arc::new(pixels),
            },
        );
    }
}

/// 深色底 + 一条白竖线。step 0 在左 1/4，step 1 在右 3/4。
fn debug_pixels(width: u32, height: u32, step: u32) -> Vec<u8> {
    let mut out = vec![0u8; (width as usize) * (height as usize) * 4];
    let line_x = if step % 2 == 0 {
        width / 4
    } else {
        width * 3 / 4
    };
    let line_width = 6u32;
    for y in 0..height {
        for x in 0..width {
            let index = ((y * width + x) * 4) as usize;
            let on_line = x >= line_x && x < line_x + line_width;
            let (r, g, b) = if on_line {
                (255, 255, 255)
            } else {
                (28, 30, 36)
            };
            out[index] = r;
            out[index + 1] = g;
            out[index + 2] = b;
            out[index + 3] = 255;
        }
    }
    out
}
