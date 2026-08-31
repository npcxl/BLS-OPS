//! End-to-end tests against a real SSH server running in-process.
//!
//! These exercise the exact paths the desktop app uses — handshake, host key
//! trust, password auth, ProxyJump — without needing a machine to SSH into.
//! A regression in the host-key flow shows up here as a failing test.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use ops_workbench_lib::ssh::{ConnectOutcome, ConnectTarget, CredentialSecrets, SshSessionManager};
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{self, Auth, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId, Disconnect};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};

const USER: &str = "opsuser";
const PASSWORD: &str = "opspass";

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
}

impl server::Server for TestServer {
    type Handler = TestHandler;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> TestHandler {
        TestHandler {
            user: self.user.clone(),
            password: self.password.clone(),
            banner: self.banner.clone(),
            allow_tunnels: self.allow_tunnels,
            tunnels: std::collections::HashSet::new(),
        }
    }
}

struct TestHandler {
    user: String,
    password: String,
    banner: String,
    allow_tunnels: bool,
    /// Channels being relayed as tunnels. Data on these belongs to whatever
    /// protocol is tunnelled (here: another SSH session), so it must be
    /// forwarded byte-for-byte — echoing it would corrupt the inner stream.
    tunnels: std::collections::HashSet<ChannelId>,
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
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
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
        if self.tunnels.contains(&channel) {
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
