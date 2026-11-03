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
    /// 把表/键值结果导出 CSV（界面上的"导出表数据"）。
    pub export: Capability,
    /// 把 SQL 工作区里的查询结果导出 CSV。
    ///
    /// **和 `export` 分开**：很多引擎只接了"按表导出"（服务端重新分页查询），
    /// 自定义 SQL 导出要重新执行一段用户脚本再流式写盘，是另一条链路。
    /// 压成一个字段，SQL 工作区的导出按钮就只能二选一地撒谎。
    pub export_sql: Capability,
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
            export_sql: cap(),
        }
    }
}

/// 逐项 DDL 能力。
///
/// **不能用一个 `schema_edit` 代表所有 DDL**：同一个引擎常常"能建表、不能改表"
/// 或"能删表、不能清空"（SQLite 没有 `CREATE TABLE … LIKE`，PostgreSQL 没有
/// 改表）。菜单按这里的每一项禁用并给出原因，后端在 `table_ops` 里按同一份
/// 声明拒绝 —— 两边读同一份事实，界面不会给出一个点了必然失败的入口。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DdlCapabilities {
    pub create_table: Capability,
    pub rename_table: Capability,
    /// 复制表结构 / 结构 + 数据。
    pub copy_table: Capability,
    pub truncate_table: Capability,
    pub drop_table: Capability,
    /// 加列 / 改列名 / 删列 / 索引增删。
    pub alter_columns: Capability,
    pub create_view: Capability,
    pub drop_view: Capability,
}

impl DdlCapabilities {
    /// 由 `schema_edit` / `view_edit` 推导：没有逐项差异的引擎不必重写一遍。
    pub fn from_schema(schema: &Capability, view: &Capability) -> Self {
        Self {
            create_table: schema.clone(),
            rename_table: schema.clone(),
            copy_table: schema.clone(),
            truncate_table: schema.clone(),
            drop_table: schema.clone(),
            alter_columns: schema.clone(),
            create_view: view.clone(),
            drop_view: view.clone(),
        }
    }

    pub fn unimplemented(reason: impl Into<String>) -> Self {
        let reason = reason.into();
        let cap = || Capability::unsupported(reason.clone());
        Self {
            create_table: cap(),
            rename_table: cap(),
            copy_table: cap(),
            truncate_table: cap(),
            drop_table: cap(),
            alter_columns: cap(),
            create_view: cap(),
            drop_view: cap(),
        }
    }

    /// 按操作查能力。**唯一**的映射点：界面与执行层都用它。
    pub fn for_operation(&self, operation: &str) -> Option<&Capability> {
        Some(match operation {
            "create_table" => &self.create_table,
            "rename_table" | "rename" => &self.rename_table,
            "copy_table" | "copy_structure" | "copy_data" => &self.copy_table,
            "truncate_table" | "truncate" => &self.truncate_table,
            "drop_table" | "drop" => &self.drop_table,
            "alter_columns" => &self.alter_columns,
            "create_view" => &self.create_view,
            "drop_view" => &self.drop_view,
            _ => return None,
        })
    }
}

/// 已验证到哪一步。**没有真实环境就不许往上写。**
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifiedLevel {
    /// 配置能保存、能通过本地校验（不联网）。
    ConfigOnly,
    /// 真实驱动已接入、代码路径可执行，但**没有**在真实实例上验证过。
    ///
    /// 这一档和 `ConfigOnly` 必须分开：前者是"没有驱动"，后者是"有驱动、
    /// 缺实例验证"。界面按这个区分显示，不能用"未实机验证"掩盖"没实现"。
    DriverOnly,
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

/// 「新建连接」窗口里要不要给这个产品一个一级入口。
///
/// **与 `Implementation` 正交，两件事不能合并**：
///
/// * 有驱动也可以不出现在列表里（Aurora、TiDB 暂时不做一级入口），
///   已有连接的名称、编辑表单、能力说明一律照旧；
/// * 没驱动也可以留在注册表里（SQL Server / MongoDB 仍在开发计划），
///   这样旧配置不会变成"未知数据库"，但也不会给用户一个点了必失败的占位入口。
///
/// 把两者压成一个布尔，界面就只能二选一地撒谎：要么假装没实现的能用，
/// 要么把有驱动的产品说成"未知"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EntryPolicy {
    /// 出现在「新建连接」的数据库类型列表里。
    Listed,
    /// 不在「新建连接」列表；为什么隐藏、以后怎么回来都写在这里。
    Hidden { reason: &'static str },
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
    /// 新建连接列表的入口策略。**不要**用 `implementation` 兼任：
    /// "隐藏"和"没实现"是两件独立的事（见 `EntryPolicy`）。
    pub entry: EntryPolicy,
    pub default_port: Option<u16>,
    /// 切到这个引擎时表单自动填的用户名；`None` = 不自动填。
    pub default_username: Option<&'static str>,
    pub fields: EngineFields,
    pub requirements: EngineRequirements,
    pub options: &'static [OptionField],
    pub capabilities: CapabilitySet,
    /// 逐项 DDL 能力：`capabilities.schema_edit` 只是"这一类操作"的总览。
    pub ddl_operations: DdlCapabilities,
    pub dialect_rules: DialectRules,
    pub verified: Vec<VerifiedScope>,
    /// 给用户看的补充说明（限制、计划批次）。
    pub note: &'static str,
}

// ---------------------------------------------------------------------------
// MySQL 协议兼容产品的执行差异
// ---------------------------------------------------------------------------

/// 只读保障怎么落地。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadOnlyMode {
    /// 会话级只读事务：服务器自己拒绝写语句。
    ServerTransaction,
    /// 产品没有只读事务：只能在客户端拦截，界面必须说明这是"客户端保障"。
    ClientOnly,
}

/// 取消方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CancelMode {
    /// `KILL QUERY <thread_id>`，走独立控制连接。
    ThreadKill,
    /// 产品不支持按连接 id 取消（Doris/StarRocks 按 query id）。
    Unsupported { reason: &'static str },
}

/// 事务能力。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionMode {
    /// 支持显式 BEGIN/COMMIT/ROLLBACK 与多语句事务。
    Explicit,
    /// 单语句自动提交，没有跨语句事务（Doris/StarRocks）。
    AutoCommitOnly,
}

/// 一个 MySQL 协议兼容产品的执行差异。
///
/// **协议兼容不等于产品等价**：会话初始化、只读保障、取消方式、系统库
/// 和事务都要按产品给。这些值来自各产品公开文档；未在真实实例验证的
/// 由 `VerifiedScope` 单独记录，不能靠改这里冒充"已验证"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MySqlProductProfile {
    /// 连接建立后必须执行的会话设置（字符集除外，连接参数里已统一设置）。
    pub session_init: &'static [&'static str],
    pub read_only: ReadOnlyMode,
    pub cancel: CancelMode,
    /// 系统库名单（精确匹配）。
    pub system_databases: &'static [&'static str],
    pub transaction: TransactionMode,
}

/// MySQL 8.x / MariaDB：标准行为。
pub const MYSQL_STANDARD_PROFILE: MySqlProductProfile = MySqlProductProfile {
    session_init: &[],
    read_only: ReadOnlyMode::ServerTransaction,
    cancel: CancelMode::ThreadKill,
    system_databases: &["information_schema", "mysql", "performance_schema", "sys"],
    transaction: TransactionMode::Explicit,
};

/// TiDB：MySQL 协议 + 分布式事务；默认端口 4000，系统库多 `metrics_schema`。
pub const TIDB_PROFILE: MySqlProductProfile = MySqlProductProfile {
    session_init: &[],
    read_only: ReadOnlyMode::ServerTransaction,
    cancel: CancelMode::ThreadKill,
    system_databases: &[
        "information_schema",
        "mysql",
        "performance_schema",
        "sys",
        "metrics_schema",
    ],
    transaction: TransactionMode::Explicit,
};

/// OceanBase（MySQL 模式）：默认端口 2881，系统库多 `oceanbase`。
pub const OCEANBASE_MYSQL_PROFILE: MySqlProductProfile = MySqlProductProfile {
    session_init: &[],
    read_only: ReadOnlyMode::ServerTransaction,
    cancel: CancelMode::ThreadKill,
    system_databases: &["information_schema", "mysql", "oceanbase", "sys"],
    transaction: TransactionMode::Explicit,
};

/// Amazon Aurora MySQL：与 MySQL 8.0 同协议，差异在托管端点/TLS 与只读副本。
pub const AURORA_MYSQL_PROFILE: MySqlProductProfile = MySqlProductProfile {
    session_init: &[],
    read_only: ReadOnlyMode::ServerTransaction,
    cancel: CancelMode::ThreadKill,
    system_databases: &["information_schema", "mysql", "performance_schema", "sys"],
    transaction: TransactionMode::Explicit,
};

/// Apache Doris：MySQL 协议传输入口默认 **9030**（不是 3306）。
///
/// 没有跨语句事务、没有只读事务；取消按 query id 而不是连接 id。
/// 行级 UPDATE/DELETE 只在 Unique Key 表模型上成立，默认不开。
pub const DORIS_PROFILE: MySqlProductProfile = MySqlProductProfile {
    session_init: &[],
    read_only: ReadOnlyMode::ClientOnly,
    cancel: CancelMode::Unsupported {
        reason: "Apache Doris 按 query id 取消，不能用连接 id 执行 KILL QUERY",
    },
    system_databases: &["information_schema", "__internal_schema"],
    transaction: TransactionMode::AutoCommitOnly,
};

/// StarRocks：同 Doris，MySQL 协议入口默认 **9030**。
pub const STARROCKS_PROFILE: MySqlProductProfile = MySqlProductProfile {
    session_init: &[],
    read_only: ReadOnlyMode::ClientOnly,
    cancel: CancelMode::Unsupported {
        reason: "StarRocks 按 query id 取消，不能用连接 id 执行 KILL QUERY",
    },
    system_databases: &["information_schema", "_statistics_"],
    transaction: TransactionMode::AutoCommitOnly,
};

impl EngineDescriptor {
    pub fn is_implemented(&self) -> bool {
        self.implementation == Implementation::Implemented
    }

    /// 是否出现在「新建连接」的数据库类型列表里。
    pub fn is_listed(&self) -> bool {
        matches!(self.entry, EntryPolicy::Listed)
    }

    /// 被移出新建列表的原因；仍是列表入口时返回 `None`。
    pub fn hidden_reason(&self) -> Option<&'static str> {
        match self.entry {
            EntryPolicy::Listed => None,
            EntryPolicy::Hidden { reason } => Some(reason),
        }
    }

    pub fn is_local_file(&self) -> bool {
        self.transport == Transport::LocalFile
    }

    /// `engine_options` 是否允许这个键。
    pub fn allows_option(&self, key: &str) -> bool {
        self.options.iter().any(|field| field.key == key)
    }
}
