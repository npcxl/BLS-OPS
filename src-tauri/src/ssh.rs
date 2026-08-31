use std::{collections::HashMap, sync::Arc};

use anyhow::{anyhow, Result};
use russh::client;
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelReadHalf;
use tokio::sync::Mutex;

use crate::db::{CredentialRecord, ServerRecord};

struct InteractiveSession {
    handle: client::Handle<ClientHandler>,
    writer: russh::ChannelWriteHalf<russh::client::Msg>,
}

#[derive(Clone, Default)]
pub struct SshSessionManager {
    sessions: Arc<Mutex<HashMap<String, InteractiveSession>>>,
}

impl SshSessionManager {
    pub async fn connect(
        &self,
        session_id: String,
        server: ServerRecord,
        credential: CredentialRecord,
        secret: String,
        expected_fingerprint: Option<String>,
    ) -> Result<ChannelReadHalf> {
        let config = Arc::new(client::Config::default());
        let mut handle = client::connect(
            config,
            (server.host.as_str(), server.port as u16),
            ClientHandler {
                expected_fingerprint,
            },
        )
        .await?;

        let channel = match credential.credential_type.as_str() {
            "password" => {
                let authenticated = handle.authenticate_password(server.username.clone(), secret).await?;
                if !authenticated.success() {
                    return Err(anyhow!("SSH 用户名或密码验证失败"));
                }
                handle.channel_open_session().await?
            }
            "private_key" | "private_key_passphrase" => {
                let private_key = decode_secret_key(&secret, None)?;
                let authenticated = handle
                    .authenticate_publickey(
                        server.username.clone(),
                        PrivateKeyWithHashAlg::new(Arc::new(private_key), None),
                    )
                    .await?;
                if !authenticated.success() {
                    return Err(anyhow!("SSH 私钥认证失败"));
                }
                handle.channel_open_session().await?
            }
            other => return Err(anyhow!("不支持的凭据类型: {other}")),
        };

        channel.request_pty(true, "xterm-256color", 120, 32, 0, 0, &[]).await?;
        channel.request_shell(true).await?;
        let (reader, writer) = channel.split();
        self.sessions.lock().await.insert(session_id, InteractiveSession { handle, writer });
        Ok(reader)
    }

    pub async fn input(&self, session_id: &str, data: String) -> Result<()> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(session_id).ok_or_else(|| anyhow!("SSH 会话不存在"))?;
        session.writer.data_bytes(data.into_bytes()).await?;
        Ok(())
    }

    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<()> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(session_id).ok_or_else(|| anyhow!("SSH 会话不存在"))?;
        session.writer.window_change(cols, rows, 0, 0).await?;
        Ok(())
    }

    pub async fn disconnect(&self, session_id: &str) {
        self.sessions.lock().await.remove(session_id);
    }
}

struct ClientHandler {
    expected_fingerprint: Option<String>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        let expected = self.expected_fingerprint.clone();
        let actual = format!("{}", server_public_key.public_key().fingerprint(HashAlg::Sha256));
        async move { Ok(expected.is_some_and(|fingerprint| fingerprint == actual)) }
    }
}
