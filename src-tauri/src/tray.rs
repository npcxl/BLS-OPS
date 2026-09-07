//! 系统托盘 —— 主窗口点 X **不退出**，而是隐藏到这里（用户裁决，勿回退）。
//!
//! 职责只有一个：给「关窗 = 藏进托盘」一条可见的回家路径：
//! - 左键单击托盘图标 → 恢复主窗口；
//! - 右键菜单 → 显示主窗口 / 退出（只有"退出"才真正结束进程，SSH 会话
//!   跟着断开 —— 这是退出语义，不再弹确认）。
//!
//! 关闭拦截在 `lib.rs` 的 `on_window_event`（CloseRequested → hide）。
//! 菜单文案由前端按当前语言下发（`tray_set_labels` 命令），语言切换时
//! 前端监听 `languageChanged` 重发 —— Rust 侧不做 i18n。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

const TRAY_ID: &str = "bls-ops-tray";
const MAIN_WINDOW: &str = "main";

/// 创建托盘。菜单文案先用英文兜底（前端就绪后立刻经 `set_labels` 覆盖成
/// 当前语言）。没有可用图标就不建托盘，绝不能因此挡住应用启动。
pub fn init(app: &tauri::App) -> tauri::Result<()> {
    let Some(icon) = app.default_window_icon().cloned() else {
        eprintln!("[tray] no default window icon; tray disabled");
        return Ok(());
    };
    let menu = build_menu(app.handle(), "Show window", "Quit")?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Ops Workbench")
        .menu(&menu)
        // 左键留给"恢复窗口"（最常用路径），右键才弹菜单。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 前端语言切换时更新菜单文案（见 `commands/app.rs::tray_set_labels`）。
pub fn set_labels<R: Runtime>(app: &AppHandle<R>, show: &str, quit: &str) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(()); // 托盘未创建（无图标/平台不支持）→ 无事可做。
    };
    let menu = build_menu(app, show, quit)?;
    let _ = tray.set_menu(Some(menu));
    Ok(())
}

/// 恢复并聚焦主窗口（托盘单击 / 菜单共用）。
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, show: &str, quit: &str) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "show", show, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}
