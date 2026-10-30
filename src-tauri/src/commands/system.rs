//! 系统集成命令（外部链接等）。

/// 用系统默认浏览器打开外部 URL。
///
/// 前端优先走 `plugin-opener`；该插件在个别 Windows 环境下会直接失败
/// （更新面板的「前往 GitHub 手动下载」曾出现「打开浏览器失败」），
/// 此时回退到系统命令：
///   - Windows: `cmd /C start "" <url>`
///   - macOS:   `open <url>`
///   - Linux:   `xdg-open <url>`
///
/// **只接受 http(s)**：拒绝 `file:` / `shell:` / 自定义协议，避免把任意
/// 字符串交给系统命令执行。
#[tauri::command]
pub fn open_external_url(url: String) -> crate::ops_error::OpsResult<()> {
    use crate::ops_error::OpsError;

    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(OpsError::new("config", "only http(s) URLs can be opened"));
    }

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        // 第一个参数是窗口标题；传空字符串，避免 URL 被当作标题吞掉。
        .args(["/C", "start", "", url])
        .spawn();

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();

    result
        .map(|_| ())
        .map_err(|error| OpsError::from_stage("local", error).retryable())
}
