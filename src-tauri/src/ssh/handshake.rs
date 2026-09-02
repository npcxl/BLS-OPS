//! The connection handshake: one hop, host-key verification, ProxyJump
//! tunneling and authentication.

use std::sync::{
    atomic::{AtomicBool, Ordering as AtomicOrdering},
    Arc,
};
use std::time::Duration;

use anyhow::{anyhow, Result};
use russh::client;
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelReadHalf, Disconnect};
use tokio::sync::Mutex;

use super::host_key::{evaluate_host_key, HostKeyVerdict};
use super::model::{ConnectTarget, HostKeyInfo, DEFAULT_KEEPALIVE_SECS};
use super::session::{SessionWriter, SshSession};

/// A completed hop: its handle, its shell channel (final hop only) and the
/// handles that must stay alive for the tunnel to keep working.
pub(crate) struct HopConnection {
    pub(crate) handle: client::Handle<ClientHandler>,
    /// `None` for jump hops, which are tunnels only.
    pub(crate) channel: Option<(ChannelReadHalf, SessionWriter)>,
    pub(crate) host_key: HostKeyInfo,
    /// Liveness flag shared with this hop's client handler.
    pub(crate) dead: Arc<AtomicBool>,
    pub(crate) chain: Vec<client::Handle<ClientHandler>>,
}

pub(crate) enum HopResult {
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

/// Opens one hop, including nested jump hosts.
///
/// `cols`/`rows` of 0 skip the PTY + shell entirely — jump hops are pure
/// tunnels, and non-interactive sessions (monitoring) want no shell either.
pub(crate) async fn connect_hop(target: &ConnectTarget, cols: u32, rows: u32) -> Result<HopResult> {
    let observed: Arc<Mutex<Option<HostKeyInfo>>> = Arc::new(Mutex::new(None));
    let dead = Arc::new(AtomicBool::new(false));
    let handler = ClientHandler {
        expected: target.known_fingerprint.clone(),
        observed: observed.clone(),
        dead: dead.clone(),
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
        dead,
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

/// russh handler: captures the server's key, refuses anything not already
/// trusted, and records the transport's death for the session registry.
#[derive(Clone)]
pub(crate) struct ClientHandler {
    pub(crate) expected: Option<String>,
    pub(crate) observed: Arc<Mutex<Option<HostKeyInfo>>>,
    /// Flipped as soon as russh reports the transport going away, so the
    /// session registry stops calling a dead connection "connected".
    pub(crate) dead: Arc<AtomicBool>,
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

    /// The server sent a disconnect (or the transport errored): record the
    /// death so `ssh_status` stops reporting this session as connected even
    /// though nobody called an explicit disconnect on it.
    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        self.dead.store(true, AtomicOrdering::Relaxed);
        match reason {
            client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            client::DisconnectReason::Error(error) => Err(error),
        }
    }
}
