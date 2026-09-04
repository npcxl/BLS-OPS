//! The session registry: connect, I/O, keepalive, disconnect.
//!
//! The registry lock is only ever held long enough to look a session up —
//! never across network I/O — so a stuck server blocks only its own session.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use russh::ChannelReadHalf;
use tokio::sync::{watch, Mutex};

use super::decoder::SessionEncoding;
use super::handshake::{connect_hop, HopResult};
use super::model::{ConnectOutcome, ConnectTarget, ExecOutput};
use super::session::SshSession;

/// Registry of live sessions — interactive shells and non-interactive
/// (monitoring) connections alike.
#[derive(Clone, Default)]
pub struct SshSessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SshSession>>>>,
}

impl SshSessionManager {
    /// Looks a session up and releases the registry lock before returning.
    ///
    /// A session whose transport has died is removed on sight: keeping it
    /// would make `is_connected` answer "yes" forever after the server
    /// dropped the connection on its own.
    pub(crate) async fn get(&self, session_id: &str) -> Result<Arc<SshSession>> {
        let session = {
            let mut sessions = self.sessions.lock().await;
            match sessions.get(session_id).cloned() {
                Some(session) if session.is_alive() => Some(session),
                Some(stale) => {
                    sessions.remove(session_id);
                    stale.mark_dead();
                    None
                }
                None => None,
            }
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
        self.connect_with(session_id, target, cols, rows).await
    }

    /// Opens a session for non-interactive use (monitoring). No PTY and no
    /// shell are requested — commands run on their own short-lived exec
    /// channels, so nothing consumes a shell on the server.
    pub async fn connect_command(
        &self,
        session_id: String,
        target: ConnectTarget,
    ) -> Result<ConnectOutcome> {
        let (outcome, _) = self.connect_with(session_id, target, 0, 0).await?;
        Ok(outcome)
    }

    /// Shared connect path. `cols`/`rows` of 0 skip the PTY + shell entirely
    /// (see `connect_hop`), which is what non-interactive sessions want.
    ///
    /// A reconnect on the same id replaces the old session outright: the old
    /// connection is torn down and removed *before* the new handshake starts.
    /// A plain insert would silently overwrite it, orphaning its channels and
    /// SFTP client while its handle kept running.
    async fn connect_with(
        &self,
        session_id: String,
        target: ConnectTarget,
        cols: u32,
        rows: u32,
    ) -> Result<(ConnectOutcome, Option<ChannelReadHalf>)> {
        let stale = self.sessions.lock().await.remove(&session_id);
        if let Some(old) = stale {
            old.shutdown().await;
        }

        match connect_hop(&target, cols, rows).await? {
            HopResult::Connected(connection) => {
                let host_key = connection.host_key;
                let (reader, writer) = match connection.channel {
                    Some((reader, writer)) => (Some(reader), Some(writer)),
                    None => (None, None),
                };
                self.sessions.lock().await.insert(
                    session_id,
                    Arc::new(SshSession {
                        handle: connection.handle,
                        writer: Mutex::new(writer),
                        closed: watch::channel(false).0,
                        dead: connection.dead,
                        _chain: connection.chain,
                        sftp: Mutex::new(None),
                        cwd: Mutex::new(None),
                        encoding: Mutex::new(SessionEncoding::Auto),
                    }),
                );
                Ok((ConnectOutcome::Connected { host_key }, reader))
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

    /// 当前的输出编码（会话不存在返回 `None`）。reader 循环每块读一次，
    /// 所以设置**运行时可改**。
    pub async fn encoding(&self, session_id: &str) -> Option<SessionEncoding> {
        let session = self.sessions.lock().await.get(session_id).cloned();
        match session {
            Some(session) => Some(*session.encoding.lock().await),
            None => None,
        }
    }

    /// 切换输出编码。返回切换后的值（便于前端回显真实状态）。
    pub async fn set_encoding(
        &self,
        session_id: &str,
        encoding: SessionEncoding,
    ) -> Result<SessionEncoding> {
        let session = self.get(session_id).await?;
        *session.encoding.lock().await = encoding;
        Ok(encoding)
    }

    pub async fn input(&self, session_id: &str, data: Vec<u8>) -> Result<()> {
        let session = self.get(session_id).await?;
        let mut writer = session.writer.lock().await;
        let writer = writer
            .as_mut()
            .ok_or_else(|| anyhow!("该会话没有交互式终端"))?;
        writer.data_bytes(data).await?;
        Ok(())
    }

    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<()> {
        let session = self.get(session_id).await?;
        let mut writer = session.writer.lock().await;
        let writer = writer
            .as_mut()
            .ok_or_else(|| anyhow!("该会话没有交互式终端"))?;
        writer.window_change(cols, rows, 0, 0).await?;
        Ok(())
    }

    /// Runs one command on its own exec channel of a live session.
    ///
    /// The registry lock is released before any network I/O, and the command is
    /// cancelled if the session is disconnected while it is running.
    pub async fn exec(
        &self,
        session_id: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<ExecOutput> {
        let session = self.get(session_id).await?;
        session.exec(command, timeout).await
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

    /// True only while the transport underneath is still alive.
    ///
    /// A remote-initiated close, a transport error or keepalive giving up all
    /// make this answer `false` (and evict the dead session), even though the
    /// registry entry itself has not been touched by an explicit disconnect.
    pub async fn is_connected(&self, session_id: &str) -> bool {
        let mut sessions = self.sessions.lock().await;
        match sessions.get(session_id).cloned() {
            Some(session) if session.is_alive() => true,
            Some(stale) => {
                sessions.remove(session_id);
                stale.mark_dead();
                false
            }
            None => false,
        }
    }

    /// Number of sessions whose transport is still alive; dead entries are
    /// evicted so the status bar never counts ghosts.
    pub async fn active_count(&self) -> usize {
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, session| {
            if session.is_alive() {
                true
            } else {
                session.mark_dead();
                false
            }
        });
        sessions.len()
    }
}
