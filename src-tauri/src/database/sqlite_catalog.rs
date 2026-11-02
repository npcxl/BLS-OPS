//! SQLite 结构浏览：`sqlite_master` + 表值 PRAGMA。
//!
//! SQLite 没有 `information_schema`，也没有"库"的概念（`main` 是文件本身）。
//! 表名/索引名来自 `sqlite_master`，属于**已验证的元数据**，但仍按字符串
//! 字面量转义后放进 PRAGMA（表值函数不接受标识符位置）。
//!
//! PRAGMA 的列名（`notnull` / `unique` / `pk`）都是 SQLite 的保留词，
//! 查询里必须加引号，否则会被当成关键字。

use super::driver::SqliteWorker;
use super::model::{
    DbDatabase, DbErrorInfo, DbIndex, DbIndexColumn, DbTable, DbTableColumn, DbTableDetail,
};

/// `sqlite_%` 是 SQLite 自己的表（sqlite_sequence / sqlite_stat*），不展示。
const HIDDEN_PREFIX: &str = "sqlite_";

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn text(row: &[super::model::DbValue], index: usize) -> String {
    match row.get(index) {
        Some(super::model::DbValue::Text { value, .. }) => value.clone(),
        Some(super::model::DbValue::Int { value, .. }) => value.clone(),
        Some(super::model::DbValue::Float { value }) => value.to_string(),
        _ => String::new(),
    }
}

fn optional_text(row: &[super::model::DbValue], index: usize) -> Option<String> {
    match row.get(index) {
        Some(super::model::DbValue::Text { value, .. }) => Some(value.clone()),
        Some(super::model::DbValue::Int { value, .. }) => Some(value.clone()),
        Some(super::model::DbValue::Float { value }) => Some(value.to_string()),
        _ => None,
    }
}

fn integer(row: &[super::model::DbValue], index: usize) -> i64 {
    match row.get(index) {
        Some(super::model::DbValue::Int { value, .. }) => value.parse().unwrap_or(0),
        Some(super::model::DbValue::Float { value }) => *value as i64,
        Some(super::model::DbValue::Text { value, .. }) => value.parse().unwrap_or(0),
        _ => 0,
    }
}

/// SQLite 只有一个库：文件本身。名称固定为 `main`，与 SQL 里可用的一致。
pub async fn databases(_worker: &SqliteWorker) -> Result<Vec<DbDatabase>, DbErrorInfo> {
    Ok(vec![DbDatabase {
        name: "main".to_string(),
        system: false,
        charset: Some("UTF-8".to_string()),
        collation: None,
    }])
}

pub async fn tables(worker: &SqliteWorker) -> Result<Vec<DbTable>, DbErrorInfo> {
    let sql = format!(
        "SELECT name, type FROM sqlite_master \
         WHERE type IN ('table','view') AND name NOT LIKE '{HIDDEN_PREFIX}%' ORDER BY name"
    );
    let answer = worker.query(&sql, 10_000, 8 * 1024 * 1024).await?;
    Ok(answer
        .rows
        .iter()
        .map(|row| DbTable {
            name: text(row, 0),
            kind: if text(row, 1).eq_ignore_ascii_case("view") {
                "view".to_string()
            } else {
                "table".to_string()
            },
            // SQLite 没有存储引擎、也不维护估算行数。
            engine: None,
            estimated_rows: None,
            comment: String::new(),
        })
        .collect())
}

pub async fn table_detail(
    worker: &SqliteWorker,
    database: &str,
    table: &str,
) -> Result<DbTableDetail, DbErrorInfo> {
    let identity = worker
        .query(
            &format!(
                "SELECT type, sql FROM sqlite_master WHERE name = {}",
                literal(table)
            ),
            1,
            256 * 1024,
        )
        .await?;
    let identity_row = identity.rows.first().ok_or_else(|| {
        DbErrorInfo::new("database", format!("表或视图不存在：{database}.{table}"))
    })?;
    let kind = if text(identity_row, 0).eq_ignore_ascii_case("view") {
        "view".to_string()
    } else {
        "table".to_string()
    };
    let create_sql = optional_text(identity_row, 1).filter(|sql| !sql.trim().is_empty());

    let columns_answer = worker
        .query(
            &format!(
                "SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info({})",
                literal(table)
            ),
            4096,
            4 * 1024 * 1024,
        )
        .await?;

    let mut columns: Vec<DbTableColumn> = Vec::new();
    let mut primary: Vec<(i64, String)> = Vec::new();
    for row in &columns_answer.rows {
        let name = text(row, 1);
        let declared = text(row, 2);
        let not_null = integer(row, 3) != 0;
        let pk_order = integer(row, 5);
        if pk_order > 0 {
            primary.push((pk_order, name.clone()));
        }
        columns.push(DbTableColumn {
            name,
            ordinal: integer(row, 0).max(0) as u32,
            data_type: declared.to_ascii_lowercase(),
            column_type: declared,
            // `INTEGER PRIMARY KEY` 在 SQLite 里允许 NULL 写入（自动分配 rowid），
            // 所以主键列不按 NOT NULL 展示。
            nullable: !not_null && pk_order == 0,
            default_value: optional_text(row, 4),
            default_expression: None,
            primary_key: pk_order > 0,
            auto_increment: false,
            unsigned: false,
            charset: None,
            collation: None,
            comment: String::new(),
        });
    }
    primary.sort_by_key(|(order, _)| *order);
    let primary_key: Vec<String> = primary.into_iter().map(|(_, name)| name).collect();

    let mut indexes: Vec<DbIndex> = Vec::new();
    let list = worker
        .query(
            &format!(
                "SELECT name, \"unique\", origin FROM pragma_index_list({})",
                literal(table)
            ),
            1024,
            1024 * 1024,
        )
        .await?;
    for row in &list.rows {
        let name = text(row, 0);
        let unique = integer(row, 1) != 0;
        let origin = text(row, 2);
        let info = worker
            .query(
                &format!(
                    "SELECT seqno, name FROM pragma_index_info({})",
                    literal(&name)
                ),
                1024,
                1024 * 1024,
            )
            .await?;
        let mut index_columns: Vec<DbIndexColumn> = info
            .rows
            .iter()
            .map(|info_row| DbIndexColumn {
                name: text(info_row, 1),
                seq: integer(info_row, 0).max(0) as u32,
                sub_part: None,
                direction: None,
            })
            .collect();
        index_columns.sort_by_key(|column| column.seq);
        // `pk` origin 的索引才是主键；SQLite 的自动索引名不固定。
        let primary = origin.eq_ignore_ascii_case("pk");
        indexes.push(DbIndex {
            name,
            unique,
            primary,
            kind: "btree".to_string(),
            columns: index_columns,
        });
    }

    // 主键优先；否则取"唯一 + 全列 NOT NULL"的索引做 keyset 游标。
    let reliable_key = if !primary_key.is_empty() {
        Some(primary_key.clone())
    } else {
        let non_null: Vec<&str> = columns
            .iter()
            .filter(|column| !column.nullable)
            .map(|column| column.name.as_str())
            .collect();
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

    Ok(DbTableDetail {
        database: database.to_string(),
        table: table.to_string(),
        kind,
        engine: None,
        collation: None,
        estimated_rows: None,
        comment: String::new(),
        create_sql,
        columns,
        indexes,
        primary_key,
        reliable_key,
    })
}

/// 写入前的存在性检查：返回（类型，引擎）。
pub async fn table_identity(
    worker: &SqliteWorker,
    database: &str,
    table: &str,
) -> Result<(String, Option<String>), DbErrorInfo> {
    let answer = worker
        .query(
            &format!(
                "SELECT type FROM sqlite_master WHERE name = {}",
                literal(table)
            ),
            1,
            64 * 1024,
        )
        .await?;
    let row = answer
        .rows
        .first()
        .ok_or_else(|| DbErrorInfo::new("database", format!("表不存在：{database}.{table}")))?;
    Ok((text(row, 0), None))
}

/// SQLite 没有可选的 collation 列表：返回空集而不是编一串名字。
pub async fn collations(_worker: &SqliteWorker) -> Result<Vec<String>, DbErrorInfo> {
    Ok(Vec::new())
}
