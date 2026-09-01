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
pub const SCHEMA_VERSION: u32 = 3;

/// Project and deployment tables (P3-2.2, P3-2.3).
///
/// A macro rather than a plain constant so the same literal can be spliced
/// into `SCHEMA_SQL` (fresh databases) and re-run by `migrate()` (existing
/// ones): both paths must produce exactly the same shape.
macro_rules! p3_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    server_id TEXT NOT NULL,
    repo_url TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT 'main',
    deploy_path TEXT NOT NULL,
    commands TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    server_id TEXT NOT NULL,
    server_name TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger_source TEXT NOT NULL DEFAULT 'manual',
    branch TEXT NOT NULL DEFAULT '',
    commit_sha TEXT NOT NULL DEFAULT '',
    started_at INTEGER,
    finished_at INTEGER,
    duration_ms INTEGER,
    log TEXT NOT NULL DEFAULT '',
    error_message TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_project
    ON deployments (project_id, created_at DESC);
"#
    };
}

/// The P3 tables on their own, for `migrate()`.
pub const P3_SCHEMA_SQL: &str = p3_schema_sql!();

const SCHEMA_SQL: &str = concat!(
    r#"
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
"#,
    p3_schema_sql!()
);

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
    if version < 3 {
        // Projects and deployments are additive, so the same
        // `CREATE TABLE IF NOT EXISTS` block used for new databases works
        // here: an upgraded database ends up byte-identical in shape.
        conn.execute_batch(P3_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 3u32)?;
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

/// A deployment target: one project on one server (P3-2.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub server_id: String,
    pub repo_url: String,
    pub branch: String,
    /// Absolute directory on the server. Deployment steps may not reference
    /// paths outside it — enforced on save *and* on every run.
    pub deploy_path: String,
    /// JSON array of deployment steps. Each one is validated against the
    /// allowlist in `safe::validate_deploy_step` before it is stored.
    pub commands_json: String,
    /// Mirrors the last deployment: `idle` | `success` | `failed` | `running`.
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One deployment run (P3-2.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentRecord {
    pub id: String,
    pub project_id: String,
    /// Denormalised so history stays readable after a project is renamed.
    pub project_name: String,
    pub server_id: String,
    pub server_name: String,
    /// `pending` | `running` | `success` | `failed`
    pub status: String,
    /// What started it: `manual` today.
    pub trigger_source: String,
    pub branch: String,
    pub commit_sha: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
    /// Step-by-step output, appended as the run proceeds.
    pub log: String,
    pub error_message: Option<String>,
    pub created_at: i64,
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

// ---------------------------------------------------------------------------
// Projects & deployments (P3-2.2, P3-2.3)
// ---------------------------------------------------------------------------

/// Deployment status values used across the app.
pub const DEPLOY_RUNNING: &str = "running";
pub const DEPLOY_SUCCESS: &str = "success";
pub const DEPLOY_FAILED: &str = "failed";

pub fn list_projects(conn: &Connection) -> Result<Vec<ProjectRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM projects ORDER BY name ASC")?;
    let rows = stmt.query_map([], project_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_project(conn: &Connection, id: &str) -> Result<Option<ProjectRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM projects WHERE id = ?1")?;
    let mut rows = stmt.query_map([id], project_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRecord> {
    Ok(ProjectRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        server_id: row.get("server_id")?,
        repo_url: row.get("repo_url")?,
        branch: row.get("branch")?,
        deploy_path: row.get("deploy_path")?,
        commands_json: row.get("commands")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert_or_replace_project(conn: &Connection, project: &ProjectRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO projects (id, name, description, server_id, repo_url, branch, deploy_path, commands, status, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            description=excluded.description,
            server_id=excluded.server_id,
            repo_url=excluded.repo_url,
            branch=excluded.branch,
            deploy_path=excluded.deploy_path,
            commands=excluded.commands,
            status=excluded.status,
            updated_at=excluded.updated_at
        "#,
        params![
            project.id,
            project.name,
            project.description,
            project.server_id,
            project.repo_url,
            project.branch,
            project.deploy_path,
            project.commands_json,
            project.status,
            project.created_at,
            project.updated_at,
        ],
    )?;
    Ok(())
}

/// Mirrors the last deployment outcome onto the project, so the list shows
/// "failed" without loading the whole history.
pub fn set_project_status(conn: &Connection, id: &str, status: &str) -> Result<()> {
    conn.execute(
        "UPDATE projects SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![status, AppDb::now(), id],
    )?;
    Ok(())
}

/// Removes a project together with its deployment history — history without
/// its project would be an orphan the UI cannot explain.
pub fn delete_project_cascade(conn: &Connection, id: &str) -> Result<i64> {
    let deployments: i64 = conn
        .prepare("SELECT COUNT(*) FROM deployments WHERE project_id = ?1")?
        .query_row([id], |row| row.get(0))?;
    conn.execute("DELETE FROM deployments WHERE project_id = ?1", [id])?;
    conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    Ok(deployments)
}

// -- deployments -------------------------------------------------------------

pub fn insert_deployment(conn: &Connection, deployment: &DeploymentRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO deployments (id, project_id, project_name, server_id, server_name, status, trigger_source, branch, commit_sha, started_at, finished_at, duration_ms, log, error_message, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        "#,
        params![
            deployment.id,
            deployment.project_id,
            deployment.project_name,
            deployment.server_id,
            deployment.server_name,
            deployment.status,
            deployment.trigger_source,
            deployment.branch,
            deployment.commit_sha,
            deployment.started_at,
            deployment.finished_at,
            deployment.duration_ms,
            deployment.log,
            deployment.error_message,
            deployment.created_at,
        ],
    )?;
    Ok(())
}

/// Appends to the log and updates status/timing. Called repeatedly as a run
/// progresses so a crash mid-deploy still leaves a record.
pub fn update_deployment_progress(
    conn: &Connection,
    id: &str,
    status: &str,
    log: &str,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    error_message: Option<&str>,
) -> Result<()> {
    let duration_ms = match (started_at, finished_at) {
        (Some(started), Some(finished)) => Some((finished - started).max(0)),
        _ => None,
    };
    conn.execute(
        r#"
        UPDATE deployments
        SET status = ?1, log = ?2, started_at = COALESCE(?3, started_at),
            finished_at = ?4, duration_ms = ?5, error_message = ?6
        WHERE id = ?7
        "#,
        params![
            status,
            log,
            started_at,
            finished_at,
            duration_ms,
            error_message,
            id
        ],
    )?;
    Ok(())
}

pub fn get_deployment(conn: &Connection, id: &str) -> Result<Option<DeploymentRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM deployments WHERE id = ?1")?;
    let mut rows = stmt.query_map([id], deployment_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Deployment history, newest first. `project_id` narrows it to one project.
pub fn list_deployments(
    conn: &Connection,
    project_id: Option<&str>,
    limit: i64,
) -> Result<Vec<DeploymentRecord>> {
    // Collect inside the branch: `MappedRows` borrows the statement, so it
    // must not outlive the branch that owns it.
    match project_id {
        Some(project_id) => {
            let mut stmt = conn.prepare(
                "SELECT * FROM deployments WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2",
            )?;
            let mut records = Vec::new();
            for row in stmt.query_map(params![project_id, limit], deployment_from_row)? {
                records.push(row?);
            }
            Ok(records)
        }
        None => {
            let mut stmt =
                conn.prepare("SELECT * FROM deployments ORDER BY created_at DESC LIMIT ?1")?;
            let mut records = Vec::new();
            for row in stmt.query_map([limit], deployment_from_row)? {
                records.push(row?);
            }
            Ok(records)
        }
    }
}

pub fn deployment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentRecord> {
    Ok(DeploymentRecord {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        project_name: row.get("project_name")?,
        server_id: row.get("server_id")?,
        server_name: row.get("server_name")?,
        status: row.get("status")?,
        trigger_source: row.get("trigger_source")?,
        branch: row.get("branch")?,
        commit_sha: row.get("commit_sha")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        duration_ms: row.get("duration_ms")?,
        log: row.get("log")?,
        error_message: row.get("error_message")?,
        created_at: row.get("created_at")?,
    })
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

    fn project(id: &str, name: &str, server_id: &str) -> ProjectRecord {
        ProjectRecord {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            server_id: server_id.to_string(),
            repo_url: "https://github.com/acme/app.git".to_string(),
            branch: "main".to_string(),
            deploy_path: "/var/www/app".to_string(),
            commands_json: r#"["git pull --ff-only","npm run build"]"#.to_string(),
            status: "idle".to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    fn deployment(id: &str, project_id: &str) -> DeploymentRecord {
        DeploymentRecord {
            id: id.to_string(),
            project_id: project_id.to_string(),
            project_name: "app".to_string(),
            server_id: "s1".to_string(),
            server_name: "web".to_string(),
            status: "pending".to_string(),
            trigger_source: "manual".to_string(),
            branch: "main".to_string(),
            commit_sha: String::new(),
            started_at: None,
            finished_at: None,
            duration_ms: None,
            log: String::new(),
            error_message: None,
            created_at: 2,
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

    // -- projects ------------------------------------------------------------

    #[test]
    fn a_project_round_trips_with_its_steps() {
        let conn = test_db();
        insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();

        let loaded = get_project(&conn, "p1").unwrap().unwrap();
        assert_eq!(loaded.name, "app");
        assert_eq!(loaded.deploy_path, "/var/www/app");
        assert_eq!(loaded.branch, "main");

        // Steps are stored as a JSON array, not flattened into a string.
        let steps: Vec<String> = serde_json::from_str(&loaded.commands_json).unwrap();
        assert_eq!(steps, vec!["git pull --ff-only", "npm run build"]);
    }

    #[test]
    fn saving_a_project_twice_updates_in_place() {
        let conn = test_db();
        insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();
        let mut renamed = project("p1", "app-v2", "s1");
        renamed.branch = "release".to_string();
        insert_or_replace_project(&conn, &renamed).unwrap();

        let all = list_projects(&conn).unwrap();
        assert_eq!(all.len(), 1, "重复保存不能产生第二条记录");
        assert_eq!(all[0].name, "app-v2");
        assert_eq!(all[0].branch, "release");
    }

    #[test]
    fn projects_are_listed_by_name() {
        let conn = test_db();
        insert_or_replace_project(&conn, &project("p2", "zeta", "s1")).unwrap();
        insert_or_replace_project(&conn, &project("p1", "alpha", "s1")).unwrap();

        let names: Vec<String> = list_projects(&conn)
            .unwrap()
            .into_iter()
            .map(|project| project.name)
            .collect();
        assert_eq!(names, vec!["alpha", "zeta"]);
    }

    #[test]
    fn deleting_a_project_takes_its_deployments_with_it() {
        let conn = test_db();
        insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();
        insert_deployment(&conn, &deployment("d1", "p1")).unwrap();
        insert_deployment(&conn, &deployment("d2", "p1")).unwrap();
        // Another project's history must survive.
        insert_or_replace_project(&conn, &project("p2", "other", "s1")).unwrap();
        insert_deployment(&conn, &deployment("d3", "p2")).unwrap();

        let removed = delete_project_cascade(&conn, "p1").unwrap();
        assert_eq!(removed, 2);
        assert!(get_project(&conn, "p1").unwrap().is_none());
        assert_eq!(list_deployments(&conn, None, 100).unwrap().len(), 1);
    }

    // -- deployments ---------------------------------------------------------

    #[test]
    fn a_deployment_records_its_outcome() {
        let conn = test_db();
        insert_deployment(&conn, &deployment("d1", "p1")).unwrap();

        update_deployment_progress(
            &conn,
            "d1",
            DEPLOY_RUNNING,
            "$ git pull --ff-only\n",
            Some(1000),
            None,
            None,
        )
        .unwrap();
        update_deployment_progress(
            &conn,
            "d1",
            DEPLOY_SUCCESS,
            "$ git pull --ff-only\nAlready up to date.\n",
            Some(1000),
            Some(4500),
            None,
        )
        .unwrap();

        let loaded = get_deployment(&conn, "d1").unwrap().unwrap();
        assert_eq!(loaded.status, DEPLOY_SUCCESS);
        assert_eq!(loaded.duration_ms, Some(3500));
        assert!(loaded.log.contains("Already up to date."));
        assert_eq!(loaded.error_message, None);
    }

    #[test]
    fn a_failed_deployment_keeps_the_error() {
        let conn = test_db();
        insert_deployment(&conn, &deployment("d1", "p1")).unwrap();
        update_deployment_progress(
            &conn,
            "d1",
            DEPLOY_FAILED,
            "$ npm run build\n",
            Some(10),
            Some(20),
            Some("npm: command not found"),
        )
        .unwrap();

        let loaded = get_deployment(&conn, "d1").unwrap().unwrap();
        assert_eq!(loaded.status, DEPLOY_FAILED);
        assert_eq!(
            loaded.error_message.as_deref(),
            Some("npm: command not found")
        );
        // The partial log is what makes a failure diagnosable.
        assert!(loaded.log.contains("npm run build"));
    }

    #[test]
    fn deployment_history_is_newest_first_and_filterable() {
        let conn = test_db();
        for (id, project_id, created) in [("d1", "p1", 10i64), ("d2", "p2", 30), ("d3", "p1", 20)] {
            let mut record = deployment(id, project_id);
            record.created_at = created;
            insert_deployment(&conn, &record).unwrap();
        }

        let all = list_deployments(&conn, None, 10).unwrap();
        assert_eq!(
            all.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            vec!["d2", "d3", "d1"]
        );

        let only_p1 = list_deployments(&conn, Some("p1"), 10).unwrap();
        assert_eq!(only_p1.len(), 2);
        assert!(only_p1.iter().all(|d| d.project_id == "p1"));
    }

    #[test]
    fn migration_v3_adds_the_p3_tables_to_an_existing_database() {
        // A database created before P3 has no projects table at all.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
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
            "#,
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 2u32).unwrap();

        migrate(&conn).unwrap();

        // The tables now exist and are usable.
        insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();
        assert_eq!(list_projects(&conn).unwrap().len(), 1);
    }

    #[test]
    fn migration_keeps_p3_tables_on_every_start() {
        let conn = test_db();
        // Running twice (every app start) must not fail or duplicate anything.
        migrate(&conn).unwrap();
        insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(list_projects(&conn).unwrap().len(), 1);
    }

    #[test]
    fn project_status_mirrors_the_last_deployment() {
        let conn = test_db();
        insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();
        set_project_status(&conn, "p1", DEPLOY_FAILED).unwrap();
        assert_eq!(get_project(&conn, "p1").unwrap().unwrap().status, "failed");
    }
}
