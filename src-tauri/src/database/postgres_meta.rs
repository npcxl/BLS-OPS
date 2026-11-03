//! PostgreSQL 结构浏览：复用 `CatalogQueries` 的 pg_catalog SQL。
//!
//! 两个约束决定了这里的写法：
//!
//! * **只走 `simple_query`**：文本协议没有参数绑定（`$1` 要配二进制协议），
//!   所以把 `$n` 按方言转义成字符串字面量再内联。值来自已验证的库名/表名，
//!   转义走 `dialect.string_literal`，不是拼字符串。
//! * **只按列名解析**：目录 SQL 把列别名成 `name` / `seq` / `is_primary`，
//!   列顺序变化不会错位，缺列得到 `None`。

use super::adapter::{AdapterSet, CatalogQueries, SqlDialect};
use super::driver::PostgresConn;
use super::metadata::MetadataCache;
use super::model::{
    DbColumn, DbDatabase, DbErrorInfo, DbIndex, DbIndexColumn, DbTable, DbTableColumn,
    DbTableDetail, DbValue,
};
use super::runtime::ProfileRuntime;

/// 把 `$1…$n` 换成按方言转义的字符串字面量。
///
/// 从大到小替换：否则 `$1` 会吃掉 `$10` 的前缀。
pub(crate) fn bind_literals(dialect: &SqlDialect, sql: &str, values: &[&str]) -> String {
    let mut statement = sql.to_string();
    for (index, value) in values.iter().enumerate().rev() {
        statement = statement.replace(&format!("${}", index + 1), &dialect.string_literal(value));
    }
    statement
}

/// 按列名读一行。`simple_query` 的值一律是文本，这里统一解析。
struct PgRow<'a> {
    columns: &'a [DbColumn],
    values: &'a [DbValue],
}

impl<'a> PgRow<'a> {
    fn new(columns: &'a [DbColumn], values: &'a [DbValue]) -> Self {
        Self { columns, values }
    }

    fn raw(&self, name: &str) -> Option<&'a DbValue> {
        self.columns
            .iter()
            .position(|column| column.name == name)
            .and_then(|index| self.values.get(index))
    }

    fn text(&self, name: &str) -> Option<String> {
        match self.raw(name)? {
            DbValue::Text { value, .. } | DbValue::Json { value, .. } => Some(value.clone()),
            DbValue::Int { value, .. } | DbValue::Decimal { value } => Some(value.clone()),
            DbValue::Float { value } => Some(value.to_string()),
            DbValue::Date { value } | DbValue::Time { value } => Some(value.clone()),
            DbValue::DateTime { value, .. } => Some(value.clone()),
            DbValue::Bit { value, .. } => Some(value.clone()),
            _ => None,
        }
    }

    fn text_or(&self, name: &str, fallback: &str) -> String {
        self.text(name).unwrap_or_else(|| fallback.to_string())
    }

    fn i64(&self, name: &str) -> Option<i64> {
        self.text(name)?.trim().parse().ok()
    }

    fn truthy(&self, name: &str) -> bool {
        matches!(
            self.text(name).as_deref(),
            Some("1") | Some("t") | Some("true") | Some("YES")
        )
    }
}

async fn run(
    conn: &PostgresConn,
    adapter: &AdapterSet,
    sql: &str,
    values: &[&str],
    limit: u64,
) -> Result<(Vec<DbColumn>, Vec<Vec<DbValue>>), DbErrorInfo> {
    let statement = bind_literals(adapter.dialect(), sql, values);
    let mut sets = conn.simple_query(&statement, limit).await?;
    if sets.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let set = sets.remove(0);
    Ok((set.columns, set.rows))
}

fn table_kind(table_type: &str) -> String {
    if table_type.to_ascii_uppercase().contains("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

pub async fn databases(
    profile: &ProfileRuntime,
    cache: &MetadataCache,
    key: String,
) -> Result<Vec<DbDatabase>, DbErrorInfo> {
    let conn = profile
        .postgres()
        .ok_or_else(|| DbErrorInfo::new("config", "该连接不是 PostgreSQL"))?;
    let adapter = profile.adapter()?;
    let catalog = CatalogQueries::of(&adapter)?;
    // PG 的"库"这一层是 schema：连接已绑定 database，跨库不可查。
    let (columns, rows) = run(conn, &adapter, catalog.schemas(), &[], 1_000).await?;
    let databases: Vec<DbDatabase> = rows
        .iter()
        .map(|values| {
            let row = PgRow::new(&columns, values);
            let name = row.text_or("name", "");
            DbDatabase {
                system: catalog.system_database(&name),
                name,
                charset: row.text("charset"),
                collation: row.text("collation"),
            }
        })
        .collect();
    cache.put(key, &databases).await;
    Ok(databases)
}

pub async fn tables(
    profile: &ProfileRuntime,
    cache: &MetadataCache,
    key: String,
    database: &str,
) -> Result<Vec<DbTable>, DbErrorInfo> {
    let conn = profile
        .postgres()
        .ok_or_else(|| DbErrorInfo::new("config", "该连接不是 PostgreSQL"))?;
    let adapter = profile.adapter()?;
    let catalog = CatalogQueries::of(&adapter)?;
    let (columns, rows) = run(
        conn,
        &adapter,
        catalog.tables(),
        &[database],
        // 一个 schema 里几千张表是上限；再多也超出界面的可用范围。
        20_000,
    )
    .await?;
    let tables: Vec<DbTable> = rows
        .iter()
        .map(|values| {
            let row = PgRow::new(&columns, values);
            DbTable {
                name: row.text_or("name", ""),
                kind: table_kind(&row.text_or("table_type", "BASE TABLE")),
                engine: row.text("engine"),
                estimated_rows: row.i64("estimated_rows").map(|value| value.max(0) as u64),
                comment: row.text_or("comment", ""),
            }
        })
        .collect();
    cache.put(key, &tables).await;
    Ok(tables)
}

pub async fn table_detail(
    profile: &ProfileRuntime,
    cache: &MetadataCache,
    key: String,
    database: &str,
    table: &str,
) -> Result<DbTableDetail, DbErrorInfo> {
    let conn = profile
        .postgres()
        .ok_or_else(|| DbErrorInfo::new("config", "该连接不是 PostgreSQL"))?;
    let adapter = profile.adapter()?;
    let catalog = CatalogQueries::of(&adapter)?;

    let (info_columns, info_rows) = run(
        conn,
        &adapter,
        catalog.table_detail(),
        &[database, table],
        1,
    )
    .await?;
    let info = info_rows
        .first()
        .map(|values| PgRow::new(&info_columns, values))
        .ok_or_else(|| {
            DbErrorInfo::new("database", format!("表或视图不存在：{database}.{table}"))
        })?;
    let kind = table_kind(&info.text_or("table_type", "BASE TABLE"));

    let (column_columns, column_rows) = run(
        conn,
        &adapter,
        catalog.columns(),
        &[database, table],
        16_384,
    )
    .await?;
    let (index_columns, index_rows) = run(
        conn,
        &adapter,
        catalog.indexes(),
        &[database, table],
        16_384,
    )
    .await?;

    // 索引按名字聚合：一个索引多行（多列）。
    let mut indexes: Vec<DbIndex> = Vec::new();
    for values in &index_rows {
        let row = PgRow::new(&index_columns, values);
        let name = row.text_or("name", "");
        if name.is_empty() {
            continue;
        }
        let unique = !row.truthy("non_unique");
        let primary = row.truthy("is_primary");
        let column = DbIndexColumn {
            name: row.text_or("column_name", ""),
            seq: row.i64("seq").unwrap_or(0).max(0) as u32,
            sub_part: row.i64("sub_part").map(|value| value.max(0) as u64),
            direction: if row.text("collation").as_deref() == Some("D") {
                Some("desc".to_string())
            } else {
                None
            },
        };
        match indexes.iter_mut().find(|index| index.name == name) {
            Some(index) => index.columns.push(column),
            None => indexes.push(DbIndex {
                name,
                unique,
                primary,
                kind: "btree".to_string(),
                columns: vec![column],
            }),
        }
    }
    for index in &mut indexes {
        index.columns.sort_by_key(|column| column.seq);
    }

    // 主键列由目录的 `is_primary` 给，不靠索引名猜（PG 叫 `<table>_pkey`）。
    let primary_key: Vec<String> = indexes
        .iter()
        .find(|index| index.primary)
        .map(|index| {
            index
                .columns
                .iter()
                .map(|column| column.name.clone())
                .collect()
        })
        .unwrap_or_default();

    let mut columns: Vec<DbTableColumn> = Vec::new();
    for values in &column_rows {
        let row = PgRow::new(&column_columns, values);
        let name = row.text_or("name", "");
        // PG 的 `nullable` 别名是 IS_NULLABLE 语义：'NO' 表示 NOT NULL。
        let nullable = !matches!(row.text("nullable").as_deref(), Some("NO"));
        let primary = primary_key.contains(&name);
        let auto_increment = row.text_or("extra", "").contains("IDENTITY")
            || row
                .text("default_value")
                .map(|value| value.starts_with("nextval("))
                .unwrap_or(false);
        columns.push(DbTableColumn {
            name,
            ordinal: row.i64("ordinal").unwrap_or(0).max(0) as u32,
            data_type: row.text_or("data_type", ""),
            column_type: row.text_or("column_type", ""),
            nullable: if primary { false } else { nullable },
            default_value: row.text("default_value"),
            default_expression: None,
            primary_key: primary,
            auto_increment,
            unsigned: false,
            charset: row.text("charset"),
            collation: row.text("collation"),
            comment: row.text_or("comment", ""),
        });
    }

    let non_null: Vec<&str> = columns
        .iter()
        .filter(|column| !column.nullable)
        .map(|column| column.name.as_str())
        .collect();
    let reliable_key = if !primary_key.is_empty() {
        Some(primary_key.clone())
    } else {
        indexes
            .iter()
            .filter(|index| index.unique && !index.primary)
            .find(|index| {
                index
                    .columns
                    .iter()
                    .all(|column| non_null.contains(&column.name.as_str()))
            })
            .map(|index| {
                index
                    .columns
                    .iter()
                    .map(|column| column.name.clone())
                    .collect()
            })
    };

    let detail = DbTableDetail {
        database: database.to_string(),
        table: table.to_string(),
        kind,
        engine: info.text("engine"),
        collation: info.text("collation"),
        estimated_rows: info.i64("estimated_rows").map(|value| value.max(0) as u64),
        comment: info.text_or("comment", ""),
        // PG 没有单语句的"查看表定义"；不编一段 DDL 冒充。
        create_sql: None,
        columns,
        indexes,
        primary_key,
        reliable_key,
    };
    cache.put(key, &detail).await;
    Ok(detail)
}

pub async fn table_identity(
    profile: &ProfileRuntime,
    database: &str,
    table: &str,
) -> Result<(String, Option<String>), DbErrorInfo> {
    let conn = profile
        .postgres()
        .ok_or_else(|| DbErrorInfo::new("config", "该连接不是 PostgreSQL"))?;
    let adapter = profile.adapter()?;
    let catalog = CatalogQueries::of(&adapter)?;
    let (columns, rows) = run(
        conn,
        &adapter,
        catalog.table_identity(),
        &[database, table],
        1,
    )
    .await?;
    let row = rows
        .first()
        .map(|values| PgRow::new(&columns, values))
        .ok_or_else(|| DbErrorInfo::new("database", format!("表不存在：{database}.{table}")))?;
    Ok((row.text_or("table_type", "BASE TABLE"), row.text("engine")))
}

pub async fn collations(profile: &ProfileRuntime) -> Result<Vec<String>, DbErrorInfo> {
    let conn = profile
        .postgres()
        .ok_or_else(|| DbErrorInfo::new("config", "该连接不是 PostgreSQL"))?;
    let adapter = profile.adapter()?;
    let catalog = CatalogQueries::of(&adapter)?;
    let Some(sql) = catalog.collations() else {
        return Ok(Vec::new());
    };
    let (columns, rows) = run(conn, &adapter, sql, &[], 20_000).await?;
    Ok(rows
        .iter()
        .filter_map(|values| PgRow::new(&columns, values).text("collation_name"))
        .collect())
}
