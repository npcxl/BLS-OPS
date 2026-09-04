//! Interactive SSH commands: connect (terminal & monitor), I/O, keepalive,
//! disconnect, and the connection test probe.

use rusqlite::Connection;
use tauri::Emitter;
use tauri::State;

use super::{open_db, record_audit, require_existing_credential, DEFAULT_SSH_PORT};
use crate::{
    db,
    db::CredentialRecord,
    keyring,
    ssh::{ConnectTarget, CredentialSecrets, Utf8StreamDecoder},
    state::AppState,
};

/// Returned by `ssh_connect` / `server_test_connection`.
///
/// `host` / `port` always describe the final destination (what the user sees
/// in the tab). `challenge_host` / `challenge_port` describe the endpoint whose
/// key must be trusted — with ProxyJump that is the jump host. The UI must save
/// the fingerprint under the *challenge* endpoint; saving it under `host`
/// would loop forever on a two-hop connection.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum SshConnectResult {
    Connected {
        session_id: String,
        host: String,
        port: i64,
        fingerprint: String,
        fingerprint_type: String,
    },
    HostKeyUnknown {
        session_id: String,
        /// Endpoint to trust — a jump host when ProxyJump is in play.
        challenge_host: String,
        challenge_port: i64,
        /// Final destination, for display only.
        host: String,
        port: i64,
        fingerprint: String,
        fingerprint_type: String,
    },
    HostKeyChanged {
        session_id: String,
        /// Endpoint to re-trust — a jump host when ProxyJump is in play.
        challenge_host: String,
        challenge_port: i64,
        /// Final destination, for display only.
        host: String,
        port: i64,
        fingerprint: String,
        fingerprint_type: String,
        known_fingerprint: String,
    },
}

/// Reads the keyring material for a credential. Rust-only: the secret never
/// crosses the IPC boundary.
fn load_secrets(credential: &CredentialRecord) -> Result<CredentialSecrets, String> {
    let secret_ref = credential
        .secret_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("凭据“{}”没有保存密钥材料，请编辑凭据补充", credential.name))?;
    let secret = keyring::read_secret(secret_ref)
        .map_err(|error| format!("无法从系统凭据管理器读取“{}”：{error}", credential.name))?;

    let passphrase = match credential
        .passphrase_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(reference) => Some(
            keyring::read_secret(reference)
                .map_err(|error| format!("无法读取“{}”的私钥口令：{error}", credential.name))?,
        ),
        None => None,
    };

    Ok(CredentialSecrets {
        credential_type: credential.credential_type.clone(),
        secret,
        passphrase,
    })
}

/// Builds one hop of the connection.
///
/// `one_time_password` is used as-is and never persisted — it never reaches the
/// keyring or the database. It applies to this hop only; a jump host keeps
/// using its own stored credential, because the typed password is for the
/// destination the user named.
fn build_target(
    conn: &Connection,
    host: String,
    port: i64,
    username: String,
    credential_id: Option<String>,
    one_time_password: Option<String>,
    proxy_jump_id: Option<String>,
) -> Result<ConnectTarget, String> {
    let secrets = match one_time_password {
        Some(password) => CredentialSecrets {
            credential_type: "password".to_string(),
            secret: password,
            passphrase: None,
        },
        None => {
            let credential_id = credential_id.ok_or_else(|| "请先为该连接选择凭据".to_string())?;
            let credential = require_existing_credential(conn, &credential_id)?;
            load_secrets(&credential)?
        }
    };

    let known_fingerprint = db::get_known_host(conn, &host, port)
        .map_err(|error| error.to_string())?
        .filter(|record| record.status == "confirmed")
        .map(|record| record.fingerprint);

    let proxy_jump = match proxy_jump_id.filter(|value| !value.trim().is_empty()) {
        Some(jump_id) => {
            let jump = db::get_server(conn, &jump_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "所选跳板机不存在".to_string())?;
            Some(Box::new(build_target(
                conn,
                jump.host,
                jump.port,
                jump.username,
                jump.credential_id,
                None,
                jump.proxy_jump_id,
            )?))
        }
        None => None,
    };

    Ok(ConnectTarget {
        host,
        port: u16::try_from(port).map_err(|_| "端口必须在 1 到 65535 之间".to_string())?,
        username,
        secrets,
        known_fingerprint,
        proxy_jump,
    })
}

pub(crate) fn session_record(
    session_id: &str,
    server_id: &str,
    server_name: &str,
    host: &str,
    port: i64,
    username: &str,
    status: &str,
    error: Option<String>,
    cols: u32,
    rows: u32,
    pty: bool,
) -> db::SessionRecord {
    let now = db::AppDb::now();
    db::SessionRecord {
        id: session_id.to_string(),
        server_id: server_id.to_string(),
        server_name: server_name.to_string(),
        server_host: host.to_string(),
        server_port: port,
        username: username.to_string(),
        status: status.to_string(),
        connected_at: if status == "connected" {
            Some(now)
        } else {
            None
        },
        disconnected_at: if status == "connected" {
            None
        } else {
            Some(now)
        },
        error_message: error,
        keep_alive_interval: crate::ssh::DEFAULT_KEEPALIVE_SECS as i64,
        reconnect_policy: "manual".to_string(),
        terminal_rows: Some(i64::from(rows)),
        terminal_cols: Some(i64::from(cols)),
        terminal_pty: Some(pty),
        sftp_enabled: false,
        port_forwards_json: "[]".to_string(),
    }
}

#[tauri::command]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    server_id: Option<String>,
    target: Option<String>,
    credential_id: Option<String>,
    // Password typed for this one connection. Used to authenticate and then
    // dropped — it never reaches the keyring, the database or a log.
    password: Option<String>,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<SshConnectResult, String> {
    let cols = cols.unwrap_or(120).clamp(20, 500);
    let rows = rows.unwrap_or(32).clamp(5, 200);

    let (result, reader) = ssh_connect_internal(
        &state,
        session_id.clone(),
        server_id,
        target,
        credential_id,
        password,
        cols,
        rows,
        true,
    )
    .await?;

    if let Some(mut reader) = reader {
        let app_handle = app.clone();
        let session_key = session_id.clone();
        let manager = state.ssh.clone();
        let db_state = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            // 流式 UTF-8 解码：中文字符常跨两个 SSH 数据块，逐块
            // `from_utf8_lossy` 会把它变成不可恢复的 `�`。
            let mut decoder = Utf8StreamDecoder::new();
            while let Some(message) = reader.wait().await {
                match message {
                    russh::ChannelMsg::Data { data }
                    | russh::ChannelMsg::ExtendedData { data, .. } => {
                        let text = decoder.feed(&data);
                        if text.is_empty() {
                            continue; // 整块都是未完成的多字节序列
                        }
                        let _ = app_handle.emit(&format!("ssh-output-{session_key}"), text);
                    }
                    russh::ChannelMsg::Eof | russh::ChannelMsg::Close { .. } => break,
                    _ => continue,
                }
            }
            // 连接结束：吐出残留字节，避免丢最后一个字符。
            let tail = decoder.flush();
            if !tail.is_empty() {
                let _ = app_handle.emit(&format!("ssh-output-{session_key}"), tail);
            }
            manager.disconnect(&session_key).await;
            db_state.dir_sizes.forget_session(&session_key);
            if let Ok(conn) = db_state.db.open() {
                let _ = db::update_session_status(&conn, &session_key, "disconnected", None);
            }
            let _ = app_handle.emit(&format!("ssh-closed-{session_key}"), "closed");
        });
    }

    Ok(result)
}

#[tauri::command]
pub async fn ssh_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state
        .ssh
        .input(&session_id, data.into_bytes())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    state
        .ssh
        .resize(&session_id, cols, rows)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ssh_keepalive(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state
        .ssh
        .keepalive(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ssh_status(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    Ok(state.ssh.is_connected(&session_id).await)
}

#[tauri::command]
pub async fn ssh_disconnect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Monitoring must not resume mid-measurement on a reconnect: the rates
    // would be diffed across the outage. Drop the baseline first.
    state.monitor.forget(&session_id).await;
    state.dir_sizes.forget_session(&session_id);
    state.ssh.disconnect(&session_id).await;
    let conn = open_db(&state)?;
    db::update_session_status(&conn, &session_id, "disconnected", None)
        .map_err(|error| error.to_string())?;
    record_audit(&state, "ssh_disconnect", None, None, &session_id);
    let _ = app.emit(&format!("ssh-closed-{session_id}"), "user");
    Ok(())
}

/// Opens a session for monitoring: authenticated, but **no PTY and no shell**.
///
/// Monitoring runs fixed read-only commands on short-lived exec channels, so
/// allocating an interactive terminal on the server would be pure waste. The
/// host-key flow is identical to `ssh_connect`.
#[tauri::command]
pub async fn ssh_connect_monitor(
    state: State<'_, AppState>,
    session_id: String,
    server_id: Option<String>,
    target: Option<String>,
    credential_id: Option<String>,
    password: Option<String>,
) -> Result<SshConnectResult, String> {
    // A reconnect with the same id must not inherit the dead connection's
    // rate baselines: CPU/network diffs read across two different TCP
    // sessions are garbage. Drop them before the new handshake starts.
    state.monitor.forget(&session_id).await;

    let (result, reader) = ssh_connect_internal(
        &state,
        session_id.clone(),
        server_id,
        target,
        credential_id,
        password,
        // 0×0 is how the SSH layer knows to skip the PTY + shell.
        0,
        0,
        false,
    )
    .await?;

    // A non-interactive session never has a shell channel, so there is no
    // output pump to start and nothing to read.
    debug_assert!(reader.is_none(), "monitor session must not open a shell");

    Ok(result)
}

/// Opens and immediately closes a session. Used by "测试连接" so a broken
/// server never leaves a live session behind.
#[tauri::command]
pub async fn server_test_connection(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<SshConnectResult, String> {
    let probe_session = format!("probe-{}", uuid::Uuid::new_v4());
    let (result, _) = ssh_connect_internal(
        &state,
        probe_session.clone(),
        Some(server_id),
        None,
        None,
        // A saved server always uses its stored credential.
        None,
        80,
        24,
        true,
    )
    .await?;
    state.ssh.disconnect(&probe_session).await;
    if let Ok(conn) = state.db.open() {
        let _ = db::update_session_status(&conn, &probe_session, "disconnected", None);
        let _ = conn.execute("DELETE FROM ssh_sessions WHERE id = ?1", [&probe_session]);
    }
    Ok(result)
}

type ConnectAttempt = (SshConnectResult, Option<russh::ChannelReadHalf>);

/// Shared by `ssh_connect` (starts an output pump) and `server_test_connection`
/// (closes immediately). Returns the channel reader so the caller can pump it.
async fn ssh_connect_internal(
    state: &AppState,
    session_id: String,
    server_id: Option<String>,
    target: Option<String>,
    credential_id: Option<String>,
    // Password typed for this one connection; used and discarded, never stored.
    password: Option<String>,
    cols: u32,
    rows: u32,
    // `pty: false` opens the session without a PTY or shell (monitoring).
    pty: bool,
) -> Result<ConnectAttempt, String> {
    let (resolved_server_id, server_name, target) = {
        let conn = open_db(state)?;
        match server_id {
            Some(id) => {
                let server = db::get_server(&conn, &id)
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "服务器不存在".to_string())?;
                let resolved = build_target(
                    &conn,
                    server.host.clone(),
                    server.port,
                    server.username.clone(),
                    server.credential_id.clone().or(credential_id),
                    password,
                    server.proxy_jump_id.clone(),
                )?;
                (server.id.clone(), server.name.clone(), resolved)
            }
            None => {
                let raw = target.ok_or_else(|| "缺少连接目标".to_string())?;
                let (username, host, port) = crate::ssh::parse_ssh_target(&raw, DEFAULT_SSH_PORT)
                    .map_err(|error| error.to_string())?;
                let resolved = build_target(
                    &conn,
                    host.clone(),
                    i64::from(port),
                    username.clone(),
                    credential_id,
                    password,
                    None,
                )?;
                (String::new(), format!("{username}@{host}:{port}"), resolved)
            }
        }
    };

    let host = target.host.clone();
    let port = i64::from(target.port);
    let username = target.username.clone();

    // A session row exists before the handshake so the UI can show progress and
    // a failed attempt stays traceable.
    if let Ok(conn) = state.db.open() {
        let _ = db::insert_session(
            &conn,
            &session_record(
                &session_id,
                &resolved_server_id,
                &server_name,
                &host,
                port,
                &username,
                "connecting",
                None,
                cols,
                rows,
                pty,
            ),
        );
    }

    let outcome = state
        .ssh
        .connect(session_id.clone(), target, cols, rows)
        .await;
    let conn = open_db(state)?;

    // The endpoint the user still has to trust. With ProxyJump this is a jump
    // host, so it is deliberately *not* just `host:port`.
    let hop = match &outcome {
        Ok((connect_outcome, _)) => connect_outcome
            .challenge_label()
            .unwrap_or_else(|| format!("{host}:{port}")),
        Err(_) => format!("{host}:{port}"),
    };

    match outcome {
        Ok((crate::ssh::ConnectOutcome::Connected { host_key }, reader)) => {
            let _ = db::insert_session(
                &conn,
                &session_record(
                    &session_id,
                    &resolved_server_id,
                    &server_name,
                    &host,
                    port,
                    &username,
                    "connected",
                    None,
                    cols,
                    rows,
                    pty,
                ),
            );
            if !resolved_server_id.is_empty() {
                let _ = db::touch_server_connection(&conn, &resolved_server_id);
            }
            drop(conn);
            record_audit(
                state,
                "ssh_connect",
                Some(&resolved_server_id),
                Some(&server_name),
                &format!("{host}:{port}"),
            );
            Ok((
                SshConnectResult::Connected {
                    session_id,
                    host,
                    port,
                    fingerprint: host_key.fingerprint,
                    fingerprint_type: host_key.key_type,
                },
                reader,
            ))
        }
        Ok((
            crate::ssh::ConnectOutcome::HostKeyUnknown {
                host_key,
                challenge_host,
                challenge_port,
            },
            _,
        )) => {
            let _ = db::update_session_status(&conn, &session_id, "error", Some("主机指纹未确认"));
            record_audit(
                state,
                "ssh_host_key_unknown",
                Some(&resolved_server_id),
                Some(&server_name),
                &hop,
            );
            Ok((
                SshConnectResult::HostKeyUnknown {
                    session_id,
                    challenge_host,
                    challenge_port: i64::from(challenge_port),
                    host,
                    port,
                    fingerprint: host_key.fingerprint,
                    fingerprint_type: host_key.key_type,
                },
                None,
            ))
        }
        Ok((
            crate::ssh::ConnectOutcome::HostKeyChanged {
                host_key,
                known_fingerprint,
                challenge_host,
                challenge_port,
            },
            _,
        )) => {
            let _ =
                db::update_session_status(&conn, &session_id, "error", Some("主机指纹发生变化"));
            record_audit(
                state,
                "ssh_host_key_changed",
                Some(&resolved_server_id),
                Some(&server_name),
                &hop,
            );
            Ok((
                SshConnectResult::HostKeyChanged {
                    session_id,
                    challenge_host,
                    challenge_port: i64::from(challenge_port),
                    host,
                    port,
                    fingerprint: host_key.fingerprint,
                    fingerprint_type: host_key.key_type,
                    known_fingerprint,
                },
                None,
            ))
        }
        Err(error) => {
            let message = error.to_string();
            let _ = db::update_session_status(&conn, &session_id, "error", Some(&message));
            record_audit(
                state,
                "ssh_connect_error",
                Some(&resolved_server_id),
                Some(&server_name),
                &message,
            );
            Err(message)
        }
    }
}
