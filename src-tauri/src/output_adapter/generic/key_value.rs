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
            let line = line.trim_end();
            if line.trim().is_empty() {
                return None;
            }
            // 跳过 `[Section]` 标题行（由 parse_key_value_sections 处理）。
            if line.trim_start().starts_with('[') && line.trim_end().ends_with(']') {
                return None;
            }
            let (key, value) = if let Some((k, v)) = line.split_once(':') {
                (k, v)
            } else if let Some((k, v)) = line.split_once('=') {
                (k, v)
            } else {
                return None;
            };
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some(serde_json::json!({
                "key": key,
                "value": value.trim(),
            }))
        })
        .collect()
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
