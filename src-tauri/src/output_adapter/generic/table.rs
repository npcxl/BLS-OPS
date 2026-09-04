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

/// 一个 token 的文本与**字节**起止偏移（偏移用于判断列对齐）。
type Token = (String, usize, usize);

/// 自动识别出的"稳定表格"（**没有列定义时的保守猜测**）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedTable {
    /// 首行（表头）原文。
    pub header: Vec<String>,
    /// 数据行 —— 列数与表头严格一致。
    pub rows: Vec<Vec<String>>,
}

/// 保守的表格检测 —— **宁可回落 raw，也不把任意文本硬拼成表格**。
///
/// 判定条件（全部满足才算表格）：
///
/// 1. **至少两行**（一行没有"表头 vs 数据"可言）；
/// 2. 列数 >= 2，且**每一行列数完全相同**（列数不稳定 = 不是表格）；
/// 3. **列对齐**：每一列的起始偏移（左对齐）或结束偏移（右对齐，数字列常
///    见）在所有行之间相差不超过 1 —— 这是把表格与"看着像表格的散文"区分
///    开的最强信号；
/// 4. 首行是**表头**：每个单元格都含字母且不是纯数字（`2024-01-02`、
///    `10:00:00` 这类时间戳会被否掉）；
/// 5. 至少有一行数据在某列上给出"值证据"：表头该列不含数字而数据含数字
///    （`Filesystem` → `/dev/sda1`）—— 防止两行散文被当成表。
///
/// 支持两种分列方式：连续空格（自动按任意空白切）与 Tab。
pub fn detect_table(stdout: &str) -> Option<DetectedTable> {
    let lines: Vec<&str> = stdout
        .lines()
        .map(|line| line.trim_end())
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.len() < 2 {
        return None;
    }
    let tabbed = lines.iter().any(|line| line.contains('\t'));
    let parsed: Vec<Vec<Token>> = lines.iter().map(|line| tokenize(line, tabbed)).collect();
    let (header_tokens, data_tokens) = parsed.split_first()?;

    // 列数由**数据行**决定（表头可能多一列，见下）。
    let columns = data_tokens.first()?.len();
    if columns < 2 || data_tokens.iter().any(|row| row.len() != columns) {
        return None; // 列数不稳定 → 不是表格
    }
    if !columns_are_aligned(data_tokens, columns) {
        return None; // 列没对齐 → 是散文，不是表格
    }

    let header: Vec<String> = if header_tokens.len() == columns {
        // 常规形态：表头与数据同列数 —— 要求连表头一起对齐（挡掉散文）。
        if !columns_are_aligned(&parsed, columns) {
            return None;
        }
        header_tokens.iter().map(|token| token.0.clone()).collect()
    } else if header_tokens.len() == columns + 1 {
        // 表头尾部多一列：真实命令里很常见 ——
        // `df -h` 的 `Mounted on`、`lsblk` 的空白 `MOUNTPOINT`（sda 没有挂载点）。
        // 此时把表头尾部合并进最后一列，且不要求表头与数据对齐（宽度本就不同）。
        let mut cells: Vec<String> = header_tokens
            .iter()
            .take(columns - 1)
            .map(|token| token.0.clone())
            .collect();
        cells.push(
            header_tokens
                .iter()
                .skip(columns - 1)
                .map(|token| token.0.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        );
        cells
    } else {
        return None; // 表头列数差得太多 → 不是表格
    };

    if !header.iter().all(|cell| is_header_cell(cell)) {
        return None; // 首行不像表头
    }
    let rows: Vec<Vec<String>> = data_tokens
        .iter()
        .map(|row| row.iter().map(|token| token.0.clone()).collect())
        .collect();
    if !has_table_evidence(&header, &rows) {
        return None;
    }
    Some(DetectedTable { header, rows })
}

/// 按空白（或 Tab）切行，同时保留每个 token 的字节起止偏移。
fn tokenize(line: &str, tabbed: bool) -> Vec<Token> {
    let bytes = line.as_bytes();
    let mut tokens = Vec::new();
    let mut start: Option<usize> = None;
    let mut index = 0;
    while index < bytes.len() {
        let is_separator = if tabbed {
            bytes[index] == b'\t'
        } else {
            bytes[index].is_ascii_whitespace()
        };
        if is_separator {
            if let Some(from) = start.take() {
                tokens.push((line[from..index].to_string(), from, index));
            }
        } else if start.is_none() {
            start = Some(index);
        }
        index += 1;
    }
    if let Some(from) = start {
        tokens.push((line[from..].to_string(), from, line.len()));
    }
    tokens
}

/// 每一列要么**左对齐**（起始偏移一致），要么**右对齐**（结束偏移一致）。
fn columns_are_aligned(parsed: &[Vec<Token>], columns: usize) -> bool {
    (0..columns).all(|column| {
        let starts: Vec<usize> = parsed.iter().map(|row| row[column].1).collect();
        if spread(&starts) <= 1 {
            return true;
        }
        let ends: Vec<usize> = parsed.iter().map(|row| row[column].2).collect();
        spread(&ends) <= 1
    })
}

fn spread(values: &[usize]) -> usize {
    let min = *values.iter().min().unwrap_or(&0);
    let max = *values.iter().max().unwrap_or(&0);
    max - min
}

/// 表头单元格：含字母（含中文等 alphabetic），且不是纯数字/时间戳。
fn is_header_cell(cell: &str) -> bool {
    !cell.is_empty() && cell.chars().any(char::is_alphabetic) && !is_number_like(cell)
}

/// 数字或类数字串（`40%` / `2024-01-02` / `10:00:00` / `1,024`）。
pub fn is_number_like(cell: &str) -> bool {
    let trimmed = cell.trim();
    if trimmed.is_empty() {
        return false;
    }
    trimmed.chars().any(|c| c.is_ascii_digit())
        && trimmed
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '-' | '+' | '%' | ':' | '/'))
}

/// "下面这些行真的是数据"的证据（两条任一成立即可）：
///
/// 1. **值证据**：某行在某个"表头不含数字"的列上给出数字
///    （`Filesystem` → `/dev/sda1`、`PID` → `912`）；
/// 2. **规模证据**：数据行 >= 3 —— 三行以上还能**逐列对齐**，几乎不可能
///    是散文（`systemctl list-unit-files` 这类纯文字表靠这条识别）。
///
/// 两行散文（`hello world` / `foo    bar`）两条都不满足 → 回落 raw。
fn has_table_evidence(header: &[String], rows: &[Vec<String>]) -> bool {
    if rows.len() >= 3 {
        return true;
    }
    rows.iter().any(|row| {
        header.iter().zip(row.iter()).any(|(head, value)| {
            !head.chars().any(|c| c.is_ascii_digit()) && value.chars().any(|c| c.is_ascii_digit())
        })
    })
}

/// 数值列判定：整列大部分非空单元格以数字开头（`50G` / `1.2GiB` / `40%`）。
fn is_numeric_cell(cell: &str) -> bool {
    let trimmed = cell.trim();
    let body = trimmed.trim_start_matches(|c| c == '+' || c == '-');
    body.starts_with(|c: char| c.is_ascii_digit())
        || (body.starts_with('.') && body.chars().nth(1).is_some_and(|c| c.is_ascii_digit()))
}

/// 表头 → 列定义（key 去重且始终可序列化；数值列自动标 numeric）。
pub fn table_columns(header: &[String], rows: &[Vec<String>]) -> Vec<ColumnDefinition> {
    let mut used: Vec<String> = Vec::new();
    header
        .iter()
        .enumerate()
        .map(|(index, label)| {
            let key = unique_key(column_key(label, index), &mut used);
            let total = rows
                .iter()
                .filter_map(|row| row.get(index))
                .filter(|cell| !cell.trim().is_empty())
                .count();
            let numeric_cells = rows
                .iter()
                .filter_map(|row| row.get(index))
                .filter(|cell| !cell.trim().is_empty() && is_numeric_cell(cell))
                .count();
            let numeric = total > 0 && numeric_cells * 10 >= total * 6;
            ColumnDefinition {
                key,
                label: label.clone(),
                numeric,
                thresholds: None,
            }
        })
        .collect()
}

fn column_key(label: &str, index: usize) -> String {
    let ascii_only: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    // 纯符号/中文表头没有稳定的 ASCII key → 用位置兜底。
    if ascii_only.is_empty() || ascii_only.starts_with(|c: char| c.is_ascii_digit()) {
        return format!("col_{}", index + 1);
    }
    ascii_only
}

fn unique_key(mut key: String, used: &mut Vec<String>) -> String {
    if !used.contains(&key) {
        used.push(key.clone());
        return key;
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{key}{suffix}");
        if !used.contains(&candidate) {
            used.push(candidate.clone());
            return candidate;
        }
        suffix += 1;
    }
}

/// 检测出的表格 → 统一协议的行（`rows` 的 key 取自列定义）。
pub fn table_rows(columns: &[ColumnDefinition], rows: &[Vec<String>]) -> Vec<serde_json::Value> {
    rows.iter()
        .map(|row| {
            let mut object = serde_json::Map::new();
            for (index, column) in columns.iter().enumerate() {
                let value = row.get(index).cloned().unwrap_or_default();
                object.insert(column.key.clone(), serde_json::Value::from(value));
            }
            serde_json::Value::Object(object)
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
