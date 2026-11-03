//! 引擎注册表：产品标识、驱动系列、方言、字段要求、能力与"验证到哪一步"。
//!
//! 这是**唯一**一份引擎清单：
//!
//! * 配置校验按这里的 `requirements` 走，不再要求每个数据库都有 host/port；
//! * 连接入口按 `implementation` 拒绝，未适配的引擎连不上就明说；
//! * 新建连接的数据库类型列表按 `entry` 过滤，**不靠前端写死数组**；
//! * `db_engines_catalog` 把它原样发给前端，界面不再自己维护一份。
//!
//! **不要把"注册了"当成"支持了"**：`Implementation::ConfigOnly` 只代表配置
//! 能保存。真实驱动接进来时才改成 `Implemented`，并且必须同时补
//! `VerifiedScope`（在哪个版本、验证到哪一步、还有什么没验证）。
//!
//! **也不要把"隐藏"当成"删除"**：`EntryPolicy::Hidden` 只表示不再给一级
//! 入口（产品线收敛），引擎仍在注册表里，旧配置照旧能显示产品名、能编辑、
//! 能连接（前提是 `Implemented`）。

use std::sync::OnceLock;

use super::capability::{
    Capability, CapabilitySet, DdlCapabilities, Dialect, DialectRules, DriverFamily,
    EndpointRequirement, EngineDescriptor, EngineFields, EngineRequirements, EntryPolicy,
    IdentifierQuote, Implementation, MySqlProductProfile, OptionField, OptionFieldKind, Transport,
    VerifiedLevel, VerifiedScope, AURORA_MYSQL_PROFILE, DORIS_PROFILE, MYSQL_STANDARD_PROFILE,
    OCEANBASE_MYSQL_PROFILE, STARROCKS_PROFILE, TIDB_PROFILE,
};
use super::model::DbErrorInfo;

const MYSQL_RULES: DialectRules = DialectRules {
    identifier_quote: IdentifierQuote::Backtick,
    backslash_escapes: true,
    hash_line_comment: true,
    dollar_quoting: false,
    batch_terminator: None,
    statement_terminator: ";",
    qualified_by_schema: false,
    max_ident_bytes: 64,
};

const POSTGRES_RULES: DialectRules = DialectRules {
    identifier_quote: IdentifierQuote::DoubleQuote,
    backslash_escapes: false,
    hash_line_comment: false,
    dollar_quoting: true,
    batch_terminator: None,
    statement_terminator: ";",
    qualified_by_schema: true,
    max_ident_bytes: 63,
};

const SQLITE_RULES: DialectRules = DialectRules {
    identifier_quote: IdentifierQuote::DoubleQuote,
    backslash_escapes: false,
    hash_line_comment: false,
    dollar_quoting: false,
    batch_terminator: None,
    statement_terminator: ";",
    qualified_by_schema: false,
    max_ident_bytes: 255,
};

const TSQL_RULES: DialectRules = DialectRules {
    identifier_quote: IdentifierQuote::Bracket,
    backslash_escapes: false,
    hash_line_comment: false,
    dollar_quoting: false,
    batch_terminator: Some("GO"),
    statement_terminator: ";",
    qualified_by_schema: true,
    max_ident_bytes: 128,
};

const ORACLE_RULES: DialectRules = DialectRules {
    identifier_quote: IdentifierQuote::DoubleQuote,
    backslash_escapes: false,
    hash_line_comment: false,
    dollar_quoting: false,
    batch_terminator: None,
    statement_terminator: ";",
    qualified_by_schema: true,
    max_ident_bytes: 128,
};

const CLICKHOUSE_RULES: DialectRules = DialectRules {
    identifier_quote: IdentifierQuote::Backtick,
    backslash_escapes: true,
    hash_line_comment: false,
    dollar_quoting: false,
    batch_terminator: None,
    statement_terminator: ";",
    qualified_by_schema: false,
    max_ident_bytes: 255,
};

const NO_DIALECT_RULES: DialectRules = DialectRules {
    identifier_quote: IdentifierQuote::DoubleQuote,
    backslash_escapes: false,
    hash_line_comment: false,
    dollar_quoting: false,
    batch_terminator: None,
    statement_terminator: ";",
    qualified_by_schema: false,
    max_ident_bytes: 255,
};

const NETWORK_MYSQL_FIELDS: EngineFields = EngineFields {
    host: true,
    port: true,
    username: true,
    password: true,
    database: true,
    path: false,
    uri: false,
    ssh_tunnel: true,
    tls: true,
};

const SQLITE_FIELDS: EngineFields = EngineFields {
    host: false,
    port: false,
    username: false,
    password: false,
    database: false,
    path: true,
    uri: false,
    ssh_tunnel: false,
    tls: false,
};

const GENERIC_FIELDS: EngineFields = EngineFields {
    host: true,
    port: true,
    username: true,
    password: true,
    database: true,
    path: false,
    uri: false,
    ssh_tunnel: false,
    tls: true,
};

const MONGO_FIELDS: EngineFields = EngineFields {
    host: true,
    port: true,
    username: true,
    password: true,
    database: true,
    path: false,
    uri: true,
    ssh_tunnel: false,
    tls: true,
};

const SQLITE_OPTIONS: &[OptionField] = &[OptionField {
    key: "path",
    label: "数据库文件路径",
    placeholder: "例如 D:\\data\\app.db 或 /opt/app/data/app.db",
    kind: OptionFieldKind::Path,
    required: true,
}];

const POSTGRES_OPTIONS: &[OptionField] = &[OptionField {
    key: "schema",
    label: "Schema",
    placeholder: "留空使用 public",
    kind: OptionFieldKind::Text,
    required: false,
}];

const ORACLE_OPTIONS: &[OptionField] = &[
    OptionField {
        key: "identifier",
        label: "连接标识类型",
        placeholder: "service",
        kind: OptionFieldKind::Enum {
            values: &["service", "sid"],
        },
        required: false,
    },
    OptionField {
        key: "schema",
        label: "Schema",
        placeholder: "留空使用当前用户 schema",
        kind: OptionFieldKind::Text,
        required: false,
    },
];

const MONGO_OPTIONS: &[OptionField] = &[
    OptionField {
        key: "uri",
        label: "连接 URI（可选）",
        placeholder: "mongodb://host:27017/?authSource=admin",
        kind: OptionFieldKind::Text,
        required: false,
    },
    OptionField {
        key: "auth_source",
        label: "认证库",
        placeholder: "留空使用 admin",
        kind: OptionFieldKind::Text,
        required: false,
    },
];

const CLICKHOUSE_OPTIONS: &[OptionField] = &[
    OptionField {
        key: "protocol",
        label: "接口",
        placeholder: "http",
        kind: OptionFieldKind::Enum {
            values: &["http", "native"],
        },
        required: false,
    },
    OptionField {
        key: "secure",
        label: "启用 TLS",
        placeholder: "",
        kind: OptionFieldKind::Bool,
        required: false,
    },
];

fn mysql_caps() -> CapabilitySet {
    CapabilitySet {
        query: Capability::Supported,
        multiple_result_sets: Capability::Supported,
        cancel: Capability::Supported,
        transaction: Capability::Supported,
        read_only_enforcement: Capability::Supported,
        table_browse: Capability::Supported,
        keyset_pagination: Capability::Supported,
        table_edit: Capability::Supported,
        schema_edit: Capability::Supported,
        view_edit: Capability::Supported,
        export: Capability::Supported,
        export_sql: Capability::Supported,
    }
}

/// MySQL 协议兼容产品：查询/浏览/编辑链路复用，但取消与 DDL 未逐版本验证。
fn mysql_compatible_caps(cancel_note: &'static str) -> CapabilitySet {
    CapabilitySet {
        query: Capability::Supported,
        multiple_result_sets: Capability::limited("多结果集依赖产品版本与连接参数，未实机验证"),
        cancel: Capability::limited(cancel_note),
        transaction: Capability::Supported,
        read_only_enforcement: Capability::Supported,
        table_browse: Capability::Supported,
        keyset_pagination: Capability::Supported,
        table_edit: Capability::Supported,
        schema_edit: Capability::limited("DDL 语法按产品版本存在差异，未逐项验证"),
        view_edit: Capability::Supported,
        export: Capability::Supported,
        export_sql: Capability::Supported,
    }
}

/// Doris / StarRocks：MySQL 协议传输的 OLAP 产品，不能按 MySQL 全量能力开放。
fn olap_caps() -> CapabilitySet {
    CapabilitySet {
        query: Capability::Supported,
        multiple_result_sets: Capability::limited("一次只执行一条语句，没有多结果集"),
        // "未接入"是 unsupported 而不是 limited：limited 表示"能用但有边界"，
        // 界面会照样放行；这里点下去只会拿到一条失败。
        cancel: Capability::unsupported("按 query id 取消，当前版本未接入"),
        transaction: Capability::unsupported("没有跨语句事务，DML/DDL 自动提交"),
        read_only_enforcement: Capability::limited("没有只读事务：只读连接仅由客户端拦截"),
        table_browse: Capability::Supported,
        keyset_pagination: Capability::Supported,
        table_edit: Capability::limited(
            "仅 INSERT 可用；UPDATE/DELETE 依赖 Unique Key 表模型，未实机验证",
        ),
        schema_edit: Capability::limited("DDL 子集：不支持 CHANGE COLUMN/AFTER，索引语法不同"),
        view_edit: Capability::Supported,
        export: Capability::Supported,
        export_sql: Capability::Supported,
    }
}

/// PostgreSQL：执行、结构浏览、表数据、单行编辑、建表/删表、视图编辑、按表导出都已接通。
///
/// 边界写在能力位上，而不是"能力没实现"这种空话：单行编辑的二进制列仍只读；
/// 导出只支持按表（自定义 SQL 导出没接）；改表/改索引没有 DDL 生成器。
/// 界面按这些原因禁用入口，而不是让用户点进去撞一条 "unsupported"。
fn postgres_caps() -> CapabilitySet {
    CapabilitySet {
        query: Capability::Supported,
        multiple_result_sets: Capability::Supported,
        cancel: Capability::Supported,
        transaction: Capability::Supported,
        read_only_enforcement: Capability::Supported,
        table_browse: Capability::Supported,
        keyset_pagination: Capability::Supported,
        table_edit: Capability::limited(
            "单行增删改已接入（事务 + IS NOT DISTINCT FROM 乐观并发）；二进制列仍只读",
        ),
        schema_edit: Capability::limited("支持建表（IDENTITY 自增）与删表；改表/改索引不支持"),
        view_edit: Capability::limited("支持创建/替换/删除视图（CREATE OR REPLACE VIEW）"),
        export: Capability::limited("按表导出已接入；导出会重新查询，数据可能已变化"),
        export_sql: Capability::unsupported("PostgreSQL 的自定义 SQL 导出尚未接入：请按表导出"),
    }
}

/// SQLite：本地文件，**全部链路已接入**（结构浏览 / 表数据 / 单行编辑 / 建表 / 视图 / 按表导出）。
///
/// 每项都对应真实调用点：`sqlite_catalog`、`sqlite_table`、`mutate::apply_sqlite`、
/// `schema_ops` 的 SQLite 分支、`export::run_sqlite_export`。
/// 改表只做 SQLite 原生支持的列操作（ADD / RENAME / DROP COLUMN）与索引增删。
fn sqlite_caps() -> CapabilitySet {
    CapabilitySet {
        query: Capability::Supported,
        multiple_result_sets: Capability::limited(
            "多语句逐条执行、每条一个结果集；没有协议层多结果集流",
        ),
        // 取消是驱动级 `InterruptHandle`，不是"关连接"。
        cancel: Capability::Supported,
        transaction: Capability::Supported,
        // 只读连接用 `SQLITE_OPEN_READ_ONLY` 打开，写语句由 SQLite 自己拒绝。
        read_only_enforcement: Capability::Supported,
        table_browse: Capability::Supported,
        keyset_pagination: Capability::Supported,
        table_edit: Capability::limited("单行增删改已接入（事务 + 乐观并发）；二进制列仍只读"),
        schema_edit: Capability::limited(
            "支持建表/删表、加列、改列名、删列、索引增删；改类型/约束与索引改名需要重建表，建库/删库不支持",
        ),
        view_edit: Capability::limited("支持创建/替换/删除视图；OR REPLACE 用先删后建实现"),
        export: Capability::limited("按表导出已接入；导出会重新查询，数据可能已变化"),
        export_sql: Capability::unsupported("SQLite 的自定义 SQL 导出尚未接入：请按表导出"),
    }
}

fn redis_caps() -> CapabilitySet {
    CapabilitySet {
        query: Capability::unsupported("Redis 是键值引擎，不使用 SQL 工作区"),
        multiple_result_sets: Capability::unsupported("Redis 命令没有多结果集概念"),
        cancel: Capability::unsupported("Redis 命令不支持服务端取消，断开连接会中断会话"),
        // 同上：没接入 ≠ 受限。Redis 界面不提供事务入口。
        transaction: Capability::unsupported("Redis 是键值引擎，MULTI/EXEC 未接入界面"),
        read_only_enforcement: Capability::limited("只读模式尚未在服务端强制，仅界面提示"),
        table_browse: Capability::Supported,
        keyset_pagination: Capability::Supported,
        table_edit: Capability::Supported,
        schema_edit: Capability::unsupported("键值引擎没有表结构"),
        view_edit: Capability::unsupported("键值引擎没有视图"),
        export: Capability::unsupported("Redis 结果导出尚未接入"),
        export_sql: Capability::unsupported("Redis 没有 SQL，导出尚未接入"),
    }
}

/// 标记"只有配置模型"：能力全部置为不可用，并写明原因。
///
/// **只能用于没有驱动的引擎。** 已经有驱动、只想把它移出新建列表，用
/// [`hidden`]：那样能力保留，旧配置还能继续用。
fn config_only(mut engine: EngineDescriptor) -> EngineDescriptor {
    debug_assert!(
        !engine.is_implemented(),
        "{} 已声明 Implemented：不要用 config_only 覆盖它的能力，请显式给 capabilities",
        engine.id
    );
    engine.capabilities =
        CapabilitySet::unimplemented(format!("{} 尚未适配：{}", engine.product, engine.note));
    engine
}

/// 移出「新建连接」列表：注册表与已有配置都保留，只改入口策略。
fn hidden(mut engine: EngineDescriptor, reason: &'static str) -> EngineDescriptor {
    engine.entry = EntryPolicy::Hidden { reason };
    engine
}

/// 逐项 DDL 能力默认跟随 `schema_edit` / `view_edit`；有真实差异的引擎
/// 在调用它之后再单独覆盖某一项（例如 SQLite 的复制表）。
fn inherit_ddl(mut engine: EngineDescriptor) -> EngineDescriptor {
    engine.ddl_operations = DdlCapabilities::from_schema(
        &engine.capabilities.schema_edit,
        &engine.capabilities.view_edit,
    );
    engine
}

fn network(
    id: &'static str,
    product: &'static str,
    family: DriverFamily,
    dialect: Dialect,
    port: u16,
    fields: EngineFields,
    requirements: EngineRequirements,
    options: &'static [OptionField],
    rules: DialectRules,
    note: &'static str,
) -> EngineDescriptor {
    EngineDescriptor {
        id,
        product,
        family,
        dialect,
        transport: Transport::Network,
        implementation: Implementation::ConfigOnly,
        // 默认给一级入口；不出现在列表里的产品由 `hidden` 明确标记。
        entry: EntryPolicy::Listed,
        default_port: Some(port),
        default_username: None,
        fields,
        requirements,
        options,
        capabilities: CapabilitySet::unimplemented("尚未适配"),
        // 逐项 DDL 默认全关；接入了 DDL 的引擎用 `inherit_ddl` 按
        // `schema_edit`/`view_edit` 推导，再覆盖真实差异。
        ddl_operations: DdlCapabilities::unimplemented("尚未适配"),
        dialect_rules: rules,
        verified: vec![VerifiedScope {
            versions: "—".to_string(),
            level: VerifiedLevel::ConfigOnly,
            notes: "配置模型已就绪，真实驱动未接入".to_string(),
        }],
        note,
    }
}

fn mysql_family(
    id: &'static str,
    product: &'static str,
    port: u16,
    note: &'static str,
) -> EngineDescriptor {
    network(
        id,
        product,
        DriverFamily::MySql,
        Dialect::MySql,
        port,
        NETWORK_MYSQL_FIELDS,
        EngineRequirements {
            endpoint: EndpointRequirement::HostPort,
            username: true,
            database: false,
        },
        &[],
        MYSQL_RULES,
        note,
    )
}

fn postgres_family(
    id: &'static str,
    product: &'static str,
    note: &'static str,
) -> EngineDescriptor {
    network(
        id,
        product,
        DriverFamily::Postgres,
        Dialect::Postgres,
        5432,
        NETWORK_MYSQL_FIELDS,
        EngineRequirements {
            endpoint: EndpointRequirement::HostPort,
            username: true,
            database: true,
        },
        POSTGRES_OPTIONS,
        POSTGRES_RULES,
        note,
    )
}

fn build() -> Vec<EngineDescriptor> {
    // 顺序 = 界面顺序：先「新建连接」里可见的产品，再只保留旧配置的引擎。
    let mut engines: Vec<EngineDescriptor> = Vec::new();

    // ---- 新建连接可见：只有真实接入驱动的产品 ------------------------------
    let mut mysql = mysql_family(
        "mysql",
        "MySQL",
        3306,
        "原生协议（mysql_async），支持 TLS、服务端取消、事务与 DDL",
    );
    mysql.implementation = Implementation::Implemented;
    mysql.default_username = Some("root");
    mysql.capabilities = mysql_caps();
    mysql.verified = vec![VerifiedScope {
        versions: "MySQL 8.x".to_string(),
        level: VerifiedLevel::Manage,
        notes: "本地容器跑通连接/类型/分页/取消/事务修改/DDL/导出；双向 TLS 与 5.7 未验证"
            .to_string(),
    }];
    engines.push(inherit_ddl(mysql));

    // 复用 mysql_async 不等于 MariaDB 全等：认证插件与部分 DDL 语法要按版本验证。
    let mut mariadb = mysql_family(
        "mariadb",
        "MariaDB",
        3306,
        "复用 MySQL 协议驱动；认证插件与部分 DDL 语法需按版本验证",
    );
    mariadb.implementation = Implementation::Implemented;
    mariadb.default_username = Some("root");
    mariadb.capabilities = mysql_caps();
    mariadb.verified = vec![VerifiedScope {
        versions: "MariaDB 11.4.13".to_string(),
        level: VerifiedLevel::Manage,
        notes: "MariaDB 11.4.13 容器上用 root 跑通同一套集成用例（连接/认证/元数据/浏览/\
                键集分页/单行编辑/DDL/按表导出/取消/重连，10/10 通过）；这套用例用的是 \
                engine=mysql，MariaDB 注册项自身的差异（系统库名单、默认端口）未逐项单独验证；\
                JSON 列在 MariaDB 上是 LONGTEXT（驱动返回文本/二进制）；TLS 与 SSH 隧道未验证"
            .to_string(),
    }];
    engines.push(inherit_ddl(mariadb));

    let mut postgres = postgres_family(
        "postgres",
        "PostgreSQL",
        "simple query 文本协议（bigint/numeric 保持字符串精度）；TLS 未接入；\
         改表/改索引与自定义 SQL 导出未接入",
    );
    postgres.implementation = Implementation::Implemented;
    postgres.default_username = Some("postgres");
    postgres.capabilities = postgres_caps();
    postgres.verified = vec![VerifiedScope {
        versions: "PostgreSQL 17.11".to_string(),
        level: VerifiedLevel::Manage,
        notes: "PostgreSQL 17.11 容器实测（6 个集成用例）：连接/认证/simple query/多语句/\
                类型精度（int8、numeric、bytea、jsonb）/取消/事务状态/关闭重连/结构浏览/\
                表数据（keyset）/单行编辑与冲突检测/建表与视图/按表导出/只读连接由服务器\
                拒绝写入；改表与改索引、自定义 SQL 导出、TLS 与 SSH 隧道未验证"
            .to_string(),
    }];
    let mut postgres = inherit_ddl(postgres);
    // PostgreSQL 侧只接了"建表 / 删表 / 视图"：改列与改索引没有 DDL 生成器，
    // 复制表也只是把结构+数据搬过去，外键与序列不会跟着走 —— 逐项写清楚。
    postgres.ddl_operations.alter_columns =
        Capability::unsupported("PostgreSQL 的改列/改索引尚未接入：请用 SQL 工作区手动执行");
    engines.push(postgres);

    let mut sqlite = network(
        "sqlite",
        "SQLite",
        DriverFamily::Sqlite,
        Dialect::Sqlite,
        0,
        SQLITE_FIELDS,
        EngineRequirements {
            endpoint: EndpointRequirement::FilePath,
            username: false,
            database: false,
        },
        SQLITE_OPTIONS,
        SQLITE_RULES,
        "本地文件数据库：不需要 host/port/用户名/TLS/SSH；打开已有文件，不会自动创建",
    );
    sqlite.transport = Transport::LocalFile;
    sqlite.default_port = None;
    sqlite.implementation = Implementation::Implemented;
    sqlite.capabilities = sqlite_caps();
    sqlite.verified = vec![VerifiedScope {
        versions: "SQLite（rusqlite bundled）".to_string(),
        level: VerifiedLevel::Manage,
        notes: "本地临时库实测（7 个集成用例）：打开已有文件/拒绝自动创建/只读打开由 SQLite \
                拒绝写入/查询类型/行数预算/多语句逐条执行/结构浏览/表数据浏览/单行编辑与冲突\
                检测/建表与视图/按表导出（完整 CSV）；改表（ALTER）、改索引与自定义 SQL 导出\
                确实没有"
            .to_string(),
    }];
    // **不要**再套 `config_only`：SQLite 六条链路都有真实实现，套上去会把
    // 全部能力改写成 "尚未适配"，界面上就变成一个"能连不能看"的空壳。
    let mut sqlite = inherit_ddl(sqlite);
    // 复制表是 SQLite 唯一的缺口：没有 `CREATE TABLE … LIKE`，也没接
    // "读建表语句再改写"。菜单据此单独置灰，而不是整个 schema_edit 一起关。
    sqlite.ddl_operations.copy_table =
        Capability::unsupported("SQLite 没有 CREATE TABLE … LIKE：复制表尚未接入");
    engines.push(sqlite);

    let mut redis = network(
        "redis",
        "Redis",
        DriverFamily::Redis,
        Dialect::None,
        6379,
        EngineFields {
            host: true,
            port: true,
            username: true,
            password: true,
            database: true,
            path: false,
            uri: false,
            ssh_tunnel: true,
            tls: true,
        },
        EngineRequirements {
            endpoint: EndpointRequirement::HostPort,
            username: false,
            database: false,
        },
        &[],
        NO_DIALECT_RULES,
        "独立的键值管线（键浏览器 + 类型化读写 + 发布订阅），不使用 SQL 工作区",
    );
    redis.implementation = Implementation::Implemented;
    redis.capabilities = redis_caps();
    redis.verified = vec![VerifiedScope {
        versions: "Redis 7.x".to_string(),
        level: VerifiedLevel::Manage,
        notes: "本地容器跑通 SCAN/类型化读写/TTL/发布订阅；集群与哨兵仅做连接级验证".to_string(),
    }];
    engines.push(redis);

    // ---- 不在新建连接列表：保留注册与已有配置 -------------------------------
    //
    // 这里的产品**仍然在注册表里**：老配置要能显示原产品名、能编辑、能连接。
    // 只是「新建连接」的数据库类型列表不再给一级入口（见 `EntryPolicy`）。
    //
    // MySQL 协议兼容产品：默认端口按各产品官方文档（TiDB 4000、OceanBase
    // 2881、Doris/StarRocks 9030、Aurora MySQL 3306），用户始终可以覆盖。
    // 共用 mysql_async **不等于**共用事务/DDL/编辑能力，差异由
    // `MySqlProductProfile` + 各自的 `CapabilitySet` 承载。
    for (id, product, port, note, reason) in [
        (
            "tidb",
            "TiDB",
            4000,
            "MySQL 协议，默认端口 4000；复用 mysql_async，事务与 DDL 差异按版本验证",
            "暂不作为新建连接的一级入口；MySQL 协议驱动保留，已有连接可继续使用与编辑",
        ),
        (
            "oceanbase_mysql",
            "OceanBase（MySQL 模式）",
            2881,
            "MySQL 模式默认端口 2881，系统库含 oceanbase；跨版本兼容性未验证",
            "暂不作为新建连接的一级入口；MySQL 协议驱动保留，已有连接可继续使用与编辑",
        ),
        (
            "doris",
            "Apache Doris",
            9030,
            "MySQL 协议入口默认 9030；无跨语句事务、无只读事务；行编辑仅 INSERT",
            "暂不作为一级入口：没有跨语句事务、行编辑仅 INSERT，差异化适配未完成",
        ),
        (
            "starrocks",
            "StarRocks",
            9030,
            "MySQL 协议入口默认 9030；无跨语句事务、无只读事务；行编辑仅 INSERT",
            "暂不作为一级入口：没有跨语句事务、行编辑仅 INSERT，差异化适配未完成",
        ),
        (
            "aurora_mysql",
            "Amazon Aurora MySQL",
            3306,
            "MySQL 8.0 兼容；差异在托管端点、TLS 证书与只读副本",
            "取消独立一级入口；后续作为 MySQL 连接预设（托管端点/TLS）处理",
        ),
    ] {
        let mut engine = mysql_family(id, product, port, note);
        engine.implementation = Implementation::Implemented;
        engine.default_username = Some("root");
        engine.capabilities = match id {
            "doris" | "starrocks" => olap_caps(),
            "tidb" => mysql_compatible_caps("复用 KILL，未在该版本实机验证"),
            "oceanbase_mysql" => mysql_compatible_caps("复用 KILL，未实机验证"),
            _ => mysql_compatible_caps("与 MySQL 8.0 同协议，托管实例未验证"),
        };
        engine.verified = vec![VerifiedScope {
            versions: "—".to_string(),
            level: VerifiedLevel::DriverOnly,
            notes: "mysql_async 的连接/查询/元数据/导出链路已接通；未在真实实例上跑过，\
                    未验证项按能力标注，不视为已验证"
                .to_string(),
        }];
        engines.push(hidden(inherit_ddl(engine), reason));
    }

    engines.push(hidden(
        config_only(postgres_family(
            "cockroach",
            "CockroachDB",
            "复用 PostgreSQL 协议驱动；系统表、事务重试与 DDL 差异未适配",
        )),
        "不在当前支持范围：PostgreSQL 协议可复用，但系统表/事务重试差异未适配",
    ));
    engines.push(hidden(
        config_only(postgres_family(
            "aurora_pg",
            "Amazon Aurora PostgreSQL",
            "复用 PostgreSQL 协议驱动；托管端点的 TLS 与故障转移未验证",
        )),
        "取消独立一级入口；后续作为 PostgreSQL 连接预设（托管端点/TLS）处理",
    ));

    // SQL Server / MongoDB：留在开发计划里。**不给配置占位入口** ——
    // 可配置但点连接必然失败，比不出现更伤用户。
    engines.push(hidden(
        config_only(network(
            "sqlserver",
            "SQL Server",
            DriverFamily::SqlServer,
            Dialect::TSql,
            1433,
            GENERIC_FIELDS,
            EngineRequirements {
                endpoint: EndpointRequirement::HostPort,
                username: true,
                database: true,
            },
            &[],
            TSQL_RULES,
            "开发计划：独立 TDS 驱动；取消与 TLS 需单独评估",
        )),
        "开发计划中：TDS 驱动尚未接入，暂不提供新建入口",
    ));
    engines.push(hidden(
        config_only(network(
            "mongodb",
            "MongoDB",
            DriverFamily::MongoDb,
            Dialect::None,
            27017,
            MONGO_FIELDS,
            EngineRequirements {
                endpoint: EndpointRequirement::UriOrHost,
                username: false,
                database: false,
            },
            MONGO_OPTIONS,
            NO_DIALECT_RULES,
            "开发计划：文档模型，独立工作区；不接入 SQL 编辑器与表结构编辑",
        )),
        "开发计划中：文档型驱动尚未接入，暂不提供新建入口",
    ));

    engines.push(hidden(
        config_only(network(
            "oracle",
            "Oracle",
            DriverFamily::Oracle,
            Dialect::Oracle,
            1521,
            GENERIC_FIELDS,
            EngineRequirements {
                endpoint: EndpointRequirement::HostPort,
                username: true,
                database: true,
            },
            ORACLE_OPTIONS,
            ORACLE_RULES,
            "先比较 OCI/Instant Client 与纯 Rust 路线（认证/TLS/LOB/取消/部署成本）",
        )),
        "暂不在支持范围：驱动未接入，后续单独评估 OCI 与纯 Rust 路线",
    ));
    engines.push(hidden(
        config_only(network(
            "clickhouse",
            "ClickHouse",
            DriverFamily::ClickHouse,
            Dialect::ClickHouse,
            8123,
            GENERIC_FIELDS,
            EngineRequirements {
                endpoint: EndpointRequirement::HostPort,
                username: true,
                database: false,
            },
            CLICKHOUSE_OPTIONS,
            CLICKHOUSE_RULES,
            "优先 HTTP 接口（含 query_id 取消），原生 TCP 后续评估",
        )),
        "暂不在支持范围：驱动未接入",
    ));

    engines
}

fn registry() -> &'static Vec<EngineDescriptor> {
    static REGISTRY: OnceLock<Vec<EngineDescriptor>> = OnceLock::new();
    REGISTRY.get_or_init(build)
}

/// 全部引擎，顺序即注册表顺序：先是新建连接可见的，再是只保留旧配置的。
///
/// 需要"新建连接能选什么"时用 [`listed`]，**不要**在前端再写一份过滤数组。
pub fn all() -> &'static [EngineDescriptor] {
    registry().as_slice()
}

/// 「新建连接」列表里的引擎。被隐藏的引擎不会出现在这里。
pub fn listed() -> Vec<&'static EngineDescriptor> {
    registry()
        .iter()
        .filter(|engine| engine.is_listed())
        .collect()
}

/// MySQL 协议兼容产品的执行差异（会话初始化 / 只读 / 取消 / 系统库 / 事务）。
///
/// 非 MySQL 驱动系列的引擎返回 `None`：不要拿 MySQL 的差异去套 PostgreSQL。
pub fn mysql_product(engine_id: &str) -> Option<&'static MySqlProductProfile> {
    Some(match engine_id {
        "mysql" | "mariadb" => &MYSQL_STANDARD_PROFILE,
        "tidb" => &TIDB_PROFILE,
        "oceanbase_mysql" => &OCEANBASE_MYSQL_PROFILE,
        "aurora_mysql" => &AURORA_MYSQL_PROFILE,
        "doris" => &DORIS_PROFILE,
        "starrocks" => &STARROCKS_PROFILE,
        _ => return None,
    })
}

pub fn find(id: &str) -> Option<&'static EngineDescriptor> {
    registry().iter().find(|engine| engine.id == id)
}

pub fn exists(id: &str) -> bool {
    find(id).is_some()
}

/// 连接/执行入口用：未注册或未适配都返回给用户看得懂的错误。
pub fn require_implemented(id: &str) -> Result<&'static EngineDescriptor, DbErrorInfo> {
    let engine = find(id).ok_or_else(|| {
        DbErrorInfo::new("unsupported", format!("未知的数据库类型：{id}"))
            .with_detail("请升级到包含该引擎的版本，或选择已支持的数据库类型。")
    })?;
    if !engine.is_implemented() {
        // 被移出新建列表的产品，老配置还在：把"入口已收敛"一并说清，
        // 否则用户会以为是自己填错了配置。
        let detail = match engine.hidden_reason() {
            Some(reason) => format!("{}；{}", engine.note, reason),
            None => engine.note.to_string(),
        };
        return Err(DbErrorInfo::new(
            "unsupported",
            format!(
                "{} 尚未适配：配置可以保存，但当前版本还不能连接",
                engine.product
            ),
        )
        .with_detail(detail));
    }
    Ok(engine)
}

/// 前端目录用的 `supported`：能建立连接并真正工作。
pub fn is_supported(id: &str) -> bool {
    find(id).is_some_and(EngineDescriptor::is_implemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 新建连接列表里只能有真实驱动：没驱动的引擎必须 Hidden（旧配置仍可编辑）。
    #[test]
    fn only_implemented_engines_are_listed() {
        for engine in all() {
            if engine.is_listed() {
                assert!(
                    engine.is_implemented(),
                    "{} 没有驱动却出现在新建列表",
                    engine.id
                );
            }
        }
        for id in ["mysql", "mariadb", "postgres", "sqlite", "redis"] {
            let engine = find(id).expect("registered");
            assert!(engine.is_implemented(), "{id} 应已实现");
            assert!(engine.is_listed(), "{id} 有驱动但不在新建列表");
        }
        // 明确不做的引擎：注册与旧配置保留，但不再出现在新建入口。
        for id in [
            "cockroach",
            "aurora_pg",
            "sqlserver",
            "oracle",
            "mongodb",
            "clickhouse",
        ] {
            let engine = find(id).expect("registered");
            assert!(!engine.is_implemented(), "{id} 不能宣称已实现");
            assert!(!engine.is_listed(), "{id} 没有驱动，不能出现在新建列表");
            assert!(
                engine
                    .hidden_reason()
                    .is_some_and(|reason| !reason.is_empty()),
                "{id} 隐藏必须给原因"
            );
        }
    }

    #[test]
    fn mysql_compatible_default_ports_follow_the_product() {
        // 不能所有 MySQL 协议产品都用 3306：TiDB 4000、OceanBase 2881、
        // Doris/StarRocks 的 MySQL 入口 9030、Aurora 3306。
        for (id, port) in [
            ("mysql", 3306),
            ("mariadb", 3306),
            ("tidb", 4000),
            ("oceanbase_mysql", 2881),
            ("doris", 9030),
            ("starrocks", 9030),
            ("aurora_mysql", 3306),
        ] {
            let engine = find(id).unwrap_or_else(|| panic!("{id} 未注册"));
            assert_eq!(engine.default_port, Some(port), "{id} 默认端口");
        }
    }

    #[test]
    fn olap_products_do_not_claim_transactions_or_server_read_only() {
        for id in ["doris", "starrocks"] {
            let engine = find(id).expect("registered");
            assert_eq!(engine.implementation, Implementation::Implemented, "{id}");
            assert!(
                !engine.capabilities.transaction.is_available(),
                "{id} 没有跨语句事务，不能声明支持"
            );
            assert!(
                engine.capabilities.read_only_enforcement.reason().is_some(),
                "{id} 的只读只在客户端拦截，必须给出原因"
            );
            assert_eq!(
                engine.verified[0].level,
                VerifiedLevel::DriverOnly,
                "{id} 没有实机验证，不能写成 Connect 以上"
            );
            assert!(
                engine.capabilities.table_edit.reason().is_some(),
                "{id} 的行编辑范围必须写明"
            );
        }
        assert!(find("tidb")
            .unwrap()
            .capabilities
            .transaction
            .is_available());
        assert_eq!(
            find("tidb").unwrap().verified[0].level,
            VerifiedLevel::DriverOnly
        );
    }

    #[test]
    fn mysql_product_profiles_are_per_product() {
        assert_eq!(
            mysql_product("doris").expect("doris").read_only,
            super::super::capability::ReadOnlyMode::ClientOnly
        );
        assert!(matches!(
            mysql_product("starrocks").expect("starrocks").cancel,
            super::super::capability::CancelMode::Unsupported { .. }
        ));
        assert!(mysql_product("tidb")
            .expect("tidb")
            .system_databases
            .contains(&"metrics_schema"));
        assert!(mysql_product("oceanbase_mysql")
            .expect("oceanbase")
            .system_databases
            .contains(&"oceanbase"));
        assert!(mysql_product("postgres").is_none());
    }

    #[test]
    fn registry_ids_are_unique_and_stable() {
        let mut ids: Vec<&str> = all().iter().map(|engine| engine.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "引擎 id 必须唯一");
        assert!(ids.contains(&"mysql"));
        assert!(ids.contains(&"mariadb"));
        assert!(ids.contains(&"redis"));
        assert!(ids.contains(&"sqlite"));
    }

    #[test]
    fn only_real_drivers_are_marked_implemented() {
        for id in [
            "mysql",
            "mariadb",
            "redis",
            "sqlite",
            "postgres",
            "tidb",
            "oceanbase_mysql",
            "aurora_mysql",
            "doris",
            "starrocks",
        ] {
            assert!(is_supported(id), "{id} 应有真实驱动");
        }
        for id in [
            "cockroach",
            "aurora_pg",
            "sqlserver",
            "oracle",
            "mongodb",
            "clickhouse",
        ] {
            let engine = find(id).expect("engine registered");
            assert!(!engine.is_implemented(), "{id} 不能宣称已实现");
            assert!(
                !engine.capabilities.query.is_available(),
                "{id} 未接入驱动前不能允许执行 SQL"
            );
        }
    }

    #[test]
    fn sqlite_is_a_file_engine_without_network_fields() {
        let sqlite = find("sqlite").expect("sqlite registered");
        assert!(sqlite.is_local_file());
        assert!(!sqlite.fields.host);
        assert!(!sqlite.fields.port);
        assert!(!sqlite.fields.username);
        assert!(!sqlite.fields.tls);
        assert!(!sqlite.fields.ssh_tunnel);
        assert_eq!(sqlite.requirements.endpoint, EndpointRequirement::FilePath);
        assert!(sqlite.allows_option("path"));
    }

    #[test]
    fn mongo_accepts_uri_instead_of_host() {
        let mongo = find("mongodb").expect("mongodb registered");
        assert_eq!(mongo.requirements.endpoint, EndpointRequirement::UriOrHost);
        assert!(mongo.allows_option("uri"));
        assert!(mongo.fields.uri);
    }

    #[test]
    fn oracle_is_config_only_and_says_so() {
        let oracle = find("oracle").expect("oracle registered");
        assert!(!oracle.is_implemented());
        assert!(oracle.capabilities.query.reason().is_some());
        assert!(oracle.hidden_reason().is_some(), "Oracle 不在新建列表里");
    }

    /// 新建连接列表 = 主力产品，且**每一个都有真实驱动**。
    ///
    /// 这条断言挡住两种回归：把没驱动的产品放回列表（点了必失败），
    /// 以及把有驱动的产品误标成隐藏。
    #[test]
    fn new_connection_list_only_contains_implemented_products() {
        let ids: Vec<&str> = listed().iter().map(|engine| engine.id).collect();
        assert_eq!(
            ids,
            vec!["mysql", "mariadb", "postgres", "sqlite", "redis"],
            "新建连接的一级入口"
        );
        for engine in listed() {
            assert!(
                engine.is_implemented(),
                "{} 出现在新建列表却没有驱动",
                engine.id
            );
        }
    }

    /// 隐藏 ≠ 删除：产品身份、配置校验与（有驱动时的）能力都要保留。
    #[test]
    fn hidden_engines_keep_identity_and_configuration() {
        for (id, product) in [
            ("tidb", "TiDB"),
            ("oceanbase_mysql", "OceanBase（MySQL 模式）"),
            ("doris", "Apache Doris"),
            ("starrocks", "StarRocks"),
            ("aurora_mysql", "Amazon Aurora MySQL"),
            ("aurora_pg", "Amazon Aurora PostgreSQL"),
            ("cockroach", "CockroachDB"),
            ("sqlserver", "SQL Server"),
            ("mongodb", "MongoDB"),
            ("oracle", "Oracle"),
            ("clickhouse", "ClickHouse"),
        ] {
            let engine = find(id).unwrap_or_else(|| panic!("{id} 必须仍在注册表里"));
            assert!(!engine.is_listed(), "{id} 不应出现在新建连接列表");
            assert_eq!(engine.product, product, "{id} 的产品名不能被改写");
            assert!(
                engine
                    .hidden_reason()
                    .is_some_and(|reason| !reason.is_empty()),
                "{id} 必须说明为什么不在列表里"
            );
        }
        // 有驱动的隐藏产品仍然可用：老配置能连上，能力没有被清空。
        assert!(is_supported("tidb"));
        assert!(find("tidb").unwrap().capabilities.query.is_available());
    }

    /// 回归：`config_only(sqlite)` 曾把 SQLite 的全部能力覆盖成"尚未适配"。
    #[test]
    fn sqlite_declares_its_real_capabilities() {
        let sqlite = find("sqlite").expect("sqlite registered");
        assert!(sqlite.is_implemented());
        for cap in [
            &sqlite.capabilities.query,
            &sqlite.capabilities.cancel,
            &sqlite.capabilities.transaction,
            &sqlite.capabilities.table_browse,
            &sqlite.capabilities.keyset_pagination,
            &sqlite.capabilities.table_edit,
            &sqlite.capabilities.schema_edit,
            &sqlite.capabilities.view_edit,
            &sqlite.capabilities.export,
        ] {
            assert!(
                cap.is_available(),
                "SQLite 的这些链路已接入，不能被 config_only 覆盖：{:?}",
                cap
            );
        }
        // 受限范围必须写清楚：建库/删库与"原地改类型"确实不支持。
        let reason = sqlite.capabilities.schema_edit.reason().unwrap_or_default();
        assert!(reason.contains("建库/删库不支持"), "实际：{reason}");
        assert!(reason.contains("重建表"), "实际：{reason}");
    }

    /// PostgreSQL：执行/浏览/编辑/导出都已接通，但每项都有真实限制。
    #[test]
    fn postgres_capabilities_are_limited_with_reasons() {
        let postgres = find("postgres").expect("postgres registered");
        for (cap, label) in [
            (&postgres.capabilities.table_edit, "编辑表数据"),
            (&postgres.capabilities.schema_edit, "修改表结构"),
            (&postgres.capabilities.view_edit, "编辑视图"),
            (&postgres.capabilities.export, "导出"),
        ] {
            assert!(cap.is_available(), "PostgreSQL 的{label}已接入");
            assert!(
                cap.reason().is_some_and(|reason| !reason.is_empty()),
                "PostgreSQL 的{label}必须说明限制"
            );
        }
        // 结构和表数据浏览已经接线（metadata::* / table::browse 的 PostgreSQL 分支），
        // 这里放开入口；"有没有实机验证"由 `verified` 单独记录，不混进能力位。
        assert!(postgres.capabilities.query.is_available());
        assert!(postgres.capabilities.table_browse.is_available());
        // 六个集成用例覆盖连接/查询/浏览/编辑/DDL/导出/服务端只读，够 Manage；
        // 没做的改表、自定义 SQL 导出、TLS 必须在 notes 里点名。
        assert_eq!(
            postgres.verified[0].level,
            VerifiedLevel::Manage,
            "实机验证到编辑/DDL/导出/只读后才允许写 Manage"
        );
        assert!(
            postgres.verified[0].notes.contains("未验证"),
            "未验证的部分必须写出来"
        );
        // 自定义 SQL 导出确实没接：SQL 工作区的导出按钮据此禁用。
        assert!(
            !postgres.capabilities.export_sql.is_available(),
            "PostgreSQL 的自定义 SQL 导出未接入，不能开放"
        );
        assert!(
            postgres.capabilities.export_sql.reason().is_some(),
            "禁用的导出必须说明原因"
        );
    }

    /// 自定义 SQL 导出是**独立链路**：只有走 MySQL 导出池的引擎接了，
    /// 其它引擎必须在能力位上禁用并说明原因，不能靠后端报错兜底。
    #[test]
    fn export_sql_is_only_claimed_where_the_chain_exists() {
        for id in [
            "mysql",
            "mariadb",
            "tidb",
            "oceanbase_mysql",
            "aurora_mysql",
            "doris",
            "starrocks",
        ] {
            let engine = find(id).expect("registered");
            assert!(
                engine.capabilities.export_sql.is_available(),
                "{id} 复用 MySQL 导出池，自定义 SQL 导出应可用"
            );
        }
        for id in ["postgres", "sqlite", "redis"] {
            let engine = find(id).expect("registered");
            let cap = &engine.capabilities.export_sql;
            assert!(
                !cap.is_available(),
                "{id} 的自定义 SQL 导出未接入，不能开放"
            );
            assert!(
                cap.reason().is_some_and(|reason| !reason.is_empty()),
                "{id} 必须说明为什么不能导出"
            );
        }
        // 两个口径不能互相顶替：PG 能按表导出，但不能导出自定义 SQL。
        let postgres = find("postgres").expect("registered");
        assert!(postgres.capabilities.export.is_available());
        assert!(!postgres.capabilities.export_sql.is_available());
    }

    /// `limited` 的语义是"能用但有边界"，界面会照着它放行。把"还没实现"写成
    /// `limited`，用户点下去只会拿到一条失败——这正是本次收敛要修掉的那类错。
    #[test]
    fn unimplemented_work_is_never_declared_as_limited() {
        // 只拦"未接入"这种结论式措辞；"未实机验证""语法差异"属于真实边界，允许。
        const FORBIDDEN: [&str; 3] = ["未接入", "尚未接入", "没接"];

        for engine in registry() {
            let caps = &engine.capabilities;
            let pairs: [(&str, &Capability); 11] = [
                ("query", &caps.query),
                ("multiple_result_sets", &caps.multiple_result_sets),
                ("cancel", &caps.cancel),
                ("transaction", &caps.transaction),
                ("read_only_enforcement", &caps.read_only_enforcement),
                ("table_browse", &caps.table_browse),
                ("keyset_pagination", &caps.keyset_pagination),
                ("table_edit", &caps.table_edit),
                ("schema_edit", &caps.schema_edit),
                ("view_edit", &caps.view_edit),
                ("export", &caps.export),
            ];
            for (name, cap) in pairs
                .into_iter()
                .chain(std::iter::once(("export_sql", &caps.export_sql)))
            {
                let Capability::Limited { reason } = cap else {
                    continue;
                };
                for word in FORBIDDEN {
                    assert!(
                        !reason.contains(word),
                        "{} 的 {} 标成 limited，但原因写着「{word}」：{reason}",
                        engine.id,
                        name
                    );
                }
            }
        }
    }

    /// 前端按这套 JSON 结构写类型；键名或枚举值改了必须同步，否则界面会
    /// 静默显示"未知"（`engineMeta` 不再回落 MySQL）。
    #[test]
    fn catalog_json_contract_is_stable() {
        let mysql = serde_json::to_value(find("mysql").expect("mysql")).expect("serialize");
        assert_eq!(mysql["id"], "mysql");
        assert_eq!(mysql["family"], "mysql");
        assert_eq!(mysql["dialect"], "mysql");
        assert_eq!(mysql["transport"], "network");
        assert_eq!(mysql["implementation"], "implemented");
        assert_eq!(mysql["entry"]["state"], "listed");
        assert_eq!(mysql["default_port"], 3306);
        assert_eq!(mysql["fields"]["host"], true);
        assert_eq!(mysql["requirements"]["endpoint"], "host_port");
        assert_eq!(mysql["capabilities"]["query"]["state"], "supported");
        assert_eq!(mysql["dialect_rules"]["identifier_quote"], "backtick");
        assert_eq!(mysql["dialect_rules"]["max_ident_bytes"], 64);
        assert_eq!(mysql["verified"][0]["level"], "manage");

        // 隐藏的引擎会带一句给用户看的原因；前端据此解释"为什么列表里没有"。
        let tidb = serde_json::to_value(find("tidb").expect("tidb")).expect("serialize");
        assert_eq!(tidb["entry"]["state"], "hidden");
        assert!(tidb["entry"]["reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty()));

        let sqlite = serde_json::to_value(find("sqlite").expect("sqlite")).expect("serialize");
        assert_eq!(sqlite["transport"], "local_file");
        assert_eq!(sqlite["requirements"]["endpoint"], "file_path");
        assert_eq!(sqlite["options"][0]["key"], "path");
        assert_eq!(sqlite["options"][0]["kind"]["kind"], "path");
        assert_eq!(
            sqlite["capabilities"]["query"]["state"], "supported",
            "SQLite 有真实驱动，不能被写成未实现"
        );
        assert_eq!(sqlite["capabilities"]["table_browse"]["state"], "supported");
        assert_eq!(sqlite["entry"]["state"], "listed");
    }

    /// 逐项 DDL：同一个 `schema_edit` 之下必须能区分具体操作。
    ///
    /// 回归点：以前菜单只读 `schema_edit` 一个开关，SQLite 的"复制表"跟着
    /// 一起亮，点下去必然失败。
    #[test]
    fn ddl_operations_are_declared_per_action() {
        let mysql = find("mysql").expect("mysql");
        for (name, capability) in [
            ("create_table", &mysql.ddl_operations.create_table),
            ("rename_table", &mysql.ddl_operations.rename_table),
            ("copy_table", &mysql.ddl_operations.copy_table),
            ("truncate_table", &mysql.ddl_operations.truncate_table),
            ("drop_table", &mysql.ddl_operations.drop_table),
            ("alter_columns", &mysql.ddl_operations.alter_columns),
            ("create_view", &mysql.ddl_operations.create_view),
            ("drop_view", &mysql.ddl_operations.drop_view),
        ] {
            assert!(capability.is_available(), "MySQL 的 {name} 已接入");
        }

        let sqlite = find("sqlite").expect("sqlite");
        assert!(sqlite.ddl_operations.rename_table.is_available());
        assert!(!sqlite.ddl_operations.copy_table.is_available());
        assert!(
            sqlite
                .ddl_operations
                .copy_table
                .reason()
                .is_some_and(|reason| reason.contains("CREATE TABLE")),
            "SQLite 的复制表必须说明缺口，而不是笼统的「未支持」"
        );

        let postgres = find("postgres").expect("postgres");
        assert!(postgres.ddl_operations.drop_table.is_available());
        assert!(postgres.ddl_operations.copy_table.is_available());
        assert!(!postgres.ddl_operations.alter_columns.is_available());

        let redis = find("redis").expect("redis");
        assert!(!redis.ddl_operations.create_table.is_available());

        // JSON 契约：前端按 `ddl_operations.<op>.state` 读。
        let value = serde_json::to_value(mysql).expect("serialize");
        assert!(value["ddl_operations"]["copy_table"]["state"].is_string());
        assert!(value["ddl_operations"]["truncate_table"].is_object());
    }

    #[test]
    fn capabilities_never_report_a_bare_false() {
        for engine in all() {
            for cap in [
                &engine.capabilities.query,
                &engine.capabilities.cancel,
                &engine.capabilities.table_edit,
                &engine.capabilities.schema_edit,
                &engine.capabilities.export,
            ] {
                if !cap.is_available() {
                    assert!(
                        cap.reason().is_some(),
                        "{} 的禁用能力必须说明原因",
                        engine.id
                    );
                }
            }
        }
    }
}
