//! Docker 专用解析（第三层：语义解析）。
//!
//! 端口串、状态串这类**有产品语义**的字段才放这里；纯列式输出交给通用解析器。

use crate::output_adapter::model::{ColumnDefinition, SummaryItem, ViewType};

/// `docker images` → 统一表格（复用 `docker::parse_images`）。
pub fn image_table(stdout: &str) -> (ViewType, Vec<ColumnDefinition>, Vec<serde_json::Value>) {
    let images = crate::docker::parse_images(stdout);
    let columns = vec![
        ColumnDefinition {
            key: "repository".into(),
            label: "镜像".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "tag".into(),
            label: "标签".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "id".into(),
            label: "ID".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "size".into(),
            label: "大小".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "created_since".into(),
            label: "创建于".into(),
            numeric: false,
            thresholds: None,
        },
    ];
    let rows = images
        .into_iter()
        .map(|image| {
            serde_json::json!({
                "id": image.short_id,
                "repository": image.repository,
                "tag": image.tag,
                "size": image.size,
                "created_since": image.created_since,
                "display_name": image.display_name,
            })
        })
        .collect();
    (ViewType::Table, columns, rows)
}

/// `docker stats --no-stream` → CPU/内存指标表。
///
/// CPU 与内存百分比用阈值着色（高占用一眼可见）。
pub fn stats_table(stdout: &str) -> (ViewType, Vec<ColumnDefinition>, Vec<serde_json::Value>) {
    let stats = crate::docker::parse_stats(stdout);
    let percent = |warn: f64, danger: f64| {
        Some(crate::output_adapter::model::ColumnThresholds { warn, danger })
    };
    let columns = vec![
        ColumnDefinition {
            key: "name".into(),
            label: "容器".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "cpu_percent".into(),
            label: "CPU%".into(),
            numeric: true,
            thresholds: percent(50.0, 90.0),
        },
        ColumnDefinition {
            key: "memory_usage".into(),
            label: "内存".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "memory_percent".into(),
            label: "内存%".into(),
            numeric: true,
            thresholds: percent(70.0, 90.0),
        },
        ColumnDefinition {
            key: "net_io".into(),
            label: "网络 IO".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "block_io".into(),
            label: "磁盘 IO".into(),
            numeric: false,
            thresholds: None,
        },
    ];
    let rows = stats
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "name": row.name,
                "cpu_percent": format!("{:.2}", row.cpu_percent),
                "memory_usage": row.memory_usage,
                "memory_percent": format!("{:.2}", row.memory_percent),
                "net_io": row.net_io,
                "block_io": row.block_io,
            })
        })
        .collect();
    (ViewType::Table, columns, rows)
}

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
