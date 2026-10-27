//! 连接配置的本地持久化（SQLite）与系统钥匙串。
//!
//! * **SQLite 只存引用**：`secret_ref` 是钥匙串账户名，`database_profiles`
//!   表里没有任何能装密码的列。
//! * **密码永远不回传前端**：`DatabaseProfile.has_password` 只表示"有没有"。
//! * **历史是可选功能**：SQL 文本可能含敏感信息，因此后端不自动记录 —
//!   只有前端显式调用 `db_history_record` 才写，且随时可以清空。
//!   应用日志（eprintln / tracing）里绝不打印 SQL 与参数。

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};

use super::model::{
    DatabaseProfile, DbErrorInfo, ENGINE_MYSQL, ENGINE_POSTGRES, TLS_DISABLED, TLS_VERIFY_CA,
    TLS_VERIFY_IDENTITY,
};

fn secret_ref_for(profile_id: &str) -> String {
    format!("db-profile:{profile_id}")
}

fn profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DatabaseProfile> {
    let secret_ref: Option<String> = row.get("secret_ref")?;
    Ok(DatabaseProfile {
        id: row.get("id")?,
        name: row.get("name")?,
        engine: row.get("engine")?,
        host: row.get("host")?,
        port: u16::try_from(row.get::<_, i64>("port")?).unwrap_or(3306),
        username: row.get("username")?,
        default_database: row.get("default_database")?,
        has_password: secret_ref.map(|v| !v.is_empty()).unwrap_or(false),
        ssh_server_id: row.get("ssh_server_id")?,
        tls_mode: row.get("tls_mode")?,
        tls_ca_path: row.get("tls_ca_path")?,
        tls_server_name: row.get("tls_server_name")?,
        read_only: row.get::<_, i64>("read_only")? != 0,
        connect_timeout_ms: row.get::<_, i64>("connect_timeout_ms")?.max(1_000) as u64,
        query_timeout_ms: row.get::<_, i64>("query_timeout_ms")?.max(1_000) as u64,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn list_profiles(conn: &Connection) -> Result<Vec<DatabaseProfile>> {
    let mut stmt = conn.prepare("SELECT * FROM database_profiles ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], profile_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_profile(conn: &Connection, id: &str) -> Result<Option<DatabaseProfile>> {
    let mut stmt = conn.prepare("SELECT * FROM database_profiles WHERE id = ?1 LIMIT 1")?;
    let mut rows = stmt.query([id])?;
    match rows.next()? {
        Some(row) => Ok(Some(profile_from_row(row)?)),
        None => Ok(None),
    }
}

/// 配置校验：错误信息是给人看的，且**不做任何网络 I/O**。
pub fn validate_profile(conn: &Connection, profile: &DatabaseProfile) -> Result<(), DbErrorInfo> {
    if profile.engine != ENGINE_MYSQL {
        return Err(DbErrorInfo::new(
            "unsupported",
            if profile.engine == ENGINE_POSTGRES {
                "PostgreSQL 适配尚未实现：本版本只支持 MySQL 8.0 / 8.4".to_string()
            } else {
                format!("不支持的数据库类型：{}", profile.engine)
            },
        ));
    }
    if profile.name.trim().is_empty() {
        return Err(DbErrorInfo::new("config", "连接名称不能为空"));
    }
    if profile.host.trim().is_empty() {
        return Err(DbErrorInfo::new("config", "数据库主机不能为空"));
    }
    if profile.username.trim().is_empty() {
        return Err(DbErrorInfo::new("config", "用户名不能为空"));
    }
    if profile.port == 0 {
        return Err(DbErrorInfo::new("config", "端口必须在 1 到 65535 之间"));
    }
    if !matches!(
        profile.tls_mode.as_str(),
        TLS_DISABLED | TLS_VERIFY_CA | TLS_VERIFY_IDENTITY
    ) {
        return Err(DbErrorInfo::new(
            "config",
            format!("未知的 TLS 模式：{}", profile.tls_mode),
        ));
    }
    if profile
        .tls_ca_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        if profile.tls_mode == TLS_DISABLED {
            return Err(DbErrorInfo::new(
                "config",
                "配置了 CA 证书但 TLS 模式为 disabled：请选择 verify_ca 或 verify_identity",
            ));
        }
    }
    if let Some(server_id) = profile
        .ssh_server_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let exists = crate::db::get_server(conn, server_id)
            .map_err(|error| DbErrorInfo::new("config", error.to_string()))?
            .is_some();
        if !exists {
            return Err(DbErrorInfo::new("config", "所选 SSH 服务器不存在"));
        }
    }
    if !(1_000..=60_000).contains(&profile.connect_timeout_ms) {
        return Err(DbErrorInfo::new(
            "config",
            "连接超时必须在 1 到 60 秒之间",
        ));
    }
    if !(1_000..=600_000).contains(&profile.query_timeout_ms) {
        return Err(DbErrorInfo::new(
            "config",
            "查询超时必须在 1 到 600 秒之间",
        ));
    }
    Ok(())
}

/// 保存（插入或更新）。密码只在 `password = Some` 时写钥匙串。
pub fn save_profile(
    conn: &Connection,
    profile: &DatabaseProfile,
    password: Option<&str>,
) -> Result<DatabaseProfile> {
    validate_profile(conn, profile).map_err(|error| anyhow!(error.message))?;

    let now = crate::db::AppDb::now();
    let created_at = get_profile(conn, &profile.id)?
        .map(|existing| existing.created_at)
        .unwrap_or(now);

    let secret_ref = match password {
        Some("") => {
            // 显式清空：钥匙串里若有旧密码必须删掉，不能留一个“无主”凭证。
            let reference = secret_ref_for(&profile.id);
            let _ = crate::keyring::delete_secret(&reference);
            None
        }
        Some(value) => {
            let reference = crate::keyring::save_secret(&secret_ref_for(&profile.id), value)
                .map_err(|error| anyhow!("无法写入系统钥匙串：{error}"))?;
            Some(reference)
        }
        None => {
            // 保留原值：读当前行的 secret_ref，而不是“猜”。
            get_profile(conn, &profile.id)?
                .filter(|existing| existing.has_password)
                .map(|_| secret_ref_for(&profile.id))
        }
    };

    conn.execute(
        r#"
        INSERT INTO database_profiles (
            id, name, engine, host, port, username, default_database, secret_ref,
            ssh_server_id, tls_mode, tls_ca_path, tls_server_name, read_only,
            connect_timeout_ms, query_timeout_ms, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            engine=excluded.engine,
            host=excluded.host,
            port=excluded.port,
            username=excluded.username,
            default_database=excluded.default_database,
            secret_ref=excluded.secret_ref,
            ssh_server_id=excluded.ssh_server_id,
            tls_mode=excluded.tls_mode,
            tls_ca_path=excluded.tls_ca_path,
            tls_server_name=excluded.tls_server_name,
            read_only=excluded.read_only,
            connect_timeout_ms=excluded.connect_timeout_ms,
            query_timeout_ms=excluded.query_timeout_ms,
            updated_at=excluded.updated_at
        "#,
        params![
            profile.id,
            profile.name.trim(),
            profile.engine,
            profile.host.trim(),
            i64::from(profile.port),
            profile.username.trim(),
            profile
                .default_database
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
            secret_ref,
            profile
                .ssh_server_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
            profile.tls_mode,
            profile
                .tls_ca_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
            profile
                .tls_server_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
            i64::from(profile.read_only),
            profile.connect_timeout_ms as i64,
            profile.query_timeout_ms as i64,
            created_at,
            now,
        ],
    )?;

    get_profile(conn, &profile.id)?.ok_or_else(|| anyhow!("保存后无法读回连接配置"))
}

pub fn delete_profile(conn: &Connection, id: &str) -> Result<()> {
    let _ = crate::keyring::delete_secret(&secret_ref_for(id));
    conn.execute("DELETE FROM database_profiles WHERE id = ?1", [id])?;
    conn.execute(
        "DELETE FROM database_query_history WHERE profile_id = ?1",
        [id],
    )?;
    Ok(())
}

/// 读取密码。返回 `Ok(None)` 表示这个连接没有保存密码（MySQL 允许空密码）。
pub fn load_password(profile: &DatabaseProfile) -> Result<Option<String>> {
    if !profile.has_password {
        return Ok(None);
    }
    let secret = crate::keyring::read_secret(&secret_ref_for(&profile.id))
        .map_err(|error| anyhow!("无法从系统钥匙串读取数据库密码：{error}"))?;
    Ok(Some(secret))
}

// ---------------------------------------------------------------------------
// SQL 历史（显式写入，可清空）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct QueryHistoryEntry {
    pub id: String,
    pub profile_id: String,
    pub session_id: Option<String>,
    pub sql: String,
    pub succeeded: bool,
    pub rows: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
    pub created_at: i64,
}

pub fn record_history(conn: &Connection, entry: &QueryHistoryEntry) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO database_query_history
            (id, profile_id, session_id, sql, succeeded, rows, elapsed_ms, error, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            entry.id,
            entry.profile_id,
            entry.session_id,
            entry.sql,
            i64::from(entry.succeeded),
            entry.rows as i64,
            entry.elapsed_ms as i64,
            entry.error,
            entry.created_at,
        ],
    )?;
    // 每个连接最多保留 500 条，超出按时间淘汰；历史不是审计日志，
    // 无限增长只会让“清空”变成一次长时间写操作。
    conn.execute(
        r#"
        DELETE FROM database_query_history
        WHERE profile_id = ?1 AND id NOT IN (
            SELECT id FROM database_query_history
            WHERE profile_id = ?1
            ORDER BY created_at DESC
            LIMIT 500
        )
        "#,
        [&entry.profile_id],
    )?;
    Ok(())
}

/// 前端显式写入历史的载荷。后端不自动记录 SQL。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct HistoryWrite {
    pub profile_id: String,
    pub session_id: Option<String>,
    pub sql: String,
    pub succeeded: bool,
    pub rows: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

pub fn record_history_request(
    conn: &Connection,
    write: &HistoryWrite,
) -> Result<QueryHistoryEntry> {
    let entry = QueryHistoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        profile_id: write.profile_id.clone(),
        session_id: write.session_id.clone(),
        sql: write.sql.clone(),
        succeeded: write.succeeded,
        rows: write.rows,
        elapsed_ms: write.elapsed_ms,
        error: write.error.clone(),
        created_at: crate::db::AppDb::now(),
    };
    record_history(conn, &entry)?;
    Ok(entry)
}

pub fn list_history(conn: &Connection, profile_id: &str) -> Result<Vec<QueryHistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM database_query_history WHERE profile_id = ?1 ORDER BY created_at DESC LIMIT 200",
    )?;
    let rows = stmt.query_map([profile_id], |row| {
        Ok(QueryHistoryEntry {
            id: row.get("id")?,
            profile_id: row.get("profile_id")?,
            session_id: row.get("session_id")?,
            sql: row.get("sql")?,
            succeeded: row.get::<_, i64>("succeeded")? != 0,
            rows: row.get::<_, i64>("rows")?.max(0) as u64,
            elapsed_ms: row.get::<_, i64>("elapsed_ms")?.max(0) as u64,
            error: row.get("error")?,
            created_at: row.get("created_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn clear_history(conn: &Connection, profile_id: Option<&str>) -> Result<()> {
    match profile_id {
        Some(id) => {
            conn.execute(
                "DELETE FROM database_query_history WHERE profile_id = ?1",
                [id],
            )?;
        }
        None => {
            conn.execute("DELETE FROM database_query_history", [])?;
        }
    }
    Ok(())
}
