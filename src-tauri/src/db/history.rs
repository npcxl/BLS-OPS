//! Command history.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Deserialize;

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

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryFilter {
    pub session_id: Option<String>,
    pub server_id: Option<String>,
    pub quick_target: Option<String>,
    pub query: Option<String>,
}

pub fn list_command_history(
    conn: &Connection,
    limit: i64,
    filter: &CommandHistoryFilter,
) -> Result<Vec<CommandHistoryRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM command_history
         WHERE ((?1 IS NULL AND ?2 IS NULL AND ?3 IS NULL)
             OR session_id = ?1 OR server_id = ?2
             OR (server_id = '' AND server_name = ?3))
           AND instr(lower(command), lower(?4)) > 0
         ORDER BY timestamp DESC, rowid DESC LIMIT ?5",
    )?;
    let rows = stmt.query_map(
        params![
            filter.session_id,
            filter.server_id,
            filter.quick_target,
            filter.query.as_deref().unwrap_or_default().trim(),
            limit,
        ],
        |row| {
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
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_history_search_finds_older_custom_commands_on_the_same_target() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::super::schema::SCHEMA_SQL)
            .unwrap();
        for (id, target, command, timestamp) in [
            ("older", "ops@host:22", "company-tool --check", 1),
            ("recent", "ops@host:22", "pwd", 2),
            ("other", "ops@host:2222", "company-tool --reset", 3),
        ] {
            insert_command_history(
                &conn,
                &CommandHistoryRecord {
                    id: id.into(),
                    session_id: "old-session".into(),
                    server_id: String::new(),
                    server_name: target.into(),
                    command: command.into(),
                    timestamp,
                    exit_code: None,
                    source: "terminal".into(),
                    output: None,
                },
            )
            .unwrap();
        }
        let filter = CommandHistoryFilter {
            session_id: Some("reconnected-session".into()),
            quick_target: Some("ops@host:22".into()),
            query: Some("company-tool".into()),
            ..Default::default()
        };
        let rows = list_command_history(&conn, 1, &filter).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].command, "company-tool --check");
    }
}
