//! SQLite 表数据浏览：过滤 / 排序 / keyset 或 OFFSET 分页 / 预算。
//!
//! 与 MySQL 路径的差别：
//!
//! * 不走预处理语句（`SqliteWorker` 只接受 SQL 文本），所以过滤值与游标
//!   用方言的 `string_literal` 转义后内联。值只来自用户输入且已双写单引号，
//!   标识符只来自已验证的元数据 —— 这不是拼接式注入的入口。
//! * 没有"驱动侧投影"：SQLite 是本地文件读，预算通过**限制返回行/字节**实现，
//!   不额外做 `substr` 投影（那会让"查看完整值"多一次查询却没有收益）。
//! * `INTEGER PRIMARY KEY` 就是 rowid，keyset 游标直接用文本比较即可
//!   （SQLite 会按列亲和性转换）。

use std::sync::Arc;
use std::time::Instant;

use super::adapter::AdapterSet;
use super::driver::SqliteWorker;
use super::model::{
    BrowseFilter, BrowseRequest, BrowseResult, DbColumn, DbErrorInfo, DbTableColumn, DbTableDetail,
    DbValue, ResolvedBudget,
};

fn text_of(value: &DbValue) -> Option<String> {
    match value {
        DbValue::Null => None,
        DbValue::Int { value, .. } => Some(value.clone()),
        DbValue::Decimal { value } => Some(value.clone()),
        DbValue::Float { value } => Some(value.to_string()),
        DbValue::Text { value, .. } | DbValue::Json { value, .. } => Some(value.clone()),
        DbValue::Date { value } | DbValue::Time { value } => Some(value.clone()),
        DbValue::DateTime { value, .. } => Some(value.clone()),
        DbValue::Bit { value, .. } => Some(value.clone()),
        DbValue::Binary { .. } | DbValue::Unsupported { .. } => None,
    }
}

fn filter_clause(
    adapter: &AdapterSet,
    filter: &BrowseFilter,
) -> Result<Option<String>, DbErrorInfo> {
    let dialect = adapter.dialect();
    let column = dialect.quote(&filter.column)?;
    let raw = filter.value.clone().unwrap_or_default();
    let value = || dialect.string_literal(&raw);
    Ok(match filter.op.as_str() {
        "is_null" => Some(format!("{column} IS NULL")),
        "not_null" => Some(format!("{column} IS NOT NULL")),
        "eq" => Some(format!("{column} = {}", value())),
        "ne" => Some(format!("{column} <> {}", value())),
        "gt" => Some(format!("{column} > {}", value())),
        "gte" => Some(format!("{column} >= {}", value())),
        "lt" => Some(format!("{column} < {}", value())),
        "lte" => Some(format!("{column} <= {}", value())),
        "contains" | "starts_with" => {
            let escaped = raw.replace('%', "\\%").replace('_', "\\_");
            let pattern = if filter.op == "contains" {
                format!("%{escaped}%")
            } else {
                format!("{escaped}%")
            };
            Some(format!(
                "{column} LIKE {} ESCAPE '\\'",
                dialect.string_literal(&pattern)
            ))
        }
        other => {
            return Err(DbErrorInfo::new(
                "query",
                format!("不支持的过滤操作符：{other}"),
            ))
        }
    })
}

fn keyset_clause(
    adapter: &AdapterSet,
    keyset: &[(String, bool)],
    cursor: &[Option<String>],
) -> Result<String, DbErrorInfo> {
    let dialect = adapter.dialect();
    let mut alternatives = Vec::new();
    for index in 0..keyset.len() {
        let mut parts = Vec::new();
        for previous in 0..index {
            parts.push(format!(
                "{} = {}",
                dialect.quote(&keyset[previous].0)?,
                dialect.string_literal(cursor[previous].as_deref().unwrap_or(""))
            ));
        }
        let operator = if keyset[index].1 { ">" } else { "<" };
        parts.push(format!(
            "{} {operator} {}",
            dialect.quote(&keyset[index].0)?,
            dialect.string_literal(cursor[index].as_deref().unwrap_or(""))
        ));
        alternatives.push(format!("({})", parts.join(" AND ")));
    }
    Ok(format!("({})", alternatives.join(" OR ")))
}

fn browse_column(index: usize, column: &DbTableColumn, table: &str) -> DbColumn {
    DbColumn {
        index,
        name: column.name.clone(),
        org_name: column.name.clone(),
        table: table.to_string(),
        org_table: table.to_string(),
        type_name: column.column_type.clone(),
        type_code: 0,
        nullable: column.nullable,
        unsigned: false,
        binary: false,
        primary_key: column.primary_key,
        auto_increment: column.auto_increment,
        decimals: 0,
        charset: 0,
    }
}

pub async fn browse(
    worker: &Arc<SqliteWorker>,
    profile_adapter: AdapterSet,
    detail: &DbTableDetail,
    request: &BrowseRequest,
    budget: &ResolvedBudget,
) -> Result<BrowseResult, DbErrorInfo> {
    let started = Instant::now();
    let dialect = profile_adapter.dialect();
    let page_size = super::table::resolved_page_size(request.page_size);
    let offset = request.offset.unwrap_or(0);

    if detail.columns.is_empty() {
        return Err(DbErrorInfo::new("query", "该表没有可读取的列"));
    }

    let key_columns = detail.reliable_key.clone().unwrap_or_default();
    let has_reliable_key = !key_columns.is_empty() && detail.kind == "table";
    let sorts = request.sorts.clone().unwrap_or_default();
    for sort in &sorts {
        if detail
            .columns
            .iter()
            .all(|column| column.name != sort.column)
        {
            return Err(DbErrorInfo::new(
                "query",
                format!("排序列不存在：{}", sort.column),
            ));
        }
        if !matches!(sort.direction.as_str(), "asc" | "desc") {
            return Err(DbErrorInfo::new("query", "排序方向必须是 asc 或 desc"));
        }
    }
    if let Some(filters) = &request.filters {
        for filter in filters {
            if detail
                .columns
                .iter()
                .all(|column| column.name != filter.column)
            {
                return Err(DbErrorInfo::new(
                    "query",
                    format!("过滤列不存在：{}", filter.column),
                ));
            }
        }
    }

    // 排序：请求优先；否则按唯一键升序（没有唯一键就不排序，交给 OFFSET）。
    let order_columns: Vec<(String, bool)> = if !sorts.is_empty() {
        sorts
            .iter()
            .map(|sort| (sort.column.clone(), sort.direction == "asc"))
            .collect()
    } else {
        key_columns.iter().map(|key| (key.clone(), true)).collect()
    };
    let order_sql = if order_columns.is_empty() {
        String::new()
    } else {
        let parts = order_columns
            .iter()
            .map(|(column, asc)| {
                Ok::<String, DbErrorInfo>(format!(
                    "{} {}",
                    dialect.quote(column)?,
                    if *asc { "ASC" } else { "DESC" }
                ))
            })
            .collect::<Result<Vec<_>, _>>()?;
        format!(" ORDER BY {}", parts.join(", "))
    };

    let qualified = dialect.qualified(Some(&detail.database), &detail.table)?;
    let mut where_parts: Vec<String> = Vec::new();
    if let Some(filters) = &request.filters {
        for filter in filters {
            if let Some(clause) = filter_clause(&profile_adapter, filter)? {
                where_parts.push(clause);
            }
        }
    }

    // keyset 只在"排序就是唯一键（升序）"且显式要 keyset 时使用；
    // 其它组合老老实实走 OFFSET —— 不能假装游标稳定。
    let keyset_order = key_columns
        .iter()
        .map(|key| (key.clone(), true))
        .collect::<Vec<_>>();
    // "能不能用 keyset" 与"这一页有没有游标"是两件事：第一页没有游标，
    // 但后续页仍会走 keyset，所以分页模式必须如实标成 keyset。
    let keyset_allowed = request.pagination.as_deref() != Some("offset")
        && has_reliable_key
        && order_columns == keyset_order;
    if keyset_allowed {
        if let Some(cursor) = &request.after {
            where_parts.push(keyset_clause(&profile_adapter, &keyset_order, cursor)?);
        }
    }

    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_parts.join(" AND "))
    };
    let pagination = if keyset_allowed { "keyset" } else { "offset" };
    let limit_sql = if keyset_allowed {
        dialect
            .limit_offset(u64::from(page_size) + 1, None)
            .unwrap_or_default()
    } else {
        dialect
            .limit_offset(u64::from(page_size) + 1, Some(offset))
            .unwrap_or_default()
    };

    let sql = format!("SELECT * FROM {qualified}{where_sql}{order_sql} {limit_sql}");
    let answer = worker
        .query(&sql, u64::from(page_size) + 1, budget.max_bytes as usize)
        .await?;

    let has_more = answer.rows.len() > page_size as usize;
    let page_rows: Vec<&Vec<DbValue>> = answer.rows.iter().take(page_size as usize).collect();

    let mut last_cursor: Option<Vec<Option<String>>> = None;
    if has_reliable_key {
        if let Some(last) = page_rows.last() {
            let cursor: Vec<Option<String>> = key_columns
                .iter()
                .map(|key| {
                    detail
                        .columns
                        .iter()
                        .position(|column| &column.name == key)
                        .and_then(|index| last.get(index))
                        .and_then(text_of)
                })
                .collect();
            if cursor.iter().all(|value| value.is_some()) {
                last_cursor = Some(cursor);
            }
        }
    }

    let exact_rows = if request.exact_count.unwrap_or(false) {
        let count_sql = format!("SELECT COUNT(*) FROM {qualified}{where_sql}");
        worker
            .query(&count_sql, 1, 64)
            .await
            .ok()
            .and_then(|count| count.rows.first().cloned())
            .and_then(|row| match row.first() {
                Some(DbValue::Int { value, .. }) => value.parse::<u64>().ok(),
                _ => None,
            })
    } else {
        None
    };

    let warning = if !has_reliable_key {
        Some("该表没有可靠唯一键：翻页使用 OFFSET，数据变化时可能重复或漏行".to_string())
    } else if !keyset_allowed && !order_columns.is_empty() && order_columns != keyset_order {
        Some("当前排序不是完整唯一键：翻页使用 OFFSET，不能保证跨页稳定".to_string())
    } else {
        None
    };

    Ok(BrowseResult {
        columns: detail
            .columns
            .iter()
            .enumerate()
            .map(|(index, column)| browse_column(index, column, &detail.table))
            .collect(),
        rows: page_rows.into_iter().cloned().collect(),
        page_size,
        offset,
        pagination: pagination.to_string(),
        key_columns,
        next_cursor: if has_more { last_cursor } else { None },
        has_more,
        estimated_rows: None,
        exact_rows,
        has_reliable_key,
        truncated: answer.truncated,
        warning,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
