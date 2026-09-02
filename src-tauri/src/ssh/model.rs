//! Core SSH data model: timeouts, exec results, remote file entries, host
//! keys and connect targets.

use std::time::Duration;

use serde::Serialize;

/// How often an idle session sends a keepalive probe; also drives russh's
/// `keepalive_max` disconnect detection.
pub const DEFAULT_KEEPALIVE_SECS: u64 = 30;

/// Hard budget for one non-interactive command. Monitoring must never be able
/// to hang a tab, so a command that has not finished by then is abandoned and
/// its channel closed.
pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

/// The SFTP subsystem is requested on its own channel over the same
/// connection, so the shell and the file browser never block each other.
pub const SFTP_SUBSYSTEM: &str = "sftp";

pub const KIND_DIRECTORY: &str = "directory";
pub const KIND_FILE: &str = "file";
pub const KIND_SYMLINK: &str = "symlink";
pub const KIND_OTHER: &str = "other";

/// Result of one non-interactive command run over a short-lived exec channel.
#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    /// `None` when the server never reported an exit status.
    pub exit_code: Option<u32>,
}

/// One remote file entry reported over SFTP.
///
/// Paths are remote POSIX paths (string only — never `PathBuf`, which would
/// apply the local OS's rules; on Windows that would be backslashes).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: Option<i64>,
    /// `rwxr-xr-x` style, as reported by the server.
    pub permissions: Option<String>,
    pub hidden: bool,
}

/// Payload of `sftp_read_file`: a text file's content, or a binary marker.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteFileContent {
    /// Canonical path the content was read from.
    pub path: String,
    pub size: u64,
    /// True when the content is not valid UTF-8 text (image, archive, …).
    pub binary: bool,
    /// UTF-8 content, `None` when `binary` is true.
    pub content: Option<String>,
}

/// Host key observed during the SSH handshake.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HostKeyInfo {
    pub fingerprint: String,
    pub key_type: String,
}

/// The endpoint that presented a host key.
///
/// With ProxyJump this is the **jump host**, not the final destination. Keeping
/// the two apart is the whole point: trusting a jump host's key under the
/// target's address would either poison the wrong record or loop forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Endpoint<'a> {
    pub host: &'a str,
    pub port: u16,
}

impl Endpoint<'_> {
    pub fn label(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// Result of a connect attempt.
///
/// Host-key problems are returned as *data*, never as a silent success: the
/// caller must show them to the user and only reconnect once the key is
/// trusted. `challenge_*` is the endpoint to save the fingerprint under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectOutcome {
    Connected {
        host_key: HostKeyInfo,
    },
    HostKeyUnknown {
        host_key: HostKeyInfo,
        challenge_host: String,
        challenge_port: u16,
    },
    HostKeyChanged {
        host_key: HostKeyInfo,
        known_fingerprint: String,
        challenge_host: String,
        challenge_port: u16,
    },
}

impl ConnectOutcome {
    /// `host:port` of the endpoint the user still has to trust.
    pub fn challenge_label(&self) -> Option<String> {
        match self {
            ConnectOutcome::Connected { .. } => None,
            ConnectOutcome::HostKeyUnknown {
                challenge_host,
                challenge_port,
                ..
            }
            | ConnectOutcome::HostKeyChanged {
                challenge_host,
                challenge_port,
                ..
            } => Some(format!("{challenge_host}:{challenge_port}")),
        }
    }
}

/// Secrets used for authentication. The command layer reads them from the OS
/// keyring; they are never handed back to the WebView.
#[derive(Debug, Clone)]
pub struct CredentialSecrets {
    /// `password` or `private_key`.
    pub credential_type: String,
    /// Password, or a private key in OpenSSH / PEM / PuTTY text form.
    pub secret: String,
    /// Passphrase protecting `secret` when it is an encrypted private key.
    pub passphrase: Option<String>,
}

/// Everything needed to open one SSH hop.
#[derive(Debug, Clone)]
pub struct ConnectTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub secrets: CredentialSecrets,
    /// SHA-256 fingerprint already trusted for this hop, if any.
    pub known_fingerprint: Option<String>,
    /// Optional jump host (`ProxyJump`). Hops nest, so chains work.
    pub proxy_jump: Option<Box<ConnectTarget>>,
}

impl ConnectTarget {
    pub fn label(&self) -> String {
        self.endpoint().label()
    }

    pub fn endpoint(&self) -> Endpoint<'_> {
        Endpoint {
            host: &self.host,
            port: self.port,
        }
    }
}

/// Parses `user@host[:port]` as typed into the quick-connect box.
pub fn parse_ssh_target(input: &str, default_port: u16) -> anyhow::Result<(String, String, u16)> {
    use anyhow::anyhow;

    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("请输入 user@host 或 user@host:port"));
    }

    let (user, rest) = trimmed
        .rsplit_once('@')
        .ok_or_else(|| anyhow!("缺少用户名，格式应为 user@host[:port]"))?;
    if user.trim().is_empty() {
        return Err(anyhow!("用户名不能为空"));
    }

    // `[ipv6]:port` keeps the port outside the brackets; a bare address with
    // several colons is IPv6 and therefore carries no port at all.
    let (host, port) = match rest.rsplit_once("]:") {
        Some((host, port)) => (host.trim_start_matches('[').to_string(), port),
        None if rest.matches(':').count() > 1 => (rest.to_string(), ""),
        None => match rest.rsplit_once(':') {
            Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
                (host.to_string(), port)
            }
            _ => (rest.to_string(), ""),
        },
    };

    if host.is_empty() {
        return Err(anyhow!("主机地址不能为空"));
    }

    let port = if port.is_empty() {
        default_port
    } else {
        port.parse::<u16>()
            .map_err(|_| anyhow!("端口必须是 1 到 65535 之间的数字"))?
    };
    if port == 0 {
        return Err(anyhow!("端口必须是 1 到 65535 之间的数字"));
    }

    Ok((user.trim().to_string(), host, port))
}
