//! Audit log — append-only, one row per state-changing action.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::model::AuditLogRecord;

pub fn insert_audit_log(conn: &Connection, audit: &AuditLogRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO audit_logs (id, action, timestamp, user_id, server_id, server_name, project_id, project_name, details, ip_address, user_agent)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
        params![
            audit.id,
            audit.action,
            audit.timestamp,
            audit.user_id,
            audit.server_id,
            audit.server_name,
            audit.project_id,
            audit.project_name,
            audit.details_json,
            audit.ip_address,
            audit.user_agent,
        ],
    )?;
    Ok(())
}

pub fn list_audit_logs(conn: &Connection, limit: i64) -> Result<Vec<AuditLogRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?1")?;
    let rows = stmt.query_map([limit], |row| {
        Ok(AuditLogRecord {
            id: row.get("id")?,
            action: row.get("action")?,
            timestamp: row.get("timestamp")?,
            user_id: row.get("user_id")?,
            server_id: row.get("server_id")?,
            server_name: row.get("server_name")?,
            project_id: row.get("project_id")?,
            project_name: row.get("project_name")?,
            details_json: row.get("details")?,
            ip_address: row.get("ip_address")?,
            user_agent: row.get("user_agent")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
