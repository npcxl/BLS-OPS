//! 命令中心的**用户态**持久化：收藏与使用记录。
//!
//! 知识条目本体是编译期常量（`command_center::builtin_catalog`），随应用
//! 版本演进，不进 SQLite —— 避免内置目录与 seed 副本之间的版本漂移。
//! 这里只存"人对命令做过什么"：收藏了哪些、执行过多少次、最近何时执行。
//! 检索排序用这两张表做个性化加权。

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// 一条使用统计。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CommandUsage {
    pub use_count: i64,
    pub last_used_at: i64,
}

pub(crate) const COMMAND_CENTER_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS command_favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    knowledge_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS command_usage (
    knowledge_id TEXT PRIMARY KEY NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_usage_recent ON command_usage(last_used_at DESC);
"#;

/// 收藏 / 取消收藏（幂等切换），返回切换后的状态。
pub fn command_favorite_toggle(conn: &Connection, knowledge_id: &str) -> Result<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT id FROM command_favorites WHERE knowledge_id = ?1",
            params!(knowledge_id),
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_some() {
        conn.execute(
            "DELETE FROM command_favorites WHERE knowledge_id = ?1",
            params!(knowledge_id),
        )?;
        Ok(false)
    } else {
        conn.execute(
            "INSERT INTO command_favorites (knowledge_id, created_at) VALUES (?1, ?2)",
            params!(knowledge_id, AppDb::now()),
        )?;
        Ok(true)
    }
}

/// 全部收藏的命令 ID。
pub fn command_favorites(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT knowledge_id FROM command_favorites ORDER BY created_at DESC")?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// 记录一次执行（upsert 计数）。
pub fn command_usage_record(conn: &Connection, knowledge_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO command_usage (knowledge_id, use_count, last_used_at)
         VALUES (?1, 1, ?2)
         ON CONFLICT(knowledge_id)
         DO UPDATE SET use_count = use_count + 1, last_used_at = ?2",
        params!(knowledge_id, AppDb::now()),
    )?;
    Ok(())
}

/// 全部使用统计（检索加权用）。
pub fn command_usage_all(conn: &Connection) -> Result<Vec<(String, CommandUsage)>> {
    let mut stmt = conn.prepare(
        "SELECT knowledge_id, use_count, last_used_at FROM command_usage ORDER BY last_used_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CommandUsage {
                    use_count: row.get(1)?,
                    last_used_at: row.get(2)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

use super::AppDb;
