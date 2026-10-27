//! SSH 隧道：在 **回环地址** 上开一个临时端口，把 TCP 转发到远端 MySQL。
//!
//! 设计要点（每条都对应一条硬要求）：
//!
//! * **只绑定 `127.0.0.1`，端口由系统分配（`:0`）**。绝不监听 `0.0.0.0`，
//!   也绝不修改远端防火墙。
//! * **复用现有 SSH 握手**：`ssh::connect_hop` 做主机指纹校验 + 认证 +
//!   ProxyJump，和终端会话完全同一条路径。指纹未确认时隧道**不会**建立 ——
//!   错误里带着指纹与端点，由前端提示用户先信任主机。
//! * **按 (SSH 服务器, 数据库端点) 共享 + 引用计数**：同一个 SSH 服务器上
//!   开了两个 SQL 编辑器标签，只建一条 SSH 连接；关掉一个标签不会拆掉
//!   另一个还在用的隧道。
//! * **不缓存失败**：建隧道失败不会留下半个 listener。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use rusqlite::Connection;
use tokio::net::TcpListener;
use tokio::sync::{watch, Mutex};

use crate::ssh::{connect_hop, ConnectTarget, CredentialSecrets, HopConnection, HopResult};

use super::model::DbErrorInfo;

/// 一条活着的隧道。
pub struct Tunnel {
    local_port: u16,
    users: AtomicUsize,
    shutdown: watch::Sender<bool>,
    /// 保持 SSH 连接（含 ProxyJump 链）不被 drop。
    /// `russh::client::Handle` 不是 `Clone`，所以用 `Arc<Mutex<…>>` 共享：
    /// accept 循环里只在"打开 direct-tcpip 通道"这一小段持有锁。
    _hop: Arc<Mutex<HopConnection>>,
}

impl Tunnel {
    pub fn local_port(&self) -> u16 {
        self.local_port
    }
}

/// 租约：最后一个使用者释放时关闭隧道。
pub struct TunnelLease {
    tunnel: Arc<Tunnel>,
}

impl TunnelLease {
    pub fn local_port(&self) -> u16 {
        self.tunnel.local_port
    }
}

impl Drop for TunnelLease {
    fn drop(&mut self) {
        // `fetch_sub` 返回旧值：从 1 → 0 才是最后一个使用者。
        if self.tunnel.users.fetch_sub(1, Ordering::AcqRel) == 1 {
            // watch::Sender::send 是同步的；accept 循环收到后退出，
            // SSH handle 随 Tunnel 一起 drop。
            let _ = self.tunnel.shutdown.send(true);
        }
    }
}

/// 隧道注册表：`key = ssh_server_id + "\u{1}" + db_host:db_port`。
#[derive(Clone, Default)]
pub struct TunnelRegistry {
    tunnels: Arc<Mutex<HashMap<String, Arc<Tunnel>>>>,
}

fn tunnel_key(ssh_server_id: &str, host: &str, port: u16) -> String {
    format!("{ssh_server_id}\u{1}{host}:{port}")
}

impl TunnelRegistry {
    pub async fn acquire(
        &self,
        ssh_server_id: &str,
        db_host: &str,
        db_port: u16,
        target: ConnectTarget,
    ) -> Result<TunnelLease, DbErrorInfo> {
        let key = tunnel_key(ssh_server_id, db_host, db_port);

        // 先看有没有活着的：registry 锁只在查表时持有，绝不在握手中持有。
        {
            let mut tunnels = self.tunnels.lock().await;
            if let Some(existing) = tunnels.get(&key) {
                if !existing.shutdown.is_closed() {
                    existing.users.fetch_add(1, Ordering::AcqRel);
                    return Ok(TunnelLease {
                        tunnel: existing.clone(),
                    });
                }
                tunnels.remove(&key);
            }
        }

        let hop = match connect_hop(&target, 0, 0)
            .await
            .map_err(|error| DbErrorInfo::new("ssh_tunnel", format!("SSH 隧道建立失败：{error}")))?
        {
            HopResult::Connected(connection) => connection,
            HopResult::HostKeyUnknown {
                host_key,
                host,
                port,
            } => {
                return Err(DbErrorInfo::new(
                    "ssh_tunnel",
                    format!("SSH 主机指纹未确认：{host}:{port}"),
                )
                .with_detail(format!(
                    "{} 指纹 {}。请先在「服务器」中连接一次该服务器并确认主机指纹，再建立数据库隧道。",
                    host_key.key_type, host_key.fingerprint
                )));
            }
            HopResult::HostKeyChanged {
                host_key,
                known,
                host,
                port,
            } => {
                return Err(DbErrorInfo::new(
                    "ssh_tunnel",
                    format!("SSH 主机指纹发生变化：{host}:{port}"),
                )
                .with_detail(format!(
                    "已记录 {}，本次为 {}。可能是中间人攻击，请先在「服务器」中核对指纹。",
                    known, host_key.fingerprint
                )));
            }
        };

        // 端口由系统动态分配；`TcpListener::bind` 在 IPv4 回环上。
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| {
            DbErrorInfo::new("ssh_tunnel", format!("无法绑定回环端口：{error}"))
        })?;
        let local_port = listener
            .local_addr()
            .map_err(|error| DbErrorInfo::new("ssh_tunnel", format!("无法读取本地端口：{error}")))?
            .port();

        let hop = Arc::new(Mutex::new(hop));
        let accept_hop = hop.clone();
        let remote_host = db_host.to_string();
        let remote_port = u32::from(db_port);
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => break,
                    accepted = listener.accept() => {
                        let (tcp, _peer) = match accepted {
                            Ok(value) => value,
                            Err(_) => continue,
                        };
                        let hop = accept_hop.clone();
                        let host = remote_host.clone();
                        tokio::spawn(async move {
                            let channel = {
                                let guard = hop.lock().await;
                                guard
                                    .handle
                                    .channel_open_direct_tcpip(
                                        host,
                                        remote_port,
                                        "127.0.0.1".to_string(),
                                        0,
                                    )
                                    .await
                            };
                            match channel {
                                Ok(channel) => {
                                    let mut stream = channel.into_stream();
                                    let mut tcp = tcp;
                                    // 任一侧关闭即结束；错误只影响这一个连接。
                                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                                }
                                Err(_) => {
                                    // 远端拒绝通道：直接关闭本地连接，由 MySQL 驱动
                                    // 报出连接失败（而不是静默重试）。
                                }
                            }
                        });
                    }
                }
            }
        });

        let tunnel = Arc::new(Tunnel {
            local_port,
            users: AtomicUsize::new(1),
            shutdown: shutdown_tx,
            _hop: hop,
        });
        self.tunnels.lock().await.insert(key, tunnel.clone());

        Ok(TunnelLease { tunnel })
    }

    /// 关闭并移除某台 SSH 服务器相关的所有空闲隧道。
    pub async fn close_for_server(&self, ssh_server_id: &str) {
        let mut tunnels = self.tunnels.lock().await;
        let keys: Vec<String> = tunnels
            .keys()
            .filter(|key| key.starts_with(&format!("{ssh_server_id}\u{1}")))
            .cloned()
            .collect();
        for key in keys {
            if let Some(tunnel) = tunnels.remove(&key) {
                let _ = tunnel.shutdown.send(true);
            }
        }
    }

    pub async fn active_count(&self) -> usize {
        self.tunnels.lock().await.len()
    }
}

/// 把一条已保存的 SSH 服务器展开成 `ConnectTarget`（含 ProxyJump 链）。
///
/// 与 `commands/ssh.rs` 的 `build_target` 保持同样的语义：凭据只从钥匙串读、
/// 只使用 `confirmed` 的主机指纹、跳板机可以继续嵌套。这里不传一次性密码 ——
/// 数据库隧道不允许“临时密码”，必须是已保存的凭据。
pub fn resolve_ssh_target(
    conn: &Connection,
    server_id: &str,
    visiting: &mut HashSet<String>,
) -> Result<ConnectTarget> {
    if !visiting.insert(server_id.to_string()) {
        return Err(anyhow!("SSH 跳板配置存在循环引用"));
    }
    if visiting.len() > 5 {
        return Err(anyhow!("SSH 跳板层数过多（最多 5 层）"));
    }

    let server = crate::db::get_server(conn, server_id)?
        .ok_or_else(|| anyhow!("所选 SSH 服务器不存在或已被删除"))?;

    let credential_id = server
        .credential_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("SSH 服务器“{}”没有选择凭据", server.name))?;
    let credential = crate::db::get_credential(conn, credential_id)?
        .ok_or_else(|| anyhow!("SSH 服务器“{}”的凭据已不存在", server.name))?;

    let secret_ref = credential
        .secret_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("凭据“{}”没有保存密钥材料", credential.name))?;
    let secret = crate::keyring::read_secret(secret_ref)
        .map_err(|error| anyhow!("无法从系统钥匙串读取“{}”：{error}", credential.name))?;
    let passphrase = match credential
        .passphrase_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(reference) => Some(
            crate::keyring::read_secret(reference)
                .map_err(|error| anyhow!("无法读取私钥口令：{error}"))?,
        ),
        None => None,
    };

    let known_fingerprint = crate::db::get_known_host(conn, &server.host, server.port)?
        .filter(|record| record.status == "confirmed")
        .map(|record| record.fingerprint);

    let proxy_jump = match server
        .proxy_jump_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(jump_id) => Some(Box::new(resolve_ssh_target(conn, jump_id, visiting)?)),
        None => None,
    };

    let port =
        u16::try_from(server.port).map_err(|_| anyhow!("SSH 服务器“{}”的端口无效", server.name))?;

    Ok(ConnectTarget {
        host: server.host,
        port,
        username: server.username,
        secrets: CredentialSecrets {
            credential_type: credential.credential_type,
            secret,
            passphrase,
        },
        known_fingerprint,
        proxy_jump,
    })
}
