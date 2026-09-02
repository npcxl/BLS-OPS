//! SSH session rows.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::model::SessionRecord;
use super::schema::AppDb;

pub fn insert_session(conn: &Connection, session: &SessionRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO ssh_sessions (
            id, server_id, server_name, server_host, server_port, username, status,
            connected_at, disconnected_at, error_message, keep_alive_interval,
            reconnect_policy, terminal_rows, terminal_cols, terminal_pty, sftp_enabled, port_forwards
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ON CONFLICT(id) DO UPDATE SET
            server_id=excluded.server_id,
            server_name=excluded.server_name,
            server_host=excluded.server_host,
            server_port=excluded.server_port,
            username=excluded.username,
            status=excluded.status,
            connected_at=excluded.connected_at,
            disconnected_at=excluded.disconnected_at,
            error_message=excluded.error_message,
            keep_alive_interval=excluded.keep_alive_interval,
            reconnect_policy=excluded.reconnect_policy,
            terminal_rows=excluded.terminal_rows,
            terminal_cols=excluded.terminal_cols,
            terminal_pty=excluded.terminal_pty,
            sftp_enabled=excluded.sftp_enabled,
            port_forwards=excluded.port_forwards
        "#,
        params![
            session.id,
            session.server_id,
            session.server_name,
            session.server_host,
            session.server_port,
            session.username,
            session.status,
            session.connected_at,
            session.disconnected_at,
            session.error_message,
            session.keep_alive_interval,
            session.reconnect_policy,
            session.terminal_rows,
            session.terminal_cols,
            session.terminal_pty.map(i64::from),
            session.sftp_enabled,
            session.port_forwards_json,
        ],
    )?;
    Ok(())
}

pub fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        id: row.get("id")?,
        server_id: row.get("server_id")?,
        server_name: row.get("server_name")?,
        server_host: row.get("server_host")?,
        server_port: row.get("server_port")?,
        username: row.get("username")?,
        status: row.get("status")?,
        connected_at: row.get("connected_at")?,
        disconnected_at: row.get("disconnected_at")?,
        error_message: row.get("error_message")?,
        keep_alive_interval: row.get("keep_alive_interval")?,
        reconnect_policy: row.get("reconnect_policy")?,
        terminal_rows: row.get("terminal_rows")?,
        terminal_cols: row.get("terminal_cols")?,
        terminal_pty: row.get::<_, Option<i64>>("terminal_pty")?.map(|v| v != 0),
        sftp_enabled: row.get::<_, i64>("sftp_enabled")? != 0,
        port_forwards_json: row.get("port_forwards")?,
    })
}

pub fn list_recent_sessions(conn: &Connection, limit: i64) -> Result<Vec<SessionRecord>> {
    let mut stmt = conn
        .prepare("SELECT * FROM ssh_sessions ORDER BY COALESCE(connected_at, 0) DESC LIMIT ?1")?;
    let rows = stmt.query_map([limit], session_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn update_session_status(
    conn: &Connection,
    id: &str,
    status: &str,
    error_message: Option<&str>,
) -> Result<()> {
    if status == "disconnected" || status == "error" {
        conn.execute(
            "UPDATE ssh_sessions SET status = ?1, error_message = ?2, disconnected_at = COALESCE(disconnected_at, ?3) WHERE id = ?4",
            params![status, error_message, AppDb::now(), id],
        )?;
    } else {
        conn.execute(
            "UPDATE ssh_sessions SET status = ?1, error_message = ?2 WHERE id = ?3",
            params![status, error_message, id],
        )?;
    }
    Ok(())
}
