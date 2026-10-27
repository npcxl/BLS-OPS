//! 表数据浏览：数据库端排序/过滤/分页 + 大字段投影预算。
//!
//! ## 为什么 keyset 不是"随便什么排序都能用"
//!
//! keyset 需要一个**严格单调**的排序键。只有"排序序列恰好等于可靠唯一键
//! （主键或唯一非空键）"时，`(k1, k2) > (v1, v2)` 才能唯一确定下一页的
//! 起点。用户按 `created_at DESC` 排序、而主键是 `id` 时，用 keyset 会
//! 漏行/重行 —— 这时我们退到有预算的 OFFSET，并在 `warning` 里说明。
//!
//! ## 大字段不是"读进来再截断"
//!
//! 对 TEXT/BLOB/JSON 列，SELECT 列表用 `LEFT(col, N)` 投影，另取
//! `OCTET_LENGTH(col)` 记录真实字节数。**驱动从 socket 收到的就是 N 字节**，
//! 所以内存峰值由 N 决定，而不是由列里实际存了多大决定。
//! 完整值需要用户在单元格详情里显式请求（见 `db_read_cell`），
//! 且只有可靠键存在时才能重新定位那一行。

use std::time::Instant;

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Params, Value};

use super::driver::{map_error, quote_identifier};
use super::model::{
    BrowseFilter, BrowseRequest, BrowseResult, BrowseSort, DbColumn, DbErrorInfo, DbTableColumn,
    DbValue, ResolvedBudget,
};
use super::runtime::ProfileRuntime;

const DEFAULT_PAGE_SIZE: u32 = 200;
const MAX_PAGE_SIZE: u32 = 1_000;
/// OFFSET 的预算：不预扫描全表，也不允许"帮我跳到第 1000 万行"。
const MAX_OFFSET: u64 = 200_000;

pub fn resolved_page_size(value: Option<u32>) -> u32 {
    value
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE)
}

fn is_large_type(data_type: &str) -> bool {
    matches!(
        data_type.to_ascii_lowercase().as_str(),
        "tinytext"
            | "text"
            | "mediumtext"
            | "longtext"
            | "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "json"
            | "geometry"
            | "point"
            | "linestring"
            | "polygon"
            | "multipoint"
            | "multilinestring"
            | "multipolygon"
            | "geometrycollection"
            | "varbinary"
    )
}

fn is_numeric_type(data_type: &str) -> bool {
    matches!(
        data_type.to_ascii_lowercase().as_str(),
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "year"
    )
}

fn is_binary_type(data_type: &str) -> bool {
    matches!(
        data_type.to_ascii_lowercase().as_str(),
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "bit"
    )
}

/// 把 `information_schema` 的列定义变成结果列的元数据。
fn browse_column(index: usize, column: &DbTableColumn) -> DbColumn {
    DbColumn {
        index,
        name: column.name.clone(),
        org_name: column.name.clone(),
        table: String::new(),
        org_table: String::new(),
        type_name: column.data_type.to_ascii_uppercase(),
        type_code: 0,
        nullable: column.nullable,
        unsigned: column.unsigned,
        binary: is_binary_type(&column.data_type),
        primary_key: column.primary_key,
        auto_increment: column.auto_increment,
        decimals: 0,
        charset: 0,
    }
}

/// 表浏览专用的值转换：类型来自 `information_schema`，而不是投影后的结果集
/// （`LEFT(col, n)` 的返回类型已经变成 VARCHAR/BLOB）。
pub fn to_browse_value(
    column: &DbTableColumn,
    value: Value,
    preview_bytes: usize,
    real_bytes: Option<usize>,
) -> DbValue {
    let kind = column.data_type.to_ascii_lowercase();
    match value {
        Value::NULL => DbValue::Null,
        Value::Int(number) => DbValue::Int {
            value: number.to_string(),
            unsigned: column.unsigned,
        },
        Value::UInt(number) => DbValue::Int {
            value: number.to_string(),
            unsigned: true,
        },
        Value::Float(number) => DbValue::Float {
            value: f64::from(number),
        },
        Value::Double(number) => DbValue::Float { value: number },
        Value::Date(year, month, day, hour, minute, second, micros) => {
            if kind == "date" {
                DbValue::Date {
                    value: format!("{year:04}-{month:02}-{day:02}"),
                }
            } else if kind == "time" {
                DbValue::Time {
                    value: format!("{hour:02}:{minute:02}:{second:02}.{micros:06}"),
                }
            } else {
                let mut text =
                    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}");
                if micros > 0 {
                    text.push_str(&format!(".{micros:06}"));
                }
                DbValue::DateTime {
                    value: text,
                    timezone: "server".to_string(),
                }
            }
        }
        Value::Time(negative, days, hours, minutes, seconds, micros) => {
            let sign = if negative { "-" } else { "" };
            let total_hours = u64::from(days) * 24 + u64::from(hours);
            let mut text = format!("{sign}{total_hours:02}:{minutes:02}:{seconds:02}");
            if micros > 0 {
                text.push_str(&format!(".{micros:06}"));
            }
            DbValue::Time { value: text }
        }
        Value::Bytes(bytes) => {
            let total = real_bytes.unwrap_or(bytes.len());
            let truncated = total > bytes.len();
            match kind.as_str() {
                "json" => DbValue::Json {
                    value: String::from_utf8_lossy(&bytes).to_string(),
                    bytes: total,
                    truncated,
                },
                "decimal" | "numeric" => match String::from_utf8(bytes) {
                    Ok(text) => DbValue::Decimal { value: text },
                    Err(error) => DbValue::Binary {
                        base64: base64_encode(error.as_bytes()),
                        bytes: total,
                        truncated,
                    },
                },
                "date" => DbValue::Date {
                    value: String::from_utf8_lossy(&bytes).to_string(),
                },
                "datetime" | "timestamp" => DbValue::DateTime {
                    value: String::from_utf8_lossy(&bytes).to_string(),
                    timezone: "server".to_string(),
                },
                "time" => DbValue::Time {
                    value: String::from_utf8_lossy(&bytes).to_string(),
                },
                "float" | "double" | "real" => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    match text.parse::<f64>() {
                        Ok(value) => DbValue::Float { value },
                        Err(_) => DbValue::Text {
                            value: text,
                            bytes: total,
                            truncated,
                        },
                    }
                }
                "bit" => {
                    let mut bits = String::from("0b");
                    for byte in &bytes {
                        bits.push_str(&format!("{byte:08b}"));
                    }
                    DbValue::Bit {
                        bits,
                        value: String::from_utf8_lossy(&bytes).to_string(),
                    }
                }
                _ if is_binary_type(&kind) => DbValue::Binary {
                    base64: base64_encode(&bytes[..bytes.len().min(preview_bytes)]),
                    bytes: total,
                    truncated,
                },
                _ if is_numeric_type(&kind) => {
                    // 投影后的数值列很少走 Bytes；仍然按字符串保留。
                    DbValue::Int {
                        value: String::from_utf8_lossy(&bytes).to_string(),
                        unsigned: column.unsigned,
                    }
                }
                _ => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    let clipped = truncate_bytes(&text, preview_bytes);
                    let clipped_again = clipped.len() < text.len();
                    DbValue::Text {
                        value: clipped,
                        bytes: total,
                        truncated: truncated || clipped_again,
                    }
                }
            }
        }
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn truncate_bytes(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn cursor_text(value: &DbValue) -> Option<String> {
    match value {
        DbValue::Null => None,
        DbValue::Int { value, .. } => Some(value.clone()),
        DbValue::Decimal { value } => Some(value.clone()),
        DbValue::Float { value } => Some(value.to_string()),
        DbValue::Text { value, .. } => Some(value.clone()),
        DbValue::Json { value, .. } => Some(value.clone()),
        DbValue::Date { value } => Some(value.clone()),
        DbValue::DateTime { value, .. } => Some(value.clone()),
        DbValue::Time { value } => Some(value.clone()),
        DbValue::Bit { value, .. } => Some(value.clone()),
        DbValue::Binary { .. } | DbValue::Unsupported { .. } => None,
    }
}

pub(crate) fn filter_clause(
    filter: &BrowseFilter,
    params: &mut Vec<Value>,
) -> Result<Option<String>, DbErrorInfo> {
    let column = quote_identifier(&filter.column)?;
    let op = filter.op.as_str();
    let clause = match op {
        "is_null" => Some(format!("{column} IS NULL")),
        "not_null" => Some(format!("{column} IS NOT NULL")),
        "eq" => {
            params.push(Value::Bytes(filter.value.clone().unwrap_or_default().into_bytes()));
            Some(format!("{column} = ?"))
        }
        "ne" => {
            params.push(Value::Bytes(filter.value.clone().unwrap_or_default().into_bytes()));
            Some(format!("{column} <> ?"))
        }
        "gt" | "gte" | "lt" | "lte" => {
            let operator = match op {
                "gt" => ">",
                "gte" => ">=",
                "lt" => "<",
                _ => "<=",
            };
            params.push(Value::Bytes(filter.value.clone().unwrap_or_default().into_bytes()));
            Some(format!("{column} {operator} ?"))
        }
        "contains" | "starts_with" => {
            let raw = filter.value.clone().unwrap_or_default();
            let escaped = raw
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let pattern = if op == "contains" {
                format!("%{escaped}%")
            } else {
                format!("{escaped}%")
            };
            params.push(Value::Bytes(pattern.into_bytes()));
            Some(format!("{column} LIKE ? ESCAPE '\\\\'"))
        }
        other => {
            return Err(DbErrorInfo::new(
                "query",
                format!("不支持的过滤操作符：{other}"),
            ))
        }
    };
    Ok(clause)
}

struct OrderPlan {
    sql: String,
    keyset: Option<Vec<(String, bool)>>,
    pagination: String,
    warning: Option<String>,
}

fn plan_order(
    request: &BrowseRequest,
    key_columns: &[String],
    has_reliable_key: bool,
    default_direction: bool,
) -> Result<OrderPlan, DbErrorInfo> {
    let sorts: Vec<BrowseSort> = request.sorts.clone().unwrap_or_default();
    let mode = request.pagination.as_deref().unwrap_or("auto");

    let valid_sort = |sort: &BrowseSort| matches!(sort.direction.as_str(), "asc" | "desc");

    let mut order_parts = Vec::new();
    let mut order_columns = Vec::new();
    for sort in &sorts {
        if !valid_sort(sort) {
            return Err(DbErrorInfo::new(
                "query",
                format!("排序方向必须是 asc 或 desc（收到 {}）", sort.direction),
            ));
        }
        order_parts.push(format!(
            "{} {}",
            quote_identifier(&sort.column)?,
            sort.direction.to_uppercase()
        ));
        order_columns.push(sort.column.clone());
    }

    if order_parts.is_empty() && has_reliable_key {
        for key in key_columns {
            order_parts.push(format!(
                "{} {}",
                quote_identifier(key)?,
                if default_direction { "ASC" } else { "DESC" }
            ));
            order_columns.push(key.clone());
        }
    }

    let matches_key = has_reliable_key
        && !key_columns.is_empty()
        && order_columns.len() == key_columns.len()
        && order_columns.iter().zip(key_columns.iter()).all(|(a, b)| a == b);

    let key_set = || -> Vec<(String, bool)> {
        if sorts.is_empty() {
            key_columns
                .iter()
                .map(|key| (key.clone(), default_direction))
                .collect()
        } else {
            sorts
                .iter()
                .map(|sort| (sort.column.clone(), sort.direction == "asc"))
                .collect()
        }
    };

    let keyset = if mode == "keyset" {
        if !matches_key {
            return Err(DbErrorInfo::new(
                "query",
                "当前排序不是完整唯一键，无法使用 keyset 分页；请按唯一键排序或改用 OFFSET",
            ));
        }
        Some(key_set())
    } else if mode == "offset" {
        None
    } else if matches_key {
        Some(key_set())
    } else {
        None
    };

    let sql = if order_parts.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order_parts.join(", "))
    };

    let pagination = if keyset.is_some() { "keyset" } else { "offset" };
    let warning = if keyset.is_none() {
        if !has_reliable_key {
            Some(
                "该表没有可靠唯一键：翻页使用 OFFSET，数据变化时可能重复或漏行；写入/重读完整字段不可用"
                    .to_string(),
            )
        } else if !order_columns.is_empty() {
            Some(
                "当前排序不包含完整唯一键：翻页使用有预算的 OFFSET，不能保证跨页稳定；按主键排序可使用 keyset"
                    .to_string(),
            )
        } else {
            None
        }
    } else {
        None
    };

    Ok(OrderPlan {
        sql,
        keyset,
        pagination: pagination.to_string(),
        warning,
    })
}

fn keyset_clause(
    keyset: &[(String, bool)],
    cursor: &[Option<String>],
    params: &mut Vec<Value>,
) -> Result<String, DbErrorInfo> {
    if keyset.len() != cursor.len() {
        return Err(DbErrorInfo::new("query", "分页游标与排序键数量不一致"));
    }
    let mut alternatives = Vec::new();
    for index in 0..keyset.len() {
        let mut parts = Vec::new();
        for previous in 0..index {
            parts.push(format!("{} = ?", quote_identifier(&keyset[previous].0)?));
            params.push(Value::Bytes(
                cursor[previous].clone().unwrap_or_default().into_bytes(),
            ));
        }
        let operator = if keyset[index].1 { ">" } else { "<" };
        parts.push(format!(
            "{} {operator} ?",
            quote_identifier(&keyset[index].0)?
        ));
        params.push(Value::Bytes(
            cursor[index].clone().unwrap_or_default().into_bytes(),
        ));
        alternatives.push(format!("({})", parts.join(" AND ")));
    }
    Ok(format!("({})", alternatives.join(" OR ")))
}

/// 构造并执行一页查询。
pub async fn browse(
    profile: &ProfileRuntime,
    detail: &super::model::DbTableDetail,
    request: &BrowseRequest,
    budget: &ResolvedBudget,
) -> Result<BrowseResult, DbErrorInfo> {
    let started = Instant::now();
    let page_size = resolved_page_size(request.page_size);
    let mut offset = request.offset.unwrap_or(0);
    if offset > MAX_OFFSET {
        return Err(DbErrorInfo::new(
            "budget",
            format!(
                "OFFSET 超过预算（{MAX_OFFSET}）：请使用主键 keyset 分页或增加过滤条件，本工具不会为跳页预扫描全表"
            ),
        ));
    }

    let columns: Vec<&DbTableColumn> = detail.columns.iter().collect();
    if columns.is_empty() {
        return Err(DbErrorInfo::new("query", "该表没有可读取的列"));
    }

    // 过滤/排序只能引用真实存在的列：这是"标识符来自验证后的元数据"的落点。
    let find_column = |name: &str| columns.iter().copied().find(|column| column.name == name);
    if let Some(filters) = &request.filters {
        for filter in filters {
            if find_column(&filter.column).is_none() {
                return Err(DbErrorInfo::new(
                    "query",
                    format!("过滤列不存在：{}", filter.column),
                ));
            }
            if !matches!(
                filter.op.as_str(),
                "eq" | "ne" | "contains" | "starts_with" | "gt" | "gte" | "lt" | "lte"
                    | "is_null"
                    | "not_null"
            ) {
                return Err(DbErrorInfo::new(
                    "query",
                    format!("不支持的过滤操作符：{}", filter.op),
                ));
            }
        }
    }
    if let Some(sorts) = &request.sorts {
        for sort in sorts {
            if find_column(&sort.column).is_none() {
                return Err(DbErrorInfo::new(
                    "query",
                    format!("排序列不存在：{}", sort.column),
                ));
            }
        }
    }

    let key_columns = detail.reliable_key.clone().unwrap_or_default();
    let has_reliable_key = !key_columns.is_empty() && detail.kind == "table";
    let order = plan_order(request, &key_columns, has_reliable_key, true)?;

    // 大字段投影：只让驱动收到预算内的字节。
    // layout: (原始列下标, 输出列下标, 长度列输出下标)。
    let mut select_parts: Vec<String> = Vec::new();
    let mut layout: Vec<(usize, usize, Option<usize>)> = Vec::new();
    let mut output_index = 0usize;
    for column in columns.iter() {
        let quoted = quote_identifier(&column.name)?;
        if is_large_type(&column.data_type) {
            select_parts.push(format!(
                "LEFT({quoted}, {})",
                budget.field_preview_bytes
            ));
            let length_position = output_index + 1;
            select_parts.push(format!("OCTET_LENGTH({quoted})"));
            layout.push((output_index, output_index, Some(length_position)));
            output_index += 2;
        } else {
            select_parts.push(quoted);
            layout.push((output_index, output_index, None));
            output_index += 1;
        }
    }

    let mut params: Vec<Value> = Vec::new();
    let mut where_parts: Vec<String> = Vec::new();
    if let Some(filters) = &request.filters {
        for filter in filters {
            if let Some(clause) = filter_clause(filter, &mut params)? {
                where_parts.push(clause);
            }
        }
    }

    let mut used_keyset = false;
    if let Some(keyset) = &order.keyset {
        if let Some(cursor) = &request.after {
            where_parts.push(keyset_clause(keyset, cursor, &mut params)?);
            used_keyset = true;
        }
    }

    if !where_parts.is_empty() {
        let where_sql = where_parts.join(" AND ");
        // 过滤条件已经包在括号里（OR 组合的 keyset），这里再包一层避免优先级问题。
        where_parts = vec![where_sql];
    }

    let quoted_database = quote_identifier(&detail.database)?;
    let quoted_table = quote_identifier(&detail.table)?;
    let where_sql = where_parts
        .first()
        .map(|clause| format!(" WHERE {clause}"))
        .unwrap_or_default();

    params.push(Value::from(u64::from(page_size) + 1));
    if !used_keyset {
        params.push(Value::from(offset));
    }

    let sql = if used_keyset {
        format!(
            "SELECT {} FROM {quoted_database}.{quoted_table}{where_sql}{} LIMIT ?",
            select_parts.join(", "),
            order.sql
        )
    } else {
        format!(
            "SELECT {} FROM {quoted_database}.{quoted_table}{where_sql}{} LIMIT ? OFFSET ?",
            select_parts.join(", "),
            order.sql
        )
    };

    let mut conn: Conn = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        profile.interactive_pool().get_conn(),
    )
    .await
    {
        Ok(Ok(conn)) => conn,
        Ok(Err(error)) => return Err(map_error(&error, "tcp")),
        Err(_) => return Err(DbErrorInfo::new("tcp", "获取表数据连接超时").retryable(true)),
    };

    let rows: Vec<mysql_async::Row> = match tokio::time::timeout(
        std::time::Duration::from_millis(profile.endpoint.profile.query_timeout_ms.max(5_000)),
        conn.exec::<mysql_async::Row, _, _>(sql, Params::Positional(params)),
    )
    .await
    {
        Ok(Ok(rows)) => rows,
        Ok(Err(error)) => return Err(map_error(&error, "query")),
        Err(_) => {
            return Err(DbErrorInfo::new(
                "timeout",
                "表数据查询超时：请增加过滤条件或减少页大小",
            ))
        }
    };

    let has_more = rows.len() > page_size as usize;
    let page_rows: Vec<&mysql_async::Row> = rows.iter().take(page_size as usize).collect();

    let column_meta: Vec<DbColumn> = columns
        .iter()
        .enumerate()
        .map(|(index, column)| browse_column(index, column))
        .collect();

    let mut truncated = false;
    let mut out_rows: Vec<Vec<DbValue>> = Vec::with_capacity(page_rows.len());
    let mut last_cursor: Option<Vec<Option<String>>> = None;

    for row in &page_rows {
        let mut values: Vec<DbValue> = Vec::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            let (_original, output, length_position) = layout
                .get(index)
                .copied()
                .unwrap_or((index, index, None));
            let real_bytes = length_position
                .and_then(|position| row.as_ref(position).cloned())
                .and_then(|value| match value {
                    Value::UInt(number) => Some(number as usize),
                    Value::Int(number) => Some(number.max(0) as usize),
                    _ => None,
                });
            let raw = row.as_ref(output).cloned().unwrap_or(Value::NULL);
            let value = to_browse_value(column, raw, budget.field_preview_bytes, real_bytes);
            if matches!(
                value,
                DbValue::Text { truncated: true, .. }
                    | DbValue::Json { truncated: true, .. }
                    | DbValue::Binary { truncated: true, .. }
            ) {
                truncated = true;
            }
            values.push(value);
        }

        if has_reliable_key {
            let cursor: Vec<Option<String>> = key_columns
                .iter()
                .map(|key| {
                    columns
                        .iter()
                        .position(|column| &column.name == key)
                        .and_then(|index| values.get(index))
                        .and_then(cursor_text)
                })
                .collect();
            if cursor.iter().all(|value| value.is_some()) {
                last_cursor = Some(cursor);
            }
        }

        out_rows.push(values);
    }

    // OFFSET 分页把"下一页起点"由 offset 推进，而不是给游标。
    if !has_more {
        last_cursor = None;
    }
    if used_keyset {
        offset = offset.saturating_add(page_rows.len() as u64);
    } else {
        offset = offset.saturating_add(page_rows.len() as u64);
    }

    let exact_rows = if request.exact_count.unwrap_or(false) {
        // COUNT(*) 只在用户显式点"精确行数"时执行。它**不**复用 keyset 游标：
        // 那是"剩余行数"，不是总数。
        let mut count_params: Vec<Value> = Vec::new();
        let mut count_clauses: Vec<String> = Vec::new();
        if let Some(filters) = &request.filters {
            for filter in filters {
                if let Some(clause) = filter_clause(filter, &mut count_params)? {
                    count_clauses.push(clause);
                }
            }
        }
        let count_where = if count_clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", count_clauses.join(" AND "))
        };
        let count_sql =
            format!("SELECT COUNT(*) FROM {quoted_database}.{quoted_table}{count_where}");
        match tokio::time::timeout(
            std::time::Duration::from_secs(20),
            conn.exec::<(i64,), _, _>(count_sql, Params::Positional(count_params)),
        )
        .await
        {
            Ok(Ok(rows)) => rows.into_iter().next().map(|(count,)| count.max(0) as u64),
            Ok(Err(error)) => return Err(map_error(&error, "query")),
            Err(_) => None,
        }
    } else {
        None
    };

    Ok(BrowseResult {
        columns: column_meta,
        rows: out_rows,
        page_size,
        offset,
        pagination: order.pagination,
        key_columns,
        next_cursor: if has_more { last_cursor } else { None },
        has_more,
        estimated_rows: detail.estimated_rows,
        exact_rows,
        has_reliable_key,
        truncated,
        warning: order.warning,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 读取一个完整字段（单元格详情）。只有可靠键才能重新定位。
pub async fn read_cell(
    profile: &ProfileRuntime,
    detail: &super::model::DbTableDetail,
    key_values: &[Option<String>],
    column: &str,
    max_bytes: usize,
) -> Result<(DbValue, usize), DbErrorInfo> {
    let key_columns = detail
        .reliable_key
        .clone()
        .ok_or_else(|| DbErrorInfo::new("query", "该表没有可靠唯一键，无法重新读取完整字段"))?;
    if key_columns.len() != key_values.len() || key_values.iter().any(|value| value.is_none()) {
        return Err(DbErrorInfo::new("query", "行定位信息不完整，无法重新读取"));
    }
    let column_meta = detail
        .columns
        .iter()
        .find(|item| item.name == column)
        .ok_or_else(|| DbErrorInfo::new("query", format!("列不存在：{column}")))?;

    let mut params: Vec<Value> = Vec::new();
    let mut where_parts = Vec::new();
    for (index, key) in key_columns.iter().enumerate() {
        where_parts.push(format!("{} = ?", quote_identifier(key)?));
        params.push(Value::Bytes(
            key_values[index].clone().unwrap_or_default().into_bytes(),
        ));
    }

    let quoted_column = quote_identifier(column)?;
    let sql = format!(
        "SELECT LEFT({quoted_column}, {}), OCTET_LENGTH({quoted_column}) FROM {}.{} WHERE {} LIMIT 2",
        max_bytes.clamp(1_024, 1024 * 1024),
        quote_identifier(&detail.database)?,
        quote_identifier(&detail.table)?,
        where_parts.join(" AND ")
    );

    let mut conn = profile
        .interactive_pool()
        .get_conn()
        .await
        .map_err(|error| map_error(&error, "tcp"))?;

    let rows: Vec<(Option<Vec<u8>>, Option<u64>)> = conn
        .exec(sql, Params::Positional(params))
        .await
        .map_err(|error| map_error(&error, "query"))?;

    if rows.len() > 1 {
        return Err(DbErrorInfo::new(
            "query",
            "定位到多行：该唯一键不再唯一，已停止读取",
        ));
    }
    let (bytes, total) = rows
        .into_iter()
        .next()
        .ok_or_else(|| DbErrorInfo::new("query", "该行已不存在（可能被其他会话删除）"))?;

    let total = total.unwrap_or(0).max(0) as usize;
    let value = match bytes {
        Some(bytes) => to_browse_value(
            column_meta,
            Value::Bytes(bytes),
            max_bytes,
            Some(total),
        ),
        None => DbValue::Null,
    };
    Ok((value, total))
}

/// `DbValue` 作为参数重新绑定（乐观并发检查用）。
pub fn bind_value(value: &DbValue) -> Result<Value, DbErrorInfo> {
    match value {
        DbValue::Null => Ok(Value::NULL),
        DbValue::Int { value, .. } => Ok(Value::Bytes(value.clone().into_bytes())),
        DbValue::Decimal { value } => Ok(Value::Bytes(value.clone().into_bytes())),
        DbValue::Float { value } => Ok(Value::Double(*value)),
        DbValue::Text { value, .. } => Ok(Value::Bytes(value.clone().into_bytes())),
        DbValue::Json { value, .. } => Ok(Value::Bytes(value.clone().into_bytes())),
        DbValue::Date { value } => Ok(Value::Bytes(value.clone().into_bytes())),
        DbValue::DateTime { value, .. } => Ok(Value::Bytes(value.clone().into_bytes())),
        DbValue::Time { value } => Ok(Value::Bytes(value.clone().into_bytes())),
        DbValue::Bit { value, .. } => Ok(Value::Bytes(value.clone().into_bytes())),
        DbValue::Binary { base64, .. } => {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(base64)
                .map_err(|error| DbErrorInfo::new("query", format!("二进制值无法解码：{error}")))?;
            Ok(Value::Bytes(bytes))
        }
        DbValue::Unsupported { .. } => Err(DbErrorInfo::new(
            "unsupported",
            "该类型不支持作为写入参数",
        )),
    }
}
