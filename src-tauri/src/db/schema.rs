//! Database handle, schema and migrations.
//!
//! Migrations are keyed off SQLite's `PRAGMA user_version` and every step is
//! idempotent, so an app start is safe to run them on any database, twice.

use anyhow::Result;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// How the SQLite file is opened and upgraded.
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
pub const SCHEMA_VERSION: u32 = 6;

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

/// 人工复核结论表（P3 用户流程收敛）：用户的"确认项目 / 忽略目录"必须跨扫描
/// 保留，否则每次重扫都要重新处理一遍不确定项。
///
/// 一个 (server_id, path) 只有一条记录，重复复核用 UPSERT 覆盖。
macro_rules! project_reviews_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS project_reviews (
    server_id TEXT NOT NULL,
    path TEXT NOT NULL,
    review TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    project_type TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, path)
);

CREATE INDEX IF NOT EXISTS idx_project_reviews_server
    ON project_reviews (server_id, review);
"#
    };
}

/// The review table on its own, for `migrate()`.
pub const PROJECT_REVIEWS_SCHEMA_SQL: &str = project_reviews_schema_sql!();

/// 项目扫描快照缓存：每台服务器保留最近一次成功扫描的结果（候选 + 实例 + 能力），
/// 让前端打开"服务器项目"时立即展示，后台再增量复核。整段以 JSON 存储。
macro_rules! project_inventory_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS project_inventory (
    server_id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
"#
    };
}

/// The inventory cache table on its own, for `migrate()`.
pub const PROJECT_INVENTORY_SCHEMA_SQL: &str = project_inventory_schema_sql!();

/// 已确认项目资产表（修复"已确认项目消失"的核心）。
///
/// 与 `project_reviews`（只存确认/忽略结论）不同，这里**保存完整候选项目快照**，
/// 即使后续扫描没有再次发现该路径，项目也必须继续存在，直到用户主动取消确认
/// 或软删除。`canonical_path` 是统一规范化后的路径，review / candidate /
/// inventory 全部使用它，避免 `/opt/app` 与 `/opt/app/` 被当成两个项目。
///
/// `scan_state` 记录最近一次扫描对该项目的态度：active（本次发现）/ missing
/// （本次未发现，保留快照）/ inaccessible（服务器暂不可访问）/ changed（分类或
/// 关键信息有变化，待复核）。`missing_since` 记录首次未发现的时间。
macro_rules! confirmed_projects_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS confirmed_projects (
    id TEXT PRIMARY KEY NOT NULL,
    server_id TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    project_type TEXT NOT NULL DEFAULT '',
    candidate_payload TEXT NOT NULL,
    scan_state TEXT NOT NULL DEFAULT 'active',
    confirmed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    missing_since INTEGER,
    deleted_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_confirmed_projects_server_path
    ON confirmed_projects (server_id, canonical_path);

CREATE INDEX IF NOT EXISTS idx_confirmed_projects_server
    ON confirmed_projects (server_id, deleted_at);
"#
    };
}

/// The confirmed-projects table on its own, for `migrate()`.
pub const CONFIRMED_PROJECTS_SCHEMA_SQL: &str = confirmed_projects_schema_sql!();

pub(crate) const SCHEMA_SQL: &str = concat!(
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
    p3_schema_sql!(),
    project_reviews_schema_sql!(),
    project_inventory_schema_sql!(),
    confirmed_projects_schema_sql!()
);

pub(crate) fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
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
    if version < 4 {
        // Project review decisions (确认项目 / 忽略目录) must survive a rescan.
        conn.execute_batch(PROJECT_REVIEWS_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 4u32)?;
    }
    if version < 5 {
        // 上一次扫描的快照缓存：用户再次打开"服务器项目"时立即展示，不必等
        // 后台重新扫描完成。每台服务器至多保留一份（整段 JSON）。
        conn.execute_batch(PROJECT_INVENTORY_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 5u32)?;
    }
    if version < 6 {
        // 已确认项目资产表：保存完整候选项目快照，即使后续扫描没再发现该路径
        // 也必须继续存在（修复"已确认项目消失"）。唯一键 (server_id, canonical_path)。
        conn.execute_batch(CONFIRMED_PROJECTS_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 6u32)?;
    }
    Ok(())
}
