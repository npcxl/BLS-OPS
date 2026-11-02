//! 引擎能力描述：把"能连上"和"能做什么"分开说清楚。
//!
//! 三条规则：
//!
//! 1. **三态，不是布尔**：`Supported` / `Limited{reason}` / `Unsupported{reason}`。
//!    "受限"必须带原因，界面直接显示这句原因，而不是给一个沉默的禁用按钮。
//! 2. **默认保守**：没有验证过的能力不能写 `Supported`。宁可让用户看到
//!    "取消：受限（服务端不支持 KILL）"，也不能让他点了取消以为生效。
//! 3. **这是唯一事实来源**：前端不再自己维护 `supported` 布尔，而是读
//!    `db_engines_catalog` 返回的同一份结构。

use serde::Serialize;

/// 单项能力。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Capability {
    Supported,
    /// 能用，但有明确边界（例如只能靠关闭连接取消、DDL 只支持部分形态）。
    Limited {
        reason: String,
    },
    /// 不能用，原因是给用户看的。
    Unsupported {
        reason: String,
    },
}

impl Capability {
    pub fn limited(reason: impl Into<String>) -> Self {
        Self::Limited {
            reason: reason.into(),
        }
    }

    pub fn unsupported(reason: impl Into<String>) -> Self {
        Self::Unsupported {
            reason: reason.into(),
        }
    }

    /// 配置层面可用（`Supported` 或 `Limited`）：用于"是否允许发起这个操作"。
    pub fn is_available(&self) -> bool {
        !matches!(self, Self::Unsupported { .. })
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Supported => None,
            Self::Limited { reason } | Self::Unsupported { reason } => Some(reason),
        }
    }
}

/// 一条连接的产品能力全集。
///
/// 字段刻意按"用户在界面上能看到的动作"划分，而不是按驱动 API 划分：
/// 能力是给 UI 用的，不是给实现者自我描述的。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CapabilitySet {
    /// 执行 SQL 脚本（含多语句）。
    pub query: Capability,
    /// 一条脚本里返回多个结果集。
    pub multiple_result_sets: Capability,
    /// 服务端取消正在执行的语句。
    pub cancel: Capability,
    /// 显式事务（BEGIN/COMMIT/ROLLBACK）。
    pub transaction: Capability,
    /// 只读保障是"服务端拒绝写"还是"仅客户端提示"。
    pub read_only_enforcement: Capability,
    /// 浏览表数据 / 键值。
    pub table_browse: Capability,
    /// 可靠唯一键上的 keyset 分页（没有就只能 OFFSET）。
    pub keyset_pagination: Capability,
    /// 单行增删改。
    pub table_edit: Capability,
    /// 建库/建表/改表/删表。
    pub schema_edit: Capability,
    /// 视图创建与替换。
    pub view_edit: Capability,
    /// 结果导出 CSV。
    pub export: Capability,
}

impl CapabilitySet {
    /// 尚未适配的产品：所有动作都不可用，原因只有一句话。
    pub fn unimplemented(reason: impl Into<String>) -> Self {
        let reason = reason.into();
        let cap = || Capability::unsupported(reason.clone());
        Self {
            query: cap(),
            multiple_result_sets: cap(),
            cancel: cap(),
            transaction: cap(),
            read_only_enforcement: cap(),
            table_browse: cap(),
            keyset_pagination: cap(),
            table_edit: cap(),
            schema_edit: cap(),
            view_edit: cap(),
            export: cap(),
        }
    }
}

/// 已验证到哪一步。**没有真实环境就不许往上写。**
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifiedLevel {
    /// 配置能保存、能通过本地校验（不联网）。
    ConfigOnly,
    /// 真实实例上完成连接 + 认证 + TLS。
    Connect,
    /// 真实实例上完成查询、元数据、类型、分页、取消。
    Query,
    /// 真实实例上完成编辑、DDL、导出、只读保障。
    Manage,
}

/// 一条"在哪个版本上验证到什么程度"的记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VerifiedScope {
    /// 已验证的产品版本，例如 `MySQL 8.0.36`；未验证写 `—`。
    pub versions: String,
    pub level: VerifiedLevel,
    /// 未覆盖的点必须写出来（例如"未验证 TLS 双向认证"）。
    pub notes: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    /// host/port/username 这类网络端点。
    Network,
    /// 本地文件（SQLite）。
    LocalFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Implementation {
    /// 有真实驱动，能连接。
    Implemented,
    /// 只有配置模型：能保存、能校验，连接会被明确拒绝。
    ConfigOnly,
}

/// 驱动系列：决定复用哪个协议实现，**不是**产品身份。
///
/// 序列化成稳定的小写标识（`mysql`/`sqlserver`…），前端路由直接用它，
/// 不用再对产品名做特判。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DriverFamily {
    #[serde(rename = "mysql")]
    MySql,
    #[serde(rename = "postgres")]
    Postgres,
    #[serde(rename = "sqlite")]
    Sqlite,
    #[serde(rename = "sqlserver")]
    SqlServer,
    #[serde(rename = "oracle")]
    Oracle,
    #[serde(rename = "mongodb")]
    MongoDb,
    #[serde(rename = "clickhouse")]
    ClickHouse,
    #[serde(rename = "redis")]
    Redis,
}

/// SQL 方言：决定标识符引用、字面量、分页与占位符。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Dialect {
    #[serde(rename = "mysql")]
    MySql,
    #[serde(rename = "postgres")]
    Postgres,
    #[serde(rename = "sqlite")]
    Sqlite,
    #[serde(rename = "tsql")]
    TSql,
    #[serde(rename = "oracle")]
    Oracle,
    #[serde(rename = "clickhouse")]
    ClickHouse,
    /// Redis 没有 SQL 方言；字段存在是为了让前端不用特判 `null`。
    #[serde(rename = "none")]
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentifierQuote {
    Backtick,
    DoubleQuote,
    Bracket,
}

/// 前端拼 SQL（复制为 INSERT / WHERE、语句拆分）需要的方言事实。
///
/// 放在后端是为了**只有一份**：前端拿到的就是后端生成 SQL 用的规则。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DialectRules {
    pub identifier_quote: IdentifierQuote,
    /// 字符串字面量是否支持反斜杠转义（MySQL）还是只能双写单引号（标准 SQL）。
    pub backslash_escapes: bool,
    /// `#` 是否算行注释（MySQL）。
    pub hash_line_comment: bool,
    /// 是否支持 `$$ ... $$` 美元引用（PostgreSQL）。
    pub dollar_quoting: bool,
    /// 批分隔符（SQL Server 的 `GO`）。
    pub batch_terminator: Option<&'static str>,
    /// 单条语句结束符；Oracle 用 `/` 单独提交一个 PL/SQL 块。
    pub statement_terminator: &'static str,
    /// 是否用 schema 作为表的两级限定（PostgreSQL/Oracle/SQL Server）。
    pub qualified_by_schema: bool,
    /// 标识符字节上限：MySQL 64、PostgreSQL 63、SQL Server 128、Oracle 128、
    /// SQLite 本身无限制（这里给一个防呆上限）。
    pub max_ident_bytes: u16,
}

/// 连接端点必填到哪一步。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointRequirement {
    /// 必须 host + port。
    HostPort,
    /// 必须 engine_options.path（SQLite）。
    FilePath,
    /// URI 或 host 至少一个（MongoDB）。
    UriOrHost,
}

/// 必填项。**密码永远不是必填**：空密码是合法配置，由服务器裁决。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct EngineRequirements {
    pub endpoint: EndpointRequirement,
    pub username: bool,
    /// "默认数据库"是否必填（Oracle service/SID、PG database）。
    pub database: bool,
}

/// 连接表单里除了 host/port/username 之外还要哪些字段。
///
/// 由后端声明，前端只按这里的布尔值渲染 —— 不再写 `engine === "sqlite"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
pub struct EngineFields {
    pub host: bool,
    pub port: bool,
    pub username: bool,
    pub password: bool,
    /// "默认数据库"（MySQL/PG/SQL Server）。
    pub database: bool,
    /// 本地文件路径（SQLite），存在 `engine_options.path`。
    pub path: bool,
    /// 连接 URI（MongoDB），存在 `engine_options.uri`。
    pub uri: bool,
    pub ssh_tunnel: bool,
    pub tls: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OptionFieldKind {
    Text,
    /// 文件选择器；保存前只做"非空 + 无控制字符"校验，不要求文件存在。
    Path,
    Enum {
        values: &'static [&'static str],
    },
    Bool,
}

/// `engine_options` 里的一个字段。前端据此渲染，后端据此校验。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct OptionField {
    pub key: &'static str,
    /// 中文标签，前端用 `t()` 翻译（与仓库既有文案风格一致）。
    pub label: &'static str,
    pub placeholder: &'static str,
    pub kind: OptionFieldKind,
    pub required: bool,
}

/// 一个产品引擎的完整描述。
#[derive(Debug, Clone, Serialize)]
pub struct EngineDescriptor {
    /// 稳定标识，写进 `database_profiles.engine`。
    pub id: &'static str,
    /// 产品名（MySQL / TiDB / OceanBase（MySQL 模式）…）。
    pub product: &'static str,
    pub family: DriverFamily,
    pub dialect: Dialect,
    pub transport: Transport,
    pub implementation: Implementation,
    pub default_port: Option<u16>,
    /// 切到这个引擎时表单自动填的用户名；`None` = 不自动填。
    pub default_username: Option<&'static str>,
    pub fields: EngineFields,
    pub requirements: EngineRequirements,
    pub options: &'static [OptionField],
    pub capabilities: CapabilitySet,
    pub dialect_rules: DialectRules,
    pub verified: Vec<VerifiedScope>,
    /// 给用户看的补充说明（限制、计划批次）。
    pub note: &'static str,
}

impl EngineDescriptor {
    pub fn is_implemented(&self) -> bool {
        self.implementation == Implementation::Implemented
    }

    pub fn is_local_file(&self) -> bool {
        self.transport == Transport::LocalFile
    }

    /// `engine_options` 是否允许这个键。
    pub fn allows_option(&self, key: &str) -> bool {
        self.options.iter().any(|field| field.key == key)
    }
}
