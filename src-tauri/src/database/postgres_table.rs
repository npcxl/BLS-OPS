//! PostgreSQL 表数据浏览：过滤 / 排序 / keyset 或 OFFSET 分页 / 精确计数。
//!
//! 与 SQLite 路径同构，差别只在执行层：PostgreSQL 走 `simple_query`（文本协议），
//! 因此过滤值与游标按方言 `string_literal` 转义后内联，而不是参数绑定。
//! 值来自用户输入、标识符来自已验证元数据，这不是拼接式注入的入口。
//!
//! 已知限制：`SELECT *` 一次把整页读进内存，预算只限制**行数**；大字段的
//! `LEFT(...)` 投影留给下一步（`read_cell` 已具备投影能力）。

use std::time::Instant;

use super::adapter::AdapterSet;
use super::driver::PostgresConn;
use super::model::{
    BrowseFilter, BrowseRequest, BrowseResult, DbColumn, DbErrorInfo, DbTableColumn, DbTableDetail,
    DbValue, ResolvedBudget,
};
use super::runtime::ProfileRuntime;

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
            let escaped = raw
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let pattern = if filter.op == "contains" {
                format!("%{escaped}%")
            } else {
                format!("{escaped}%")
            };
            Some(format!(
                "{column} LIKE {} {}",
                dialect.string_literal(&pattern),
                adapter.like_escape()
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
    // 游标必须与排序键一一对应；含 NULL 的游标不能参与比较（NULL 比较恒为 NULL）。
    if keyset.len() != cursor.len() {
        return Err(DbErrorInfo::new(
            "query",
            "分页游标与排序键数量不一致：请重新从第一页开始",
        ));
    }
    if cursor.iter().any(|value| value.is_none()) {
        return Err(DbErrorInfo::new(
            "query",
            "分页游标包含 NULL：该行不能用作稳定游标",
        ));
    }
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

/// 取第一条结果集；目录/查询语句执行失败时把错误原样交给上层。
async fn first_set(
    conn: &PostgresConn,
    sql: &str,
    limit: u64,
) -> Result<(Vec<DbColumn>, Vec<Vec<DbValue>>), DbErrorInfo> {
    let mut sets = conn.simple_query(sql, limit).await?;
    if sets.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let set = sets.remove(0);
    Ok((set.columns, set.rows))
}

pub async fn browse(
    profile: &ProfileRuntime,
    detail: &DbTableDetail,
    request: &BrowseRequest,
    budget: &ResolvedBudget,
) -> Result<BrowseResult, DbErrorInfo> {
    let started = Instant::now();
    let conn = profile
        .postgres()
        .ok_or_else(|| DbErrorInfo::new("config", "该连接不是 PostgreSQL"))?;
    let adapter = profile.adapter()?;
    let dialect = adapter.dialect();
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
    // 过滤条件与分页游标必须分开：COUNT 只统计过滤结果，不能把游标算进去。
    let mut filter_parts: Vec<String> = Vec::new();
    if let Some(filters) = &request.filters {
        for filter in filters {
            if let Some(clause) = filter_clause(&adapter, filter)? {
                filter_parts.push(clause);
            }
        }
    }
    let filter_where = if filter_parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", filter_parts.join(" AND "))
    };

    // keyset 只在"排序就是唯一键（升序）"且允许 keyset 时使用。
    let keyset_order = key_columns
        .iter()
        .map(|key| (key.clone(), true))
        .collect::<Vec<_>>();
    let keyset_allowed = request.pagination.as_deref() != Some("offset")
        && has_reliable_key
        && order_columns == keyset_order;
    let mut where_parts = filter_parts;
    if keyset_allowed {
        if let Some(cursor) = &request.after {
            where_parts.push(keyset_clause(&adapter, &keyset_order, cursor)?);
        }
    }

    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_parts.join(" AND "))
    };

    // OFFSET 上限：越翻越慢，超过上限要求改用 keyset 或收窄过滤。
    const MAX_OFFSET: u64 = 10_000_000;
    if !keyset_allowed && offset > MAX_OFFSET {
        return Err(DbErrorInfo::new(
            "query",
            format!("OFFSET 超过上限（{MAX_OFFSET}）：请改用 keyset 分页或缩小过滤范围"),
        ));
    }
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
    let (_, mut rows) = first_set(conn, &sql, u64::from(page_size) + 1).await?;

    let has_more = rows.len() > page_size as usize;
    let page_rows: Vec<Vec<DbValue>> = rows.drain(..).take(page_size as usize).collect();

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
        // 只带过滤、不带游标：翻到第 N 页时总数仍然是全量。
        let count_sql = format!("SELECT COUNT(*) AS c FROM {qualified}{filter_where}");
        first_set(conn, &count_sql, 1)
            .await
            .ok()
            .and_then(|(columns, rows)| {
                rows.first()
                    .map(|values| {
                        columns
                            .iter()
                            .position(|column| column.name == "c")
                            .and_then(|index| values.get(index))
                            .and_then(text_of)
                            .and_then(|value| value.parse::<u64>().ok())
                    })
                    .flatten()
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
        rows: page_rows,
        page_size,
        offset,
        pagination: pagination.to_string(),
        key_columns,
        next_cursor: if has_more { last_cursor } else { None },
        has_more,
        estimated_rows: detail.estimated_rows,
        exact_rows,
        has_reliable_key,
        truncated: false,
        warning,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
