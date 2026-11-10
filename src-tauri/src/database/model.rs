//! 数据库工作台的领域模型与 IPC 协议。
//!
//! 三条硬约束（贯穿整个 `database` 模块）：
//!
//! 1. **数字不经过 JSON number**：`BIGINT UNSIGNED` 超过 2^53 后 JS 的
//!    `Number` 会静默丢精度。所有整数、DECIMAL 一律以字符串 + 是否无符号
//!    的标记传输，前端只做展示，不回算。
//! 2. **NULL 不是 `"NULL"`，也不是空串**：`DbValue::Null` 是独立变体，
//!    空字符串是 `Text { value: "" }`，两者在表格、复制、导出里都可区分。
//! 3. **列只按序号对齐**：`SELECT a.id, b.id` 有两个同名 `id`。行是
//!    `Vec<DbValue>`、列是 `Vec<DbColumn>` 且带 `index`，任何地方都不把
//!    列名当对象键。
//!
//! 另外，`unsupported` 变体是给"驱动不认识的列类型"用的：宁可显示
//! "几何类型 · 受限预览"，也不静默丢字段。

use serde::{Deserialize, Serialize};

use super::protocol::{ConnectionIdentity, TransactionState};

pub const ENGINE_MYSQL: &str = "mysql";
/// PostgreSQL 只在模型层留位：连接表单会明确标注"尚未实现"，
/// 后端拒绝连接，绝不返回假成功。
pub const ENGINE_POSTGRES: &str = "postgres";
/// Redis：独立于 SQL 管线的键值引擎（键浏览器视图，不走 session/query）。
pub const ENGINE_REDIS: &str = "redis";

/// Redis 连接模式。
pub const REDIS_MODE_STANDALONE: &str = "standalone";
pub const REDIS_MODE_SENTINEL: &str = "sentinel";
pub const REDIS_MODE_CLUSTER: &str = "cluster";
pub const DEFAULT_REDIS_PORT: u16 = 6379;

/// TLS 模式。**没有** `preferred`（自动降级）：一旦选择 TLS 就必须成功，
/// 连不上就报 TLS 错误，而不是悄悄退回明文。
pub const TLS_DISABLED: &str = "disabled";
/// 校验证书链，但允许证书 SAN 与连接地址不同（SQL 隧道 + 私网 IP 的常见情况）。
pub const TLS_VERIFY_CA: &str = "verify_ca";
/// 校验证书链 + 主机名/`tls_server_name`。
pub const TLS_VERIFY_IDENTITY: &str = "verify_identity";

pub const DEFAULT_MYSQL_PORT: u16 = 3306;
pub const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 10_000;
pub const DEFAULT_QUERY_TIMEOUT_MS: u64 = 60_000;

/// 引擎专属配置。存在 `database_profiles.engine_options`（JSON 文本）。
///
/// 为什么不给每个引擎加一组列：SQLite 要文件路径、PostgreSQL 要 schema、
/// Oracle 要 service/SID、MongoDB 要 URI 与认证库 —— 列会无限膨胀，而且
/// 每种引擎只用到其中一两列，其余全是 NULL。
///
/// `extra` 保留未知键**只用于**把它读出来报错：保存时按引擎白名单校验，
/// 发现未知键直接拒绝，避免"配置写进去了但没人读"的静默丢失。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EngineOptions {
    /// SQLite 数据库文件路径。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// PostgreSQL / Oracle 的 schema。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// Oracle：`service` 或 `sid`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    /// MongoDB 连接 URI（可替代 host/port）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// MongoDB 认证库。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_source: Option<String>,
    /// ClickHouse 接口：`http` | `native`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// ClickHouse / MongoDB：是否启用 TLS。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    #[serde(flatten, default)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

impl EngineOptions {
    pub fn path(&self) -> Option<&str> {
        trim_opt(&self.path)
    }

    pub fn schema(&self) -> Option<&str> {
        trim_opt(&self.schema)
    }

    pub fn uri(&self) -> Option<&str> {
        trim_opt(&self.uri)
    }

    pub fn identifier(&self) -> Option<&str> {
        trim_opt(&self.identifier)
    }

    pub fn protocol(&self) -> Option<&str> {
        trim_opt(&self.protocol)
    }

    pub fn auth_source(&self) -> Option<&str> {
        trim_opt(&self.auth_source)
    }

    pub fn has_any(&self) -> bool {
        self.path().is_some()
            || self.schema().is_some()
            || self.identifier().is_some()
            || self.uri().is_some()
            || self.auth_source().is_some()
            || self.protocol().is_some()
            || self.secure.is_some()
            || !self.extra.is_empty()
    }
}

fn trim_opt(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// 展示预算（可被设置覆盖，但有硬上限）。
///
/// **1,000 行太小**：查 4,000 行会在第 1,000 行触发截断，后端随后 KILL 查询、
/// 连接带未读结果无法复用而被丢弃 —— 用户看到的是"结果只有 1000 行 + 会话连接
/// 已关闭"。10,000 行 / 32 MiB 覆盖绝大多数手工查询，超过这个量级本就该导出。
pub const DEFAULT_MAX_ROWS: u64 = 10_000;
pub const DEFAULT_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// 单批目标行数 / 字节数。
pub const DEFAULT_BATCH_ROWS: usize = 200;
pub const DEFAULT_BATCH_BYTES: usize = 256 * 1024;
/// 单字段预览上限：超过就截断并标记，详情需要单独取（见 `db_read_cell`）。
pub const DEFAULT_FIELD_PREVIEW_BYTES: usize = 64 * 1024;
/// 硬上限：即使前端传了更大的值也不会超过这些。
pub const HARD_MAX_ROWS: u64 = 50_000;
pub const HARD_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const HARD_FIELD_PREVIEW_BYTES: usize = 1024 * 1024;

/// 一条数据库连接配置（SQLite 行 + 是否已存密码）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseProfile {
    pub id: String,
    pub name: String,
    /// 引擎标识。清单与字段要求见 `engine_registry`。
    pub engine: String,
    /// 网络端点。**文件型引擎（SQLite）不使用**：保存时会被归一化为空串/0。
    pub host: String,
    pub port: u16,
    pub username: String,
    pub default_database: Option<String>,
    /// 密码是否已存在系统钥匙串。**密码本身永远不回传前端。**
    pub has_password: bool,
    /// 通过已保存的 SSH 服务器做隧道；`None` = 直连。
    pub ssh_server_id: Option<String>,
    /// `disabled` | `verify_ca` | `verify_identity`
    pub tls_mode: String,
    pub tls_ca_path: Option<String>,
    /// SSH 隧道时用于证书校验的名字；为空则用 `host`。
    pub tls_server_name: Option<String>,
    /// 服务端只读：连接后执行 `SET SESSION TRANSACTION READ ONLY`。
    pub read_only: bool,
    /// Redis 专用：`standalone` | `sentinel` | `cluster`。MySQL 为 `None`。
    pub redis_mode: Option<String>,
    /// Redis sentinel 模式的 master 名。其余模式为 `None`。
    pub sentinel_master: Option<String>,
    /// Redis sentinel/cluster 的额外节点列表，JSON 数组 `["host:port", …]`。
    pub nodes_json: Option<String>,
    /// 引擎专属配置（SQLite 路径 / PG schema / Oracle service-SID / Mongo URI …）。
    #[serde(default)]
    pub engine_options: EngineOptions,
    pub connect_timeout_ms: u64,
    pub query_timeout_ms: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 保存请求：`password` 为 `None` 表示保留原密码，`Some("")` 表示清除。
#[derive(Debug, Clone, Deserialize)]
pub struct SaveProfileRequest {
    pub profile: DatabaseProfile,
    pub password: Option<String>,
}

/// "测试连接"载荷：配置可能还没保存，密码可以由表单临时提供。
#[derive(Debug, Clone, Deserialize)]
pub struct TestConnectionRequest {
    pub profile: DatabaseProfile,
    /// `None` = 用已保存的钥匙串密码；`Some` = 用这次表单里输入的值。
    pub password: Option<String>,
}

/// 结构化错误。`stage` 是用户在 UI 上看到的"哪一步失败"。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DbErrorInfo {
    /// `config` | `ssh_tunnel` | `tcp` | `tls` | `auth` | `database` |
    /// `query` | `permission` | `cancelled` | `timeout` | `outcome_unknown` |
    /// `unsupported` | `budget`
    pub stage: String,
    /// MySQL 服务器错误码（如 1045 / 1317 / 1792）。
    pub code: Option<u32>,
    pub sql_state: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    /// 仅表示"同一个操作再做一次可能成功"（如网络错误），
    /// 写操作**永远**是 false：禁止自动重试。
    pub retryable: bool,
}

impl DbErrorInfo {
    pub fn new(stage: &str, message: impl Into<String>) -> Self {
        Self {
            stage: stage.to_string(),
            code: None,
            sql_state: None,
            message: message.into(),
            detail: None,
            retryable: false,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}

impl std::fmt::Display for DbErrorInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.stage, self.message)
    }
}

/// 一个连接会话（一个 SQL 编辑器标签页 = 一个逻辑会话）。
#[derive(Debug, Clone, Serialize)]
pub struct DbSessionInfo {
    /// 会话可能已 lost，即使所属运行时/连接池仍然存在。
    pub state: String,
    pub session_id: String,
    pub profile_id: String,
    /// 每次 `db_session_open` / 重连自增：旧响应带旧代次，前端必须丢弃。
    pub generation: u64,
    /// 物理连接身份。**不是** u32 thread id：只有 MySQL 协议才有那个概念。
    pub connection: ConnectionIdentity,
    pub server_version: Option<String>,
    pub current_database: Option<String>,
    pub tls_active: bool,
    pub tls_cipher: Option<String>,
    pub tls_version: Option<String>,
    /// 事务状态以驱动读到的真实状态为准（不是 SQL 前缀）。
    pub transaction: TransactionState,
    pub read_only: bool,
    pub opened_at: i64,
}

// ---------------------------------------------------------------------------
// 结果值
// ---------------------------------------------------------------------------

/// 一个单元格。所有变体都是可解释的：没有"空字符串代替 NULL"。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DbValue {
    Null,
    /// 有符号/无符号整数一律字符串，避免 JS 精度丢失。
    Int {
        value: String,
        unsigned: bool,
    },
    /// DECIMAL 精确字符串，绝不转 f64。
    Decimal {
        value: String,
    },
    Float {
        value: f64,
    },
    /// 文本（VARCHAR/TEXT/ENUM/SET…）。`truncated` 表示预览被截断。
    Text {
        value: String,
        bytes: usize,
        truncated: bool,
    },
    Json {
        value: String,
        bytes: usize,
        truncated: bool,
    },
    /// `DATE`（无时区）。
    Date {
        value: String,
    },
    /// `DATETIME` / `TIMESTAMP`：原样展示服务器给出的字面值，不做时区换算。
    DateTime {
        value: String,
        timezone: String,
    },
    /// `TIME`，可能超过 24 小时。
    Time {
        value: String,
    },
    Binary {
        /// base64（IPC 是 JSON）。
        base64: String,
        bytes: usize,
        truncated: bool,
    },
    /// BIT(n)：按位串展示，同时给十进制。
    Bit {
        bits: String,
        value: String,
    },
    /// 驱动无法安全解码的类型：绝不丢列，给出类型名与受限预览。
    Unsupported {
        type_name: String,
        preview: String,
        bytes: usize,
    },
}

/// 列元数据。`index` 是行内下标，重复列名靠它区分。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DbColumn {
    #[serde(default)]
    pub origin_database: Option<String>,
    pub index: usize,
    pub name: String,
    pub org_name: String,
    pub table: String,
    pub org_table: String,
    pub type_name: String,
    pub type_code: u16,
    pub nullable: bool,
    pub unsigned: bool,
    pub binary: bool,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub decimals: u8,
    pub charset: u16,
}

/// 一个批次。`ResultSet` 只发一次（列元数据），之后是 `Rows`。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DbBatch {
    ResultSet {
        result_set_id: String,
        /// 在整条 SQL 里的结果集序号（从 0 开始）。
        index: u32,
        columns: Vec<DbColumn>,
        /// 语句文本（供多结果集面板显示），截断到合理长度。
        statement: String,
    },
    Rows {
        result_set_id: String,
        /// 该结果集内的批次序号（从 0 开始）。
        sequence: u64,
        rows: Vec<Vec<DbValue>>,
        /// 本批序列化后的近似字节数。
        bytes: usize,
    },
    ResultSetEnd {
        result_set_id: String,
        affected_rows: u64,
        last_insert_id: Option<String>,
        warnings: u16,
        info: String,
        rows: u64,
        bytes: usize,
        elapsed_ms: u64,
    },
    /// 语句级错误：后续结果集仍然会继续发（MySQL 的脚本语义）。
    Error { error: DbErrorInfo },
    /// 任务终态。`state` 与 `query_state` 一致。
    Finished {
        state: String,
        elapsed_ms: u64,
        rows: u64,
        bytes: usize,
        truncated: bool,
        truncation_reason: Option<String>,
    },
}

/// 任务状态。`outcome_unknown` 是**必须存在**的状态：
/// 写操作在 COMMIT/断网期间失败时，服务器可能已提交，不能假装失败。
pub const STATE_QUEUED: &str = "queued";
pub const STATE_RUNNING: &str = "running";
pub const STATE_STREAMING: &str = "streaming";
pub const STATE_CANCELLING: &str = "cancelling";
pub const STATE_COMPLETED: &str = "completed";
pub const STATE_CANCELLED: &str = "cancelled";
pub const STATE_FAILED: &str = "failed";
pub const STATE_OUTCOME_UNKNOWN: &str = "outcome_unknown";

/// 拉取一批结果。`batch = None` 且 `state` 是终态表示没有更多数据。
#[derive(Debug, Clone, Serialize)]
pub struct QueryBatchResponse {
    pub batch: Option<DbBatch>,
    pub state: String,
    pub query_id: String,
    pub generation: u64,
    /// 当前在途（已生产未消费）的批次数与字节数，用于前端显示背压。
    pub in_flight: usize,
    pub in_flight_bytes: usize,
}

/// 查询预算。前端可以调小，但后端会夹到硬上限。
#[derive(Debug, Clone, Deserialize)]
pub struct QueryBudget {
    pub max_rows: Option<u64>,
    pub max_bytes: Option<u64>,
    pub batch_rows: Option<usize>,
    pub batch_bytes: Option<usize>,
    pub field_preview_bytes: Option<usize>,
}

impl Default for QueryBudget {
    fn default() -> Self {
        Self {
            max_rows: None,
            max_bytes: None,
            batch_rows: None,
            batch_bytes: None,
            field_preview_bytes: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedBudget {
    pub max_rows: u64,
    pub max_bytes: u64,
    pub batch_rows: usize,
    pub batch_bytes: usize,
    pub field_preview_bytes: usize,
}

impl ResolvedBudget {
    pub fn resolve(budget: Option<&QueryBudget>) -> Self {
        let max_rows = budget
            .and_then(|b| b.max_rows)
            .unwrap_or(DEFAULT_MAX_ROWS)
            .clamp(1, HARD_MAX_ROWS);
        let max_bytes = budget
            .and_then(|b| b.max_bytes)
            .unwrap_or(DEFAULT_MAX_BYTES)
            .clamp(64 * 1024, HARD_MAX_BYTES);
        let batch_rows = budget
            .and_then(|b| b.batch_rows)
            .unwrap_or(DEFAULT_BATCH_ROWS)
            .clamp(1, 2_000);
        let batch_bytes = budget
            .and_then(|b| b.batch_bytes)
            .unwrap_or(DEFAULT_BATCH_BYTES)
            .clamp(16 * 1024, 4 * 1024 * 1024);
        let field_preview_bytes = budget
            .and_then(|b| b.field_preview_bytes)
            .unwrap_or(DEFAULT_FIELD_PREVIEW_BYTES)
            .clamp(1_024, HARD_FIELD_PREVIEW_BYTES);
        Self {
            max_rows,
            max_bytes,
            batch_rows,
            batch_bytes,
            field_preview_bytes,
        }
    }
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DbDatabase {
    pub name: String,
    /// `information_schema` / `mysql` / `sys` / `performance_schema`
    pub system: bool,
    pub charset: Option<String>,
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DbTable {
    pub name: String,
    /// `table` | `view`
    pub kind: String,
    pub engine: Option<String>,
    /// `information_schema.TABLES.TABLE_ROWS`：**估算值**，与精确 COUNT 区分。
    pub estimated_rows: Option<u64>,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DbTableColumn {
    pub name: String,
    pub ordinal: u32,
    pub data_type: String,
    pub column_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    /// `Some("CURRENT_TIMESTAMP")` 之类的表达式默认值。
    pub default_expression: Option<String>,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub unsigned: bool,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DbIndexColumn {
    pub name: String,
    pub seq: u32,
    /// 前缀长度；`None` = 整列。
    pub sub_part: Option<u64>,
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DbIndex {
    pub name: String,
    pub unique: bool,
    pub primary: bool,
    pub kind: String,
    pub columns: Vec<DbIndexColumn>,
}

/// 表的完整结构（打开"表结构"时才查，不在展开树时读）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbTableDetail {
    pub database: String,
    pub table: String,
    pub kind: String,
    pub engine: Option<String>,
    pub collation: Option<String>,
    pub estimated_rows: Option<u64>,
    pub comment: String,
    pub create_sql: Option<String>,
    pub columns: Vec<DbTableColumn>,
    pub indexes: Vec<DbIndex>,
    pub primary_key: Vec<String>,
    /// 有主键/唯一非空键才能做 keyset 分页与安全修改。
    pub reliable_key: Option<Vec<String>>,
}

/// 元数据缓存条目的来源：显式失效由 `db_metadata_invalidate` 触发。
#[derive(Debug, Clone, Serialize)]
pub struct MetadataCacheStatus {
    pub profile_id: String,
    pub entries: usize,
    pub last_invalidated_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// 表数据浏览
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct BrowseFilter {
    /// 列名（必须来自验证后的元数据）。
    pub column: String,
    /// `eq` | `ne` | `contains` | `starts_with` | `gt` | `gte` | `lt` | `lte` | `is_null` | `not_null`
    pub op: String,
    /// 值；`is_null` / `not_null` 忽略。
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BrowseSort {
    pub column: String,
    /// `asc` | `desc`
    pub direction: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BrowseRequest {
    pub session_id: String,
    pub database: String,
    pub table: String,
    pub page_size: Option<u32>,
    pub offset: Option<u64>,
    /// keyset 游标：上一页最后一行的键值（JSON 字符串数组，按 `key_columns` 顺序）。
    pub after: Option<Vec<Option<String>>>,
    pub sorts: Option<Vec<BrowseSort>>,
    pub filters: Option<Vec<BrowseFilter>>,
    /// `auto` | `keyset` | `offset`
    pub pagination: Option<String>,
    /// 精确 COUNT：显式请求才做，默认用估算值。
    pub exact_count: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowseResult {
    pub columns: Vec<DbColumn>,
    pub rows: Vec<Vec<DbValue>>,
    pub page_size: u32,
    pub offset: u64,
    /// `keyset` | `offset`
    pub pagination: String,
    pub key_columns: Vec<String>,
    /// 下一页游标（keyset 时是最后一行键值）。
    pub next_cursor: Option<Vec<Option<String>>>,
    pub has_more: bool,
    /// 估算行数（`information_schema`），不是精确值。
    pub estimated_rows: Option<u64>,
    /// 只有 `exact_count=true` 才有；`None` 表示没有执行 COUNT(*)。
    pub exact_rows: Option<u64>,
    pub has_reliable_key: bool,
    pub truncated: bool,
    pub warning: Option<String>,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// 数据修改
// ---------------------------------------------------------------------------

/// 写入一个列时三态：NULL / DEFAULT / 具体值。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssignValue {
    Null,
    Default,
    Value { value: String },
}

#[derive(Debug, Clone, Deserialize)]
pub struct RowMutation {
    /// `insert` | `update` | `delete`
    pub kind: String,
    /// 定位行用的键值（按 `key_columns` 顺序）。insert 忽略。
    pub key: Option<Vec<AssignValue>>,
    /// update/insert 的赋值：列名 → 三态值。
    pub values: Vec<ColumnAssignment>,
    /// 乐观并发的期望值（update/delete）：列名 → 读取时的值。
    /// NULL 用 `AssignValue::Null`，与空串区分。
    pub expected: Option<Vec<ColumnAssignment>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ColumnAssignment {
    pub column: String,
    pub value: AssignValue,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MutationRequest {
    pub session_id: String,
    pub database: String,
    pub table: String,
    pub rows: Vec<RowMutation>,
    /// 显式确认"这张表不是事务表，无法回滚"。默认拒绝。
    pub allow_non_transactional: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MutationRowOutcome {
    pub index: usize,
    pub kind: String,
    pub affected_rows: u64,
    /// `applied` | `conflict` | `failed`
    pub status: String,
    pub error: Option<DbErrorInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MutationResult {
    /// `committed` | `rolled_back` | `outcome_unknown`
    pub state: String,
    pub outcomes: Vec<MutationRowOutcome>,
    pub committed_rows: u64,
    pub elapsed_ms: u64,
    /// 事务表？DDL / 非事务表的回滚不可信，这里如实写出来。
    pub transactional: bool,
    pub warning: Option<String>,
    /// 结果未知时的重新核对指令（前端展示，不自动执行）。
    pub verify_hint: Option<String>,
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    #[default]
    Csv,
    Tsv,
    Json,
    Jsonl,
    Sql,
    Html,
    Xml,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Tsv => "tsv",
            Self::Json => "json",
            Self::Jsonl => "jsonl",
            Self::Sql => "sql",
            Self::Html => "html",
            Self::Xml => "xml",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportRequest {
    #[serde(default)]
    pub format: ExportFormat,
    pub profile_id: String,
    /// 重新执行的 SQL（必须是只读语句）。表达式导出永远重新查询：
    /// 我们**不**把前端缓存的结果再传回 Rust 假装它是完整数据。
    pub sql: String,
    /// 运行 SQL 前切换到的库。
    pub database: Option<String>,
    pub target_path: String,
    /// `auto` = 有主键时 keyset，否则 offset；仅对 `db_export_table` 生效。
    pub pagination: Option<String>,
    pub page_size: Option<u32>,
    pub sorts: Option<Vec<BrowseSort>>,
    pub filters: Option<Vec<BrowseFilter>>,
    /// 表导出：与 `sql` 二选一。
    pub table: Option<ExportTableTarget>,
    /// 是否写 UTF-8 BOM（Excel 打开中文 CSV 需要）。
    pub bom: Option<bool>,
    /// 上限：0 = 不限制行数（仍有磁盘剩余空间与取消保护）。
    pub max_rows: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportTableTarget {
    pub database: String,
    pub table: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportStarted {
    pub export_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportProgress {
    pub export_id: String,
    pub rows: u64,
    pub bytes: u64,
    /// `running` | `cancelling` | `completed` | `cancelled` | `failed`
    pub state: String,
    pub message: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportOutcome {
    pub export_id: String,
    pub state: String,
    pub path: Option<String>,
    pub rows: u64,
    pub bytes: u64,
    pub error: Option<DbErrorInfo>,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// 连接测试 / 服务器信息
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct TlsStatus {
    pub active: bool,
    pub cipher: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionTestResult {
    pub ok: bool,
    /// 成功时的阶段：`ssh_tunnel` / `tcp` / `tls` / `auth` / `database` / `ready`
    pub stage: String,
    pub error: Option<DbErrorInfo>,
    pub latency_ms: u64,
    pub server_version: Option<String>,
    /// 建连后的连接身份（`#42`）；驱动没有数值 id 时为 `None` 或具名标签。
    pub connection: Option<ConnectionIdentity>,
    pub tls: Option<TlsStatus>,
    /// 隧道本地端口（仅诊断用；不会暴露远程网络）。
    pub tunnel_local_port: Option<u16>,
    /// 用户配置只读时，服务器实际接受的模式（`SET SESSION TRANSACTION READ ONLY`）。
    pub read_only: bool,
}

/// 一个连接运行时的实时状态（UI 顶部状态条）。
#[derive(Debug, Clone, Serialize)]
pub struct ProfileRuntimeStatus {
    pub profile_id: String,
    pub generation: u64,
    pub connected: bool,
    pub tunnel_active: bool,
    pub tunnel_local_port: Option<u16>,
    pub open_sessions: usize,
    pub active_queries: usize,
    pub server_version: Option<String>,
}
