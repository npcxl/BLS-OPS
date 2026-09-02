//! Servers and server groups.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::model::{CascadeResult, ServerGroupRecord, ServerRecord};
use super::schema::AppDb;

pub fn server_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ServerRecord> {
    let tags_json: String = row.get("tags")?;
    Ok(ServerRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        host: row.get("host")?,
        port: row.get("port")?,
        username: row.get("username")?,
        credential_id: row.get("credential_id")?,
        group_id: row.get("group_id")?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        proxy_jump_id: row.get("proxy_jump_id")?,
        favorite: row.get::<_, i64>("favorite")? != 0,
        last_connected_at: row.get("last_connected_at")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert_or_replace_server(conn: &Connection, server: &ServerRecord) -> Result<()> {
    let tags = serde_json::to_string(&server.tags)?;
    conn.execute(
        r#"
        INSERT INTO servers (id, name, host, port, username, credential_id, group_id, tags, proxy_jump_id, favorite, last_connected_at, status, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            host=excluded.host,
            port=excluded.port,
            username=excluded.username,
            credential_id=excluded.credential_id,
            group_id=excluded.group_id,
            tags=excluded.tags,
            proxy_jump_id=excluded.proxy_jump_id,
            favorite=excluded.favorite,
            last_connected_at=excluded.last_connected_at,
            status=excluded.status,
            updated_at=excluded.updated_at
        "#,
        params![
            server.id,
            server.name,
            server.host,
            server.port,
            server.username,
            server.credential_id,
            server.group_id,
            tags,
            server.proxy_jump_id,
            i64::from(server.favorite),
            server.last_connected_at,
            server.status,
            server.created_at,
            server.updated_at,
        ],
    )?;
    Ok(())
}

pub fn set_server_favorite(conn: &Connection, id: &str, favorite: bool) -> Result<()> {
    conn.execute(
        "UPDATE servers SET favorite = ?1, updated_at = ?2 WHERE id = ?3",
        params![i64::from(favorite), AppDb::now(), id],
    )?;
    Ok(())
}

pub fn touch_server_connection(conn: &Connection, id: &str) -> Result<()> {
    let now = AppDb::now();
    conn.execute(
        "UPDATE servers SET last_connected_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

/// Removes a server together with every row that references it, so the UI never
/// shows sessions or history for a server that no longer exists.
pub fn delete_server_cascade(conn: &Connection, id: &str) -> Result<CascadeResult> {
    let sessions: i64 = conn
        .prepare("SELECT COUNT(*) FROM ssh_sessions WHERE server_id = ?1")?
        .query_row([id], |row| row.get(0))?;
    let history: i64 = conn
        .prepare("SELECT COUNT(*) FROM command_history WHERE server_id = ?1")?
        .query_row([id], |row| row.get(0))?;

    conn.execute("DELETE FROM command_history WHERE server_id = ?1", [id])?;
    conn.execute("DELETE FROM ssh_sessions WHERE server_id = ?1", [id])?;
    conn.execute("DELETE FROM servers WHERE id = ?1", [id])?;
    // Any remaining server pointing at this one as a jump host would dangle.
    conn.execute(
        "UPDATE servers SET proxy_jump_id = NULL WHERE proxy_jump_id = ?1",
        [id],
    )?;

    Ok(CascadeResult { sessions, history })
}

pub fn count_servers_by_credential(conn: &Connection, credential_id: &str) -> Result<i64> {
    Ok(conn
        .prepare("SELECT COUNT(*) FROM servers WHERE credential_id = ?1")?
        .query_row([credential_id], |row| row.get(0))?)
}

pub fn list_servers(conn: &Connection) -> Result<Vec<ServerRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM servers ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], server_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_server(conn: &Connection, id: &str) -> Result<Option<ServerRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM servers WHERE id = ?1 LIMIT 1")?;
    let mut rows = stmt.query([id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(server_from_row(row)?))
    } else {
        Ok(None)
    }
}

// -- groups ------------------------------------------------------------------

pub fn list_server_groups(conn: &Connection) -> Result<Vec<ServerGroupRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM server_groups ORDER BY sort_order ASC, name ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(ServerGroupRecord {
            id: row.get("id")?,
            name: row.get("name")?,
            sort_order: row.get("sort_order")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn insert_or_replace_server_group(conn: &Connection, group: &ServerGroupRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO server_groups (id, name, sort_order, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            sort_order=excluded.sort_order,
            updated_at=excluded.updated_at
        "#,
        params![
            group.id,
            group.name,
            group.sort_order,
            group.created_at,
            group.updated_at
        ],
    )?;
    Ok(())
}

pub fn delete_server_group(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE servers SET group_id = NULL WHERE group_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM server_groups WHERE id = ?1", [id])?;
    Ok(())
}
