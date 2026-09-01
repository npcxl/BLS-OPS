//! journald log querying (P3-1.2).
//!
//! `journalctl -o json` is the only output mode that preserves priority and
//! multi-line messages unambiguously, so that is what we ask for and parse.
//! Everything here is pure text-in / data-out so real fixtures can be tested.

use anyhow::Result;
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::remote::{require_linux, run_capability, run_on_linux};
use crate::safe::Capability;
use crate::ssh::SshSessionManager;

/// One journald record.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JournalEntry {
    /// ISO 8601, UTC. Server-local time would need the remote timezone, which
    /// journald does not export; UTC is at least unambiguous.
    pub timestamp: String,
    /// The unit that emitted the record, `—` when journald did not tag it.
    pub unit: String,
    /// syslog priority, 0 (emerg) … 7 (debug).
    pub priority: i32,
    pub message: String,
}

/// What to fetch. Mirrors the fields the UI exposes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JournalQuery {
    /// Restrict to one unit. `None` reads the whole journal.
    pub unit: Option<String>,
    /// Number of lines, newest last.
    pub lines: u32,
    /// Maximum priority to include (0 = emerg … 7 = debug).
    pub priority: Option<u8>,
}

/// Journald's disk footprint.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JournalDiskUsage {
    /// The line journalctl printed, shown verbatim.
    pub raw: String,
    /// Parsed byte count, when the line could be understood.
    pub bytes: Option<u64>,
}

/// Parses `journalctl -o json`, one JSON object per line.
///
/// Lines that are not valid JSON are skipped: a partial write or a concurrent
/// rotation can leave one behind, and dropping it is better than failing the
/// whole query.
pub fn parse_journal_json(input: &str) -> Vec<JournalEntry> {
    let mut entries = Vec::new();

    for line in input.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        entries.push(entry_from_json(&value));
    }

    entries
}

fn entry_from_json(value: &serde_json::Value) -> JournalEntry {
    JournalEntry {
        timestamp: format_timestamp(string_field(value, "__REALTIME_TIMESTAMP")),
        unit: unit_of(value),
        priority: priority_of(value),
        message: message_of(value),
    }
}

fn string_field<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|field| field.as_str())
}

/// journald tags the owning unit under `_SYSTEMD_UNIT`, or `UNIT` for records
/// that were relayed. Some records carry no unit at all (kernel messages).
fn unit_of(value: &serde_json::Value) -> String {
    for key in [
        "_SYSTEMD_UNIT",
        "UNIT",
        "_SYSTEMD_USER_UNIT",
        "SYSLOG_IDENTIFIER",
    ] {
        if let Some(unit) = string_field(value, key) {
            let unit = unit.trim();
            if !unit.is_empty() {
                return unit.to_string();
            }
        }
    }
    "—".to_string()
}

fn priority_of(value: &serde_json::Value) -> i32 {
    // Priority arrives as a string of digits, but tolerating a JSON number
    // keeps us working across journald versions.
    let raw = match value.get("PRIORITY") {
        Some(serde_json::Value::String(text)) => text.parse::<i32>().ok(),
        Some(number) => number.as_i64().map(|number| number as i32),
        None => None,
    };
    // Records without a priority are informational by convention.
    raw.filter(|priority| (0..=7).contains(priority))
        .unwrap_or(6)
}

/// journald exports non-UTF-8 messages as an array of bytes, so both shapes
/// have to be handled.
fn message_of(value: &serde_json::Value) -> String {
    match value.get("MESSAGE") {
        Some(serde_json::Value::String(text)) => text.trim_end().to_string(),
        Some(serde_json::Value::Array(bytes)) => {
            let raw: Vec<u8> = bytes
                .iter()
                .map(|byte| byte.as_u64().unwrap_or(0) as u8)
                .collect();
            String::from_utf8_lossy(&raw).trim_end().to_string()
        }
        _ => String::new(),
    }
}

/// Converts `__REALTIME_TIMESTAMP` (microseconds since the epoch) to ISO 8601.
///
/// Returns an empty string when the field is missing or unparseable rather
/// than a fabricated date.
pub fn format_timestamp(raw: Option<&str>) -> String {
    let Some(raw) = raw else { return String::new() };
    let Ok(micros) = raw.parse::<u64>() else {
        return String::new();
    };
    let seconds = (micros / 1_000_000) as i64;
    let nanos = ((micros % 1_000_000) * 1_000) as u32;
    match Utc.timestamp_opt(seconds, nanos).single() {
        Some(moment) => moment.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        None => String::new(),
    }
}

/// Chinese label for a syslog priority, shown in the log list.
pub fn priority_label(priority: i32) -> &'static str {
    match priority {
        0 => "紧急",
        1 => "警报",
        2 => "严重",
        3 => "错误",
        4 => "警告",
        5 => "通知",
        6 => "信息",
        7 => "调试",
        _ => "其他",
    }
}

/// Short English name, used for the CSS tone of a row.
pub fn priority_name(priority: i32) -> &'static str {
    match priority {
        0 => "emerg",
        1 => "alert",
        2 => "crit",
        3 => "err",
        4 => "warning",
        5 => "notice",
        6 => "info",
        7 => "debug",
        _ => "unknown",
    }
}

/// Parses `journalctl --disk-usage`, e.g.
/// `Archived and active journals take up 1.2G in the filesystem.`
pub fn parse_disk_usage(input: &str) -> JournalDiskUsage {
    let raw = input.trim().to_string();
    JournalDiskUsage {
        bytes: parse_human_size(&raw),
        raw,
    }
}

/// Reads a size suffix the way journald and `df` print them.
///
/// journald uses powers of 1000 for these; matching that keeps the number
/// consistent with what the user sees on the server.
pub fn parse_human_size(input: &str) -> Option<u64> {
    let token = input
        .split_whitespace()
        .find(|part| part.chars().next().is_some_and(|ch| ch.is_ascii_digit()))?;

    let split_at = token
        .find(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .unwrap_or(token.len());
    let (digits, suffix) = token.split_at(split_at);
    let value: f64 = digits.parse().ok()?;

    let multiplier = match suffix.trim().to_ascii_uppercase().as_str() {
        "" | "B" => 1.0,
        "K" | "KB" => 1_000.0,
        "M" | "MB" => 1_000_000.0,
        "G" | "GB" => 1_000_000_000.0,
        "T" | "TB" => 1_000_000_000_000.0,
        _ => return None,
    };

    Some((value * multiplier).round() as u64)
}

// -- Collection --------------------------------------------------------------

/// Fetches journal entries for a query.
///
/// Priority filtering happens on the server (`-p`) rather than after the fact,
/// so asking for errors only does not ship the entire journal over the wire.
pub async fn collect_journal(
    manager: &SshSessionManager,
    session_id: &str,
    query: &JournalQuery,
) -> Result<Vec<JournalEntry>> {
    let lines = if query.lines == 0 { 200 } else { query.lines };
    // Validated before the `uname` probe, so a bad unit name costs no round
    // trip and never becomes shell text.
    let output = run_on_linux(
        manager,
        session_id,
        &Capability::Journal {
            unit: query.unit.clone(),
            lines,
            priority: query.priority,
        },
    )
    .await?;

    Ok(parse_journal_json(&output))
}

/// How much space the journal occupies.
pub async fn collect_disk_usage(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<JournalDiskUsage> {
    require_linux(manager, session_id).await?;
    let output = run_capability(manager, session_id, &Capability::JournalDiskUsage).await?;
    Ok(parse_disk_usage(&output))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three real-shaped `journalctl -o json` records.
    const FIXTURE: &str = r#"{"__REALTIME_TIMESTAMP":"1699000000123456","_SYSTEMD_UNIT":"nginx.service","PRIORITY":"6","MESSAGE":"Started A high performance web server.","_PID":"1234"}
{"__REALTIME_TIMESTAMP":"1699000001000000","_SYSTEMD_UNIT":"nginx.service","PRIORITY":"3","MESSAGE":"bind() to 0.0.0.0:80 failed (98: Address already in use)","_PID":"1234"}
{"__REALTIME_TIMESTAMP":"1699000002000000","_SYSTEMD_UNIT":"ssh.service","PRIORITY":"6","MESSAGE":"Accepted publickey for root from 10.0.0.1 port 51234 ssh2"}
"#;

    #[test]
    fn parses_records() {
        let entries = parse_journal_json(FIXTURE);
        assert_eq!(entries.len(), 3);

        assert_eq!(entries[0].unit, "nginx.service");
        assert_eq!(entries[0].priority, 6);
        assert_eq!(entries[0].message, "Started A high performance web server.");
        // `1699000000123456` microseconds, rendered as ISO 8601 in UTC.
        assert_eq!(entries[0].timestamp, "2023-11-03T08:26:40.123Z");
    }

    #[test]
    fn keeps_priority_and_unit_per_record() {
        let entries = parse_journal_json(FIXTURE);
        assert_eq!(entries[1].priority, 3);
        assert!(entries[1].message.contains("Address already in use"));
        assert_eq!(entries[2].unit, "ssh.service");
    }

    #[test]
    fn decodes_byte_array_messages() {
        // journald emits non-UTF-8 payloads as arrays of byte values.
        let line = r#"{"__REALTIME_TIMESTAMP":"1699000000000000","_SYSTEMD_UNIT":"app.service","PRIORITY":"6","MESSAGE":[72,101,108,108,111]}"#;
        let entries = parse_journal_json(line);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "Hello");
    }

    #[test]
    fn skips_malformed_lines_without_losing_the_rest() {
        let input = format!("{}\nnot json at all\n\n", FIXTURE);
        let entries = parse_journal_json(&input);
        assert_eq!(entries.len(), 3, "坏行应被跳过，其余照常解析");
    }

    #[test]
    fn a_record_without_priority_is_informational() {
        let line = r#"{"__REALTIME_TIMESTAMP":"1699000000000000","_SYSTEMD_UNIT":"a.service","MESSAGE":"no priority"}"#;
        let entries = parse_journal_json(line);
        assert_eq!(entries[0].priority, 6);
    }

    #[test]
    fn a_record_without_a_unit_gets_a_placeholder() {
        let line = r#"{"__REALTIME_TIMESTAMP":"1699000000000000","MESSAGE":"kernel chatter"}"#;
        let entries = parse_journal_json(line);
        assert_eq!(entries[0].unit, "—");
    }

    #[test]
    fn formats_timestamps_and_tolerates_bad_input() {
        assert_eq!(
            format_timestamp(Some("1699000000123456")),
            "2023-11-03T08:26:40.123Z"
        );
        assert_eq!(format_timestamp(None), "");
        assert_eq!(format_timestamp(Some("not-a-number")), "");
    }

    #[test]
    fn priority_labels_cover_the_whole_range() {
        assert_eq!(priority_label(0), "紧急");
        assert_eq!(priority_label(3), "错误");
        assert_eq!(priority_label(7), "调试");
        assert_eq!(priority_label(99), "其他");
        assert_eq!(priority_name(3), "err");
        assert_eq!(priority_name(99), "unknown");
    }

    #[test]
    fn parses_disk_usage_sentence() {
        let usage =
            parse_disk_usage("Archived and active journals take up 1.2G in the filesystem.\n");
        assert_eq!(usage.bytes, Some(1_200_000_000));

        let usage =
            parse_disk_usage("Archived and active journals take up 24.0M in the filesystem.");
        assert_eq!(usage.bytes, Some(24_000_000));
    }

    #[test]
    fn parses_human_sizes() {
        assert_eq!(parse_human_size("take up 512B"), Some(512));
        assert_eq!(parse_human_size("take up 100K"), Some(100_000));
        assert_eq!(parse_human_size("take up 3.5G"), Some(3_500_000_000));
        assert_eq!(parse_human_size("take up 1T"), Some(1_000_000_000_000));
        assert_eq!(parse_human_size("nothing here"), None);
    }

    #[test]
    fn defaults_an_empty_line_count() {
        // The UI can send 0 before the user picks; 200 is a sane default.
        let query = JournalQuery::default();
        assert_eq!(query.lines, 0);
    }
}
