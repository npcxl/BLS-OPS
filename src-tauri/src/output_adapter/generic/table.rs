//! 通用表格解析：空白列分隔的文本（`--no-headers` 类输出）。
//!
//! 这是**第二层（通用文本解析）**的核心：绝大多数 Linux 命令的列式输出都能
//! 用 `split_whitespace` 稳定切开。少数命令（挂载点含空格等）才需要第三层
//! 专用解析器。
//!
//! 不猜测数据类型：所有单元格都是字符串，是否当数字展示由
//! [`ColumnDefinition::numeric`] 显式声明。

use crate::output_adapter::model::ColumnDefinition;

/// 把列式文本切成行（每行的 key 取自 `columns` 的 `key`）。
///
/// - `skip_header_lines`：跳过前 N 行（`ps` 的表头、`df` 的 Filesystem 行）；
/// - 列数不足的行跳过（残缺行不是数据）；
/// - 多出的列并入**最后一列**（挂载点这类可能含空格的字段）。
pub fn parse_whitespace_table(
    stdout: &str,
    columns: &[ColumnDefinition],
    skip_header_lines: usize,
) -> Vec<serde_json::Value> {
    let expected = columns.len();
    if expected == 0 {
        return Vec::new();
    }
    stdout
        .lines()
        .skip(skip_header_lines)
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let mut row = serde_json::Map::new();
            for (index, column) in columns.iter().enumerate() {
                if index + 1 == expected {
                    // 最后一列吃掉剩余内容（挂载点可能含空格）。
                    let rest: Vec<&str> = parts.collect();
                    if rest.is_empty() {
                        return None; // 列数不足 → 残缺行，跳过
                    }
                    row.insert(column.key.clone(), serde_json::Value::from(rest.join(" ")));
                    break;
                }
                let value = parts.next()?;
                row.insert(column.key.clone(), serde_json::Value::from(value));
            }
            Some(serde_json::Value::Object(row))
        })
        .collect()
}

/// 按**固定列位置**取字段（用于 `ps` 这种前面几列固定、后面可能很长的输出）。
///
/// 与 [`parse_whitespace_table`] 的区别：这里**不要求**最后一列吃掉剩余，
/// 而是每列各取一个 token，多余的 token 丢弃。
pub fn parse_fixed_columns(
    stdout: &str,
    columns: &[ColumnDefinition],
    skip_header_lines: usize,
) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .skip(skip_header_lines)
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let mut row = serde_json::Map::new();
            for column in columns {
                let value = parts.next()?;
                row.insert(column.key.clone(), serde_json::Value::from(value));
            }
            Some(serde_json::Value::Object(row))
        })
        .collect()
}
