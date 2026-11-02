//! 原生窗口材质与主题同步。
//!
//! 为什么必须在这一层做：CSS 的 `backdrop-filter` 只能模糊 WebView **内部**的内容，
//! 模糊不了窗口背后的桌面；真正的磨砂只能交给 DWM（Acrylic / Mica）。
//!
//! 这里负责三件事，且只有这三件：
//! 1. 把网页主题（light / dark）同步到原生窗口（标题栏、系统菜单、Win11 材质色调）；
//! 2. 按主题给出 Acrylic 的染色（Win10 的 SWCA 路径会用它；Win11 由系统材质决定，
//!    剩下的染色交给 CSS 的 `--shell` alpha）；
//! 3. 材质不可用时**显式清掉**效果并回报 `solid`，让 CSS 走实色回退 ——
//!    不能只"设置失败就算了"，残留的模糊会盖住纯色背景，出现半灰不白的脏表面。
//!
//! `WebviewWindow::set_effects` 内部的错误是被吞掉的（它只是投递到主线程），
//! 所以支持性必须自己判断，不能依赖返回值。

use serde::Serialize;
use tauri::{Theme, WebviewWindow};

/// 前端据 `material` 决定外壳是半透明还是实色（`[data-material="solid"]`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaterial {
    /// "acrylic" | "solid"
    pub material: &'static str,
    /// "light" | "dark"
    pub theme: &'static str,
    /// 回退原因键：user_disabled / system_transparency_off / os_unsupported /
    /// platform_unsupported；成功时为 None。
    pub reason: Option<&'static str>,
    /// Windows 内部版本号；其它平台为 0（仅用于诊断与日志）。
    pub os_build: u32,
    /// 本次实际请求的透明效果开关。
    pub transparency: bool,
}

fn normalize_theme(theme: &str) -> &'static str {
    if theme == "dark" {
        "dark"
    } else {
        "light"
    }
}

/// 应用窗口材质。幂等：重复调用只是重设一次属性。
pub fn apply(window: &WebviewWindow, theme: &str, transparency: bool) -> WindowMaterial {
    let theme = normalize_theme(theme);
    let dark = theme == "dark";

    // 先同步原生主题：标题栏、滚动条、右键菜单、以及 Win11 的材质底色都看它。
    let _ = window.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }));

    #[cfg(target_os = "windows")]
    {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::{Color, Effect, EffectState, EffectsBuilder};

        let (supported, reason, os_build) = windows_support();

        if supported && transparency {
            // 亮色：浅灰白染色（不是纯白 —— 纯白会把磨砂糊成一张纸）。
            // 暗色：近黑的蓝灰，与 `--shell` 的暗色值同源。
            let tint = if dark {
                Color(18, 20, 26, 205)
            } else {
                Color(247, 249, 252, 195)
            };
            let _ = window.set_effects(
                EffectsBuilder::new()
                    .effect(Effect::Acrylic)
                    .state(EffectState::Active)
                    .color(tint)
                    .build(),
            );
            return WindowMaterial {
                material: "acrylic",
                theme,
                reason: None,
                os_build,
                transparency,
            };
        }

        // 实色回退：必须显式清空，否则旧的 Acrylic 还在，实色背景会被它拖灰。
        let _ = window.set_effects(None::<WindowEffectsConfig>);
        return WindowMaterial {
            material: "solid",
            theme,
            reason: if !transparency {
                Some("user_disabled")
            } else {
                reason
            },
            os_build,
            transparency,
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        // macOS / Linux：不伪造磨砂，直接实色，避免"看起来像有材质其实没有"。
        WindowMaterial {
            material: "solid",
            theme,
            reason: Some("platform_unsupported"),
            os_build: 0,
            transparency: false,
        }
    }
}

/// 当前系统是否真的能给出磨砂。
///
/// * Windows 10 1809（build 17763）以下没有可用的 Acrylic 路径；
/// * 系统"透明效果"被关闭时 DWM 会把 Acrylic 退化成纯色 —— 这时我们主动回退，
///   而不是留一个半透明的窗口让文字压在壁纸上。
#[cfg(target_os = "windows")]
fn windows_support() -> (bool, Option<&'static str>, u32) {
    let build = windows_version::OsVersion::current().build;
    if build < 17763 {
        return (false, Some("os_unsupported"), build);
    }
    if !system_transparency_enabled() {
        return (false, Some("system_transparency_off"), build);
    }
    (true, None, build)
}

/// `HKCU\...\Themes\Personalize\EnableTransparency`。
/// 读不到（老系统 / 被策略移除）时按"开启"处理，跟随 DWM 的默认行为。
#[cfg(target_os = "windows")]
fn system_transparency_enabled() -> bool {
    use windows_registry::CURRENT_USER;

    let path = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    match CURRENT_USER.open(path) {
        Ok(key) => match key.get_u32("EnableTransparency") {
            Ok(value) => value != 0,
            Err(_) => true,
        },
        Err(_) => true,
    }
}

/// 前端切换 light / dark / system 时调用；也用于首次挂载时的纠正。
///
/// 同步命令（不 `async`）：它只做几次窗口属性设置，并且 `set_theme` 本身
/// 会把工作投递到主线程 —— 在命令线程里 await 没有意义。
#[tauri::command]
pub fn app_window_material(
    window: WebviewWindow,
    theme: String,
    transparency: bool,
) -> WindowMaterial {
    apply(&window, &theme, transparency)
}

#[cfg(test)]
mod tests {
    use super::normalize_theme;

    #[test]
    fn theme_names_are_normalized() {
        assert_eq!(normalize_theme("dark"), "dark");
        assert_eq!(normalize_theme("light"), "light");
        // 未知值一律落到亮色：这是应用的默认视觉语言，猜错也不会看不清。
        assert_eq!(normalize_theme("system"), "light");
        assert_eq!(normalize_theme(""), "light");
    }
}
