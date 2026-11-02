//! 引擎注册表：产品标识、驱动系列、方言、字段要求、能力与"验证到哪一步"。
//!
//! 这是**唯一**一份引擎清单：
//!
//! * 配置校验按这里的 `requirements` 走，不再要求每个数据库都有 host/port；
//! * 连接入口按 `implementation` 拒绝，未适配的引擎连不上就明说；
//! * `db_engines_catalog` 把它原样发给前端，界面不再自己维护一份。
//!
//! **不要把"注册了"当成"支持了"**：`Implementation::ConfigOnly` 只代表配置
//! 能保存。真实驱动接进来时才改成 `Implemented`，并且必须同时补
//! `VerifiedScope`（在哪个版本、验证到哪一步、还有什么没验证）。

use std::sync::OnceLock;

use super::capability::{
    Capability, CapabilitySet, Dialect, DialectRules, DriverFamily, EndpointRequirement,
    EngineDescriptor, EngineFields, EngineRequirements, IdentifierQuote, Implementation,
    MySqlProductProfile, OptionField, OptionFieldKind, Transport, VerifiedLevel, VerifiedScope,
    AURORA_MYSQL_PROFILE, DORIS_PROFILE, MYSQL_STANDARD_PROFILE, OCEANBASE_MYSQL_PROFILE,
    STARROCKS_PROFILE, TIDB_PROFILE,
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
    }
}

/// Doris / StarRocks：MySQL 协议传输的 OLAP 产品，不能按 MySQL 全量能力开放。
fn olap_caps() -> CapabilitySet {
    CapabilitySet {
        query: Capability::Supported,
        multiple_result_sets: Capability::limited("一次只执行一条语句，没有多结果集"),
        cancel: Capability::limited("按 query id 取消，当前版本未接入"),
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
    }
}

/// SQLite：本地文件，SQL 执行链路已接通；结构浏览与编辑还没接。
fn sqlite_caps() -> CapabilitySet {
    CapabilitySet {
        query: Capability::Supported,
        multiple_result_sets: Capability::limited(
            "多语句逐条执行、每条一个结果集；没有协议层多结果集流",
        ),
        cancel: Capability::Supported,
        transaction: Capability::Supported,
        read_only_enforcement: Capability::Supported,
        table_browse: Capability::Supported,
        keyset_pagination: Capability::Supported,
        table_edit: Capability::unsupported("SQLite 单行编辑尚未接入"),
        schema_edit: Capability::unsupported("SQLite DDL 生成尚未接入"),
        view_edit: Capability::unsupported("SQLite 视图编辑尚未接入"),
        export: Capability::unsupported("SQLite 导出尚未接入"),
    }
}

fn redis_caps() -> CapabilitySet {
    CapabilitySet {
        query: Capability::unsupported("Redis 是键值引擎，不使用 SQL 工作区"),
        multiple_result_sets: Capability::unsupported("Redis 命令没有多结果集概念"),
        cancel: Capability::unsupported("Redis 命令不支持服务端取消，断开连接会中断会话"),
        transaction: Capability::limited("MULTI/EXEC 尚未接入界面"),
        read_only_enforcement: Capability::limited("只读模式尚未在服务端强制，仅界面提示"),
        table_browse: Capability::Supported,
        keyset_pagination: Capability::Supported,
        table_edit: Capability::Supported,
        schema_edit: Capability::unsupported("键值引擎没有表结构"),
        view_edit: Capability::unsupported("键值引擎没有视图"),
        export: Capability::limited("Redis 结果导出尚未接入"),
    }
}

fn config_only(mut engine: EngineDescriptor) -> EngineDescriptor {
    engine.capabilities =
        CapabilitySet::unimplemented(format!("{} 尚未适配：{}", engine.product, engine.note));
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
        default_port: Some(port),
        default_username: None,
        fields,
        requirements,
        options,
        capabilities: CapabilitySet::unimplemented("尚未适配"),
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
    let mut engines: Vec<EngineDescriptor> = Vec::new();

    // ---- 已有真实驱动 -----------------------------------------------------
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
    engines.push(mysql);

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
        versions: "—".to_string(),
        level: VerifiedLevel::DriverOnly,
        notes: "复用 mysql_async 的连接/查询/元数据链路；尚未在真实 MariaDB 实例上跑完整链路"
            .to_string(),
    }];
    engines.push(mariadb);

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

    // ---- 批次 2：MySQL 协议兼容产品（复用驱动，差异由 MySqlProductProfile 承载）----
    //
    // 默认端口按各产品官方文档：TiDB 4000、OceanBase（MySQL 模式）2881、
    // Doris/StarRocks 的 MySQL 协议入口 9030、Aurora MySQL 3306。
    // 用户始终可以覆盖端口。
    for (id, product, port, note) in [
        (
            "tidb",
            "TiDB",
            4000,
            "MySQL 协议，默认端口 4000；复用 mysql_async，事务与 DDL 差异按版本验证",
        ),
        (
            "oceanbase_mysql",
            "OceanBase（MySQL 模式）",
            2881,
            "MySQL 模式默认端口 2881，系统库含 oceanbase；跨版本兼容性未验证",
        ),
        (
            "doris",
            "Apache Doris",
            9030,
            "MySQL 协议入口默认 9030；无跨语句事务、无只读事务；行编辑仅 INSERT",
        ),
        (
            "starrocks",
            "StarRocks",
            9030,
            "MySQL 协议入口默认 9030；无跨语句事务、无只读事务；行编辑仅 INSERT",
        ),
        (
            "aurora_mysql",
            "Amazon Aurora MySQL",
            3306,
            "MySQL 8.0 兼容；差异在托管端点、TLS 证书与只读副本",
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
        engines.push(engine);
    }

    // ---- 批次 3：PostgreSQL 家族 + SQLite ---------------------------------
    engines.push(config_only(postgres_family(
        "postgres",
        "PostgreSQL",
        "批次 3：tokio-postgres；simple query 与参数化查询分两条路径",
    )));
    engines.push(config_only(postgres_family(
        "cockroach",
        "CockroachDB",
        "批次 3：复用 PostgreSQL 协议驱动；系统表、事务重试与 DDL 差异单独适配",
    )));
    engines.push(config_only(postgres_family(
        "aurora_pg",
        "Amazon Aurora PostgreSQL",
        "批次 3：复用 PostgreSQL 协议驱动；托管端点的 TLS 与故障转移单独验证",
    )));

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
        level: VerifiedLevel::Query,
        notes: "本地临时库验证了打开已有文件/拒绝创建/只读打开/查询类型/行数预算/多语句逐条执行；\
                结构浏览、表编辑、DDL 与导出尚未接入，取消仅有驱动 interrupt 实现"
            .to_string(),
    }];
    engines.push(config_only(sqlite));

    // ---- 批次 4：独立驱动 ------------------------------------------------
    engines.push(config_only(network(
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
        "批次 4：独立 TDS 驱动；取消与 TLS 需单独评估",
    )));
    engines.push(config_only(network(
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
        "批次 4 末尾：先比较 OCI/Instant Client 与纯 Rust 路线（认证/TLS/LOB/取消/部署成本）",
    )));
    engines.push(config_only(network(
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
        "批次 4：文档模型，独立工作区；不接入 SQL 编辑器与表结构编辑",
    )));
    engines.push(config_only(network(
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
        "批次 4：优先 HTTP 接口（含 query_id 取消），原生 TCP 后续评估",
    )));

    engines
}

fn registry() -> &'static Vec<EngineDescriptor> {
    static REGISTRY: OnceLock<Vec<EngineDescriptor>> = OnceLock::new();
    REGISTRY.get_or_init(build)
}

/// 全部引擎，顺序即界面顺序：先能用的，再配置可保存的。
pub fn all() -> &'static [EngineDescriptor] {
    registry().as_slice()
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
        return Err(DbErrorInfo::new(
            "unsupported",
            format!(
                "{} 尚未适配：配置可以保存，但当前版本还不能连接",
                engine.product
            ),
        )
        .with_detail(engine.note));
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
            "tidb",
            "oceanbase_mysql",
            "aurora_mysql",
            "doris",
            "starrocks",
        ] {
            assert!(is_supported(id), "{id} 应有真实驱动");
        }
        for id in [
            "postgres",
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
        assert!(oracle.note.contains("批次 4"));
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
        assert_eq!(mysql["default_port"], 3306);
        assert_eq!(mysql["fields"]["host"], true);
        assert_eq!(mysql["requirements"]["endpoint"], "host_port");
        assert_eq!(mysql["capabilities"]["query"]["state"], "supported");
        assert_eq!(mysql["dialect_rules"]["identifier_quote"], "backtick");
        assert_eq!(mysql["dialect_rules"]["max_ident_bytes"], 64);
        assert_eq!(mysql["verified"][0]["level"], "manage");

        let sqlite = serde_json::to_value(find("sqlite").expect("sqlite")).expect("serialize");
        assert_eq!(sqlite["transport"], "local_file");
        assert_eq!(sqlite["requirements"]["endpoint"], "file_path");
        assert_eq!(sqlite["options"][0]["key"], "path");
        assert_eq!(sqlite["options"][0]["kind"]["kind"], "path");
        assert_eq!(
            sqlite["capabilities"]["query"]["state"], "unsupported",
            "没有驱动就不能允许执行 SQL"
        );
        assert!(sqlite["capabilities"]["query"]["reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty()));
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
