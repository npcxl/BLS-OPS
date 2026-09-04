//! 通用 JSON 解析：整段 JSON / JSON Lines（每行一个 JSON）。
//!
//! 覆盖 `docker inspect`、`kubectl -o json`、`journalctl -o json`、
//! `lsblk -J`、`ip -j` 等。这是**第一层（机器可读格式）**的入口。

/// 解析优先级：整段 JSON → JSON Lines → 失败。
///
/// **数据完整原则**：JSON Lines 的每个非空行都必须是合法 JSON；只要有一行
/// 解析失败就整体返回 `None`——宁可不识别，也不允许“跳过坏行、部分成功”。
/// 原始输出永远在 raw 视图完整保留，解析失败只是让结构化视图不出现。
#[derive(Debug)]
pub enum JsonShape {
    /// 单个 JSON 值（对象或数组）。
    Single(serde_json::Value),
    /// JSON Lines：每行一个 JSON 值。
    Lines(Vec<serde_json::Value>),
}

pub fn parse_json(stdout: &str) -> Option<JsonShape> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return Some(JsonShape::Single(value));
    }
    // JSON Lines：逐非空行解析；任一失败 → 整体不识别，绝不丢弃坏行。
    let mut lines = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(value) => lines.push(value),
            Err(_) => return None,
        }
    }
    if lines.is_empty() {
        None
    } else {
        Some(JsonShape::Lines(lines))
    }
}
