//! P4.2 命令检索：内存打分，零 I/O，可单测。
//!
//! # 为什么不用 FTS5 做知识条目检索
//!
//! 知识条目本体是编译期常量（首批 ~60 条，目标几千条），内存扫描本身就是
//! 亚毫秒级；SQLite 若再存一份会引入"内置目录升级 vs seed 副本"的版本漂移
//! 问题。FTS5 留给知识库超过万条、需要分词的场景（届时条目仍在编译期，
//! 只加一层索引）。SQLite 存的是**用户态**数据（收藏 / 使用记录），
//! 参与排序加权。
//!
//! # 打分（高→低）
//!
//! id 精确 > 别名精确 > 可执行名精确 > 命令前缀 > 别名/场景包含 >
//! 标题包含 > 描述包含 > 语法包含 > 字符子序列模糊；再叠加
//! 收藏 +150、使用次数 ×10（封顶 +100）、7 天内用过 +30。
//! 同分时只读命令排前面（风险优先）。

use std::collections::HashMap;

use super::model::{CommandKnowledge, CommandSearchHit, RiskLevel};
use crate::db;

/// 检索上下文：收藏集 + 使用统计。
#[derive(Debug, Default, Clone)]
pub struct SearchContext {
    pub favorites: Vec<String>,
    pub usage: HashMap<String, db::CommandUsage>,
}

impl SearchContext {
    pub fn load(conn: &rusqlite::Connection) -> anyhow::Result<Self> {
        let favorites = db::command_favorites(conn)?;
        let usage = db::command_usage_all(conn)?.into_iter().collect();
        Ok(Self { favorites, usage })
    }
}

/// 检索知识库。空查询返回"收藏 + 最近使用 + 兜底推荐"。
pub fn search(
    catalog: &[CommandKnowledge],
    query: &str,
    ctx: &SearchContext,
    limit: usize,
) -> Vec<CommandSearchHit> {
    let q = normalize(query);
    let mut scored: Vec<(f64, &CommandKnowledge)> = catalog
        .iter()
        .filter_map(|entry| Some((score_entry(entry, &q, ctx)?, entry)))
        .collect();
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                // 同分：只读优先，再按 id 保证稳定。
                a.1.risk
                    .rank()
                    .cmp(&b.1.risk.rank())
                    .then(a.1.id.cmp(b.1.id))
            })
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(score, entry)| to_hit(entry, score, ctx))
        .collect()
}

fn to_hit(entry: &CommandKnowledge, score: f64, ctx: &SearchContext) -> CommandSearchHit {
    CommandSearchHit {
        id: entry.id.to_string(),
        executable: entry.executable.to_string(),
        subcommand: entry.subcommand.to_string(),
        title: entry.title.to_string(),
        description: entry.description.to_string(),
        category: entry.category,
        syntax: entry.syntax.to_string(),
        risk: entry.risk,
        mutability: entry.mutability,
        output_adapter: entry.output_adapter.to_string(),
        requires: entry
            .requires
            .iter()
            .map(|tool| tool.name().to_string())
            .collect(),
        required_params: entry
            .exec
            .required_params()
            .iter()
            .map(|name| name.to_string())
            .collect(),
        placeholders: super::model::placeholders_in(entry.syntax),
        can_execute: entry.executable_now(),
        favorite: ctx.favorites.iter().any(|id| id == entry.id),
        score,
    }
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

/// 返回 `None` 表示该条目与查询无关（空查询除外）。
fn score_entry(entry: &CommandKnowledge, q: &str, ctx: &SearchContext) -> Option<f64> {
    let display = normalize(&entry.display_command());
    let title = normalize(entry.title);
    let description = normalize(entry.description);
    let syntax = normalize(entry.syntax);
    let id = normalize(entry.id);

    let mut score = if q.is_empty() {
        // 空查询：只推荐收藏 / 用过 / 高频默认（由 base 分 + 加权决定）。
        base_recency(entry.id, ctx)?
    } else if id == q {
        1000.0
    } else if entry.aliases.iter().any(|a| normalize(a) == q) {
        900.0
    } else if display == q || entry.executable.eq_ignore_ascii_case(q) {
        850.0
    } else if display.starts_with(q) || entry.executable.to_lowercase().starts_with(q) {
        // 前缀补全是输入提示的主路径（`docker p` → docker ps）。
        700.0 - display.len() as f64 * 0.5
    } else if entry.aliases.iter().any(|a| normalize(a).contains(q)) {
        600.0
    } else if entry.scenarios.iter().any(|s| normalize(s).contains(q)) {
        550.0
    } else if title.contains(q) {
        500.0
    } else if description.contains(q) {
        300.0
    } else if syntax.contains(q) {
        250.0
    } else if is_subsequence(q, &display) || is_subsequence(q, &id) {
        // `dps` → docker ps；`dpsa` → docker ps -a。
        150.0
    } else {
        return None;
    };

    // 个性化加权。
    if ctx.favorites.iter().any(|id| id == entry.id) {
        score += 150.0;
    }
    if let Some(usage) = ctx.usage.get(entry.id) {
        score += (usage.use_count as f64 * 10.0).min(100.0);
        // 7 天内用过 → 再加时近性分。
        let week_ms = 7 * 24 * 3600 * 1000;
        if db::AppDb::now() - usage.last_used_at < week_ms {
            score += 30.0;
        }
    }
    // 只读命令在同分下优先（排序处也会 tiebreak）。
    score -= entry.risk.rank() as f64;
    Some(score)
}

/// 空查询的兜底分：只有收藏 / 用过的命令，外加常用只读推荐。
fn base_recency(id: &str, ctx: &SearchContext) -> Option<f64> {
    if ctx.favorites.iter().any(|fav| fav == id) {
        return Some(120.0);
    }
    if let Some(usage) = ctx.usage.get(id) {
        return Some(60.0 + (usage.use_count as f64 * 5.0).min(50.0));
    }
    None
}

/// `needle` 的全部字符是否按顺序出现在 `haystack` 中（子序列模糊匹配）。
fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut chars = haystack.chars();
    for need in needle.chars() {
        if need.is_ascii_whitespace() {
            continue;
        }
        loop {
            match chars.next() {
                Some(c) if c == need => break,
                Some(_) => continue,
                None => return false,
            }
        }
    }
    true
}
