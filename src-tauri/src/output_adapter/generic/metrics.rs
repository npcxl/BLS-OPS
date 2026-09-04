//! 通用指标解析：`free` / `uptime` / `vmstat` 这类"若干指标 + 数值"的输出。
//!
//! 输出统一成 `{label, value, unit?, tone?}`，前端渲染成指标卡。
//! 只解析**明确认识**的形态，认不出就返回空（由调用方回落 raw）。

/// `free -h` / `free -m` 的 Mem/Swap 行 → 指标卡。
///
/// 列：`total used free shared buff/cache available`
pub fn parse_free_metrics(stdout: &str) -> Vec<serde_json::Value> {
    let mut metrics = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        let prefix = if lower.starts_with("mem:") {
            "内存"
        } else if lower.starts_with("swap:") {
            "交换分区"
        } else {
            continue;
        };
        let columns: Vec<&str> = trimmed.split_whitespace().collect();
        // 去掉行首的 "Mem:" / "Swap:" 标签本身。
        let values: Vec<&str> = columns.into_iter().skip(1).collect();
        if values.len() < 3 {
            continue;
        }
        let total = values[0];
        let used = values[1];
        // Mem 行有 6 列（available 是第 6 列）；Swap 行只有 3 列
        // （没有 buff/cache 与 available），此时"可用"就是 free。
        let available = if values.len() >= 6 {
            values[5]
        } else {
            values[2]
        };
        metrics.push(serde_json::json!({
            "label": format!("{prefix} 总量"),
            "value": total,
        }));
        metrics.push(serde_json::json!({
            "label": format!("{prefix} 已用"),
            "value": used,
        }));
        metrics.push(serde_json::json!({
            "label": format!("{prefix} 可用"),
            "value": available,
        }));
    }
    metrics
}

/// `uptime` → 运行时长与平均负载。
///
/// 形态：` 10:00:00 up 3 days,  2:00,  1 user,  load average: 0.10, 0.20, 0.30`
pub fn parse_uptime_metrics(stdout: &str) -> Vec<serde_json::Value> {
    let line = stdout.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return Vec::new();
    }
    // 形态门槛：必须真的有 `up ` 或 `load average:`。否则任何含 "user"
    // 一词的文本都会被解析出一条"登录用户"指标（自动识别会误判成 metrics）。
    if !line.contains(" up ") && !line.contains("load average:") {
        return Vec::new();
    }
    let mut metrics = Vec::new();
    if let Some((_, rest)) = line.split_once("up ") {
        let uptime = rest.split(',').next().unwrap_or("").trim().to_string();
        if !uptime.is_empty() {
            metrics.push(serde_json::json!({
                "label": "运行时长",
                "value": uptime,
            }));
        }
    }
    if let Some((_, rest)) = line.split_once("load average:") {
        let load = rest.trim().to_string();
        if !load.is_empty() {
            metrics.push(serde_json::json!({
                "label": "平均负载",
                "value": load,
            }));
        }
    }
    if let Some((_, rest)) = line.split_once("user") {
        // `1 user` 之前的数字是登录用户数。
        let before = line[..line.len() - rest.len()].trim_end();
        let count = before.split_whitespace().last().unwrap_or("—");
        metrics.push(serde_json::json!({
            "label": "登录用户",
            "value": count,
        }));
    }
    metrics
}
