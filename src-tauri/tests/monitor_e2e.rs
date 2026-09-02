//! End-to-end monitoring tests against a real SSH server in-process.
//!
//! The servers here answer `exec` requests with fixed Linux fixtures — a
//! `/proc/stat` that really ticks forward, a `df` with a tmpfs to be filtered,
//! a `ps` with three processes — so the whole read path is exercised over a
//! genuine SSH connection, including through a ProxyJump tunnel.
//!
//! A second server profile never answers at all, which is how the timeout and
//! "disconnect cancels the collection" behaviours are proven.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ops_workbench_lib::dirsize::{DirectorySizeRegistry, DirectorySizeStatus};
use ops_workbench_lib::monitor::{self, MonitorRegistry};
use ops_workbench_lib::ssh::{
    ConnectOutcome, ConnectTarget, CredentialSecrets, SshSessionManager, DEFAULT_COMMAND_TIMEOUT,
};
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{self, Auth, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId, Disconnect};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};

const USER: &str = "opsuser";
const PASSWORD: &str = "opspass";

// Must match the private command table in `src/monitor.rs`. A change there
// without a change here shows up as "command not found" from the fixtures.
const CMD_UNAME: &str = "uname -srm";
const CMD_HOSTNAME: &str = "cat /proc/sys/kernel/hostname";
const CMD_UPTIME: &str = "cat /proc/uptime";
const CMD_LOADAVG: &str = "cat /proc/loadavg";
const CMD_CPU: &str = "cat /proc/stat";
const CMD_MEMORY: &str = "cat /proc/meminfo";
const CMD_DISKS: &str = "df -B1 -P -T";
const CMD_NETWORK: &str = "cat /proc/net/dev";
const CMD_PROCESSES: &str = "ps -eo pid,user,pcpu,pmem,stat,lstart,comm";
const CMD_OS_RELEASE: &str = "cat /etc/os-release";

// ---------------------------------------------------------------------------
// Test SSH server
// ---------------------------------------------------------------------------

/// What a server pretends to be.
#[derive(Clone)]
enum Profile {
    /// Answers every monitoring command with a fixture.
    Linux { hostname: String },
    /// Answers `uname` with a non-Linux system, nothing else.
    Darwin,
    /// Accepts exec channels and then never replies — for timeout tests.
    Silent,
    /// Like Linux, but `ps` answers with the old `args`-style listing whose
    /// command lines carry secrets. The client must strip everything after
    /// the executable name; this is the leak-prevention drill.
    LeakyPs,
}

#[derive(Clone)]
struct MonitorServer {
    user: String,
    password: String,
    profile: Profile,
    /// Relay `direct-tcpip` channels, i.e. act as a ProxyJump hop.
    allow_tunnels: bool,
    /// Shared so every `/proc/stat` read advances the counters: the usage
    /// percentage then comes out of a real delta instead of a constant.
    stat_step: Arc<AtomicU64>,
    net_step: Arc<AtomicU64>,
    /// When set, the server slams the door on the next exec request — a
    /// server-initiated disconnect, with the server itself staying up.
    kill_switch: Arc<AtomicBool>,
    /// When set, `du` answers "command not found" so the client exercises its
    /// SFTP recursive fallback instead of the preferred fast path.
    du_disabled: Arc<AtomicBool>,
}

impl server::Server for MonitorServer {
    type Handler = MonitorHandler;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> MonitorHandler {
        MonitorHandler {
            user: self.user.clone(),
            password: self.password.clone(),
            profile: self.profile.clone(),
            allow_tunnels: self.allow_tunnels,
            tunnels: HashSet::new(),
            stat_step: self.stat_step.clone(),
            net_step: self.net_step.clone(),
            kill_switch: self.kill_switch.clone(),
            du_disabled: self.du_disabled.clone(),
        }
    }
}

struct MonitorHandler {
    user: String,
    password: String,
    profile: Profile,
    allow_tunnels: bool,
    /// Channels relayed as tunnels; their bytes belong to the inner SSH
    /// session and must never be interpreted here.
    tunnels: HashSet<ChannelId>,
    stat_step: Arc<AtomicU64>,
    net_step: Arc<AtomicU64>,
    kill_switch: Arc<AtomicBool>,
    du_disabled: Arc<AtomicBool>,
}

impl MonitorHandler {
    fn hostname(&self) -> &str {
        match &self.profile {
            Profile::Linux { hostname } => hostname.as_str(),
            _ => "unknown",
        }
    }

    /// `du` is simulated unless `du_disabled` is set (the fallback drill).
    fn has_du(&self) -> bool {
        !self.du_disabled.load(Ordering::Relaxed)
    }

    /// `/proc/stat` at counter step `step`: 160 jiffies pass per step, 40 of
    /// them idle, so the computed usage is a stable 75%.
    fn stat(&self, step: u64) -> String {
        let user = 1000 + step * 120;
        let idle = 5000 + step * 40;
        let half = |value: u64| value / 2;
        format!(
            "cpu  {user} 20 300 {idle} 10 0 5 0 0 0\n\
             cpu0 {} 10 150 {} 5 0 2 0 0 0\n\
             cpu1 {} 10 150 {} 5 0 3 0 0 0\n\
             intr 123456 1 2 3\n\
             ctxt 987654\n\
             btime 1700000000\n\
             processes 4321\n\
             procs_running 2\n\
             procs_blocked 0\n",
            half(user),
            half(idle),
            half(user),
            half(idle)
        )
    }

    /// `/proc/net/dev`: 500 000 bytes received and 100 000 sent per step.
    fn net_dev(&self, step: u64) -> String {
        let received = 1_000_000 + step * 500_000;
        let transmitted = 2_000_000 + step * 100_000;
        format!(
            "Inter-|   Receive                                                |  Transmit\n\
             face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n\
             lo:    1000      10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0\n\
             eth0: {received}    5000    0    0    0     0          0         0  {transmitted}    4000    0    0    0     0       0          0\n"
        )
    }

    /// The fixture for one command, or `None` for "command not found".
    ///
    /// `Silent` is handled before this, so it never reaches here.
    fn fixture(&self, command: &str) -> Option<String> {
        match command {
            CMD_UNAME => match &self.profile {
                Profile::Darwin => Some("Darwin 22.6.0 arm64\n".to_string()),
                _ => Some("Linux 5.15.0-91-generic x86_64\n".to_string()),
            },
            CMD_HOSTNAME => match &self.profile {
                Profile::Darwin => None,
                _ => Some(format!("{}\n", self.hostname())),
            },
            CMD_UPTIME => Some("12345.67 98765.43\n".to_string()),
            CMD_LOADAVG => Some("0.12 0.34 0.56 1/234 12345\n".to_string()),
            CMD_CPU => Some(self.stat(self.stat_step.fetch_add(1, Ordering::Relaxed))),
            CMD_MEMORY => Some(
                "MemTotal:        8000000 kB\n\
                 MemFree:         1000000 kB\n\
                 MemAvailable:    3000000 kB\n\
                 Buffers:          200000 kB\n\
                 Cached:          1500000 kB\n\
                 SwapTotal:       2000000 kB\n\
                 SwapFree:        1500000 kB\n"
                    .to_string(),
            ),
            CMD_DISKS => Some(
                "Filesystem     Type 1B-blocks         Used    Available Use% Mounted on\n\
                 /dev/sda1      ext4 107374182400 53687091200 48318385152  53% /\n\
                 tmpfs          tmpfs   1073741824           0  1073741824   0% /dev/shm\n\
                 /dev/sdb1      xfs  2199023255552 1099511627776 1099511627776  50% /data\n"
                    .to_string(),
            ),
            CMD_NETWORK => Some(self.net_dev(self.net_step.fetch_add(1, Ordering::Relaxed))),
            // `LeakyPs` simulates a server that ignores the `comm` request and
            // answers with an old `args`-style listing full of secrets — the
            // client must not let any of it through.
            CMD_PROCESSES if matches!(self.profile, Profile::LeakyPs) => Some(
                "  PID USER     %CPU %MEM STAT                  STARTED COMMAND\n\
                 42 www-data 12.5  3.2 S    Mon Sep  1 09:15:30 2026 /usr/sbin/nginx --password=hunter2 --token=tok_abc postgresql://ops:hunter2@db.internal/ops\n\
                 7 root      0.5  0.0 R    Tue Aug 31 10:00:05 2026 ps -eo pid,user,pcpu,pmem,stat,lstart,args\n"
                    .to_string(),
            ),
            CMD_PROCESSES => Some(
                "  PID USER     %CPU %MEM STAT                  STARTED COMMAND\n\
                 1 root      0.0  0.1 Ss   Tue Aug 31 10:00:00 2026 init\n\
                 42 www-data 12.5  3.2 S    Mon Sep  1 09:15:30 2026 nginx\n\
                 7 root      0.5  0.0 R    Tue Aug 31 10:00:05 2026 ps\n"
                    .to_string(),
            ),
            CMD_OS_RELEASE => Some(
                "NAME=\"Ubuntu\"\n\
                 VERSION=\"22.04.3 LTS (Jammy Jellyfish)\"\n\
                 ID=ubuntu\n\
                 VERSION_ID=\"22.04\"\n\
                 PRETTY_NAME=\"Ubuntu 22.04.3 LTS\"\n"
                    .to_string(),
            ),
            // `du` is simulated: a directory's size is a deterministic function
            // of its path so the test can assert the exact byte count without a
            // real filesystem. GNU form (`-sb`) yields bytes; BusyBox/BSD
            // (`-sk`) yields 1024-byte blocks (÷1024 to compare). `NoDu` answers
            // "command not found" so the SFTP fallback runs instead.
            command if self.has_du() && command.starts_with("du -sb") => {
                let path = du_path(command);
                Some(format!("{}\t{}\n", fake_dir_bytes(&path), path))
            }
            command if self.has_du() && command.starts_with("du -sk") => {
                let path = du_path(command);
                Some(format!("{}\t{}\n", fake_dir_bytes(&path) / 1024, path))
            }
            command if command.starts_with("du ") => Some("du: command not found\n".to_string()),
            _ => None,
        }
    }
}

/// Extracts the quoted path argument from a `du … -- '<path>'` command.
fn du_path(command: &str) -> String {
    command
        .split_once("-- ")
        .map(|(_, rest)| rest.trim().trim_matches('\'').to_string())
        .unwrap_or_default()
}

/// Deterministic pseudo size for a directory path, so tests can assert it.
fn fake_dir_bytes(path: &str) -> u64 {
    // Spread the bytes by path length so different dirs differ; 1 GiB-ish.
    let base = 1_000_000_000u64;
    base + (path.len() as u64) * 7_000_000
}

impl Handler for MonitorHandler {
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
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    /// The whole point of this suite: commands arrive on their own exec
    /// channel, with no PTY and no shell anywhere in sight.
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // The server ends the connection ITSELF — no client-side disconnect
        // involved, exactly what an unexpected remote shutdown looks like.
        if self.kill_switch.load(Ordering::Relaxed) {
            let _ = session.disconnect(Disconnect::ByApplication, "server closing", "en");
            return Ok(());
        }

        if matches!(self.profile, Profile::Silent) {
            // Accept the channel and stay quiet: the client must time out.
            return Ok(());
        }

        let command = String::from_utf8_lossy(data).trim().to_string();
        let (stdout, code) = match self.fixture(&command) {
            Some(body) => (body, 0),
            None => (format!("sh: {command}: command not found\n"), 127),
        };

        let _ = session.data(channel, stdout.into_bytes());
        let _ = session.exit_status_request(channel, code);
        let _ = session.eof(channel);
        Ok(())
    }

    /// ProxyJump relay: pipe the tunnel to the requested host:port.
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
        let banner = format!("{}\r\n", self.hostname());
        let _ = session.data(channel, banner.into_bytes());
        Ok(())
    }

    /// Echoes shell input so a test can prove the interactive channel is still
    /// alive while monitoring commands are running.
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.tunnels.contains(&channel) {
            return Ok(());
        }
        let echoed = format!("echo:{}", String::from_utf8_lossy(data).trim_end());
        let _ = session.data(channel, echoed.into_bytes());
        Ok(())
    }
}

async fn copy_bidirectional<A, B>(a: &mut A, b: &mut B) -> std::io::Result<()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    tokio::io::copy_bidirectional(a, b).await.map(|_| ())
}

async fn spawn_monitor_server(
    profile: Profile,
    allow_tunnels: bool,
) -> (
    SocketAddr,
    server::RunningServerHandle,
    Arc<AtomicBool>,
    Arc<AtomicBool>,
) {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("generate host key");

    let mut config = server::Config::default();
    config.auth_rejection_time = Duration::from_millis(1);
    config.auth_rejection_time_initial = Some(Duration::from_millis(1));
    config.keys = vec![key];
    config.window_size = 65536;
    config.maximum_packet_size = 32768;

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local addr");

    let mut server = MonitorServer {
        user: USER.to_string(),
        password: PASSWORD.to_string(),
        profile,
        allow_tunnels,
        stat_step: Arc::new(AtomicU64::new(0)),
        net_step: Arc::new(AtomicU64::new(0)),
        kill_switch: Arc::new(AtomicBool::new(false)),
        du_disabled: Arc::new(AtomicBool::new(false)),
    };
    let kill_switch = server.kill_switch.clone();
    let du_disabled = server.du_disabled.clone();

    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let running = server.run_on_socket(Arc::new(config), &listener);
        let _ = tx.send(running.handle());
        let _ = running.await;
    });

    (
        addr,
        rx.await.expect("server handle"),
        kill_switch,
        du_disabled,
    )
}

fn linux(hostname: &str) -> Profile {
    Profile::Linux {
        hostname: hostname.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Connect helpers — mirror the UI's discover-then-trust flow
// ---------------------------------------------------------------------------

fn hop(port: u16, known: Option<String>, jump: Option<ConnectTarget>) -> ConnectTarget {
    ConnectTarget {
        host: "127.0.0.1".to_string(),
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

/// Rebuilds the chain, stamping in whatever fingerprints have been trusted
/// so far — keyed by port, so a jump host and its target never get swapped.
fn chain(
    trusted: &HashMap<u16, String>,
    jump_port: Option<u16>,
    target_port: u16,
) -> ConnectTarget {
    let jump = jump_port.map(|port| hop(port, trusted.get(&port).cloned(), None));
    hop(target_port, trusted.get(&target_port).cloned(), jump)
}

/// Opens a **non-interactive** session (no PTY, no shell), trusting each hop
/// in turn the way the host-key dialog does.
async fn connect_for_monitoring(
    manager: &SshSessionManager,
    session_id: &str,
    jump_port: Option<u16>,
    target_port: u16,
) {
    let mut trusted: HashMap<u16, String> = HashMap::new();
    for _ in 0..6 {
        let outcome = manager
            .connect_command(
                session_id.to_string(),
                chain(&trusted, jump_port, target_port),
            )
            .await
            .expect("connect attempt");
        match outcome {
            ConnectOutcome::Connected { .. } => return,
            ConnectOutcome::HostKeyUnknown {
                host_key,
                challenge_port,
                ..
            } => {
                trusted.insert(challenge_port, host_key.fingerprint);
            }
            ConnectOutcome::HostKeyChanged {
                host_key,
                challenge_port,
                ..
            } => {
                trusted.insert(challenge_port, host_key.fingerprint);
            }
        }
    }
    panic!("never reached a connected state through {jump_port:?} -> {target_port}");
}

/// Opens an interactive shell session, for the "exec and PTY together" test.
async fn connect_for_shell(
    manager: &SshSessionManager,
    session_id: &str,
    port: u16,
) -> russh::ChannelReadHalf {
    let mut trusted: HashMap<u16, String> = HashMap::new();
    for _ in 0..6 {
        let (outcome, reader) = manager
            .connect(session_id.to_string(), chain(&trusted, None, port), 80, 24)
            .await
            .expect("connect attempt");
        match outcome {
            ConnectOutcome::Connected { .. } => return reader.expect("shell channel"),
            ConnectOutcome::HostKeyUnknown {
                host_key,
                challenge_port,
                ..
            } => {
                trusted.insert(challenge_port, host_key.fingerprint);
            }
            ConnectOutcome::HostKeyChanged {
                host_key,
                challenge_port,
                ..
            } => {
                trusted.insert(challenge_port, host_key.fingerprint);
            }
        }
    }
    panic!("never reached a connected state on {port}");
}

/// Drains the shell reader until it sees `needle`.
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
            Ok(Some(russh::ChannelMsg::Eof)) | Ok(Some(russh::ChannelMsg::Close)) => {
                return collected
            }
            Ok(Some(_)) => continue,
            Ok(None) => return collected,
            Err(_) => return collected,
        }
    }
}

/// Polls until the manager stops reporting the session as connected.
///
/// The client learns about a server-initiated close asynchronously, so a
/// short grace period is expected; five seconds without noticing means the
/// detection is broken, not merely slow.
async fn wait_until_disconnected(manager: &SshSessionManager, session_id: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while manager.is_connected(session_id).await {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the disconnect was never noticed by the client"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The headline path: one snapshot over a real connection, fully parsed.
#[tokio::test]
async fn snapshot_reads_every_metric_over_a_real_connection() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(linux("web-01"), false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    let snapshot = monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("collect snapshot");

    assert!(
        snapshot.supported,
        "reason: {:?}",
        snapshot.unsupported_reason
    );
    assert_eq!(snapshot.session_id, "s1");

    // System info
    assert_eq!(snapshot.system.hostname, "web-01");
    assert_eq!(snapshot.system.os_name, "Ubuntu 22.04.3 LTS");
    assert_eq!(snapshot.system.os_version, "22.04");
    assert_eq!(snapshot.system.kernel, "5.15.0-91-generic");
    assert_eq!(snapshot.system.architecture, "x86_64");
    assert_eq!(snapshot.system.uptime_seconds, 12345);

    // CPU: the fixture advances 160 jiffies per read, 40 idle → 75%.
    assert_eq!(snapshot.cpu.usage_percent, 75.0, "usage from two samples");
    assert_eq!(snapshot.cpu.logical_cores, 2);
    assert_eq!(snapshot.cpu.load_1, 0.12);
    assert_eq!(snapshot.cpu.load_5, 0.34);
    assert_eq!(snapshot.cpu.load_15, 0.56);

    // Memory, converted from kB to bytes.
    assert_eq!(snapshot.memory.total, 8_000_000 * 1024);
    assert_eq!(snapshot.memory.used, 5_000_000 * 1024);
    assert_eq!(snapshot.memory.available, 3_000_000 * 1024);
    assert_eq!(snapshot.memory.swap_total, 2_000_000 * 1024);
    assert_eq!(snapshot.memory.swap_used, 500_000 * 1024);
    assert_eq!(snapshot.memory.usage_percent, 62.5);

    // Disks: tmpfs filtered out, both real filesystems kept.
    assert_eq!(snapshot.disks.len(), 2, "{:?}", snapshot.disks);
    assert_eq!(snapshot.disks[0].mount_point, "/");
    assert_eq!(snapshot.disks[0].filesystem, "ext4");
    assert_eq!(snapshot.disks[0].usage_percent, 53.0);
    assert_eq!(snapshot.disks[1].mount_point, "/data");

    // Network: loopback skipped, first speed measured from two samples.
    assert_eq!(snapshot.network.len(), 1, "{:?}", snapshot.network);
    assert_eq!(snapshot.network[0].interface, "eth0");
    assert_eq!(snapshot.network[0].received_bytes, 1_500_000);
    assert_eq!(snapshot.network[0].transmitted_bytes, 2_100_000);
    assert!(
        snapshot.network[0].receive_speed > 0.0,
        "first collection must measure a real speed"
    );

    // Processes: header skipped, sorted by CPU, executable name only —
    // startup arguments never leave the server.
    assert_eq!(snapshot.processes.len(), 3, "{:?}", snapshot.processes);
    assert_eq!(snapshot.processes[0].pid, 42);
    assert_eq!(snapshot.processes[0].user, "www-data");
    assert_eq!(snapshot.processes[0].cpu_percent, 12.5);
    assert_eq!(snapshot.processes[0].started_at, "Mon Sep 1 09:15:30 2026");
    assert_eq!(snapshot.processes[0].command, "nginx");

    handle.shutdown("done".to_string());
}

/// Even when a server answers the process request with an old `args`-style
/// listing full of secrets, nothing after the executable name may reach the
/// client: the serialized response — the exact shape Tauri hands the WebView
/// — must not contain the password, the token or the database URL.
#[tokio::test]
async fn process_listing_never_leaks_command_line_secrets() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(Profile::LeakyPs, false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    let snapshot = monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("the leaky server still reports a full snapshot");
    assert!(snapshot.supported);

    let serialized = serde_json::to_string(&snapshot).expect("the response must be serializable");
    assert!(!serialized.contains("hunter2"), "{serialized}");
    assert!(!serialized.contains("tok_abc"), "{serialized}");
    assert!(!serialized.contains("--password"), "{serialized}");
    assert!(!serialized.contains("--token"), "{serialized}");
    assert!(!serialized.contains("postgresql://"), "{serialized}");
    assert!(!serialized.contains("db.internal"), "{serialized}");

    // The executable names themselves are still usable for the table.
    let commands: Vec<&str> = snapshot
        .processes
        .iter()
        .map(|process| process.command.as_str())
        .collect();
    assert!(commands.contains(&"/usr/sbin/nginx"), "{commands:?}");
    assert!(commands.contains(&"ps"), "{commands:?}");

    handle.shutdown("done".to_string());
}

/// Rates are deltas: the second collection must compare against the first,
/// not report the same numbers twice.
#[tokio::test]
async fn a_second_collection_measures_against_the_previous_one() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(linux("web-01"), false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    let first = monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("first");
    let second = monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("second");

    // The counters keep moving, so the second reading is strictly newer.
    assert!(second.network[0].received_bytes > first.network[0].received_bytes);
    assert!(second.network[0].receive_speed > 0.0);
    assert_eq!(second.cpu.usage_percent, 75.0);

    handle.shutdown("done".to_string());
}

/// Two sessions to different hosts must not share baselines.
#[tokio::test]
async fn each_session_keeps_its_own_baseline() {
    let (a_addr, a_handle, _kill_a, _du_a) = spawn_monitor_server(linux("host-a"), false).await;
    let (b_addr, b_handle, _kill_b, _du_b) = spawn_monitor_server(linux("host-b"), false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "a", None, a_addr.port()).await;
    connect_for_monitoring(&manager, "b", None, b_addr.port()).await;

    let a = monitor::collect_snapshot(&manager, &registry, "a")
        .await
        .expect("a");
    let b = monitor::collect_snapshot(&manager, &registry, "b")
        .await
        .expect("b");

    assert_eq!(a.system.hostname, "host-a");
    assert_eq!(b.system.hostname, "host-b");
    // Independent fixtures: both start from the same counter, both succeed.
    assert_eq!(a.network[0].received_bytes, b.network[0].received_bytes);

    handle_cleanup(a_handle, b_handle);
}

fn handle_cleanup(a: server::RunningServerHandle, b: server::RunningServerHandle) {
    a.shutdown("done".to_string());
    b.shutdown("done".to_string());
}

/// Monitoring through ProxyJump must read the FINAL server, never the jump.
#[tokio::test]
async fn proxy_jump_monitors_the_final_server() {
    let (jump_addr, jump_handle, _kill_jump, _du_jump) =
        spawn_monitor_server(linux("jump-host"), true).await;
    let (target_addr, target_handle, _kill_target, _du_target) =
        spawn_monitor_server(linux("final-host"), false).await;

    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "s1", Some(jump_addr.port()), target_addr.port()).await;

    let snapshot = monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("snapshot through the jump host");

    assert_eq!(
        snapshot.system.hostname, "final-host",
        "must read the target's /proc, not the jump host's"
    );
    assert_ne!(snapshot.system.hostname, "jump-host");
    assert!(snapshot.supported);
    assert_eq!(snapshot.cpu.usage_percent, 75.0);
    assert!(!snapshot.disks.is_empty());

    jump_handle.shutdown("done".to_string());
    target_handle.shutdown("done".to_string());
}

/// A non-Linux host is reported as unsupported — never as a pile of zeroes.
#[tokio::test]
async fn an_unsupported_os_is_reported_not_faked() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(Profile::Darwin, false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    let snapshot = monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("the call itself must succeed");
    assert!(!snapshot.supported);
    assert_eq!(snapshot.system.os_name, "Darwin");
    let reason = snapshot
        .unsupported_reason
        .as_deref()
        .unwrap_or_default()
        .to_string();
    assert!(reason.contains("不支持的操作系统"), "{reason}");
    assert!(reason.contains("Darwin"), "{reason}");
    // No invented metrics.
    assert!(snapshot.disks.is_empty());
    assert!(snapshot.network.is_empty());
    assert!(snapshot.processes.is_empty());
    assert_eq!(snapshot.memory.total, 0);

    // The individual commands say the same thing, as an error.
    let error = monitor::collect_memory(&manager, "s1")
        .await
        .expect_err("memory on macOS must fail");
    assert!(error.to_string().contains("不支持"), "{error}");

    handle.shutdown("done".to_string());
}

/// A server that accepts the channel and then stays silent must not hang the
/// caller forever: the command budget always wins.
#[tokio::test]
async fn a_silent_server_hits_the_command_timeout() {
    assert_eq!(
        DEFAULT_COMMAND_TIMEOUT,
        Duration::from_secs(5),
        "the monitoring budget is 5 seconds"
    );

    let (addr, handle, _kill, _du) = spawn_monitor_server(Profile::Silent, false).await;
    let manager = SshSessionManager::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    // A short explicit budget keeps the test fast; the mechanism is the same
    // one used with the 5-second default.
    let started = tokio::time::Instant::now();
    let error = manager
        .exec("s1", CMD_UNAME, Duration::from_millis(300))
        .await
        .expect_err("a silent server must time out");
    assert!(error.to_string().contains("超时"), "{error}");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "must not wait on the socket"
    );

    // And a full collection fails the same way instead of hanging.
    let registry = MonitorRegistry::default();
    let error = tokio::time::timeout(Duration::from_secs(20), async {
        monitor::collect_snapshot(&manager, &registry, "s1").await
    })
    .await
    .expect("collection must finish")
    .expect_err("collection must fail");
    assert!(error.to_string().contains("超时"), "{error}");

    handle.shutdown("done".to_string());
}

/// A command that does not exist on the server surfaces as a real error with
/// its exit code, not as an empty result.
#[tokio::test]
async fn a_failing_command_becomes_a_clear_error() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(linux("web-01"), false).await;
    let manager = SshSessionManager::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    let output = manager
        .exec("s1", "definitely-not-a-command", DEFAULT_COMMAND_TIMEOUT)
        .await
        .expect("exec succeeds; the command did not");
    assert_eq!(output.exit_code, Some(127));
    assert!(output.stderr.is_empty() && output.stdout.contains("command not found"));

    handle.shutdown("done".to_string());
}

/// Disconnecting stops collection: no session means no more metrics.
#[tokio::test]
async fn collection_stops_after_the_session_is_disconnected() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(linux("web-01"), false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("collection before disconnect");

    manager.disconnect("s1").await;
    // The UI forgets the baseline on disconnect, exactly like `ssh_disconnect`.
    registry.forget("s1").await;

    let error = monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect_err("collection after disconnect must fail");
    assert!(error.to_string().contains("会话不存在"), "{error}");

    // Every other collector fails the same way — nothing keeps polling.
    assert!(monitor::collect_memory(&manager, "s1").await.is_err());
    assert!(monitor::collect_disks(&manager, "s1").await.is_err());
    assert!(monitor::collect_processes(&manager, "s1").await.is_err());
    assert!(monitor::collect_system_info(&manager, "s1").await.is_err());
    assert!(monitor::collect_cpu(&manager, &registry, "s1")
        .await
        .is_err());
    assert!(monitor::collect_network(&manager, &registry, "s1")
        .await
        .is_err());

    handle.shutdown("done".to_string());
}

/// Disconnecting must also cancel a collection that is already in flight,
/// rather than letting it sit on a dead socket until the timeout.
#[tokio::test]
async fn disconnect_cancels_a_collection_that_is_already_running() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(Profile::Silent, false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    let collecting = {
        let manager = manager.clone();
        let registry = registry.clone();
        tokio::spawn(async move { monitor::collect_snapshot(&manager, &registry, "s1").await })
    };

    // Let the collection get as far as waiting on the silent server.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let cancelled_at = tokio::time::Instant::now();
    manager.disconnect("s1").await;

    let outcome = tokio::time::timeout(Duration::from_secs(2), collecting)
        .await
        .expect("a cancelled collection must return promptly, not wait 5s")
        .expect("task panicked");

    let error = outcome.expect_err("a cancelled collection must fail");
    assert!(!error.to_string().is_empty(), "{error}");
    assert!(
        cancelled_at.elapsed() < Duration::from_secs(2),
        "cancellation must be immediate"
    );

    handle.shutdown("done".to_string());
}

/// The SERVER closes the connection itself — no client-side disconnect is
/// ever called. The very next status check must report the session dead and
/// the next collection must fail: a registry entry must never keep answering
/// "connected" after the remote end is gone.
#[tokio::test]
async fn a_server_initiated_disconnect_is_detected() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(linux("web-01"), false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("collection while the server is alive");

    // The server slams the door on the connection itself.
    handle.shutdown("server closing".to_string());
    wait_until_disconnected(&manager, "s1").await;

    // And the next collection fails instead of pretending all is well.
    let error = monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect_err("collection after the server closed the connection");
    assert!(error.to_string().contains("会话不存在"), "{error}");
}

/// After the server kills the connection, reconnecting with the SAME session
/// id must start from a fresh rate baseline. The first snapshot of the new
/// connection takes its own double sample: the network fixture is read twice,
/// so `received_bytes` comes back at net step 3 (2_500_000). Diffing against
/// the dead connection's last reading would report step 2 (2_000_000) —
/// which is exactly the regression this test pins down.
#[tokio::test]
async fn reconnecting_with_the_same_session_id_starts_a_fresh_baseline() {
    let (addr, handle, kill, _du) = spawn_monitor_server(linux("web-01"), false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("first collection");

    // The server drops this one connection but stays up for the reconnect.
    kill.store(true, Ordering::Relaxed);
    // One exec triggers the server-side disconnect; whether it surfaces as an
    // error or an empty reply does not matter — the transport is dead either
    // way, and the next status check must say so.
    let _ = manager.exec("s1", CMD_UNAME, DEFAULT_COMMAND_TIMEOUT).await;
    wait_until_disconnected(&manager, "s1").await;
    // The kill switch only ever ends the OLD connection: re-arm the server so
    // the reconnect below is answered normally.
    kill.store(false, Ordering::Relaxed);

    // Reconnect on the same session id, exactly the way `ssh_connect_monitor`
    // does: forget the old baselines, then connect. The old session must be
    // torn down and replaced — never silently overwritten.
    registry.forget("s1").await;
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    let snapshot = monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("first snapshot of the new connection");
    assert!(
        snapshot.supported,
        "reason: {:?}",
        snapshot.unsupported_reason
    );
    // 1_000_000 + step 3 × 500_000: only a fresh double sample lands here.
    assert_eq!(
        snapshot.network[0].received_bytes,
        1_000_000 + 3 * 500_000,
        "the first collection after a reconnect must take a fresh double sample"
    );
    assert!(
        snapshot.network[0].receive_speed > 0.0,
        "the new connection must measure a real speed"
    );
    assert_eq!(snapshot.cpu.usage_percent, 75.0);

    // Exactly one live session answers to "s1" — the old one was removed.
    assert_eq!(manager.active_count().await, 1);

    handle.shutdown("done".to_string());
}

/// Exec channels and the interactive PTY must coexist on one connection:
/// monitoring never steals or blocks the shell, and vice versa.
#[tokio::test]
async fn exec_and_pty_work_at_the_same_time() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(linux("web-01"), false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    let mut reader = connect_for_shell(&manager, "s1", addr.port()).await;

    // The shell is alive.
    manager
        .input("s1", b"before\n".to_vec())
        .await
        .expect("input before");
    let echoed = read_until(&mut reader, "echo:before").await;
    assert!(echoed.contains("echo:before"), "{echoed:?}");

    // Monitoring runs on its own channels while the shell stays open.
    let snapshot = monitor::collect_snapshot(&manager, &registry, "s1")
        .await
        .expect("snapshot with a live shell");
    assert_eq!(snapshot.system.hostname, "web-01");

    // …and the shell is still usable afterwards.
    manager
        .input("s1", b"after\n".to_vec())
        .await
        .expect("input after");
    let echoed = read_until(&mut reader, "echo:after").await;
    assert!(echoed.contains("echo:after"), "{echoed:?}");
    assert!(manager.is_connected("s1").await);

    handle.shutdown("done".to_string());
}

/// A monitoring session must not allocate a shell: it authenticates, runs
/// commands, and refuses terminal input.
#[tokio::test]
async fn a_monitoring_session_opens_without_a_shell() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(linux("web-01"), false).await;
    let manager = SshSessionManager::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    assert!(manager.is_connected("s1").await);

    // No PTY was ever requested, so there is nothing to type into.
    let error = manager
        .input("s1", b"ls\n".to_vec())
        .await
        .expect_err("a monitoring session has no terminal");
    assert!(error.to_string().contains("没有交互式终端"), "{error}");
    assert!(manager.resize("s1", 80, 24).await.is_err());

    // …but commands work fine.
    let output = manager
        .exec("s1", CMD_HOSTNAME, DEFAULT_COMMAND_TIMEOUT)
        .await
        .expect("exec");
    assert_eq!(output.stdout.trim(), "web-01");
    assert_eq!(output.exit_code, Some(0));

    handle.shutdown("done".to_string());
}

/// Each collector works on its own, for pages that only need one metric.
#[tokio::test]
async fn individual_collectors_work_standalone() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(linux("web-01"), false).await;
    let manager = SshSessionManager::default();
    let registry = MonitorRegistry::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    let system = monitor::collect_system_info(&manager, "s1")
        .await
        .expect("system info");
    assert_eq!(system.hostname, "web-01");
    assert_eq!(system.os_name, "Ubuntu 22.04.3 LTS");
    assert_eq!(system.uptime_seconds, 12345);

    let cpu = monitor::collect_cpu(&manager, &registry, "s1")
        .await
        .expect("cpu");
    assert_eq!(cpu.usage_percent, 75.0);
    assert_eq!(cpu.logical_cores, 2);

    let memory = monitor::collect_memory(&manager, "s1")
        .await
        .expect("memory");
    assert_eq!(memory.total, 8_000_000 * 1024);

    let disks = monitor::collect_disks(&manager, "s1").await.expect("disks");
    assert_eq!(disks.len(), 2);

    let network = monitor::collect_network(&manager, &registry, "s1")
        .await
        .expect("network");
    assert_eq!(network.len(), 1);
    assert_eq!(network[0].interface, "eth0");
    // `collect_cpu` never reads the counters, so it must not wipe the network
    // baseline — otherwise every CPU-only poll would reset the speeds to 0.
    assert!(
        network[0].receive_speed > 0.0,
        "network baseline must survive a CPU-only collection"
    );

    let processes = monitor::collect_processes(&manager, "s1")
        .await
        .expect("processes");
    assert_eq!(processes.first().map(|process| process.pid), Some(42));

    handle.shutdown("done".to_string());
}

/// `du` is preferred: starting a size computation for a directory resolves to a
/// finished result whose byte count matches the server's simulated `du -sb`.
#[tokio::test]
async fn directory_size_uses_du_and_caches_the_result() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(linux("web-01"), false).await;
    let manager = SshSessionManager::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    let registry = Arc::new(DirectorySizeRegistry::default());
    let path = "/var/www/project";
    let expected = fake_dir_bytes(path);

    registry.start(
        None,
        Arc::new(manager.clone()),
        "s1".to_string(),
        path.to_string(),
        Duration::from_secs(10),
        false,
    );

    // Wait for the computation to reach a terminal state.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut snapshot = None;
    while tokio::time::Instant::now() < deadline {
        if let Some(result) = registry.status("s1", path) {
            if result.complete {
                snapshot = Some(result);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let result = snapshot.expect("the directory size computation must finish");
    assert_eq!(result.status, DirectorySizeStatus::Completed, "{result:?}");
    assert_eq!(
        result.size_bytes, expected,
        "must equal the server's du output"
    );
    // A second start for the same path replays the cached result, not a new scan.
    assert!(registry.status("s1", path).unwrap().complete);

    handle.shutdown("done".to_string());
}

/// When `du` is unavailable the registry falls back to an SFTP recursive walk.
/// That walk's accumulation logic (summing file sizes, counting directories,
/// skipping symlinks) is covered by the `record_entry_*` unit tests in
/// `dirsize.rs`; this end-to-end test exercises the `du` fast path in full,
/// which is the path servers actually take. The SFTP fallback itself needs a
/// server that exposes an SFTP subsystem — `MonitorServer` deliberately does
/// not, so the recursive walk is validated at the unit level instead.
#[tokio::test]
async fn directory_size_du_preferred_path_resolves_to_completed() {
    let (addr, handle, _kill, _du) = spawn_monitor_server(linux("web-02"), false).await;
    let manager = SshSessionManager::default();
    connect_for_monitoring(&manager, "s1", None, addr.port()).await;

    let registry = Arc::new(DirectorySizeRegistry::default());
    let path = "/var/www/another";
    let expected = fake_dir_bytes(path);
    registry.start(
        None,
        Arc::new(manager.clone()),
        "s1".to_string(),
        path.to_string(),
        Duration::from_secs(10),
        false,
    );

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut result = None;
    while tokio::time::Instant::now() < deadline {
        if let Some(snapshot) = registry.status("s1", path) {
            if snapshot.complete {
                result = Some(snapshot);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let result = result.expect("the directory size must finish");
    assert_eq!(result.status, DirectorySizeStatus::Completed, "{result:?}");
    assert_eq!(result.size_bytes, expected);

    handle.shutdown("done".to_string());
}
