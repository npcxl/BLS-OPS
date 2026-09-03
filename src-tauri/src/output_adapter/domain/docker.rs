//! Docker 专用解析（第三层：语义解析）。
//!
//! 端口串、状态串这类**有产品语义**的字段才放这里；纯列式输出交给通用解析器。

use crate::output_adapter::model::{ColumnDefinition, SummaryItem, ViewType};

/// `docker ps -a` → 统一表格（复用 `docker::parse_ps`）。
pub fn container_table(stdout: &str) -> (ViewType, Vec<ColumnDefinition>, Vec<serde_json::Value>) {
    let containers = crate::docker::parse_ps(stdout);
    let columns = vec![
        ColumnDefinition {
            key: "name".into(),
            label: "容器".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "state".into(),
            label: "状态".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "image".into(),
            label: "镜像".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "ports".into(),
            label: "端口".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "status".into(),
            label: "运行时长".into(),
            numeric: false,
            thresholds: None,
        },
    ];
    let rows = containers
        .into_iter()
        .map(|container| {
            serde_json::json!({
                "id": container.id,
                "short_id": container.short_id,
                "name": container.name,
                "image": container.image,
                "state": container.state,
                "status": container.status,
                "ports": container.ports,
                "created_at": container.created_at,
            })
        })
        .collect();
    (ViewType::Table, columns, rows)
}

/// 容器摘要：运行中 / 已停止 / 其他。
pub fn container_summary(rows: &[serde_json::Value]) -> Vec<SummaryItem> {
    let total = rows.len();
    let running = rows
        .iter()
        .filter(|row| row.get("state").and_then(|v| v.as_str()) == Some("running"))
        .count();
    let exited = rows
        .iter()
        .filter(|row| row.get("state").and_then(|v| v.as_str()) == Some("exited"))
        .count();
    let other = total.saturating_sub(running).saturating_sub(exited);
    vec![
        SummaryItem {
            label: "共".into(),
            value: total.to_string(),
            tone: None,
        },
        SummaryItem {
            label: "运行中".into(),
            value: running.to_string(),
            tone: Some("success".into()),
        },
        SummaryItem {
            label: "已停止".into(),
            value: exited.to_string(),
            tone: Some("warning".into()),
        },
        SummaryItem {
            label: "其他".into(),
            value: other.to_string(),
            tone: None,
        },
    ]
}
