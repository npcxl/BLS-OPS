//! 自动输出识别 —— 没有可用先验（专用适配器）时，按输出形态判定视图。
//!
//! # 为什么需要它
//!
//! 知识库 100+ 条命令里绝大多数没有（也不该有）专用适配器。过去这些命令
//! 一律 `generic-raw-output` → 只有一坨原始文本，用户自己数列。现在统一走
//! 这里的**形态识别**：认得出就给结构化视图，认不出就老实回落 raw。
//!
//! # 识别顺序（自上而下，第一个命中的胜出）
//!
//! 1. JSON / JSON Lines
//! 2. 稳定表格（列数一致 + 列对齐 + 表头）
//! 3. `key: value` / `key = value`
//! 4. 日志（时间戳 / 级别标记占多数）
//! 5. metrics（`free` / `uptime` 形态）
//! 6. 树（树线字符 + 缩进层级）
//! 7. 纯文本（短、无结构）
//! 8. raw 回落
//!
//! # 铁律
//!
//! - **每个识别器都必须"挑剔"**：宁可让它返回 `None` 走下一层，也不能把
//!   任意文本硬套成一个看起来对其实错的表格。`parse_log_lines` 那种"任何
//!   非空行都算一条日志"的宽容解析器**不能直接当识别器**，必须先过置信度
//!   门槛（见 [`detect_log`]）。
//! - 专用适配器只是 **hint**：先试，失败后继续走 auto，**绝不直接 raw**。
//! - 命令含管道/重定向时**禁用 hint** —— 管道会改变列结构，套用主命令的
//!   专用适配器必然解析出错误表格（见 [`has_shell_operator`]）。

use super::generic;
use super::model::{ColumnDefinition, ResultSection, SummaryItem, ViewType};
use super::registry::AdapterContext;

/// 一次自动识别的产物。
pub(super) struct AutoHit {
    pub view: ViewType,
    pub summary: Vec<SummaryItem>,
    pub columns: Vec<ColumnDefinition>,
    pub rows: Vec<serde_json::Value>,
    pub sections: Vec<ResultSection>,
    pub json: Option<serde_json::Value>,
    /// 识别到的形态（人话，用于测试与说明）。
    pub label: &'static str,
}

impl AutoHit {
    fn rows_of(view: ViewType, label: &'static str, rows: Vec<serde_json::Value>) -> Self {
        Self {
            view,
            summary: vec![count("行", rows.len())],
            columns: Vec::new(),
            rows,
            sections: Vec::new(),
            json: None,
            label,
        }
    }
}

fn count(label: &str, value: usize) -> SummaryItem {
    SummaryItem {
        label: label.to_string(),
        value: value.to_string(),
        tone: None,
    }
}

/// 自动识别：返回识别出的形态；`None` = 老老实实回落 raw。
pub fn detect(stdout: &str) -> Option<AutoHit> {
    detect_json(stdout)
        .or_else(|| detect_table(stdout))
        .or_else(|| detect_key_value(stdout))
        .or_else(|| detect_log(stdout))
        .or_else(|| detect_metrics(stdout))
        .or_else(|| detect_tree(stdout))
        .or_else(|| detect_text(stdout))
}

/// 给人看的形态名（`raw` = 未识别）。测试与调试用。
pub fn describe(stdout: &str) -> &'static str {
    detect(stdout).map_or("raw", |hit| hit.label)
}

// ── 1. JSON ────────────────────────────────────────────────────────────────

fn detect_json(stdout: &str) -> Option<AutoHit> {
    match generic::json::parse_json(stdout)? {
        generic::json::JsonShape::Single(value) => Some(AutoHit {
            view: ViewType::Json,
            summary: Vec::new(),
            columns: Vec::new(),
            rows: Vec::new(),
            sections: Vec::new(),
            json: Some(value),
            label: "json",
        }),
        generic::json::JsonShape::Lines(lines) => Some(AutoHit {
            view: ViewType::Json,
            summary: vec![count("记录", lines.len())],
            columns: Vec::new(),
            rows: Vec::new(),
            sections: Vec::new(),
            json: Some(serde_json::Value::Array(lines)),
            label: "json-lines",
        }),
    }
}

// ── 2. 稳定表格 ────────────────────────────────────────────────────────────

fn detect_table(stdout: &str) -> Option<AutoHit> {
    let table = generic::table::detect_table(stdout)?;
    let columns = generic::table::table_columns(&table.header, &table.rows);
    let rows = generic::table::table_rows(&columns, &table.rows);
    Some(AutoHit {
        view: ViewType::Table,
        summary: vec![count("行", rows.len())],
        columns,
        rows,
        sections: Vec::new(),
        json: None,
        label: "table",
    })
}

// ── 3. key: value ──────────────────────────────────────────────────────────

fn detect_key_value(stdout: &str) -> Option<AutoHit> {
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.len() < 2 {
        return None; // 只有一行的 "key: value" 也可能是正文里的一句话
    }
    let parsed = lines
        .iter()
        .filter(|line| generic::key_value::split_pair(line).is_some())
        .count();
    // 置信度门槛：至少 2 行、且 60% 以上的非空行都能解析成键值对。
    if parsed < 2 || parsed * 100 < lines.len() * 60 {
        return None;
    }
    let sections = generic::key_value::parse_key_value_sections(stdout);
    let total: usize = sections.iter().map(|section| section.rows.len()).sum();
    if total == 0 {
        return None;
    }
    Some(AutoHit {
        view: ViewType::KeyValue,
        summary: vec![count("属性", total)],
        columns: Vec::new(),
        rows: Vec::new(),
        sections,
        json: None,
        label: "key_value",
    })
}

// ── 4. 日志 ────────────────────────────────────────────────────────────────

fn detect_log(stdout: &str) -> Option<AutoHit> {
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.len() < 2 {
        return None;
    }
    let timed = lines
        .iter()
        .filter(|line| generic::log::has_timestamp(line))
        .count();
    let levelled = lines
        .iter()
        .filter(|line| generic::log::has_level_token(line))
        .count();
    // 日志的两个可信信号：时间戳占多数，或"有时间戳 + 级别标记占多数"。
    // 只凭 `parse_log_lines` 能解析是不够的 —— 它对任何非空行都返回一条日志。
    let looks_like_log = timed * 2 >= lines.len() || (timed >= 1 && levelled * 2 >= lines.len());
    if !looks_like_log {
        return None;
    }
    let rows = generic::log::parse_log_lines(stdout, None);
    let severe = generic::log::count_severe(&rows);
    Some(AutoHit {
        view: ViewType::Log,
        summary: vec![
            count("行", rows.len()),
            SummaryItem {
                label: "错误与警告".into(),
                value: severe.to_string(),
                tone: if severe > 0 {
                    Some("danger".into())
                } else {
                    None
                },
            },
        ],
        columns: Vec::new(),
        rows,
        sections: Vec::new(),
        json: None,
        label: "log",
    })
}

// ── 5. metrics ─────────────────────────────────────────────────────────────

fn detect_metrics(stdout: &str) -> Option<AutoHit> {
    let mut rows = generic::metrics::parse_free_metrics(stdout);
    rows.extend(generic::metrics::parse_uptime_metrics(stdout));
    if rows.is_empty() {
        return None;
    }
    Some(AutoHit {
        view: ViewType::Metrics,
        summary: Vec::new(),
        columns: Vec::new(),
        rows,
        sections: Vec::new(),
        json: None,
        label: "metrics",
    })
}

// ── 6. 树 ──────────────────────────────────────────────────────────────────

const TREE_GLYPHS: [&str; 6] = ["├──", "└──", "├─", "└─", "│", "──"];

fn detect_tree(stdout: &str) -> Option<AutoHit> {
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.len() < 2 {
        return None;
    }
    // 必须真的有树线字符（缩进本身不足以区分"树"和"缩进的日志/配置"）。
    let glyph_lines = lines
        .iter()
        .filter(|line| TREE_GLYPHS.iter().any(|glyph| line.contains(glyph)))
        .count();
    if glyph_lines == 0 {
        return None;
    }
    let rows = generic::tree::parse_tree_lines(stdout);
    if rows.is_empty() {
        return None;
    }
    let max_depth = rows
        .iter()
        .filter_map(|row| row.get("depth").and_then(|v| v.as_u64()))
        .max()
        .unwrap_or(0);
    if max_depth == 0 {
        return None; // 全在同一层 → 是列表不是树
    }
    Some(AutoHit::rows_of(ViewType::Tree, "tree", rows))
}

// ── 7. 纯文本 ──────────────────────────────────────────────────────────────

fn detect_text(stdout: &str) -> Option<AutoHit> {
    if stdout.trim().is_empty() {
        return None;
    }
    // "concise text" 的边界：短到值得原样展示，长到该交给 raw（可直接翻页）。
    if stdout.chars().count() > 8_000 {
        return None;
    }
    let lines = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    if lines == 0 || lines > 200 {
        return None;
    }
    Some(AutoHit {
        view: ViewType::Text,
        summary: vec![count("行", lines)],
        columns: Vec::new(),
        rows: Vec::new(),
        sections: Vec::new(),
        json: None,
        label: "text",
    })
}

// ── 统一入口 ───────────────────────────────────────────────────────────────

/// 命令里是否含会**改变输出结构**的 shell 操作符（管道 / 重定向 / 链式）。
///
/// 有这些符号时，输出不再由主命令决定（`df -h | grep /dev` 的列结构由
/// grep 之后的整条管线决定），**主命令的专用适配器必然解析错**。引号内的
/// 符号不算（`awk '{print $1}'` 里的 `$` 不是操作符）。
pub fn has_shell_operator(command: &str) -> bool {
    let mut in_single = false;
    let mut in_double = false;
    for ch in command.chars() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '|' | ';' | '>' | '<' | '&' | '`' | '$' if !in_single && !in_double => return true,
            _ => {}
        }
    }
    false
}

/// **统一自动输出适配入口。**
///
/// `adapter_hint` 是知识库给的建议（专用适配器 id），只作为**优先尝试**：
/// - 命中且解析出非 raw 视图 → 直接采用（专用解析比通用猜更准）；
/// - 未命中 / 解析失败 → **继续走 auto**，绝不直接 raw；
/// - 命令含管道/重定向 → **跳过 hint**，只看最终输出。
///
/// 失败原因会写进 `warnings`（可见，不静默）。
pub fn adapt_auto(
    adapter_hint: Option<&str>,
    stdout: &str,
    ctx: &AdapterContext,
) -> super::model::StructuredCommandResult {
    let mut note: Option<String> = None;

    if let Some(hint) = adapter_hint.filter(|id| !id.is_empty() && *id != "auto") {
        if has_shell_operator(&ctx.meta.command) {
            note = Some(format!(
                "命令含管道/重定向，已跳过专用适配器 {hint}，改按最终输出自动识别"
            ));
        } else {
            let specialized = super::registry().adapt(hint, stdout, ctx);
            if specialized.view != ViewType::Raw {
                return specialized;
            }
            note = Some(format!(
                "专用适配器 {hint} 未匹配本次输出，已按最终输出自动识别"
            ));
        }
    }

    let mut result = match detect(stdout) {
        Some(hit) => super::model::StructuredCommandResult {
            view: hit.view,
            title: ctx.title.clone(),
            summary: hit.summary,
            columns: hit.columns,
            rows: hit.rows,
            sections: hit.sections,
            warnings: Vec::new(),
            meta: ctx.meta.clone(),
            raw: ctx.raw.clone(),
            json: hit.json,
        },
        None => super::model::StructuredCommandResult::raw_fallback(
            ctx.title.clone(),
            ctx.meta.clone(),
            ctx.raw.clone(),
        ),
    };
    if let Some(note) = note {
        result.warnings.push(note);
    }
    result
}
