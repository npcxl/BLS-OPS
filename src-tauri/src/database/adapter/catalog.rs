//! 系统目录查询模板：库 / 表 / 字段 / 索引 / 排序规则 / 表定义。
//!
//! 这一层只产出**SQL 文本**，不执行、不解析。解析在 `metadata` 里按列名进行，
//! 所以每个引擎的查询必须把列**别名成统一名字**（`name` / `charset` / `seq` …）：
//! 列顺序变了不会崩，缺列会得到 `None` 而不是错位取值。
//!
//! 规则：
//!
//! * 没有系统目录可查的引擎返回 `unsupported`，不编一条"看起来能用"的 SQL。
//! * PostgreSQL 的查询按 `pg_catalog` 写，由 `postgres_meta` 在 simple query
//!   文本协议上执行（占位符是 `$n`，不是 `?`）。这条链路**尚未在真实实例上
//!   验证**；验证状态看引擎注册表的 `verified`，不要因为这里返回了语句就当
//!   功能已验证。
//! * 表名/库名一律走参数绑定，不拼进 SQL；只有 `SHOW CREATE TABLE` 这种
//!   不支持参数的语句使用方言引用后的标识符。

use super::super::capability::DriverFamily;
use super::super::model::DbErrorInfo;
use super::AdapterSet;

pub struct CatalogQueries {
    engine_id: &'static str,
    family: DriverFamily,
}

impl CatalogQueries {
    pub fn of(adapter: &AdapterSet) -> Result<Self, DbErrorInfo> {
        match adapter.family() {
            DriverFamily::MySql | DriverFamily::Postgres => Ok(Self {
                engine_id: adapter.engine_id(),
                family: adapter.family(),
            }),
            other => Err(DbErrorInfo::new(
                "unsupported",
                format!("{} 的结构浏览尚未适配", family_name(other)),
            )
            .with_detail("当前版本提供 MySQL/MariaDB 与 PostgreSQL 的库表浏览。")),
        }
    }

    /// 库列表。无参数。
    pub fn databases(&self) -> &'static str {
        match self.family {
            DriverFamily::MySql => {
                r#"
                SELECT SCHEMA_NAME AS name,
                       DEFAULT_CHARACTER_SET_NAME AS charset,
                       DEFAULT_COLLATION_NAME AS collation
                FROM information_schema.SCHEMATA
                ORDER BY SCHEMA_NAME
                "#
            }
            _ => {
                r#"
                SELECT datname AS name,
                       pg_encoding_to_char(encoding) AS charset,
                       datcollate AS collation
                FROM pg_database
                WHERE NOT datistemplate
                ORDER BY datname
                "#
            }
        }
    }

    /// 界面上的"库"这一层。
    ///
    /// MySQL 里 database 就是表容器；PostgreSQL 里连接已绑定一个 database，
    /// 真正装表的是 **schema**。所以 PG 返回 schema 列表（`public` + 用户 schema）：
    /// 跨 database 不可查，展示一堆点不开的库名只会误导。
    pub fn schemas(&self) -> &'static str {
        match self.family {
            DriverFamily::MySql => self.databases(),
            _ => {
                r#"
                SELECT nspname AS name,
                       NULL::text AS charset,
                       NULL::text AS collation
                FROM pg_namespace
                WHERE nspname NOT LIKE 'pg_%'
                  AND nspname <> 'information_schema'
                ORDER BY nspname
                "#
            }
        }
    }

    /// 表/视图列表。参数：schema。
    pub fn tables(&self) -> &'static str {
        match self.family {
            DriverFamily::MySql => {
                r#"
                SELECT TABLE_NAME AS name,
                       TABLE_TYPE AS table_type,
                       ENGINE AS engine,
                       TABLE_ROWS AS estimated_rows,
                       TABLE_COMMENT AS comment
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = ?
                ORDER BY TABLE_NAME
                "#
            }
            _ => {
                r#"
                SELECT c.relname AS name,
                       CASE c.relkind
                            WHEN 'v' THEN 'VIEW'
                            WHEN 'm' THEN 'MATERIALIZED VIEW'
                            ELSE 'BASE TABLE'
                       END AS table_type,
                       NULL::text AS engine,
                       GREATEST(c.reltuples, 0)::bigint AS estimated_rows,
                       COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1
                  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                ORDER BY c.relname
                "#
            }
        }
    }

    /// 单表元信息（类型 / 引擎 / 估算行数 / 排序规则 / 注释）。参数：schema, table。
    pub fn table_detail(&self) -> &'static str {
        match self.family {
            DriverFamily::MySql => {
                r#"
                SELECT TABLE_TYPE AS table_type,
                       ENGINE AS engine,
                       TABLE_ROWS AS estimated_rows,
                       TABLE_COLLATION AS collation,
                       TABLE_COMMENT AS comment
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                LIMIT 1
                "#
            }
            _ => {
                r#"
                SELECT CASE c.relkind
                            WHEN 'v' THEN 'VIEW'
                            WHEN 'm' THEN 'MATERIALIZED VIEW'
                            ELSE 'BASE TABLE'
                       END AS table_type,
                       NULL::text AS engine,
                       GREATEST(c.reltuples, 0)::bigint AS estimated_rows,
                       NULL::text AS collation,
                       COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2
                  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                LIMIT 1
                "#
            }
        }
    }

    /// 字段。参数：schema, table。列集见 `metadata::columns_from_rows`。
    pub fn columns(&self) -> &'static str {
        match self.family {
            DriverFamily::MySql => {
                r#"
                SELECT COLUMN_NAME AS name,
                       ORDINAL_POSITION AS ordinal,
                       DATA_TYPE AS data_type,
                       COLUMN_TYPE AS column_type,
                       IS_NULLABLE AS nullable,
                       COLUMN_DEFAULT AS default_value,
                       EXTRA AS extra,
                       CHARACTER_SET_NAME AS charset,
                       COLLATION_NAME AS collation,
                       COLUMN_COMMENT AS comment
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION
                "#
            }
            _ => {
                r#"
                SELECT a.attname AS name,
                       a.attnum AS ordinal,
                       t.typname AS data_type,
                       format_type(a.atttypid, a.atttypmod) AS column_type,
                       CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
                       pg_get_expr(d.adbin, d.adrelid) AS default_value,
                       CASE
                            WHEN a.attidentity <> '' THEN 'IDENTITY'
                            WHEN d.adbin IS NOT NULL
                                 AND (pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%'
                                      OR pg_get_expr(d.adbin, d.adrelid) LIKE 'now()%'
                                      OR pg_get_expr(d.adbin, d.adrelid) LIKE 'CURRENT_TIMESTAMP%')
                                THEN 'DEFAULT_GENERATED'
                            ELSE ''
                       END AS extra,
                       NULL::text AS charset,
                       NULL::text AS collation,
                       COALESCE(col_description(a.attrelid, a.attnum), '') AS comment
                FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_type t ON t.oid = a.atttypid
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE n.nspname = $1 AND c.relname = $2
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attnum
                "#
            }
        }
    }

    /// 索引。参数：schema, table。
    ///
    /// `is_primary` 必须由目录给出：MySQL 的主键索引叫 `PRIMARY`，PostgreSQL
    /// 叫 `<table>_pkey`，不能靠名字猜。
    pub fn indexes(&self) -> &'static str {
        match self.family {
            DriverFamily::MySql => {
                r#"
                SELECT INDEX_NAME AS name,
                       NON_UNIQUE AS non_unique,
                       SEQ_IN_INDEX AS seq,
                       COLUMN_NAME AS column_name,
                       SUB_PART AS sub_part,
                       COLLATION AS collation,
                       INDEX_TYPE AS index_type,
                       CASE WHEN INDEX_NAME = 'PRIMARY' THEN 1 ELSE 0 END AS is_primary
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                ORDER BY INDEX_NAME, SEQ_IN_INDEX
                "#
            }
            _ => {
                r#"
                SELECT i.relname AS name,
                       CASE WHEN x.indisunique THEN 0 ELSE 1 END AS non_unique,
                       k.ord AS seq,
                       a.attname AS column_name,
                       NULL::integer AS sub_part,
                       CASE WHEN (x.indoption[k.ord - 1] & 1) = 1 THEN 'D' ELSE 'A' END AS collation,
                       am.amname AS index_type,
                       CASE WHEN x.indisprimary THEN 1 ELSE 0 END AS is_primary
                FROM pg_index x
                JOIN pg_class c ON c.oid = x.indrelid
                JOIN pg_class i ON i.oid = x.indexrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_am am ON am.oid = i.relam
                JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
                LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                WHERE n.nspname = $1 AND c.relname = $2
                ORDER BY i.relname, k.ord
                "#
            }
        }
    }

    /// 只读的"表是否存在/类型"。参数：schema, table。
    pub fn table_identity(&self) -> &'static str {
        match self.family {
            DriverFamily::MySql => {
                r#"
                SELECT TABLE_TYPE AS table_type, ENGINE AS engine
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                LIMIT 1
                "#
            }
            _ => {
                r#"
                SELECT CASE c.relkind
                            WHEN 'v' THEN 'VIEW'
                            WHEN 'm' THEN 'MATERIALIZED VIEW'
                            ELSE 'BASE TABLE'
                       END AS table_type,
                       NULL::text AS engine
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2
                  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                LIMIT 1
                "#
            }
        }
    }

    /// 排序规则列表。没有这个概念时返回 `None`（界面据此隐藏下拉框）。
    pub fn collations(&self) -> Option<&'static str> {
        match self.family {
            DriverFamily::MySql => {
                Some("SELECT COLLATION_NAME AS collation_name FROM information_schema.COLLATIONS ORDER BY COLLATION_NAME")
            }
            _ => Some("SELECT collname AS collation_name FROM pg_collation ORDER BY collname"),
        }
    }

    /// "查看表定义"的语句。PostgreSQL 没有等价单语句，返回 `None`
    /// （详情面板不显示定义，而不是显示一段编造的 DDL）。
    pub fn create_table_statement(&self, qualified: &str) -> Option<String> {
        match self.family {
            DriverFamily::MySql => Some(format!("SHOW CREATE TABLE {qualified}")),
            _ => None,
        }
    }

    /// 系统库判定。MySQL 家族按产品给名单（TiDB 有 `metrics_schema`、
    /// OceanBase 有 `oceanbase`、Doris/StarRocks 是另一套），PostgreSQL 用
    /// `pg_` 前缀。
    pub fn system_database(&self, name: &str) -> bool {
        match self.family {
            DriverFamily::MySql => super::super::engine_registry::mysql_product(self.engine_id)
                .map(|profile| profile.system_databases.contains(&name))
                .unwrap_or(false),
            _ => name == "information_schema" || name.starts_with("pg_"),
        }
    }
}

fn family_name(family: DriverFamily) -> &'static str {
    match family {
        DriverFamily::MySql => "MySQL",
        DriverFamily::Postgres => "PostgreSQL",
        DriverFamily::Sqlite => "SQLite",
        DriverFamily::SqlServer => "SQL Server",
        DriverFamily::Oracle => "Oracle",
        DriverFamily::MongoDb => "MongoDB",
        DriverFamily::ClickHouse => "ClickHouse",
        DriverFamily::Redis => "Redis",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(engine: &str) -> CatalogQueries {
        CatalogQueries::of(&AdapterSet::of(engine).expect("registered")).expect("catalog")
    }

    #[test]
    fn mysql_queries_keep_the_existing_shape() {
        let mysql = catalog("mysql");
        assert!(mysql.databases().contains("information_schema.SCHEMATA"));
        assert!(mysql.tables().contains("WHERE TABLE_SCHEMA = ?"));
        assert!(mysql.columns().contains("COLUMN_NAME AS name"));
        assert!(mysql.indexes().contains("AS is_primary"));
        assert!(mysql.system_database("mysql"));
        assert!(mysql.system_database("sys"));
        assert!(!mysql.system_database("ops_test"));
        assert_eq!(
            mysql.create_table_statement("`db`.`t`").as_deref(),
            Some("SHOW CREATE TABLE `db`.`t`")
        );
    }

    #[test]
    fn postgres_uses_pg_catalog_and_numbered_placeholders() {
        let pg = catalog("postgres");
        assert!(pg.databases().contains("pg_database"));
        assert!(pg.tables().contains("n.nspname = $1"));
        assert!(pg.columns().contains("pg_attribute"));
        assert!(pg.indexes().contains("x.indisprimary"));
        assert!(pg.system_database("pg_catalog"));
        assert!(pg.system_database("information_schema"));
        assert!(!pg.system_database("public"));
        assert!(pg.create_table_statement("\"public\".\"t\"").is_none());
    }

    #[test]
    fn engines_without_a_catalog_are_rejected() {
        for id in [
            "sqlite",
            "sqlserver",
            "oracle",
            "clickhouse",
            "mongodb",
            "redis",
        ] {
            assert_eq!(
                CatalogQueries::of(&AdapterSet::of(id).unwrap())
                    .err()
                    .map(|error| error.stage),
                Some("unsupported".to_string()),
                "{id}"
            );
        }
    }
}
