use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{
    db,
    db::{CredentialRecord, ServerRecord},
    dirsize::DirectorySizeResult,
    keyring,
    ssh::{ConnectTarget, CredentialSecrets},
    state::AppState,
};

const DEFAULT_SSH_PORT: u16 = 22;

fn open_db(state: &AppState) -> Result<Connection, String> {
    state.db.open().map_err(|error| error.to_string())
}

fn record_audit(
    state: &AppState,
    action: &str,
    server_id: Option<&str>,
    server_name: Option<&str>,
    details: &str,
) {
    let Ok(conn) = state.db.open() else { return };
    let _ = db::insert_audit_log(
        &conn,
        &db::AuditLogRecord {
            id: uuid::Uuid::new_v4().to_string(),
            action: action.to_string(),
            timestamp: db::AppDb::now(),
            user_id: None,
            server_id: server_id.map(str::to_string),
            server_name: server_name.map(str::to_string),
            project_id: None,
            project_name: None,
            details_json: details.to_string(),
            ip_address: None,
            user_agent: Some("ops-workbench".to_string()),
        },
    );
}

fn require_existing_credential(conn: &Connection, id: &str) -> Result<CredentialRecord, String> {
    db::get_credential(conn, id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "所选凭据不存在，请重新选择".to_string())
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

/// All referential checks for a server, kept free of Tauri types so it can be
/// unit-tested directly.
fn validate_server(conn: &Connection, server: &ServerRecord) -> Result<(), String> {
    if server.name.trim().is_empty()
        || server.host.trim().is_empty()
        || server.username.trim().is_empty()
    {
        return Err("服务器名称、主机和用户名不能为空".to_string());
    }
    if !(1..=65535).contains(&server.port) {
        return Err("端口必须在 1 到 65535 之间".to_string());
    }

    if let Some(credential_id) = server.credential_id.as_deref() {
        require_existing_credential(conn, credential_id)?;
    }
    if let Some(group_id) = server
        .group_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let exists = db::list_server_groups(conn)
            .map_err(|error| error.to_string())?
            .iter()
            .any(|group| group.id == group_id);
        if !exists {
            return Err("所选分组不存在".to_string());
        }
    }
    if let Some(jump_id) = server
        .proxy_jump_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if jump_id == server.id {
            return Err("跳板机不能是服务器自身".to_string());
        }
        match db::get_server(conn, jump_id).map_err(|error| error.to_string())? {
            None => return Err("所选跳板机不存在".to_string()),
            Some(jump) => {
                // Reject the shortest cycle: A -> B -> A.
                if jump.proxy_jump_id.as_deref() == Some(server.id.as_str()) {
                    return Err("跳板机配置存在循环引用".to_string());
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn server_list(state: State<'_, AppState>) -> Result<Vec<ServerRecord>, String> {
    let conn = open_db(&state)?;
    db::list_servers(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn server_get(state: State<'_, AppState>, id: String) -> Result<Option<ServerRecord>, String> {
    let conn = open_db(&state)?;
    db::get_server(&conn, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn server_save(
    state: State<'_, AppState>,
    server: ServerRecord,
) -> Result<ServerRecord, String> {
    let conn = open_db(&state)?;
    validate_server(&conn, &server)?;

    // `last_connected_at` is owned by the connection layer, not by the form.
    let existing = db::get_server(&conn, &server.id).map_err(|error| error.to_string())?;
    let is_new = existing.is_none();
    let mut server = server;
    server.name = server.name.trim().to_string();
    server.host = server.host.trim().to_string();
    server.username = server.username.trim().to_string();
    server.group_id = server.group_id.filter(|value| !value.trim().is_empty());
    server.proxy_jump_id = server
        .proxy_jump_id
        .filter(|value| !value.trim().is_empty());
    server.last_connected_at = existing.and_then(|item| item.last_connected_at);
    server.updated_at = db::AppDb::now();

    db::insert_or_replace_server(&conn, &server).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        if is_new {
            "server_create"
        } else {
            "server_update"
        },
        Some(&server.id),
        Some(&server.name),
        &server.host,
    );

    db::get_server(&conn, &server.id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "保存服务器后无法读取记录".to_string())
}

#[tauri::command]
pub fn server_delete(state: State<'_, AppState>, id: String) -> Result<db::CascadeResult, String> {
    let conn = open_db(&state)?;
    let server = db::get_server(&conn, &id).map_err(|error| error.to_string())?;
    let result = db::delete_server_cascade(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "server_delete",
        Some(&id),
        server.as_ref().map(|item| item.name.as_str()),
        &format!("sessions={} history={}", result.sessions, result.history),
    );
    Ok(result)
}

#[tauri::command]
pub fn server_set_favorite(
    state: State<'_, AppState>,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    db::set_server_favorite(&conn, &id, favorite).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Server groups
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn group_list(state: State<'_, AppState>) -> Result<Vec<db::ServerGroupRecord>, String> {
    let conn = open_db(&state)?;
    db::list_server_groups(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn group_save(
    state: State<'_, AppState>,
    group: db::ServerGroupRecord,
) -> Result<db::ServerGroupRecord, String> {
    if group.name.trim().is_empty() {
        return Err("分组名称不能为空".to_string());
    }
    let conn = open_db(&state)?;
    let mut group = group;
    group.name = group.name.trim().to_string();
    group.updated_at = db::AppDb::now();
    db::insert_or_replace_server_group(&conn, &group).map_err(|error| error.to_string())?;
    db::list_server_groups(&conn)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == group.id)
        .ok_or_else(|| "保存分组后无法读取记录".to_string())
}

#[tauri::command]
pub fn group_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    db::delete_server_group(&conn, &id).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Credentials
//
// Secrets live in the OS keyring. They are read here, in Rust, and are never
// returned to the WebView — there is intentionally no `credential_get_secret`.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn credential_list(state: State<'_, AppState>) -> Result<Vec<CredentialRecord>, String> {
    let conn = open_db(&state)?;
    db::list_credentials(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn credential_save(
    state: State<'_, AppState>,
    credential: CredentialRecord,
    secret: Option<String>,
    passphrase: Option<String>,
) -> Result<CredentialRecord, String> {
    let conn = open_db(&state)?;
    if credential.name.trim().is_empty() || credential.username.trim().is_empty() {
        return Err("凭据名称和用户名不能为空".to_string());
    }

    // `private_key_passphrase` was a legacy type; passphrase + key is now one
    // configuration instead of two mutually exclusive ones.
    let credential_type = match credential.credential_type.as_str() {
        "password" | "private_key" => credential.credential_type.clone(),
        "private_key_passphrase" => "private_key".to_string(),
        other => return Err(format!("不支持的凭据类型：{other}")),
    };

    let existing = db::get_credential(&conn, &credential.id).map_err(|error| error.to_string())?;
    let mut credential = credential;
    credential.credential_type = credential_type;
    credential.name = credential.name.trim().to_string();
    credential.username = credential.username.trim().to_string();
    credential.updated_at = db::AppDb::now();

    let trimmed_secret = secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let trimmed_passphrase = passphrase
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let is_new_secret = trimmed_secret.is_some();

    if existing.is_none() && trimmed_secret.is_none() {
        return Err(match credential.credential_type.as_str() {
            "private_key" => "请粘贴私钥内容".to_string(),
            _ => "请填写密码".to_string(),
        });
    }
    if trimmed_passphrase.is_some() && credential.credential_type != "private_key" {
        return Err("只有私钥凭据可以设置私钥口令".to_string());
    }

    // Keyring first: if it fails nothing has been persisted yet, and if the DB
    // write fails below we roll the keyring entry back instead of orphaning it.
    let mut written: Vec<String> = Vec::new();
    let secret_ref = credential
        .secret_ref
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("cred-{}", uuid::Uuid::new_v4()));
    let passphrase_ref = credential
        .passphrase_ref
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("cred-{}-pass", uuid::Uuid::new_v4()));

    if let Some(value) = trimmed_secret {
        keyring::save_secret(&secret_ref, value).map_err(|error| error.to_string())?;
        written.push(secret_ref.clone());
        credential.secret_ref = Some(secret_ref);
    }
    if let Some(value) = trimmed_passphrase {
        keyring::save_secret(&passphrase_ref, value).map_err(|error| error.to_string())?;
        written.push(passphrase_ref.clone());
        credential.passphrase_ref = Some(passphrase_ref);
    }

    match db::insert_or_replace_credential(&conn, &credential) {
        Ok(()) => {
            // Drop passphrase entries that are no longer wanted.
            if trimmed_passphrase.is_none() {
                if let Some(reference) = credential.passphrase_ref.as_deref() {
                    if !written.iter().any(|item| item == reference) {
                        let _ = keyring::delete_secret(reference);
                    }
                }
                credential.passphrase_ref = None;
                let _ = db::insert_or_replace_credential(&conn, &credential);
            }
            record_audit(
                &state,
                if existing.is_none() {
                    "credential_create"
                } else {
                    "credential_update"
                },
                None,
                None,
                &format!("{} (secret={})", credential.name, is_new_secret),
            );
            db::get_credential(&conn, &credential.id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "保存凭据后无法读取记录".to_string())
        }
        Err(error) => {
            for reference in written {
                let _ = keyring::delete_secret(&reference);
            }
            Err(error.to_string())
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CredentialDeleteResult {
    pub deleted: bool,
    /// Servers that would lose their credential if the delete went through.
    pub references: i64,
}

#[tauri::command]
pub fn credential_delete(
    state: State<'_, AppState>,
    id: String,
    force: Option<bool>,
) -> Result<CredentialDeleteResult, String> {
    let conn = open_db(&state)?;
    let credential = db::get_credential(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "凭据不存在".to_string())?;
    let references =
        db::count_servers_by_credential(&conn, &id).map_err(|error| error.to_string())?;

    if references > 0 && force != Some(true) {
        return Ok(CredentialDeleteResult {
            deleted: false,
            references,
        });
    }

    db::delete_credential(&conn, &id).map_err(|error| error.to_string())?;
    for reference in [credential.secret_ref, credential.passphrase_ref]
        .into_iter()
        .flatten()
    {
        if !reference.trim().is_empty() {
            let _ = keyring::delete_secret(&reference);
        }
    }
    record_audit(&state, "credential_delete", None, None, &credential.name);
    Ok(CredentialDeleteResult {
        deleted: true,
        references,
    })
}

// ---------------------------------------------------------------------------
// Known hosts
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn known_host_list(state: State<'_, AppState>) -> Result<Vec<db::KnownHostRecord>, String> {
    let conn = open_db(&state)?;
    db::list_known_hosts(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn known_host_get(
    state: State<'_, AppState>,
    host: String,
    port: i64,
) -> Result<Option<db::KnownHostRecord>, String> {
    let conn = open_db(&state)?;
    db::get_known_host(&conn, &host, port).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn known_host_delete(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let conn = open_db(&state)?;
    let removed = db::delete_known_host(&conn, &id).map_err(|error| error.to_string())?;
    if removed {
        record_audit(&state, "known_host_delete", None, None, &id);
    }
    Ok(removed)
}

/// Records the user's decision for a host key shown during the handshake.
/// `trust = false` explicitly refuses the key; the connection stays closed.
#[tauri::command]
pub fn known_host_trust(
    state: State<'_, AppState>,
    host: String,
    port: i64,
    fingerprint: String,
    fingerprint_type: Option<String>,
    trust: bool,
) -> Result<Option<db::KnownHostRecord>, String> {
    if !(1..=65535).contains(&port) {
        return Err("端口必须在 1 到 65535 之间".to_string());
    }
    if !trust {
        record_audit(
            &state,
            "known_host_reject",
            None,
            None,
            &format!("{host}:{port}"),
        );
        return Ok(None);
    }
    if fingerprint.trim().is_empty() {
        return Err("主机指纹不能为空".to_string());
    }
    let conn = open_db(&state)?;
    let record = db::trust_known_host(
        &conn,
        host.trim(),
        port,
        fingerprint.trim(),
        fingerprint_type.as_deref().unwrap_or("ssh-rsa"),
    )
    .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "known_host_confirm",
        None,
        None,
        &format!("{host}:{port}"),
    );
    Ok(Some(record))
}

// ---------------------------------------------------------------------------
// Sessions, history, audit
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn session_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<db::SessionRecord>, String> {
    let conn = open_db(&state)?;
    db::list_recent_sessions(&conn, limit.unwrap_or(20).clamp(1, 200))
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionStats {
    /// Live sessions tracked by `SshSessionManager` — the source of truth for
    /// the status bar, never a hard-coded number.
    pub active: usize,
    pub keepalive_secs: u64,
}

#[tauri::command]
pub async fn session_stats(state: State<'_, AppState>) -> Result<SessionStats, String> {
    Ok(SessionStats {
        active: state.ssh.active_count().await,
        keepalive_secs: crate::ssh::DEFAULT_KEEPALIVE_SECS,
    })
}

#[tauri::command]
pub fn history_record(
    state: State<'_, AppState>,
    session_id: String,
    server_id: String,
    server_name: String,
    command: String,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Ok(());
    }
    let conn = open_db(&state)?;
    db::insert_command_history(
        &conn,
        &db::CommandHistoryRecord {
            id: uuid::Uuid::new_v4().to_string(),
            session_id,
            server_id,
            server_name,
            command,
            timestamp: db::AppDb::now(),
            exit_code: None,
            source: "terminal".to_string(),
            output: None,
        },
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn history_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<db::CommandHistoryRecord>, String> {
    let conn = open_db(&state)?;
    db::list_command_history(&conn, limit.unwrap_or(100).clamp(1, 500))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn audit_log_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<db::AuditLogRecord>, String> {
    let conn = open_db(&state)?;
    db::list_audit_logs(&conn, limit.unwrap_or(100).clamp(1, 500))
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

/// Returned by `ssh_connect` / `server_test_connection`.
///
/// `host` / `port` always describe the final destination (what the user sees
/// in the tab). `challenge_host` / `challenge_port` describe the endpoint whose
/// key must be trusted — with ProxyJump that is the jump host. The UI must save
/// the fingerprint under the *challenge* endpoint; saving it under `host`
/// would loop forever on a two-hop connection.
#[derive(Debug, Clone, Serialize)]
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

fn session_record(
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
            while let Some(message) = reader.wait().await {
                match message {
                    russh::ChannelMsg::Data { data }
                    | russh::ChannelMsg::ExtendedData { data, .. } => {
                        let _ = app_handle.emit(
                            &format!("ssh-output-{session_key}"),
                            String::from_utf8_lossy(&data).into_owned(),
                        );
                    }
                    russh::ChannelMsg::Eof | russh::ChannelMsg::Close { .. } => break,
                    _ => continue,
                }
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

// ---------------------------------------------------------------------------
// SFTP (remote file browsing over the live session)
// ---------------------------------------------------------------------------

/// One directory listing: the canonical path actually read, plus its entries.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SftpListResult {
    pub path: String,
    pub entries: Vec<crate::ssh::RemoteFileEntry>,
}

#[tauri::command]
pub async fn sftp_open(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    state
        .ssh
        .sftp_open(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    session_id: String,
    path: Option<String>,
) -> Result<SftpListResult, String> {
    let (path, entries) = state
        .ssh
        .sftp_list_dir(&session_id, path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(SftpListResult { path, entries })
}

// -- Directory size (on-demand, background) -------------------------------

/// Starts computing the size of a remote directory in the background and
/// begins emitting `directory-size-update` events as it progresses. A second
/// call for the same session + path replays the current (possibly finished)
/// state instead of launching a duplicate scan.
#[tauri::command]
pub async fn directory_size_start(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    timeout_ms: Option<u64>,
    force: Option<bool>,
) -> Result<DirectorySizeResult, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5 * 60_000).max(1_000));
    let initial = state.dir_sizes.start(
        Some(Arc::new(move |result| {
            let _ = app.emit(crate::dirsize::DIR_SIZE_EVENT, &result);
        })),
        Arc::new(state.ssh.clone()),
        session_id,
        path,
        timeout,
        force.unwrap_or(false),
    );
    Ok(initial)
}

/// Asks a running computation to stop. The result, once cancelled, is
/// reported with status `cancelled` through the event stream.
#[tauri::command]
pub async fn directory_size_cancel(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    state.dir_sizes.cancel(&session_id, &path);
    Ok(())
}

/// Snapshot of the current (or last) computation for a path, or `None` if it
/// was never requested.
#[tauri::command]
pub async fn directory_size_status(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Option<DirectorySizeResult>, String> {
    Ok(state.dir_sizes.status(&session_id, &path))
}

#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    state
        .ssh
        .sftp_realpath(&session_id, &path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sftp_stat(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<crate::ssh::RemoteFileEntry, String> {
    state
        .ssh
        .sftp_stat(&session_id, &path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sftp_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state
        .ssh
        .sftp_close(&session_id)
        .await
        .map_err(|error| error.to_string())
}

/// Uploads local files/directories (paths handed over by a drag & drop) into
/// `remote_dir`. Emits `sftp-upload-{session_id}` once per finished file so
/// the UI can show progress without polling.
#[tauri::command]
pub async fn sftp_upload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<Vec<crate::ssh::RemoteFileEntry>, String> {
    let session_id_for_cb = session_id.clone();
    let uploaded = state
        .ssh
        .sftp_upload(&session_id, &local_paths, &remote_dir, &|name| {
            let _ = app.emit(
                &format!("sftp-upload-{session_id_for_cb}"),
                name.to_string(),
            );
        })
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "sftp_upload",
        None,
        None,
        &format!("{} file(s) → {remote_dir}", uploaded.len()),
    );
    Ok(uploaded)
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    state
        .ssh
        .sftp_remove(&session_id, &path)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "sftp_remove", None, None, &path);
    Ok(())
}

/// Renames `path` to `new_name` (plain name, stays in the same directory).
#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let new_path = state
        .ssh
        .sftp_rename(&session_id, &path, &new_name)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "sftp_rename",
        None,
        None,
        &format!("{path} → {new_path}"),
    );
    Ok(new_path)
}

/// Copies a file or directory within its own directory under `new_name`.
#[tauri::command]
pub async fn sftp_copy(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let new_path = state
        .ssh
        .sftp_copy(&session_id, &path, &new_name)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "sftp_copy",
        None,
        None,
        &format!("{path} → {new_path}"),
    );
    Ok(new_path)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let created = state
        .ssh
        .sftp_mkdir(&session_id, &path)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "sftp_mkdir", None, None, &created);
    Ok(created)
}

/// Creates an empty remote file (the "新建文件" action).
#[tauri::command]
pub async fn sftp_touch(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let created = state
        .ssh
        .sftp_touch(&session_id, &path)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "sftp_touch", None, None, &created);
    Ok(created)
}

/// Reads a remote file for the in-app editor (text files only, size-capped).
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<crate::ssh::RemoteFileContent, String> {
    const MAX_EDIT_SIZE: u64 = 2 * 1024 * 1024;
    let content = state
        .ssh
        .sftp_read_file(&session_id, &path, MAX_EDIT_SIZE)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "sftp_read_file", None, None, &path);
    Ok(content)
}

/// Saves editor content back to the remote file.
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    state
        .ssh
        .sftp_write_file(&session_id, &path, &content)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(&state, "sftp_write_file", None, None, &path);
    Ok(())
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

// ---------------------------------------------------------------------------
// Server monitoring — read-only Linux metrics over the live session
//
// Every command here takes only a `session_id`: the commands that run on the
// server are a fixed table inside `monitor.rs`, so the WebView cannot ask for
// an arbitrary shell string.
// ---------------------------------------------------------------------------

use crate::monitor::{
    CpuMetrics, DiskMetrics, MemoryMetrics, MonitorSnapshot, NetworkMetrics, ProcessInfo,
    SystemInfo,
};

#[tauri::command]
pub async fn monitor_system_info(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SystemInfo, String> {
    crate::monitor::collect_system_info(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_cpu(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<CpuMetrics, String> {
    crate::monitor::collect_cpu(&state.ssh, &state.monitor, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_memory(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<MemoryMetrics, String> {
    crate::monitor::collect_memory(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_disks(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<DiskMetrics>, String> {
    crate::monitor::collect_disks(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_network(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<NetworkMetrics>, String> {
    crate::monitor::collect_network(&state.ssh, &state.monitor, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_processes(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ProcessInfo>, String> {
    crate::monitor::collect_processes(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

/// The one call the monitoring page is built around: every headline metric in
/// a single round trip.
#[tauri::command]
pub async fn monitor_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<MonitorSnapshot, String> {
    crate::monitor::collect_snapshot(&state.ssh, &state.monitor, &session_id)
        .await
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub app_name: String,
    pub version: String,
    pub db_path: String,
    pub schema_version: u32,
    pub keepalive_secs: u64,
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> Result<AppInfo, String> {
    Ok(AppInfo {
        app_name: "运维工作台".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        db_path: state.db.path().to_string_lossy().to_string(),
        schema_version: db::SCHEMA_VERSION,
        keepalive_secs: crate::ssh::DEFAULT_KEEPALIVE_SECS,
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Service management — systemd (P3-1.1)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn service_list(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<crate::systemd::ServiceUnit>, String> {
    crate::systemd::collect_services(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

/// Start / stop / restart / reload / enable / disable a unit.
///
/// `action` is one of the fixed verbs in [`crate::safe::ServiceAction`]; an
/// unknown verb never reaches the shell.
#[tauri::command]
pub async fn service_action(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    action: String,
    unit: String,
) -> Result<String, String> {
    let action = parse_service_action(&action)?;
    let outcome = crate::systemd::service_action(&state.ssh, &session_id, action, &unit)
        .await
        .map_err(|error| error.to_string())?;

    record_audit(
        &state,
        "service_action",
        None,
        None,
        &format!(
            "{{\"session\":\"{session_id}\",\"action\":\"{}\",\"unit\":\"{unit}\"}}",
            action.label()
        ),
    );
    // The list page reloads on this event so the new state shows immediately.
    let _ = app.emit(&format!("services-changed-{session_id}"), &unit);

    Ok(outcome)
}

fn parse_service_action(action: &str) -> Result<crate::safe::ServiceAction, String> {
    use crate::safe::ServiceAction;
    match action {
        "start" => Ok(ServiceAction::Start),
        "stop" => Ok(ServiceAction::Stop),
        "restart" => Ok(ServiceAction::Restart),
        "reload" => Ok(ServiceAction::Reload),
        "enable" => Ok(ServiceAction::Enable),
        "disable" => Ok(ServiceAction::Disable),
        other => Err(format!("不支持的服务操作：{other}")),
    }
}

#[tauri::command]
pub async fn service_status(
    state: State<'_, AppState>,
    session_id: String,
    unit: String,
) -> Result<String, String> {
    crate::systemd::service_status(&state.ssh, &session_id, &unit)
        .await
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Log centre — journald (P3-1.2)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn journal_query(
    state: State<'_, AppState>,
    session_id: String,
    unit: Option<String>,
    lines: u32,
    priority: Option<u8>,
) -> Result<Vec<crate::journal::JournalEntry>, String> {
    let query = crate::journal::JournalQuery {
        unit: unit.filter(|value| !value.trim().is_empty()),
        lines,
        priority,
    };
    crate::journal::collect_journal(&state.ssh, &session_id, &query)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn journal_disk_usage(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<crate::journal::JournalDiskUsage, String> {
    crate::journal::collect_disk_usage(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Docker (P3-1.3)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn docker_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<crate::docker::DockerSnapshot, String> {
    crate::docker::collect_snapshot(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn docker_logs(
    state: State<'_, AppState>,
    session_id: String,
    container: String,
    lines: u32,
) -> Result<String, String> {
    crate::docker::collect_logs(&state.ssh, &session_id, &container, lines)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn docker_container_action(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    action: String,
    container: String,
) -> Result<String, String> {
    let action = match action.as_str() {
        "start" => crate::safe::ContainerAction::Start,
        "stop" => crate::safe::ContainerAction::Stop,
        "restart" => crate::safe::ContainerAction::Restart,
        "remove" => crate::safe::ContainerAction::Remove,
        other => return Err(format!("不支持的容器操作：{other}")),
    };

    let outcome = crate::docker::container_action(&state.ssh, &session_id, action, &container)
        .await
        .map_err(|error| error.to_string())?;

    record_audit(
        &state,
        "docker_container_action",
        None,
        None,
        &format!(
            "{{\"session\":\"{session_id}\",\"action\":\"{}\",\"container\":\"{container}\"}}",
            action.label()
        ),
    );
    let _ = app.emit(&format!("docker-changed-{session_id}"), &container);

    Ok(outcome)
}

#[tauri::command]
pub async fn docker_image_remove(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    image: String,
) -> Result<String, String> {
    let outcome = crate::docker::image_remove(&state.ssh, &session_id, &image)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "docker_image_remove",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\",\"image\":\"{image}\"}}"),
    );
    let _ = app.emit(&format!("docker-changed-{session_id}"), &image);
    Ok(outcome)
}

/// Drops stopped containers and dangling images. Destructive, so it is audited
/// and the frontend confirms before calling.
#[tauri::command]
pub async fn docker_prune(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let outcome = crate::docker::system_prune(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "docker_prune",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\"}}"),
    );
    let _ = app.emit(&format!("docker-changed-{session_id}"), "prune");
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// Nginx (P3-1.4)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn nginx_sites(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<crate::nginx::NginxSite>, String> {
    crate::nginx::collect_sites_with_summary(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn nginx_config(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    crate::nginx::read_config(&state.ssh, &session_id, &path)
        .await
        .map_err(|error| error.to_string())
}

/// Writes a config file, validates it, and only then reloads.
///
/// The order matters: saving an invalid config and reloading would take the
/// site offline, so the reload is skipped when `nginx -t` fails and the error
/// is returned for the UI to show.
#[derive(Debug, Clone, Serialize)]
pub struct NginxSaveResult {
    pub saved: bool,
    pub test: crate::nginx::NginxTestResult,
    pub reloaded: bool,
    /// Where the pre-edit copy went, so a mistake is recoverable.
    pub backup_path: Option<String>,
}

#[tauri::command]
pub async fn nginx_save_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<NginxSaveResult, String> {
    // Back up first: an edit that fails validation still leaves the original
    // recoverable, and the operator is told where it is.
    let backup_path = crate::nginx::backup_config(&state.ssh, &session_id, &path)
        .await
        .ok();

    state
        .ssh
        .sftp_write_file(&session_id, &path, &content)
        .await
        .map_err(|error| error.to_string())?;

    let test = crate::nginx::test_config(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())?;

    let reloaded = if test.success {
        crate::nginx::reload(&state.ssh, &session_id).await.is_ok()
    } else {
        false
    };

    record_audit(
        &state,
        "nginx_save_config",
        None,
        None,
        &format!(
            "{{\"session\":\"{session_id}\",\"path\":\"{path}\",\"ok\":{}}}",
            test.success
        ),
    );
    let _ = app.emit(&format!("nginx-changed-{session_id}"), &path);

    Ok(NginxSaveResult {
        saved: true,
        test,
        reloaded,
        backup_path,
    })
}

#[tauri::command]
pub async fn nginx_test(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<crate::nginx::NginxTestResult, String> {
    crate::nginx::test_config(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn nginx_reload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let outcome = crate::nginx::reload(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "nginx_reload",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\"}}"),
    );
    let _ = app.emit(&format!("nginx-changed-{session_id}"), "reload");
    Ok(outcome)
}

#[tauri::command]
pub async fn nginx_set_site_enabled(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    site: String,
    enable: bool,
) -> Result<String, String> {
    let outcome = crate::nginx::set_site_enabled(&state.ssh, &session_id, &site, enable)
        .await
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "nginx_set_site_enabled",
        None,
        None,
        &format!("{{\"session\":\"{session_id}\",\"site\":\"{site}\",\"enable\":{enable}}}"),
    );
    let _ = app.emit(&format!("nginx-changed-{session_id}"), &site);
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// Project discovery (P3 read-only)
// ---------------------------------------------------------------------------

/// 从部署实例输出解析 `path\tfile` 行，累积到 path → 标志名集合。
fn collect_markers(
    output: &str,
    markers_by_path: &mut std::collections::BTreeMap<String, Vec<String>>,
) {
    for line in output.lines() {
        let mut parts = line.splitn(2, '\t');
        let Some(path) = parts.next() else { continue };
        let Some(file) = parts.next() else { continue };
        if path.is_empty() || file.is_empty() {
            continue;
        }
        let entry = markers_by_path.entry(path.to_string()).or_default();
        let file = file.to_string();
        if !entry.contains(&file) {
            entry.push(file);
        }
    }
}

/// 候选路径与部署实例的双向前缀关联：候选目录是实例源码目录（或其父/子目录），
/// 就建立运行时关联 —— 这取代旧的 ps/systemctl 文本匹配。
fn instance_links_for_path(
    instances: &[crate::deployment_collector::DeploymentInstance],
    path: &str,
) -> Vec<crate::project_discovery::RuntimeLink> {
    let mut links = Vec::new();
    for instance in instances {
        let related = instance
            .source_paths
            .iter()
            .chain(instance.working_directories.iter())
            .any(|p| {
                p == path
                    || path.starts_with(&format!("{p}/"))
                    || p.starts_with(&format!("{path}/"))
            });
        if !related {
            continue;
        }
        let kind = match instance.kind.as_str() {
            "docker" => crate::project_discovery::RuntimeKind::Docker,
            "systemd" => crate::project_discovery::RuntimeKind::Systemd,
            "nginx" => crate::project_discovery::RuntimeKind::Nginx,
            _ => crate::project_discovery::RuntimeKind::Process,
        };
        links.push(crate::project_discovery::RuntimeLink {
            kind,
            name: instance.name.clone(),
            status: Some(instance.status.clone()),
            ports: instance.ports.clone(),
            source: "deployment_instance".into(),
        });
    }
    links
}

/// 刷新一条扫描任务的进度。全部阶段共用；`current` 是正在处理的路径。
async fn set_progress(
    registry: &crate::project_discovery::ScanRegistry,
    task_id: &str,
    phase: &str,
    percent: u8,
    checked: u32,
    discovered: usize,
    current: Option<String>,
    warnings: u32,
) {
    if let Some(status) = registry.tasks.lock().await.get_mut(task_id) {
        status.progress.phase = phase.into();
        status.progress.progress = percent;
        status.progress.checked_directories = checked;
        status.progress.discovered_candidates = discovered as u32;
        status.progress.current_path = current;
        status.progress.warnings = warnings;
    }
}

fn scan_status(
    id: &str,
    server_id: &str,
    state: crate::project_discovery::ScanState,
) -> crate::project_discovery::ProjectScanStatus {
    crate::project_discovery::ProjectScanStatus {
        id: id.into(),
        server_id: server_id.into(),
        state,
        progress: crate::project_discovery::ScanProgress {
            phase: "候选发现".into(),
            progress: 0,
            checked_directories: 0,
            discovered_candidates: 0,
            current_path: None,
            warnings: 0,
        },
        error: None,
        started_at: crate::project_discovery::chrono_like_now(),
        finished_at: None,
    }
}

#[tauri::command]
pub async fn project_scan_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    server_id: String,
    incremental: Option<bool>,
) -> Result<crate::project_discovery::ProjectScanStatus, String> {
    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let status = scan_status(
        &id,
        &server_id,
        crate::project_discovery::ScanState::Running,
    );
    let cancel = state.project_scans.start(status.clone()).await?;
    let registry = state.project_scans.clone();
    let ssh = state.ssh.clone();
    let app_handle = app.clone();
    let sid = session_id.clone();
    let server = server_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            // ---- 阶段 1（0→15%）：能力识别前置 ----
            // 先搞清楚服务器装了什么，再决定启用哪些收集器。未安装的组件
            // （Docker/Nginx/…）不会产生任何探测命令。
            set_progress(&registry, &id, "能力识别", 5, 0, 0, None, 0).await;
            let profile = match crate::capability_probe::probe_capabilities(&sid, &ssh).await {
                Ok(p) => p,
                Err(e) => return Err(format!("服务器能力识别失败：{e}")),
            };

            let mut warnings = profile.warnings.clone();
            // ---- 阶段 2（15→35%）：部署实例枚举（第一轮核心）----
            // Docker/systemd/Nginx 收集器只按能力图谱启用；每个实例深入查
            // ID、路径、端口与配置。
            set_progress(
                &registry,
                &id,
                "部署实例枚举",
                18,
                0,
                0,
                None,
                warnings.len() as u32,
            )
            .await;
            let instances =
                crate::deployment_collector::collect_instances(&sid, &ssh, &profile, &mut warnings)
                    .await;
            let known = instances.iter().filter(|i| i.source_known).count();
            warnings.push(format!(
                "发现 {} 个部署实例（{} 个可关联源码，{} 个源码未知）",
                instances.len(),
                known,
                instances.len() - known
            ));
            set_progress(
                &registry,
                &id,
                "部署实例枚举",
                35,
                instances.len() as u32,
                0,
                None,
                warnings.len() as u32,
            )
            .await;

            // ---- 阶段 3（35→65%）：定向 marker 扫描 ----
            // 只扫实例给出的候选目录（find -name 项目标志），不再全量枚举文件。
            let mut targeted: Vec<String> = Vec::new();
            for instance in &instances {
                for path in instance
                    .source_paths
                    .iter()
                    .chain(instance.working_directories.iter())
                {
                    if !targeted.contains(path) {
                        targeted.push(path.clone());
                    }
                }
            }
            let mut markers_by_path: std::collections::BTreeMap<String, Vec<String>> =
                std::collections::BTreeMap::new();
            let chunk_size = 16;
            let chunks = targeted.chunks(chunk_size).count().max(1);
            for (index, chunk) in targeted.chunks(chunk_size).enumerate() {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("扫描已取消".to_string());
                }
                match crate::remote::run_capability(
                    &ssh,
                    &sid,
                    &crate::safe::Capability::ProjectDirMarkers {
                        paths: chunk.to_vec(),
                    },
                )
                .await
                {
                    Ok(output) => collect_markers(&output, &mut markers_by_path),
                    Err(error) => warnings.push(format!("定向扫描失败（{error}）")),
                }
                set_progress(
                    &registry,
                    &id,
                    "部署实例路径定向扫描",
                    35 + (((index + 1) * 30 / chunks) as u8),
                    chunk.len() as u32 * (index as u32 + 1),
                    0,
                    chunk.first().cloned(),
                    warnings.len() as u32,
                )
                .await;
            }

            // ---- 阶段 4（65→85%）：第二轮固定根 marker 扫描 ----
            // 补充"已上传但未部署"的源码：只在 /home /srv /opt /var/www /data
            // 中查找项目标志文件。
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("扫描已取消".to_string());
            }
            set_progress(
                &registry,
                &id,
                "补充源码扫描",
                68,
                targeted.len() as u32,
                0,
                None,
                warnings.len() as u32,
            )
            .await;
            match crate::remote::run_capability(
                &ssh,
                &sid,
                &crate::safe::Capability::ProjectMarkerScan,
            )
            .await
            {
                Ok(output) => collect_markers(&output, &mut markers_by_path),
                Err(error) => warnings.push(format!("补充源码扫描失败（{error}）")),
            }
            set_progress(
                &registry,
                &id,
                "补充源码扫描",
                85,
                targeted.len() as u32,
                0,
                None,
                warnings.len() as u32,
            )
            .await;

            // ---- 阶段 5（85→100%）：评分、合并与图谱 ----
            let total = markers_by_path.len().max(1) as u32;
            let mut candidates = Vec::new();
            for (index, (path, markers)) in markers_by_path.into_iter().enumerate() {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("扫描已取消".to_string());
                }
                let runtime_links = instance_links_for_path(&instances, &path);
                set_progress(
                    &registry,
                    &id,
                    if runtime_links.is_empty() {
                        "候选评分"
                    } else {
                        "运行服务关联"
                    },
                    85 + (((index as u32 + 1) * 15 / total) as u8),
                    index as u32 + 1,
                    candidates.len(),
                    Some(path.clone()),
                    warnings.len() as u32,
                )
                .await;
                let input = crate::project_discovery::CandidateInput {
                    path: path.clone(),
                    name: path.rsplit('/').next().unwrap_or("项目").into(),
                    server_id: server.clone(),
                    markers,
                    source: "deployment_instance_scan".into(),
                    runtime_links,
                    modules: Vec::new(),
                    env_names: Vec::new(),
                    ports: Vec::new(),
                };
                if let Some(candidate) = crate::project_discovery::score_candidate(
                    input,
                    &crate::project_discovery::chrono_like_now().to_string(),
                ) {
                    candidates.push(candidate);
                }
            }
            let candidates = crate::project_discovery::merge_candidates(candidates);

            // ---- 第四层：部署可行性图谱 ----
            // 评估每个已注册适配器在当前服务器能力下的准备度（P3.8）。
            // 项目是否"需要"某方式在 P3 仅做占位（证据尚未归集到具体适配器），
            // 这里以"服务器是否具备该能力"作为就绪与否的依据，绝不猜测。
            let deployment_readiness: Vec<crate::deployment_adapter::AdapterReadiness> =
                crate::deployment_adapter::DeploymentAdapter::all()
                    .iter()
                    .map(|id| {
                        let adapter = crate::deployment_adapter::DeploymentAdapter { id: *id };
                        // 在 P3 阶段，无法从候选项精确反推"项目是否需要"，故统一按
                        // 服务器能力是否具备评估；需要明确需求的判定由 P4 完成。
                        let required = adapter.is_applicable(&profile);
                        adapter.assess_readiness(&profile, required)
                    })
                    .collect();

            set_progress(
                &registry,
                &id,
                "完成",
                100,
                total,
                candidates.len(),
                None,
                warnings.len() as u32,
            )
            .await;

            let result = crate::project_discovery::ProjectScanResult {
                scan_id: id.clone(),
                server_id: server.clone(),
                candidates,
                warnings,
                completed_at: crate::project_discovery::chrono_like_now(),
                incremental: incremental.unwrap_or(false),
                capability: Some(profile),
                instances,
                deployment_readiness,
            };
            registry
                .results
                .lock()
                .await
                .insert(id.clone(), result.clone());
            let _ = app_handle.emit(&format!("project-scan-result-{id}"), &result);
            Ok::<(), String>(())
        }
        .await;
        let final_state = if result.is_ok() {
            crate::project_discovery::ScanState::Completed
        } else if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            crate::project_discovery::ScanState::Cancelled
        } else {
            crate::project_discovery::ScanState::Failed
        };
        let final_error = result.as_ref().err().cloned();
        registry
            .finish(&id, &server, final_state, final_error)
            .await;
    });
    Ok(status)
}

#[tauri::command]
pub async fn project_scan_cancel(
    state: State<'_, AppState>,
    scan_id: String,
) -> Result<bool, String> {
    Ok(state.project_scans.cancel(&scan_id).await)
}
#[tauri::command]
pub async fn project_scan_status(
    state: State<'_, AppState>,
    scan_id: String,
) -> Result<Option<crate::project_discovery::ProjectScanStatus>, String> {
    Ok(state
        .project_scans
        .tasks
        .lock()
        .await
        .get(&scan_id)
        .cloned())
}
#[tauri::command]
pub async fn project_scan_result(
    state: State<'_, AppState>,
    scan_id: String,
) -> Result<Option<crate::project_discovery::ProjectScanResult>, String> {
    Ok(state
        .project_scans
        .results
        .lock()
        .await
        .get(&scan_id)
        .cloned())
}

/// 单独获取服务器能力图谱（第一/二层），供前端在扫描前展示"这是一台什么服务器"。
/// 这是 P3 流水线的起点，绝不执行任何未安装组件（Docker/Nginx/…）的命令。
#[tauri::command]
pub async fn capability_profile(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<crate::capability_probe::ServerCapabilityProfile, String> {
    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".into());
    }
    crate::capability_probe::probe_capabilities(&session_id, &state.ssh)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Projects & deployments (legacy records retained for P5)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn project_list(state: State<'_, AppState>) -> Result<Vec<db::ProjectRecord>, String> {
    let conn = open_db(&state)?;
    db::list_projects(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn project_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<db::ProjectRecord>, String> {
    let conn = open_db(&state)?;
    db::get_project(&conn, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn project_save(
    state: State<'_, AppState>,
    project: db::ProjectRecord,
) -> Result<db::ProjectRecord, String> {
    let conn = open_db(&state)?;
    validate_project(&conn, &project)?;
    db::insert_or_replace_project(&conn, &project).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "project_save",
        Some(&project.server_id),
        None,
        &format!(
            "{{\"id\":\"{}\",\"name\":\"{}\"}}",
            project.id, project.name
        ),
    );
    Ok(project)
}

#[tauri::command]
pub async fn project_delete(state: State<'_, AppState>, id: String) -> Result<i64, String> {
    let conn = open_db(&state)?;
    let removed = db::delete_project_cascade(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "project_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\",\"deployments_removed\":{removed}}}"),
    );
    Ok(removed)
}

#[tauri::command]
pub async fn deployment_list(
    state: State<'_, AppState>,
    project_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<db::DeploymentRecord>, String> {
    let conn = open_db(&state)?;
    db::list_deployments(
        &conn,
        project_id.as_deref(),
        limit.unwrap_or(50).min(500) as i64,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<db::DeploymentRecord>, String> {
    let conn = open_db(&state)?;
    db::get_deployment(&conn, &id).map_err(|error| error.to_string())
}

/// Runs a project's deployment steps on a live session.
///
/// The steps come from the project record, **not** from the caller: the
/// WebView passes only a project id, so it cannot smuggle in a command. Each
/// step is re-validated here even though it was validated on save, because the
/// record could have been edited since.
#[tauri::command]
pub async fn deployment_execute(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    session_id: String,
    // Supplying the id lets the caller subscribe to `deploy-progress-<id>`
    // *before* the run starts, so nothing emitted early is missed.
    // (A doc comment is not allowed on a command parameter.)
    deployment_id: Option<String>,
) -> Result<db::DeploymentRecord, String> {
    let conn = open_db(&state)?;

    let project = db::get_project(&conn, &project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;

    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".to_string());
    }

    let steps: Vec<String> = serde_json::from_str(&project.commands_json)
        .map_err(|error| format!("项目的部署步骤不是合法的 JSON：{error}"))?;

    // Validate before anything runs: a project with one bad step should fail
    // immediately, not halfway through a deploy.
    for step in &steps {
        crate::safe::validate_deploy_step(step, &project.deploy_path)
            .map_err(|error| error.to_string())?;
    }

    let server_name = db::get_server(&conn, &project.server_id)
        .map_err(|error| error.to_string())?
        .map(|server| server.name)
        .unwrap_or_default();

    let now = db::AppDb::now();
    let deployment_id = deployment_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut record = db::DeploymentRecord {
        id: deployment_id,
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        server_id: project.server_id.clone(),
        server_name: server_name.clone(),
        status: db::DEPLOY_RUNNING.to_string(),
        trigger_source: "manual".to_string(),
        branch: project.branch.clone(),
        commit_sha: String::new(),
        started_at: Some(now),
        finished_at: None,
        duration_ms: None,
        log: String::new(),
        error_message: None,
        created_at: now,
    };
    db::insert_deployment(&conn, &record).map_err(|error| error.to_string())?;
    db::set_project_status(&conn, &project.id, db::DEPLOY_RUNNING)
        .map_err(|error| error.to_string())?;

    let event = format!("deploy-progress-{}", record.id);
    let mut log = String::new();
    let mut failure: Option<String> = None;

    for (index, step) in steps.iter().enumerate() {
        let header = format!("[{}/{}] $ {}\n", index + 1, steps.len(), step);
        log.push_str(&header);
        let _ = app.emit(&event, log.clone());

        match crate::remote::run_capability(
            &state.ssh,
            &session_id,
            &crate::safe::Capability::DeployStep {
                step: step.clone(),
                root: project.deploy_path.clone(),
            },
        )
        .await
        {
            Ok(output) => {
                if !output.trim().is_empty() {
                    log.push_str(output.trim_end());
                    log.push('\n');
                }
            }
            Err(error) => {
                // The failing step's output is what makes the failure
                // diagnosable, so it is kept in the log.
                log.push_str(&format!("失败：{error}\n"));
                failure = Some(error.to_string());
            }
        }

        let _ = app.emit(&event, log.clone());
        if failure.is_some() {
            break;
        }
    }

    let finished = db::AppDb::now();
    let status = if failure.is_some() {
        db::DEPLOY_FAILED
    } else {
        db::DEPLOY_SUCCESS
    };
    record.status = status.to_string();
    record.finished_at = Some(finished);
    record.started_at = Some(record.started_at.unwrap_or(finished));
    record.duration_ms = Some((finished - record.started_at.unwrap_or(finished)).max(0));
    record.log = log.clone();
    record.error_message = failure.clone();

    db::update_deployment_progress(
        &conn,
        &record.id,
        status,
        &log,
        record.started_at,
        record.finished_at,
        failure.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    db::set_project_status(&conn, &project.id, status).map_err(|error| error.to_string())?;

    record_audit(
        &state,
        "deployment_execute",
        Some(&project.server_id),
        Some(&server_name),
        &format!(
            "{{\"project\":\"{}\",\"status\":\"{status}\",\"deployment\":\"{}\"}}",
            project.name, record.id
        ),
    );
    let _ = app.emit(&event, log);

    Ok(record)
}

/// Project validation kept free of Tauri types so it can be unit-tested.
fn validate_project(conn: &Connection, project: &db::ProjectRecord) -> Result<(), String> {
    if project.name.trim().is_empty() {
        return Err("项目名称不能为空".to_string());
    }
    if project.server_id.trim().is_empty() {
        return Err("请选择部署服务器".to_string());
    }
    db::get_server(conn, &project.server_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "所选服务器不存在，请重新选择".to_string())?;

    let path = project.deploy_path.trim();
    if !path.starts_with('/') {
        return Err("部署路径必须是绝对路径".to_string());
    }
    crate::safe::validate_abs_path(path, "部署路径").map_err(|error| error.to_string())?;

    if !project.branch.trim().is_empty() {
        crate::safe::validate_git_ref(project.branch.trim()).map_err(|error| error.to_string())?;
    }
    if !project.repo_url.trim().is_empty() {
        crate::safe::validate_repo_url(project.repo_url.trim())
            .map_err(|error| error.to_string())?;
    }

    // The important one: a deployment step is a command, so it is held to the
    // allowlist and confined to the project directory.
    let steps: Vec<String> = serde_json::from_str(&project.commands_json)
        .map_err(|error| format!("部署步骤不是合法的 JSON 数组：{error}"))?;
    if steps.is_empty() {
        return Err("至少需要一个部署步骤".to_string());
    }
    for step in &steps {
        crate::safe::validate_deploy_step(step, path).map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_service_action, session_record, validate_project, validate_server};
    use crate::db::{
        self, insert_or_replace_server, CredentialRecord, ServerGroupRecord, ServerRecord,
    };
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Mirrors `AppDb::init` without touching the filesystem.
        conn.execute_batch(
            r#"
            CREATE TABLE servers (
                id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL,
                port INTEGER NOT NULL, username TEXT NOT NULL, credential_id TEXT,
                group_id TEXT, tags TEXT NOT NULL DEFAULT '[]', proxy_jump_id TEXT,
                favorite INTEGER NOT NULL DEFAULT 0, last_connected_at INTEGER,
                status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE server_groups (
                id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE credentials (
                id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
                username TEXT NOT NULL, secret_ref TEXT, passphrase_ref TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            "#,
        )
        .unwrap();
        conn
    }

    fn server(id: &str) -> ServerRecord {
        ServerRecord {
            id: id.to_string(),
            name: "web".to_string(),
            host: "10.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            credential_id: None,
            group_id: None,
            tags: vec![],
            proxy_jump_id: None,
            favorite: false,
            last_connected_at: None,
            status: "idle".to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    fn project(id: &str, server_id: &str) -> db::ProjectRecord {
        db::ProjectRecord {
            id: id.to_string(),
            name: "app".to_string(),
            description: String::new(),
            server_id: server_id.to_string(),
            repo_url: "https://github.com/acme/app.git".to_string(),
            branch: "main".to_string(),
            deploy_path: "/var/www/app".to_string(),
            commands_json: r#"["git pull --ff-only","npm run build"]"#.to_string(),
            status: "idle".to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    fn credential(id: &str) -> CredentialRecord {
        CredentialRecord {
            id: id.to_string(),
            name: "key".to_string(),
            credential_type: "password".to_string(),
            username: "root".to_string(),
            secret_ref: Some(format!("cred-{id}")),
            passphrase_ref: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn rejects_unknown_service_actions() {
        // Only the six fixed verbs exist; anything else must not reach a shell.
        assert!(parse_service_action("restart").is_ok());
        assert!(parse_service_action("enable").is_ok());
        assert!(parse_service_action("rm -rf /").is_err());
        assert!(parse_service_action("").is_err());
    }

    // -- projects ------------------------------------------------------------

    #[test]
    fn accepts_a_well_formed_project() {
        let conn = db();
        insert_or_replace_server(&conn, &server("s1")).unwrap();
        assert!(validate_project(&conn, &project("p1", "s1")).is_ok());
    }

    #[test]
    fn rejects_a_project_without_a_name_or_server() {
        let conn = db();
        insert_or_replace_server(&conn, &server("s1")).unwrap();

        let mut blank = project("p1", "s1");
        blank.name = "  ".to_string();
        assert!(validate_project(&conn, &blank).is_err());

        // A project pointing at a deleted server would deploy nowhere.
        assert!(validate_project(&conn, &project("p1", "missing")).is_err());
    }

    #[test]
    fn rejects_a_relative_or_traversing_deploy_path() {
        let conn = db();
        insert_or_replace_server(&conn, &server("s1")).unwrap();

        let mut relative = project("p1", "s1");
        relative.deploy_path = "var/www/app".to_string();
        assert!(validate_project(&conn, &relative).is_err());

        let mut traversing = project("p1", "s1");
        traversing.deploy_path = "/var/www/../../etc".to_string();
        assert!(validate_project(&conn, &traversing).is_err());
    }

    #[test]
    fn rejects_a_project_whose_steps_are_not_allowlisted() {
        let conn = db();
        insert_or_replace_server(&conn, &server("s1")).unwrap();

        let mut evil = project("p1", "s1");
        evil.commands_json = r#"["git pull; rm -rf /"]"#.to_string();
        assert!(validate_project(&conn, &evil).is_err());

        let mut outside = project("p1", "s1");
        outside.commands_json = r#"["rm -rf /var/log"]"#.to_string();
        assert!(
            validate_project(&conn, &outside).is_err(),
            "步骤不能触碰项目目录之外"
        );
    }

    #[test]
    fn rejects_a_project_with_no_steps_or_broken_json() {
        let conn = db();
        insert_or_replace_server(&conn, &server("s1")).unwrap();

        let mut empty = project("p1", "s1");
        empty.commands_json = "[]".to_string();
        assert!(validate_project(&conn, &empty).is_err());

        let mut broken = project("p1", "s1");
        broken.commands_json = "not json".to_string();
        assert!(validate_project(&conn, &broken).is_err());
    }

    #[test]
    fn rejects_bad_repo_urls_and_branches() {
        let conn = db();
        insert_or_replace_server(&conn, &server("s1")).unwrap();

        let mut bad_url = project("p1", "s1");
        bad_url.repo_url = "rm -rf /".to_string();
        assert!(validate_project(&conn, &bad_url).is_err());

        let mut bad_branch = project("p1", "s1");
        bad_branch.branch = "--upload-pack=evil".to_string();
        assert!(validate_project(&conn, &bad_branch).is_err());
    }

    #[test]
    fn rejects_blank_fields_and_bad_ports() {
        let conn = db();
        let mut blank = server("s1");
        blank.name = "  ".to_string();
        assert!(validate_server(&conn, &blank).is_err());

        let mut bad_port = server("s1");
        bad_port.port = 70000;
        assert!(validate_server(&conn, &bad_port).is_err());

        assert!(validate_server(&conn, &server("s1")).is_ok());
    }

    #[test]
    fn rejects_unknown_credential_group_and_jump_host() {
        let conn = db();

        let mut unknown_credential = server("s1");
        unknown_credential.credential_id = Some("missing".to_string());
        assert!(validate_server(&conn, &unknown_credential).is_err());

        db::insert_or_replace_credential(&conn, &credential("c1")).unwrap();
        let mut known = server("s1");
        known.credential_id = Some("c1".to_string());
        assert!(validate_server(&conn, &known).is_ok());

        let mut unknown_group = server("s1");
        unknown_group.group_id = Some("missing".to_string());
        assert!(validate_server(&conn, &unknown_group).is_err());

        db::insert_or_replace_server_group(
            &conn,
            &ServerGroupRecord {
                id: "g1".to_string(),
                name: "prod".to_string(),
                sort_order: 0,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
        let mut known_group = server("s1");
        known_group.group_id = Some("g1".to_string());
        assert!(validate_server(&conn, &known_group).is_ok());

        let mut unknown_jump = server("s1");
        unknown_jump.proxy_jump_id = Some("missing".to_string());
        assert!(validate_server(&conn, &unknown_jump).is_err());
    }

    #[test]
    fn rejects_self_and_cyclic_jump_hosts() {
        let conn = db();
        db::insert_or_replace_server(&conn, &server("a")).unwrap();
        db::insert_or_replace_server(&conn, &server("b")).unwrap();

        let mut itself = server("a");
        itself.proxy_jump_id = Some("a".to_string());
        assert!(validate_server(&conn, &itself).is_err());

        // a -> b first, then b -> a would close a cycle.
        let mut a = server("a");
        a.proxy_jump_id = Some("b".to_string());
        db::insert_or_replace_server(&conn, &a).unwrap();
        let mut b = server("b");
        b.proxy_jump_id = Some("a".to_string());
        assert!(validate_server(&conn, &b).is_err());
    }

    #[test]
    fn session_record_tracks_status_and_geometry() {
        let connected = session_record(
            "sess-1",
            "s1",
            "web",
            "10.0.0.1",
            22,
            "root",
            "connected",
            None,
            100,
            40,
            true,
        );
        assert_eq!(connected.status, "connected");
        assert_eq!(connected.terminal_pty, Some(true));
        assert_eq!(connected.username, "root");
        assert_eq!(connected.terminal_cols, Some(100));
        assert_eq!(connected.terminal_rows, Some(40));
        assert!(connected.connected_at.is_some());
        assert!(connected.disconnected_at.is_none());

        let failed = session_record(
            "sess-2",
            "s1",
            "web",
            "10.0.0.1",
            22,
            "root",
            "error",
            Some("认证失败".to_string()),
            80,
            24,
            true,
        );
        assert_eq!(failed.error_message.as_deref(), Some("认证失败"));
        assert!(failed.connected_at.is_none());
        assert!(failed.disconnected_at.is_some());

        // Monitoring sessions record that they did not allocate a terminal.
        let monitor = session_record(
            "sess-3",
            "s1",
            "web",
            "10.0.0.1",
            22,
            "root",
            "connected",
            None,
            0,
            0,
            false,
        );
        assert_eq!(monitor.terminal_pty, Some(false));
        assert_eq!(monitor.terminal_cols, Some(0));
    }
}
