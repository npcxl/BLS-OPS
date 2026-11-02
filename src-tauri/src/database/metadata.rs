//! 结构浏览：库 → 表/视图 → 字段/主键/索引。
//!
//! **按需加载**：展开连接只查库名；展开库才查表；点开表才查字段/索引。
//! 绝不在打开连接时把全部库、全部表、全部字段读一遍。
//!
//! 缓存按 `(profile, database, …)` 分组，TTL 60 秒，可显式失效。
//! 展开表时**不执行** `COUNT(*)`：`TABLE_ROWS` / `reltuples` 都是估算值，
//! 界面上明确标注"估算"。
//!
//! ## 引擎无关性
//!
//! SQL 来自 `adapter::CatalogQueries`（按引擎族给出，做不到就明确拒绝），
//! 这里**不出现 `information_schema` 字面量**。结果一律按**列名**解析：
//! 每个引擎的查询把列别名成统一名字（`name` / `ordinal` / `is_primary` …），
//! 所以列顺序变化不会错位，缺列得到 `None` 而不是取到隔壁列的值。
//!
//! 主键判定来自目录的 `is_primary`，**不靠索引名**：MySQL 叫 `PRIMARY`，
//! PostgreSQL 叫 `<table>_pkey`。

use std::collections::HashMap;
use std::time::Duration;

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Params, Row, Value};
use tokio::sync::Mutex;

use super::adapter::{AdapterSet, CatalogQueries};
use super::driver::map_error;
use super::model::{
    DbDatabase, DbErrorInfo, DbIndex, DbIndexColumn, DbTable, DbTableColumn, DbTableDetail,
    MetadataCacheStatus,
};
use super::runtime::ProfileRuntime;

const METADATA_TIMEOUT: Duration = Duration::from_secs(20);
const CACHE_TTL_MS: i64 = 60_000;

async fn pooled(profile: &ProfileRuntime) -> Result<Conn, DbErrorInfo> {
    match tokio::time::timeout(METADATA_TIMEOUT, profile.interactive_pool()?.get_conn()).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(error)) => Err(map_error(&error, "tcp")),
        Err(_) => Err(DbErrorInfo::new("tcp", "获取元数据连接超时").retryable(true)),
    }
}

async fn fetch_rows(conn: &mut Conn, sql: &str, params: Params) -> Result<Vec<Row>, DbErrorInfo> {
    match tokio::time::timeout(METADATA_TIMEOUT, conn.exec::<Row, _, _>(sql, params)).await {
        Ok(Ok(rows)) => Ok(rows),
        Ok(Err(error)) => Err(map_error(&error, "query")),
        Err(_) => Err(DbErrorInfo::new(
            "timeout",
            format!("元数据查询超过 {} 秒", METADATA_TIMEOUT.as_secs()),
        )),
    }
}

/// 按列名取字符串。缺列 / NULL 都返回 `None`，不会退化成"取第 N 列"。
fn text(row: &Row, name: &str) -> Option<String> {
    row.get::<Option<String>, _>(name).flatten()
}

fn number(row: &Row, name: &str) -> Option<i64> {
    row.get::<Option<i64>, _>(name).flatten()
}

fn positional(values: &[&str]) -> Params {
    Params::Positional(
        values
            .iter()
            .map(|value| Value::from(value.to_string()))
            .collect(),
    )
}

async fn catalog_for(profile: &ProfileRuntime) -> Result<CatalogQueries, DbErrorInfo> {
    CatalogQueries::of(&profile.adapter()?)
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct MetadataCache {
    entries: std::sync::Arc<Mutex<HashMap<String, (i64, serde_json::Value)>>>,
    invalidated_at: std::sync::Arc<Mutex<Option<i64>>>,
}

impl MetadataCache {
    fn key(profile_id: &str, parts: &[&str]) -> String {
        format!("{profile_id}\u{1}{}", parts.join("\u{1}"))
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        let entries = self.entries.lock().await;
        let (expires_at, value) = entries.get(key)?;
        if crate::db::AppDb::now() >= *expires_at {
            return None;
        }
        serde_json::from_value(value.clone()).ok()
    }

    pub(crate) async fn put<T: serde::Serialize>(&self, key: String, value: &T) {
        if let Ok(value) = serde_json::to_value(value) {
            self.entries
                .lock()
                .await
                .insert(key, (crate::db::AppDb::now() + CACHE_TTL_MS, value));
        }
    }

    pub async fn invalidate(&self, profile_id: Option<&str>) -> usize {
        let mut entries = self.entries.lock().await;
        let before = entries.len();
        match profile_id {
            Some(id) => entries.retain(|key, _| !key.starts_with(&format!("{id}\u{1}"))),
            None => entries.clear(),
        }
        let removed = before - entries.len();
        *self.invalidated_at.lock().await = Some(crate::db::AppDb::now());
        removed
    }

    pub async fn status(&self, profile_id: &str) -> MetadataCacheStatus {
        let entries = self.entries.lock().await;
        let prefix = format!("{profile_id}\u{1}");
        MetadataCacheStatus {
            profile_id: profile_id.to_string(),
            entries: entries
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .count(),
            last_invalidated_at: *self.invalidated_at.lock().await,
        }
    }
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

fn columns_from_rows(rows: Vec<Row>) -> Vec<DbTableColumn> {
    rows.into_iter()
        .map(|row| {
            let extra = text(&row, "extra").unwrap_or_default();
            let extra_lower = extra.to_ascii_lowercase();
            let column_type = text(&row, "column_type").unwrap_or_default();
            let default_value = text(&row, "default_value");
            let auto_increment =
                extra_lower.contains("auto_increment") || extra_lower.contains("identity");
            // 表达式默认值与字面量默认值要区分：前者前端显示为 `DEFAULT (expr)`。
            let default_expression = if extra.to_ascii_uppercase().contains("DEFAULT_GENERATED") {
                default_value.clone()
            } else {
                None
            };
            DbTableColumn {
                name: text(&row, "name").unwrap_or_default(),
                ordinal: number(&row, "ordinal").unwrap_or(0).max(0) as u32,
                data_type: text(&row, "data_type").unwrap_or_default(),
                column_type: column_type.clone(),
                nullable: text(&row, "nullable")
                    .map(|value| value.eq_ignore_ascii_case("YES"))
                    .unwrap_or(false),
                default_value,
                default_expression,
                // 主键由索引结果回填：目录里的列标记各引擎不一致。
                primary_key: false,
                auto_increment,
                unsigned: column_type.to_ascii_lowercase().contains("unsigned"),
                charset: text(&row, "charset"),
                collation: text(&row, "collation"),
                comment: text(&row, "comment").unwrap_or_default(),
            }
        })
        .collect()
}

fn indexes_from_rows(rows: Vec<Row>) -> Vec<DbIndex> {
    let mut indexes: Vec<DbIndex> = Vec::new();
    for row in rows {
        let name = text(&row, "name").unwrap_or_default();
        let seq = number(&row, "seq").unwrap_or(0).max(0) as u32;
        let direction = match text(&row, "collation").as_deref() {
            Some("D") => Some("desc".to_string()),
            Some("A") => Some("asc".to_string()),
            _ => None,
        };
        let column = DbIndexColumn {
            name: text(&row, "column_name").unwrap_or_else(|| "(expression)".to_string()),
            seq,
            sub_part: number(&row, "sub_part").and_then(|value| u64::try_from(value).ok()),
            direction,
        };
        let primary = number(&row, "is_primary").unwrap_or(0) != 0;
        match indexes.last_mut() {
            Some(index) if index.name == name => index.columns.push(column),
            _ => indexes.push(DbIndex {
                name,
                unique: number(&row, "non_unique").unwrap_or(1) == 0,
                primary,
                kind: text(&row, "index_type").unwrap_or_default(),
                columns: vec![column],
            }),
        }
    }
    indexes
}

/// "查看表定义"的文本。个别引擎没有等价语句（PostgreSQL），返回 `None`。
async fn create_table_sql(
    conn: &mut Conn,
    catalog: &CatalogQueries,
    adapter: &AdapterSet,
    database: &str,
    table: &str,
) -> Option<String> {
    let qualified = adapter.dialect().qualified(Some(database), table).ok()?;
    let statement = catalog.create_table_statement(&qualified)?;
    match tokio::time::timeout(
        METADATA_TIMEOUT,
        conn.query::<(String, String), _>(statement),
    )
    .await
    {
        Ok(Ok(rows)) => rows.into_iter().next().map(|(_, create)| create),
        _ => None,
    }
}

/// keyset 的可靠键：主键优先；否则找一个"唯一 + 全列 NOT NULL + 无前缀 +
/// 非大对象"的唯一索引。TEXT/BLOB/JSON 不能做稳定游标。
fn stable_sort_type(data_type: &str) -> bool {
    !matches!(
        data_type.to_ascii_lowercase().as_str(),
        "text"
            | "mediumtext"
            | "longtext"
            | "tinytext"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "tinyblob"
            | "json"
            | "jsonb"
            | "bytea"
            | "xml"
            | "geometry"
    )
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

pub async fn list_databases(
    profile: &ProfileRuntime,
    cache: &MetadataCache,
) -> Result<Vec<DbDatabase>, DbErrorInfo> {
    let key = MetadataCache::key(&profile.profile_id, &["databases"]);
    if let Some(cached) = cache.get(&key).await {
        return Ok(cached);
    }

    if let Some(worker) = profile.sqlite() {
        let databases = super::sqlite_catalog::databases(worker).await?;
        cache.put(key, &databases).await;
        return Ok(databases);
    }

    if profile.postgres().is_some() {
        return super::postgres_meta::databases(profile, cache, key).await;
    }

    let catalog = catalog_for(profile).await?;
    let mut conn = pooled(profile).await?;
    let rows = fetch_rows(&mut conn, catalog.databases(), Params::Empty).await?;

    let databases: Vec<DbDatabase> = rows
        .into_iter()
        .map(|row| {
            let name = text(&row, "name").unwrap_or_default();
            DbDatabase {
                system: catalog.system_database(&name),
                name,
                charset: text(&row, "charset"),
                collation: text(&row, "collation"),
            }
        })
        .collect();

    cache.put(key, &databases).await;
    Ok(databases)
}

pub async fn list_tables(
    profile: &ProfileRuntime,
    cache: &MetadataCache,
    database: &str,
) -> Result<Vec<DbTable>, DbErrorInfo> {
    let key = MetadataCache::key(&profile.profile_id, &["tables", database]);
    if let Some(cached) = cache.get(&key).await {
        return Ok(cached);
    }

    if let Some(worker) = profile.sqlite() {
        let tables = super::sqlite_catalog::tables(worker).await?;
        cache.put(key, &tables).await;
        return Ok(tables);
    }

    if profile.postgres().is_some() {
        return super::postgres_meta::tables(profile, cache, key, database).await;
    }

    let catalog = catalog_for(profile).await?;
    let mut conn = pooled(profile).await?;
    let rows = fetch_rows(&mut conn, catalog.tables(), positional(&[database])).await?;

    let tables: Vec<DbTable> = rows
        .into_iter()
        .map(|row| DbTable {
            kind: if text(&row, "table_type")
                .unwrap_or_default()
                .to_ascii_uppercase()
                .contains("VIEW")
            {
                "view".to_string()
            } else {
                "table".to_string()
            },
            name: text(&row, "name").unwrap_or_default(),
            engine: text(&row, "engine"),
            estimated_rows: number(&row, "estimated_rows")
                .and_then(|value| u64::try_from(value).ok()),
            comment: text(&row, "comment").unwrap_or_default(),
        })
        .collect();

    cache.put(key, &tables).await;
    Ok(tables)
}

pub async fn table_detail(
    profile: &ProfileRuntime,
    cache: &MetadataCache,
    database: &str,
    table: &str,
) -> Result<DbTableDetail, DbErrorInfo> {
    let key = MetadataCache::key(&profile.profile_id, &["detail", database, table]);
    if let Some(cached) = cache.get(&key).await {
        return Ok(cached);
    }

    if let Some(worker) = profile.sqlite() {
        let detail = super::sqlite_catalog::table_detail(worker, database, table).await?;
        cache.put(key, &detail).await;
        return Ok(detail);
    }

    if profile.postgres().is_some() {
        return super::postgres_meta::table_detail(profile, cache, key, database, table).await;
    }

    let adapter = profile.adapter()?;
    let catalog = CatalogQueries::of(&adapter)?;
    let mut conn = pooled(profile).await?;
    let params = || positional(&[database, table]);

    let meta = fetch_rows(&mut conn, catalog.table_detail(), params())
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| {
            DbErrorInfo::new("database", format!("表或视图不存在：{database}.{table}"))
        })?;

    let table_type = text(&meta, "table_type").unwrap_or_default();
    let engine = text(&meta, "engine");
    let estimated_rows =
        number(&meta, "estimated_rows").and_then(|value| u64::try_from(value).ok());
    let collation = text(&meta, "collation");
    let comment = text(&meta, "comment").unwrap_or_default();

    let column_rows = fetch_rows(&mut conn, catalog.columns(), params()).await?;
    let mut columns = columns_from_rows(column_rows);

    let index_rows = fetch_rows(&mut conn, catalog.indexes(), params()).await?;
    let indexes = indexes_from_rows(index_rows);

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

    // 列的"主键"标记统一以索引结果为准。
    for column in &mut columns {
        column.primary_key = primary_key.iter().any(|key| key == &column.name);
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
                index.columns.iter().all(|column| {
                    non_null.contains(&column.name.as_str())
                        && column.sub_part.is_none()
                        && stable_sort_type(
                            columns
                                .iter()
                                .find(|item| item.name == column.name)
                                .map(|item| item.data_type.as_str())
                                .unwrap_or("text"),
                        )
                })
            })
            .map(|index| {
                index
                    .columns
                    .iter()
                    .map(|column| column.name.clone())
                    .collect()
            })
    };

    // "查看表定义"是用户明确打开面板时才需要的；没有等价语句的引擎返回 None。
    let create_sql = create_table_sql(&mut conn, &catalog, &adapter, database, table).await;

    let detail = DbTableDetail {
        database: database.to_string(),
        table: table.to_string(),
        kind: if table_type.to_ascii_uppercase().contains("VIEW") {
            "view".to_string()
        } else {
            "table".to_string()
        },
        engine,
        collation,
        estimated_rows,
        comment,
        create_sql,
        columns,
        indexes,
        primary_key,
        reliable_key,
    };

    cache.put(key, &detail).await;
    Ok(detail)
}

/// 只读的"表是否存在/类型"检查（写入前必查）。
pub async fn table_identity(
    profile: &ProfileRuntime,
    database: &str,
    table: &str,
) -> Result<(String, Option<String>), DbErrorInfo> {
    if let Some(worker) = profile.sqlite() {
        return super::sqlite_catalog::table_identity(worker, database, table).await;
    }

    if profile.postgres().is_some() {
        return super::postgres_meta::table_identity(profile, database, table).await;
    }

    let catalog = catalog_for(profile).await?;
    let mut conn = pooled(profile).await?;
    let row = fetch_rows(
        &mut conn,
        catalog.table_identity(),
        positional(&[database, table]),
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| DbErrorInfo::new("database", format!("表不存在：{database}.{table}")))?;
    Ok((
        text(&row, "table_type").unwrap_or_default(),
        text(&row, "engine"),
    ))
}

pub async fn list_collations(profile: &ProfileRuntime) -> Result<Vec<String>, DbErrorInfo> {
    if let Some(worker) = profile.sqlite() {
        return super::sqlite_catalog::collations(worker).await;
    }

    if profile.postgres().is_some() {
        return super::postgres_meta::collations(profile).await;
    }

    let catalog = catalog_for(profile).await?;
    let sql = catalog.collations().ok_or_else(|| {
        DbErrorInfo::new(
            "unsupported",
            "该引擎没有排序规则概念，不需要选择 collation",
        )
    })?;
    let mut conn = pooled(profile).await?;
    let rows = fetch_rows(&mut conn, sql, Params::Empty).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| text(&row, "collation_name"))
        .collect())
}
