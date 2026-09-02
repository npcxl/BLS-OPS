//! Server and server-group commands.

use rusqlite::Connection;
use tauri::State;

use super::{open_db, record_audit, require_existing_credential};
use crate::{db, db::ServerRecord, state::AppState};

/// All referential checks for a server, kept free of Tauri types so it can be
/// unit-tested directly.
pub(crate) fn validate_server(conn: &Connection, server: &ServerRecord) -> Result<(), String> {
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
