//! 桌面浮窗（右键菜单 / 通知）共用的原生窗口操作。
//!
//! 这些实现必须只有一份：菜单与通知都是"透明 + 无边框 + 复用"的窗口，
//! 几何提交方式稍有差异就会一个不抖、另一个抖。

use tauri::WebviewWindow;

/// 尺寸 + 位置 + 首次显示，**一次**原生调用提交。
///
/// 之前是 `set_size` 再 `set_position` 两次调用：两次 SetWindowPos 之间会有
/// 一帧"新尺寸 + 旧位置"，靠近屏幕底部/右侧时那一帧就是用户看到的抖动。
/// 这里合并成单个 `SetWindowPos`，并且把 `SWP_SHOWWINDOW` 一并带上，
/// 保证窗口第一次出现在屏幕上时几何已经是最终值（不先显示后翻转）。
#[cfg(target_os = "windows")]
pub(crate) fn set_geometry(
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
            // HWND 属于本应用的复用浮窗；只在该窗口的 UI 线程改几何。
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
pub(crate) fn set_geometry(
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

/// 隐藏复用浮窗。
///
/// 不能用 `hide()`：`set_geometry` 走的是 `ShowWindow(SWP_SHOWWINDOW)`，
/// tao 内部的可见性缓存不会同步，之后再 `hide()` 可能被缓存判定为"已经隐藏"
/// 而什么都不做。这里显式走 `SW_HIDE`，与显示路径对称。
pub(crate) fn hide(window: &WebviewWindow) -> Result<(), String> {
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
                // HWND 属于本应用的复用浮窗；仅在其 UI 线程修改可见性。
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
