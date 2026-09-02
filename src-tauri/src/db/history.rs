//! Command history.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::model::CommandHistoryRecord;

pub fn insert_command_history(conn: &Connection, history: &CommandHistoryRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO command_history (id, session_id, server_id, server_name, command, timestamp, exit_code, source, output)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            history.id,
            history.session_id,
            history.server_id,
            history.server_name,
            history.command,
            history.timestamp,
            history.exit_code,
            history.source,
            history.output,
        ],
    )?;
    Ok(())
}

pub fn list_command_history(conn: &Connection, limit: i64) -> Result<Vec<CommandHistoryRecord>> {
    let mut stmt =
        conn.prepare("SELECT * FROM command_history ORDER BY timestamp DESC LIMIT ?1")?;
    let rows = stmt.query_map([limit], |row| {
        Ok(CommandHistoryRecord {
            id: row.get("id")?,
            session_id: row.get("session_id")?,
            server_id: row.get("server_id")?,
            server_name: row.get("server_name")?,
            command: row.get("command")?,
            timestamp: row.get("timestamp")?,
            exit_code: row.get("exit_code")?,
            source: row.get("source")?,
            output: row.get("output")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
