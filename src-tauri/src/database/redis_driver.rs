//! Redis 驱动适配层 —— 与 MySQL 的 `session`/`query` 管线**完全平行**。
//!
//! 职责边界：
//! * 这里只做"把配置变成已认证的 Redis 连接"以及键空间操作
//!   （SCAN / 读写 / TTL / PUBLISH / 订阅推流）。
//! * 不碰 SQL 会话注册表 —— Redis 没有 session/query/事务语义。
//! * 密码来自 `EndpointPlan`（Keyring 已在 plan 层解析），**绝不落日志**。
//!
//! 连接模式：
//! * `standalone` —— 支持 SSH 隧道与 TLS（组合不支持，见 TLS 说明）。
//! * `sentinel`   —— 先向哨兵节点 `SENTINEL get-master-addr-by-name` 查询
//!   master 真实地址，再按 standalone 方式连接 master。**哨兵与 master
//!   均为直连**（不经过 SSH 隧道）——隧道只能映射单个目标端口，而
//!   哨兵拓扑的节点地址是运行期发现的，二者天然冲突。
//! * `cluster`    —— `ClusterClient` 直连全部启动节点，仅 db 0
//!   （Redis Cluster 本身不支持 SELECT）。
//!
//! TLS 边界：`verify_ca` / `verify_identity` 都映射为"校验证书链"
//! （redis-rs 的 rustls 后端没有自定义 CA 文件入口），因此 `tls_ca_path`
//! 非空、或"TLS + SSH 隧道"组合都会返回明确的 config 错误 —— 宁可拒绝，
//! 不做静默降级。
//!
//! db index 语义：standalone/sentinel 用**连接级 db**（连接串里的 db），
//! 不发 `SELECT` —— 这样连接断线重连后仍落在正确的 db 上；cluster 只有 db 0。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use redis::aio::ConnectionManager;
use redis::cluster_async::ClusterConnection;
use redis::{AsyncCommands, Cmd, FromRedisValue, RedisError, Value as RedisValue};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::driver::{self, EndpointPlan};
use super::model::{
    ConnectionTestResult, DatabaseProfile, DbErrorInfo, ProfileRuntimeStatus, REDIS_MODE_CLUSTER,
    REDIS_MODE_SENTINEL, REDIS_MODE_STANDALONE, TLS_DISABLED,
};
use super::tunnel::TunnelRegistry;

/// 单次 SCAN 的键数上限（前端翻页用 cursor 续扫）。
pub const SCAN_PAGE_MAX: usize = 500;
/// 单键读值的条目上限（list/set/zset/stream 共用）：防御全量拉取拖垮 UI。
pub const READ_ITEMS_MAX: usize = 5_000;
/// Stream 单次 XRANGE 的条目上限。
pub const STREAM_READ_MAX: usize = 1_000;
/// pub/sub 订阅数上限：防止订阅面板把连接数吃爆。
pub const PUBSUB_MAX: usize = 16;
/// Hash 单次 HSCAN 的条目上限：hash 一律走 HSCAN 分页，绝不 HGETALL。
pub const HASH_PAGE_MAX: usize = 200;

// ---------------------------------------------------------------------------
// 连接表示
// ---------------------------------------------------------------------------

/// 统一的连接句柄：`ConnectionManager` 与 `ClusterConnection` 都是可克隆的
/// 共享句柄（内部自带自动重连），克隆出去用，不需要长时间持有锁。
#[derive(Clone)]
pub enum RedisConn {
    Single(ConnectionManager),
    Cluster(Box<ClusterConnection>),
}

/// 转发 `ConnectionLike`：让 `AsyncCommands`（set/hset/del/…）直接可用。
impl redis::aio::ConnectionLike for RedisConn {
    fn req_packed_command<'a>(
        &'a mut self,
        cmd: &'a Cmd,
    ) -> redis::RedisFuture<'a, RedisValue> {
        match self {
            RedisConn::Single(conn) => conn.req_packed_command(cmd),
            RedisConn::Cluster(conn) => conn.req_packed_command(cmd),
        }
    }

    fn req_packed_commands<'a>(
        &'a mut self,
        cmd: &'a redis::Pipeline,
        offset: usize,
        count: usize,
    ) -> redis::RedisFuture<'a, Vec<RedisValue>> {
        match self {
            RedisConn::Single(conn) => conn.req_packed_commands(cmd, offset, count),
            RedisConn::Cluster(conn) => conn.req_packed_commands(cmd, offset, count),
        }
    }

    fn get_db(&self) -> i64 {
        match self {
            RedisConn::Single(conn) => conn.get_db(),
            RedisConn::Cluster(conn) => conn.get_db(),
        }
    }
}

impl RedisConn {
    async fn query<T: FromRedisValue>(&mut self, cmd: &mut Cmd) -> Result<T, RedisError> {
        redis::aio::ConnectionLike::req_packed_command(self, cmd)
            .await
            .and_then(|value| T::from_owned_redis_value(value))
    }
}

// ---------------------------------------------------------------------------
// 值载荷（前端契约）
// ---------------------------------------------------------------------------

/// 键列表里的一行：SCAN 只拿名字，类型/TTL 用 pipeline 补齐。
#[derive(Debug, Clone, Serialize)]
pub struct RedisKeyBrief {
    pub key: String,
    pub kind: String,
    /// 剩余毫秒；-1 = 永久，-2 = 已过期/不存在。
    pub ttl_ms: i64,
}

/// hash 的一行。
///
/// 字段值按 UTF-8 传输；不是合法 UTF-8 的值以 Base64 前缀
/// `b64:` 标记（数据本体不损坏，前端可还原）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisFieldEntry {
    pub field: String,
    pub value: String,
}

impl RedisFieldEntry {
    /// 把原始字节安全地变成可传输的字符串：UTF-8 直传，二进制走 Base64。
    pub fn from_bytes(field: String, bytes: &[u8]) -> Self {
        match std::str::from_utf8(bytes) {
            Ok(value) => Self {
                field,
                value: value.to_string(),
            },
            Err(_) => Self {
                field,
                value: format!("b64:{}", BASE64_STANDARD.encode(bytes)),
            },
        }
    }
}

/// HSCAN 的一页：cursor 为 0 表示已取完。
#[derive(Debug, Clone, Serialize)]
pub struct RedisHashPage {
    pub cursor: u64,
    pub fields: Vec<RedisFieldEntry>,
    pub length: i64,
}

/// zset 的一行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisZEntry {
    pub member: String,
    pub score: f64,
}

/// stream 的一行（XRANGE 展开）。
#[derive(Debug, Clone, Serialize)]
pub struct RedisStreamEntry {
    pub id: String,
    pub fields: Vec<RedisFieldEntry>,
}

/// 键值的类型化载荷：前端按 `kind` 分支渲染与编辑。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RedisValuePayload {
    String {
        value: String,
        /// true = `value` 是原始字节的 Base64 编码（二进制值），写回时需
        /// 先 Base64 解码。这样数据本体永不损坏（不做有损替换）。
        binary: bool,
    },
    Hash {
        fields: Vec<RedisFieldEntry>,
        length: i64,
        /// 下一页 HSCAN cursor；0 = 已取完（小 hash 一页就完）。
        cursor: u64,
    },
    List {
        items: Vec<String>,
        length: i64,
        /// 条目数超过 READ_ITEMS_MAX：列表被截断，编辑入口关闭。
        truncated: bool,
    },
    Set {
        members: Vec<String>,
        length: i64,
        truncated: bool,
    },
    Zset {
        entries: Vec<RedisZEntry>,
        length: i64,
        truncated: bool,
    },
    Stream {
        entries: Vec<RedisStreamEntry>,
        /// XLEN 的真实长度（与 entries 长度不同即代表被截断）。
        length: i64,
    },
    /// 未知/模块类型：只报类型名，不假装能读。
    Other {
        type_name: String,
    },
}

/// 键元信息（详情面板头部）。
#[derive(Debug, Clone, Serialize)]
pub struct RedisKeyInfo {
    pub key: String,
    pub kind: String,
    /// 剩余毫秒；-1 = 永久，-2 = 不存在。
    pub ttl_ms: i64,
    /// MEMORY USAGE 的字节数；None = 服务器不支持或键已不存在。
    pub memory_bytes: Option<i64>,
}

/// SCAN 的一页。
#[derive(Debug, Clone, Serialize)]
pub struct RedisScanPage {
    /// 下一页 cursor；0 表示已扫完。
    pub cursor: u64,
    pub keys: Vec<RedisKeyBrief>,
    pub dbsize: i64,
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

pub struct RedisSession {
    pub profile: DatabaseProfile,
    pub generation: u64,
    /// standalone 模式下持有隧道租约，保证隧道不断（sentinel/cluster 直连）。
    pub tunnel: Option<super::tunnel::TunnelLease>,
    pub server_version: Option<String>,
    /// plan 层解析好的密码（Keyring），克隆进每个连接串。**不落日志。**
    password: Option<String>,
    /// 真实连接目标（隧道时是回环地址）。sentinel/cluster 模式为 None。
    connect_addr: Option<(String, u16)>,
    /// standalone：按 db index 缓存连接（SELECT 语义靠连接级 db 实现）。
    single_conns: Mutex<HashMap<i64, ConnectionManager>>,
    cluster_conn: Mutex<Option<ClusterConnection>>,
}

impl RedisSession {
    /// 建立会话：解析端点 → 建连 → PING。任何一步失败都按阶段报错。
    pub async fn open(
        tunnels: &TunnelRegistry,
        plan: EndpointPlan,
    ) -> Result<Arc<Self>, DbErrorInfo> {
        let profile = plan.profile.clone();
        let mode = profile
            .redis_mode
            .as_deref()
            .unwrap_or(REDIS_MODE_STANDALONE)
            .to_string();
        let timeout = Duration::from_millis(profile.connect_timeout_ms.max(1_000));

        let mut session = Self {
            profile,
            generation: plan.generation,
            tunnel: None,
            server_version: None,
            password: plan.password.clone(),
            connect_addr: None,
            single_conns: Mutex::new(HashMap::new()),
            cluster_conn: Mutex::new(None),
        };

        match mode.as_str() {
            REDIS_MODE_STANDALONE => {
                let endpoint = driver::resolve_plan(tunnels, plan).await?;
                session.tunnel = endpoint.tunnel;
                session.connect_addr =
                    Some((endpoint.connect_host.clone(), endpoint.connect_port));
                let db = session.default_db()?;
                let conn = session
                    .build_single(&endpoint.connect_host, endpoint.connect_port, db, "connect")
                    .await?;
                session.single_conns.lock().await.insert(db, conn);
            }
            REDIS_MODE_SENTINEL => {
                let master = session
                    .profile
                    .sentinel_master
                    .clone()
                    .unwrap_or_default();
                let nodes = session.topology_nodes();
                let (host, port) = discover_master_via_sentinel(
                    &nodes,
                    &master,
                    session.profile.username.trim(),
                    session.password.clone(),
                    timeout,
                )
                .await?;
                session.connect_addr = Some((host.clone(), port));
                let db = session.default_db()?;
                let conn = session
                    .build_single(&host, port, db, "sentinel")
                    .await?;
                session.single_conns.lock().await.insert(db, conn);
            }
            REDIS_MODE_CLUSTER => {
                let nodes = session
                    .topology_nodes()
                    .into_iter()
                    .map(|(host, port)| {
                        node_url(&host, port, &session.profile, session.password.clone())
                    })
                    .collect::<Vec<_>>();
                let client = redis::cluster::ClusterClient::new(nodes)
                    .map_err(|error| {
                        DbErrorInfo::new("connect", format!("ClusterClient 初始化失败：{error}"))
                    })?;
                let conn = tokio::time::timeout(timeout, client.get_async_connection())
                    .await
                    .map_err(|_| DbErrorInfo::new("connect", "连接超时"))?
                    .map_err(|error| DbErrorInfo::new("connect", format!("{error}")))?;
                *session.cluster_conn.lock().await = Some(conn);
            }
            other => {
                return Err(DbErrorInfo::new(
                    "config",
                    format!("未知的 Redis 连接模式：{other}"),
                ));
            }
        }

        // PING：任何模式下都要求成功才算"已连接"。
        let pong: String = {
            let mut conn = session.acquire(session.default_db()?).await?;
            conn.query(Cmd::new().arg("PING")).await.map_err(|error| {
                DbErrorInfo::new("auth", format!("PING 失败：{error}"))
            })?
        };
        if pong != "PONG" {
            return Err(DbErrorInfo::new("auth", format!("PING 返回异常：{pong}")));
        }
        session.server_version =
            redis_version(&mut session.acquire(session.default_db()?).await?).await;

        Ok(Arc::new(session))
    }

    /// 默认 db index：`default_database` 存 "0".."15"，缺失/非法按 0。
    fn default_db(&self) -> Result<i64, DbErrorInfo> {
        let parsed = self
            .profile
            .default_database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::parse::<i64>);
        match parsed {
            None => Ok(0),
            Some(Ok(value)) if (0..=15).contains(&value) => Ok(value),
            Some(Ok(other)) => Err(DbErrorInfo::new(
                "config",
                format!("Redis db index 必须在 0 到 15 之间（当前 {other}）"),
            )),
            Some(Err(_)) => Err(DbErrorInfo::new(
                "config",
                "默认数据库必须是 0 到 15 的数字",
            )),
        }
    }

    /// 拓扑节点：profile 的 host:port 永远是第一个，`nodes_json` 追加其余。
    fn topology_nodes(&self) -> Vec<(String, u16)> {
        let mut nodes = vec![(self.profile.host.trim().to_string(), self.profile.port)];
        if let Some(raw) = self.profile.nodes_json.as_deref() {
            if let Ok(list) = serde_json::from_str::<Vec<String>>(raw) {
                for entry in list {
                    let entry = entry.trim().to_string();
                    if entry.is_empty() {
                        continue;
                    }
                    let (host, port) = match entry.rsplit_once(':') {
                        Some((host, port)) => (
                            host.trim().trim_start_matches('[').to_string(),
                            port.trim().parse::<u16>().unwrap_or(6379),
                        ),
                        None => (entry, 6379),
                    };
                    if !nodes.iter().any(|(h, p)| h == &host && p == &port) {
                        nodes.push((host, port));
                    }
                }
            }
        }
        nodes
    }

    /// standalone：建一条指向 (host, port) 的 ConnectionManager。
    async fn build_single(
        &self,
        host: &str,
        port: u16,
        db: i64,
        stage: &str,
    ) -> Result<ConnectionManager, DbErrorInfo> {
        if self.profile.tls_mode != TLS_DISABLED && self.tunnel.is_some() {
            return Err(DbErrorInfo::new(
                "config",
                "Redis 的 TLS 与 SSH 隧道暂不支持同时使用：请二选一（隧道场景大多数是内网明文）",
            ));
        }
        let info = connection_info(host, port, db, &self.profile, self.password.clone())?;
        connect_manager(info, Duration::from_millis(self.profile.connect_timeout_ms), stage).await
    }

    /// 取指定 db 的连接句柄（克隆共享句柄，不长时间持锁）。
    pub async fn acquire(&self, db: i64) -> Result<RedisConn, DbErrorInfo> {
        {
            let cluster = self.cluster_conn.lock().await;
            if let Some(conn) = cluster.as_ref() {
                if db != 0 {
                    return Err(DbErrorInfo::new(
                        "query",
                        "Redis Cluster 只有 db 0：cluster 模式不支持切换数据库",
                    ));
                }
                return Ok(RedisConn::Cluster(Box::new(conn.clone())));
            }
        }
        {
            let conns = self.single_conns.lock().await;
            if let Some(conn) = conns.get(&db) {
                return Ok(RedisConn::Single(conn.clone()));
            }
        }
        // 该 db 还没建过连接：新建并缓存（连接级 db，重连不跑偏）。
        let (host, port) = self
            .connect_addr
            .clone()
            .ok_or_else(|| DbErrorInfo::new("connect", "会话尚未建立连接"))?;
        let conn = self.build_single(&host, port, db, "connect").await?;
        self.single_conns.lock().await.insert(db, conn.clone());
        Ok(RedisConn::Single(conn))
    }

    /// 只读闸门：`read_only` 的连接拒绝一切写命令。
    fn ensure_writable(&self, op: &str) -> Result<(), DbErrorInfo> {
        if self.profile.read_only {
            return Err(DbErrorInfo::new(
                "query",
                format!("连接配置为只读，已拒绝 {op}"),
            ));
        }
        Ok(())
    }

    pub async fn status(&self, open_sessions: usize) -> ProfileRuntimeStatus {
        ProfileRuntimeStatus {
            profile_id: self.profile.id.clone(),
            generation: self.generation,
            connected: true,
            tunnel_active: self.tunnel.is_some(),
            tunnel_local_port: self.tunnel.as_ref().map(|lease| lease.local_port()),
            open_sessions,
            active_queries: 0,
            server_version: self.server_version.clone(),
        }
    }

    // -----------------------------------------------------------------
    // 读操作
    // -----------------------------------------------------------------

    /// SCAN 一页：cursor 续扫，`pattern` 支持 `user:*` 通配。
    pub async fn scan(
        &self,
        db: i64,
        pattern: &str,
        cursor: u64,
        count: usize,
    ) -> Result<RedisScanPage, DbErrorInfo> {
        let count = count.clamp(1, SCAN_PAGE_MAX);
        let mut conn = self.acquire(db).await?;
        let mut cmd = Cmd::new();
        cmd.arg("SCAN").arg(cursor);
        if !pattern.trim().is_empty() {
            cmd.arg("MATCH").arg(pattern.trim());
        }
        cmd.arg("COUNT").arg(count);
        // SCAN 返回 [下一页 cursor 的 bulk string, [key, ...]]。
        let raw: RedisValue = conn.query(&mut cmd).await.map_err(stage_err("scan"))?;
        let (next, keys) = parse_scan_reply(&raw)?;
        let keys = self.fill_briefs(db, keys).await?;
        let dbsize: i64 = conn.query(Cmd::new().arg("DBSIZE")).await.unwrap_or(0);
        Ok(RedisScanPage {
            cursor: next,
            keys,
            dbsize,
        })
    }

    /// 为键名批量补 type / pttl（pipeline：N 个键 2N 条命令一次性发）。
    async fn fill_briefs(
        &self,
        db: i64,
        keys: Vec<String>,
    ) -> Result<Vec<RedisKeyBrief>, DbErrorInfo> {
        let mut conn = self.acquire(db).await?;
        let mut pipe = redis::pipe();
        for key in &keys {
            pipe.cmd("TYPE").arg(key).cmd("PTTL").arg(key);
        }
        let replies: Vec<RedisValue> = match &mut conn {
            RedisConn::Single(single) => pipe.query_async(single).await,
            RedisConn::Cluster(cluster) => pipe.query_async(cluster.as_mut()).await,
        }
        .map_err(stage_err("scan"))?;
        let mut briefs = Vec::with_capacity(keys.len());
        for (index, key) in keys.into_iter().enumerate() {
            let kind =
                String::from_redis_value(&replies[index * 2]).unwrap_or_else(|_| "none".into());
            let ttl_ms = i64::from_redis_value(&replies[index * 2 + 1]).unwrap_or(-2);
            briefs.push(RedisKeyBrief {
                key,
                kind,
                ttl_ms,
            });
        }
        Ok(briefs)
    }

    /// 键元信息：type / pttl / memory usage。
    pub async fn key_info(&self, db: i64, key: &str) -> Result<RedisKeyInfo, DbErrorInfo> {
        let mut conn = self.acquire(db).await?;
        let kind: String = conn
            .query(Cmd::new().arg("TYPE").arg(key))
            .await
            .map_err(stage_err("key_info"))?;
        let ttl_ms: i64 = conn
            .query(Cmd::new().arg("PTTL").arg(key))
            .await
            .unwrap_or(-2);
        let mut usage = Cmd::new();
        usage.arg("MEMORY").arg("USAGE").arg(key);
        let memory_bytes: Option<i64> = conn.query(&mut usage).await.ok();
        Ok(RedisKeyInfo {
            key: key.to_string(),
            kind,
            ttl_ms,
            memory_bytes,
        })
    }

    /// 读取键值（按类型分支）。未知类型返回 `Other`，绝不假装能读。
    pub async fn read_value(&self, db: i64, key: &str) -> Result<RedisValuePayload, DbErrorInfo> {
        let mut conn = self.acquire(db).await?;
        let kind: String = conn
            .query(Cmd::new().arg("TYPE").arg(key))
            .await
            .map_err(stage_err("read"))?;
        match kind.as_str() {
            "string" => {
                let raw: RedisValue = conn
                    .query(Cmd::new().arg("GET").arg(key))
                    .await
                    .map_err(stage_err("read"))?;
                match raw {
                    RedisValue::Nil => Ok(RedisValuePayload::String {
                        value: String::new(),
                        binary: false,
                    }),
                    RedisValue::BulkString(bytes) => match String::from_utf8(bytes.clone()) {
                        Ok(value) => Ok(RedisValuePayload::String {
                            value,
                            binary: false,
                        }),
                        // 二进制值：Base64 编码传输，字节本体无损（前端写回时解码）。
                        Err(_) => Ok(RedisValuePayload::String {
                            value: BASE64_STANDARD.encode(&bytes),
                            binary: true,
                        }),
                    },
                    _ => Err(DbErrorInfo::new("read", "GET 返回了意外形状")),
                }
            }
            // hash 一律 HSCAN 分页：大 hash 绝不执行 HGETALL（O(N) 全量
            // 拉取会长时间阻塞连接与 UI）。cursor 交给前端续扫。
            "hash" => {
                let length: i64 = conn
                    .query(Cmd::new().arg("HLEN").arg(key))
                    .await
                    .map_err(stage_err("read"))?;
                let raw: RedisValue = conn
                    .query(&mut hscan_cmd(key, 0, HASH_PAGE_MAX))
                    .await
                    .map_err(stage_err("read"))?;
                let (cursor, fields) = parse_hash_scan_reply(&raw)?;
                Ok(RedisValuePayload::Hash {
                    fields,
                    length,
                    cursor,
                })
            }
            "list" => {
                let length: i64 = conn
                    .query(Cmd::new().arg("LLEN").arg(key))
                    .await
                    .map_err(stage_err("read"))?;
                let items: Vec<String> = conn
                    .query(Cmd::new().arg("LRANGE").arg(key).arg(0).arg(READ_ITEMS_MAX as i64 - 1))
                    .await
                    .map_err(stage_err("read"))?;
                let truncated = length as usize > READ_ITEMS_MAX;
                Ok(RedisValuePayload::List {
                    items,
                    length,
                    truncated,
                })
            }
            "set" => {
                let length: i64 = conn
                    .query(Cmd::new().arg("SCARD").arg(key))
                    .await
                    .map_err(stage_err("read"))?;
                let members: Vec<String> = conn
                    .query(Cmd::new().arg("SRANDMEMBER").arg(key).arg(READ_ITEMS_MAX as i64))
                    .await
                    .map_err(stage_err("read"))?;
                let truncated = length as usize > READ_ITEMS_MAX;
                Ok(RedisValuePayload::Set {
                    members,
                    length,
                    truncated,
                })
            }
            "zset" => {
                let length: i64 = conn
                    .query(Cmd::new().arg("ZCARD").arg(key))
                    .await
                    .map_err(stage_err("read"))?;
                let raw: Vec<(String, f64)> = conn
                    .query(Cmd::new().arg("ZRANGE").arg(key).arg(0).arg(READ_ITEMS_MAX as i64 - 1).arg("WITHSCORES"))
                    .await
                    .map_err(stage_err("read"))?;
                let truncated = length as usize > READ_ITEMS_MAX;
                Ok(RedisValuePayload::Zset {
                    entries: raw
                        .into_iter()
                        .map(|(member, score)| RedisZEntry { member, score })
                        .collect(),
                    length,
                    truncated,
                })
            }
            "stream" => {
                let length: i64 = conn
                    .query(Cmd::new().arg("XLEN").arg(key))
                    .await
                    .map_err(stage_err("read"))?;
                let raw: RedisValue = conn
                    .query(Cmd::new().arg("XRANGE").arg(key).arg("-").arg("+").arg("COUNT").arg(STREAM_READ_MAX))
                    .await
                    .map_err(stage_err("read"))?;
                Ok(RedisValuePayload::Stream {
                    entries: parse_stream_reply(&raw)?,
                    length,
                })
            }
            "none" => Err(DbErrorInfo::new("read", "键不存在或已过期")),
            other => Ok(RedisValuePayload::Other {
                type_name: other.to_string(),
            }),
        }
    }

    /// HSCAN 续扫一页：前端在 `Hash.cursor != 0` 时用它翻页。
    pub async fn hash_scan(
        &self,
        db: i64,
        key: &str,
        cursor: u64,
        count: usize,
    ) -> Result<RedisHashPage, DbErrorInfo> {
        let count = count.clamp(1, HASH_PAGE_MAX);
        let mut conn = self.acquire(db).await?;
        let length: i64 = conn
            .query(Cmd::new().arg("HLEN").arg(key))
            .await
            .map_err(stage_err("read"))?;
        let raw: RedisValue = conn
            .query(&mut hscan_cmd(key, cursor, count))
            .await
            .map_err(stage_err("read"))?;
        let (next, fields) = parse_hash_scan_reply(&raw)?;
        Ok(RedisHashPage {
            cursor: next,
            fields,
            length,
        })
    }

    // -----------------------------------------------------------------
    // 写操作（read_only 闸门 + 阶段化错误）
    // -----------------------------------------------------------------

    /// SET string 值；`binary = true` 时 `value` 是 Base64，先解码成字节
    /// 再写入（保证二进制数据无损往返）。
    pub async fn write_string(
        &self,
        db: i64,
        key: &str,
        value: &str,
        binary: bool,
    ) -> Result<(), DbErrorInfo> {
        self.ensure_writable("SET")?;
        let mut conn = self.acquire(db).await?;
        if binary {
            let bytes = BASE64_STANDARD
                .decode(value.trim())
                .map_err(|error| DbErrorInfo::new("write", format!("Base64 解码失败：{error}")))?;
            let _: () = conn
                .set(key, bytes)
                .await
                .map_err(stage_err("write"))?;
        } else {
            let _: () = conn
                .set(key, value)
                .await
                .map_err(stage_err("write"))?;
        }
        Ok(())
    }

    /// hash：写入/更新一个字段；`value = None` 删除字段。
    pub async fn write_hash_field(
        &self,
        db: i64,
        key: &str,
        field: &str,
        value: Option<&str>,
    ) -> Result<(), DbErrorInfo> {
        let op = if value.is_some() { "HSET" } else { "HDEL" };
        self.ensure_writable(op)?;
        let mut conn = self.acquire(db).await?;
        match value {
            Some(value) => {
                let _: i64 = conn
                    .hset(key, field, value)
                    .await
                    .map_err(stage_err("write"))?;
            }
            None => {
                let _: i64 = conn
                    .hdel(key, field)
                    .await
                    .map_err(stage_err("write"))?;
            }
        }
        Ok(())
    }

    /// list：头部/尾部插入；`index + value` 原位改写（LSET）；`None` 按值删除（LREM）。
    pub async fn write_list(
        &self,
        db: i64,
        key: &str,
        action: ListWrite,
    ) -> Result<(), DbErrorInfo> {
        let op = match action {
            ListWrite::Push { .. } => "LPUSH/RPUSH",
            ListWrite::Set { .. } => "LSET",
            ListWrite::Remove { .. } => "LREM",
        };
        self.ensure_writable(op)?;
        let mut conn = self.acquire(db).await?;
        match action {
            ListWrite::Push { front, value } => {
                let _: i64 = if front {
                    conn.lpush(key, value).await
                } else {
                    conn.rpush(key, value).await
                }
                .map_err(stage_err("write"))?;
            }
            ListWrite::Set { index, value } => {
                let _: () = conn
                    .lset(key, index as isize, value)
                    .await
                    .map_err(stage_err("write"))?;
            }
            ListWrite::Remove { value } => {
                let _: i64 = conn.lrem(key, 1, value).await.map_err(stage_err("write"))?;
            }
        }
        Ok(())
    }

    /// set：加入/移除成员。
    pub async fn write_set(
        &self,
        db: i64,
        key: &str,
        member: &str,
        add: bool,
    ) -> Result<(), DbErrorInfo> {
        self.ensure_writable(if add { "SADD" } else { "SREM" })?;
        let mut conn = self.acquire(db).await?;
        let _: i64 = if add {
            conn.sadd(key, member).await
        } else {
            conn.srem(key, member).await
        }
        .map_err(stage_err("write"))?;
        Ok(())
    }

    /// zset：新增/更新成员分数；`score = None` 移除成员。
    pub async fn write_zset(
        &self,
        db: i64,
        key: &str,
        member: &str,
        score: Option<f64>,
    ) -> Result<(), DbErrorInfo> {
        self.ensure_writable(if score.is_some() { "ZADD" } else { "ZREM" })?;
        let mut conn = self.acquire(db).await?;
        match score {
            Some(score) => {
                let _: i64 = conn
                    .zadd(key, member, score)
                    .await
                    .map_err(stage_err("write"))?;
            }
            None => {
                let _: i64 = conn.zrem(key, member).await.map_err(stage_err("write"))?;
            }
        }
        Ok(())
    }

    /// 新键的统一入口：string 类型 + 初始值（编辑器"新建键"）。
    pub async fn create_string_key(&self, db: i64, key: &str, value: &str) -> Result<(), DbErrorInfo> {
        self.ensure_writable("SET(新建键)")?;
        if key.trim().is_empty() {
            return Err(DbErrorInfo::new("config", "键名不能为空"));
        }
        self.write_string(db, key, value, false).await
    }

    /// 删除键。
    pub async fn delete_key(&self, db: i64, key: &str) -> Result<(), DbErrorInfo> {
        self.ensure_writable("DEL")?;
        let mut conn = self.acquire(db).await?;
        let _: i64 = conn.del(key).await.map_err(stage_err("write"))?;
        Ok(())
    }

    /// 设置 TTL；`ttl_ms = None` 表示 PERSIST（永久）。
    pub async fn expire_key(&self, db: i64, key: &str, ttl_ms: Option<i64>) -> Result<(), DbErrorInfo> {
        self.ensure_writable("EXPIRE/PERSIST")?;
        let mut conn = self.acquire(db).await?;
        match ttl_ms {
            Some(ms) => {
                let seconds = (ms / 1000).max(1);
                let _: i64 = conn
                    .expire(key, seconds)
                    .await
                    .map_err(stage_err("write"))?;
            }
            None => {
                let _: bool = conn.persist(key).await.map_err(stage_err("write"))?;
            }
        }
        Ok(())
    }

    /// 重命名键（RENAME：目标存在会被覆盖，前端要提示）。
    pub async fn rename_key(&self, db: i64, old: &str, new: &str) -> Result<(), DbErrorInfo> {
        self.ensure_writable("RENAME")?;
        if new.trim().is_empty() {
            return Err(DbErrorInfo::new("config", "新键名不能为空"));
        }
        let mut conn = self.acquire(db).await?;
        let _: () = conn.rename(old, new).await.map_err(stage_err("write"))?;
        Ok(())
    }

    /// PUBLISH，返回收到的订阅者数量。
    pub async fn publish(&self, db: i64, channel: &str, message: &str) -> Result<i64, DbErrorInfo> {
        self.ensure_writable("PUBLISH")?;
        let mut conn = self.acquire(db).await?;
        let receivers: i64 = conn
            .publish(channel, message)
            .await
            .map_err(stage_err("publish"))?;
        Ok(receivers)
    }
}

/// list 写操作的三种形态。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListWrite {
    Push { front: bool, value: String },
    Set { index: i64, value: String },
    Remove { value: String },
}

// ---------------------------------------------------------------------------
// pub/sub
// ---------------------------------------------------------------------------

/// 一个订阅任务：取消位 + 后台任务句柄。
pub struct PubSubTask {
    pub profile_id: String,
    pub channel: String,
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for PubSubTask {
    fn drop(&mut self) {
        // 发送失败 = 任务已经结束了，无所谓。
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
        self.handle.abort();
    }
}/// 运行时注册表：profile → 会话，sub_id → 订阅任务。
#[derive(Clone, Default)]
pub struct RedisManager {
    runtimes: Arc<Mutex<HashMap<String, Arc<RedisSession>>>>,
    pubsubs: Arc<Mutex<HashMap<String, PubSubTask>>>,
    /// 每个 profile 一把建连锁：并发首连只允许一次 `RedisSession::open`，
    /// 其余调用等锁后直接命中缓存，杜绝重复建连。
    open_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl RedisManager {
    /// 取得（或建立）一个 profile 的会话。并发首次连接只建一次。
    pub async fn runtime(
        &self,
        tunnels: &TunnelRegistry,
        plan: EndpointPlan,
    ) -> Result<Arc<RedisSession>, DbErrorInfo> {
        let profile_id = plan.profile.id.clone();
        // 单飞：同一 profile 的并发请求在这里串行化。
        let guard = {
            let mut locks = self.open_locks.lock().await;
            locks
                .entry(profile_id.clone())
                .or_default()
                .clone()
        };
        let _permit = guard.lock().await;
        if let Some(existing) = self.runtimes.lock().await.get(&profile_id).cloned() {
            return Ok(existing);
        }
        let session = RedisSession::open(tunnels, plan).await?;
        self.runtimes
            .lock()
            .await
            .insert(profile_id.clone(), session.clone());
        Ok(session)
    }

    pub async fn session(&self, profile_id: &str) -> Result<Arc<RedisSession>, DbErrorInfo> {
        self.runtimes
            .lock()
            .await
            .get(profile_id)
            .cloned()
            .ok_or_else(|| DbErrorInfo::new("config", "Redis 连接尚未建立或已断开"))
    }

    /// 只读测试：用**表单里的**配置建连 + PING + 立即丢弃（不留运行时）。
    pub async fn test_connection(
        &self,
        tunnels: &TunnelRegistry,
        plan: EndpointPlan,
    ) -> ConnectionTestResult {
        let started = std::time::Instant::now();
        let read_only = plan.profile.read_only;
        match RedisSession::open(tunnels, plan).await {
            Ok(session) => ConnectionTestResult {
                ok: true,
                stage: "ready".to_string(),
                error: None,
                latency_ms: started.elapsed().as_millis() as u64,
                server_version: session.server_version.clone(),
                connection_id: None,
                tls: None,
                tunnel_local_port: session.tunnel.as_ref().map(|lease| lease.local_port()),
                read_only,
            },
            Err(error) => ConnectionTestResult {
                ok: false,
                stage: error.stage.clone(),
                error: Some(error),
                latency_ms: started.elapsed().as_millis() as u64,
                server_version: None,
                connection_id: None,
                tls: None,
                tunnel_local_port: None,
                read_only,
            },
        }
    }

    /// 关闭 profile：会话 + 该 profile 的全部订阅。
    pub async fn close_profile(&self, profile_id: &str) {
        self.runtimes.lock().await.remove(profile_id);
        self.open_locks.lock().await.remove(profile_id);
        let mut pubsubs = self.pubsubs.lock().await;
        let ids: Vec<String> = pubsubs
            .iter()
            .filter(|(_, task)| task.profile_id == profile_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(task) = pubsubs.remove(&id) {
                drop(task); // Drop 会取消任务
            }
        }
    }

    pub async fn status(&self, profile_id: &str) -> ProfileRuntimeStatus {
        let session = self.runtimes.lock().await.get(profile_id).cloned();
        match session {
            Some(session) => session.status(0).await,
            None => ProfileRuntimeStatus {
                profile_id: profile_id.to_string(),
                generation: 0,
                connected: false,
                tunnel_active: false,
                tunnel_local_port: None,
                open_sessions: 0,
                active_queries: 0,
                server_version: None,
            },
        }
    }

    /// 订阅频道：后台长任务把消息经 Tauri Channel 推给前端。
    /// 返回 sub_id，用于 `unsubscribe`。
    pub async fn subscribe(
        &self,
        session: Arc<RedisSession>,
        db: i64,
        channel: String,
        sink: tauri::ipc::Channel<serde_json::Value>,
    ) -> Result<String, DbErrorInfo> {
        let mut pubsubs = self.pubsubs.lock().await;
        if pubsubs.len() >= PUBSUB_MAX {
            return Err(DbErrorInfo::new(
                "query",
                format!("订阅数已达上限（{PUBSUB_MAX}）：请先取消不需要的订阅"),
            ));
        }
        if pubsubs
            .values()
            .any(|task| task.profile_id == session.profile.id && task.channel == channel)
        {
            return Err(DbErrorInfo::new(
                "query",
                format!("频道 {channel} 已在订阅中"),
            ));
        }
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let sub_id = uuid::Uuid::new_v4().to_string();
        let profile_id = session.profile.id.clone();
        let profile_id_for_task = profile_id.clone();
        let channel_for_task = channel.clone();
        let sub_id_for_task = sub_id.clone();

        // cluster 模式的 pub/sub 需要按节点广播，MVP 不支持。
        // 订阅用**独立的物理连接**（同一连接上的订阅会污染普通命令流）。
        let pubsub = build_pubsub_connection(&session, db).await?;

        let handle = tokio::spawn(async move {
            run_pubsub_loop(
                pubsub,
                channel_for_task,
                sink,
                cancel_rx,
                sub_id_for_task,
                profile_id_for_task,
            )
            .await;
        });
        pubsubs.insert(
            sub_id.clone(),
            PubSubTask {
                profile_id,
                channel,
                cancel: Some(cancel_tx),
                handle,
            },
        );
        Ok(sub_id)
    }

    pub async fn unsubscribe(&self, sub_id: &str) {
        if let Some(task) = self.pubsubs.lock().await.remove(sub_id) {
            drop(task);
        }
    }
}

/// 为订阅建一条专用连接（standalone/sentinel；cluster 不支持，见上）。
async fn build_pubsub_connection(
    session: &RedisSession,
    db: i64,
) -> Result<redis::aio::PubSub, DbErrorInfo> {
    let (host, port) = session
        .connect_addr
        .clone()
        .ok_or_else(|| DbErrorInfo::new("query", "cluster 模式的订阅暂不支持：请改用 standalone/sentinel 连接"))?;
    if session.profile.tls_mode != TLS_DISABLED && session.tunnel.is_some() {
        return Err(DbErrorInfo::new(
            "config",
            "Redis 的 TLS 与 SSH 隧道暂不支持同时使用",
        ));
    }
    let info = connection_info(&host, port, db, &session.profile, session.password.clone())?;
    let client =
        redis::Client::open(info).map_err(|error| DbErrorInfo::new("query", format!("{error}")))?;
    let pubsub = tokio::time::timeout(
        Duration::from_millis(session.profile.connect_timeout_ms.max(1_000)),
        client.get_async_pubsub(),
    )
    .await
    .map_err(|_| DbErrorInfo::new("query", "订阅连接超时"))?
    .map_err(|error| DbErrorInfo::new("query", format!("订阅连接失败：{error}")))?;
    Ok(pubsub)
}

/// 订阅循环：PUSH 消息逐条经 Channel 推给前端，取消位触发时退出。
async fn run_pubsub_loop(
    mut pubsub: redis::aio::PubSub,
    channel: String,
    sink: tauri::ipc::Channel<serde_json::Value>,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
    sub_id: String,
    profile_id: String,
) {
    use futures_util::StreamExt;
    if let Err(error) = pubsub.subscribe(&channel).await {
        let _ = sink.send(serde_json::json!({
            "event": "error",
            "subId": sub_id,
            "message": format!("订阅失败：{error}"),
        }));
        return;
    }
    let _ = sink.send(serde_json::json!({
        "event": "subscribed",
        "subId": sub_id,
        "channel": channel,
    }));
    let mut stream = pubsub.on_message();
    loop {
        tokio::select! {
            _ = &mut cancel_rx => break,
            message = stream.next() => {
                match message {
                    Some(message) => {
                        // 消息字节一律 Base64 编码推送：不做有损 UTF-8 转换，
                        // 二进制消息原样到达，前端自行尝试解码显示。
                        let payload = BASE64_STANDARD.encode(message.get_payload_bytes());
                        let _ = sink.send(serde_json::json!({
                            "event": "message",
                            "subId": sub_id,
                            "profileId": profile_id,
                            "channel": message.get_channel_name(),
                            "messageBase64": payload,
                        }));
                    }
                    None => {
                        let _ = sink.send(serde_json::json!({
                            "event": "closed",
                            "subId": sub_id,
                            "message": "订阅连接已断开",
                        }));
                        break;
                    }
                }
            }
        }
    }
    let _ = sink.send(serde_json::json!({ "event": "unsubscribed", "subId": sub_id }));
}

// ---------------------------------------------------------------------------
// 解析与工具
// ---------------------------------------------------------------------------

fn stage_err(stage: &str) -> impl Fn(RedisError) -> DbErrorInfo + '_ {
    move |error| DbErrorInfo::new(stage, format!("{error}"))
}

/// SCAN 回复：[bulk(cursor), array(keys)]。
fn parse_scan_reply(raw: &RedisValue) -> Result<(u64, Vec<String>), DbErrorInfo> {
    let items = match raw {
        RedisValue::Array(items) if items.len() == 2 => items,
        _ => return Err(DbErrorInfo::new("scan", "SCAN 返回了意外形状")),
    };
    let cursor_bytes = match &items[0] {
        RedisValue::BulkString(bytes) => bytes.clone(),
        _ => return Err(DbErrorInfo::new("scan", "SCAN cursor 形状异常")),
    };
    let cursor = String::from_utf8_lossy(&cursor_bytes)
        .parse::<u64>()
        .map_err(|error| DbErrorInfo::new("scan", format!("cursor 解析失败：{error}")))?;
    let keys = Vec::<String>::from_redis_value(&items[1])
        .map_err(|error| DbErrorInfo::new("scan", format!("键列表解析失败：{error}")))?;
    Ok((cursor, keys))
}

/// HSCAN 命令：cursor 续扫 + COUNT 提示（服务端可能返回更多，解析时截断）。
fn hscan_cmd(key: &str, cursor: u64, count: usize) -> Cmd {
    let mut cmd = Cmd::new();
    cmd.arg("HSCAN").arg(key).arg(cursor).arg("COUNT").arg(count);
    cmd
}

/// HSCAN 回复：[bulk(cursor), [field, value, field, value, ...]]。
/// 超出 HASH_PAGE_MAX 的部分截断（COUNT 只是提示，不强制上限）。
fn parse_hash_scan_reply(raw: &RedisValue) -> Result<(u64, Vec<RedisFieldEntry>), DbErrorInfo> {
    let items = match raw {
        RedisValue::Array(items) if items.len() == 2 => items,
        _ => return Err(DbErrorInfo::new("read", "HSCAN 返回了意外形状")),
    };
    let cursor_bytes = match &items[0] {
        RedisValue::BulkString(bytes) => bytes.clone(),
        _ => return Err(DbErrorInfo::new("read", "HSCAN cursor 形状异常")),
    };
    let cursor = String::from_utf8_lossy(&cursor_bytes)
        .parse::<u64>()
        .map_err(|error| DbErrorInfo::new("read", format!("cursor 解析失败：{error}")))?;
    let flat = match &items[1] {
        RedisValue::Array(flat) => flat,
        RedisValue::Nil => return Ok((cursor, Vec::new())),
        _ => return Err(DbErrorInfo::new("read", "HSCAN 字段列表形状异常")),
    };
    let mut fields = Vec::with_capacity(flat.len() / 2);
    for chunk in flat.chunks(2) {
        let field = String::from_redis_value(&chunk[0]).unwrap_or_default();
        let entry = chunk
            .get(1)
            .and_then(|value| match value {
                RedisValue::BulkString(bytes) => {
                    Some(RedisFieldEntry::from_bytes(field.clone(), bytes))
                }
                _ => String::from_redis_value(value)
                    .ok()
                    .map(|text| RedisFieldEntry { field: field.clone(), value: text }),
            })
            .unwrap_or(RedisFieldEntry { field, value: String::new() });
        fields.push(entry);
    }
    fields.truncate(HASH_PAGE_MAX);
    Ok((cursor, fields))
}

/// XRANGE 回复：[[id, [field, value, ...]], ...]。
fn parse_stream_reply(raw: &RedisValue) -> Result<Vec<RedisStreamEntry>, DbErrorInfo> {
    let items = match raw {
        RedisValue::Array(items) => items,
        RedisValue::Nil => return Ok(Vec::new()),
        _ => return Err(DbErrorInfo::new("read", "XRANGE 返回了意外形状")),
    };
    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        let pair = match item {
            RedisValue::Array(pair) if pair.len() == 2 => pair,
            _ => continue,
        };
        let id = String::from_redis_value(&pair[0]).unwrap_or_default();
        let mut fields = Vec::new();
        if let RedisValue::Array(flat) = &pair[1] {
            for chunk in flat.chunks(2) {
                let field = String::from_redis_value(&chunk[0]).unwrap_or_default();
                let entry = chunk
                    .get(1)
                    .and_then(|value| match value {
                        RedisValue::BulkString(bytes) => Some(RedisFieldEntry::from_bytes(
                            field.clone(),
                            bytes,
                        )),
                        _ => String::from_redis_value(value)
                            .ok()
                            .map(|text| RedisFieldEntry { field: field.clone(), value: text }),
                    })
                    .unwrap_or(RedisFieldEntry { field, value: String::new() });
                fields.push(entry);
            }
        }
        entries.push(RedisStreamEntry { id, fields });
    }
    Ok(entries)
}

fn node_url(host: &str, port: u16, profile: &DatabaseProfile, password: Option<String>) -> String {
    let scheme = if profile.tls_mode == TLS_DISABLED {
        "redis"
    } else {
        "rediss"
    };
    let auth = match (profile.username.trim(), password.as_deref()) {
        (user, Some(pass)) if !user.is_empty() => {
            format!("{}:{}@", uri_encode(user), uri_encode(pass))
        }
        (_, Some(pass)) => format!(":{}@", uri_encode(pass)),
        _ => String::new(),
    };
    format!("{scheme}://{auth}{host}:{port}")
}

fn uri_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn connection_info(
    host: &str,
    port: u16,
    db: i64,
    profile: &DatabaseProfile,
    password: Option<String>,
) -> Result<redis::ConnectionInfo, DbErrorInfo> {
    use redis::{ConnectionAddr, ConnectionInfo, ProtocolVersion, RedisConnectionInfo};

    let addr = if profile.tls_mode == TLS_DISABLED {
        ConnectionAddr::Tcp(host.to_string(), port)
    } else {
        if profile.tls_ca_path.is_some() {
            return Err(DbErrorInfo::new(
                "config",
                "Redis 的 TLS 暂不支持自定义 CA 证书文件：请清空 CA 路径（使用系统信任库），或改用 MySQL 引擎",
            ));
        }
        // verify_ca / verify_identity 统一映射为"校验证书链"；redis-rs 的
        // rustls 后端没有关闭校验的入口，因此这里也没有不安全开关。
        // tls_params = None：使用 rustls 默认配置（系统信任库，不支持自定义 CA）。
        ConnectionAddr::TcpTls {
            host: host.to_string(),
            port,
            insecure: false,
            tls_params: None,
        }
    };

    let username = profile
        .username
        .trim()
        .is_empty()
        .then(|| None)
        .unwrap_or_else(|| Some(profile.username.trim().to_string()));

    Ok(ConnectionInfo {
        addr,
        redis: RedisConnectionInfo {
            db,
            username,
            password,
            protocol: ProtocolVersion::RESP2,
            ..Default::default()
        },
    })
}

async fn connect_manager(
    info: redis::ConnectionInfo,
    timeout: Duration,
    stage: &str,
) -> Result<ConnectionManager, DbErrorInfo> {
    let client =
        redis::Client::open(info).map_err(|error| DbErrorInfo::new(stage, format!("{error}")))?;
    tokio::time::timeout(timeout, client.get_connection_manager())
        .await
        .map_err(|_| DbErrorInfo::new(stage, "连接超时"))?
        .map_err(|error| DbErrorInfo::new(stage, format!("{error}")))
}

/// 逐个哨兵节点 `SENTINEL get-master-addr-by-name`，返回 master 地址。
async fn discover_master_via_sentinel(
    nodes: &[(String, u16)],
    master: &str,
    username: &str,
    password: Option<String>,
    timeout: Duration,
) -> Result<(String, u16), DbErrorInfo> {
    if nodes.is_empty() {
        return Err(DbErrorInfo::new("config", "没有可用的哨兵节点"));
    }
    let mut last_error = String::new();
    for (host, port) in nodes {
        let info = redis::ConnectionInfo {
            addr: redis::ConnectionAddr::Tcp(host.clone(), *port),
            redis: redis::RedisConnectionInfo {
                username: username
                    .is_empty()
                    .then(|| None)
                    .unwrap_or_else(|| Some(username.to_string())),
                password: password.clone(),
                ..Default::default()
            },
        };
        let client = match redis::Client::open(info) {
            Ok(client) => client,
            Err(error) => {
                last_error = format!("{host}:{port}: {error}");
                continue;
            }
        };
        let query = async {
            let mut conn = client.get_multiplexed_async_connection().await?;
            let reply: RedisValue = redis::cmd("SENTINEL")
                .arg("get-master-addr-by-name")
                .arg(master)
                .query_async(&mut conn)
                .await?;
            Ok::<_, RedisError>(reply)
        };
        match tokio::time::timeout(timeout, query).await {
            Ok(Ok(RedisValue::Array(items))) if items.len() == 2 => {
                let ip = String::from_redis_value(&items[0]).unwrap_or_default();
                let port = i64::from_redis_value(&items[1]).unwrap_or(6379) as u16;
                if !ip.is_empty() {
                    return Ok((ip, port));
                }
                last_error = format!("{host}:{port}: 哨兵返回了空地址");
            }
            Ok(Ok(_)) => last_error = format!("{host}:{port}: master 不存在或哨兵返回异常"),
            Ok(Err(error)) => last_error = format!("{host}:{port}: {error}"),
            Err(_) => last_error = format!("{host}:{port}: 连接超时"),
        }
    }
    Err(DbErrorInfo::new(
        "connect",
        format!("所有哨兵节点都未能解析 master「{master}」：{last_error}"),
    ))
}

async fn redis_version(conn: &mut RedisConn) -> Option<String> {
    let mut info_cmd = Cmd::new();
    info_cmd.arg("INFO").arg("server");
    let raw: Option<String> = conn.query(&mut info_cmd).await.ok();
    raw.and_then(|text| {
        text.lines()
            .find_map(|line| line.strip_prefix("redis_version:"))
            .map(|version| version.trim().to_string())
    })
}
