//! systemd 专用解析（第三层：语义解析）。
//!
//! 复用 `systemd::parse_list_units`（服务列表的唯一解析点），这里只负责把
//! 领域结构转成统一协议的 `columns` + `rows`。

use crate::output_adapter::model::{ColumnDefinition, SummaryItem, ViewType};

/// `systemctl list-units --type=service --all` → 统一表格。
pub fn list_units_table(stdout: &str) -> (ViewType, Vec<ColumnDefinition>, Vec<serde_json::Value>) {
    let units = crate::systemd::parse_list_units(stdout);
    let columns = vec![
        ColumnDefinition {
            key: "state".into(),
            label: "状态".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "unit".into(),
            label: "服务".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "description".into(),
            label: "说明".into(),
            numeric: false,
            thresholds: None,
        },
    ];
    let rows = units
        .into_iter()
        .map(|unit| {
            serde_json::json!({
                "state": unit.active,
                "sub": unit.sub,
                "load": unit.load,
                "unit": unit.unit,
                "description": unit.description,
            })
        })
        .collect();
    (ViewType::Table, columns, rows)
}

/// 服务列表摘要：运行中 / 失败 / 总数。
pub fn list_units_summary(rows: &[serde_json::Value]) -> Vec<SummaryItem> {
    let total = rows.len();
    let active = rows
        .iter()
        .filter(|row| row.get("state").and_then(|v| v.as_str()) == Some("active"))
        .count();
    let failed = rows
        .iter()
        .filter(|row| {
            let state = row.get("state").and_then(|v| v.as_str()).unwrap_or("");
            let sub = row.get("sub").and_then(|v| v.as_str()).unwrap_or("");
            state == "failed" || sub == "failed"
        })
        .count();
    vec![
        SummaryItem {
            label: "共".into(),
            value: total.to_string(),
            tone: None,
        },
        SummaryItem {
            label: "运行中".into(),
            value: active.to_string(),
            tone: Some("success".into()),
        },
        SummaryItem {
            label: "失败".into(),
            value: failed.to_string(),
            tone: if failed > 0 {
                Some("danger".into())
            } else {
                None
            },
        },
    ]
}

/// `journalctl -o json` → 统一日志行。
///
/// 保留 PRIORITY 级别；坏行跳过（半条写入不是日志）。
pub fn journal_json_lines(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter_map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).ok()?;
            let message = value.get("MESSAGE")?.as_str()?.to_string();
            let timestamp = value
                .get("__REALTIME_TIMESTAMP")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let unit = value
                .get("_SYSTEMD_UNIT")
                .and_then(|v| v.as_str())
                .unwrap_or("—")
                .to_string();
            let level = value
                .get("PRIORITY")
                .and_then(|v| v.as_str())
                .unwrap_or("6")
                .to_string();
            Some(serde_json::json!({
                "timestamp": timestamp,
                "unit": unit,
                "level": level,
                "message": message,
            }))
        })
        .collect()
}
