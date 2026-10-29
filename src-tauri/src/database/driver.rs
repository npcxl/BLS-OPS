//! MySQL 驱动适配层：连接参数、TLS、阶段化错误、会话设置。
//!
//! 这里只做"把配置变成一条已认证的物理连接"以及读取服务器真实状态，
//! 不执行任何用户 SQL（那是 `session` / `query` 的职责）。
//!
//! TLS 规则：
//! * `disabled` 才是明文；没有"尝试 TLS、失败退回明文"的自动降级。
//! * `verify_ca` 校验证书链（可跳过 SAN 匹配，用于 SSH 隧道连到 127.0.0.1）。
//! * `verify_identity` 校验链 + 主机名（或 `tls_server_name`）。
//! * **没有** `accept_invalid_certs` 开关：过期/不受信任的证书一定失败。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use mysql_async::consts::{ColumnType, StatusFlags};
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, SslOpts};
use rusqlite::Connection;

use super::model::{
    DatabaseProfile, DbErrorInfo, TlsStatus, TLS_DISABLED, TLS_VERIFY_CA, TLS_VERIFY_IDENTITY,
};
use super::profiles;
use super::tunnel::{TunnelLease, TunnelRegistry};

/// 交互式连接池上限：4 条足够让"元数据 + 表数据 + 列详情"并行，
/// 又不会在后台把一个 MySQL 账号的连接数吃光。
const INTERACTIVE_POOL_MAX: usize = 4;
/// 导出单独一个池，最多 1 条：大导出必须**不能**占满交互连接。
const EXPORT_POOL_MAX: usize = 1;
const POOL_IDLE_TTL_SECS: u64 = 30;

/// 每次解析配置递增，用于"旧响应不能污染新结果"。
static GENERATION: AtomicU64 = AtomicU64::new(1);

pub fn next_generation() -> u64 {
    GENERATION.fetch_add(1, Ordering::AcqRel)
}

/// rustls 需要进程级 CryptoProvider；没有它，第一次 TLS 握手会 panic。
/// `run()` 里已经装过一次，这里再用 `Once` 兜底，让集成测试/纯驱动调用
/// 也不依赖 Tauri 启动流程。
static CRYPTO_PROVIDER: std::sync::Once = std::sync::Once::new();

fn ensure_crypto_provider() {
    CRYPTO_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// 已解析的物理端点。SSH 隧道时 `connect_host` 是回环地址，
/// 而 `tls_server_name` / `profile.host` 仍然是用户填的数据库地址。
pub struct ResolvedEndpoint {
    pub profile: DatabaseProfile,
    pub password: Option<String>,
    pub tunnel: Option<TunnelLease>,
    pub connect_host: String,
    pub connect_port: u16,
    pub generation: u64,
    pub read_only: bool,
}

impl ResolvedEndpoint {
    pub fn tunnel_local_port(&self) -> Option<u16> {
        self.tunnel.as_ref().map(TunnelLease::local_port)
    }

    /// 证书校验用的名字：优先用户显式配置，否则用数据库原始主机名
    /// （**不是**隧道的 127.0.0.1）。
    pub fn tls_server_name(&self) -> String {
        self.profile
            .tls_server_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&self.profile.host)
            .to_string()
    }
}

/// 同步阶段准备好的连接计划。
///
/// 把 SQLite 读取与钥匙串读取放在**同步**阶段，`async` 阶段只做网络 I/O。
/// 这样 `rusqlite::Connection`（`!Sync`）不会被带进 `Future`，
/// Tauri 的 `Send` 约束自然成立，也不会在 await 期间占着数据库文件。
pub struct EndpointPlan {
    pub profile: DatabaseProfile,
    pub password: Option<String>,
    /// `(ssh 服务器 id, 已展开的 ConnectTarget)`
    pub ssh: Option<(String, crate::ssh::ConnectTarget)>,
    pub generation: u64,
}

pub fn plan_from_db(db: &Connection, profile_id: &str) -> Result<EndpointPlan, DbErrorInfo> {
    let profile = profiles::get_profile(db, profile_id)
        .map_err(|error| DbErrorInfo::new("config", error.to_string()))?
        .ok_or_else(|| DbErrorInfo::new("config", "连接配置不存在或已被删除"))?;
    plan_from_profile(db, &profile, None)
}

/// 从内存中的配置构建计划（"测试连接"用的就是这条路径：
/// 表单还没保存，但用户需要知道能不能连）。
pub fn plan_from_profile(
    db: &Connection,
    profile: &DatabaseProfile,
    password_override: Option<&str>,
) -> Result<EndpointPlan, DbErrorInfo> {
    if profile.engine != super::model::ENGINE_MYSQL
        && profile.engine != super::model::ENGINE_REDIS
    {
        return Err(DbErrorInfo::new(
            "unsupported",
            if profile.engine == super::model::ENGINE_POSTGRES {
                "PostgreSQL 适配尚未实现：本版本只支持 MySQL 8.0 / 8.4"
            } else {
                "不支持的数据库类型"
            },
        ));
    }

    let password = match password_override {
        Some(value) => Some(value.to_string()),
        None => profiles::load_password(profile).map_err(|error| {
            DbErrorInfo::new("config", error.to_string())
                .with_detail("密码保存在系统钥匙串；若钥匙串项被删除，请重新填写密码。")
        })?,
    };

    let ssh = match profile
        .ssh_server_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(server_id) => {
            let target = super::tunnel::resolve_ssh_target(
                db,
                server_id,
                &mut std::collections::HashSet::new(),
            )
            .map_err(|error| DbErrorInfo::new("ssh_tunnel", error.to_string()))?;
            Some((server_id.to_string(), target))
        }
        None => None,
    };

    Ok(EndpointPlan {
        profile: profile.clone(),
        password,
        ssh,
        generation: next_generation(),
    })
}

/// 需要时建立/复用 SSH 隧道，得到真正可连接的端点。
pub async fn resolve_plan(
    tunnels: &TunnelRegistry,
    plan: EndpointPlan,
) -> Result<ResolvedEndpoint, DbErrorInfo> {
    let (tunnel, connect_host, connect_port) = match plan.ssh {
        Some((server_id, target)) => {
            let lease = tunnels
                .acquire(&server_id, &plan.profile.host, plan.profile.port, target)
                .await?;
            let port = lease.local_port();
            (Some(lease), "127.0.0.1".to_string(), port)
        }
        None => (None, plan.profile.host.clone(), plan.profile.port),
    };

    Ok(ResolvedEndpoint {
        read_only: plan.profile.read_only,
        profile: plan.profile,
        password: plan.password,
        tunnel,
        connect_host,
        connect_port,
        generation: plan.generation,
    })
}

fn build_ssl_opts(endpoint: &ResolvedEndpoint) -> Result<Option<SslOpts>, DbErrorInfo> {
    let mode = endpoint.profile.tls_mode.as_str();
    if mode == TLS_DISABLED {
        return Ok(None);
    }

    let mut ssl = SslOpts::default();
    if mode != TLS_VERIFY_CA && mode != TLS_VERIFY_IDENTITY {
        return Err(DbErrorInfo::new(
            "config",
            format!("未知的 TLS 模式：{mode}"),
        ));
    }

    // 已知限制（实测，不隐藏）：mysql_async 0.37.1 的
    // `with_danger_skip_domain_validation` 靠匹配 rustls 旧版错误文本
    // "NotValidForName" 实现，而 rustls 0.23 的错误文本已变化，开关
    // **实际不会跳过域名验证**。因此我们不做"verify_ca 假装只验证链"：
    // 两种模式都使用明确的验证名，SSH 隧道场景请填写 `tls_server_name`。
    // 绝不使用 `accept_invalid_certs` 来"解决"连接失败。

    if let Some(ca_path) = endpoint
        .profile
        .tls_ca_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let path = PathBuf::from(ca_path);
        if !path.is_file() {
            return Err(DbErrorInfo::new(
                "tls",
                format!("CA 证书文件不存在：{ca_path}"),
            ));
        }
        // `PathOrBuf` 在 mysql_async 的私有 opts 模块里，外部无法命名，
        // 但它实现了 `From<PathBuf>`；由参数类型推断即可，不需要暴露类型。
        ssl = ssl.with_root_certs(vec![path.into()]);
    }

    // 无论是否走隧道，都给驱动一个明确的校验名字：
    // 隧道场景下这是用户填的数据库域名，而不是 127.0.0.1。
    ssl = ssl.with_danger_tls_hostname_override(Some(endpoint.tls_server_name()));

    Ok(Some(ssl))
}

/// 构建连接参数。`pool = true` 时带上明确的池上限与空闲回收。
pub fn build_opts(endpoint: &ResolvedEndpoint, pool: bool) -> Result<Opts, DbErrorInfo> {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(endpoint.connect_host.clone())
        .tcp_port(endpoint.connect_port)
        .user(Some(endpoint.profile.username.clone()))
        // MySQL 允许空密码；`None` 在部分服务器上会被当成"不发送密码"，
        // 与"发送空密码"不是一回事，因此统一给 Some。
        .pass(Some(endpoint.password.clone().unwrap_or_default()))
        .db_name(
            endpoint
                .profile
                .default_database
                .clone()
                .filter(|value| !value.trim().is_empty()),
        )
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .tcp_nodelay(true)
        .stmt_cache_size(Some(16usize))
        .wait_timeout(Some(600usize))
        // 单包硬上限：驱动在解码前会按包长分配内存。
        // 16 MiB 足以容纳单个 JSON/文本单元格，又能让"一行 2 GB"的
        // 意外立刻变成可解释的错误，而不是把进程内存吃光。
        .max_allowed_packet(Some(16 * 1024 * 1024))
        // 中文/emoji：连接后显式设置，不依赖服务器的默认字符集。
        .init(vec!["SET NAMES utf8mb4".to_string()]);

    if let Some(ssl_opts) = build_ssl_opts(endpoint)? {
        builder = builder.ssl_opts(Some(ssl_opts));
    }

    if pool {
        let max = if endpoint.profile.read_only {
            INTERACTIVE_POOL_MAX
        } else {
            INTERACTIVE_POOL_MAX
        };
        let constraints = PoolConstraints::new(0, max)
            .ok_or_else(|| DbErrorInfo::new("config", "无法创建数据库连接池约束（内部错误）"))?;
        builder = builder.pool_opts(Some(
            PoolOpts::default()
                .with_constraints(constraints)
                .with_inactive_connection_ttl(Duration::from_secs(POOL_IDLE_TTL_SECS))
                // 归还时重置会话：表浏览/元数据连接不携带事务、临时表或用户变量。
                .with_reset_connection(true),
        ));
    }

    Ok(Opts::from(builder))
}

pub fn build_interactive_pool(opts: Opts) -> Pool {
    Pool::new(opts)
}

pub fn build_export_pool(opts: Opts) -> Pool {
    let constraints = PoolConstraints::new(0, EXPORT_POOL_MAX).expect("export pool constraints");
    Pool::new(Opts::from(
        OptsBuilder::from_opts(opts).pool_opts(Some(
            PoolOpts::default()
                .with_constraints(constraints)
                .with_inactive_connection_ttl(Duration::from_secs(POOL_IDLE_TTL_SECS)),
        )),
    ))
}

/// 建立一条独占连接。连接超时是**客户端**强制的：服务器不响应时不会挂死。
pub async fn connect_once(opts: Opts, timeout: Duration) -> Result<Conn, DbErrorInfo> {
    ensure_crypto_provider();
    let started = Instant::now();
    match tokio::time::timeout(timeout, Conn::new(opts)).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(error)) => Err(map_error(&error, "tcp")),
        Err(_) => Err(DbErrorInfo::new(
            "tcp",
            format!("连接超时（{} 秒）", started.elapsed().as_secs().max(1)),
        )
        .retryable(true)
        .with_detail("请检查地址、端口、安全组与 SSH 隧道是否可用。")),
    }
}

/// 按服务器设置会话：字符集、只读默认事务。
pub async fn apply_session_settings(conn: &mut Conn, read_only: bool) -> Result<(), DbErrorInfo> {
    conn.query_drop("SET NAMES utf8mb4")
        .await
        .map_err(|error| map_error(&error, "query"))?;
    if read_only {
        // 服务端机制，不是前端开关：之后任何写语句都会被服务器拒绝（1792）。
        conn.query_drop("SET SESSION TRANSACTION READ ONLY")
            .await
            .map_err(|error| map_error(&error, "permission"))?;
    }
    Ok(())
}

pub async fn server_version(conn: &mut Conn) -> Option<String> {
    conn.query_first::<String, _>("SELECT VERSION()")
        .await
        .ok()
        .flatten()
}

pub async fn current_database(conn: &mut Conn) -> Option<String> {
    conn.query_first::<Option<String>, _>("SELECT DATABASE()")
        .await
        .ok()
        .flatten()
        .flatten()
}

pub async fn read_tls_status(conn: &mut Conn) -> TlsStatus {
    let rows: Vec<(String, String)> = match conn
        .query::<(String, String), _>("SHOW SESSION STATUS LIKE 'Ssl_%'")
        .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return TlsStatus {
                active: false,
                cipher: None,
                version: None,
            }
        }
    };

    let mut cipher = None;
    let mut version = None;
    for (key, value) in rows {
        match key.as_str() {
            "Ssl_cipher" => cipher = Some(value).filter(|value| !value.is_empty()),
            "Ssl_version" => version = Some(value).filter(|value| !value.is_empty()),
            _ => {}
        }
    }
    TlsStatus {
        active: cipher.is_some(),
        cipher,
        version,
    }
}

/// 事务状态以**服务器的 OK 包**为准，不看 SQL 前缀。
pub fn transaction_state(conn: &Conn) -> &'static str {
    match conn.last_ok_packet() {
        Some(packet)
            if packet
                .status_flags()
                .contains(StatusFlags::SERVER_STATUS_IN_TRANS) =>
        {
            if packet
                .status_flags()
                .contains(StatusFlags::SERVER_STATUS_IN_TRANS_READONLY)
            {
                "in_transaction_read_only"
            } else {
                "in_transaction"
            }
        }
        Some(_) => "none",
        None => "unknown",
    }
}

/// 结构化的错误映射。`stage_hint` 是调用方已知的上下文（例如"认证"）。
pub fn map_error(error: &mysql_async::Error, stage_hint: &str) -> DbErrorInfo {
    match error {
        mysql_async::Error::Server(server) => {
            let stage = match server.code {
                1045 => "auth",
                1044 | 1049 | 1146 => "database",
                1792 => "permission",
                1317 | 3024 => "cancelled",
                1227 => "permission",
                _ => stage_hint,
            };
            DbErrorInfo {
                stage: stage.to_string(),
                code: Some(u32::from(server.code)),
                sql_state: Some(server.state.clone()),
                message: server.message.clone(),
                detail: None,
                retryable: false,
            }
        }
        mysql_async::Error::Io(io) => {
            let text = io.to_string();
            let lower = text.to_lowercase();
            let stage = if lower.contains("tls")
                || lower.contains("certificate")
                || lower.contains("handshake")
                || lower.contains("invalid peer")
            {
                "tls"
            } else {
                "tcp"
            };
            DbErrorInfo::new(stage, text).retryable(true)
        }
        mysql_async::Error::Url(url) => DbErrorInfo::new("config", url.to_string()),
        other => {
            let text = other.to_string();
            let lower = text.to_lowercase();
            let stage = if lower.contains("tls") || lower.contains("certificate") {
                "tls"
            } else {
                stage_hint
            };
            DbErrorInfo::new(stage, text)
        }
    }
}

/// 服务器错误码判断：查询被 KILL / 超时。
pub fn is_interrupted(error: &mysql_async::Error) -> bool {
    matches!(error, mysql_async::Error::Server(server) if server.code == 1317 || server.code == 3024)
}

/// 标识符引用。**只用于来自验证后元数据的库名/表名/列名**，
/// 但函数本身仍然是防御性的：反引号会被转义，NUL 被拒绝。
pub fn quote_identifier(name: &str) -> Result<String, DbErrorInfo> {
    if name.is_empty() {
        return Err(DbErrorInfo::new("query", "标识符不能为空"));
    }
    if name.len() > 64 {
        return Err(DbErrorInfo::new(
            "query",
            format!("标识符过长（{} 字节，MySQL 上限 64）", name.len()),
        ));
    }
    if name.contains('\0') {
        return Err(DbErrorInfo::new("query", "标识符包含非法字符"));
    }
    Ok(format!("`{}`", name.replace('`', "``")))
}

/// 类型名：给 UI 显示，不参与逻辑判断。
pub fn column_type_name(kind: ColumnType) -> &'static str {
    match kind {
        ColumnType::MYSQL_TYPE_DECIMAL => "DECIMAL",
        ColumnType::MYSQL_TYPE_TINY => "TINYINT",
        ColumnType::MYSQL_TYPE_SHORT => "SMALLINT",
        ColumnType::MYSQL_TYPE_LONG => "INT",
        ColumnType::MYSQL_TYPE_FLOAT => "FLOAT",
        ColumnType::MYSQL_TYPE_DOUBLE => "DOUBLE",
        ColumnType::MYSQL_TYPE_NULL => "NULL",
        ColumnType::MYSQL_TYPE_TIMESTAMP => "TIMESTAMP",
        ColumnType::MYSQL_TYPE_LONGLONG => "BIGINT",
        ColumnType::MYSQL_TYPE_INT24 => "MEDIUMINT",
        ColumnType::MYSQL_TYPE_DATE => "DATE",
        ColumnType::MYSQL_TYPE_TIME => "TIME",
        ColumnType::MYSQL_TYPE_DATETIME => "DATETIME",
        ColumnType::MYSQL_TYPE_YEAR => "YEAR",
        ColumnType::MYSQL_TYPE_NEWDATE => "DATE",
        ColumnType::MYSQL_TYPE_VARCHAR => "VARCHAR",
        ColumnType::MYSQL_TYPE_BIT => "BIT",
        ColumnType::MYSQL_TYPE_TIMESTAMP2 => "TIMESTAMP",
        ColumnType::MYSQL_TYPE_DATETIME2 => "DATETIME",
        ColumnType::MYSQL_TYPE_TIME2 => "TIME",
        ColumnType::MYSQL_TYPE_TYPED_ARRAY => "TYPED ARRAY",
        ColumnType::MYSQL_TYPE_UNKNOWN => "UNKNOWN",
        ColumnType::MYSQL_TYPE_JSON => "JSON",
        ColumnType::MYSQL_TYPE_NEWDECIMAL => "DECIMAL",
        ColumnType::MYSQL_TYPE_ENUM => "ENUM",
        ColumnType::MYSQL_TYPE_SET => "SET",
        ColumnType::MYSQL_TYPE_TINY_BLOB => "TINYBLOB",
        ColumnType::MYSQL_TYPE_MEDIUM_BLOB => "MEDIUMBLOB",
        ColumnType::MYSQL_TYPE_LONG_BLOB => "LONGBLOB",
        ColumnType::MYSQL_TYPE_BLOB => "BLOB",
        ColumnType::MYSQL_TYPE_VAR_STRING => "VARBINARY",
        ColumnType::MYSQL_TYPE_STRING => "CHAR",
        ColumnType::MYSQL_TYPE_GEOMETRY => "GEOMETRY",
        _ => "UNKNOWN",
    }
}

/// 判断一条语句是否只读（导出、安全提示用）。
///
/// **这不是安全边界**：真正的只读保证来自导出连接的
/// `START TRANSACTION READ ONLY`。这里只是拒绝明显会写数据的语句，
/// 避免把 `INSERT … SELECT` 当成"查询"去重复执行。
pub fn is_read_only_sql(sql: &str) -> bool {
    let stripped = strip_leading_comments_and_space(sql);
    let keyword = stripped
        .split(|c: char| c.is_whitespace() || c == '(' || c == ';')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let lower = stripped.to_ascii_lowercase();
    if lower.contains("into outfile") || lower.contains("into dumpfile") {
        return false;
    }
    // `WITH` 也可能是 `WITH … UPDATE`。真正的写保护来自导出连接上的
    // `START TRANSACTION READ ONLY`，这里只做第一道筛选。
    matches!(
        keyword.as_str(),
        "select" | "show" | "describe" | "desc" | "explain" | "table" | "values" | "with"
    )
}

fn strip_leading_comments_and_space(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(stripped) = rest.strip_prefix("--") {
            match stripped.find('\n') {
                Some(index) => rest = stripped[index + 1..].trim_start(),
                None => return "",
            }
        } else if let Some(stripped) = rest.strip_prefix('#') {
            match stripped.find('\n') {
                Some(index) => rest = stripped[index + 1..].trim_start(),
                None => return "",
            }
        } else if rest.starts_with("/*") {
            match rest[2..].find("*/") {
                Some(index) => rest = rest[2 + index + 2..].trim_start(),
                None => return "",
            }
        } else {
            return rest;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_identifier_escapes_backticks() {
        assert_eq!(quote_identifier("users").unwrap(), "`users`");
        assert_eq!(quote_identifier("we`ird").unwrap(), "`we``ird`");
        assert!(quote_identifier("").is_err());
        assert!(quote_identifier(&"x".repeat(65)).is_err());
    }

    #[test]
    fn read_only_detection_handles_comments_and_cte() {
        assert!(is_read_only_sql("SELECT 1"));
        assert!(is_read_only_sql("-- comment\nSELECT 1"));
        assert!(is_read_only_sql("/* c */ show tables"));
        assert!(is_read_only_sql("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!is_read_only_sql("UPDATE t SET a = 1"));
        assert!(!is_read_only_sql("select * from t into outfile '/tmp/x'"));
    }
}
