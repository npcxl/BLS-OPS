//! 引擎执行层适配器：驱动系列 + 方言 + 表对象 SQL 模板。
//!
//! 分工：
//!
//! | 层 | 回答的问题 |
//! |---|---|
//! | `SqlDialect` | 一个标识符/字面量/分页怎么写 |
//! | `AdapterSet` | 这条表对象操作用什么语句（含"这个引擎做不到"） |
//!
//! 规则：
//!
//! * 做不到就返回 `unsupported` 并说明原因，不返回一条"看起来像"的语句；
//!   用户宁可看到明确拒绝，也不要看到执行到一半的 DDL。
//! * 语义有必然偏差（SQLite 的 `CREATE TABLE … AS SELECT` 丢约束）时，
//!   用 `StatementPlan::note` 交给界面展示，不静默。
//! * 限定名目前沿用 MySQL 的 `database.table` 两段语义。PostgreSQL / SQL Server
//!   的 database/schema 分层在批次 3 接入驱动时统一，这里**不猜**。
//! * 所有语句只由验证过的元数据（库名/表名）拼出来，前端传不了 SQL。

use super::super::capability::DriverFamily;
use super::super::engine_registry;
use super::super::model::DbErrorInfo;
use super::SqlDialect;

/// 一次表对象操作要执行的语句，以及该引擎下的必要说明。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementPlan {
    pub statements: Vec<String>,
    /// 引擎特有偏差（例如"SQLite 复制表不保留约束"），会合并进界面 warning。
    pub note: Option<String>,
}

impl StatementPlan {
    fn plain(statements: Vec<String>) -> Self {
        Self {
            statements,
            note: None,
        }
    }
}

/// 一个引擎的执行层适配器。
#[derive(Debug, Clone, Copy)]
pub struct AdapterSet {
    /// 具体产品 id（`mysql` / `tidb` / `doris` …）。同一驱动系列的产品差异
    /// 由 `engine_registry::mysql_product` 继续细分。
    engine_id: &'static str,
    dialect: SqlDialect,
    family: DriverFamily,
}

impl AdapterSet {
    /// 按引擎 id 取适配器。未注册的引擎返回 `unsupported`。
    pub fn of(engine_id: &str) -> Result<Self, DbErrorInfo> {
        let engine = engine_registry::find(engine_id).ok_or_else(|| {
            DbErrorInfo::new("unsupported", format!("未知的数据库类型：{engine_id}"))
        })?;
        Ok(Self {
            engine_id: engine.id,
            dialect: SqlDialect::new(engine.dialect, engine.dialect_rules),
            family: engine.family,
        })
    }

    /// MySQL 家族（现有多数调用点仍走这条路径）。
    pub fn mysql() -> Self {
        Self::of("mysql").expect("mysql 必须注册在引擎表里")
    }

    pub fn engine_id(&self) -> &'static str {
        self.engine_id
    }

    pub fn family(&self) -> DriverFamily {
        self.family
    }

    pub fn dialect(&self) -> &SqlDialect {
        &self.dialect
    }

    /// 重命名表或视图。
    pub fn rename_object(
        &self,
        schema: &str,
        name: &str,
        new_name: &str,
        is_view: bool,
    ) -> Result<StatementPlan, DbErrorInfo> {
        let old = self.dialect.qualified(Some(schema), name)?;
        let fresh = self.dialect.quote(new_name)?;
        let statement = match (self.family, is_view) {
            // MySQL / ClickHouse：视图也是表对象，RENAME TABLE 同时适用。
            (DriverFamily::MySql, _) | (DriverFamily::ClickHouse, _) => {
                format!(
                    "RENAME TABLE {old} TO {}",
                    self.dialect.qualified(Some(schema), new_name)?
                )
            }
            (DriverFamily::SqlServer, _) => {
                // sp_rename 的旧名是字符串里的对象名，不是标识符。
                format!(
                    "EXEC sp_rename {}, {}",
                    self.object_literal(schema, name),
                    self.dialect.string_literal(new_name)
                )
            }
            (DriverFamily::Postgres, true) => format!("ALTER VIEW {old} RENAME TO {fresh}"),
            (DriverFamily::Postgres, false) | (DriverFamily::Sqlite, false) => {
                format!("ALTER TABLE {old} RENAME TO {fresh}")
            }
            (DriverFamily::Sqlite, true) => {
                return Err(DbErrorInfo::new("unsupported", "SQLite 不支持重命名视图")
                    .with_detail("请删除后按原定义重建视图。"))
            }
            (DriverFamily::Oracle, false) => format!("ALTER TABLE {old} RENAME TO {fresh}"),
            (DriverFamily::Oracle, true) => {
                return Err(DbErrorInfo::new(
                    "unsupported",
                    "Oracle 的重命名视图只能用当前 schema 下的 RENAME 语句",
                )
                .with_detail("请在 SQL 编辑器里手动执行 RENAME，并确认当前 schema。"))
            }
            (DriverFamily::MongoDb, _) | (DriverFamily::Redis, _) => {
                return Err(no_sql_engine(self.family))
            }
        };
        Ok(StatementPlan::plain(vec![statement]))
    }

    /// 复制表结构 / 结构 + 数据。
    pub fn copy_table(
        &self,
        schema: &str,
        name: &str,
        new_name: &str,
        with_data: bool,
    ) -> Result<StatementPlan, DbErrorInfo> {
        let old = self.dialect.qualified(Some(schema), name)?;
        let new = self.dialect.qualified(Some(schema), new_name)?;
        match self.family {
            DriverFamily::MySql | DriverFamily::ClickHouse => {
                let mut statements = vec![format!("CREATE TABLE {new} LIKE {old}")];
                if with_data {
                    statements.push(format!("INSERT INTO {new} SELECT * FROM {old}"));
                }
                Ok(StatementPlan::plain(statements))
            }
            DriverFamily::Postgres => {
                let mut statements = vec![format!("CREATE TABLE {new} (LIKE {old} INCLUDING ALL)")];
                if with_data {
                    statements.push(format!("INSERT INTO {new} SELECT * FROM {old}"));
                }
                Ok(StatementPlan::plain(statements))
            }
            DriverFamily::Oracle => {
                let statement = if with_data {
                    format!("CREATE TABLE {new} AS SELECT * FROM {old}")
                } else {
                    format!("CREATE TABLE {new} AS SELECT * FROM {old} WHERE 1 = 0")
                };
                Ok(StatementPlan {
                    statements: vec![statement],
                    note: Some("CREATE TABLE … AS SELECT 不复制主键、索引与非空约束".to_string()),
                })
            }
            DriverFamily::SqlServer => {
                let filter = if with_data { "" } else { " WHERE 1 = 0" };
                Ok(StatementPlan {
                    statements: vec![format!("SELECT * INTO {new} FROM {old}{filter}")],
                    note: Some("SELECT … INTO 不复制主键、索引与默认值约束".to_string()),
                })
            }
            DriverFamily::Sqlite => {
                if !with_data {
                    return Err(DbErrorInfo::new("unsupported", "SQLite 不支持只复制表结构")
                        .with_detail(
                        "SQLite 没有 CREATE TABLE … LIKE：请先手动建空表，或用 SQL 编辑器执行。",
                    ));
                }
                Ok(StatementPlan {
                    statements: vec![format!("CREATE TABLE {new} AS SELECT * FROM {old}")],
                    note: Some(
                        "SQLite 用 CREATE TABLE … AS SELECT 复制：列类型靠推导，主键/索引/约束不会复制"
                            .to_string(),
                    ),
                })
            }
            DriverFamily::MongoDb | DriverFamily::Redis => Err(no_sql_engine(self.family)),
        }
    }

    /// 删除表或视图。
    pub fn drop_object(
        &self,
        schema: &str,
        name: &str,
        is_view: bool,
    ) -> Result<StatementPlan, DbErrorInfo> {
        if matches!(self.family, DriverFamily::MongoDb | DriverFamily::Redis) {
            return Err(no_sql_engine(self.family));
        }
        let qualified = self.dialect.qualified(Some(schema), name)?;
        let object = if is_view { "VIEW" } else { "TABLE" };
        Ok(StatementPlan::plain(vec![format!(
            "DROP {object} {qualified}"
        )]))
    }

    /// 清空表数据，保留结构。
    pub fn truncate_table(&self, schema: &str, name: &str) -> Result<StatementPlan, DbErrorInfo> {
        let qualified = self.dialect.qualified(Some(schema), name)?;
        match self.family {
            // SQLite 没有 TRUNCATE：DELETE 语义等价，但代价不同，必须说清楚。
            DriverFamily::Sqlite => Ok(StatementPlan {
                statements: vec![format!("DELETE FROM {qualified}")],
                note: Some(
                    "SQLite 没有 TRUNCATE：已改用 DELETE FROM，大表较慢，空间需要 VACUUM 回收"
                        .to_string(),
                ),
            }),
            DriverFamily::MongoDb | DriverFamily::Redis => Err(no_sql_engine(self.family)),
            _ => Ok(StatementPlan::plain(vec![format!(
                "TRUNCATE TABLE {qualified}"
            )])),
        }
    }

    /// 只取前 N 字节的表达式（大字段投影预算）。
    pub fn left_bytes(&self, column_sql: &str, bytes: usize) -> String {
        match self.family {
            DriverFamily::Sqlite | DriverFamily::Oracle => {
                format!("SUBSTR({column_sql}, 1, {bytes})")
            }
            _ => format!("LEFT({column_sql}, {bytes})"),
        }
    }

    /// 列的真实**字节**长度表达式（不是字符数）。
    pub fn octet_length(&self, column_sql: &str) -> String {
        match self.family {
            DriverFamily::Sqlite => format!("LENGTH(CAST({column_sql} AS BLOB))"),
            DriverFamily::SqlServer => format!("DATALENGTH({column_sql})"),
            DriverFamily::Oracle => format!("LENGTHB({column_sql})"),
            _ => format!("OCTET_LENGTH({column_sql})"),
        }
    }

    /// LIKE 的转义子句。
    ///
    /// MySQL 里 `'\\'` 是一个反斜杠（反斜杠本身是转义符），标准 SQL 里
    /// `'\\'` 是两个字符，`ESCAPE` 会直接报错。
    pub fn like_escape(&self) -> &'static str {
        if self.dialect.rules().backslash_escapes {
            "ESCAPE '\\\\'"
        } else {
            "ESCAPE '\\'"
        }
    }

    /// 只读事务的开启语句。
    ///
    /// - `Ok(Some(sql))`：先在服务器上开启只读事务，写语句会被服务器拒绝。
    /// - `Ok(None)`：产品没有只读事务（Doris/StarRocks），导出继续，但**没有**
    ///   服务器保障；调用方必须自己确认语句只读。能力矩阵里已标为受限。
    /// - `Err(..)`：没有任何安全的导出方式，明确拒绝。
    pub fn begin_read_only_transaction(&self) -> Result<Option<&'static str>, DbErrorInfo> {
        match self.family {
            DriverFamily::MySql => {
                match engine_registry::mysql_product(self.engine_id)
                    .map(|profile| profile.read_only)
                {
                    Some(super::super::capability::ReadOnlyMode::ClientOnly) => Ok(None),
                    _ => Ok(Some("START TRANSACTION READ ONLY")),
                }
            }
            DriverFamily::Postgres => Ok(Some("START TRANSACTION READ ONLY")),
            DriverFamily::Oracle => Ok(Some("SET TRANSACTION READ ONLY")),
            DriverFamily::Sqlite => Err(DbErrorInfo::new(
                "unsupported",
                "SQLite 没有只读事务：无法保证导出语句不写数据",
            )
            .with_detail("请用只读文件权限或只读账号导出，或在 SQL 编辑器里自行确认语句只读。")),
            DriverFamily::SqlServer => Err(DbErrorInfo::new(
                "unsupported",
                "SQL Server 没有只读事务：导出前请确认账号无写权限",
            )),
            DriverFamily::ClickHouse | DriverFamily::MongoDb | DriverFamily::Redis => {
                Err(DbErrorInfo::new(
                    "unsupported",
                    format!("{} 不支持 SQL 只读事务", self.dialect.dialect_name()),
                ))
            }
        }
    }

    /// null-safe 等值比较（乐观并发用）。
    ///
    /// MySQL 是 `<=>`；标准 SQL 是 `IS NOT DISTINCT FROM`；SQL Server 两者都没有，
    /// 只能展开成 `(a = b OR (a IS NULL AND b IS NULL))`。
    pub fn null_safe_equal(&self, left: &str, right: &str) -> String {
        match self.family {
            DriverFamily::MySql => format!("{left} <=> {right}"),
            DriverFamily::SqlServer => {
                format!("({left} = {right} OR ({left} IS NULL AND {right} IS NULL))")
            }
            _ => format!("{left} IS NOT DISTINCT FROM {right}"),
        }
    }

    /// 显式开启事务的语句。MySQL 用 `START TRANSACTION`，其余标准 SQL 用 `BEGIN`。
    pub fn begin_transaction(&self) -> &'static str {
        match self.family {
            DriverFamily::MySql => "START TRANSACTION",
            _ => "BEGIN",
        }
    }

    /// 这个引擎的写操作是否**默认**事务安全。
    ///
    /// MySQL 要看存储引擎（MyISAM 不支持事务），所以这里返回 `false`，
    /// 由调用方叠加 `engine` 字段判断；PostgreSQL/SQLite/SQL Server/Oracle
    /// 一律事务安全；ClickHouse 没有单行事务语义。
    pub fn transactional_writes(&self) -> bool {
        matches!(
            self.family,
            DriverFamily::Postgres
                | DriverFamily::Sqlite
                | DriverFamily::SqlServer
                | DriverFamily::Oracle
        )
    }

    /// T-SQL 的 `sp_rename` 参数：`N'schema.name'`。其它引擎用普通字符串字面量。
    fn object_literal(&self, schema: &str, name: &str) -> String {
        let raw = if schema.trim().is_empty() {
            name.to_string()
        } else {
            format!("{schema}.{name}")
        };
        match self.family {
            DriverFamily::SqlServer => format!("N{}", self.dialect.string_literal(&raw)),
            _ => self.dialect.string_literal(&raw),
        }
    }
}

fn no_sql_engine(family: DriverFamily) -> DbErrorInfo {
    let product = match family {
        DriverFamily::MongoDb => "MongoDB",
        DriverFamily::Redis => "Redis",
        _ => "该引擎",
    };
    DbErrorInfo::new(
        "unsupported",
        format!("{product} 没有 SQL 表对象，不能执行该操作"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_table_operations_match_previous_statements() {
        let adapter = AdapterSet::mysql();
        assert_eq!(
            adapter
                .rename_object("db", "orders", "new`orders", false)
                .unwrap()
                .statements,
            vec!["RENAME TABLE `db`.`orders` TO `db`.`new``orders`".to_string()]
        );
        assert_eq!(
            adapter
                .copy_table("db", "orders", "copy", true)
                .unwrap()
                .statements,
            vec![
                "CREATE TABLE `db`.`copy` LIKE `db`.`orders`".to_string(),
                "INSERT INTO `db`.`copy` SELECT * FROM `db`.`orders`".to_string()
            ]
        );
        assert_eq!(
            adapter
                .copy_table("db", "orders", "copy", false)
                .unwrap()
                .statements,
            vec!["CREATE TABLE `db`.`copy` LIKE `db`.`orders`".to_string()]
        );
        assert_eq!(
            adapter
                .drop_object("db", "orders", true)
                .unwrap()
                .statements,
            vec!["DROP VIEW `db`.`orders`".to_string()]
        );
        assert_eq!(
            adapter.truncate_table("db", "orders").unwrap().statements,
            vec!["TRUNCATE TABLE `db`.`orders`".to_string()]
        );
    }

    #[test]
    fn postgres_uses_its_own_ddl_forms() {
        let adapter = AdapterSet::of("postgres").expect("pg registered");
        assert_eq!(
            adapter
                .rename_object("public", "orders", "orders_new", false)
                .unwrap()
                .statements,
            vec!["ALTER TABLE \"public\".\"orders\" RENAME TO \"orders_new\"".to_string()]
        );
        assert_eq!(
            adapter
                .rename_object("public", "orders_v", "orders_v2", true)
                .unwrap()
                .statements,
            vec!["ALTER VIEW \"public\".\"orders_v\" RENAME TO \"orders_v2\"".to_string()]
        );
        assert_eq!(
            adapter
                .copy_table("public", "orders", "orders_copy", true)
                .unwrap()
                .statements,
            vec![
                "CREATE TABLE \"public\".\"orders_copy\" (LIKE \"public\".\"orders\" INCLUDING ALL)"
                    .to_string(),
                "INSERT INTO \"public\".\"orders_copy\" SELECT * FROM \"public\".\"orders\""
                    .to_string()
            ]
        );
        assert!(adapter
            .copy_table("public", "orders", "orders_copy", true)
            .unwrap()
            .note
            .is_none());
    }

    #[test]
    fn sqlite_refuses_structure_only_copy_and_uses_delete() {
        let adapter = AdapterSet::of("sqlite").expect("sqlite registered");
        let error = adapter
            .copy_table("main", "orders", "orders_copy", false)
            .unwrap_err();
        assert_eq!(error.stage, "unsupported");

        let plan = adapter
            .copy_table("main", "orders", "orders_copy", true)
            .unwrap();
        assert_eq!(
            plan.statements,
            vec!["CREATE TABLE \"main\".\"orders_copy\" AS SELECT * FROM \"main\".\"orders\""]
        );
        assert!(plan.note.is_some(), "丢约束必须提示，不能静默");

        let truncate = adapter.truncate_table("main", "orders").unwrap();
        assert_eq!(truncate.statements, vec!["DELETE FROM \"main\".\"orders\""]);
        assert!(truncate.note.is_some());

        let error = adapter.rename_object("main", "v", "v2", true).unwrap_err();
        assert_eq!(error.stage, "unsupported");
    }

    #[test]
    fn sqlserver_rename_uses_string_object_name() {
        let adapter = AdapterSet::of("sqlserver").expect("sqlserver registered");
        let plan = adapter
            .rename_object("dbo", "order's", "order_new", false)
            .unwrap();
        assert_eq!(
            plan.statements,
            vec!["EXEC sp_rename N'dbo.order''s', 'order_new'".to_string()]
        );

        let plan = adapter
            .copy_table("dbo", "orders", "orders_copy", true)
            .unwrap();
        assert_eq!(
            plan.statements,
            vec!["SELECT * INTO [dbo].[orders_copy] FROM [dbo].[orders]".to_string()]
        );
    }

    #[test]
    fn key_value_engines_have_no_table_operations() {
        for id in ["mongodb", "redis"] {
            let adapter = AdapterSet::of(id).expect("registered");
            for error in [
                adapter.drop_object("db", "x", false).unwrap_err(),
                adapter.rename_object("db", "x", "y", false).unwrap_err(),
                adapter.copy_table("db", "x", "y", false).unwrap_err(),
                adapter.truncate_table("db", "x").unwrap_err(),
            ] {
                assert_eq!(error.stage, "unsupported", "{id}");
            }
        }
    }

    #[test]
    fn null_safe_comparison_is_per_family() {
        assert_eq!(AdapterSet::mysql().null_safe_equal("`a`", "?"), "`a` <=> ?");
        let pg = AdapterSet::of("postgres").unwrap();
        assert_eq!(
            pg.null_safe_equal("\"a\"", "$1"),
            "\"a\" IS NOT DISTINCT FROM $1"
        );
        let tsql = AdapterSet::of("sqlserver").unwrap();
        assert_eq!(
            tsql.null_safe_equal("[a]", "@p1"),
            "([a] = @p1 OR ([a] IS NULL AND @p1 IS NULL))"
        );
    }

    #[test]
    fn transaction_entry_and_capability_follow_the_family() {
        assert_eq!(AdapterSet::mysql().begin_transaction(), "START TRANSACTION");
        assert_eq!(
            AdapterSet::of("postgres").unwrap().begin_transaction(),
            "BEGIN"
        );
        // MySQL 的事务性取决于存储引擎，不能由方言直接断言。
        assert!(!AdapterSet::mysql().transactional_writes());
        assert!(AdapterSet::of("postgres").unwrap().transactional_writes());
        assert!(AdapterSet::of("sqlite").unwrap().transactional_writes());
        assert!(!AdapterSet::of("clickhouse").unwrap().transactional_writes());
    }

    #[test]
    fn read_only_transaction_is_rejected_where_it_does_not_exist() {
        assert_eq!(
            AdapterSet::mysql()
                .begin_read_only_transaction()
                .expect("mysql 支持只读事务"),
            Some("START TRANSACTION READ ONLY")
        );
        assert_eq!(
            AdapterSet::of("postgres")
                .unwrap()
                .begin_read_only_transaction()
                .unwrap(),
            Some("START TRANSACTION READ ONLY")
        );
        // Doris/StarRocks 没有只读事务：导出继续，但没有服务器保障。
        for id in ["doris", "starrocks"] {
            assert_eq!(
                AdapterSet::of(id)
                    .unwrap()
                    .begin_read_only_transaction()
                    .unwrap(),
                None,
                "{id}"
            );
        }
        for id in ["sqlite", "sqlserver", "clickhouse"] {
            assert_eq!(
                AdapterSet::of(id)
                    .unwrap()
                    .begin_read_only_transaction()
                    .unwrap_err()
                    .stage,
                "unsupported",
                "{id} 没有只读事务语义"
            );
        }
    }

    #[test]
    fn large_field_projection_is_per_family() {
        let mysql = AdapterSet::mysql();
        assert_eq!(mysql.left_bytes("`body`", 256), "LEFT(`body`, 256)");
        assert_eq!(mysql.octet_length("`body`"), "OCTET_LENGTH(`body`)");
        assert_eq!(mysql.like_escape(), "ESCAPE '\\\\'");

        let sqlite = AdapterSet::of("sqlite").unwrap();
        assert_eq!(
            sqlite.left_bytes("\"body\"", 256),
            "SUBSTR(\"body\", 1, 256)"
        );
        assert_eq!(
            sqlite.octet_length("\"body\""),
            "LENGTH(CAST(\"body\" AS BLOB))"
        );
        assert_eq!(sqlite.like_escape(), "ESCAPE '\\'");

        let tsql = AdapterSet::of("sqlserver").unwrap();
        assert_eq!(tsql.octet_length("[body]"), "DATALENGTH([body])");
    }

    #[test]
    fn unknown_engine_is_rejected() {
        assert!(AdapterSet::of("not-a-db").is_err());
    }
}
