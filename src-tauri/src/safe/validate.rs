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
fn validate_token<'a>(value: &'a str, field: &str, max_len: usize) -> Result<&'a str> {
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
