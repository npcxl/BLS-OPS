//! 结构浏览：库 → 表/视图 → 字段/主键/索引。
//!
//! **按需加载**：展开连接只查库名；展开库才查表；点开表才查字段/索引。
//! 绝不在打开连接时把全部库、全部表、全部字段读一遍。
//!
//! 缓存按 `(profile, database, …)` 分组，TTL 60 秒，可显式失效。
//! 展开表时**不执行** `COUNT(*)`：`TABLE_ROWS` 是 InnoDB 估算值，
//! 界面上明确标注"估算"。

use std::collections::HashMap;
use std::time::Duration;

use mysql_async::prelude::{FromRow, Queryable};
use mysql_async::{Conn, Params};
use tokio::sync::Mutex;

use super::driver::{map_error, quote_identifier};
use super::model::{
    DbDatabase, DbErrorInfo, DbIndex, DbIndexColumn, DbTable, DbTableColumn, DbTableDetail,
    MetadataCacheStatus,
};
use super::runtime::ProfileRuntime;

const METADATA_TIMEOUT: Duration = Duration::from_secs(20);
const CACHE_TTL_MS: i64 = 60_000;

const SYSTEM_DATABASES: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];

async fn pooled(profile: &ProfileRuntime) -> Result<Conn, DbErrorInfo> {
    match tokio::time::timeout(METADATA_TIMEOUT, profile.interactive_pool().get_conn()).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(error)) => Err(map_error(&error, "tcp")),
        Err(_) => Err(DbErrorInfo::new("tcp", "获取元数据连接超时").retryable(true)),
    }
}

async fn fetch<T>(
    conn: &mut Conn,
    sql: &str,
    params: Params,
) -> Result<Vec<T>, DbErrorInfo>
where
    T: FromRow + Send + 'static,
{
    match tokio::time::timeout(METADATA_TIMEOUT, conn.exec::<T, _, _>(sql, params)).await {
        Ok(Ok(rows)) => Ok(rows),
        Ok(Err(error)) => Err(map_error(&error, "query")),
        Err(_) => Err(DbErrorInfo::new(
            "timeout",
            format!("元数据查询超过 {} 秒", METADATA_TIMEOUT.as_secs()),
        )),
    }
}

async fn fetch_text(
    conn: &mut Conn,
    sql: &str,
    params: Params,
) -> Result<Vec<String>, DbErrorInfo> {
    let rows: Vec<(String,)> = fetch(conn, sql, params).await?;
    Ok(rows.into_iter().map(|(value,)| value).collect())
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

    async fn put<T: serde::Serialize>(&self, key: String, value: &T) {
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
            entries: entries.keys().filter(|key| key.starts_with(&prefix)).count(),
            last_invalidated_at: *self.invalidated_at.lock().await,
        }
    }
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

    let mut conn = pooled(profile).await?;
    let rows: Vec<(String, Option<String>, Option<String>)> = fetch(
        &mut conn,
        r#"
        SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
        FROM information_schema.SCHEMATA
        ORDER BY SCHEMA_NAME
        "#,
        Params::Empty,
    )
    .await?;

    let databases: Vec<DbDatabase> = rows
        .into_iter()
        .map(|(name, charset, collation)| DbDatabase {
            system: SYSTEM_DATABASES.contains(&name.as_str()),
            name,
            charset,
            collation,
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

    let mut conn = pooled(profile).await?;
    let rows: Vec<(String, String, Option<String>, Option<i64>, Option<String>)> = fetch(
        &mut conn,
        r#"
        SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME
        "#,
        Params::Positional(vec![mysql_async::Value::from(database.to_string())]),
    )
    .await?;

    let tables: Vec<DbTable> = rows
        .into_iter()
        .map(|(name, table_type, engine, estimated_rows, comment)| DbTable {
            kind: if table_type.to_ascii_uppercase().contains("VIEW") {
                "view".to_string()
            } else {
                "table".to_string()
            },
            name,
            engine,
            estimated_rows: estimated_rows.and_then(|value| u64::try_from(value).ok()),
            comment: comment.unwrap_or_default(),
        })
        .collect();

    cache.put(key, &tables).await;
    Ok(tables)
}

/// `information_schema.COLUMNS` 的一行。字段顺序必须与 SQL 完全一致。
type ColumnRow = (
    String,
    i64,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

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

    let mut conn = pooled(profile).await?;
    let positional = || {
        Params::Positional(vec![
            mysql_async::Value::from(database.to_string()),
            mysql_async::Value::from(table.to_string()),
        ])
    };

    let meta: Vec<(
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = fetch(
        &mut conn,
        r#"
        SELECT TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COLLATION, TABLE_COMMENT, TABLE_SCHEMA
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        LIMIT 1
        "#,
        positional(),
    )
    .await?;

    let (table_type, engine, estimated_rows, collation, comment, _schema) =
        meta.into_iter().next().ok_or_else(|| {
            DbErrorInfo::new("database", format!("表或视图不存在：{database}.{table}"))
        })?;

    let column_rows: Vec<ColumnRow> = fetch(
        &mut conn,
        r#"
        SELECT COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
               COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME,
               COLUMN_COMMENT, COLUMN_KEY
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
        "#,
        positional(),
    )
    .await?;

    let columns: Vec<DbTableColumn> = column_rows
        .into_iter()
        .map(
            |(
                name,
                ordinal,
                data_type,
                column_type,
                nullable,
                default_value,
                extra,
                charset,
                collation,
                comment,
                column_key,
            )| {
                let extra = extra.unwrap_or_default();
                let auto_increment = extra.to_ascii_lowercase().contains("auto_increment");
                let default_expression = if extra.to_ascii_uppercase().contains("DEFAULT_GENERATED")
                {
                    default_value.clone()
                } else {
                    None
                };
                DbTableColumn {
                    name,
                    ordinal: u32::try_from(ordinal).unwrap_or(0),
                    data_type,
                    column_type: column_type.clone(),
                    nullable: nullable.eq_ignore_ascii_case("YES"),
                    default_value,
                    default_expression,
                    primary_key: column_key.as_deref() == Some("PRI"),
                    auto_increment,
                    unsigned: column_type.to_ascii_lowercase().contains("unsigned"),
                    charset,
                    collation,
                    comment: comment.unwrap_or_default(),
                }
            },
        )
        .collect();

    let index_rows: Vec<(String, i64, i64, Option<String>, Option<i64>, Option<String>, String)> =
        fetch(
            &mut conn,
            r#"
            SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
                   SUB_PART, COLLATION, INDEX_TYPE
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY INDEX_NAME, SEQ_IN_INDEX
            "#,
            positional(),
        )
        .await?;

    let mut indexes: Vec<DbIndex> = Vec::new();
    for (name, non_unique, seq, column, sub_part, collation, index_type) in index_rows {
        let column_name = column.unwrap_or_else(|| "(expression)".to_string());
        match indexes.last_mut() {
            Some(index) if index.name == name => {
                index.columns.push(DbIndexColumn {
                    name: column_name,
                    seq: u32::try_from(seq).unwrap_or(0),
                    sub_part: sub_part.and_then(|value| u64::try_from(value).ok()),
                    direction: match collation.as_deref() {
                        Some("D") => Some("desc".to_string()),
                        Some("A") => Some("asc".to_string()),
                        _ => None,
                    },
                });
            }
            _ => indexes.push(DbIndex {
                name,
                unique: non_unique == 0,
                primary: false,
                kind: index_type,
                columns: vec![DbIndexColumn {
                    name: column_name,
                    seq: u32::try_from(seq).unwrap_or(0),
                    sub_part: sub_part.and_then(|value| u64::try_from(value).ok()),
                    direction: match collation.as_deref() {
                        Some("D") => Some("desc".to_string()),
                        Some("A") => Some("asc".to_string()),
                        _ => None,
                    },
                }],
            }),
        }
    }
    for index in &mut indexes {
        index.primary = index.name == "PRIMARY";
    }

    let primary_key: Vec<String> = indexes
        .iter()
        .find(|index| index.primary)
        .map(|index| index.columns.iter().map(|column| column.name.clone()).collect())
        .unwrap_or_default();

    // keyset 的可靠键：主键优先；否则找一个"唯一 + 全列 NOT NULL + 无前缀 +
    // 非大对象"的唯一索引。TEXT/BLOB/JSON 不能做稳定游标。
    let non_null: Vec<&str> = columns
        .iter()
        .filter(|column| !column.nullable)
        .map(|column| column.name.as_str())
        .collect();
    let stable_type = |name: &str| {
        columns
            .iter()
            .find(|column| column.name == name)
            .map(|column| {
                !matches!(
                    column.data_type.to_ascii_lowercase().as_str(),
                    "text" | "mediumtext" | "longtext" | "tinytext" | "blob" | "mediumblob"
                        | "longblob" | "tinyblob" | "json" | "geometry"
                )
            })
            .unwrap_or(false)
    };

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
                        && stable_type(&column.name)
                })
            })
            .map(|index| index.columns.iter().map(|column| column.name.clone()).collect())
    };

    // `SHOW CREATE TABLE` 是用户明确要求"查看表定义"时才打开的面板里的一部分。
    let create_sql = {
        let quoted_database = quote_identifier(database)?;
        let quoted_table = quote_identifier(table)?;
        let statement = format!("SHOW CREATE TABLE {quoted_database}.{quoted_table}");
        match tokio::time::timeout(
            METADATA_TIMEOUT,
            conn.query::<(String, String), _>(statement),
        )
        .await
        {
            Ok(Ok(rows)) => rows.into_iter().next().map(|(_, create)| create),
            _ => None,
        }
    };

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
        estimated_rows: estimated_rows.and_then(|value| u64::try_from(value).ok()),
        comment: comment.unwrap_or_default(),
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
    let mut conn = pooled(profile).await?;
    let rows: Vec<(String, Option<String>)> = fetch(
        &mut conn,
        r#"
        SELECT TABLE_TYPE, ENGINE
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        LIMIT 1
        "#,
        Params::Positional(vec![
            mysql_async::Value::from(database.to_string()),
            mysql_async::Value::from(table.to_string()),
        ]),
    )
    .await?;
    rows.into_iter()
        .next()
        .ok_or_else(|| DbErrorInfo::new("database", format!("表不存在：{database}.{table}")))
}

pub async fn list_collations(profile: &ProfileRuntime) -> Result<Vec<String>, DbErrorInfo> {
    let mut conn = pooled(profile).await?;
    fetch_text(
        &mut conn,
        "SELECT COLLATION_NAME FROM information_schema.COLLATIONS ORDER BY COLLATION_NAME",
        Params::Empty,
    )
    .await
}
