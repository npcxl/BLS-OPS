//! 驱动值 → 带类型协议值的转换。
//!
//! 这里的每个分支都在回答同一个问题：**这个值在界面上如何不被误解？**
//! * `NULL` 独立变体，绝不折叠成空串；
//! * 整数/DDECIMAL 走字符串，JS 不会丢精度；
//! * 日期时间保留服务器字面值，不做时区换算；
//! * 不认识的类型落到 `Unsupported`，带类型名和受限预览，而不是丢列。

use base64::Engine;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::{Column, Value};

use super::driver::column_type_name;
use super::model::DbColumn;

fn flags(column: &Column) -> ColumnFlags {
    column.flags()
}

pub fn to_column(index: usize, column: &Column, primary_key: bool) -> DbColumn {
    let flags = flags(column);
    DbColumn {
        index,
        name: column.name_str().to_string(),
        org_name: column.org_name_str().to_string(),
        table: column.table_str().to_string(),
        org_table: column.org_table_str().to_string(),
        type_name: column_type_name(column.column_type()).to_string(),
        type_code: column.column_type() as u16,
        nullable: !flags.contains(ColumnFlags::NOT_NULL_FLAG),
        unsigned: flags.contains(ColumnFlags::UNSIGNED_FLAG),
        binary: flags.contains(ColumnFlags::BINARY_FLAG),
        primary_key,
        auto_increment: flags.contains(ColumnFlags::AUTO_INCREMENT_FLAG),
        decimals: column.decimals(),
        charset: column.character_set(),
    }
}

fn is_blob_like(kind: ColumnType) -> bool {
    matches!(
        kind,
        ColumnType::MYSQL_TYPE_TINY_BLOB
            | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
            | ColumnType::MYSQL_TYPE_LONG_BLOB
            | ColumnType::MYSQL_TYPE_BLOB
    )
}

fn is_decimal_like(kind: ColumnType) -> bool {
    matches!(
        kind,
        ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL
    )
}

fn is_date_like(kind: ColumnType) -> bool {
    matches!(
        kind,
        ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE
    )
}

fn is_datetime_like(kind: ColumnType) -> bool {
    matches!(
        kind,
        ColumnType::MYSQL_TYPE_DATETIME
            | ColumnType::MYSQL_TYPE_DATETIME2
            | ColumnType::MYSQL_TYPE_TIMESTAMP
            | ColumnType::MYSQL_TYPE_TIMESTAMP2
    )
}

fn is_time_like(kind: ColumnType) -> bool {
    matches!(
        kind,
        ColumnType::MYSQL_TYPE_TIME | ColumnType::MYSQL_TYPE_TIME2
    )
}

fn is_integer_like(kind: ColumnType) -> bool {
    matches!(
        kind,
        ColumnType::MYSQL_TYPE_TINY
            | ColumnType::MYSQL_TYPE_SHORT
            | ColumnType::MYSQL_TYPE_LONG
            | ColumnType::MYSQL_TYPE_LONGLONG
            | ColumnType::MYSQL_TYPE_INT24
            | ColumnType::MYSQL_TYPE_YEAR
    )
}

fn is_float_like(kind: ColumnType) -> bool {
    matches!(
        kind,
        ColumnType::MYSQL_TYPE_FLOAT | ColumnType::MYSQL_TYPE_DOUBLE
    )
}

/// 文本协议（`query_iter`）把**所有**值都放进 `Value::Bytes`。
/// 因此"是不是数字"必须由列的 `ColumnType` 决定，不能靠值的内容猜。
fn text_of(bytes: &[u8]) -> Option<String> {
    String::from_utf8(bytes.to_vec()).ok()
}

fn base64_of(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 按 UTF-8 边界安全截断；返回（前缀, 是否截断）。
fn truncate_utf8(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

fn text_value(text: String, preview_bytes: usize) -> super::model::DbValue {
    let bytes = text.len();
    let truncated = bytes > preview_bytes;
    let (value, _) = truncate_utf8(&text, preview_bytes);
    super::model::DbValue::Text {
        value,
        bytes,
        truncated,
    }
}

fn json_value(text: String, preview_bytes: usize) -> super::model::DbValue {
    let bytes = text.len();
    let truncated = bytes > preview_bytes;
    let (value, _) = truncate_utf8(&text, preview_bytes);
    super::model::DbValue::Json {
        value,
        bytes,
        truncated,
    }
}

fn binary_value(bytes: &[u8], preview_bytes: usize) -> super::model::DbValue {
    let total = bytes.len();
    let truncated = total > preview_bytes;
    let slice = &bytes[..total.min(preview_bytes)];
    super::model::DbValue::Binary {
        base64: base64_of(slice),
        bytes: total,
        truncated,
    }
}

fn bytes_value(column: &Column, bytes: Vec<u8>, preview_bytes: usize) -> super::model::DbValue {
    let kind = column.column_type();
    // 先按列类型判断，不能用"看起来像文本"来猜。
    if kind == ColumnType::MYSQL_TYPE_JSON {
        return match String::from_utf8(bytes) {
            Ok(text) => json_value(text, preview_bytes),
            Err(error) => binary_value(error.as_bytes(), preview_bytes),
        };
    }
    if is_decimal_like(kind) {
        return match String::from_utf8(bytes) {
            Ok(text) => super::model::DbValue::Decimal { value: text },
            // DECIMAL 不是 UTF-8 只能是协议损坏：保留原始字节，不伪造数字。
            Err(error) => binary_value(error.as_bytes(), preview_bytes),
        };
    }
    if is_date_like(kind) {
        return super::model::DbValue::Date {
            value: String::from_utf8_lossy(&bytes).to_string(),
        };
    }
    if is_datetime_like(kind) {
        return super::model::DbValue::DateTime {
            value: String::from_utf8_lossy(&bytes).to_string(),
            // MySQL 的 TIMESTAMP 会按会话时区转换；这里**不**再换算一次，
            // 只标注"服务器时区"，避免用户以为是本地时间。
            timezone: "server".to_string(),
        };
    }
    if is_time_like(kind) {
        return super::model::DbValue::Time {
            value: String::from_utf8_lossy(&bytes).to_string(),
        };
    }
    if kind == ColumnType::MYSQL_TYPE_BIT {
        let mut bits = String::from("0b");
        for byte in &bytes {
            bits.push_str(&format!("{byte:08b}"));
        }
        let mut value: u128 = 0;
        for byte in &bytes {
            value = (value << 8) | u128::from(*byte);
        }
        return super::model::DbValue::Bit {
            bits,
            value: value.to_string(),
        };
    }
    if kind == ColumnType::MYSQL_TYPE_GEOMETRY {
        return super::model::DbValue::Unsupported {
            type_name: "GEOMETRY".to_string(),
            preview: base64_of(&bytes[..bytes.len().min(preview_bytes)]),
            bytes: bytes.len(),
        };
    }
    if is_integer_like(kind) {
        let text = text_of(&bytes).unwrap_or_else(|| String::from_utf8_lossy(&bytes).to_string());
        // 校验是数字；被服务器格式化成别的样子时按文本显示，绝不猜。
        if text
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == '-' || ch == '+')
            && !text.is_empty()
        {
            return super::model::DbValue::Int {
                value: text,
                unsigned: column.flags().contains(ColumnFlags::UNSIGNED_FLAG),
            };
        }
        return text_value(text, preview_bytes);
    }
    if is_float_like(kind) {
        let text = text_of(&bytes).unwrap_or_else(|| String::from_utf8_lossy(&bytes).to_string());
        return match text.parse::<f64>() {
            Ok(value) => super::model::DbValue::Float { value },
            Err(_) => text_value(text, preview_bytes),
        };
    }
    // BLOB 系列里既有 BLOB（二进制）也有 TEXT（字符集 63 = binary）。
    // 只看类型名会把 LONGTEXT 误判成二进制，必须再看列的字符集/标志。
    let binary_column =
        column.character_set() == 63 || column.flags().contains(ColumnFlags::BINARY_FLAG);
    if is_blob_like(kind) && binary_column {
        return binary_value(&bytes, preview_bytes);
    }

    match String::from_utf8(bytes) {
        Ok(text) => text_value(text, preview_bytes),
        // 二进制内容混进了文本列（或连接字符集不匹配）：不丢，按二进制显示。
        Err(error) => binary_value(error.as_bytes(), preview_bytes),
    }
}

pub fn to_value(column: &Column, value: Value, preview_bytes: usize) -> super::model::DbValue {
    use super::model::DbValue;
    match value {
        Value::NULL => DbValue::Null,
        Value::Int(number) => DbValue::Int {
            value: number.to_string(),
            unsigned: false,
        },
        Value::UInt(number) => DbValue::Int {
            value: number.to_string(),
            unsigned: true,
        },
        Value::Float(number) => DbValue::Float {
            value: f64::from(number),
        },
        Value::Double(number) => DbValue::Float { value: number },
        Value::Bytes(bytes) => bytes_value(column, bytes, preview_bytes),
        Value::Date(year, month, day, hour, minute, second, micros) => {
            if is_date_like(column.column_type()) && hour == 0 && minute == 0 && second == 0 {
                DbValue::Date {
                    value: format!("{year:04}-{month:02}-{day:02}"),
                }
            } else if is_time_like(column.column_type()) {
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
    }
}

/// 把 UI 文本变成绑定参数。**永远不拼进 SQL 字符串**。
///
/// 不做数值解析：MySQL 会按目标列类型转换；解析失败时是服务器报错，
/// 比客户端猜一个值更诚实。
pub fn bind_text(value: &str) -> Value {
    Value::Bytes(value.as_bytes().to_vec())
}

/// 乐观并发比较用：NULL 必须用 `<=>`（NULL-safe），普通值用 `=`。
pub fn is_null_value(value: &Value) -> bool {
    matches!(value, Value::NULL)
}

pub fn export_cell(value: &super::model::DbValue) -> String {
    use super::model::DbValue;
    match value {
        DbValue::Null => String::new(),
        DbValue::Int { value, .. } => value.clone(),
        DbValue::Decimal { value } => value.clone(),
        DbValue::Float { value } => {
            if value.fract() == 0.0 && value.abs() < 1e15 {
                format!("{value:.0}")
            } else {
                value.to_string()
            }
        }
        DbValue::Text { value, .. } => value.clone(),
        DbValue::Json { value, .. } => value.clone(),
        DbValue::Date { value } => value.clone(),
        DbValue::DateTime { value, .. } => value.clone(),
        DbValue::Time { value } => value.clone(),
        DbValue::Binary { base64, .. } => base64.clone(),
        DbValue::Bit { bits, .. } => bits.clone(),
        DbValue::Unsupported { preview, .. } => preview.clone(),
    }
}

/// CSV 单元格：NULL 与空串必须可区分（NULL = 空字段，空串 = `""`）。
pub fn csv_cell(value: &super::model::DbValue) -> String {
    use super::model::DbValue;
    match value {
        DbValue::Null => String::new(),
        other => {
            let raw = export_cell(other);
            csv_quote(&raw)
        }
    }
}

/// CSV 表头/普通字符串字段的引号规则（与数据单元格一致）。
pub fn csv_field(value: &str) -> String {
    csv_quote(value)
}

fn csv_quote(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::model::DbValue;

    #[test]
    fn csv_quotes_and_keeps_null_distinct() {
        assert_eq!(csv_cell(&DbValue::Null), "");
        assert_eq!(
            csv_cell(&DbValue::Text {
                value: String::new(),
                bytes: 0,
                truncated: false
            }),
            "\"\""
        );
        assert_eq!(
            csv_cell(&DbValue::Text {
                value: "a,b".to_string(),
                bytes: 3,
                truncated: false
            }),
            "\"a,b\""
        );
        assert_eq!(
            csv_cell(&DbValue::Text {
                value: "a\"b".to_string(),
                bytes: 3,
                truncated: false
            }),
            "\"a\"\"b\""
        );
    }

    #[test]
    fn truncate_respects_utf8_boundaries() {
        let (value, truncated) = truncate_utf8("你好世界", 4);
        assert!(truncated);
        assert_eq!(value, "你");
    }

    #[test]
    fn unsigned_int_is_flagged() {
        let value = to_value(
            // 用不存在的列类型构造成本高；这里只验证字符串数字不会丢精度。
            &Column::new(ColumnType::MYSQL_TYPE_LONGLONG),
            Value::UInt(18_446_744_073_709_551_615),
            1024,
        );
        match value {
            DbValue::Int { value, unsigned } => {
                assert!(unsigned);
                assert_eq!(value, "18446744073709551615");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
