use tauri::{Emitter, State};

use crate::{db, keyring, state::AppState};

fn open_db(state: &AppState) -> Result<rusqlite::Connection, String> {
    state.db.open().map_err(|error| error.to_string())
}

fn record_audit(state: &AppState, action: &str, server_id: Option<&str>, server_name: Option<&str>, details: &str) {
    let Ok(conn) = state.db.open() else { return };
    let _ = db::insert_audit_log(&conn, &db::AuditLogRecord {
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
    });
}

#[tauri::command]
pub fn server_list(state: State<'_, AppState>) -> Result<Vec<db::ServerRecord>, String> {
    let conn = open_db(&state)?;
    db::list_servers(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn server_get(state: State<'_, AppState>, id: String) -> Result<Option<db::ServerRecord>, String> {
    let conn = open_db(&state)?;
    db::get_server(&conn, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn server_save(state: State<'_, AppState>, server: db::ServerRecord) -> Result<db::ServerRecord, String> {
    if server.name.trim().is_empty() || server.host.trim().is_empty() || server.username.trim().is_empty() {
        return Err("服务器名称、主机和用户名不能为空".to_string());
    }
    if !(1..=65535).contains(&server.port) {
        return Err("端口必须在 1 到 65535 之间".to_string());
    }

    let conn = open_db(&state)?;
    db::insert_or_replace_server(&conn, &server).map_err(|error| error.to_string())?;
    db::get_server(&conn, &server.id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "保存服务器后无法读取记录".to_string())
}

#[tauri::command]
pub fn server_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    db::delete_server(&conn, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn credential_list(state: State<'_, AppState>) -> Result<Vec<db::CredentialRecord>, String> {
    let conn = open_db(&state)?;
    db::list_credentials(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn credential_save(state: State<'_, AppState>, mut credential: db::CredentialRecord, secret: Option<String>) -> Result<db::CredentialRecord, String> {
    if credential.name.trim().is_empty() || credential.username.trim().is_empty() {
        return Err("凭据名称和用户名不能为空".to_string());
    }
    if let Some(value) = secret.as_deref() {
        let secret_ref = credential.secret_ref.as_deref().filter(|value| !value.trim().is_empty()).unwrap_or(&credential.id);
        keyring::save_secret(secret_ref, value).map_err(|error| error.to_string())?;
        credential.secret_ref = Some(secret_ref.to_string());
    }

    let conn = open_db(&state)?;
    db::insert_or_replace_credential(&conn, &credential).map_err(|error| error.to_string())?;
    db::list_credentials(&conn)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == credential.id)
        .ok_or_else(|| "保存凭据后无法读取记录".to_string())
}

#[tauri::command]
pub fn credential_delete(state: State<'_, AppState>, id: String, secret_ref: Option<String>) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("DELETE FROM credentials WHERE id = ?1", [&id]).map_err(|error| error.to_string())?;
    if let Some(secret_ref) = secret_ref.filter(|value| !value.trim().is_empty()) {
        let _ = keyring::delete_secret(&secret_ref);
    }
    Ok(())
}

#[tauri::command]
pub fn known_host_list(state: State<'_, AppState>) -> Result<Vec<db::KnownHostRecord>, String> {
    let conn = open_db(&state)?;
    db::list_known_hosts(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn known_host_get(state: State<'_, AppState>, host: String, port: i64) -> Result<Option<db::KnownHostRecord>, String> {
    let conn = open_db(&state)?;
    db::get_known_host(&conn, &host, port).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn known_host_save(state: State<'_, AppState>, host: db::KnownHostRecord) -> Result<db::KnownHostRecord, String> {
    if host.host.trim().is_empty() || host.fingerprint.trim().is_empty() {
        return Err("主机地址和指纹不能为空".to_string());
    }
    if !(1..=65535).contains(&host.port) {
        return Err("端口必须在 1 到 65535 之间".to_string());
    }
    let conn = open_db(&state)?;
    db::insert_known_host(&conn, &host).map_err(|error| error.to_string())?;
    db::get_known_host(&conn, &host.host, host.port)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "保存主机指纹后无法读取记录".to_string())
}

#[tauri::command]
pub fn credential_save_secret(secret_id: String, secret: String) -> Result<String, String> {
    if secret_id.trim().is_empty() {
        return Err("凭据引用不能为空".to_string());
    }
    keyring::save_secret(&secret_id, &secret).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn credential_get_secret(secret_id: String) -> Result<String, String> {
    keyring::read_secret(&secret_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn credential_delete_secret(secret_id: String) -> Result<(), String> {
    keyring::delete_secret(&secret_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ssh_connect(app: tauri::AppHandle, state: State<'_, AppState>, session_id: String, server_id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    let server = db::get_server(&conn, &server_id).map_err(|error| error.to_string())?.ok_or_else(|| "服务器不存在".to_string())?;
    let credential_id = server.credential_id.clone().ok_or_else(|| "服务器尚未关联凭据".to_string())?;
    let credential = db::list_credentials(&conn).map_err(|error| error.to_string())?.into_iter().find(|item| item.id == credential_id).ok_or_else(|| "关联凭据不存在".to_string())?;
    let known_host = db::get_known_host(&conn, &server.host, server.port).map_err(|error| error.to_string())?;
    let expected_fingerprint = known_host.as_ref().map(|item| item.fingerprint.clone());
    let secret_ref = credential.secret_ref.clone().ok_or_else(|| "关联凭据尚未配置 secret_ref".to_string())?;
    let secret = keyring::read_secret(&secret_ref).map_err(|error| error.to_string())?;
    let connection = state.ssh.connect(session_id.clone(), server.clone(), credential, secret, expected_fingerprint).await.map_err(|error| error.to_string());
    let mut reader = match connection {
        Ok(reader) => reader,
        Err(error) => {
            let record = db::SessionRecord { id: session_id.clone(), server_id: server.id.clone(), server_name: server.name.clone(), server_host: server.host.clone(), server_port: server.port, username: server.username.clone(), status: "error".to_string(), connected_at: None, disconnected_at: Some(db::AppDb::now()), error_message: Some(error.clone()), keep_alive_interval: 30, reconnect_policy: "manual".to_string(), terminal_rows: None, terminal_cols: None, terminal_pty: Some(true), sftp_enabled: false, port_forwards_json: "[]".to_string() };
            let _ = db::insert_session(&conn, &record);
            record_audit(&state, "ssh_connect_error", Some(&server.id), Some(&server.name), &error);
            return Err(error);
        }
    };
    let record = db::SessionRecord { id: session_id.clone(), server_id: server.id.clone(), server_name: server.name.clone(), server_host: server.host.clone(), server_port: server.port, username: server.username.clone(), status: "connected".to_string(), connected_at: Some(db::AppDb::now()), disconnected_at: None, error_message: None, keep_alive_interval: 30, reconnect_policy: "manual".to_string(), terminal_rows: Some(32), terminal_cols: Some(120), terminal_pty: Some(true), sftp_enabled: false, port_forwards_json: "[]".to_string() };
    let _ = db::insert_session(&conn, &record);
    record_audit(&state, "ssh_connect", Some(&server.id), Some(&server.name), "connected");
    tauri::async_runtime::spawn(async move {
        while let Some(message) = reader.wait().await {
            let data = match message {
                russh::ChannelMsg::Data { data } | russh::ChannelMsg::ExtendedData { data, .. } => String::from_utf8_lossy(&data).into_owned(),
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close { .. } => break,
                _ => continue,
            };
            let _ = app.emit(&format!("ssh-output-{session_id}"), data);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn ssh_input(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    state.ssh.input(&session_id, data).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn history_record(state: State<'_, AppState>, session_id: String, server_id: String, server_name: String, command: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    let record = db::CommandHistoryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        session_id,
        server_id,
        server_name,
        command,
        timestamp: db::AppDb::now(),
        exit_code: None,
        source: "terminal".to_string(),
        output: None,
    };
    db::insert_command_history(&conn, &record).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn history_list(state: State<'_, AppState>, limit: i64) -> Result<Vec<db::CommandHistoryRecord>, String> {
    let conn = open_db(&state)?;
    db::list_command_history(&conn, limit.clamp(1, 500)).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn audit_log_list(state: State<'_, AppState>, limit: i64) -> Result<Vec<db::AuditLogRecord>, String> {
    let conn = open_db(&state)?;
    db::list_audit_logs(&conn, limit.clamp(1, 500)).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ssh_resize(state: State<'_, AppState>, session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    state.ssh.resize(&session_id, cols, rows).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.ssh.disconnect(&session_id).await;
    let conn = open_db(&state)?;
    conn.execute("UPDATE ssh_sessions SET status = ?1, disconnected_at = ?2 WHERE id = ?3", rusqlite::params!["disconnected", db::AppDb::now(), session_id]).map_err(|error| error.to_string())?;
    record_audit(&state, "ssh_disconnect", None, None, &session_id);
    Ok(())
}

#[tauri::command]
pub fn known_host_confirm(state: State<'_, AppState>, host: db::KnownHostRecord) -> Result<db::KnownHostRecord, String> {
    let now = db::AppDb::now();
    let record = db::KnownHostRecord { status: "confirmed".to_string(), last_seen_at: now, ..host.clone() };
    let saved = known_host_save(state.clone(), record)?;
    db::insert_audit_log(&state.db.open().map_err(|error| error.to_string())?, &db::AuditLogRecord {
        id: uuid::Uuid::new_v4().to_string(),
        action: "known_host_confirm".to_string(),
        timestamp: now,
        user_id: None,
        server_id: None,
        server_name: None,
        project_id: None,
        project_name: None,
        details_json: format!("{{\"host\":\"{}\",\"port\":{}}}", host.host.replace('"', "\\\""), host.port),
        ip_address: None,
        user_agent: Some("ops-workbench".to_string()),
    }).map_err(|error| error.to_string())?;
    Ok(saved)
} 

#[tauri::command]
pub fn audit_log_record(state: State<'_, AppState>, action: String, server_id: Option<String>, server_name: Option<String>, details: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    let record = db::AuditLogRecord { id: uuid::Uuid::new_v4().to_string(), action, timestamp: db::AppDb::now(), user_id: None, server_id, server_name, project_id: None, project_name: None, details_json: details, ip_address: None, user_agent: Some("ops-workbench".to_string()) };
    db::insert_audit_log(&conn, &record).map_err(|error| error.to_string())
} 
