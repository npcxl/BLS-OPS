//! Validators and the shell quoter — rule 2 and rule 3 of the security
//! boundary (see the module docs in `mod.rs`).
//!
//! Everything the user can influence is checked here before it can reach a
//! command template.

use anyhow::{anyhow, Result};

// -- Character classes -------------------------------------------------------

/// Characters allowed in any identifier we interpolate into a command.
///
/// Deliberately excludes quotes, backslashes, `$`, backticks, whitespace,
/// `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}` and newlines: none of the
/// values we accept legitimately need them.
fn is_safe_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(
            ch,
            '.' | '-' | '_' | '/' | ':' | '@' | '+' | '=' | ',' | '~' | '*' | '#' | '%'
        )
}

/// Rejects empty values, over-long ones, control characters and anything
/// outside [`is_safe_char`].
pub(crate) fn validate_token<'a>(value: &'a str, field: &str, max_len: usize) -> Result<&'a str> {
    if value.is_empty() {
        return Err(anyhow!("{field}不能为空"));
    }
    if value.len() > max_len {
        return Err(anyhow!("{field}过长（最多 {max_len} 个字符）"));
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err(anyhow!("{field}不能包含控制字符"));
    }
    if let Some(ch) = value.chars().find(|ch| !is_safe_char(*ch)) {
        return Err(anyhow!("{field}包含不允许的字符：{ch:?}"));
    }
    Ok(value)
}

/// Wraps a value in single quotes so the remote shell treats it as one literal
/// argument. Embedded single quotes are escaped the POSIX way.
pub fn shell_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

// -- Path validation ---------------------------------------------------------

/// Splits an absolute path into its segments, so `..` can be caught as a
/// segment rather than a substring (which would reject `..foo`).
fn segments(path: &str) -> Vec<&str> {
    path.split('/').filter(|part| !part.is_empty()).collect()
}

/// Validates an absolute path: must start at `/`, must not contain `.` or `..`
/// segments, and must not contain characters outside the safe set.
pub fn validate_abs_path<'a>(value: &'a str, field: &str) -> Result<&'a str> {
    if !value.starts_with('/') {
        return Err(anyhow!("{field}必须是绝对路径"));
    }
    if value.contains('\0') {
        return Err(anyhow!("{field}不能包含空字符"));
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err(anyhow!("{field}不能包含控制字符"));
    }
    if segments(value)
        .iter()
        .any(|part| *part == "." || *part == "..")
    {
        return Err(anyhow!("{field}不能包含相对路径段（. 或 ..）"));
    }
    // Spaces are legal in paths but are the classic injection carrier, so only
    // the characters we actually need are permitted.
    if value
        .chars()
        .any(|ch| !ch.is_ascii_alphanumeric() && !matches!(ch, '/' | '.' | '-' | '_' | '~' | '+'))
    {
        return Err(anyhow!("{field}包含不允许的字符"));
    }
    Ok(value)
}

/// True when `path` is `root` itself or lives underneath it.
///
/// Used to keep destructive commands (deployment steps, config writes) inside
/// the directory the project declared.
pub fn is_within(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    if path == root {
        return true;
    }
    path.starts_with(&format!("{root}/"))
}

/// Validates the directory list for the targeted marker scan.
///
/// Every path comes from remote instance output (Docker mounts, systemd unit
/// properties, nginx roots), so it is treated as untrusted input: absolute,
/// no control characters, no `.`/`..` segments, character whitelist as
/// [`validate_abs_path`], and bounded in count and length. Duplicates are
/// collapsed so one `find` invocation covers them.
pub fn validate_remote_paths(values: &[String]) -> Result<Vec<String>> {
    if values.is_empty() {
        return Err(anyhow!("扫描路径列表不能为空"));
    }
    if values.len() > 64 {
        return Err(anyhow!("单次扫描路径过多（最多 64 个）"));
    }
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let path = validate_abs_path(value, "扫描路径")?;
        if path.matches('/').count() > 64 {
            return Err(anyhow!("扫描路径过深：{value}"));
        }
        if !out.iter().any(|existing| existing == path) {
            out.push(path.to_string());
        }
    }
    Ok(out)
}

// -- Specific identifiers ----------------------------------------------------

/// systemd unit types we allow acting on.
const UNIT_SUFFIXES: &[&str] = &[
    ".service",
    ".socket",
    ".timer",
    ".target",
    ".mount",
    ".path",
    ".slice",
    ".scope",
    ".device",
    ".swap",
    ".automount",
    ".snapshot",
];

/// Validates a systemd unit name: safe characters plus a known unit suffix.
pub fn validate_unit(value: &str) -> Result<&str> {
    let unit = validate_token(value, "服务单元名", 256)?;
    let lower = unit.to_ascii_lowercase();
    if !UNIT_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix)) {
        return Err(anyhow!(
            "服务单元名必须以有效的单元类型结尾（如 .service、.timer）：{value}"
        ));
    }
    Ok(unit)
}

/// Validates a Docker container id or name.
pub fn validate_container(value: &str) -> Result<&str> {
    let container = validate_token(value, "容器标识", 128)?;
    if container.starts_with('-') {
        return Err(anyhow!("容器标识不能以 - 开头（避免被当作选项）"));
    }
    Ok(container)
}

/// Validates a Docker image reference, including an optional registry host,
/// tag and `sha256:` digest.
pub fn validate_image(value: &str) -> Result<&str> {
    let image = validate_token(value, "镜像名", 256)?;
    if image.starts_with('-') {
        return Err(anyhow!("镜像名不能以 - 开头"));
    }
    // A digest carries a colon; a plain tag carries at most one. Reject the
    // rest so a stray colon cannot smuggle in a second argument.
    if !image.contains('@') && image.matches(':').count() > 1 {
        return Err(anyhow!("镜像名格式不正确：{value}"));
    }
    Ok(image)
}

/// Validates an Nginx site name — a plain filename, never a path.
pub fn validate_site_name(value: &str) -> Result<&str> {
    let site = validate_token(value, "站点名", 128)?;
    if site.contains('/') {
        return Err(anyhow!("站点名不能包含路径分隔符"));
    }
    if site == "." || site == ".." {
        return Err(anyhow!("站点名无效"));
    }
    Ok(site)
}

/// Validates a tail/head line count.
pub fn validate_lines(value: u32) -> Result<u32> {
    if (1..=10_000).contains(&value) {
        Ok(value)
    } else {
        Err(anyhow!("行数必须在 1 到 10000 之间"))
    }
}

/// A git ref: branch, tag or short SHA. Rejects the leading dash and the
/// characters git itself treats specially.
pub fn validate_git_ref(value: &str) -> Result<&str> {
    let reference = validate_token(value, "Git 引用", 256)?;
    if reference.starts_with('-') {
        return Err(anyhow!("Git 引用不能以 - 开头"));
    }
    if reference.contains("..") {
        return Err(anyhow!("Git 引用不能包含 .."));
    }
    Ok(reference)
}

/// A clone URL: `https://`, `ssh://`, `git@host:` or a bare `host:path`.
pub fn validate_repo_url(value: &str) -> Result<&str> {
    let url = validate_token(value, "仓库地址", 512)?;
    let accepted = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("ssh://")
        || url.starts_with("git@")
        || url.starts_with("git://");
    if accepted {
        Ok(url)
    } else {
        Err(anyhow!(
            "仓库地址必须以 https://、http://、ssh://、git:// 或 git@ 开头"
        ))
    }
}

// -- Hostnames, e-mail, URLs, file modes (P5.3 / P5.4) -----------------------
//
// 这几个判定同时被"命令构造"（`capability.rs`）与"动作校验"
// （`deployment::action::validate`）使用。**必须只有一份实现**：两处各写一遍
// 规则，迟早会出现"动作校验放行、命令构造拒绝"（或反过来）的裂缝。

/// 主机名 / 域名：`example.com`、`api.example.com`、`*.example.com`。
///
/// 泛域名只允许 `*.` 打头 —— `a.*.b` 在任何 CA 那里都不合法，与其让 certbot
/// 报错，不如在这里挡住。
pub fn validate_hostname<'a>(value: &'a str, field: &str) -> Result<&'a str> {
    let host = validate_token(value, field, 253)?;
    if host.starts_with('.') || host.ends_with('.') || host.contains("..") {
        return Err(anyhow!("{field}格式不正确：{value}"));
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return Err(anyhow!("{field}至少需要两段（例如 example.com）"));
    }
    for (position, label) in labels.iter().enumerate() {
        if *label == "*" {
            if position != 0 {
                return Err(anyhow!("{field}的通配符只能出现在最左侧"));
            }
            continue;
        }
        if label.is_empty() || label.len() > 63 {
            return Err(anyhow!("{field}的每一段长度必须在 1 到 63 之间"));
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err(anyhow!("{field}的每一段不能以 - 开头或结尾"));
        }
    }
    Ok(host)
}

/// HTTP(S) URL：`http://` / `https://` + 主机 + 可选路径。
///
/// **不接受查询串与片段** —— 它们会把 `&`、`?` 之类字符带进命令文本。
pub fn validate_http_url<'a>(value: &'a str) -> Result<&'a str> {
    let url = validate_token(value, "健康检查地址", 512)?;
    let rest = match url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        Some(rest) => rest,
        None => return Err(anyhow!("健康检查地址必须以 http:// 或 https:// 开头")),
    };
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() {
        return Err(anyhow!("健康检查地址缺少主机名"));
    }
    let host = authority.split(':').next().unwrap_or("");
    if host.parse::<std::net::IpAddr>().is_err() {
        validate_hostname(host, "健康检查主机")?;
    }
    Ok(url)
}

/// 邮箱（certbot 注册用）。
pub fn validate_email<'a>(value: &'a str) -> Result<&'a str> {
    let email = validate_token(value, "邮箱", 254)?;
    let (local, domain) = match email.split_once('@') {
        Some(parts) => parts,
        None => return Err(anyhow!("邮箱格式不正确：{value}")),
    };
    if local.is_empty() || domain.contains('@') {
        return Err(anyhow!("邮箱格式不正确：{value}"));
    }
    validate_hostname(domain, "邮箱域名")?;
    Ok(email)
}

/// 文件权限位：只允许这几档常见值。写含密钥的配置文件时**不允许** 777。
pub fn validate_octal_mode(mode: u32) -> Result<String> {
    if matches!(mode, 0o600 | 0o640 | 0o644 | 0o700 | 0o750 | 0o755) {
        Ok(format!("{mode:o}"))
    } else {
        Err(anyhow!("文件权限只允许 600 / 640 / 644 / 700 / 750 / 755"))
    }
}

/// 端口：1–65535（0 不是可绑定的端口，直接拒绝）。
pub fn validate_port(port: u16) -> Result<u16> {
    if port == 0 {
        Err(anyhow!("端口必须在 1 到 65535 之间"))
    } else {
        Ok(port)
    }
}

/// certbot 的证书名：一个文件名（不带路径）。
pub fn validate_cert_name<'a>(value: &'a str) -> Result<&'a str> {
    let name = validate_container(value)?;
    if name.contains('/') || name == "." || name == ".." {
        return Err(anyhow!("证书名不能包含路径分隔符"));
    }
    Ok(name)
}
