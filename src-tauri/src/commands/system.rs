//! 系统集成命令（外部链接等）。

/// 打开外链时优先使用的浏览器。
///
/// 前端只传**名字**，不传可执行文件路径：路径由这里解析，避免把任意程序
/// 交给 `Command` 执行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreferredBrowser {
    /// 系统默认浏览器：`plugin-opener` / `start` / `open` / `xdg-open`。
    System,
    /// Google Chrome。没装或启动失败时回退系统默认浏览器。
    Chrome,
}

impl PreferredBrowser {
    fn parse(value: Option<&str>) -> Self {
        match value
            .map(|item| item.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("chrome") => Self::Chrome,
            _ => Self::System,
        }
    }
}

/// 只放行 http(s)：拒绝 `file:` / `shell:` / 自定义协议，避免把任意字符串
/// 交给系统命令执行。
fn http_url(raw: &str) -> Option<&str> {
    let url = raw.trim();
    (url.starts_with("https://") || url.starts_with("http://")).then_some(url)
}

/// 用指定浏览器打开外部 URL；`browser` 缺省 = 系统默认浏览器。
///
/// 前端优先走 `plugin-opener`；该插件在个别 Windows 环境下会直接失败
/// （更新面板的「前往 GitHub 手动下载」曾出现「打开浏览器失败」），
/// 此时回退到系统命令。
#[tauri::command]
pub fn open_external_url(url: String, browser: Option<String>) -> crate::ops_error::OpsResult<()> {
    use crate::ops_error::OpsError;

    let Some(url) = http_url(&url) else {
        return Err(OpsError::new("config", "only http(s) URLs can be opened"));
    };

    // Chrome 没装 / 启动失败都不报错：外链的底线是"能用默认浏览器打开"。
    if PreferredBrowser::parse(browser.as_deref()) == PreferredBrowser::Chrome
        && open_in_chrome(url)
    {
        return Ok(());
    }

    open_with_system(url).map_err(|error| OpsError::from_stage("local", error).retryable())
}

fn open_with_system(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        // 第一个参数是窗口标题；传空字符串，避免 URL 被当作标题吞掉。
        .args(["/C", "start", "", url])
        .spawn();

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();

    result.map(|_| ())
}

/// Chrome 可执行文件的候选位置。
///
/// Windows 先读注册表 `App Paths`（Chrome 安装器写的标准位置，自定义安装
/// 目录也能覆盖），再退回 `LocalAppData` / `Program Files` 的默认路径。
#[cfg(target_os = "windows")]
fn chrome_candidates() -> Vec<std::path::PathBuf> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};

    const APP_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe";
    const APP_PATH_WOW: &str =
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe";

    let mut found = Vec::new();
    for hive in [CURRENT_USER, LOCAL_MACHINE] {
        for key_path in [APP_PATH, APP_PATH_WOW] {
            if let Ok(exe) = hive.open(key_path).and_then(|key| key.get_string("")) {
                // 个别安装器会把路径写成带引号的形式。
                let exe = exe.trim().trim_matches('"');
                if !exe.is_empty() {
                    found.push(std::path::PathBuf::from(exe));
                }
            }
        }
    }
    for env in ["LocalAppData", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(env) {
            found.push(std::path::Path::new(&root).join(r"Google\Chrome\Application\chrome.exe"));
        }
    }
    found
}

#[cfg(target_os = "windows")]
fn open_in_chrome(url: &str) -> bool {
    chrome_candidates()
        .into_iter()
        .any(|exe| exe.is_file() && std::process::Command::new(exe).arg(url).spawn().is_ok())
}

#[cfg(target_os = "macos")]
fn open_in_chrome(url: &str) -> bool {
    const CHROME: &str = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    std::path::Path::new(CHROME).is_file()
        && std::process::Command::new(CHROME).arg(url).spawn().is_ok()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_chrome(url: &str) -> bool {
    [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
    ]
    .into_iter()
    .any(|exe| std::process::Command::new(exe).arg(url).spawn().is_ok())
}

#[cfg(test)]
mod tests {
    use super::{http_url, PreferredBrowser};

    #[test]
    fn only_http_urls_reach_the_browser() {
        assert_eq!(
            http_url("  https://example.com/a  "),
            Some("https://example.com/a")
        );
        assert_eq!(http_url("http://example.com"), Some("http://example.com"));
        assert_eq!(http_url("file:///etc/passwd"), None);
        assert_eq!(http_url("javascript:alert(1)"), None);
        assert_eq!(http_url(""), None);
    }

    #[test]
    fn browser_preference_defaults_to_the_system_browser() {
        assert_eq!(PreferredBrowser::parse(None), PreferredBrowser::System);
        assert_eq!(
            PreferredBrowser::parse(Some("chrome")),
            PreferredBrowser::Chrome
        );
        assert_eq!(
            PreferredBrowser::parse(Some(" Chrome ")),
            PreferredBrowser::Chrome
        );
        assert_eq!(
            PreferredBrowser::parse(Some("edge")),
            PreferredBrowser::System
        );
    }
}
