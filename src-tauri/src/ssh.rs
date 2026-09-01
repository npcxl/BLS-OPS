use std::{
    cmp::Ordering,
    collections::HashMap,
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};

use anyhow::{anyhow, Result};
use russh::client;
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelReadHalf, ChannelWriteHalf, Disconnect};
use russh_sftp::client::{fs::DirEntry, SftpSession};
use russh_sftp::protocol::{FileAttributes, FileType, StatusCode as SftpStatusCode};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

/// How often an idle session sends a keepalive probe; also drives russh's
/// `keepalive_max` disconnect detection.
pub const DEFAULT_KEEPALIVE_SECS: u64 = 30;

/// The SFTP subsystem is requested on its own channel over the same
/// connection, so the shell and the file browser never block each other.
pub const SFTP_SUBSYSTEM: &str = "sftp";

pub const KIND_DIRECTORY: &str = "directory";
pub const KIND_FILE: &str = "file";
pub const KIND_SYMLINK: &str = "symlink";
pub const KIND_OTHER: &str = "other";

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

/// `1.5 MB` style, for error messages.
fn format_size_human(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = "B";
    for next in units {
        value /= 1024.0;
        unit = next;
        if value < 1024.0 {
            break;
        }
    }
    format!("{value:.1} {unit}")
}

fn sftp_kind(file_type: FileType) -> &'static str {
    match file_type {
        FileType::Dir => KIND_DIRECTORY,
        FileType::File => KIND_FILE,
        FileType::Symlink => KIND_SYMLINK,
        FileType::Other => KIND_OTHER,
    }
}

/// Builds an entry from a `read_dir` item, remembering whether the server
/// reported a size at all (some servers/servers behind proxies omit it).
fn remote_entry(parent: &str, entry: DirEntry) -> (RemoteFileEntry, bool) {
    let name = entry.file_name();
    let meta = entry.metadata();
    let size_missing = meta.size.is_none();
    (
        build_entry(&posix_join(parent, &name), &name, &meta),
        size_missing,
    )
}

/// Builds an entry for a single path (used by `sftp_stat`).
///
/// Paths are always absolute remote paths, so the name is the last segment.
fn build_entry(path: &str, name: &str, meta: &russh_sftp::client::fs::Metadata) -> RemoteFileEntry {
    RemoteFileEntry {
        name: name.to_string(),
        path: path.to_string(),
        kind: sftp_kind(meta.file_type()).to_string(),
        size: meta.len(),
        modified_at: meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64),
        permissions: Some(meta.permissions().to_string()),
        hidden: name.starts_with('.'),
    }
}

/// Maps SFTP client errors onto user-facing messages, calling out permission
/// problems explicitly so the UI can present them distinctly.
fn sftp_error(error: russh_sftp::client::error::Error) -> anyhow::Error {
    use russh_sftp::client::error::Error as SftpError;
    match &error {
        SftpError::Status(status) if status.status_code == SftpStatusCode::PermissionDenied => {
            anyhow!("权限不足：无法访问该路径（{}）", status.error_message)
        }
        SftpError::Status(status) => anyhow!("SFTP 错误：{}", status.error_message),
        _ => anyhow!("SFTP 错误：{error}"),
    }
}

/// Joins a remote path segment onto a base directory, POSIX rules only.
pub fn posix_join(base: &str, name: &str) -> String {
    if name.starts_with('/') {
        return posix_normalize(name);
    }
    if base == "/" {
        posix_normalize(&format!("/{name}"))
    } else {
        posix_normalize(&format!("{base}/{name}"))
    }
}

/// Lexically resolves `.` and `..` in a remote path. The server canonicalizes
/// authoritatively via SFTP REALPATH; this keeps client-side joins consistent.
pub fn posix_normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            component => parts.push(component),
        }
    }
    if parts.is_empty() {
        return "/".to_string();
    }
    format!("/{}", parts.join("/"))
}

/// Splits a name into digit / non-digit chunks for natural ordering.
fn natural_chunks(s: &str) -> Vec<(bool, String)> {
    let mut chunks: Vec<(bool, String)> = Vec::new();
    let mut current = String::new();
    let mut current_digit: Option<bool> = None;
    for char in s.chars() {
        let digit = char.is_ascii_digit();
        if Some(digit) != current_digit && !current.is_empty() {
            chunks.push((current_digit.unwrap_or(false), std::mem::take(&mut current)));
        }
        current_digit = Some(digit);
        current.push(char);
    }
    if !current.is_empty() {
        chunks.push((current_digit.unwrap_or(false), current));
    }
    chunks
}

/// Orders names the way humans expect: embedded numbers compare by value, so
/// `file2` sorts before `file10`. Non-digits compare by character value, which
/// also gives stable ordering for CJK names and names with spaces.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let chunk_a = natural_chunks(a);
    let chunk_b = natural_chunks(b);
    for index in 0..chunk_a.len().min(chunk_b.len()) {
        let (digit_a, text_a) = &chunk_a[index];
        let (digit_b, text_b) = &chunk_b[index];
        let ordering = match (digit_a, digit_b) {
            (true, true) => text_a
                .parse::<u64>()
                .unwrap_or(u64::MAX)
                .cmp(&text_b.parse::<u64>().unwrap_or(u64::MAX)),
            _ => text_a.cmp(text_b),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
        if digit_a != digit_b {
            return digit_b.cmp(digit_a); // digits before letters
        }
    }
    chunk_a.len().cmp(&chunk_b.len())
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

/// Verdict on the key a server presented during the handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerdict {
    /// Matches the fingerprint we already trust.
    Trusted,
    /// No fingerprint on record for this endpoint.
    Unknown {
        challenge_host: String,
        challenge_port: u16,
    },
    /// On record, but different — possible machine-in-the-middle.
    Changed {
        challenge_host: String,
        challenge_port: u16,
        known_fingerprint: String,
    },
}

/// Decides whether an observed host key is acceptable.
///
/// Pure and network-free so the whole trust matrix is unit-testable.
/// `challenge_host` / `challenge_port` always name the endpoint that actually
/// presented the key.
pub fn evaluate_host_key(
    endpoint: Endpoint<'_>,
    trusted_fingerprint: Option<&str>,
    observed: &HostKeyInfo,
) -> HostKeyVerdict {
    match trusted_fingerprint {
        None => HostKeyVerdict::Unknown {
            challenge_host: endpoint.host.to_string(),
            challenge_port: endpoint.port,
        },
        Some(known) if known == observed.fingerprint => HostKeyVerdict::Trusted,
        Some(known) => HostKeyVerdict::Changed {
            challenge_host: endpoint.host.to_string(),
            challenge_port: endpoint.port,
            known_fingerprint: known.to_string(),
        },
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
pub fn parse_ssh_target(input: &str, default_port: u16) -> Result<(String, String, u16)> {
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

type SessionWriter = ChannelWriteHalf<client::Msg>;

/// One live session.
///
/// The writer sits behind its own lock: slow or stuck I/O on one session must
/// never block input, resize or keepalive on another. The registry below is
/// only ever held long enough to look a session up.
struct SshSession {
    handle: client::Handle<ClientHandler>,
    writer: Mutex<SessionWriter>,
    /// Jump-host handles must outlive the tunneled session, otherwise the
    /// direct-tcpip channel is dropped and the connection dies.
    _chain: Vec<client::Handle<ClientHandler>>,
    /// Lazily opened SFTP client for this session. Each session owns one, so
    /// sessions never share a browser; dropped on disconnect. `SftpSession`
    /// itself is not `Clone`, but its operations only need `&self`, so the
    /// session lives in an `Arc` that callers can clone cheaply — nobody holds
    /// this lock across network I/O.
    sftp: Mutex<Option<Arc<SftpSession>>>,
    /// Last canonical directory this session's file browser viewed.
    cwd: Mutex<Option<String>>,
}

impl SshSession {
    /// Returns the session's SFTP client, opening the subsystem channel on
    /// first use.
    ///
    /// Opening a second channel for SFTP leaves the shell channel untouched —
    /// both work simultaneously over the same connection.
    async fn sftp_client(&self) -> Result<Arc<SftpSession>> {
        let mut guard = self.sftp.lock().await;
        if let Some(sftp) = guard.as_ref() {
            return Ok(sftp.clone());
        }
        let channel = self.handle.channel_open_session().await?;
        channel
            .request_subsystem(true, SFTP_SUBSYSTEM)
            .await
            .map_err(|error| anyhow!("远端未提供 SFTP 子系统：{error}"))?;
        let sftp = Arc::new(SftpSession::new(channel.into_stream()).await?);
        *guard = Some(sftp.clone());
        Ok(sftp)
    }

    /// Best-effort teardown. Each step is attempted even if an earlier one
    /// fails, so the remote side is told to release the session.
    async fn shutdown(&self) {
        // Close SFTP while the connection is still alive so it sees a clean
        // EOF instead of dying with the socket.
        if let Some(sftp) = self.sftp.lock().await.take() {
            let _ = sftp.close().await;
        }
        {
            let writer = self.writer.lock().await;
            // Tell the pty we're done writing, then close the channel.
            let _ = writer.eof().await;
            let _ = writer.close().await;
        }
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "client closed the session", "en")
            .await;
    }
}

/// Registry of live interactive sessions.
#[derive(Clone, Default)]
pub struct SshSessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SshSession>>>>,
}

impl SshSessionManager {
    /// Looks a session up and releases the registry lock before returning.
    ///
    /// Every caller can therefore `.await` on network I/O without holding the
    /// global lock — a stuck server blocks only its own session.
    async fn get(&self, session_id: &str) -> Result<Arc<SshSession>> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions.get(session_id).cloned()
        };
        session.ok_or_else(|| anyhow!("SSH 会话不存在或已断开"))
    }

    /// Opens an interactive shell session. On success the caller owns the read
    /// half and must pump it until it yields `None`.
    pub async fn connect(
        &self,
        session_id: String,
        target: ConnectTarget,
        cols: u32,
        rows: u32,
    ) -> Result<(ConnectOutcome, Option<ChannelReadHalf>)> {
        match connect_hop(&target, cols, rows).await? {
            HopResult::Connected(connection) => {
                let host_key = connection.host_key;
                let (reader, writer) = connection
                    .channel
                    .ok_or_else(|| anyhow!("会话未打开终端通道"))?;
                self.sessions.lock().await.insert(
                    session_id,
                    Arc::new(SshSession {
                        handle: connection.handle,
                        writer: Mutex::new(writer),
                        _chain: connection.chain,
                        sftp: Mutex::new(None),
                        cwd: Mutex::new(None),
                    }),
                );
                Ok((ConnectOutcome::Connected { host_key }, Some(reader)))
            }
            HopResult::HostKeyUnknown {
                host_key,
                host,
                port,
            } => Ok((
                ConnectOutcome::HostKeyUnknown {
                    host_key,
                    challenge_host: host,
                    challenge_port: port,
                },
                None,
            )),
            HopResult::HostKeyChanged {
                host_key,
                known,
                host,
                port,
            } => Ok((
                ConnectOutcome::HostKeyChanged {
                    host_key,
                    known_fingerprint: known,
                    challenge_host: host,
                    challenge_port: port,
                },
                None,
            )),
        }
    }

    pub async fn input(&self, session_id: &str, data: Vec<u8>) -> Result<()> {
        let session = self.get(session_id).await?;
        session.writer.lock().await.data_bytes(data).await?;
        Ok(())
    }

    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<()> {
        let session = self.get(session_id).await?;
        session
            .writer
            .lock()
            .await
            .window_change(cols, rows, 0, 0)
            .await?;
        Ok(())
    }

    /// Explicit keepalive, on top of russh's built-in timer.
    pub async fn keepalive(&self, session_id: &str) -> Result<()> {
        let session = self.get(session_id).await?;
        session.handle.send_keepalive(true).await?;
        Ok(())
    }

    /// Closes the session gracefully and removes it from the registry.
    ///
    /// The session is unregistered *first*, so no new operation can start on a
    /// connection that is being torn down.
    pub async fn disconnect(&self, session_id: &str) {
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(session_id)
        };
        if let Some(session) = session {
            session.shutdown().await;
        }
    }

    pub async fn is_connected(&self, session_id: &str) -> bool {
        let sessions = self.sessions.lock().await;
        sessions.contains_key(session_id)
    }

    pub async fn active_count(&self) -> usize {
        self.sessions.lock().await.len()
    }

    // -- SFTP ----------------------------------------------------------------

    /// Opens SFTP for the session and returns the canonical home directory.
    pub async fn sftp_open(&self, session_id: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        // "." resolves against the login directory of the authenticated user.
        let home = sftp.canonicalize(".").await.map_err(sftp_error)?;
        let mut cwd = session.cwd.lock().await;
        if cwd.is_none() {
            *cwd = Some(home.clone());
        }
        Ok(home)
    }

    /// Lists a directory over SFTP.
    ///
    /// `None` / empty resolves to the session's current directory (home on
    /// first use). Returns the canonical path plus entries sorted
    /// directories-first, then by natural name order. The session's current
    /// directory is updated so a later `None` resumes here.
    pub async fn sftp_list_dir(
        &self,
        session_id: &str,
        path: Option<String>,
    ) -> Result<(String, Vec<RemoteFileEntry>)> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;

        let requested = match path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => value.to_string(),
            None => session
                .cwd
                .lock()
                .await
                .clone()
                .unwrap_or_else(|| ".".to_string()),
        };

        // The server canonicalizes (resolving symlinks in the path), so the
        // returned path is always the real, absolute remote path.
        let canonical = sftp.canonicalize(requested).await.map_err(sftp_error)?;

        let mut entries: Vec<RemoteFileEntry> = Vec::new();
        for (entry, size_missing) in sftp
            .read_dir(&canonical)
            .await
            .map_err(sftp_error)?
            .map(|entry| remote_entry(&canonical, entry))
        {
            // Some servers omit SIZE in readdir attrs (the client would then
            // silently report 0). One extra lstat per affected entry is the
            // honest fix; it only ever runs for those entries.
            if size_missing {
                if let Ok(full) = sftp.symlink_metadata(&entry.path).await {
                    let patched = build_entry(&entry.path, &entry.name, &full);
                    entries.push(patched);
                    continue;
                }
            }
            entries.push(entry);
        }

        entries.sort_by(|a, b| {
            (b.kind == KIND_DIRECTORY)
                .cmp(&(a.kind == KIND_DIRECTORY))
                .then_with(|| natural_cmp(&a.name, &b.name))
        });

        // Deliberately NOT tracking the last-listed directory as the session
        // cwd here: the frontend owns the current-location state, and helper
        // listings (e.g. child counts) must not disturb it. `None` in a later
        // call still resolves to the session's home via `sftp_open`.
        Ok((canonical, entries))
    }

    /// Canonicalizes a remote path server-side.
    pub async fn sftp_realpath(&self, session_id: &str, path: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        Ok(sftp.canonicalize(path).await.map_err(sftp_error)?)
    }

    /// Stat for a single entry. Uses lstat semantics so a symlink is reported
    /// as a symlink rather than as its target — what a file browser wants.
    pub async fn sftp_stat(&self, session_id: &str, path: &str) -> Result<RemoteFileEntry> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp.canonicalize(path).await.map_err(sftp_error)?;
        let meta = sftp
            .symlink_metadata(&canonical)
            .await
            .map_err(sftp_error)?;
        let name = canonical.rsplit('/').next().unwrap_or(&canonical);
        Ok(build_entry(&canonical, name, &meta))
    }

    /// Closes the session's SFTP client and releases its channel.
    pub async fn sftp_close(&self, session_id: &str) -> Result<()> {
        let session = self.get(session_id).await?;
        let mut guard = session.sftp.lock().await;
        if let Some(sftp) = guard.take() {
            sftp.close().await.map_err(sftp_error)?;
        }
        Ok(())
    }

    /// Removes a remote file, symlink or directory tree.
    ///
    /// Directories are removed recursively: entries first, then the directory
    /// itself. Symlinks are unlinked, never followed, so `remove` on a link
    /// cannot wipe out the target.
    pub async fn sftp_remove(&self, session_id: &str, path: &str) -> Result<()> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp.canonicalize(path).await.map_err(sftp_error)?;
        remove_recursive(&sftp, &canonical).await
    }

    /// Renames an entry within its directory (`new_name` is a plain name, not
    /// a path). Fails if the target exists — SFTP rename does not overwrite.
    pub async fn sftp_rename(
        &self,
        session_id: &str,
        path: &str,
        new_name: &str,
    ) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp.canonicalize(path).await.map_err(sftp_error)?;
        if new_name.trim().is_empty() || new_name.contains('/') {
            return Err(anyhow!("名称不能为空，且不能包含 /"));
        }
        let target = posix_join(&parent_of(&canonical), new_name);
        sftp.rename(&canonical, &target).await.map_err(sftp_error)?;
        Ok(target)
    }

    /// Creates a copy of a file or directory inside its own directory.
    /// Directories are copied recursively; symlinks are reported as
    /// unsupported to keep phase 2 honest.
    pub async fn sftp_copy(&self, session_id: &str, path: &str, new_name: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp.canonicalize(path).await.map_err(sftp_error)?;
        if new_name.trim().is_empty() || new_name.contains('/') {
            return Err(anyhow!("名称不能为空，且不能包含 /"));
        }
        let target = posix_join(&parent_of(&canonical), new_name);
        if sftp.symlink_metadata(&target).await.is_ok() {
            return Err(anyhow!("目标已存在：{new_name}"));
        }
        copy_recursive(&sftp, &canonical, &target).await?;
        Ok(target)
    }

    /// Creates a directory. Parent must already exist (SFTP has no mkdir -p).
    pub async fn sftp_mkdir(&self, session_id: &str, path: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp
            .canonicalize(parent_of(&posix_normalize(path)))
            .await
            .map_err(sftp_error)?;
        let target = posix_join(&canonical, &base_name(&posix_normalize(path)));
        sftp.create_dir(&target).await.map_err(sftp_error)?;
        Ok(target)
    }

    /// Creates an empty remote file (fails if it already exists).
    pub async fn sftp_touch(&self, session_id: &str, path: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        if sftp.symlink_metadata(path).await.is_ok() {
            return Err(anyhow!("文件已存在"));
        }
        let mut file = sftp.create(path).await.map_err(sftp_error)?;
        file.shutdown()
            .await
            .map_err(|error| anyhow!("创建文件失败：{error}"))?;
        Ok(path.to_string())
    }

    /// Reads a remote text file for the in-app editor.
    ///
    /// Binary content (NUL byte or invalid UTF-8) is reported via `binary`
    /// instead of being garbled; oversized files are refused with a clear
    /// message rather than silently truncated.
    pub async fn sftp_read_file(
        &self,
        session_id: &str,
        path: &str,
        max_len: u64,
    ) -> Result<RemoteFileContent> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp.canonicalize(path).await.map_err(sftp_error)?;
        let meta = sftp
            .symlink_metadata(&canonical)
            .await
            .map_err(sftp_error)?;
        if meta.file_type() == FileType::Dir {
            return Err(anyhow!("这是一个文件夹，无法作为文本打开"));
        }
        let size = meta.len();
        if size > max_len {
            return Err(anyhow!(
                "文件过大（{}），暂不支持在应用内编辑",
                format_size_human(size)
            ));
        }

        let mut file = sftp.open(&canonical).await.map_err(sftp_error)?;
        let mut bytes = Vec::with_capacity(size as usize);
        tokio::io::AsyncReadExt::read_to_end(&mut file, &mut bytes)
            .await
            .map_err(|error| anyhow!("读取文件失败：{error}"))?;

        let binary = bytes.contains(&0) || String::from_utf8(bytes.clone()).is_err();
        let content = if binary {
            None
        } else {
            Some(String::from_utf8(bytes).unwrap_or_default())
        };
        Ok(RemoteFileContent {
            path: canonical,
            size,
            binary,
            content,
        })
    }

    /// Overwrites a remote text file (the editor's save action).
    pub async fn sftp_write_file(&self, session_id: &str, path: &str, content: &str) -> Result<()> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp.canonicalize(path).await.map_err(sftp_error)?;
        let mut file = sftp.create(&canonical).await.map_err(sftp_error)?;
        tokio::io::AsyncWriteExt::write_all(&mut file, content.as_bytes())
            .await
            .map_err(|error| anyhow!("写入文件失败：{error}"))?;
        file.shutdown()
            .await
            .map_err(|error| anyhow!("保存文件失败：{error}"))?;
        Ok(())
    }

    /// Uploads local files or directories into `remote_dir`.
    ///
    /// Local paths are the one place `PathBuf` is correct — they are on this
    /// machine. Directories are walked recursively and re-created remotely.
    /// Directories themselves are never followed outside the uploaded root.
    pub async fn sftp_upload(
        &self,
        session_id: &str,
        local_paths: &[String],
        remote_dir: &str,
        on_file_done: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<Vec<RemoteFileEntry>> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let base = sftp.canonicalize(remote_dir).await.map_err(sftp_error)?;

        let mut uploaded = Vec::new();
        for raw in local_paths {
            let local = std::path::PathBuf::from(raw);
            if !local.exists() {
                return Err(anyhow!("本地路径不存在：{}", local.display()));
            }
            uploaded.extend(upload_walk(&sftp, &local, &local.clone(), &base, on_file_done).await?);
        }
        Ok(uploaded)
    }
}

/// The last segment of a POSIX path (`""` stays `""` — caller decides).
fn parent_of(path: &str) -> String {
    let cut = path.rfind('/').unwrap_or(0);
    if cut == 0 {
        "/".to_string()
    } else {
        path[..cut].to_string()
    }
}

fn base_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn remove_recursive<'a>(
    sftp: &'a SftpSession,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let meta = sftp.symlink_metadata(path).await.map_err(sftp_error)?;
        if meta.file_type() != FileType::Dir {
            sftp.remove_file(path).await.map_err(sftp_error)?;
            return Ok(());
        }
        for entry in sftp.read_dir(path).await.map_err(sftp_error)? {
            let child = posix_join(path, &entry.file_name());
            // Use lstat so a symlink inside the tree is unlinked, not followed.
            remove_recursive(sftp, &child).await?;
        }
        sftp.remove_dir(path).await.map_err(sftp_error)?;
        Ok(())
    })
}

fn copy_recursive<'a>(
    sftp: &'a SftpSession,
    from: &'a str,
    to: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let meta = sftp.symlink_metadata(from).await.map_err(sftp_error)?;
        match meta.file_type() {
            FileType::Dir => {
                sftp.create_dir(to).await.map_err(sftp_error)?;
                for entry in sftp.read_dir(from).await.map_err(sftp_error)? {
                    let child_from = posix_join(from, &entry.file_name());
                    let child_to = posix_join(to, &entry.file_name());
                    copy_recursive(sftp, &child_from, &child_to).await?;
                }
                Ok(())
            }
            FileType::Symlink => Err(anyhow!("暂不支持复制符号链接：{from}")),
            _ => {
                let mut source = sftp.open(from).await.map_err(sftp_error)?;
                let mut target = sftp.create(to).await.map_err(sftp_error)?;
                tokio::io::copy(&mut source, &mut target)
                    .await
                    .map_err(|error| anyhow!("复制 {from} 失败：{error}"))?;
                target
                    .shutdown()
                    .await
                    .map_err(|error| anyhow!("写入 {to} 失败：{error}"))?;
                Ok(())
            }
        }
    })
}

/// Uploads `root` (file or directory) into `remote_dir`, mirroring the
/// relative structure below `root_base`.
fn upload_walk<'a>(
    sftp: &'a SftpSession,
    current: &'a std::path::Path,
    root_base: &'a std::path::Path,
    remote_dir: &'a str,
    on_file_done: &'a (dyn Fn(&str) + Send + Sync),
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<RemoteFileEntry>>> + Send + 'a>>
{
    Box::pin(
        async move { upload_walk_inner(sftp, current, root_base, remote_dir, on_file_done).await },
    )
}

async fn upload_walk_inner(
    sftp: &SftpSession,
    current: &std::path::Path,
    root_base: &std::path::Path,
    remote_dir: &str,
    on_file_done: &(dyn Fn(&str) + Send + Sync),
) -> Result<Vec<RemoteFileEntry>> {
    // Only used for the parent/child relationship check below; the remote path
    // is derived from `remote_dir` + names, not from this prefix.
    current
        .strip_prefix(root_base)
        .map_err(|_| anyhow!("内部错误：路径前缀不匹配 {}", current.display()))?;
    let name = current
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let remote_path = if name.is_empty() {
        remote_dir.to_string()
    } else {
        posix_join(remote_dir, &name)
    };

    if current.is_dir() {
        if !name.is_empty() {
            // Overwrite-tolerant create: an existing dir makes CREATE fail, so
            // reuse it instead of erroring the whole upload.
            if sftp.symlink_metadata(&remote_path).await.is_err() {
                sftp.create_dir(&remote_path).await.map_err(sftp_error)?;
            }
        }
        let mut uploaded = Vec::new();
        let mut children = tokio::fs::read_dir(current)
            .await
            .map_err(|error| anyhow!("读取本地目录 {} 失败：{error}", current.display()))?;
        while let Some(child) = children
            .next_entry()
            .await
            .map_err(|error| anyhow!("读取本地目录 {} 失败：{error}", current.display()))?
        {
            uploaded.extend(
                upload_walk(sftp, &child.path(), root_base, &remote_path, on_file_done).await?,
            );
        }
        Ok(uploaded)
    } else {
        let size = current
            .metadata()
            .map_err(|error| anyhow!("读取本地文件 {} 失败：{error}", current.display()))?
            .len();
        let mut local = tokio::fs::File::open(current)
            .await
            .map_err(|error| anyhow!("打开本地文件 {} 失败：{error}", current.display()))?;
        let mut remote = sftp.create(&remote_path).await.map_err(sftp_error)?;
        tokio::io::copy(&mut local, &mut remote)
            .await
            .map_err(|error| anyhow!("上传 {name} 失败：{error}"))?;
        remote
            .shutdown()
            .await
            .map_err(|error| anyhow!("上传 {name} 失败：{error}"))?;
        on_file_done(&name);
        let mut entry = build_entry(
            &remote_path,
            &base_name(&remote_path),
            &FileAttributes::empty(),
        );
        entry.size = size;
        entry.kind = KIND_FILE.to_string();
        Ok(vec![entry])
    }
}

struct HopConnection {
    handle: client::Handle<ClientHandler>,
    /// `None` for jump hops, which are tunnels only.
    channel: Option<(ChannelReadHalf, SessionWriter)>,
    host_key: HostKeyInfo,
    chain: Vec<client::Handle<ClientHandler>>,
}

enum HopResult {
    Connected(HopConnection),
    HostKeyUnknown {
        host_key: HostKeyInfo,
        host: String,
        port: u16,
    },
    HostKeyChanged {
        host_key: HostKeyInfo,
        known: String,
        host: String,
        port: u16,
    },
}

fn build_config() -> Arc<client::Config> {
    let mut config = client::Config::default();
    config.keepalive_interval = Some(Duration::from_secs(DEFAULT_KEEPALIVE_SECS));
    config.keepalive_max = 3;
    Arc::new(config)
}

async fn connect_hop(target: &ConnectTarget, cols: u32, rows: u32) -> Result<HopResult> {
    let observed: Arc<Mutex<Option<HostKeyInfo>>> = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        expected: target.known_fingerprint.clone(),
        observed: observed.clone(),
    };
    let config = build_config();

    let mut chain: Vec<client::Handle<ClientHandler>> = Vec::new();
    let attempt = match target.proxy_jump.as_deref() {
        Some(jump) => {
            // A jump hop that challenges propagates its own endpoint, so the
            // caller trusts the *jump host's* key, not the target's.
            let jump_connection = match Box::pin(connect_hop(jump, 0, 0)).await? {
                HopResult::Connected(connection) => connection,
                other => return Ok(other),
            };
            let jump_handle = jump_connection.handle;
            chain = jump_connection.chain;
            let channel = jump_handle
                .channel_open_direct_tcpip(
                    target.host.clone(),
                    target.port as u32,
                    "127.0.0.1".to_string(),
                    0,
                )
                .await?;
            // The jump handle has to stay alive for the tunnel to keep working.
            chain.push(jump_handle);
            client::connect_stream(config, channel.into_stream(), handler).await
        }
        None => client::connect(config, (target.host.as_str(), target.port), handler).await,
    };

    let mut handle = match attempt {
        Ok(handle) => handle,
        Err(error) => {
            // The handshake rejected the key: report it instead of authenticating,
            // so no credential is ever offered to an untrusted host.
            if let Some(outcome) = host_key_outcome(target, &observed).await {
                return Ok(outcome);
            }
            return Err(anyhow!("无法连接到 {} — {}", target.label(), error));
        }
    };

    let host_key = observed
        .lock()
        .await
        .clone()
        .ok_or_else(|| anyhow!("未能读取 {} 的主机指纹", target.label()))?;

    let authenticated = match target.secrets.credential_type.as_str() {
        "password" => {
            handle
                .authenticate_password(target.username.clone(), target.secrets.secret.clone())
                .await?
        }
        "private_key" => {
            let passphrase = target.secrets.passphrase.as_deref();
            let key = decode_secret_key(&target.secrets.secret, passphrase)
                .map_err(|error| anyhow!("无法解析私钥（口令错误或格式不支持）：{error}"))?;
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            handle
                .authenticate_publickey(
                    target.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await?
        }
        other => return Err(anyhow!("不支持的凭据类型：{other}")),
    };

    if !authenticated.success() {
        return Err(anyhow!(
            "{}@{} 认证失败：用户名或凭据被拒绝",
            target.username,
            target.label()
        ));
    }

    // Jump hops are pure tunnels; only the final hop gets a PTY + shell.
    let channel = if cols == 0 || rows == 0 {
        None
    } else {
        let channel = handle.channel_open_session().await?;
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;
        Some(channel.split())
    };

    Ok(HopResult::Connected(HopConnection {
        handle,
        channel,
        host_key,
        chain,
    }))
}

/// Turns a failed handshake into a host-key prompt whenever the server did
/// present a key we do not trust; otherwise it is reported as a normal error.
///
/// `target` is always the hop that failed, so the challenge names that hop.
async fn host_key_outcome(
    target: &ConnectTarget,
    observed: &Arc<Mutex<Option<HostKeyInfo>>>,
) -> Option<HopResult> {
    let host_key = observed.lock().await.clone()?;
    match evaluate_host_key(
        target.endpoint(),
        target.known_fingerprint.as_deref(),
        &host_key,
    ) {
        HostKeyVerdict::Trusted => None,
        HostKeyVerdict::Unknown {
            challenge_host,
            challenge_port,
        } => Some(HopResult::HostKeyUnknown {
            host_key,
            host: challenge_host,
            port: challenge_port,
        }),
        HostKeyVerdict::Changed {
            challenge_host,
            challenge_port,
            known_fingerprint,
        } => Some(HopResult::HostKeyChanged {
            host_key,
            known: known_fingerprint,
            host: challenge_host,
            port: challenge_port,
        }),
    }
}

#[derive(Clone)]
struct ClientHandler {
    expected: Option<String>,
    observed: Arc<Mutex<Option<HostKeyInfo>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        let expected = self.expected.clone();
        let observed = self.observed.clone();
        let public_key = server_public_key.public_key();
        let fingerprint = format!("{}", public_key.fingerprint(HashAlg::Sha256));
        let key_type = format!("{}", public_key.algorithm());
        async move {
            *observed.lock().await = Some(HostKeyInfo {
                fingerprint: fingerprint.clone(),
                key_type,
            });
            Ok(matches!(expected.as_deref(), Some(expected) if expected == fingerprint))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        evaluate_host_key, natural_cmp, parse_ssh_target, posix_join, posix_normalize,
        ConnectOutcome, ConnectTarget, CredentialSecrets, Endpoint, HostKeyInfo, HostKeyVerdict,
    };
    use std::cmp::Ordering;

    fn key(fingerprint: &str) -> HostKeyInfo {
        HostKeyInfo {
            fingerprint: fingerprint.to_string(),
            key_type: "ssh-ed25519".to_string(),
        }
    }

    fn secrets() -> CredentialSecrets {
        CredentialSecrets {
            credential_type: "password".to_string(),
            secret: "pw".to_string(),
            passphrase: None,
        }
    }

    fn target(host: &str, port: u16, known: Option<&str>) -> ConnectTarget {
        ConnectTarget {
            host: host.to_string(),
            port,
            username: "root".to_string(),
            secrets: secrets(),
            known_fingerprint: known.map(str::to_string),
            proxy_jump: None,
        }
    }

    #[test]
    fn parses_user_host_port() {
        let (user, host, port) = parse_ssh_target("root@10.0.0.11:2222", 22).unwrap();
        assert_eq!(
            (user.as_str(), host.as_str(), port),
            ("root", "10.0.0.11", 2222)
        );
    }

    #[test]
    fn falls_back_to_default_port() {
        let (user, host, port) = parse_ssh_target("deploy@example.com", 22).unwrap();
        assert_eq!(
            (user.as_str(), host.as_str(), port),
            ("deploy", "example.com", 22)
        );
    }

    #[test]
    fn parses_ipv6_literal_with_port() {
        let (user, host, port) = parse_ssh_target("root@[2001:db8::1]:2200", 22).unwrap();
        assert_eq!(
            (user.as_str(), host.as_str(), port),
            ("root", "2001:db8::1", 2200)
        );
    }

    #[test]
    fn parses_bare_ipv6_without_port() {
        let (user, host, port) = parse_ssh_target("root@2001:db8::1", 22).unwrap();
        assert_eq!(
            (user.as_str(), host.as_str(), port),
            ("root", "2001:db8::1", 22)
        );
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let (user, host, port) = parse_ssh_target("  root@host:22  ", 22).unwrap();
        assert_eq!((user.as_str(), host.as_str(), port), ("root", "host", 22));
    }

    #[test]
    fn rejects_missing_user() {
        assert!(parse_ssh_target("10.0.0.11", 22).is_err());
    }

    #[test]
    fn rejects_empty_input() {
        assert!(parse_ssh_target("   ", 22).is_err());
    }

    #[test]
    fn rejects_invalid_port() {
        assert!(parse_ssh_target("root@host:99999", 22).is_err());
        assert!(parse_ssh_target("root@host:0", 22).is_err());
    }

    // -- host key trust matrix ------------------------------------------------

    #[test]
    fn untrusted_endpoint_is_unknown() {
        let verdict = evaluate_host_key(
            Endpoint {
                host: "a",
                port: 22,
            },
            None,
            &key("SHA256:new"),
        );
        assert_eq!(
            verdict,
            HostKeyVerdict::Unknown {
                challenge_host: "a".to_string(),
                challenge_port: 22
            }
        );
    }

    #[test]
    fn matching_fingerprint_is_trusted() {
        let verdict = evaluate_host_key(
            Endpoint {
                host: "a",
                port: 22,
            },
            Some("SHA256:same"),
            &key("SHA256:same"),
        );
        assert_eq!(verdict, HostKeyVerdict::Trusted);
    }

    #[test]
    fn differing_fingerprint_is_changed() {
        let verdict = evaluate_host_key(
            Endpoint {
                host: "a",
                port: 2222,
            },
            Some("SHA256:old"),
            &key("SHA256:new"),
        );
        assert_eq!(
            verdict,
            HostKeyVerdict::Changed {
                challenge_host: "a".to_string(),
                challenge_port: 2222,
                known_fingerprint: "SHA256:old".to_string(),
            }
        );
    }

    /// The regression this file exists for: the challenge must name the hop
    /// that presented the key, never the final destination.
    #[test]
    fn challenge_names_the_failing_hop_not_the_target() {
        let jump = target("jump.internal", 2022, None);
        let mut dest = target("db.internal", 22, None);
        dest.proxy_jump = Some(Box::new(jump));

        assert_eq!(dest.label(), "db.internal:22");
        assert_eq!(dest.endpoint().label(), "db.internal:22");

        let jump_hop = dest.proxy_jump.as_ref().expect("jump hop");
        let verdict = evaluate_host_key(
            jump_hop.endpoint(),
            jump_hop.known_fingerprint.as_deref(),
            &key("SHA256:jump"),
        );

        match verdict {
            HostKeyVerdict::Unknown {
                challenge_host,
                challenge_port,
            } => {
                assert_eq!(challenge_host, "jump.internal");
                assert_eq!(challenge_port, 2022);
            }
            other => panic!("expected Unknown for the jump host, got {other:?}"),
        }
    }

    #[test]
    fn outcome_challenge_label_points_at_the_untrusted_endpoint() {
        let unknown = ConnectOutcome::HostKeyUnknown {
            host_key: key("SHA256:jump"),
            challenge_host: "jump.internal".to_string(),
            challenge_port: 2022,
        };
        assert_eq!(
            unknown.challenge_label().as_deref(),
            Some("jump.internal:2022")
        );

        let changed = ConnectOutcome::HostKeyChanged {
            host_key: key("SHA256:jump2"),
            known_fingerprint: "SHA256:jump".to_string(),
            challenge_host: "jump.internal".to_string(),
            challenge_port: 2022,
        };
        assert_eq!(
            changed.challenge_label().as_deref(),
            Some("jump.internal:2022")
        );

        let connected = ConnectOutcome::Connected {
            host_key: key("SHA256:ok"),
        };
        assert_eq!(connected.challenge_label(), None);
    }

    // -- remote POSIX paths ---------------------------------------------------

    #[test]
    fn posix_join_keeps_absolute_names() {
        assert_eq!(posix_join("/var/log", "/etc/passwd"), "/etc/passwd");
        assert_eq!(posix_join("/var/log", "nginx"), "/var/log/nginx");
        assert_eq!(posix_join("/var/log", "./nginx"), "/var/log/nginx");
        assert_eq!(posix_join("/var/log", "../etc"), "/var/etc");
        assert_eq!(posix_join("/", "srv"), "/srv");
    }

    #[test]
    fn posix_normalize_collapses_components() {
        assert_eq!(posix_normalize("/a//b/./c"), "/a/b/c");
        assert_eq!(posix_normalize("/a/b/../c"), "/a/c");
        assert_eq!(posix_normalize("/.."), "/");
        assert_eq!(posix_normalize("/"), "/");
    }

    // -- natural ordering -----------------------------------------------------

    #[test]
    fn natural_order_compares_numbers_by_value() {
        assert_eq!(natural_cmp("file2.txt", "file10.txt"), Ordering::Less);
        assert_eq!(natural_cmp("file10.txt", "file2.txt"), Ordering::Greater);
        assert_eq!(natural_cmp("file2.txt", "file2.txt"), Ordering::Equal);
    }

    #[test]
    fn natural_order_handles_cjk_and_spaces() {
        // Same prefix, embedded numbers still numeric.
        assert_eq!(natural_cmp("日志 2", "日志 10"), Ordering::Less);
        // Different first characters order by character value; determinism is
        // what matters for a listing, not locale collation.
        assert_eq!(natural_cmp("日志", "文档"), Ordering::Greater);
        assert_eq!(natural_cmp("a b", "a-c"), Ordering::Less);
    }

    #[test]
    fn natural_order_mixed_digit_text_chunks() {
        assert_eq!(natural_cmp("2.txt", "a.txt"), Ordering::Less);
        assert_eq!(natural_cmp("10", "9a"), Ordering::Greater);
    }
}
