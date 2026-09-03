//! 通用 JSON 解析：整段 JSON / JSON Lines（每行一个 JSON）。
//!
//! 覆盖 `docker inspect`、`kubectl -o json`、`journalctl -o json`、
//! `lsblk -J`、`ip -j` 等。这是**第一层（机器可读格式）**的入口。

/// 解析优先级：整段 JSON → JSON Lines → 失败。
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
    // JSON Lines：坏行跳过（半条写入不是数据）。
    let lines: Vec<serde_json::Value> = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .collect();
    if lines.is_empty() {
        None
    } else {
        Some(JsonShape::Lines(lines))
    }
}

/// JSON 对象数组 → 表格（列名取所有对象 key 的并集，按首次出现顺序）。
///
/// `kubectl get pods -o json`、`docker inspect`（数组）走这条路径：
/// 结构稳定的 JSON 数组直接当表格看比折叠树更好读。
pub fn json_array_to_rows(items: &[serde_json::Value]) -> (Vec<String>, Vec<serde_json::Value>) {
    let mut keys: Vec<String> = Vec::new();
    for item in items {
        if let Some(object) = item.as_object() {
            for key in object.keys() {
                if !keys.contains(key) {
                    keys.push(key.clone());
                }
            }
        }
    }
    let rows = items
        .iter()
        .map(|item| {
            let mut row = serde_json::Map::new();
            for key in &keys {
                let value = item.get(key).cloned().unwrap_or(serde_json::Value::Null);
                // 嵌套结构转成紧凑 JSON 文本，避免表格里出现 [object Object]。
                let cell = match &value {
                    serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                        serde_json::Value::from(serde_json::to_string(&value).unwrap_or_default())
                    }
                    other => other.clone(),
                };
                row.insert(key.clone(), cell);
            }
            serde_json::Value::Object(row)
        })
        .collect();
    (keys, rows)
}
