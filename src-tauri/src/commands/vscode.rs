//! "Open remote folder in VSCode" (Remote-SSH).
//!
//! The flow: register (or reuse) a marked `Host` block in the user's
//! `~/.ssh/config`, export the server's private key to `~/.ssh/bls-ops/` when
//! the credential is key-based, then spawn `code --remote ssh-remote+<alias>
//! <path>`. VSCode then owns the SSH connection, so the opened folder is the
//! real remote filesystem — live, with no syncing on our side.
//!
//! Design decisions (user-approved 2026-09-08):
//! - Host blocks are appended to `~/.ssh/config` inside
//!   `# bls-ops:begin <alias>` / `# bls-ops:end` markers so they are easy to
//!   inspect and remove by hand.
//! - Private keys leave the keyring only onto disk under `~/.ssh/bls-ops/`
//!   (0600 on unix). They never pass through the WebView.
//! - Servers reached through a ProxyJump are refused: their jump chain and
//!   credentials would also need registration, which is out of scope.
//!
//! Security notes: the remote path must pass `safe::validate_abs_path`
//! (whitelist, no quotes/spaces/control chars), the alias is sanitized, and
//! on Windows the `code` invocation goes through `cmd /C` with `raw_arg`
//! quoting so metacharacters can never split the command line. No remote
//! command strings are built here — nothing touches `safe::Capability`.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::State;

use super::{open_db, record_audit, require_existing_credential};
use crate::safe::validate_abs_path;
use crate::{db, keyring, state::AppState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VscodeOpenResult {
    /// SSH alias registered for this server (also the Remote-SSH label).
    pub alias: String,
    /// Where the Host block lives, shown on success for transparency.
    pub config_path: String,
    /// True when a private key was (re-)written to `~/.ssh/bls-ops/`.
    pub key_exported: bool,
}

// -- Pure helpers (unit-tested below) ----------------------------------------

const BEGIN_PREFIX: &str = "# bls-ops:begin ";
const END_LINE: &str = "# bls-ops:end";

/// Lowercase `[a-z0-9._-]` slug from a server name; empty results become
/// `server`. This is what keeps a user-editable name from injecting
/// arbitrary lines into the ssh config.
pub fn sanitize_alias(name: &str) -> String {
    let slug: String = name
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "server".to_string()
    } else {
        slug
    }
}

/// The full marked block for one host, trailing newline included.
pub fn build_host_block(
    alias: &str,
    host: &str,
    port: i64,
    user: &str,
    identity: Option<&str>,
) -> String {
    let mut block = String::new();
    block.push_str(BEGIN_PREFIX);
    block.push_str(alias);
    block.push('\n');
    block.push_str(&format!("Host {alias}\n"));
    block.push_str(&format!("    HostName {host}\n"));
    block.push_str(&format!("    Port {port}\n"));
    block.push_str(&format!("    User {user}\n"));
    if let Some(path) = identity {
        block.push_str(&format!("    IdentityFile {path}\n"));
        block.push_str("    IdentitiesOnly yes\n");
    }
    block.push_str(END_LINE);
    block.push('\n');
    block
}

/// Byte range of the marked block for `alias`, if present. The trailing
/// newline of the begin marker is part of the match so a same-prefix alias
/// (`bls-ops-a` vs `bls-ops-ab`) can never be confused.
fn block_range(config: &str, alias: &str) -> Option<(usize, usize)> {
    let begin_marker = format!("{BEGIN_PREFIX}{alias}\n");
    let begin = config.find(&begin_marker)?;
    let body_start = begin + begin_marker.len();
    let end_rel = config[body_start..].find(END_LINE)?;
    let end = body_start + end_rel + END_LINE.len();
    Some((begin, end))
}

/// The block body (without markers) for `alias`, if present.
pub fn existing_block(config: &str, alias: &str) -> Option<String> {
    let (start, end) = block_range(config, alias)?;
    Some(config[start..end].to_string())
}

/// True when the existing block for `alias` already points at the same
/// `host:port` as `user`. IdentityFile changes are allowed (re-exported keys
/// and credential switches happen in place).
fn block_matches(block: &str, host: &str, port: i64, user: &str) -> bool {
    let value = |key: &str| -> Option<String> {
        for line in block.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix(key) {
                let rest = rest.trim_start();
                return Some(rest.to_string());
            }
        }
        None
    };
    value("HostName").as_deref() == Some(host)
        && value("Port").map(|p| p.parse::<i64>().ok()) == Some(Some(port))
        && value("User").as_deref() == Some(user)
}

/// Replaces the marked block for `alias` in place, or appends it.
pub fn upsert_block(config: &str, alias: &str, block: &str) -> String {
    match block_range(config, alias) {
        Some((start, end)) => {
            let mut next = String::with_capacity(config.len() + block.len());
            next.push_str(&config[..start]);
            next.push_str(block);
            next.push_str(&config[end..]);
            next
        }
        None => {
            let mut next = String::with_capacity(config.len() + block.len() + 1);
            next.push_str(config);
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            // A blank line keeps the marked section visually separate from
            // whatever the user keeps in this file.
            if !next.is_empty() {
                next.push('\n');
            }
            next.push_str(block);
            next
        }
    }
}

// -- Local filesystem --------------------------------------------------------

fn ssh_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".ssh"))
        .ok_or_else(|| "无法定位用户主目录".to_string())
}

fn config_path() -> Result<PathBuf, String> {
    Ok(ssh_dir()?.join("config"))
}

/// Writes the key to `~/.ssh/bls-ops/<file_name>.pem`, skipping the write when
/// the file already holds identical content. Returns true when bytes changed.
fn export_identity(credential_id: &str, secret_ref: &str) -> Result<bool, String> {
    let key = keyring::read_secret(secret_ref).map_err(|error| format!("读取私钥失败：{error}"))?;
    let dir = ssh_dir()?.join("bls-ops");
    fs::create_dir_all(&dir).map_err(|error| format!("创建 {} 失败：{error}", dir.display()))?;

    let file_name: String = credential_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let file = dir.join(format!("{file_name}.pem"));

    let unchanged = fs::read_to_string(&file).is_ok_and(|existing| existing == key);
    if !unchanged {
        fs::write(&file, &key).map_err(|error| format!("写入 {} 失败：{error}", file.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("收紧 {} 权限失败：{error}", file.display()))?;
    }
    Ok(!unchanged)
}

// -- Launcher ----------------------------------------------------------------

/// Values interpolated into the ssh config (host/user) or the Remote-SSH
/// URI must not be able to inject new lines or quotes.
fn validate_host_value(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{field}不能为空"));
    }
    if value
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '"' | '\''))
    {
        return Err(format!("{field}包含不允许的字符"));
    }
    Ok(())
}

/// Spawns VSCode with Remote-SSH arguments. `code` resolves through the
/// shared editor locator (Code.exe, or code.cmd which must go through
/// `cmd /C`). Arguments are passed with `raw_arg` and wrapped in explicit
/// quotes because cmd's parser does not follow the MSVCRT quoting rules that
/// `std::Command` assumes — an unquoted `&` would split the line. Remote
/// paths and the alias are validated upstream, so quotes cannot reach here.
#[cfg(windows)]
fn launch(alias: &str, remote_path: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let (_, exe) = crate::editor_sync::find_editor("vscode")
        .ok_or_else(|| "未检测到 VSCode，请安装后重试（需 code 命令可用）".to_string())?;
    let remote = format!("ssh-remote+{alias}");
    let quoted = |value: &str| format!("\"{value}\"");
    let lower = exe.to_string_lossy().to_ascii_lowercase();
    let result = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        Command::new("cmd")
            .arg("/C")
            .raw_arg(quoted(&exe.to_string_lossy()))
            .raw_arg("--remote")
            .raw_arg(quoted(&remote))
            .raw_arg(quoted(remote_path))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    } else {
        Command::new(&exe)
            .args(["--remote", &remote, remote_path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    };
    result
        .map(|_| ())
        .map_err(|error| format!("启动 VSCode 失败：{error}"))
}

#[cfg(not(windows))]
fn launch(alias: &str, remote_path: &str) -> Result<(), String> {
    let (_, exe) = crate::editor_sync::find_editor("vscode")
        .ok_or_else(|| "未检测到 VSCode（需要 code 命令可用）".to_string())?;
    Command::new(&exe)
        .args(["--remote", &format!("ssh-remote+{alias}"), remote_path])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动 VSCode 失败：{error}"))
}

// -- Command ------------------------------------------------------------------

/// Registers the server as an ssh config Host (if needed) and opens `path` in
/// VSCode via Remote-SSH. `path` must be an absolute remote directory.
#[tauri::command]
pub fn vscode_open_remote_folder(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
) -> Result<VscodeOpenResult, String> {
    let remote_path = validate_abs_path(&path, "远程路径").map_err(|error| error.to_string())?;

    let conn = open_db(&state)?;
    let server = db::get_server(&conn, &server_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "服务器不存在".to_string())?;
    if server.proxy_jump_id.is_some() {
        return Err("经由跳板机的服务器暂不支持在 VSCode 中打开".to_string());
    }
    validate_host_value(&server.host, "主机地址")?;
    validate_host_value(&server.username, "用户名")?;
    if !(1..=65535).contains(&server.port) {
        return Err("端口超出范围".to_string());
    }

    // Key credentials get an IdentityFile so the connection is passwordless;
    // password credentials fall back to VSCode's own interactive prompt.
    let mut identity = None;
    let mut key_exported = false;
    if let Some(credential_id) = server
        .credential_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
    {
        let credential = require_existing_credential(&conn, credential_id)?;
        if credential.credential_type == "private_key" {
            let secret_ref = credential
                .secret_ref
                .filter(|reference| !reference.trim().is_empty())
                .ok_or_else(|| "私钥凭据缺少密钥内容，请重新保存凭据".to_string())?;
            key_exported = export_identity(credential_id, &secret_ref)?;
            identity = Some(format!(
                "~/.ssh/bls-ops/{}.pem",
                credential_id
                    .chars()
                    .map(
                        |ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                            ch
                        } else {
                            '-'
                        }
                    )
                    .collect::<String>()
            ));
        }
    }

    // Pick an alias: reuse the existing block when it already points at this
    // host:port/user, otherwise find the first free `<slug>`, `<slug>-2`, …
    let config = fs::read_to_string(config_path()?).unwrap_or_default();
    let base = sanitize_alias(&server.name);
    let mut alias = base.clone();
    let mut suffix = 2;
    loop {
        match existing_block(&config, &alias) {
            Some(block) if block_matches(&block, &server.host, server.port, &server.username) => {
                break
            }
            Some(_) => {
                alias = format!("{base}-{suffix}");
                suffix += 1;
            }
            None => break,
        }
    }

    let block = build_host_block(
        &alias,
        &server.host,
        server.port,
        &server.username,
        identity.as_deref(),
    );
    let updated = upsert_block(&config, &alias, &block);
    let config_file = config_path()?;
    fs::write(&config_file, &updated)
        .map_err(|error| format!("写入 {} 失败：{error}", config_file.display()))?;

    launch(&alias, remote_path)?;
    record_audit(
        &state,
        "vscode_open_folder",
        Some(&server.id),
        Some(&server.name),
        &format!("{alias} → {remote_path}"),
    );
    Ok(VscodeOpenResult {
        alias,
        config_path: config_file.display().to_string(),
        key_exported,
    })
}

// -- Tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_aliases() {
        assert_eq!(sanitize_alias("My Server!"), "my-server");
        // Non-ascii collapses to '-', then trims: only "01" survives.
        assert_eq!(sanitize_alias("生产环境/01"), "01");
        assert_eq!(sanitize_alias("生产环境"), "server");
        assert_eq!(sanitize_alias("  "), "server");
        assert_eq!(sanitize_alias("web-1.2"), "web-1.2");
    }

    #[test]
    fn builds_blocks_with_and_without_identity() {
        let with = build_host_block(
            "bls-ops-web",
            "1.2.3.4",
            22,
            "root",
            Some("~/.ssh/bls-ops/cred.pem"),
        );
        assert!(with.starts_with("# bls-ops:begin bls-ops-web\n"));
        assert!(with.contains("    IdentityFile ~/.ssh/bls-ops/cred.pem\n"));
        assert!(with.contains("    IdentitiesOnly yes\n"));
        assert!(with.ends_with("# bls-ops:end\n"));

        let without = build_host_block("b", "h", 2222, "u", None);
        assert!(!without.contains("IdentityFile"));
        assert!(without.contains("    Port 2222\n"));
    }

    #[test]
    fn upsert_appends_then_replaces() {
        let block1 = build_host_block("web", "1.1.1.1", 22, "root", None);
        let config = upsert_block("", "web", &block1);
        assert!(config.contains("HostName 1.1.1.1"));

        // Same alias, changed host → replaced in place, still exactly one block.
        let block2 = build_host_block("web", "2.2.2.2", 22, "root", None);
        let updated = upsert_block(&config, "web", &block2);
        assert_eq!(updated.matches("# bls-ops:begin web\n").count(), 1);
        assert!(updated.contains("HostName 2.2.2.2"));
        assert!(!updated.contains("HostName 1.1.1.1"));
    }

    #[test]
    fn upsert_keeps_other_blocks_and_user_content() {
        let a = build_host_block("a", "1.1.1.1", 22, "root", None);
        let b = build_host_block("ab", "2.2.2.2", 22, "root", None);
        let config = upsert_block("Host my-own\n    HostName 9.9.9.9\n", "a", &a);
        let config = upsert_block(&config, "ab", &b);

        let replaced = build_host_block("a", "3.3.3.3", 22, "root", None);
        let config = upsert_block(&config, "a", &replaced);

        assert!(config.contains("Host my-own"));
        assert!(config.contains("HostName 9.9.9.9"));
        assert!(config.contains("HostName 2.2.2.2"));
        assert!(config.contains("HostName 3.3.3.3"));
        assert!(!config.contains("HostName 1.1.1.1"));
        // Same-prefix alias must not swallow the longer one.
        assert!(existing_block(&config, "ab").is_some());
    }

    #[test]
    fn block_matching_cares_about_endpoint_not_identity() {
        let block = build_host_block("web", "1.2.3.4", 22, "root", Some("~/.ssh/bls-ops/a.pem"));
        assert!(block_matches(&block, "1.2.3.4", 22, "root"));
        assert!(!block_matches(&block, "1.2.3.5", 22, "root"));
        assert!(!block_matches(&block, "1.2.3.4", 2222, "root"));
        assert!(!block_matches(&block, "1.2.3.4", 22, "deploy"));
    }

    #[test]
    fn missing_blocks_are_none() {
        assert!(existing_block("", "web").is_none());
        assert!(existing_block("# bls-ops:begin web\nno end marker", "web").is_none());
    }
}
