//! Linux 系统命令专用解析（第三层）。
//!
//! 这几个命令的输出**不能**用通用 `split_whitespace` 稳切：
//! - `ps` 的 comm 固定但挂载/参数可能很长；
//! - `df` 的挂载点可能含空格；
//! - `ss` 的 PID/进程名嵌在方括号里。
//! 所以保留专用解析，但输出仍是统一协议。

use crate::output_adapter::model::ColumnDefinition;

/// `ps -eo pid,comm,etimes,pcpu,pmem --no-headers`：5 列固定。
pub fn process_lines(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            Some(serde_json::json!({
                "pid": columns.next()?,
                "comm": columns.next()?,
                "etimes": columns.next()?,
                "pcpu": columns.next()?,
                "pmem": columns.next()?,
            }))
        })
        .collect()
}

pub fn process_columns() -> Vec<ColumnDefinition> {
    vec![
        ColumnDefinition {
            key: "pid".into(),
            label: "PID".into(),
            numeric: true,
            thresholds: None,
        },
        ColumnDefinition {
            key: "comm".into(),
            label: "进程".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "pcpu".into(),
            label: "CPU%".into(),
            numeric: true,
            thresholds: Some(crate::output_adapter::model::ColumnThresholds {
                warn: 50.0,
                danger: 90.0,
            }),
        },
        ColumnDefinition {
            key: "pmem".into(),
            label: "内存%".into(),
            numeric: true,
            thresholds: Some(crate::output_adapter::model::ColumnThresholds {
                warn: 50.0,
                danger: 90.0,
            }),
        },
        ColumnDefinition {
            key: "etimes".into(),
            label: "运行时长".into(),
            numeric: false,
            thresholds: None,
        },
    ]
}

/// `df -hP`：6 列，挂载点含空格时并入最后一列。
pub fn df_lines(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter(|line| !line.trim_start().starts_with("Filesystem"))
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            Some(serde_json::json!({
                "filesystem": columns.next()?,
                "size": columns.next()?,
                "used": columns.next()?,
                "avail": columns.next()?,
                "use_percent": columns.next()?,
                "mounted_on": columns.collect::<Vec<_>>().join(" "),
            }))
        })
        .collect()
}

pub fn df_columns() -> Vec<ColumnDefinition> {
    vec![
        ColumnDefinition {
            key: "filesystem".into(),
            label: "文件系统".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "size".into(),
            label: "容量".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "used".into(),
            label: "已用".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "avail".into(),
            label: "可用".into(),
            numeric: false,
            thresholds: None,
        },
        // 使用率是百分比字符串（"85%"），前端按数值列解析前缀数字。
        ColumnDefinition {
            key: "use_percent".into(),
            label: "使用率".into(),
            numeric: true,
            thresholds: Some(crate::output_adapter::model::ColumnThresholds {
                warn: 75.0,
                danger: 90.0,
            }),
        },
        ColumnDefinition {
            key: "mounted_on".into(),
            label: "挂载点".into(),
            numeric: false,
            thresholds: None,
        },
    ]
}

/// `ss -tlnp`：LISTEN 行 → 端口 / 本地地址 / PID / 进程名。
pub fn ss_lines(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter(|line| line.trim_start().starts_with("LISTEN"))
        .filter_map(|line| {
            let columns: Vec<&str> = line.split_whitespace().collect();
            let local = columns.get(3)?;
            let port = local.rsplit(':').next()?.to_string();
            let pid = line
                .split("pid=")
                .nth(1)
                .map(|rest| {
                    rest.chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>()
                })
                .unwrap_or_default();
            let process = line
                .split("users:((\"")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .unwrap_or("")
                .to_string();
            Some(serde_json::json!({
                "local": local,
                "port": port,
                "pid": pid,
                "process": process,
            }))
        })
        .collect()
}

pub fn ss_columns() -> Vec<ColumnDefinition> {
    vec![
        ColumnDefinition {
            key: "port".into(),
            label: "端口".into(),
            numeric: true,
            thresholds: None,
        },
        ColumnDefinition {
            key: "local".into(),
            label: "监听地址".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "process".into(),
            label: "进程".into(),
            numeric: false,
            thresholds: None,
        },
        ColumnDefinition {
            key: "pid".into(),
            label: "PID".into(),
            numeric: true,
            thresholds: None,
        },
    ]
}
