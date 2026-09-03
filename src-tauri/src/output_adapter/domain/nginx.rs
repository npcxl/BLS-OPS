//! Nginx 专用解析（第三层：server/location 关系是有语义的嵌套结构）。

use crate::output_adapter::model::{ColumnDefinition, SummaryItem, ViewType};

/// `nginx -T` 生效配置 → 统一表格（站点维度）。
///
/// 每个 server block 一行：域名 / 端口 / 静态 root / 代理目标 / 配置文件。
pub fn site_table(stdout: &str) -> (ViewType, Vec<ColumnDefinition>, Vec<serde_json::Value>) {
    let sites = crate::deployment_collector::parse_nginx_effective(stdout);
    let columns = vec![
        ColumnDefinition {
            key: "server_name".into(),
            label: "server_name".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "listen".into(),
            label: "listen".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "root".into(),
            label: "静态 root".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "proxy_pass".into(),
            label: "proxy_pass".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "config_file".into(),
            label: "配置文件".into(),
            numeric: false,
            thresholds: None,
        },
    ];
    let rows = sites
        .iter()
        .map(|site| {
            serde_json::json!({
                "server_name": site.name,
                "listen": site.listen_ports.iter().map(|p| p.to_string()).collect::<Vec<_>>().join("/"),
                "root": site.root.clone().unwrap_or_default(),
                "proxy_pass": site.proxy_targets.join(", "),
                "config_file": site.config_file.clone().unwrap_or_default(),
            })
        })
        .collect();
    (ViewType::Table, columns, rows)
}

/// 站点摘要：站点数 / 静态站点数 / 反向代理数。
pub fn site_summary(rows: &[serde_json::Value]) -> Vec<SummaryItem> {
    let total = rows.len();
    let proxied = rows
        .iter()
        .filter(|row| {
            row.get("proxy_pass")
                .and_then(|v| v.as_str())
                .is_some_and(|value| !value.trim().is_empty())
        })
        .count();
    let statics = rows
        .iter()
        .filter(|row| {
            row.get("root")
                .and_then(|v| v.as_str())
                .is_some_and(|value| !value.trim().is_empty())
        })
        .count();
    vec![
        SummaryItem {
            label: "站点".into(),
            value: total.to_string(),
            tone: None,
        },
        SummaryItem {
            label: "反向代理".into(),
            value: proxied.to_string(),
            tone: Some("accent".into()),
        },
        SummaryItem {
            label: "静态站点".into(),
            value: statics.to_string(),
            tone: None,
        },
    ]
}
