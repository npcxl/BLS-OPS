//! 通用日志解析：识别常见时间戳与级别前缀，其余整行作为消息。
//!
//! 覆盖 `journalctl -o short`、`tail`、`dmesg`、docker/nginx 日志。
//! **认不出时间戳不报错** —— 该行仍然作为一条日志显示（只缺时间）。

/// 日志级别（归一化后给前端着色）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

impl LogLevel {
    /// 与 journald PRIORITY 对齐的字符串（前端按数字着色）。
    pub fn as_priority(self) -> &'static str {
        match self {
            LogLevel::Error => "3",
            LogLevel::Warn => "4",
            LogLevel::Info => "6",
            LogLevel::Debug => "7",
        }
    }
}

/// 从一行文本里猜级别（只看行首的可信标记，绝不猜正文）。
fn detect_level(line: &str) -> LogLevel {
    let upper = line.to_ascii_uppercase();
    for token in ["ERROR", "ERR", "FATAL", "CRITICAL", "CRIT", "FAIL"] {
        if upper.contains(token) {
            return LogLevel::Error;
        }
    }
    for token in ["WARN", "WARNING"] {
        if upper.contains(token) {
            return LogLevel::Warn;
        }
    }
    for token in ["DEBUG", "TRACE"] {
        if upper.contains(token) {
            return LogLevel::Debug;
        }
    }
    LogLevel::Info
}

/// 行首是否带可识别的时间戳（自动识别"这是日志"的判据之一）。
pub fn has_timestamp(line: &str) -> bool {
    let (timestamp, rest) = split_timestamp(line);
    !timestamp.is_empty() && rest != line
}

/// 行内是否带**独立成词**的级别标记（ERROR / WARN / INFO …）。
///
/// 只认词边界，绝不拿正文里的子串当级别（`terrain` 里没有 `err` 的独立
/// 单词，不会被误判）。
pub fn has_level_token(line: &str) -> bool {
    let upper = line.to_ascii_uppercase();
    upper
        .split(|c: char| !c.is_ascii_uppercase() && !c.is_ascii_digit())
        .any(|token| {
            matches!(
                token,
                "ERROR"
                    | "ERR"
                    | "FATAL"
                    | "CRIT"
                    | "CRITICAL"
                    | "FAIL"
                    | "FAILED"
                    | "WARN"
                    | "WARNING"
                    | "INFO"
                    | "NOTICE"
                    | "DEBUG"
                    | "TRACE"
            )
        })
}

/// 尝试剥离行首时间戳（`2024-01-02 03:04:05` / `Jan 02 03:04:05` / ISO8601）。
/// 剥离失败返回 `None`，时间戳为空 —— 不伪造。
fn split_timestamp(line: &str) -> (String, &str) {
    // ISO8601 / `2024-01-02 03:04:05`（可能带 ,123 毫秒或 .123456）
    let bytes = line.as_bytes();
    if bytes.len() >= 19
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && (bytes[10] == b' ' || bytes[10] == b'T')
        && bytes[13] == b':'
        && bytes[16] == b':'
    {
        return (line[..19].to_string(), line[19..].trim_start());
    }
    // syslog 形态：`Jan  2 03:04:05`
    let mut parts = line.splitn(4, ' ');
    let month = parts.next().unwrap_or("");
    let day = parts.next().unwrap_or("");
    let time = parts.next().unwrap_or("");
    let rest = parts.next();
    let is_month = matches!(
        month,
        "Jan"
            | "Feb"
            | "Mar"
            | "Apr"
            | "May"
            | "Jun"
            | "Jul"
            | "Aug"
            | "Sep"
            | "Oct"
            | "Nov"
            | "Dec"
    );
    if is_month && !day.is_empty() && time.len() >= 8 && rest.is_some() {
        return (
            format!("{month} {day} {time}"),
            rest.unwrap_or("").trim_start(),
        );
    }
    (String::new(), line)
}

/// 纯文本日志 → 统一 log 行（`{timestamp, level, unit, message}`）。
pub fn parse_log_lines(stdout: &str, unit: Option<&str>) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let (timestamp, rest) = split_timestamp(line);
            let level = detect_level(rest);
            serde_json::json!({
                "timestamp": timestamp,
                "unit": unit.unwrap_or("—"),
                "level": level.as_priority(),
                "message": rest,
            })
        })
        .collect()
}

/// 只保留错误与警告的条数（摘要用）。
pub fn count_severe(rows: &[serde_json::Value]) -> usize {
    rows.iter()
        .filter(|row| {
            row.get("level")
                .and_then(|v| v.as_str())
                .and_then(|level| level.parse::<u8>().ok())
                .is_some_and(|level| level <= 4)
        })
        .count()
}
