//! Host-key trust store.
//!
//! Nothing here trusts a key on its own: a fingerprint is only ever recorded
//! through `trust_known_host`, which the SSH layer calls after the user has
//! confirmed it in the UI.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::model::KnownHostRecord;
use super::schema::AppDb;

pub fn insert_known_host(conn: &Connection, host: &KnownHostRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO known_hosts (id, host, port, fingerprint, fingerprint_type, status, first_seen_at, last_seen_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(host, port) DO UPDATE SET
            fingerprint=excluded.fingerprint,
            fingerprint_type=excluded.fingerprint_type,
            status=excluded.status,
            last_seen_at=excluded.last_seen_at
        "#,
        params![
            host.id,
            host.host,
            host.port,
            host.fingerprint,
            host.fingerprint_type,
            host.status,
            host.first_seen_at,
            host.last_seen_at,
        ],
    )?;
    Ok(())
}

pub fn get_known_host(conn: &Connection, host: &str, port: i64) -> Result<Option<KnownHostRecord>> {
    let mut stmt =
        conn.prepare("SELECT * FROM known_hosts WHERE host = ?1 AND port = ?2 LIMIT 1")?;
    let mut rows = stmt.query(params![host, port])?;
    if let Some(row) = rows.next()? {
        Ok(Some(known_host_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn list_known_hosts(conn: &Connection) -> Result<Vec<KnownHostRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM known_hosts ORDER BY last_seen_at DESC")?;
    let rows = stmt.query_map([], known_host_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn known_host_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnownHostRecord> {
    Ok(KnownHostRecord {
        id: row.get("id")?,
        host: row.get("host")?,
        port: row.get("port")?,
        fingerprint: row.get("fingerprint")?,
        fingerprint_type: row.get("fingerprint_type")?,
        status: row.get("status")?,
        first_seen_at: row.get("first_seen_at")?,
        last_seen_at: row.get("last_seen_at")?,
    })
}

pub fn delete_known_host(conn: &Connection, id: &str) -> Result<bool> {
    let affected = conn.execute("DELETE FROM known_hosts WHERE id = ?1", [id])?;
    Ok(affected > 0)
}

/// Records (or refreshes) a trusted host key. Used by the host-key confirmation
/// dialog; the SSH layer never trusts an unverified key.
pub fn trust_known_host(
    conn: &Connection,
    host: &str,
    port: i64,
    fingerprint: &str,
    fingerprint_type: &str,
) -> Result<KnownHostRecord> {
    let now = AppDb::now();
    let existing = get_known_host(conn, host, port)?;
    let record = KnownHostRecord {
        id: existing
            .as_ref()
            .map(|item| item.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        host: host.to_string(),
        port,
        fingerprint: fingerprint.to_string(),
        fingerprint_type: fingerprint_type.to_string(),
        status: "confirmed".to_string(),
        first_seen_at: existing
            .as_ref()
            .map(|item| item.first_seen_at)
            .unwrap_or(now),
        last_seen_at: now,
    };
    insert_known_host(conn, &record)?;
    Ok(record)
}
