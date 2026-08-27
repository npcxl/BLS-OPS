use tauri::State;

use crate::{db, keyring, state::AppState};

fn open_db(state: &AppState) -> Result<rusqlite::Connection, String> {
    state.db.open().map_err(|error| error.to_string())
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
