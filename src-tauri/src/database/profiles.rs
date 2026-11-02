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

use super::capability::EndpointRequirement;
use super::engine_registry;
use super::model::{
    DatabaseProfile, DbErrorInfo, EngineOptions, ENGINE_REDIS, REDIS_MODE_CLUSTER,
    REDIS_MODE_SENTINEL, REDIS_MODE_STANDALONE, TLS_DISABLED, TLS_VERIFY_CA, TLS_VERIFY_IDENTITY,
};

fn secret_ref_for(profile_id: &str) -> String {
    format!("db-profile:{profile_id}")
}

fn parse_engine_options(text: Option<&str>) -> EngineOptions {
    let Some(text) = text.map(str::trim).filter(|value| !value.is_empty()) else {
        return EngineOptions::default();
    };
    match serde_json::from_str::<EngineOptions>(text) {
        Ok(options) => options,
        Err(error) => {
            // 不打印内容：配置里可能有内网地址。坏数据只在保存时被拒绝，
            // 读取时退回默认值，避免一条坏行让整个连接列表打不开。
            eprintln!("[database] engine_options 无法解析（已退回默认值）：{error}");
            EngineOptions::default()
        }
    }
}

fn profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DatabaseProfile> {
    let secret_ref: Option<String> = row.get("secret_ref")?;
    let engine_options: Option<String> = row.get("engine_options")?;
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
        redis_mode: row.get("redis_mode")?,
        sentinel_master: row.get("sentinel_master")?,
        nodes_json: row.get("nodes_json")?,
        engine_options: parse_engine_options(engine_options.as_deref()),
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

/// 归一化：去掉不适用于当前引擎的字段，避免"填了但永远不生效"的误导性配置。
///
/// 只在保存时调用（读写路径不动旧数据），因此旧行仍然可恢复。
pub fn normalize_profile(profile: &DatabaseProfile) -> DatabaseProfile {
    let mut out = profile.clone();
    out.name = out.name.trim().to_string();
    out.host = out.host.trim().to_string();
    out.username = out.username.trim().to_string();
    out.default_database = out
        .default_database
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    out.tls_ca_path = out
        .tls_ca_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    out.tls_server_name = out
        .tls_server_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    out.ssh_server_id = out
        .ssh_server_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let options = &mut out.engine_options;
    trim_in_place(&mut options.path);
    trim_in_place(&mut options.schema);
    trim_in_place(&mut options.identifier);
    trim_in_place(&mut options.uri);
    trim_in_place(&mut options.auth_source);
    trim_in_place(&mut options.protocol);

    if engine_registry::find(&out.engine).is_some_and(|engine| engine.is_local_file()) {
        // 文件型数据库没有网络端点：保留 host/port 只会让人以为它在生效。
        out.host.clear();
        out.port = 0;
        out.username.clear();
        out.tls_mode = TLS_DISABLED.to_string();
        out.tls_ca_path = None;
        out.tls_server_name = None;
        out.ssh_server_id = None;
    }
    out
}

fn trim_in_place(value: &mut Option<String>) {
    *value = value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// 简单标识符：schema 名、认证库名。带引号/空格的名字在 DDL 里歧义太大。
fn is_simple_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$' | '#'))
}

/// 文件路径：绝对路径 + 无控制字符。
///
/// 不要求文件已经存在（连接时才判断）：保存配置不该因为"还没建库"失败。
/// 但必须是绝对路径 —— 相对路径会按进程工作目录解析，用户看到的文件和
/// 程序实际打开的文件可能不是同一个。
fn validate_file_path(path: &str) -> Result<(), DbErrorInfo> {
    if path.chars().any(|ch| ch.is_control()) {
        return Err(DbErrorInfo::new("config", "文件路径包含控制字符"));
    }
    if path.len() > 4096 {
        return Err(DbErrorInfo::new("config", "文件路径过长（上限 4096 字节）"));
    }
    let absolute = path.starts_with('/')
        || path.starts_with("\\\\")
        || path
            .chars()
            .nth(1)
            .is_some_and(|ch| ch == ':' && path.len() > 2);
    if !absolute {
        return Err(DbErrorInfo::new(
            "config",
            "请填写绝对路径（例如 D:\\data\\app.db 或 /opt/app/data/app.db）",
        )
        .with_detail("相对路径会按程序工作目录解析，容易打开到意外的文件。"));
    }
    Ok(())
}

/// 只校验这个引擎声明过的配置项；未知键一律拒绝，避免静默丢弃用户配置。
fn validate_engine_options(
    profile: &DatabaseProfile,
    engine: &super::capability::EngineDescriptor,
) -> Result<(), DbErrorInfo> {
    for key in profile.engine_options.extra.keys() {
        return Err(DbErrorInfo::new(
            "config",
            format!("{} 没有配置项 {key}", engine.product),
        ));
    }
    let options = &profile.engine_options;

    let declared = |key: &str| engine.allows_option(key);
    if options.path().is_some() && !declared("path") {
        return Err(DbErrorInfo::new("config", "该数据库类型不使用文件路径"));
    }
    if options.schema().is_some() && !declared("schema") {
        return Err(DbErrorInfo::new("config", "该数据库类型不使用 schema 配置"));
    }
    if options.identifier().is_some() && !declared("identifier") {
        return Err(DbErrorInfo::new(
            "config",
            "该数据库类型不使用 service/SID 配置",
        ));
    }
    if options.uri().is_some() && !declared("uri") {
        return Err(DbErrorInfo::new("config", "该数据库类型不使用连接 URI"));
    }
    if options.auth_source().is_some() && !declared("auth_source") {
        return Err(DbErrorInfo::new("config", "该数据库类型不使用认证库配置"));
    }
    if options.protocol().is_some() && !declared("protocol") {
        return Err(DbErrorInfo::new("config", "该数据库类型不使用接口选择"));
    }
    if options.secure.is_some() && !declared("secure") {
        return Err(DbErrorInfo::new("config", "该数据库类型不使用 secure 配置"));
    }

    for field in engine.options {
        let present = match field.key {
            "path" => options.path().is_some(),
            "schema" => options.schema().is_some(),
            "identifier" => options.identifier().is_some(),
            "uri" => options.uri().is_some(),
            "auth_source" => options.auth_source().is_some(),
            "protocol" => options.protocol().is_some(),
            "secure" => options.secure.is_some(),
            _ => false,
        };
        if field.required && !present {
            return Err(DbErrorInfo::new("config", format!("请填写{}", field.label)));
        }
    }

    if let Some(path) = options.path() {
        validate_file_path(path)?;
    }
    if let Some(schema) = options.schema() {
        if !is_simple_identifier(schema) {
            return Err(DbErrorInfo::new(
                "config",
                "schema 只能包含字母、数字、下划线、$ 与 #，且不超过 63 字节",
            ));
        }
    }
    if let Some(identifier) = options.identifier() {
        if !matches!(identifier, "service" | "sid") {
            return Err(DbErrorInfo::new(
                "config",
                "连接标识类型只能是 service 或 sid",
            ));
        }
    }
    if let Some(uri) = options.uri() {
        let lower = uri.to_ascii_lowercase();
        if !(lower.starts_with("mongodb://") || lower.starts_with("mongodb+srv://")) {
            return Err(DbErrorInfo::new(
                "config",
                "MongoDB URI 必须以 mongodb:// 或 mongodb+srv:// 开头",
            ));
        }
    }
    if let Some(auth_source) = options.auth_source() {
        if !is_simple_identifier(auth_source) {
            return Err(DbErrorInfo::new("config", "认证库名不合法"));
        }
    }
    if let Some(protocol) = options.protocol() {
        if !matches!(protocol, "http" | "native") {
            return Err(DbErrorInfo::new(
                "config",
                "ClickHouse 接口只能是 http 或 native",
            ));
        }
    }
    Ok(())
}

/// 配置校验：错误信息是给人看的，且**不做任何网络 I/O**。
///
/// 必填项来自 `engine_registry`：文件型不要求 host/port/用户名，Oracle 要求
/// service/SID，MongoDB 接受 URI 代替主机。
pub fn validate_profile(conn: &Connection, profile: &DatabaseProfile) -> Result<(), DbErrorInfo> {
    let engine = engine_registry::find(&profile.engine).ok_or_else(|| {
        DbErrorInfo::new(
            "unsupported",
            format!("不支持的数据库类型：{}", profile.engine),
        )
        .with_detail("请重新选择数据库类型；已有配置不会被修改。")
    })?;

    if profile.name.trim().is_empty() {
        return Err(DbErrorInfo::new("config", "连接名称不能为空"));
    }
    validate_engine_options(profile, engine)?;

    match engine.requirements.endpoint {
        EndpointRequirement::FilePath => {
            if profile.engine_options.path().is_none() {
                return Err(DbErrorInfo::new("config", "请填写数据库文件路径"));
            }
            if non_empty(&profile.host).is_some() || profile.port != 0 {
                return Err(DbErrorInfo::new(
                    "config",
                    "SQLite 是本地文件数据库：请清除主机与端口",
                ));
            }
        }
        EndpointRequirement::HostPort => {
            if non_empty(&profile.host).is_none() {
                return Err(DbErrorInfo::new("config", "数据库主机不能为空"));
            }
            if profile.port == 0 {
                return Err(DbErrorInfo::new("config", "端口必须在 1 到 65535 之间"));
            }
        }
        EndpointRequirement::UriOrHost => {
            if profile.engine_options.uri().is_none() {
                if non_empty(&profile.host).is_none() {
                    return Err(DbErrorInfo::new("config", "请填写主机，或提供连接 URI"));
                }
                if profile.port == 0 {
                    return Err(DbErrorInfo::new("config", "端口必须在 1 到 65535 之间"));
                }
            }
        }
    }

    if engine.requirements.username && non_empty(&profile.username).is_none() {
        return Err(DbErrorInfo::new("config", "用户名不能为空"));
    }
    if engine.requirements.database
        && profile
            .default_database
            .as_deref()
            .and_then(non_empty)
            .is_none()
    {
        let label = if engine.id == "oracle" {
            "服务名 / SID"
        } else {
            "数据库名"
        };
        return Err(DbErrorInfo::new("config", format!("请填写{label}")));
    }

    if engine.fields.tls {
        if !matches!(
            profile.tls_mode.as_str(),
            TLS_DISABLED | TLS_VERIFY_CA | TLS_VERIFY_IDENTITY
        ) {
            return Err(DbErrorInfo::new(
                "config",
                format!("未知的 TLS 模式：{}", profile.tls_mode),
            ));
        }
        if profile.tls_ca_path.is_some() && profile.tls_mode == TLS_DISABLED {
            return Err(DbErrorInfo::new(
                "config",
                "配置了 CA 证书但 TLS 模式为 disabled：请选择 verify_ca 或 verify_identity",
            ));
        }
    } else if profile.tls_mode != TLS_DISABLED {
        return Err(DbErrorInfo::new(
            "config",
            format!("{} 不支持 TLS 配置", engine.product),
        ));
    }

    if !engine.fields.ssh_tunnel && profile.ssh_server_id.is_some() {
        return Err(DbErrorInfo::new(
            "config",
            format!("{} 不支持 SSH 隧道", engine.product),
        ));
    }
    if let Some(server_id) = profile.ssh_server_id.as_deref().and_then(non_empty) {
        let exists = crate::db::get_server(conn, server_id)
            .map_err(|error| DbErrorInfo::new("config", error.to_string()))?
            .is_some();
        if !exists {
            return Err(DbErrorInfo::new("config", "所选 SSH 服务器不存在"));
        }
    }

    if profile.engine == ENGINE_REDIS {
        validate_redis_profile(profile)?;
    }
    if !(1_000..=60_000).contains(&profile.connect_timeout_ms) {
        return Err(DbErrorInfo::new("config", "连接超时必须在 1 到 60 秒之间"));
    }
    if !(1_000..=600_000).contains(&profile.query_timeout_ms) {
        return Err(DbErrorInfo::new("config", "查询超时必须在 1 到 600 秒之间"));
    }
    Ok(())
}

/// Redis 配置校验：模式必须合法，sentinel 必须有 master 名。
fn validate_redis_profile(profile: &DatabaseProfile) -> Result<(), DbErrorInfo> {
    let mode = profile
        .redis_mode
        .as_deref()
        .unwrap_or(REDIS_MODE_STANDALONE);
    if !matches!(
        mode,
        REDIS_MODE_STANDALONE | REDIS_MODE_SENTINEL | REDIS_MODE_CLUSTER
    ) {
        return Err(DbErrorInfo::new(
            "config",
            format!("未知的 Redis 连接模式：{mode}"),
        ));
    }
    if mode == REDIS_MODE_SENTINEL
        && profile
            .sentinel_master
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err(DbErrorInfo::new(
            "config",
            "sentinel 模式必须填写 master 名称",
        ));
    }
    if let Some(nodes) = profile.nodes_json.as_deref() {
        if serde_json::from_str::<Vec<String>>(nodes).is_err() {
            return Err(DbErrorInfo::new(
                "config",
                "节点列表必须是 JSON 字符串数组，例如 [\"10.0.0.2:26379\"]",
            ));
        }
    }
    Ok(())
}

/// 保存（插入或更新）。密码只在 `password = Some` 时写钥匙串。
pub fn save_profile(
    conn: &Connection,
    profile: &DatabaseProfile,
    password: Option<&str>,
) -> Result<DatabaseProfile> {
    // 先归一化再校验：切引擎后残留的 host/port/TLS 不该阻塞保存，
    // 但也不能被原样写回去（那会让人以为它在生效）。
    let profile = normalize_profile(profile);
    let profile = &profile;
    validate_profile(conn, profile).map_err(|error| anyhow!(error.message))?;
    let engine_options = serde_json::to_string(&profile.engine_options)?;

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
            redis_mode, sentinel_master, nodes_json, engine_options,
            connect_timeout_ms, query_timeout_ms, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
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
            redis_mode=excluded.redis_mode,
            sentinel_master=excluded.sentinel_master,
            nodes_json=excluded.nodes_json,
            engine_options=excluded.engine_options,
            connect_timeout_ms=excluded.connect_timeout_ms,
            query_timeout_ms=excluded.query_timeout_ms,
            updated_at=excluded.updated_at
        "#,
        params![
            profile.id,
            profile.name,
            profile.engine,
            profile.host,
            i64::from(profile.port),
            profile.username,
            profile.default_database,
            secret_ref,
            profile.ssh_server_id,
            profile.tls_mode,
            profile.tls_ca_path,
            profile.tls_server_name,
            i64::from(profile.read_only),
            profile.redis_mode.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            profile.sentinel_master.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            profile.nodes_json.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            engine_options,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::model::EngineOptions;

    fn temp_conn() -> (std::path::PathBuf, rusqlite::Connection) {
        let path =
            std::env::temp_dir().join(format!("bls-profile-test-{}.sqlite3", uuid::Uuid::new_v4()));
        let app = crate::db::AppDb::new(path.clone());
        app.init().expect("init sqlite");
        let conn = app.open().expect("open sqlite");
        (path, conn)
    }

    fn profile(engine: &str) -> DatabaseProfile {
        let now = crate::db::AppDb::now();
        DatabaseProfile {
            id: format!("p-{}", uuid::Uuid::new_v4()),
            name: "测试连接".to_string(),
            engine: engine.to_string(),
            host: "127.0.0.1".to_string(),
            port: 3306,
            username: "root".to_string(),
            default_database: None,
            has_password: false,
            ssh_server_id: None,
            tls_mode: TLS_DISABLED.to_string(),
            tls_ca_path: None,
            tls_server_name: None,
            read_only: true,
            redis_mode: None,
            sentinel_master: None,
            nodes_json: None,
            engine_options: EngineOptions::default(),
            connect_timeout_ms: 10_000,
            query_timeout_ms: 60_000,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn sqlite_saves_without_host_port_or_username() {
        let (path, conn) = temp_conn();
        let mut sqlite = profile("sqlite");
        sqlite.host = String::new();
        sqlite.port = 0;
        sqlite.username = String::new();
        sqlite.engine_options.path = Some("D:\\data\\app.db".to_string());

        let saved = save_profile(&conn, &sqlite, None).expect("sqlite 配置应能保存");
        assert_eq!(saved.engine_options.path(), Some("D:\\data\\app.db"));
        assert_eq!(saved.host, "");
        assert_eq!(saved.port, 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_save_clears_leftover_network_fields() {
        let (path, conn) = temp_conn();
        let mut sqlite = profile("sqlite");
        sqlite.engine_options.path = Some("/tmp/app.db".to_string());
        // 模拟从 MySQL 切过来没清干净：保存时必须归一化掉。
        let saved = save_profile(&conn, &sqlite, None).expect("应归一化成功");
        assert_eq!(saved.host, "");
        assert_eq!(saved.port, 0);
        assert_eq!(saved.username, "");
        assert_eq!(saved.tls_mode, TLS_DISABLED);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_requires_absolute_path() {
        let (_path, conn) = temp_conn();
        let mut sqlite = profile("sqlite");
        sqlite.engine_options.path = Some("app.db".to_string());
        let error = save_profile(&conn, &sqlite, None).expect_err("相对路径必须被拒绝");
        assert!(error.to_string().contains("绝对路径"));
    }

    #[test]
    fn sqlite_without_path_is_rejected() {
        let (_path, conn) = temp_conn();
        let sqlite = profile("sqlite");
        let error = save_profile(&conn, &sqlite, None).expect_err("缺少路径必须被拒绝");
        assert!(error.to_string().contains("文件路径"));
    }

    #[test]
    fn mysql_still_requires_host_and_username() {
        let (_path, conn) = temp_conn();
        let mut mysql = profile("mysql");
        mysql.host = "  ".to_string();
        assert!(validate_profile(&conn, &mysql).is_err());

        let mut no_user = profile("mysql");
        no_user.username.clear();
        assert!(validate_profile(&conn, &no_user).is_err());
    }

    #[test]
    fn oracle_requires_service_name() {
        let (_path, conn) = temp_conn();
        let mut oracle = profile("oracle");
        oracle.port = 1521;
        let error = validate_profile(&conn, &oracle).expect_err("Oracle 必须有服务名");
        assert!(error.message.contains("服务名"));

        oracle.default_database = Some("ORCLPDB1".to_string());
        assert!(validate_profile(&conn, &oracle).is_ok());
    }

    #[test]
    fn unknown_engine_option_key_is_rejected() {
        let (_path, conn) = temp_conn();
        let mut mysql = profile("mysql");
        mysql
            .engine_options
            .extra
            .insert("path".to_string(), serde_json::json!("/tmp/x.db"));
        assert!(validate_profile(&conn, &mysql).is_err());
    }

    #[test]
    fn unknown_engine_is_rejected_with_reason() {
        let (_path, conn) = temp_conn();
        let profile = profile("not-a-db");
        let error = validate_profile(&conn, &profile).expect_err("未知引擎必须拒绝");
        assert_eq!(error.stage, "unsupported");
    }

    #[test]
    fn engine_options_round_trip_through_sqlite() {
        let (path, conn) = temp_conn();
        let mut postgres = profile("postgres");
        postgres.port = 5432;
        postgres.default_database = Some("app".to_string());
        postgres.engine_options.schema = Some("tenant_a".to_string());

        let saved = save_profile(&conn, &postgres, None).expect("pg 配置应能保存");
        let loaded = get_profile(&conn, &saved.id).expect("读回").expect("存在");
        assert_eq!(loaded.engine_options.schema(), Some("tenant_a"));
        let _ = std::fs::remove_file(path);
    }
}
