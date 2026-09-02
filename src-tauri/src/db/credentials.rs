//! Credentials.
//!
//! The `secret_ref` / `passphrase_ref` columns hold keyring references only —
//! the secrets themselves are never written to SQLite.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::model::CredentialRecord;

pub fn insert_or_replace_credential(
    conn: &Connection,
    credential: &CredentialRecord,
) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO credentials (id, name, type, username, secret_ref, passphrase_ref, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            type=excluded.type,
            username=excluded.username,
            secret_ref=excluded.secret_ref,
            passphrase_ref=excluded.passphrase_ref,
            updated_at=excluded.updated_at
        "#,
        params![
            credential.id,
            credential.name,
            credential.credential_type,
            credential.username,
            credential.secret_ref,
            credential.passphrase_ref,
            credential.created_at,
            credential.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get_credential(conn: &Connection, id: &str) -> Result<Option<CredentialRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM credentials WHERE id = ?1 LIMIT 1")?;
    let mut rows = stmt.query([id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(credential_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn credential_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CredentialRecord> {
    Ok(CredentialRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        credential_type: row.get("type")?,
        username: row.get("username")?,
        secret_ref: row.get("secret_ref")?,
        passphrase_ref: row.get("passphrase_ref")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn list_credentials(conn: &Connection) -> Result<Vec<CredentialRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM credentials ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], credential_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn delete_credential(conn: &Connection, id: &str) -> Result<()> {
    // Servers referencing a removed credential would be unable to connect, so the
    // reference is cleared explicitly instead of leaving a dangling id.
    conn.execute(
        "UPDATE servers SET credential_id = NULL WHERE credential_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM credentials WHERE id = ?1", [id])?;
    Ok(())
}
