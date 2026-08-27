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
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS credentials (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                username TEXT NOT NULL,
                secret_ref TEXT,
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

            CREATE TABLE IF NOT EXISTS quick_commands (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                command TEXT NOT NULL,
                description TEXT,
                group_id TEXT,
                server_id TEXT,
                created_at INTEGER NOT NULL
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
        )?;
        Ok(())
    }

    pub fn now() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
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
    pub status: String,
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
pub struct QuickCommandRecord {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    pub group_id: Option<String>,
    pub server_id: Option<String>,
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
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert_or_replace_server(conn: &Connection, server: &ServerRecord) -> Result<()> {
    let tags = serde_json::to_string(&server.tags)?;
    conn.execute(
        r#"
        INSERT INTO servers (id, name, host, port, username, credential_id, group_id, tags, proxy_jump_id, status, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            host=excluded.host,
            port=excluded.port,
            username=excluded.username,
            credential_id=excluded.credential_id,
            group_id=excluded.group_id,
            tags=excluded.tags,
            proxy_jump_id=excluded.proxy_jump_id,
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
            server.status,
            server.created_at,
            server.updated_at,
        ],
    )?;
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

pub fn delete_server(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM servers WHERE id = ?1", [id])?;
    Ok(())
}

pub fn insert_or_replace_credential(conn: &Connection, credential: &CredentialRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO credentials (id, name, type, username, secret_ref, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            type=excluded.type,
            username=excluded.username,
            secret_ref=excluded.secret_ref,
            updated_at=excluded.updated_at
        "#,
        params![
            credential.id,
            credential.name,
            credential.credential_type,
            credential.username,
            credential.secret_ref,
            credential.created_at,
            credential.updated_at,
        ],
    )?;
    Ok(())
}

pub fn list_credentials(conn: &Connection) -> Result<Vec<CredentialRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM credentials ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |row| {
        Ok(CredentialRecord {
            id: row.get("id")?,
            name: row.get("name")?,
            credential_type: row.get("type")?,
            username: row.get("username")?,
            secret_ref: row.get("secret_ref")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
    let mut stmt = conn.prepare("SELECT * FROM known_hosts WHERE host = ?1 AND port = ?2 LIMIT 1")?;
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
    let rows = stmt.query_map([], |row| {
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
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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

pub fn list_sessions(conn: &Connection) -> Result<Vec<SessionRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM ssh_sessions ORDER BY rowid DESC")?;
    let rows = stmt.query_map([], |row| {
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
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
    let mut stmt = conn.prepare("SELECT * FROM command_history ORDER BY timestamp DESC LIMIT ?1")?;
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

pub fn insert_quick_command(conn: &Connection, quick: &QuickCommandRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO quick_commands (id, name, command, description, group_id, server_id, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            command=excluded.command,
            description=excluded.description,
            group_id=excluded.group_id,
            server_id=excluded.server_id
        "#,
        params![quick.id, quick.name, quick.command, quick.description, quick.group_id, quick.server_id, quick.created_at],
    )?;
    Ok(())
}

pub fn list_quick_commands(conn: &Connection) -> Result<Vec<QuickCommandRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM quick_commands ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], |row| {
        Ok(QuickCommandRecord {
            id: row.get("id")?,
            name: row.get("name")?,
            command: row.get("command")?,
            description: row.get("description")?,
            group_id: row.get("group_id")?,
            server_id: row.get("server_id")?,
            created_at: row.get("created_at")?,
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
