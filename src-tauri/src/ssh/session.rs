//! One live session: its channels, exec, SFTP client handle and teardown.

use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        Arc,
    },
    time::Duration,
};

use anyhow::{anyhow, Result};
use russh::client;
use russh::{ChannelMsg, ChannelReadHalf, Disconnect};
use russh_sftp::client::SftpSession;
use tokio::io::AsyncWriteExt;
use tokio::sync::{watch, Mutex};

use super::decoder::SessionEncoding;
use super::handshake::ClientHandler;
use super::model::{ExecOutput, SFTP_SUBSYSTEM};
use super::sftp::sftp_error;

pub(crate) type SessionWriter = ChannelWriteHalf<client::Msg>;
use russh::ChannelWriteHalf;

/// One live session.
///
/// The writer sits behind its own lock: slow or stuck I/O on one session must
/// never block input, resize or keepalive on another. The registry below is
/// only ever held long enough to look a session up.
pub(crate) struct SshSession {
    pub(crate) handle: client::Handle<ClientHandler>,
    /// `None` for non-interactive sessions (monitoring): those never open a
    /// shell channel and run each command on its own exec channel instead.
    pub(crate) writer: Mutex<Option<SessionWriter>>,
    /// Flipped once when the session is torn down. Every in-flight command
    /// selects on it, so a disconnect cancels work instead of leaving it
    /// waiting on a dead socket.
    pub(crate) closed: watch::Sender<bool>,
    /// Liveness of the underlying transport, shared with this hop's client
    /// handler: the handler flips it when the server disconnects or the
    /// transport errors, so an unexpected remote shutdown can be told apart
    /// from a mere command failure.
    pub(crate) dead: Arc<AtomicBool>,
    /// Jump-host handles must outlive the tunneled session, otherwise the
    /// direct-tcpip channel is dropped and the connection dies.
    pub(crate) _chain: Vec<client::Handle<ClientHandler>>,
    /// Lazily opened SFTP client for this session. Each session owns one, so
    /// sessions never share a browser; dropped on disconnect. `SftpSession`
    /// itself is not `Clone`, but its operations only need `&self`, so the
    /// session lives in an `Arc` that callers can clone cheaply — nobody holds
    /// this lock across network I/O.
    pub(crate) sftp: Mutex<Option<Arc<SftpSession>>>,
    /// Last canonical directory this session's file browser viewed.
    pub(crate) cwd: Mutex<Option<String>>,
    /// 输出编码设置（`auto` / `utf8` / `gb18030` / `big5`）。
    ///
    /// 不是连接参数，可**运行时修改**（老服务器接不上 UTF-8 时现场切）；
    /// reader 循环每收到一块就读一次，切换后从下一块生效。
    pub(crate) encoding: Mutex<SessionEncoding>,
}

impl SshSession {
    /// Whether the transport underneath is still alive.
    ///
    /// Two independent signals: the `dead` flag (set by the handler's
    /// `disconnected` callback or by an exec that could not create a channel)
    /// and russh's own handle, which is closed as soon as its connection task
    /// ends — remote close, transport error, keepalive timeout.
    pub(crate) fn is_alive(&self) -> bool {
        !self.dead.load(AtomicOrdering::Relaxed) && !self.handle.is_closed()
    }

    /// Marks the transport as gone and cancels every in-flight command.
    pub(crate) fn mark_dead(&self) {
        self.dead.store(true, AtomicOrdering::Relaxed);
        // Commands waiting on this session must stop immediately.
        let _ = self.closed.send(true);
    }

    /// Returns the session's SFTP client, opening the subsystem channel on
    /// first use.
    ///
    /// Opening a second channel for SFTP leaves the shell channel untouched —
    /// both work simultaneously over the same connection.
    pub(crate) async fn sftp_client(&self) -> Result<Arc<SftpSession>> {
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

    /// Runs one command on a dedicated exec channel — never a PTY, never the
    /// interactive shell.
    ///
    /// A shell channel echoes prompts and would interleave command output with
    /// whatever the user happens to be typing, so monitoring always opens its
    /// own channel, reads until the exit status, and closes the channel before
    /// returning. The whole call is bounded by `timeout` and is cancelled the
    /// moment the session is disconnected.
    pub(crate) async fn exec(&self, command: &str, timeout: Duration) -> Result<ExecOutput> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut closed = self.closed.subscribe();

        let opened = timed(
            self.handle.channel_open_session(),
            deadline,
            &mut closed,
            timeout,
        )
        .await;
        let mut channel = match opened {
            Ok(Ok(channel)) => channel,
            // A failure to open a channel rides on the transport: a send
            // error, a hang-up or a dropped reply mean the connection itself
            // is gone. A server-side `ChannelOpenFailure` only refuses *this
            // one* channel while the session stays healthy — the two must
            // never be confused, and a plain command failure (a parse error
            // downstream) never even reaches this branch.
            Ok(Err(error)) => {
                let transport_gone = matches!(
                    error,
                    russh::Error::SendError | russh::Error::Disconnect | russh::Error::HUP
                ) || self.handle.is_closed();
                if transport_gone {
                    self.mark_dead();
                }
                return Err(anyhow!("SSH 通道创建失败：{error}"));
            }
            // Budget expiry alone is not evidence of a dead transport.
            Err(deadline_error) => return Err(deadline_error),
        };

        let outcome: Result<ExecOutput> = async {
            timed(
                channel.exec(true, command.as_bytes()),
                deadline,
                &mut closed,
                timeout,
            )
            .await??;

            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut exit_code = None;

            loop {
                let message = match timed(channel.wait(), deadline, &mut closed, timeout).await? {
                    Some(message) => message,
                    None => break,
                };
                match message {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    // OpenSSH sends exit-status before eof, so eof after a
                    // status means the command is finished; a bare eof may
                    // still be followed by the status.
                    ChannelMsg::Eof if exit_code.is_some() => break,
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }

            Ok(ExecOutput {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                exit_code,
            })
        }
        .await;

        // A command owns its channel: close it whether the run succeeded,
        // timed out or was cancelled.
        let _ = channel.close().await;
        outcome
    }

    /// Best-effort teardown. Each step is attempted even if an earlier one
    /// fails, so the remote side is told to release the session.
    pub(crate) async fn shutdown(&self) {
        // Cancels every command still waiting on this session.
        let _ = self.closed.send(true);
        // Close SFTP while the connection is still alive so it sees a clean
        // EOF instead of dying with the socket.
        if let Some(sftp) = self.sftp.lock().await.take() {
            let _ = sftp.close().await;
        }
        {
            let mut writer = self.writer.lock().await;
            if let Some(writer) = writer.as_mut() {
                // Tell the pty we're done writing, then close the channel.
                let _ = writer.eof().await;
                let _ = writer.close().await;
            }
        }
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "client closed the session", "en")
            .await;
    }
}

/// Awaits `future` but gives up as soon as `deadline` passes or the session is
/// disconnected, so neither a stuck command nor a dropped connection can hold
/// a caller (or a channel) forever.
pub(crate) async fn timed<F>(
    future: F,
    deadline: tokio::time::Instant,
    closed: &mut watch::Receiver<bool>,
    timeout: Duration,
) -> Result<F::Output>
where
    F: Future,
{
    tokio::select! {
        output = future => Ok(output),
        _ = tokio::time::sleep_until(deadline) => {
            Err(anyhow!("命令执行超时（超过 {} 秒）", timeout.as_secs()))
        }
        // Both `Ok` (session closed) and `Err` (session dropped) mean stop.
        _ = closed.changed() => Err(anyhow!("SSH 会话已断开，命令已取消")),
    }
}
