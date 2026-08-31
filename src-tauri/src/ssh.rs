use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{anyhow, Result};
use russh::client;
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelReadHalf, ChannelWriteHalf, Disconnect};
use serde::Serialize;
use tokio::sync::Mutex;

/// How often an idle session sends a keepalive probe; also drives russh's
/// `keepalive_max` disconnect detection.
pub const DEFAULT_KEEPALIVE_SECS: u64 = 30;

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
}

impl SshSession {
    /// Best-effort teardown. Each step is attempted even if an earlier one
    /// fails, so the remote side is told to release the session.
    async fn shutdown(&self) {
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
        evaluate_host_key, parse_ssh_target, ConnectOutcome, ConnectTarget, CredentialSecrets,
        Endpoint, HostKeyInfo, HostKeyVerdict,
    };

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
}
