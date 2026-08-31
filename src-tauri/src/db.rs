use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AppDb {
    path: PathBuf,
}

impl AppDb {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn open(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }

    pub fn init(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = self.open()?;
        conn.execute_batch(SCHEMA_SQL)?;
        migrate(&conn)?;
        Ok(())
    }

    pub fn now() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

/// Current schema version. Bump it whenever `migrate()` gains a new step so an
/// already-created database is upgraded in place instead of silently drifting.
pub const SCHEMA_VERSION: u32 = 2;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    credential_id TEXT,
    group_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    proxy_jump_id TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    last_connected_at INTEGER,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_groups (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    username TEXT NOT NULL,
    secret_ref TEXT,
    passphrase_ref TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS known_hosts (
                id TEXT PRIMARY KEY NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                fingerprint TEXT NOT NULL,
                fingerprint_type TEXT NOT NULL,
                status TEXT NOT NULL,
                first_seen_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                UNIQUE(host, port)
            );

            CREATE TABLE IF NOT EXISTS ssh_sessions (
                id TEXT PRIMARY KEY NOT NULL,
                server_id TEXT NOT NULL,
                server_name TEXT NOT NULL,
                server_host TEXT NOT NULL,
                server_port INTEGER NOT NULL,
                username TEXT NOT NULL,
                status TEXT NOT NULL,
                connected_at INTEGER,
                disconnected_at INTEGER,
                error_message TEXT,
                keep_alive_interval INTEGER NOT NULL,
                reconnect_policy TEXT NOT NULL,
                terminal_rows INTEGER,
                terminal_cols INTEGER,
                terminal_pty INTEGER,
                sftp_enabled INTEGER NOT NULL,
                port_forwards TEXT NOT NULL DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS command_history (
                id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL,
                server_id TEXT NOT NULL,
                server_name TEXT NOT NULL,
                command TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                exit_code INTEGER,
                source TEXT NOT NULL,
                output TEXT
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY NOT NULL,
                action TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                user_id TEXT,
                server_id TEXT,
                server_name TEXT,
                project_id TEXT,
                project_name TEXT,
                details TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT
);
"#;

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(columns.iter().any(|existing| existing == column))
}

fn add_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    if column_exists(conn, table, column)? {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )?;
    Ok(())
}

/// Idempotent, ordered schema upgrades. Every step must be safe to run twice.
pub fn migrate(conn: &Connection) -> Result<()> {
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
        .unwrap_or(0);

    if version < 1 {
        // v1 == the original `CREATE TABLE IF NOT EXISTS` baseline.
        conn.pragma_update(None, "user_version", 1u32)?;
    }
    if version < 2 {
        add_column(conn, "servers", "favorite", "INTEGER NOT NULL DEFAULT 0")?;
        add_column(conn, "servers", "last_connected_at", "INTEGER")?;
        add_column(conn, "credentials", "passphrase_ref", "TEXT")?;
        conn.pragma_update(None, "user_version", 2u32)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerRecord {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub credential_id: Option<String>,
    pub group_id: Option<String>,
    pub tags: Vec<String>,
    pub proxy_jump_id: Option<String>,
    pub favorite: bool,
    pub last_connected_at: Option<i64>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerGroupRecord {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialRecord {
    pub id: String,
    pub name: String,
    pub credential_type: String,
    pub username: String,
    pub secret_ref: Option<String>,
    pub passphrase_ref: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHostRecord {
    pub id: String,
    pub host: String,
    pub port: i64,
    pub fingerprint: String,
    pub fingerprint_type: String,
    pub status: String,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub server_id: String,
    pub server_name: String,
    pub server_host: String,
    pub server_port: i64,
    pub username: String,
    pub status: String,
    pub connected_at: Option<i64>,
    pub disconnected_at: Option<i64>,
    pub error_message: Option<String>,
    pub keep_alive_interval: i64,
    pub reconnect_policy: String,
    pub terminal_rows: Option<i64>,
    pub terminal_cols: Option<i64>,
    pub terminal_pty: Option<bool>,
    pub sftp_enabled: bool,
    pub port_forwards_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandHistoryRecord {
    pub id: String,
    pub session_id: String,
    pub server_id: String,
    pub server_name: String,
    pub command: String,
    pub timestamp: i64,
    pub exit_code: Option<i64>,
    pub source: String,
    pub output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLogRecord {
    pub id: String,
    pub action: String,
    pub timestamp: i64,
    pub user_id: Option<String>,
    pub server_id: Option<String>,
    pub server_name: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub details_json: String,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
}

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct CascadeResult {
    pub sessions: i64,
    pub history: i64,
}

pub fn count_servers_by_credential(conn: &Connection, credential_id: &str) -> Result<i64> {
    Ok(conn
        .prepare("SELECT COUNT(*) FROM servers WHERE credential_id = ?1")?
        .query_row([credential_id], |row| row.get(0))?)
}

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
        Ok(Some(KnownHostRecord {
            id: row.get("id")?,
            host: row.get("host")?,
            port: row.get("port")?,
            fingerprint: row.get("fingerprint")?,
            fingerprint_type: row.get("fingerprint_type")?,
            status: row.get("status")?,
            first_seen_at: row.get("first_seen_at")?,
            last_seen_at: row.get("last_seen_at")?,
        }))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch(SCHEMA_SQL).expect("schema");
        migrate(&conn).expect("migrate");
        conn
    }

    fn server(id: &str, name: &str) -> ServerRecord {
        ServerRecord {
            id: id.to_string(),
            name: name.to_string(),
            host: "10.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            credential_id: None,
            group_id: None,
            tags: vec![],
            proxy_jump_id: None,
            favorite: false,
            last_connected_at: None,
            status: "idle".to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    fn session_fixture(server_id: &str, server_name: &str) -> SessionRecord {
        SessionRecord {
            id: String::new(),
            server_id: server_id.to_string(),
            server_name: server_name.to_string(),
            server_host: "10.0.0.1".to_string(),
            server_port: 22,
            username: "root".to_string(),
            status: "connected".to_string(),
            connected_at: Some(1),
            disconnected_at: None,
            error_message: None,
            keep_alive_interval: 30,
            reconnect_policy: "manual".to_string(),
            terminal_rows: Some(24),
            terminal_cols: Some(80),
            terminal_pty: Some(true),
            sftp_enabled: false,
            port_forwards_json: "[]".to_string(),
        }
    }

    #[test]
    fn schema_reaches_current_version() {
        let conn = test_db();
        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("user_version");
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn migration_is_idempotent() {
        let conn = test_db();
        migrate(&conn).expect("second migrate");
        migrate(&conn).expect("third migrate");
        assert!(column_exists(&conn, "servers", "favorite").unwrap());
        assert!(column_exists(&conn, "credentials", "passphrase_ref").unwrap());
    }

    #[test]
    fn migration_upgrades_a_v1_database() {
        let conn = Connection::open_in_memory().unwrap();
        // Legacy v1 shapes: no favorite / last_connected_at / passphrase_ref.
        conn.execute_batch(
            r#"
            CREATE TABLE servers (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                username TEXT NOT NULL,
                credential_id TEXT,
                group_id TEXT,
                tags TEXT NOT NULL DEFAULT '[]',
                proxy_jump_id TEXT,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE credentials (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                username TEXT NOT NULL,
                secret_ref TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            "#,
        )
        .unwrap();
        migrate(&conn).unwrap();

        insert_or_replace_server(&conn, &server("s1", "legacy")).expect("save legacy server");
        let loaded = get_server(&conn, "s1").unwrap().unwrap();
        assert!(!loaded.favorite);
        assert_eq!(loaded.last_connected_at, None);
    }

    #[test]
    fn favorite_round_trips() {
        let conn = test_db();
        insert_or_replace_server(&conn, &server("s1", "web")).unwrap();
        set_server_favorite(&conn, "s1", true).unwrap();
        assert!(get_server(&conn, "s1").unwrap().unwrap().favorite);
        set_server_favorite(&conn, "s1", false).unwrap();
        assert!(!get_server(&conn, "s1").unwrap().unwrap().favorite);
    }

    #[test]
    fn deleting_a_server_cascades_to_sessions_and_history() {
        let conn = test_db();
        insert_or_replace_server(&conn, &server("s1", "web")).unwrap();
        insert_session(
            &conn,
            &SessionRecord {
                id: "sess-1".to_string(),
                ..session_fixture("s1", "web")
            },
        )
        .unwrap();
        insert_command_history(
            &conn,
            &CommandHistoryRecord {
                id: "h1".to_string(),
                session_id: "sess-1".to_string(),
                server_id: "s1".to_string(),
                server_name: "web".to_string(),
                command: "uptime".to_string(),
                timestamp: 1,
                exit_code: None,
                source: "terminal".to_string(),
                output: None,
            },
        )
        .unwrap();

        let result = delete_server_cascade(&conn, "s1").unwrap();
        assert_eq!(result.sessions, 1);
        assert_eq!(result.history, 1);
        assert!(get_server(&conn, "s1").unwrap().is_none());
        assert!(list_recent_sessions(&conn, 10).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_server_clears_jump_host_references() {
        let conn = test_db();
        insert_or_replace_server(&conn, &server("jump", "jump")).unwrap();
        let mut dependent = server("target", "target");
        dependent.proxy_jump_id = Some("jump".to_string());
        insert_or_replace_server(&conn, &dependent).unwrap();

        delete_server_cascade(&conn, "jump").unwrap();

        assert_eq!(
            get_server(&conn, "target").unwrap().unwrap().proxy_jump_id,
            None
        );
    }

    #[test]
    fn deleting_a_credential_clears_server_references() {
        let conn = test_db();
        insert_or_replace_credential(
            &conn,
            &CredentialRecord {
                id: "c1".to_string(),
                name: "key".to_string(),
                credential_type: "password".to_string(),
                username: "root".to_string(),
                secret_ref: Some("cred-1".to_string()),
                passphrase_ref: None,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
        let mut dependent = server("s1", "web");
        dependent.credential_id = Some("c1".to_string());
        insert_or_replace_server(&conn, &dependent).unwrap();
        assert_eq!(count_servers_by_credential(&conn, "c1").unwrap(), 1);

        delete_credential(&conn, "c1").unwrap();

        assert_eq!(count_servers_by_credential(&conn, "c1").unwrap(), 0);
        assert_eq!(
            get_server(&conn, "s1").unwrap().unwrap().credential_id,
            None
        );
    }

    #[test]
    fn trusting_a_known_host_is_upserted() {
        let conn = test_db();
        let first = trust_known_host(&conn, "10.0.0.1", 22, "SHA256:aaa", "ssh-ed25519").unwrap();
        let second = trust_known_host(&conn, "10.0.0.1", 22, "SHA256:bbb", "ssh-ed25519").unwrap();

        assert_eq!(first.id, second.id, "trust must not duplicate the host row");
        assert_eq!(second.fingerprint, "SHA256:bbb");
        assert_eq!(second.status, "confirmed");
        assert_eq!(list_known_hosts(&conn).unwrap().len(), 1);

        assert!(delete_known_host(&conn, &second.id).unwrap());
        assert!(list_known_hosts(&conn).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_group_unlinks_its_servers() {
        let conn = test_db();
        insert_or_replace_server_group(
            &conn,
            &ServerGroupRecord {
                id: "g1".to_string(),
                name: "prod".to_string(),
                sort_order: 0,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
        let mut dependent = server("s1", "web");
        dependent.group_id = Some("g1".to_string());
        insert_or_replace_server(&conn, &dependent).unwrap();

        delete_server_group(&conn, "g1").unwrap();

        assert_eq!(get_server(&conn, "s1").unwrap().unwrap().group_id, None);
        assert!(list_server_groups(&conn).unwrap().is_empty());
    }
}
