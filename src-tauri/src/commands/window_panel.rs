//! 打开右栏时**向外扩宽窗口**（普通窗口），而不是压缩聊天区。
//!
//! 规则：
//! * 最大化 / 全屏 → 不动外框（里面分栏）；
//! * 显示器右侧没有足够空间 → 不扩（里面分栏 / 覆盖）；
//! * 只扩"右栏宽度"这一次，标签切换不会重复扩；
//! * 收起时**只撤回自己加的那一段**，用户中途手动拉过窗口就尊重用户的尺寸。

use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::ops_error::OpsResult;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WidenOutcome {
    /// 这次是否真的改了窗口尺寸。
    pub widened: bool,
    /// 增加 / 撤回的宽度（逻辑像素，正数）。
    pub added: f64,
    /// 为什么没扩（界面可据此决定是否内部分栏）。
    pub reason: Option<String>,
}

/// 纯计算：返回扩宽后的 `(x, y, w, h)`（逻辑像素）。
///
/// 输入输出都用逻辑像素，缩放比在调用方处理 —— 纯函数好测，也不会把
/// `dpi` 混进业务判断里。
#[allow(clippy::too_many_arguments)]
pub fn plan_widen(
    pos: (f64, f64),
    size: (f64, f64),
    monitor_pos: (f64, f64),
    monitor_size: (f64, f64),
    panel_width: f64,
) -> Option<(f64, f64, f64, f64)> {
    // 显示器右侧还剩多少可用宽度。
    let right = monitor_pos.0 + monitor_size.0;
    let available = right - (pos.0 + size.0);
    // 留 8px 边距，别贴着屏幕边缘。
    let add = panel_width.min(available - 8.0);
    if add < 40.0 {
        return None;
    }
    let width = size.0 + add;
    // 高度不能越出显示器底部。
    let bottom = monitor_pos.1 + monitor_size.1;
    let height = size.1.min(bottom - pos.1).max(320.0);
    Some((pos.0, pos.1, width, height))
}

/// 外拖的目标宽度：右侧留 8px，且不越出工作区。
///
/// 正常拖拽只允许外扩；取消 / 收起回收时传 `allow_shrink = true`。
pub fn plan_resize(
    current: f64,
    desired: f64,
    left: f64,
    work_right: f64,
    allow_shrink: bool,
) -> Option<f64> {
    let max_width = (work_right - left - 8.0).max(current);
    let min_width = if allow_shrink { 320.0 } else { current };
    let target = desired.clamp(min_width, max_width);
    if (target - current).abs() < 1.0 {
        None
    } else {
        Some(target)
    }
}

/// 最近一次由面板自动增加的宽度（逻辑像素）与加完之后的窗口宽度。
static AUTO: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// 打开 / 收起右栏时调整外框。
#[tauri::command]
pub fn extreme_panel_widen(
    window: WebviewWindow,
    panel_width: f64,
    open: bool,
) -> OpsResult<WidenOutcome> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let outer = window
        .outer_position()
        .unwrap_or(PhysicalPosition::new(0, 0));
    let inner = window
        .inner_size()
        .or_else(|_| window.outer_size())
        .unwrap_or(PhysicalSize::new(1200, 800));
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return Ok(WidenOutcome {
            widened: false,
            added: 0.0,
            reason: Some("没有可用的显示器信息".to_string()),
        });
    };

    // 统一换算成逻辑像素。
    let pos = (
        (outer.x as f64 - monitor.position().x as f64) / scale,
        (outer.y as f64 - monitor.position().y as f64) / scale,
    );
    let size = (inner.width as f64 / scale, inner.height as f64 / scale);
    let monitor_size = (
        monitor.size().width as f64 / scale,
        monitor.size().height as f64 / scale,
    );

    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);

    if !open {
        let recorded = AUTO.lock().ok().and_then(|mut slot| slot.take());
        let Some((added, expected_width)) = recorded else {
            return Ok(WidenOutcome {
                widened: false,
                added: 0.0,
                reason: None,
            });
        };
        // 用户中途拉过窗口：现在的宽度和"加完之后的宽度"对不上，就别动。
        if (size.0 - expected_width).abs() > 2.0 {
            return Ok(WidenOutcome {
                widened: false,
                added: 0.0,
                reason: Some("窗口已被手动调整，保留当前尺寸".to_string()),
            });
        }
        set_logical_size(&window, size.0 - added, size.1, scale);
        return Ok(WidenOutcome {
            widened: true,
            added,
            reason: None,
        });
    }

    if maximized || fullscreen {
        return Ok(WidenOutcome {
            widened: false,
            added: 0.0,
            reason: Some("最大化 / 全屏：内部按分栏显示".to_string()),
        });
    }

    // 已经扩过一次（标签切换）：不重复扩。
    if AUTO.lock().map(|slot| slot.is_some()).unwrap_or(false) {
        return Ok(WidenOutcome {
            widened: false,
            added: 0.0,
            reason: Some("已经扩宽过".to_string()),
        });
    }

    let Some((_x, _y, width, height)) =
        plan_widen(pos, size, (0.0, 0.0), monitor_size, panel_width)
    else {
        return Ok(WidenOutcome {
            widened: false,
            added: 0.0,
            reason: Some("显示器右侧空间不足：内部按分栏显示".to_string()),
        });
    };

    set_logical_size(&window, width, height, scale);
    let added = width - size.0;
    if let Ok(mut slot) = AUTO.lock() {
        *slot = Some((added, width));
    }
    Ok(WidenOutcome {
        widened: true,
        added,
        reason: None,
    })
}

fn set_logical_size(window: &WebviewWindow, width: f64, height: f64, scale: f64) {
    let _ = window.set_size(PhysicalSize::new(
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    ));
}

/**
 * 右栏外缘拖动：把窗口右侧拉到鼠标位置。
 *
 * `width` 是**目标客户区宽度**（逻辑像素），不是增量 —— 每帧都用拖拽开始时的
 * 基准算绝对目标，避免 pointermove 重复调用时把宽度越加越大。左边缘、垂直
 * 位置与高度保持不变；只受当前显示器**工作区**右侧限制（任务栏也算）。
 */
#[tauri::command]
pub fn extreme_panel_resize(
    window: WebviewWindow,
    width: f64,
    allow_shrink: Option<bool>,
) -> OpsResult<WidenOutcome> {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return Ok(WidenOutcome {
            widened: false,
            added: 0.0,
            reason: Some("最大化 / 全屏：内部按分栏显示".to_string()),
        });
    }

    let scale = window.scale_factor().unwrap_or(1.0);
    let outer = window
        .outer_position()
        .unwrap_or(PhysicalPosition::new(0, 0));
    let inner = window
        .inner_size()
        .or_else(|_| window.outer_size())
        .unwrap_or(PhysicalSize::new(1200, 800));
    let Some(monitor) = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
    else {
        return Ok(WidenOutcome {
            widened: false,
            added: 0.0,
            reason: Some("没有可用的显示器信息".to_string()),
        });
    };

    let work = monitor.work_area();
    let work_right = (work.position.x as f64 + work.size.width as f64) / scale;
    let work_bottom = (work.position.y as f64 + work.size.height as f64) / scale;
    let left = outer.x as f64 / scale;
    let top = outer.y as f64 / scale;
    let current = inner.width as f64 / scale;
    let height = inner.height as f64 / scale;

    // 留 8px，别贴着工作区边缘；宽度不能小于当前（这个手柄只负责外扩）。
    let Some(target) = plan_resize(
        current,
        width,
        left,
        work_right,
        allow_shrink.unwrap_or(false),
    ) else {
        return Ok(WidenOutcome {
            widened: false,
            added: 0.0,
            reason: Some("显示器右侧空间不足：内部按分栏显示".to_string()),
        });
    };
    let added = target - current;

    let next_height = height.min(work_bottom - top).max(320.0);
    set_logical_size(&window, target, next_height, scale);
    Ok(WidenOutcome {
        widened: true,
        added,
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{plan_resize, plan_widen};

    #[test]
    fn widens_when_there_is_room_on_the_right() {
        let plan = plan_widen(
            (0.0, 0.0),
            (1200.0, 800.0),
            (0.0, 0.0),
            (2560.0, 1440.0),
            340.0,
        );
        let (_, _, width, height) = plan.expect("should widen");
        assert_eq!(width, 1540.0);
        assert_eq!(height, 800.0);
    }

    #[test]
    fn does_not_widen_when_the_window_touches_the_right_edge() {
        // 右边只剩 30px：放不下右栏，交给内部分栏。
        assert!(plan_widen(
            (1360.0, 0.0),
            (1200.0, 800.0),
            (0.0, 0.0),
            (2560.0, 1440.0),
            340.0
        )
        .is_none());
    }

    #[test]
    fn outer_resize_uses_absolute_target_and_keeps_left_edge() {
        // 拖到 1600：工作区右侧 1920，左边缘 100 → 上限 1812。
        assert_eq!(
            plan_resize(1200.0, 1600.0, 100.0, 1920.0, false),
            Some(1600.0)
        );
        // 超过工作区：夹到 1812，不会把窗口推到屏幕外。
        assert_eq!(
            plan_resize(1200.0, 3000.0, 100.0, 1920.0, false),
            Some(1812.0)
        );
        // 没有空间：返回 None，调用方退回内部拖拽。
        assert_eq!(plan_resize(1200.0, 1500.0, 1400.0, 1920.0, false), None);
        // 正常拖拽不能缩窗口；取消 / 收起回收时允许。
        assert_eq!(plan_resize(1200.0, 900.0, 100.0, 1920.0, false), None);
        assert_eq!(plan_resize(1200.0, 900.0, 100.0, 1920.0, true), Some(900.0));
    }

    #[test]
    fn partial_room_is_used_but_keeps_a_margin() {
        let plan = plan_widen(
            (600.0, 100.0),
            (1200.0, 800.0),
            (0.0, 0.0),
            (2400.0, 1400.0),
            340.0,
        );
        let (_, _, width, _) = plan.expect("should widen a bit");
        // 右侧可用 600px → 加 340（够），仍留 8px 边距的余量。
        assert!((width - 1540.0).abs() < f64::EPSILON);
        // 高度不越出显示器底部。
        let (_, _, _, height) = plan.unwrap();
        assert!(100.0 + height <= 1400.0);
    }
}
