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

pub mod codec;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use mysql_async::consts::{ColumnType, StatusFlags};
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, SslOpts};
use rusqlite::Connection;

use super::super::capability::{MySqlProductProfile, ReadOnlyMode};
use super::super::model::{
    DatabaseProfile, DbErrorInfo, TlsStatus, TLS_DISABLED, TLS_VERIFY_CA, TLS_VERIFY_IDENTITY,
};
use super::super::profiles;
use super::super::protocol::{ConnectionIdentity, TransactionState};
use super::super::tunnel::{TunnelLease, TunnelRegistry};

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
    // 适配状态来自注册表：`ConfigOnly` 的引擎配置能保存，但连接必须明确
    // 拒绝，并按产品给出原因（不返回假成功）。
    let engine = super::super::engine_registry::require_implemented(&profile.engine)?;

    // 文件型数据库没有密码，也不该去读钥匙串（读不到反而变成"密码错误"）。
    let password = if engine.fields.password {
        match password_override {
            Some(value) => Some(value.to_string()),
            None => profiles::load_password(profile).map_err(|error| {
                DbErrorInfo::new("config", error.to_string())
                    .with_detail("密码保存在系统钥匙串；若钥匙串项被删除，请重新填写密码。")
            })?,
        }
    } else {
        None
    };

    let ssh = if engine.fields.ssh_tunnel {
        match profile
            .ssh_server_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(server_id) => {
                let target = super::super::tunnel::resolve_ssh_target(
                    db,
                    server_id,
                    &mut std::collections::HashSet::new(),
                )
                .map_err(|error| DbErrorInfo::new("ssh_tunnel", error.to_string()))?;
                Some((server_id.to_string(), target))
            }
            None => None,
        }
    } else {
        None
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
    let tls_enabled = opts.ssl_opts().is_some();
    let host = opts.ip_or_hostname().to_string();
    let port = opts.tcp_port();
    let started = Instant::now();
    match tokio::time::timeout(timeout, Conn::new(opts)).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(error)) => {
            let mut info = map_connect_error(&error, tls_enabled);
            // 没有服务器错误码 = 对端没回错误包就断了。这时唯一有用的事实是
            // "它到底有没有说 MySQL 协议"，补一次只读探测（失败才做，不发送认证数据）。
            if info.code.is_none() {
                let probe = probe_greeting(&host, port, Duration::from_secs(3).min(timeout)).await;
                let line = match probe {
                    Ok(greeting) => format!(
                        "探测结果：{}。服务器确实在说 MySQL 协议，说明它是在认证/握手响应阶段\
                             拒绝了这条连接（认证插件、TLS 要求或账号白名单）。",
                        greeting.summary()
                    ),
                    Err(reason) => format!(
                        "探测结果：{reason}。对端在发出第一条数据前就关闭了连接——端口不是 \
                             MySQL 协议，或中间设备只接受 TLS。"
                    ),
                };
                info.detail = Some(match info.detail.take() {
                    Some(detail) => format!("{detail}\n{line}"),
                    None => line,
                });
            }
            Err(info)
        }
        Err(_) => Err(DbErrorInfo::new(
            "tcp",
            format!("连接超时（{} 秒）", started.elapsed().as_secs().max(1)),
        )
        .retryable(true)
        .with_detail("请检查地址、端口、安全组与 SSH 隧道是否可用。")),
    }
}

/// 服务器初始问候包里我们关心的几个事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerGreeting {
    pub protocol_version: u8,
    pub server_version: String,
    /// 服务端能力位里的 `CLIENT_SSL`。
    pub ssl_supported: bool,
    pub auth_plugin: Option<String>,
}

impl ServerGreeting {
    pub fn summary(&self) -> String {
        format!(
            "{}（协议 v{}，{}，认证插件 {}）",
            self.server_version,
            self.protocol_version,
            if self.ssl_supported {
                "声明支持 TLS"
            } else {
                "未声明支持 TLS"
            },
            self.auth_plugin.as_deref().unwrap_or("未知")
        )
    }
}

/// 只读探测：连上去读第一包，**不发送任何认证数据**。
///
/// 握手被对端关闭时，靠它区分"端口根本不是 MySQL"和"服务器在说 MySQL、
/// 只是拒绝了我们的握手响应"——这两种的排查方向完全不同。
pub async fn probe_greeting(
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<ServerGreeting, String> {
    use tokio::io::AsyncReadExt;

    let mut stream =
        match tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host, port))).await {
            Err(_) => return Err("TCP 连接超时".to_string()),
            Ok(Err(error)) => return Err(format!("TCP 连接失败：{error}")),
            Ok(Ok(stream)) => stream,
        };

    let mut header = [0u8; 4];
    match tokio::time::timeout(timeout, stream.read_exact(&mut header)).await {
        Err(_) => return Err("等待服务器问候超时（对端没有发送任何数据）".to_string()),
        Ok(Err(error)) => return Err(format!("读取服务器问候失败：{error}")),
        Ok(Ok(_)) => {}
    }
    let len = header[0] as usize | (header[1] as usize) << 8 | (header[2] as usize) << 16;
    if len == 0 || len > 4096 {
        return Err(format!(
            "服务器问候长度异常（{len} 字节），对端不像 MySQL 协议"
        ));
    }
    let mut payload = vec![0u8; len];
    match tokio::time::timeout(timeout, stream.read_exact(&mut payload)).await {
        Err(_) => return Err("读取服务器问候超时（包头到了、内容没到）".to_string()),
        Ok(Err(error)) => return Err(format!("读取服务器问候失败：{error}")),
        Ok(Ok(_)) => {}
    }
    parse_greeting(&payload).ok_or_else(|| "服务器问候不是 MySQL 协议格式".to_string())
}

/// 解析 protocol v10 的初始问候包；字段对不上就返回 `None`，不猜。
fn parse_greeting(payload: &[u8]) -> Option<ServerGreeting> {
    if payload.first().copied()? != 10 {
        return None;
    }
    let mut cursor = 1;
    let end = payload[cursor..].iter().position(|byte| *byte == 0)? + cursor;
    let server_version = String::from_utf8_lossy(&payload[cursor..end]).to_string();
    cursor = end + 1;
    // connection id(4) + auth-plugin-data-part-1(8) + filler(1)
    cursor += 13;
    let lower = u16::from_le_bytes([*payload.get(cursor)?, *payload.get(cursor + 1)?]);
    cursor += 2;
    cursor += 1; // charset
    cursor += 2; // status flags
    let upper = u16::from_le_bytes([*payload.get(cursor)?, *payload.get(cursor + 1)?]);
    cursor += 2;
    let capabilities = u32::from(lower) | (u32::from(upper) << 16);
    let ssl_supported = capabilities & 0x0800 != 0;
    cursor += 1; // auth-plugin-data len
    cursor += 10; // reserved

    // 插件名在问候包末尾（`CLIENT_PLUGIN_AUTH` 时）：跳过随机 salt，只认
    // "全小写/数字/下划线"的 NUL 片段，避免把随机字节当插件名。
    let auth_plugin = payload
        .get(cursor..)?
        .split(|byte| *byte == 0)
        .map(|chunk| String::from_utf8_lossy(chunk).to_string())
        .find(|text| {
            text.len() > 4
                && text
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
        });

    Some(ServerGreeting {
        protocol_version: 10,
        server_version,
        ssl_supported,
        auth_plugin,
    })
}

/// 这条配置是否启用了 TLS。连接期错误要不要往 TLS 方向归因，全看它。
pub fn profile_tls_enabled(profile: &DatabaseProfile) -> bool {
    profile.tls_mode != TLS_DISABLED
}

/// 连接期错误：在通用映射之上补"下一步该查什么"。
///
/// `Input/output error: connection closed` 的真实含义是**对端在握手阶段直接
/// 关掉了 TCP**（读包时拿到 EOF，服务器连错误包都没回）。这句原始文本对用户
/// 没有任何指导意义，所以按 `io::ErrorKind` 分类给出可能原因；服务器已经回了
/// 错误包（`code.is_some()`）的情况不覆盖，因为那条信息本来就足够具体。
pub fn map_connect_error(error: &mysql_async::Error, tls_enabled: bool) -> DbErrorInfo {
    let mut info = map_error(error, "tcp");
    if info.code.is_some() {
        return info;
    }

    let kind = match error {
        mysql_async::Error::Io(mysql_async::IoError::Io(io)) => Some(io.kind()),
        _ => None,
    };
    let raw = info.message.clone();
    let lower = raw.to_lowercase();

    let detail = match kind {
        Some(std::io::ErrorKind::UnexpectedEof)
        | Some(std::io::ErrorKind::ConnectionReset)
        | Some(std::io::ErrorKind::BrokenPipe) => {
            // TLS 握手被对端拒绝时也是"读不到预期的握手包"：错误里没有 TLS
            // 字样，只能靠配置判断，否则会一直标成 tcp。
            if tls_enabled {
                info.stage = "tls".to_string();
            }
            info.message = "服务器在握手阶段关闭了连接（没有返回错误包）".to_string();
            let tls_hint = if tls_enabled {
                "服务器不支持 TLS，或拒绝了本次 TLS 握手（当前连接配置了 TLS）"
            } else {
                "服务器要求 TLS（require_secure_transport=ON），而当前是明文连接"
            };
            Some(format!(
                "按可能性排查：1) 端口不是 MySQL 协议端口（填成了 HTTP / 代理 / 监控端口）；\
                 2) {tls_hint}；\
                 3) 服务器已按 max_connect_errors 封禁该来源 IP：在服务器执行 `FLUSH HOSTS` 后重试；\
                 4) 连接被防火墙 / 负载均衡 / 跳板机中断。原始错误：{raw}"
            ))
        }
        Some(std::io::ErrorKind::ConnectionRefused) => {
            info.message = "端口拒绝连接（没有服务在监听）".to_string();
            Some(format!(
                "确认 MySQL 的 bind-address 与端口，以及安全组/防火墙是否放行。原始错误：{raw}"
            ))
        }
        Some(std::io::ErrorKind::TimedOut) => {
            info.message = "连接超时".to_string();
            Some(format!(
                "服务器可能只监听内网地址、被安全组拦截，或 SSH 隧道尚未就绪。原始错误：{raw}"
            ))
        }
        // DNS 失败在各平台上没有稳定的 ErrorKind，退回文本匹配。
        _ if lower.contains("lookup") || lower.contains("dns") || lower.contains("解析") => {
            info.message = "域名解析失败".to_string();
            Some(format!("检查主机名拼写与 DNS 配置。原始错误：{raw}"))
        }
        _ => None,
    };

    match detail {
        Some(detail) => info.with_detail(detail),
        None => info,
    }
}

/// 按产品设置会话：字符集、产品必需的会话初始化、只读默认事务。
///
/// **只读不是所有产品都能落到服务器**：Doris/StarRocks 没有只读事务，
/// 这里不执行（执行会直接报错），由会话标记"仅客户端拦截"并在入口拒绝写语句。
pub async fn apply_session_settings(
    conn: &mut Conn,
    read_only: bool,
    product: &MySqlProductProfile,
) -> Result<(), DbErrorInfo> {
    conn.query_drop("SET NAMES utf8mb4")
        .await
        .map_err(|error| map_error(&error, "query"))?;
    for statement in product.session_init {
        conn.query_drop(*statement)
            .await
            .map_err(|error| map_error(&error, "config"))?;
    }
    if read_only && product.read_only == ReadOnlyMode::ServerTransaction {
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
pub fn transaction_state(conn: &Conn) -> TransactionState {
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
                TransactionState::InTransactionReadOnly
            } else {
                TransactionState::InTransaction
            }
        }
        Some(_) => TransactionState::None,
        None => TransactionState::Unknown,
    }
}

/// MySQL 的连接身份就是服务端 thread id；界面按 `#42` 展示。
/// 其它引擎由各自的驱动实现同一类型，不需要 u32。
pub fn connection_identity(conn: &Conn) -> ConnectionIdentity {
    ConnectionIdentity::numbered(conn.id())
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

/// 标识符引用。**只用于来自验证后元数据的库名/表名/列名**。
///
/// 实现已移到 `adapter::SqlDialect`（方言感知、可单测）；这里保留同名薄封装，
/// 避免改动几十个既有调用点。新代码请直接用 `SqlDialect`。
pub fn quote_identifier(name: &str) -> Result<String, DbErrorInfo> {
    super::super::adapter::SqlDialect::mysql().quote(name)
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
///
/// 实现已移到 `adapter::SqlDialect`（按方言判定 `#` 注释等）；保留此封装
/// 供既有调用点使用。
pub fn is_read_only_sql(sql: &str) -> bool {
    super::super::adapter::SqlDialect::mysql().is_read_only_statement(sql)
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

    fn io_error(kind: std::io::ErrorKind, message: &str) -> mysql_async::Error {
        mysql_async::Error::Io(mysql_async::IoError::Io(std::io::Error::new(kind, message)))
    }

    /// 用户实际看到的那一句：`Input/output error: connection closed`。
    /// 它的含义是"对端在握手阶段关了 TCP"，必须给出可执行的排查方向，
    /// 且原始文本要留在 detail 里，方便事后对日志。
    #[test]
    fn peer_close_during_handshake_explains_what_to_check() {
        let info = map_connect_error(
            &io_error(std::io::ErrorKind::UnexpectedEof, "connection closed"),
            false,
        );
        assert_eq!(info.stage, "tcp");
        assert_eq!(info.code, None);
        assert!(info.message.contains("握手"), "{}", info.message);
        let detail = info.detail.expect("必须给出排查提示");
        assert!(detail.contains("require_secure_transport"));
        assert!(detail.contains("max_connect_errors"));
        assert!(detail.contains("connection closed"), "原始文本不能丢");
    }

    /// 配了 TLS 却读不到握手包：八成是 TLS 本身，标签也要跟着变成 tls。
    #[test]
    fn peer_close_with_tls_is_reported_as_tls_stage() {
        let info = map_connect_error(
            &io_error(std::io::ErrorKind::UnexpectedEof, "connection closed"),
            true,
        );
        assert_eq!(info.stage, "tls");
        assert!(info.detail.expect("提示").contains("配置了 TLS"));
    }

    #[test]
    fn refused_and_timeout_get_their_own_wording() {
        let refused = map_connect_error(
            &io_error(std::io::ErrorKind::ConnectionRefused, "refused"),
            false,
        );
        assert!(refused.message.contains("拒绝"), "{}", refused.message);

        let timeout =
            map_connect_error(&io_error(std::io::ErrorKind::TimedOut, "timed out"), false);
        assert!(timeout.message.contains("超时"), "{}", timeout.message);
    }

    /// 构造一个 protocol v10 问候包：版本串 + 能力位 + 插件名。
    fn greeting_packet(version: &str, capabilities: u32, plugin: &str) -> Vec<u8> {
        let mut payload = vec![10u8];
        payload.extend_from_slice(version.as_bytes());
        payload.push(0);
        payload.extend_from_slice(&42u32.to_le_bytes()); // connection id
        payload.extend_from_slice(b"12345678"); // auth data part 1
        payload.push(0); // filler
        payload.extend_from_slice(&(capabilities as u16).to_le_bytes());
        payload.push(0x21); // charset
        payload.extend_from_slice(&2u16.to_le_bytes()); // status
        payload.extend_from_slice(&((capabilities >> 16) as u16).to_le_bytes());
        payload.push(21); // auth plugin data len
        payload.extend_from_slice(&[0u8; 10]); // reserved
                                               // salt 用非 UTF-8 字节，确保不会被误认为插件名
        payload.extend_from_slice(&[0x9f, 0x8e, 0x8d, 0x8c, 0x00]);
        payload.extend_from_slice(plugin.as_bytes());
        payload.push(0);
        payload
    }

    #[test]
    fn greeting_parser_reads_version_tls_flag_and_plugin() {
        let greeting = parse_greeting(&greeting_packet(
            "8.0.36-log",
            0x0000_0800 | 0x0000_0008,
            "caching_sha2_password",
        ))
        .expect("合法问候包必须能解析");
        assert_eq!(greeting.protocol_version, 10);
        assert_eq!(greeting.server_version, "8.0.36-log");
        assert!(greeting.ssl_supported);
        assert_eq!(
            greeting.auth_plugin.as_deref(),
            Some("caching_sha2_password")
        );

        let plain = parse_greeting(&greeting_packet(
            "5.7.44",
            0x0000_0008,
            "mysql_native_password",
        ))
        .expect("解析");
        assert!(
            !plain.ssl_supported,
            "没有 CLIENT_SSL 能力位就不能报支持 TLS"
        );
        assert_eq!(plain.auth_plugin.as_deref(), Some("mysql_native_password"));
    }

    #[test]
    fn greeting_parser_rejects_non_mysql_payloads() {
        assert!(parse_greeting(b"").is_none());
        assert!(parse_greeting(b"HTTP/1.1 400 Bad Request\r\n").is_none());
        // 协议版本不是 10（例如代理返回的其它协议）
        assert!(parse_greeting(&[9, b'x', 0]).is_none());
    }

    /// 服务器已经回了错误包（比如密码错）时，不能用"握手被关闭"覆盖它。
    #[test]
    fn server_error_keeps_its_own_message() {
        let server = mysql_async::Error::Server(mysql_async::ServerError {
            code: 1045,
            message: "Access denied".to_string(),
            state: "28000".to_string(),
        });
        let info = map_connect_error(&server, false);
        assert_eq!(info.stage, "auth");
        assert!(info.message.contains("Access denied"));
        assert!(info.detail.is_none());
    }
}
