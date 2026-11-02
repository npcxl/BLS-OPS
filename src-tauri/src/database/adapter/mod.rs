//! SQL 方言原语：标识符引用、字符串字面量、分页、占位符、只读语句判定。
//!
//! 这些函数**不做任何 I/O**，所以能完整单测 —— 这也是把它们从 `driver`
//! （连接/TLS/错误映射）里拆出来的原因：连接要实例，方言不需要。
//!
//! 规则来源是 `engine_registry` 里的 `DialectRules`：调用方按引擎取一次
//! `SqlDialect`，之后只跟这个类型打交道，不再出现 `if engine == "mysql"`。
//!
//! **不是安全边界**：标识符来自验证后的元数据，值一律走参数绑定。
//! 这里的 `string_literal` 只用于"预览 / 复制为 SQL / DDL 默认值"这类
//! 必须生成文本的地方。
//!
//! 目录：
//!
//! | 文件 | 职责 |
//! |---|---|
//! | `adapter/mod.rs` | `SqlDialect`：标识符、字面量、占位符、分页、只读判定 |
//! | `adapter/engine.rs` | `AdapterSet`：按引擎族生成表对象 SQL（做不到就明确拒绝） |
//! | `adapter/catalog.rs` | `CatalogQueries`：系统目录查询（库/表/字段/索引/排序规则/表定义） |

pub mod catalog;
pub mod engine;

pub use catalog::CatalogQueries;
pub use engine::{AdapterSet, StatementPlan};

use super::capability::{Dialect, DialectRules, IdentifierQuote};
use super::engine_registry;
use super::model::DbErrorInfo;

/// 一个具体方言的 SQL 生成规则。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SqlDialect {
    dialect: Dialect,
    rules: DialectRules,
}

impl SqlDialect {
    pub fn new(dialect: Dialect, rules: DialectRules) -> Self {
        Self { dialect, rules }
    }

    /// 按引擎 id 取方言。未注册的引擎返回 `unsupported`，不做猜测。
    pub fn of(engine_id: &str) -> Result<Self, DbErrorInfo> {
        let engine = engine_registry::find(engine_id).ok_or_else(|| {
            DbErrorInfo::new("unsupported", format!("未知的数据库类型：{engine_id}"))
        })?;
        Ok(Self::new(engine.dialect, engine.dialect_rules))
    }

    /// MySQL 方言（现有多数调用点仍走这条路径）。
    pub fn mysql() -> Self {
        Self::of("mysql").expect("mysql 必须注册在引擎表里")
    }

    pub fn dialect(&self) -> Dialect {
        self.dialect
    }

    pub fn rules(&self) -> DialectRules {
        self.rules
    }

    /// 标识符引用。空串、含 NUL、超过方言上限都拒绝。
    pub fn quote(&self, name: &str) -> Result<String, DbErrorInfo> {
        if name.is_empty() {
            return Err(DbErrorInfo::new("query", "标识符不能为空"));
        }
        if name.contains('\0') {
            return Err(DbErrorInfo::new("query", "标识符包含非法字符"));
        }
        let max = usize::from(self.rules.max_ident_bytes);
        if max > 0 && name.len() > max {
            return Err(DbErrorInfo::new(
                "query",
                format!(
                    "标识符过长（{} 字节，{} 上限 {max}）",
                    name.len(),
                    self.dialect_name()
                ),
            ));
        }
        let (open, close) = match self.rules.identifier_quote {
            IdentifierQuote::Backtick => ('`', '`'),
            IdentifierQuote::DoubleQuote => ('"', '"'),
            IdentifierQuote::Bracket => ('[', ']'),
        };
        let escaped = name.replace(close, &format!("{close}{close}"));
        Ok(format!("{open}{escaped}{close}"))
    }

    /// 两级限定名。是否真的用 schema 由方言决定（MySQL 传库名）。
    pub fn qualified(&self, schema: Option<&str>, name: &str) -> Result<String, DbErrorInfo> {
        match schema.filter(|value| !value.trim().is_empty()) {
            Some(schema) => Ok(format!("{}.{}", self.quote(schema)?, self.quote(name)?)),
            None => self.quote(name),
        }
    }

    /// 字符串字面量。**只用于文本生成**；参数化查询请走绑定。
    pub fn string_literal(&self, value: &str) -> String {
        let escaped = if self.rules.backslash_escapes {
            value.replace('\\', "\\\\").replace('\'', "''")
        } else {
            value.replace('\'', "''")
        };
        format!("'{escaped}'")
    }

    /// 位置参数占位符。`index` 从 1 开始（PostgreSQL/Oracle 需要序号）。
    pub fn placeholder(&self, index: usize) -> String {
        match self.dialect {
            Dialect::Postgres => format!("${index}"),
            Dialect::TSql => format!("@p{index}"),
            Dialect::Oracle => format!(":{index}"),
            _ => "?".to_string(),
        }
    }

    /// 分页子句。`limit`/`offset` 必须是已经校验过的整数（不接受外部字符串）。
    ///
    /// SQL Server / Oracle 的 `OFFSET … FETCH NEXT` **要求先有 ORDER BY**，
    /// 调用方必须自己保证；这里不替它编一个假的排序。
    pub fn limit_offset(&self, limit: u64, offset: Option<u64>) -> Option<String> {
        let offset = offset.unwrap_or(0);
        match self.dialect {
            Dialect::None => None,
            Dialect::TSql | Dialect::Oracle => {
                let mut clause = format!("OFFSET {offset} ROWS");
                if limit > 0 {
                    clause.push_str(&format!(" FETCH NEXT {limit} ROWS ONLY"));
                }
                Some(clause)
            }
            _ => {
                let mut clause = format!("LIMIT {limit}");
                if offset > 0 {
                    clause.push_str(&format!(" OFFSET {offset}"));
                }
                Some(clause)
            }
        }
    }

    /// 语句是否"只读"。用于导出/危险操作提示的第一道筛选。
    ///
    /// 真正的只读保证来自服务端（只读事务 / 只读账号），这里只做保守判定：
    /// 认不出是读语句就当写语句。
    pub fn is_read_only_statement(&self, sql: &str) -> bool {
        let stripped = strip_leading_comments(sql, self.rules.hash_line_comment);
        if stripped.is_empty() {
            return false;
        }
        let keyword = stripped
            .split(|ch: char| ch.is_whitespace() || ch == '(' || ch == ';')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let lower = stripped.to_ascii_lowercase();
        // MySQL 的 SELECT … INTO OUTFILE 会写文件。
        if lower.contains("into outfile") || lower.contains("into dumpfile") {
            return false;
        }
        matches!(
            keyword.as_str(),
            "select"
                | "show"
                | "describe"
                | "desc"
                | "explain"
                | "table"
                | "values"
                | "with"
                // ClickHouse 的 EXISTS 也常作只读查询
                | "exists"
        )
    }

    fn dialect_name(&self) -> &'static str {
        match self.dialect {
            Dialect::MySql => "MySQL",
            Dialect::Postgres => "PostgreSQL",
            Dialect::Sqlite => "SQLite",
            Dialect::TSql => "SQL Server",
            Dialect::Oracle => "Oracle",
            Dialect::ClickHouse => "ClickHouse",
            Dialect::None => "非 SQL 引擎",
        }
    }
}

/// 位置参数与占位符的唯一来源。
///
/// 参数顺序一旦和占位符错位，写进去的就是别人的值（PostgreSQL 尤其危险：
/// `$2` 写在 `$1` 前面不会报错）。所以**不允许**"先拼 SQL 再补参数"：
/// `bind` 同时完成 push 与编号。
pub struct ParamBinder<'a, P> {
    dialect: &'a SqlDialect,
    pub params: Vec<P>,
}

impl<'a, P> ParamBinder<'a, P> {
    pub fn new(dialect: &'a SqlDialect) -> Self {
        Self {
            dialect,
            params: Vec::new(),
        }
    }

    /// 绑定一个参数，返回它在这条语句里的占位符。
    pub fn bind(&mut self, value: P) -> String {
        self.params.push(value);
        self.dialect.placeholder(self.params.len())
    }

    pub fn is_empty(&self) -> bool {
        self.params.is_empty()
    }

    pub fn into_params(self) -> Vec<P> {
        self.params
    }
}

/// 去掉开头的注释与空白，返回第一条语句的起始位置。
fn strip_leading_comments(sql: &str, hash_comment: bool) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(stripped) = rest.strip_prefix("--") {
            match stripped.find('\n') {
                Some(index) => rest = stripped[index + 1..].trim_start(),
                None => return "",
            }
        } else if hash_comment && rest.starts_with('#') {
            match rest.find('\n') {
                Some(index) => rest = rest[index + 1..].trim_start(),
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
    fn mysql_quoting_matches_existing_behaviour() {
        let sql = SqlDialect::mysql();
        assert_eq!(sql.quote("users").unwrap(), "`users`");
        assert_eq!(sql.quote("we`ird").unwrap(), "`we``ird`");
        assert!(sql.quote("").is_err());
        assert!(sql.quote(&"x".repeat(65)).is_err());
        assert!(sql.quote(&"x".repeat(64)).is_ok());
        assert_eq!(
            sql.qualified(Some("shop"), "orders").unwrap(),
            "`shop`.`orders`"
        );
        assert_eq!(sql.qualified(None, "orders").unwrap(), "`orders`");
    }

    #[test]
    fn postgres_uses_double_quotes_and_63_bytes() {
        let sql = SqlDialect::of("postgres").expect("pg registered");
        assert_eq!(sql.quote("user").unwrap(), "\"user\"");
        assert_eq!(sql.quote("we\"ird").unwrap(), "\"we\"\"ird\"");
        assert!(sql.quote(&"x".repeat(64)).is_err());
    }

    #[test]
    fn sqlserver_escapes_brackets() {
        let sql = SqlDialect::of("sqlserver").expect("sqlserver registered");
        assert_eq!(sql.quote("order").unwrap(), "[order]");
        assert_eq!(sql.quote("we]ird").unwrap(), "[we]]ird]");
    }

    #[test]
    fn string_literals_respect_backslash_mode() {
        let mysql = SqlDialect::mysql();
        assert_eq!(mysql.string_literal(r"a\b'c"), r"'a\\b''c'");
        let pg = SqlDialect::of("postgres").expect("pg");
        assert_eq!(pg.string_literal(r"a\b'c"), r"'a\b''c'");
    }

    #[test]
    fn placeholders_are_per_dialect() {
        assert_eq!(SqlDialect::mysql().placeholder(1), "?");
        assert_eq!(SqlDialect::of("postgres").unwrap().placeholder(2), "$2");
        assert_eq!(SqlDialect::of("sqlserver").unwrap().placeholder(3), "@p3");
        assert_eq!(SqlDialect::of("oracle").unwrap().placeholder(4), ":4");
    }

    #[test]
    fn pagination_is_per_dialect() {
        let mysql = SqlDialect::mysql();
        assert_eq!(mysql.limit_offset(100, None).as_deref(), Some("LIMIT 100"));
        assert_eq!(
            mysql.limit_offset(100, Some(200)).as_deref(),
            Some("LIMIT 100 OFFSET 200")
        );
        let pg = SqlDialect::of("postgres").unwrap();
        assert_eq!(
            pg.limit_offset(10, Some(5)).as_deref(),
            Some("LIMIT 10 OFFSET 5")
        );
        // SQL Server / Oracle 用 OFFSET … FETCH NEXT（需要调用方提供 ORDER BY）
        let tsql = SqlDialect::of("sqlserver").unwrap();
        assert_eq!(
            tsql.limit_offset(10, Some(20)).as_deref(),
            Some("OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY")
        );
        let oracle = SqlDialect::of("oracle").unwrap();
        assert_eq!(
            oracle.limit_offset(10, None).as_deref(),
            Some("OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY")
        );
        // Redis 没有 SQL 分页子句
        assert!(SqlDialect::of("redis")
            .unwrap()
            .limit_offset(10, None)
            .is_none());
    }

    #[test]
    fn read_only_classification_is_conservative() {
        let mysql = SqlDialect::mysql();
        assert!(mysql.is_read_only_statement("SELECT 1"));
        assert!(mysql.is_read_only_statement("-- c\nSELECT 1"));
        assert!(mysql.is_read_only_statement("# c\nSELECT 1"));
        assert!(mysql.is_read_only_statement("/* c */ show tables"));
        assert!(mysql.is_read_only_statement("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!mysql.is_read_only_statement("UPDATE t SET a = 1"));
        assert!(!mysql.is_read_only_statement("select * from t into outfile '/tmp/x'"));

        // PostgreSQL 里 `#` 不是注释：`# select 1` 是一条非法语句，不能当只读。
        let pg = SqlDialect::of("postgres").unwrap();
        assert!(!pg.is_read_only_statement("# select 1"));
        assert!(pg.is_read_only_statement("-- ok\nselect 1"));
    }

    #[test]
    fn unknown_engine_has_no_dialect() {
        assert!(SqlDialect::of("not-a-db").is_err());
    }

    #[test]
    fn mysql_family_products_share_the_dialect() {
        for id in [
            "mysql",
            "mariadb",
            "tidb",
            "doris",
            "starrocks",
            "aurora_mysql",
        ] {
            let sql = SqlDialect::of(id).expect("registered");
            assert_eq!(sql.dialect(), Dialect::MySql, "{id} 应复用 MySQL 方言");
            assert_eq!(sql.quote("t").unwrap(), "`t`");
        }
    }
}
