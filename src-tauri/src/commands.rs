use rusqlite::Connection;
use serde::Serialize;
use tauri::{Emitter, State};

use crate::{
    db,
    db::{CredentialRecord, ServerRecord},
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

fn build_target(
    conn: &Connection,
    host: String,
    port: i64,
    username: String,
    credential_id: Option<String>,
    proxy_jump_id: Option<String>,
) -> Result<ConnectTarget, String> {
    let credential_id = credential_id.ok_or_else(|| "请先为该连接选择凭据".to_string())?;
    let credential = require_existing_credential(conn, &credential_id)?;
    let secrets = load_secrets(&credential)?;
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
        terminal_pty: Some(true),
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
        cols,
        rows,
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
    state.ssh.disconnect(&session_id).await;
    let conn = open_db(&state)?;
    db::update_session_status(&conn, &session_id, "disconnected", None)
        .map_err(|error| error.to_string())?;
    record_audit(&state, "ssh_disconnect", None, None, &session_id);
    let _ = app.emit(&format!("ssh-closed-{session_id}"), "user");
    Ok(())
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
        80,
        24,
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
    cols: u32,
    rows: u32,
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

#[cfg(test)]
mod tests {
    use super::{session_record, validate_server};
    use crate::db::{self, CredentialRecord, ServerGroupRecord, ServerRecord};
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
        );
        assert_eq!(connected.status, "connected");
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
        );
        assert_eq!(failed.error_message.as_deref(), Some("认证失败"));
        assert!(failed.connected_at.is_none());
        assert!(failed.disconnected_at.is_some());
    }
}
