//! 通用 key_value 解析：`Key: value` / `Key = value` 两种最常见形态。
//!
//! 覆盖 `systemctl show`、`docker info`、`sysctl -a`、`ulimit -a` 等。
//! 认不出行就跳过（不伪造），`section` 形态（`[Section]`）会切成
//! [`ResultSection`](crate::output_adapter::model::ResultSection)。

use crate::output_adapter::model::{ResultSection, ViewType};

/// 一行解析出的键值对。
pub fn parse_key_value_pairs(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter_map(|line| {
            split_pair(line).map(|(key, value)| serde_json::json!({ "key": key, "value": value }))
        })
        .collect()
}

/// 单行 → `key` / `value`（**严格版**，供自动识别判定形态用）。
///
/// 宽松解析器（`parse_key_value_pairs`）会把任何带冒号的行都当成键值
/// （`10:00:00 开机` → key=`10`），自动识别若照搬就会把日志、时间、URL
/// 统统误判成属性面板。这里的额外约束：
///
/// - 跳过 `[Section]` 标题行与空行；
/// - 跳过 URL（`http://…`）：`https` 会被当成 key；
/// - key 必须**含字母**、长度 1..=64、且不是纯数字（`10:00:00` → `10` 被否）；
/// - `:` 与 `=` 都是合法分隔符。
pub fn split_pair(line: &str) -> Option<(String, String)> {
    let line = line.trim_end();
    if line.trim().is_empty() {
        return None;
    }
    if line.trim_start().starts_with('[') && line.trim_end().ends_with(']') {
        return None; // `[Section]` 标题行
    }
    if line.contains("://") {
        return None; // URL 不是属性
    }
    let (key, value) = if let Some((k, v)) = line.split_once(':') {
        (k, v)
    } else if let Some((k, v)) = line.split_once('=') {
        (k, v)
    } else {
        return None;
    };
    let key = key.trim();
    if key.is_empty() || key.len() > 64 {
        return None;
    }
    if !key.chars().any(char::is_alphabetic) {
        return None; // 纯数字 / 纯符号 → 时间戳之类，不是属性名
    }
    Some((key.to_string(), value.trim().to_string()))
}

/// 带 `[Section]` 分块的 key_value（如 `docker info`）。
///
/// 分块之前的内容归入"通用"分区。
pub fn parse_key_value_sections(stdout: &str) -> Vec<ResultSection> {
    let mut sections: Vec<ResultSection> = Vec::new();
    let mut current_title = String::from("通用");
    let mut current_rows: Vec<serde_json::Value> = Vec::new();

    let flush = |title: &str, rows: &Vec<serde_json::Value>, out: &mut Vec<ResultSection>| {
        if rows.is_empty() {
            return;
        }
        out.push(ResultSection {
            title: title.to_string(),
            view: ViewType::KeyValue,
            columns: None,
            rows: rows.clone(),
        });
    };

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() > 2 {
            flush(&current_title, &current_rows, &mut sections);
            current_rows.clear();
            current_title = trimmed[1..trimmed.len() - 1].to_string();
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        let parsed = parse_key_value_pairs(trimmed);
        if let Some(first) = parsed.into_iter().next() {
            current_rows.push(first);
        }
    }
    flush(&current_title, &current_rows, &mut sections);
    sections
}
