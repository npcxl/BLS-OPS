//! End-to-end tests against a real SSH server running in-process.
//!
//! These exercise the exact paths the desktop app uses — handshake, host key
//! trust, password auth, ProxyJump — without needing a machine to SSH into.
//! A regression in the host-key flow shows up here as a failing test.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use ops_workbench_lib::ssh::{ConnectOutcome, ConnectTarget, CredentialSecrets, SshSessionManager};
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{self, Auth, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId, Disconnect};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use russh_sftp::server::Handler as SftpHandlerTrait;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

const USER: &str = "opsuser";
const PASSWORD: &str = "opspass";
/// Fixed mtime for every test entry, so `modified_at` assertions are exact.
const MTIME: u32 = 1_700_000_000;

// ---------------------------------------------------------------------------
// Test SSH server
// ---------------------------------------------------------------------------

/// One SSH endpoint. `banner` is written when the shell opens, which lets a
/// test prove it reached a specific hop rather than just "something connected".
#[derive(Clone)]
struct TestServer {
    user: String,
    password: String,
    banner: String,
    /// When true this hop relays `direct-tcpip` channels, i.e. acts as a
    /// jump host for ProxyJump.
    allow_tunnels: bool,
    /// When true the `sftp` subsystem is served with this hop's `TestFs`.
    allow_sftp: bool,
    fs: TestFs,
}

impl server::Server for TestServer {
    type Handler = TestHandler;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> TestHandler {
        TestHandler {
            user: self.user.clone(),
            password: self.password.clone(),
            banner: self.banner.clone(),
            allow_tunnels: self.allow_tunnels,
            allow_sftp: self.allow_sftp,
            fs: self.fs.clone(),
            tunnels: HashSet::new(),
            sftp_channels: HashSet::new(),
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct TestHandler {
    user: String,
    password: String,
    banner: String,
    allow_tunnels: bool,
    allow_sftp: bool,
    fs: TestFs,
    /// Channels being relayed as tunnels. Data on these belongs to whatever
    /// protocol is tunnelled (here: another SSH session), so it must be
    /// forwarded byte-for-byte — echoing it would corrupt the inner stream.
    tunnels: HashSet<ChannelId>,
    /// Channels owned by the SFTP subsystem. Their bytes are the SFTP wire
    /// protocol; echoing them would corrupt the stream just like for tunnels.
    sftp_channels: HashSet<ChannelId>,
    /// Session channels, kept so `subsystem_request` can hand one to the
    /// SFTP server (russh hands the callback only a channel id).
    channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}

#[allow(clippy::too_many_arguments)]
impl Handler for TestHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == self.user && password == self.password {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Remember it: the sftp subsystem request only receives an id.
        self.channels.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" || !self.allow_sftp {
            let _ = session.channel_failure(channel_id);
            return Ok(());
        }
        let Some(channel) = self.channels.lock().await.remove(&channel_id) else {
            let _ = session.channel_failure(channel_id);
            return Ok(());
        };
        self.sftp_channels.insert(channel_id);
        // Detach the channel's data path BEFORE acknowledging the subsystem
        // request: the client starts the SFTP handshake as soon as it sees
        // success, and data arriving before `into_stream` registers the
        // channel would be dropped.
        let stream = channel.into_stream();
        let _ = session.channel_success(channel_id);

        let fs = self.fs.clone();
        tokio::spawn(async move {
            let handler = SftpState {
                fs,
                next_handle: 0,
                dir_handles: HashMap::new(),
                exhausted: HashSet::new(),
                file_handles: HashMap::new(),
            };
            russh_sftp::server::run(stream, handler).await;
        });
        Ok(())
    }

    /// ProxyJump relay: accept the tunnel and pipe it to the requested
    /// host:port, exactly like `ssh -W`.
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.allow_tunnels {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        reply.accept().await;

        // Remember this channel so `data` forwards instead of echoing.
        self.tunnels.insert(channel.id());

        let host = host_to_connect.to_string();
        tokio::spawn(async move {
            let upstream = match TcpStream::connect((host.as_str(), port_to_connect as u16)).await {
                Ok(stream) => stream,
                Err(_) => return,
            };
            let mut channel_stream = channel.into_stream();
            let _ = copy_bidirectional(&mut channel_stream, &mut { upstream }).await;
        });
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        let banner = format!("{}\r\n", self.banner);
        let _ = session.data(channel, banner.into_bytes());
        Ok(())
    }

    /// Echoes input back with a marker, so a test can verify the round trip.
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Tunnel and SFTP channels carry foreign protocols byte-for-byte; the
        // russh connection loop already delivers their data to the channel
        // stream these protocols read from.
        if self.tunnels.contains(&channel) || self.sftp_channels.contains(&channel) {
            return Ok(());
        }
        let echoed = format!("echo:{}", String::from_utf8_lossy(data).trim_end());
        let _ = session.data(channel, echoed.into_bytes());
        Ok(())
    }
}

/// `tokio::io::copy_bidirectional` needs both halves to be `Unpin`; the channel
/// stream is, we just spell the bound out here.
async fn copy_bidirectional<A, B>(a: &mut A, b: &mut B) -> std::io::Result<()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    tokio::io::copy_bidirectional(a, b).await.map(|_| ())
}

/// Starts a test SSH server on an ephemeral port. Returns its address and a
/// shutdown handle.
async fn spawn_server(
    banner: &str,
    allow_tunnels: bool,
) -> (SocketAddr, server::RunningServerHandle) {
    spawn_server_fs(banner, allow_tunnels, false, TestFs::empty()).await
}

/// Same, but with SFTP enabled and backed by the given virtual filesystem.
async fn spawn_server_fs(
    banner: &str,
    allow_tunnels: bool,
    allow_sftp: bool,
    fs: TestFs,
) -> (SocketAddr, server::RunningServerHandle) {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("generate host key");

    let mut config = server::Config::default();
    // Keep the suite fast: rejections normally sleep to stay constant-time.
    config.auth_rejection_time = Duration::from_millis(1);
    config.auth_rejection_time_initial = Some(Duration::from_millis(1));
    config.keys = vec![key];
    config.window_size = 65536;
    config.maximum_packet_size = 32768;

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local addr");

    let mut server = TestServer {
        user: USER.to_string(),
        password: PASSWORD.to_string(),
        banner: banner.to_string(),
        allow_tunnels,
        allow_sftp,
        fs,
    };

    // `run_on_socket` borrows the server and the listener, so the task that
    // drives it has to own both.
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let running = server.run_on_socket(Arc::new(config), &listener);
        let _ = tx.send(running.handle());
        let _ = running.await;
    });

    (addr, rx.await.expect("server handle"))
}

// ---------------------------------------------------------------------------
// In-memory filesystem served over SFTP
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct TestEntry {
    is_dir: bool,
    is_link: bool,
    size: u64,
    mtime: u32,
    /// Unix permission bits; a directory without any read bit refuses opendir.
    perms: u32,
    /// File payload for reads/writes through the test SFTP server.
    content: Option<Vec<u8>>,
    /// When true, readdir omits the SIZE attr — simulating servers that do.
    omit_size: bool,
}

fn file(size: u64) -> TestEntry {
    TestEntry {
        is_dir: false,
        is_link: false,
        size,
        mtime: MTIME,
        perms: 0o644,
        content: Some(vec![0u8; size as usize]),
        omit_size: false,
    }
}

/// A file with known text content, for read/write round-trip assertions.
fn file_with_content(content: &[u8]) -> TestEntry {
    TestEntry {
        is_dir: false,
        is_link: false,
        size: content.len() as u64,
        mtime: MTIME,
        perms: 0o644,
        content: Some(content.to_vec()),
        omit_size: false,
    }
}

fn dir() -> TestEntry {
    TestEntry {
        is_dir: true,
        is_link: false,
        size: 4096,
        mtime: MTIME,
        perms: 0o755,
        content: None,
        omit_size: false,
    }
}

fn link() -> TestEntry {
    TestEntry {
        is_dir: false,
        is_link: true,
        size: 0,
        mtime: MTIME,
        perms: 0o777,
        content: None,
        omit_size: false,
    }
}

/// A tiny in-memory filesystem: canonical absolute path -> entry.
#[derive(Clone)]
struct TestFs {
    home: String,
    entries: Arc<StdMutex<HashMap<String, TestEntry>>>,
}

impl TestFs {
    fn empty() -> Self {
        Self {
            home: "/home/opsuser".to_string(),
            entries: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    fn with(home: &str, entries: HashMap<String, TestEntry>) -> Self {
        Self {
            home: home.to_string(),
            entries: Arc::new(StdMutex::new(entries)),
        }
    }

    fn get(&self, path: &str) -> Option<TestEntry> {
        self.entries.lock().unwrap().get(path).cloned()
    }

    fn insert(&self, path: &str, entry: TestEntry) {
        self.entries.lock().unwrap().insert(path.to_string(), entry);
    }

    fn remove(&self, path: &str) {
        self.entries.lock().unwrap().remove(path);
    }

    fn exists(&self, path: &str) -> bool {
        self.entries.lock().unwrap().contains_key(path)
    }

    /// Resolves a client-supplied path: relative paths land in the home
    /// directory, `.` / `..` are folded lexically (POSIX rules only).
    fn resolve(&self, path: &str) -> String {
        let raw = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("{}/{}", self.home.trim_end_matches('/'), path)
        };
        let mut parts: Vec<&str> = Vec::new();
        for component in raw.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                component => parts.push(component),
            }
        }
        if parts.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", parts.join("/"))
        }
    }
}

fn sftp_attrs(entry: &TestEntry) -> FileAttributes {
    // SFTP encodes the type in the top bits of the permission word.
    let type_bits: u32 = if entry.is_link {
        0xA000
    } else if entry.is_dir {
        0x4000
    } else {
        0x8000
    };
    let mut attrs = FileAttributes::empty();
    attrs.size = Some(entry.size);
    attrs.permissions = Some(type_bits | entry.perms);
    attrs.atime = Some(entry.mtime);
    attrs.mtime = Some(entry.mtime);
    attrs
}

/// State for one SFTP session on the server side.
struct SftpState {
    fs: TestFs,
    next_handle: u32,
    /// Open directory handles: handle id -> canonical path.
    dir_handles: HashMap<String, String>,
    /// Handles whose entries have already been returned once.
    exhausted: HashSet<String>,
    /// Open file handles (reads + pending writes).
    file_handles: HashMap<String, OpenedFile>,
}

/// One open file: read mode exposes `content`, write mode buffers until close.
struct OpenedFile {
    path: String,
    pos: u64,
    write: bool,
    buffer: Vec<u8>,
}

impl SftpHandlerTrait for SftpState {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy(self.fs.resolve(&path))],
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let canonical = self.fs.resolve(&path);
        let entry = self.fs.get(&canonical).ok_or(StatusCode::NoSuchFile)?;
        if !entry.is_dir {
            return Err(StatusCode::NoSuchFile);
        }
        if entry.perms & 0o444 == 0 {
            return Err(StatusCode::PermissionDenied);
        }
        self.next_handle += 1;
        let handle = format!("dh{}", self.next_handle);
        self.dir_handles.insert(handle.clone(), canonical);
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let path = self
            .dir_handles
            .get(&handle)
            .ok_or(StatusCode::Failure)?
            .clone();
        if self.exhausted.contains(&handle) {
            return Err(StatusCode::Eof);
        }
        self.exhausted.insert(handle);

        let prefix = if path == "/" {
            "/".to_string()
        } else {
            format!("{path}/")
        };
        let entries = self.fs.entries.lock().unwrap().clone();
        let mut files = Vec::new();
        for (child, entry) in entries.iter() {
            let Some(name) = child.strip_prefix(&prefix) else {
                continue;
            };
            if name.contains('/') {
                continue; // grandchild, not this directory's entry
            }
            let mut attrs = sftp_attrs(entry);
            if entry.omit_size {
                attrs.size = None; // simulates servers that omit SIZE
            }
            files.push(File::new(name.to_string(), attrs));
        }
        Ok(Name { id, files })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.lstat(id, path).await
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let canonical = self.fs.resolve(&path);
        let entry = self.fs.get(&canonical).ok_or(StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: sftp_attrs(&entry),
        })
    }

    /// Handles both reads (shell side) and writes (upload/copy side). A write
    /// buffer is flushed into the virtual fs when the handle is closed.
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let canonical = self.fs.resolve(&filename);
        let writing = pflags.contains(OpenFlags::WRITE);

        if writing {
            // The parent directory must exist; the file itself is truncated.
            let parent = match canonical.rfind('/') {
                Some(0) => "/".to_string(),
                Some(pos) => canonical[..pos].to_string(),
                None => return Err(StatusCode::NoSuchFile),
            };
            let parent_entry = self.fs.get(&parent).ok_or(StatusCode::NoSuchFile)?;
            if !parent_entry.is_dir {
                return Err(StatusCode::NoSuchFile);
            }
            self.next_handle += 1;
            let handle = format!("fh{}", self.next_handle);
            self.file_handles.insert(
                handle.clone(),
                OpenedFile {
                    path: canonical,
                    pos: 0,
                    write: true,
                    buffer: Vec::new(),
                },
            );
            Ok(Handle { id, handle })
        } else {
            let entry = self.fs.get(&canonical).ok_or(StatusCode::NoSuchFile)?;
            if entry.is_dir {
                return Err(StatusCode::NoSuchFile);
            }
            self.next_handle += 1;
            let handle = format!("fh{}", self.next_handle);
            self.file_handles.insert(
                handle.clone(),
                OpenedFile {
                    path: canonical,
                    pos: 0,
                    write: false,
                    buffer: entry.content.clone().unwrap_or_default(),
                },
            );
            Ok(Handle { id, handle })
        }
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let file = self.file_handles.get(&handle).ok_or(StatusCode::Failure)?;
        if file.write {
            return Err(StatusCode::Failure);
        }
        let start = usize::try_from(offset).map_err(|_| StatusCode::BadMessage)?;
        if start >= file.buffer.len() {
            return Err(StatusCode::Eof);
        }
        let end = (start + len as usize).min(file.buffer.len());
        Ok(Data {
            id,
            data: file.buffer[start..end].to_vec(),
        })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let file = self
            .file_handles
            .get_mut(&handle)
            .ok_or(StatusCode::Failure)?;
        if !file.write {
            return Err(StatusCode::Failure);
        }
        let start = usize::try_from(offset).map_err(|_| StatusCode::BadMessage)?;
        if start > file.buffer.len() {
            return Err(StatusCode::BadMessage);
        }
        if start == file.buffer.len() {
            file.buffer.extend_from_slice(&data);
        } else {
            // Sequential writes from the client; a rewrite would need splicing.
            file.buffer.truncate(start);
            file.buffer.extend_from_slice(&data);
        }
        file.pos = (start + data.len()) as u64;
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        })
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let canonical = self.fs.resolve(&path);
        if self.fs.exists(&canonical) {
            return Err(StatusCode::Failure);
        }
        self.fs.insert(&canonical, dir());
        Ok(self.ok_status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let canonical = self.fs.resolve(&filename);
        let entry = self.fs.get(&canonical).ok_or(StatusCode::NoSuchFile)?;
        if entry.is_dir {
            return Err(StatusCode::Failure);
        }
        self.fs.remove(&canonical);
        Ok(self.ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let canonical = self.fs.resolve(&path);
        let prefix = format!("{canonical}/");
        let has_children = self
            .fs
            .entries
            .lock()
            .unwrap()
            .keys()
            .any(|child| child.starts_with(&prefix));
        if has_children {
            return Err(StatusCode::Failure);
        }
        if !self.fs.exists(&canonical) {
            return Err(StatusCode::NoSuchFile);
        }
        self.fs.remove(&canonical);
        Ok(self.ok_status(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let from = self.fs.resolve(&oldpath);
        let to = self.fs.resolve(&newpath);
        if !self.fs.exists(&from) || self.fs.exists(&to) {
            return Err(StatusCode::Failure);
        }
        let entry = self.fs.get(&from).expect("checked above");
        self.fs.remove(&from);
        self.fs.insert(&to, entry);
        Ok(self.ok_status(id))
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        // A file handle being closed commits its write buffer to the fs.
        if let Some(opened) = self.file_handles.remove(&handle) {
            if opened.write {
                self.fs.insert(
                    &opened.path,
                    TestEntry {
                        is_dir: false,
                        is_link: false,
                        size: opened.buffer.len() as u64,
                        mtime: MTIME,
                        perms: 0o644,
                        content: Some(opened.buffer),
                    },
                );
            }
        }
        self.dir_handles.remove(&handle);
        self.exhausted.remove(&handle);
        Ok(self.ok_status(id))
    }
}

impl SftpState {
    fn ok_status(&self, id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        }
    }
}

fn target(
    host: &str,
    port: u16,
    known: Option<String>,
    jump: Option<ConnectTarget>,
) -> ConnectTarget {
    ConnectTarget {
        host: host.to_string(),
        port,
        username: USER.to_string(),
        secrets: CredentialSecrets {
            credential_type: "password".to_string(),
            secret: PASSWORD.to_string(),
            passphrase: None,
        },
        known_fingerprint: known,
        proxy_jump: jump.map(Box::new),
    }
}

/// Drains the reader until it sees `needle` or the timeout expires.
async fn read_until(reader: &mut russh::ChannelReadHalf, needle: &str) -> String {
    let mut collected = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, reader.wait()).await {
            Ok(Some(russh::ChannelMsg::Data { data })) => {
                collected.push_str(&String::from_utf8_lossy(&data));
                if collected.contains(needle) {
                    return collected;
                }
            }
            Ok(Some(russh::ChannelMsg::Eof)) | Ok(Some(russh::ChannelMsg::Close { .. })) => {
                return collected;
            }
            Ok(Some(_)) => continue,
            Ok(None) => return collected,
            Err(_) => return collected,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn first_connection_reports_unknown_host_key() {
    let (addr, handle) = spawn_server("target", false).await;

    let manager = SshSessionManager::default();
    let (outcome, reader) = manager
        .connect(
            "s1".to_string(),
            target("127.0.0.1", addr.port(), None, None),
            80,
            24,
        )
        .await
        .expect("connect attempt");

    assert!(
        reader.is_none(),
        "no shell channel before the key is trusted"
    );
    match outcome {
        ConnectOutcome::HostKeyUnknown {
            host_key,
            challenge_host,
            challenge_port,
        } => {
            assert_eq!(challenge_host, "127.0.0.1");
            assert_eq!(challenge_port, addr.port());
            assert!(
                host_key.fingerprint.starts_with("SHA256:"),
                "got {}",
                host_key.fingerprint
            );
            assert!(!host_key.key_type.is_empty());
        }
        other => panic!("expected HostKeyUnknown, got {other:?}"),
    }
    handle.shutdown("done".to_string());
}

#[tokio::test]
async fn changed_host_key_reports_the_previous_fingerprint() {
    let (addr, handle) = spawn_server("target", false).await;

    let manager = SshSessionManager::default();
    let (outcome, _) = manager
        .connect(
            "s1".to_string(),
            target(
                "127.0.0.1",
                addr.port(),
                Some("SHA256:stale".to_string()),
                None,
            ),
            80,
            24,
        )
        .await
        .expect("connect attempt");

    match outcome {
        ConnectOutcome::HostKeyChanged {
            known_fingerprint,
            challenge_host,
            challenge_port,
            host_key,
        } => {
            assert_eq!(known_fingerprint, "SHA256:stale");
            assert_eq!(challenge_host, "127.0.0.1");
            assert_eq!(challenge_port, addr.port());
            assert_ne!(host_key.fingerprint, known_fingerprint);
        }
        other => panic!("expected HostKeyChanged, got {other:?}"),
    }
    handle.shutdown("done".to_string());
}

/// The full happy path: discover the key, trust it, connect, run a command.
#[tokio::test]
async fn trusting_the_key_then_reconnecting_reaches_a_shell() {
    let (addr, handle) = spawn_server("target-host", false).await;

    let manager = SshSessionManager::default();

    // 1. First attempt surfaces the fingerprint.
    let (outcome, _) = manager
        .connect(
            "s1".to_string(),
            target("127.0.0.1", addr.port(), None, None),
            80,
            24,
        )
        .await
        .expect("first attempt");
    let fingerprint = match outcome {
        ConnectOutcome::HostKeyUnknown { host_key, .. } => host_key.fingerprint,
        other => panic!("expected HostKeyUnknown, got {other:?}"),
    };

    // 2. Trust it (this is what `known_host_trust` persists) and retry.
    let (outcome, reader) = manager
        .connect(
            "s1".to_string(),
            target("127.0.0.1", addr.port(), Some(fingerprint.clone()), None),
            80,
            24,
        )
        .await
        .expect("second attempt");

    let host_key = match outcome {
        ConnectOutcome::Connected { host_key } => host_key,
        other => panic!("expected Connected after trusting, got {other:?}"),
    };
    assert_eq!(host_key.fingerprint, fingerprint);

    // 3. Shell really works: server greets us, input comes back echoed.
    let mut reader = reader.expect("shell channel");
    let banner = read_until(&mut reader, "target-host").await;
    assert!(
        banner.contains("target-host"),
        "banner not seen: {banner:?}"
    );

    manager
        .input("s1", b"hello\n".to_vec())
        .await
        .expect("input");
    let echoed = read_until(&mut reader, "echo:hello").await;
    assert!(echoed.contains("echo:hello"), "no echo: {echoed:?}");

    // 4. Resize must not error on a live session.
    manager.resize("s1", 120, 40).await.expect("resize");

    handle.shutdown("done".to_string());
}

#[tokio::test]
async fn wrong_password_is_reported_as_an_error() {
    let (addr, handle) = spawn_server("target", false).await;
    let manager = SshSessionManager::default();

    // Trust the key first so we fail on auth, not on the host key.
    let (outcome, _) = manager
        .connect(
            "s1".to_string(),
            target("127.0.0.1", addr.port(), None, None),
            80,
            24,
        )
        .await
        .expect("probe");
    let fingerprint = match outcome {
        ConnectOutcome::HostKeyUnknown { host_key, .. } => host_key.fingerprint,
        other => panic!("expected HostKeyUnknown, got {other:?}"),
    };

    let mut bad = target("127.0.0.1", addr.port(), Some(fingerprint), None);
    bad.secrets.secret = "wrong-password".to_string();

    let error = manager
        .connect("s1".to_string(), bad, 80, 24)
        .await
        .expect_err("bad password must fail");
    assert!(
        error.to_string().contains("认证失败"),
        "unexpected error: {error}"
    );

    handle.shutdown("done".to_string());
}

/// The regression that motivated this suite.
///
/// Connecting through a jump host must challenge the **jump host** first, then
/// the target — never the target twice — and trusting each in turn must
/// eventually reach the target's shell.
#[tokio::test]
async fn proxy_jump_trusts_each_hop_in_turn() {
    // The jump host relays tunnels; the target is only reachable through it.
    let (jump_addr, jump_handle) = spawn_server("jump-host", true).await;
    let (target_addr, target_handle) = spawn_server("final-host", false).await;

    let manager = SshSessionManager::default();
    let mut trusted: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    // Build the chain: target reached via 127.0.0.1:<target_port> through the jump.
    let build = |trusted: &std::collections::HashMap<String, String>| {
        let jump = target(
            "127.0.0.1",
            jump_addr.port(),
            trusted
                .get(&format!("127.0.0.1:{}", jump_addr.port()))
                .cloned(),
            None,
        );
        target(
            "127.0.0.1",
            target_addr.port(),
            trusted
                .get(&format!("127.0.0.1:{}", target_addr.port()))
                .cloned(),
            Some(jump),
        )
    };

    // 1. First attempt must challenge the JUMP host, not the target.
    let (outcome, _) = manager
        .connect("s1".to_string(), build(&trusted), 80, 24)
        .await
        .expect("hop 1");
    let (host, port, fingerprint) = match outcome {
        ConnectOutcome::HostKeyUnknown {
            host_key,
            challenge_host,
            challenge_port,
        } => (challenge_host, challenge_port, host_key.fingerprint),
        other => panic!("expected the jump host to challenge first, got {other:?}"),
    };
    assert_eq!(
        port,
        jump_addr.port(),
        "challenge must name the jump host's port"
    );
    trusted.insert(format!("{host}:{port}"), fingerprint);

    // 2. With the jump trusted, the TARGET challenges next — still not
    //    connected, and the challenge must now name the target's port.
    let (outcome, _) = manager
        .connect("s1".to_string(), build(&trusted), 80, 24)
        .await
        .expect("hop 2");
    let (host, port, fingerprint) = match outcome {
        ConnectOutcome::HostKeyUnknown {
            host_key,
            challenge_host,
            challenge_port,
        } => (challenge_host, challenge_port, host_key.fingerprint),
        other => panic!("expected the target to challenge second, got {other:?}"),
    };
    assert_eq!(
        port,
        target_addr.port(),
        "challenge must name the target's port"
    );
    trusted.insert(format!("{host}:{port}"), fingerprint);

    // 3. Both trusted: the chain completes and we land on the TARGET's shell.
    let (outcome, reader) = manager
        .connect("s1".to_string(), build(&trusted), 80, 24)
        .await
        .expect("hop 3");
    match outcome {
        ConnectOutcome::Connected { .. } => {}
        other => panic!("expected Connected once both hops are trusted, got {other:?}"),
    }

    let mut reader = reader.expect("shell channel");
    let banner = read_until(&mut reader, "final-host").await;
    assert!(
        banner.contains("final-host"),
        "must reach the target shell: {banner:?}"
    );
    assert!(
        !banner.contains("jump-host"),
        "must not be the jump host's shell"
    );

    jump_handle.shutdown("done".to_string());
    target_handle.shutdown("done".to_string());
}

/// A jump host that refuses tunnels must surface a real error rather than
/// silently returning the jump host's own shell.
#[tokio::test]
async fn proxy_jump_through_a_host_without_tunnels_fails_clearly() {
    let (jump_addr, jump_handle) = spawn_server("jump-host", false).await;
    let (target_addr, target_handle) = spawn_server("final-host", false).await;

    let manager = SshSessionManager::default();

    let fingerprint_of = async |port: u16| -> String {
        let (outcome, _) = manager
            .connect(
                "probe".to_string(),
                target("127.0.0.1", port, None, None),
                80,
                24,
            )
            .await
            .expect("probe");
        match outcome {
            ConnectOutcome::HostKeyUnknown { host_key, .. } => host_key.fingerprint,
            other => panic!("expected HostKeyUnknown while probing, got {other:?}"),
        }
    };

    let jump_fp = fingerprint_of(jump_addr.port()).await;
    let target_fp = fingerprint_of(target_addr.port()).await;

    let jump = target("127.0.0.1", jump_addr.port(), Some(jump_fp), None);
    let dest = target("127.0.0.1", target_addr.port(), Some(target_fp), Some(jump));

    let error = manager
        .connect("s1".to_string(), dest, 80, 24)
        .await
        .expect_err("a jump host without tunnels must fail");
    assert!(
        !error.to_string().is_empty(),
        "error must carry a message for the UI"
    );

    jump_handle.shutdown("done".to_string());
    target_handle.shutdown("done".to_string());
}

/// Disconnecting must unregister the session, and the manager must tolerate
/// disconnecting something that was never connected.
#[tokio::test]
async fn disconnect_removes_the_session_and_is_idempotent() {
    let (addr, handle) = spawn_server("target", false).await;
    let manager = SshSessionManager::default();

    let (outcome, _) = manager
        .connect(
            "s1".to_string(),
            target("127.0.0.1", addr.port(), None, None),
            80,
            24,
        )
        .await
        .expect("probe");
    let fingerprint = match outcome {
        ConnectOutcome::HostKeyUnknown { host_key, .. } => host_key.fingerprint,
        other => panic!("expected HostKeyUnknown, got {other:?}"),
    };

    let (_, _reader) = manager
        .connect(
            "s1".to_string(),
            target("127.0.0.1", addr.port(), Some(fingerprint), None),
            80,
            24,
        )
        .await
        .expect("connect");
    assert!(manager.is_connected("s1").await);
    assert_eq!(manager.active_count().await, 1);

    manager.disconnect("s1").await;

    assert!(!manager.is_connected("s1").await);
    assert_eq!(manager.active_count().await, 0);

    // Idempotent: tearing down an unknown session is a no-op.
    manager.disconnect("s1").await;
    manager.disconnect("never-existed").await;

    handle.shutdown("done".to_string());
}

/// Operations on a second session must not be blocked by a first session that
/// is registered but idle — proves the registry lock is not held across I/O.
#[tokio::test]
async fn sessions_are_independent() {
    let (a_addr, a_handle) = spawn_server("host-a", false).await;
    let (b_addr, b_handle) = spawn_server("host-b", false).await;
    let manager = SshSessionManager::default();

    let fingerprint = async |manager: &SshSessionManager, port: u16| -> String {
        let (outcome, _) = manager
            .connect(
                "probe".to_string(),
                target("127.0.0.1", port, None, None),
                80,
                24,
            )
            .await
            .expect("probe");
        match outcome {
            ConnectOutcome::HostKeyUnknown { host_key, .. } => host_key.fingerprint,
            other => panic!("expected HostKeyUnknown, got {other:?}"),
        }
    };

    let a_fp = fingerprint(&manager, a_addr.port()).await;
    let b_fp = fingerprint(&manager, b_addr.port()).await;

    let (_, a_reader) = manager
        .connect(
            "a".to_string(),
            target("127.0.0.1", a_addr.port(), Some(a_fp), None),
            80,
            24,
        )
        .await
        .expect("connect a");
    let (_, b_reader) = manager
        .connect(
            "b".to_string(),
            target("127.0.0.1", b_addr.port(), Some(b_fp), None),
            80,
            24,
        )
        .await
        .expect("connect b");
    let mut a_reader = a_reader.expect("shell channel a");
    let mut b_reader = b_reader.expect("shell channel b");

    assert_eq!(manager.active_count().await, 2);

    // Both shells answer independently.
    let a_banner = read_until(&mut a_reader, "host-a").await;
    let b_banner = read_until(&mut b_reader, "host-b").await;
    assert!(a_banner.contains("host-a"), "a: {a_banner:?}");
    assert!(b_banner.contains("host-b"), "b: {b_banner:?}");

    // Input on one session does not disturb the other.
    manager
        .input("a", b"ping-a\n".to_vec())
        .await
        .expect("input a");
    let echoed = read_until(&mut a_reader, "echo:ping-a").await;
    assert!(echoed.contains("echo:ping-a"), "a echo: {echoed:?}");

    // Keepalives on both sessions are independent too.
    manager.keepalive("a").await.expect("keepalive a");
    manager.keepalive("b").await.expect("keepalive b");

    manager.disconnect("a").await;
    assert_eq!(manager.active_count().await, 1);
    assert!(!manager.is_connected("a").await);
    assert!(manager.is_connected("b").await);

    manager.disconnect("b").await;
    a_handle.shutdown("done".to_string());
    b_handle.shutdown("done".to_string());
}

/// Operating on a session that does not exist must fail rather than panic.
#[tokio::test]
async fn operations_on_unknown_sessions_fail_cleanly() {
    let manager = SshSessionManager::default();
    assert!(manager.input("ghost", b"x".to_vec()).await.is_err());
    assert!(manager.resize("ghost", 80, 24).await.is_err());
    assert!(manager.keepalive("ghost").await.is_err());
    assert!(!manager.is_connected("ghost").await);
}

/// Sanity check that the disconnect reason constant used by graceful shutdown
/// is the one we think it is.
#[test]
fn graceful_shutdown_uses_by_application() {
    assert_eq!(Disconnect::ByApplication as u32, 11);
}

// ---------------------------------------------------------------------------
// SFTP: browsing over the live session
// ---------------------------------------------------------------------------

/// Trusts the server's key (probe + reconnect), like the UI flow does.
async fn connect_trusted(
    manager: &SshSessionManager,
    session_id: &str,
    port: u16,
) -> russh::ChannelReadHalf {
    let probe = format!("probe-{session_id}");
    let (outcome, _) = manager
        .connect(probe.clone(), target("127.0.0.1", port, None, None), 80, 24)
        .await
        .expect("probe");
    let fingerprint = match outcome {
        ConnectOutcome::HostKeyUnknown { host_key, .. } => host_key.fingerprint,
        other => panic!("expected HostKeyUnknown, got {other:?}"),
    };
    manager.disconnect(&probe).await;

    let (outcome, reader) = manager
        .connect(
            session_id.to_string(),
            target("127.0.0.1", port, Some(fingerprint), None),
            80,
            24,
        )
        .await
        .expect("connect");
    assert!(
        matches!(outcome, ConnectOutcome::Connected { .. }),
        "expected Connected, got {outcome:?}"
    );
    reader.expect("shell channel")
}

/// A directory listing with everything the UI has to render correctly.
fn rich_fs() -> TestFs {
    let mut entries = HashMap::new();
    entries.insert("/home".to_string(), dir());
    entries.insert("/home/opsuser".to_string(), dir());
    entries.insert("/home/opsuser/TARGET_MARKER.txt".to_string(), file(14));
    entries.insert("/home/opsuser/.hidden".to_string(), file(7));
    entries.insert("/home/opsuser/link-to-marker".to_string(), link());
    entries.insert("/home/opsuser/1.txt".to_string(), file(1));
    entries.insert("/home/opsuser/2.txt".to_string(), file(2));
    entries.insert("/home/opsuser/10.txt".to_string(), file(10));
    entries.insert("/home/opsuser/docs".to_string(), dir());
    entries.insert("/home/opsuser/docs/readme.md".to_string(), file(256));
    entries.insert("/home/opsuser/中文 目录".to_string(), dir());
    entries.insert("/home/opsuser/中文 目录/文件.txt".to_string(), file(9));
    entries.insert("/home/opsuser/spaces dir".to_string(), dir());
    // Unreadable directory: opendir must answer "permission denied".
    entries.insert("/home/opsuser/_locked".to_string(), {
        let mut locked = dir();
        locked.perms = 0o000;
        locked
    });
    TestFs::with("/home/opsuser", entries)
}

fn jump_fs() -> TestFs {
    let mut entries = HashMap::new();
    entries.insert("/home".to_string(), dir());
    entries.insert("/home/opsuser".to_string(), dir());
    entries.insert("/home/opsuser/JUMP_MARKER.txt".to_string(), file(14));
    TestFs::with("/home/opsuser", entries)
}

#[tokio::test]
async fn sftp_opens_home_and_lists_entries() {
    let (addr, handle) = spawn_server_fs("target-host", false, true, rich_fs()).await;
    let manager = SshSessionManager::default();
    connect_trusted(&manager, "s1", addr.port()).await;

    // 1. Opening SFTP returns the canonical home directory.
    let home = manager.sftp_open("s1").await.expect("sftp open");
    assert_eq!(home, "/home/opsuser");

    // 2. Listing without a path uses the session's current directory (home).
    let (canonical, entries) = manager.sftp_list_dir("s1", None).await.expect("list home");
    assert_eq!(canonical, "/home/opsuser");
    assert!(!entries.is_empty());

    let find = |name: &str| entries.iter().find(|entry| entry.name == name).cloned();

    // Files: kind, size, mtime, path and hidden flag.
    let marker = find("TARGET_MARKER.txt").expect("marker listed");
    assert_eq!(marker.kind, "file");
    assert_eq!(marker.size, 14);
    assert_eq!(marker.modified_at, Some(MTIME as i64));
    assert_eq!(marker.path, "/home/opsuser/TARGET_MARKER.txt");
    assert!(!marker.hidden);

    let hidden = find(".hidden").expect("hidden file listed");
    assert!(hidden.hidden);

    // Symlinks are reported as symlinks, not as their target.
    let symlink = find("link-to-marker").expect("symlink listed");
    assert_eq!(symlink.kind, "symlink");

    // CJK and space-containing names survive the round trip.
    let cjk_dir = find("中文 目录").expect("cjk dir listed");
    assert_eq!(cjk_dir.kind, "directory");
    assert!(find("spaces dir").is_some(), "space-named dir listed");

    // Directories sort before everything else.
    let first_non_dir = entries
        .iter()
        .position(|entry| entry.kind != "directory")
        .expect("has non-directory entries");
    assert!(entries[..first_non_dir]
        .iter()
        .all(|entry| entry.kind == "directory"));

    // Natural order: numbers by value, so 1 < 2 < 10.
    let at = |name: &str| {
        entries
            .iter()
            .position(|entry| entry.name == name)
            .expect(name)
    };
    assert!(at("1.txt") < at("2.txt"));
    assert!(at("2.txt") < at("10.txt"));

    handle.shutdown("done".to_string());
}

#[tokio::test]
async fn sftp_enters_subdirs_and_tracks_cwd() {
    let (addr, handle) = spawn_server_fs("target-host", false, true, rich_fs()).await;
    let manager = SshSessionManager::default();
    connect_trusted(&manager, "s1", addr.port()).await;
    manager.sftp_open("s1").await.expect("sftp open");

    // Realpath canonicalizes relative paths against the home directory.
    let docs = manager.sftp_realpath("s1", "docs").await.expect("realpath");
    assert_eq!(docs, "/home/opsuser/docs");

    // Enter the subdirectory.
    let (canonical, entries) = manager
        .sftp_list_dir("s1", Some(docs.clone()))
        .await
        .expect("list docs");
    assert_eq!(canonical, "/home/opsuser/docs");
    assert!(entries.iter().any(|entry| entry.name == "readme.md"));
    assert!(!entries
        .iter()
        .any(|entry| entry.name == "TARGET_MARKER.txt"));

    // Helper listings of OTHER directories (the child-count feature) must not
    // disturb the current location: `None` still resolves to the home.
    let _ = manager
        .sftp_list_dir("s1", Some("/home/opsuser/docs".to_string()))
        .await;
    let (canonical, _) = manager.sftp_list_dir("s1", None).await.expect("list home");
    assert_eq!(canonical, "/home/opsuser");

    // Going up. Note: the server resolves `..` against ITS working directory
    // (the home), not against the directory the UI is currently viewing —
    // which is why the UI computes the parent path itself from the current
    // location instead of asking the server for `..`.
    let parent = manager
        .sftp_realpath("s1", "..")
        .await
        .expect("realpath ..");
    assert_eq!(parent, "/home");
    // The UI's parent-of-current-directory is an absolute path; listing it
    // lands back in the home directory.
    let (canonical, entries) = manager
        .sftp_list_dir("s1", Some("/home/opsuser".to_string()))
        .await
        .expect("list parent");
    assert_eq!(canonical, "/home/opsuser");
    assert!(entries
        .iter()
        .any(|entry| entry.name == "TARGET_MARKER.txt"));

    handle.shutdown("done".to_string());
}

#[tokio::test]
async fn sftp_stat_reports_details() {
    let (addr, handle) = spawn_server_fs("target-host", false, true, rich_fs()).await;
    let manager = SshSessionManager::default();
    connect_trusted(&manager, "s1", addr.port()).await;
    manager.sftp_open("s1").await.expect("sftp open");

    let marker = manager
        .sftp_stat("s1", "/home/opsuser/TARGET_MARKER.txt")
        .await
        .expect("stat file");
    assert_eq!(marker.kind, "file");
    assert_eq!(marker.size, 14);
    assert_eq!(marker.modified_at, Some(MTIME as i64));
    assert!(marker.permissions.is_some());
    assert!(!marker.hidden);

    let hidden = manager
        .sftp_stat("s1", "/home/opsuser/.hidden")
        .await
        .expect("stat hidden");
    assert!(hidden.hidden);

    // lstat semantics: the link itself, not its target.
    let symlink = manager
        .sftp_stat("s1", "/home/opsuser/link-to-marker")
        .await
        .expect("stat link");
    assert_eq!(symlink.kind, "symlink");

    handle.shutdown("done".to_string());
}

#[tokio::test]
async fn sftp_permission_denied_is_a_clear_error() {
    let (addr, handle) = spawn_server_fs("target-host", false, true, rich_fs()).await;
    let manager = SshSessionManager::default();
    connect_trusted(&manager, "s1", addr.port()).await;
    manager.sftp_open("s1").await.expect("sftp open");

    let error = manager
        .sftp_list_dir("s1", Some("/home/opsuser/_locked".to_string()))
        .await
        .expect_err("unreadable dir must fail");
    assert!(
        error.to_string().contains("权限不足"),
        "unexpected error: {error}"
    );

    // The session and the SFTP client survive the failed listing.
    let (canonical, _) = manager
        .sftp_list_dir("s1", None)
        .await
        .expect("list still works");
    assert_eq!(canonical, "/home/opsuser");

    handle.shutdown("done".to_string());
}

#[tokio::test]
async fn sftp_fails_after_ssh_disconnect() {
    let (addr, handle) = spawn_server_fs("target-host", false, true, rich_fs()).await;
    let manager = SshSessionManager::default();
    connect_trusted(&manager, "s1", addr.port()).await;

    manager.sftp_open("s1").await.expect("sftp open");
    manager
        .sftp_list_dir("s1", None)
        .await
        .expect("list before disconnect");

    manager.disconnect("s1").await;

    // Every SFTP operation must fail immediately afterwards — the client is
    // gone, not hanging on a dead socket.
    let list_error = manager
        .sftp_list_dir("s1", None)
        .await
        .expect_err("list after disconnect must fail");
    assert!(
        list_error.to_string().contains("会话不存在"),
        "unexpected: {list_error}"
    );
    assert!(manager.sftp_open("s1").await.is_err());
    assert!(manager.sftp_stat("s1", "/home/opsuser").await.is_err());
    // Closing an already-disconnected session is a clean no-op error, not a panic.
    assert!(manager.sftp_close("s1").await.is_err());

    handle.shutdown("done".to_string());
}

#[tokio::test]
async fn sftp_and_shell_work_simultaneously() {
    let (addr, handle) = spawn_server_fs("target-host", false, true, rich_fs()).await;
    let manager = SshSessionManager::default();
    let mut reader = connect_trusted(&manager, "s1", addr.port()).await;

    // Shell round trip.
    manager
        .input("s1", b"one\n".to_vec())
        .await
        .expect("input one");
    let echoed = read_until(&mut reader, "echo:one").await;
    assert!(echoed.contains("echo:one"), "first echo: {echoed:?}");

    // SFTP traffic on its own channel.
    manager.sftp_open("s1").await.expect("sftp open");
    let (_, entries) = manager.sftp_list_dir("s1", None).await.expect("list");
    assert!(entries
        .iter()
        .any(|entry| entry.name == "TARGET_MARKER.txt"));

    // The shell is still alive afterwards.
    manager
        .input("s1", b"two\n".to_vec())
        .await
        .expect("input two");
    let echoed = read_until(&mut reader, "echo:two").await;
    assert!(echoed.contains("echo:two"), "second echo: {echoed:?}");

    handle.shutdown("done".to_string());
}

/// SFTP must talk to the FINAL server through the tunnel, never to the jump
/// host — the file listings are the proof.
#[tokio::test]
async fn proxy_jump_browses_final_server_files() {
    // The jump host relays tunnels but serves its own (different) files.
    let (jump_addr, jump_handle) = spawn_server_fs("jump-host", true, false, jump_fs()).await;
    let (target_addr, target_handle) = spawn_server_fs("final-host", false, true, rich_fs()).await;

    let manager = SshSessionManager::default();
    let mut trusted: HashMap<String, String> = HashMap::new();

    let build = |trusted: &HashMap<String, String>| {
        let jump = target(
            "127.0.0.1",
            jump_addr.port(),
            trusted
                .get(&format!("127.0.0.1:{}", jump_addr.port()))
                .cloned(),
            None,
        );
        target(
            "127.0.0.1",
            target_addr.port(),
            trusted
                .get(&format!("127.0.0.1:{}", target_addr.port()))
                .cloned(),
            Some(jump),
        )
    };

    // Trust the jump host first, then the target (same flow as the shell test).
    let (outcome, _) = manager
        .connect("s1".to_string(), build(&trusted), 80, 24)
        .await
        .expect("hop 1");
    let (host, port, fingerprint) = match outcome {
        ConnectOutcome::HostKeyUnknown {
            host_key,
            challenge_host,
            challenge_port,
        } => (challenge_host, challenge_port, host_key.fingerprint),
        other => panic!("expected jump host challenge first, got {other:?}"),
    };
    assert_eq!(port, jump_addr.port());
    trusted.insert(format!("{host}:{port}"), fingerprint);

    let (outcome, _) = manager
        .connect("s1".to_string(), build(&trusted), 80, 24)
        .await
        .expect("hop 2");
    let (host, port, fingerprint) = match outcome {
        ConnectOutcome::HostKeyUnknown {
            host_key,
            challenge_host,
            challenge_port,
        } => (challenge_host, challenge_port, host_key.fingerprint),
        other => panic!("expected target challenge second, got {other:?}"),
    };
    assert_eq!(port, target_addr.port());
    trusted.insert(format!("{host}:{port}"), fingerprint);

    let (outcome, reader) = manager
        .connect("s1".to_string(), build(&trusted), 80, 24)
        .await
        .expect("hop 3");
    assert!(
        matches!(outcome, ConnectOutcome::Connected { .. }),
        "got {outcome:?}"
    );
    let mut reader = reader.expect("shell channel");
    let banner = read_until(&mut reader, "final-host").await;
    assert!(banner.contains("final-host"));

    // Now browse: the listing must be the TARGET's files.
    let home = manager.sftp_open("s1").await.expect("sftp open");
    assert_eq!(home, "/home/opsuser");
    let (_, entries) = manager
        .sftp_list_dir("s1", None)
        .await
        .expect("list through jump");
    assert!(
        entries
            .iter()
            .any(|entry| entry.name == "TARGET_MARKER.txt"),
        "must list the final server's files, got: {entries:?}"
    );
    assert!(
        !entries.iter().any(|entry| entry.name == "JUMP_MARKER.txt"),
        "must NOT list the jump host's files"
    );

    jump_handle.shutdown("done".to_string());
    target_handle.shutdown("done".to_string());
}

// ---------------------------------------------------------------------------
// SFTP: file management (remove / rename / copy / mkdir / upload)
// ---------------------------------------------------------------------------

/// A fs with one file whose bytes are known, so round-trips can be asserted.
fn content_fs() -> TestFs {
    let mut entries = HashMap::new();
    entries.insert("/home".to_string(), dir());
    entries.insert("/home/opsuser".to_string(), dir());
    entries.insert(
        "/home/opsuser/hello.txt".to_string(),
        file_with_content(b"hello sftp world"),
    );
    entries.insert("/home/opsuser/docs".to_string(), dir());
    entries.insert(
        "/home/opsuser/docs/a.txt".to_string(),
        file_with_content(b"AAA"),
    );
    entries.insert(
        "/home/opsuser/docs/b.txt".to_string(),
        file_with_content(b"BBB"),
    );
    TestFs::with("/home/opsuser", entries)
}

async fn open_session(fs: TestFs) -> (SocketAddr, server::RunningServerHandle, SshSessionManager) {
    let (addr, handle) = spawn_server_fs("target-host", false, true, fs).await;
    let manager = SshSessionManager::default();
    connect_trusted(&manager, "s1", addr.port()).await;
    manager.sftp_open("s1").await.expect("sftp open");
    (addr, handle, manager)
}

#[tokio::test]
async fn sftp_mkdir_creates_a_directory() {
    let (_addr, handle, manager) = open_session(content_fs()).await;

    let created = manager
        .sftp_mkdir("s1", "/home/opsuser/newdir")
        .await
        .expect("mkdir");
    assert_eq!(created, "/home/opsuser/newdir");

    // It shows up in the listing as a directory.
    let (_, entries) = manager.sftp_list_dir("s1", None).await.expect("list");
    let entry = entries
        .iter()
        .find(|entry| entry.name == "newdir")
        .expect("newdir listed");
    assert_eq!(entry.kind, "directory");

    // Creating it twice fails instead of silently succeeding.
    assert!(manager
        .sftp_mkdir("s1", "/home/opsuser/newdir")
        .await
        .is_err());

    handle.shutdown("done".to_string());
}

#[tokio::test]
async fn sftp_rename_moves_within_the_same_directory() {
    let (_addr, handle, manager) = open_session(content_fs()).await;

    let new_path = manager
        .sftp_rename("s1", "/home/opsuser/hello.txt", "renamed.txt")
        .await
        .expect("rename");
    assert_eq!(new_path, "/home/opsuser/renamed.txt");

    let (_, entries) = manager.sftp_list_dir("s1", None).await.expect("list");
    assert!(entries.iter().any(|entry| entry.name == "renamed.txt"));
    assert!(!entries.iter().any(|entry| entry.name == "hello.txt"));

    // Renaming onto an existing name must fail, not overwrite.
    assert!(manager
        .sftp_rename("s1", "/home/opsuser/renamed.txt", "renamed.txt")
        .await
        .is_err());

    handle.shutdown("done".to_string());
}

#[tokio::test]
async fn sftp_copy_duplicates_files_and_directories() {
    let (_addr, handle, manager) = open_session(content_fs()).await;

    // File copy keeps the content.
    manager
        .sftp_copy("s1", "/home/opsuser/hello.txt", "hello-copy.txt")
        .await
        .expect("copy file");
    let copied = manager
        .sftp_stat("s1", "/home/opsuser/hello-copy.txt")
        .await
        .expect("stat copy");
    assert_eq!(copied.kind, "file");
    assert_eq!(copied.size, 16);

    // Directory copy is recursive.
    manager
        .sftp_copy("s1", "/home/opsuser/docs", "docs-copy")
        .await
        .expect("copy dir");
    let (_, copies) = manager
        .sftp_list_dir("s1", Some("/home/opsuser/docs-copy".to_string()))
        .await
        .expect("list copy dir");
    assert!(copies.iter().any(|entry| entry.name == "a.txt"));
    assert!(copies.iter().any(|entry| entry.name == "b.txt"));

    // Copying onto an existing name must fail.
    assert!(manager
        .sftp_copy("s1", "/home/opsuser/hello.txt", "hello-copy.txt")
        .await
        .is_err());

    handle.shutdown("done".to_string());
}

#[tokio::test]
async fn sftp_remove_deletes_files_and_directories() {
    let (_addr, handle, manager) = open_session(content_fs()).await;

    // A file goes away.
    manager
        .sftp_remove("s1", "/home/opsuser/hello.txt")
        .await
        .expect("remove file");
    assert!(manager
        .sftp_stat("s1", "/home/opsuser/hello.txt")
        .await
        .is_err());

    // A directory tree goes away with everything in it.
    manager
        .sftp_remove("s1", "/home/opsuser/docs")
        .await
        .expect("remove dir tree");
    assert!(manager.sftp_stat("s1", "/home/opsuser/docs").await.is_err());
    assert!(manager
        .sftp_stat("s1", "/home/opsuser/docs/a.txt")
        .await
        .is_err());

    // Removing something that does not exist is an error, not a panic.
    assert!(manager
        .sftp_remove("s1", "/home/opsuser/ghost")
        .await
        .is_err());

    handle.shutdown("done".to_string());
}

/// Upload writes the local bytes to the remote path and reports the entries.
#[tokio::test]
async fn sftp_upload_writes_local_files_to_the_remote_dir() {
    let (_addr, handle, manager) = open_session(content_fs()).await;

    // Two temp files, one of them in a subdirectory (recursive upload).
    let tmp = std::env::temp_dir().join(format!("bls-ops-e2e-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(tmp.join("nested"))
        .await
        .expect("mkdir tmp");
    tokio::fs::write(tmp.join("first.txt"), b"FIRST FILE")
        .await
        .expect("write");
    tokio::fs::write(tmp.join("nested").join("second.log"), b"SECOND LOG")
        .await
        .expect("write");

    let done_names: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let uploaded = manager
        .sftp_upload(
            "s1",
            &[tmp.join("first.txt").to_string_lossy().to_string()],
            "/home/opsuser",
            &|name| done_names.lock().unwrap().push(name.to_string()),
        )
        .await
        .expect("upload file");
    assert_eq!(uploaded.len(), 1);
    assert_eq!(uploaded[0].path, "/home/opsuser/first.txt");
    assert_eq!(uploaded[0].size, 10);

    // The bytes actually landed remotely.
    let stat = manager
        .sftp_stat("s1", "/home/opsuser/first.txt")
        .await
        .expect("stat");
    assert_eq!(stat.size, 10);

    // Directory upload mirrors the structure (the temp root itself is skipped,
    // its children land in the target dir). The same collector counts both.
    let uploaded = manager
        .sftp_upload(
            "s1",
            &[tmp.to_string_lossy().to_string()],
            "/home/opsuser",
            &|name| done_names.lock().unwrap().push(name.to_string()),
        )
        .await
        .expect("upload dir");
    assert_eq!(uploaded.len(), 2, "file + nested file: {uploaded:?}");

    let (_, nested) = manager
        .sftp_list_dir(
            "s1",
            Some(format!(
                "/home/opsuser/{}/nested",
                tmp.file_name().unwrap().to_string_lossy()
            )),
        )
        .await
        .expect("list nested");
    assert!(nested.iter().any(|entry| entry.name == "second.log"));

    // The completion callback fired once per file (1 + 2).
    let done = done_names.lock().unwrap();
    assert_eq!(done.len(), 3, "callback per file: {done:?}");
    assert!(done.contains(&"first.txt".to_string()));
    assert!(done.contains(&"second.log".to_string()));
    drop(done);

    tokio::fs::remove_dir_all(&tmp).await.ok();
    handle.shutdown("done".to_string());
}

/// The editor round trip: read back known bytes, save an edit, read it again.
#[tokio::test]
async fn sftp_read_and_write_files_round_trip() {
    let (_addr, handle, manager) = open_session(content_fs()).await;

    // 1. Read returns the exact stored content.
    let content = manager
        .sftp_read_file("s1", "/home/opsuser/hello.txt", 1024 * 1024)
        .await
        .expect("read file");
    assert_eq!(content.path, "/home/opsuser/hello.txt");
    assert!(!content.binary);
    assert_eq!(content.content.as_deref(), Some("hello sftp world"));

    // 2. Saving an edit overwrites the file.
    manager
        .sftp_write_file("s1", "/home/opsuser/hello.txt", "edited content\nline 2")
        .await
        .expect("write file");
    let reread = manager
        .sftp_read_file("s1", "/home/opsuser/hello.txt", 1024 * 1024)
        .await
        .expect("reread");
    assert_eq!(reread.content.as_deref(), Some("edited content\nline 2"));
    let stat = manager
        .sftp_stat("s1", "/home/opsuser/hello.txt")
        .await
        .expect("stat");
    assert_eq!(stat.size, "edited content\nline 2".len() as u64);

    // 3. Oversized reads are refused with a clear message, not truncated.
    let error = manager
        .sftp_read_file("s1", "/home/opsuser/hello.txt", 4)
        .await
        .expect_err("must refuse small cap");
    assert!(
        error.to_string().contains("文件过大"),
        "unexpected: {error}"
    );

    // 4. Directories cannot be opened as text.
    let error = manager
        .sftp_read_file("s1", "/home/opsuser/docs", 1024 * 1024)
        .await
        .expect_err("directory must be refused");
    assert!(error.to_string().contains("文件夹"), "unexpected: {error}");

    handle.shutdown("done".to_string());
}

/// Binary payloads must be flagged, not decoded into garbage text.
#[tokio::test]
async fn sftp_read_flags_binary_content() {
    // Build a file with a NUL byte — the classic binary marker.
    let (addr, handle) = spawn_server_fs("target-host", false, true, {
        let mut entries = HashMap::new();
        entries.insert("/home".to_string(), dir());
        entries.insert("/home/opsuser".to_string(), dir());
        entries.insert(
            "/home/opsuser/blob.bin".to_string(),
            file_with_content(&[0x50, 0x4B, 0x00, 0x03, 0xFF]),
        );
        TestFs::with("/home/opsuser", entries)
    })
    .await;
    let manager = SshSessionManager::default();
    connect_trusted(&manager, "s1", addr.port()).await;
    manager.sftp_open("s1").await.expect("sftp open");

    let content = manager
        .sftp_read_file("s1", "/home/opsuser/blob.bin", 1024 * 1024)
        .await
        .expect("read");
    assert!(content.binary, "NUL byte must mark the file as binary");
    assert!(content.content.is_none());

    handle.shutdown("done".to_string());
}

/// Servers that omit SIZE in readdir attrs must still yield real sizes: the
/// client lstats the affected entries instead of silently reporting 0.
#[tokio::test]
async fn sftp_list_recovers_missing_sizes_via_lstat() {
    let mut entries = HashMap::new();
    entries.insert("/home".to_string(), dir());
    entries.insert("/home/opsuser".to_string(), dir());
    entries.insert(
        "/home/opsuser/plain.txt".to_string(),
        file_with_content(b"normal attrs"),
    );
    // The server omits SIZE for this one in readdir only.
    let mut shy = file_with_content(b"shy size 12345");
    shy.omit_size = true;
    entries.insert("/home/opsuser/shy.txt".to_string(), shy);
    let (addr, handle) =
        spawn_server_fs("target-host", false, true, TestFs::with("/home/opsuser", entries)).await;
    let manager = SshSessionManager::default();
    connect_trusted(&manager, "s1", addr.port()).await;
    manager.sftp_open("s1").await.expect("sftp open");

    let (_, listed) = manager.sftp_list_dir("s1", None).await.expect("list");
    let shy = listed
        .iter()
        .find(|entry| entry.name == "shy.txt")
        .expect("shy.txt listed");
    assert_eq!(shy.size, 14, "recovered via lstat, not 0");
    let plain = listed
        .iter()
        .find(|entry| entry.name == "plain.txt")
        .expect("plain.txt listed");
    assert_eq!(plain.size, 12);

    handle.shutdown("done".to_string());
}
