//! AI 提供方与复核任务的持久化。
//!
//! # 三条硬规则
//!
//! 1. **SQLite 里绝没有明文密钥** —— 只有 `api_key_ref`（钥匙串账户名）。
//!    读写钥匙串只发生在 `commands::ai_provider`，且明文只在保存那一瞬间存在。
//! 2. **删除提供方不删历史复核**：任务表只记 `provider_id` 文本，
//!    提供方没了，历史任务仍然能读（审计要能说清"当时的模型是谁"）。
//! 3. **任务表不存提示词原文与答复原文**：只存状态、耗时、次数与脱敏错误。

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::deployment::ai::model::{AiProviderConfig, AiProviderKind, AiReviewTask, AiTaskStatus};

fn kind_from_text(text: &str) -> AiProviderKind {
    match text {
        "openai_compatible" => AiProviderKind::OpenAiCompatible,
        _ => AiProviderKind::OpenAiCompatible,
    }
}

fn status_from_text(text: &str) -> AiTaskStatus {
    match text {
        "queued" => AiTaskStatus::Queued,
        "running" => AiTaskStatus::Running,
        "succeeded" => AiTaskStatus::Succeeded,
        "failed" => AiTaskStatus::Failed,
        "cancelled" => AiTaskStatus::Cancelled,
        _ => AiTaskStatus::Idle,
    }
}

fn provider_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiProviderConfig> {
    Ok(AiProviderConfig {
        id: row.get("id")?,
        name: row.get("name")?,
        provider_kind: kind_from_text(&row.get::<_, String>("provider_kind")?),
        base_url: row.get("base_url")?,
        model: row.get("model")?,
        api_key_ref: row.get("api_key_ref")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        is_default: row.get::<_, i64>("is_default")? != 0,
        allow_insecure_http: row.get::<_, i64>("allow_insecure_http")? != 0,
        timeout_seconds: row.get("timeout_seconds")?,
        max_output_tokens: row.get("max_output_tokens")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn list_providers(conn: &Connection) -> Result<Vec<AiProviderConfig>> {
    let mut statement =
        conn.prepare("SELECT * FROM ai_providers ORDER BY is_default DESC, name ASC")?;
    let rows = statement.query_map([], provider_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_provider(conn: &Connection, id: &str) -> Result<Option<AiProviderConfig>> {
    let mut statement = conn.prepare("SELECT * FROM ai_providers WHERE id = ?1")?;
    let mut rows = statement.query_map([id], provider_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 当前应当使用的提供方：**启用 + 设为默认**的那一个。
pub fn default_provider(conn: &Connection) -> Result<Option<AiProviderConfig>> {
    let mut statement = conn.prepare(
        "SELECT * FROM ai_providers WHERE enabled = 1 AND is_default = 1
         ORDER BY updated_at DESC LIMIT 1",
    )?;
    let mut rows = statement.query_map([], provider_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn upsert_provider(conn: &Connection, config: &AiProviderConfig) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO ai_providers (
            id, name, provider_kind, base_url, model, api_key_ref, enabled, is_default,
            allow_insecure_http, timeout_seconds, max_output_tokens, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            provider_kind=excluded.provider_kind,
            base_url=excluded.base_url,
            model=excluded.model,
            api_key_ref=excluded.api_key_ref,
            enabled=excluded.enabled,
            is_default=excluded.is_default,
            allow_insecure_http=excluded.allow_insecure_http,
            timeout_seconds=excluded.timeout_seconds,
            max_output_tokens=excluded.max_output_tokens,
            updated_at=excluded.updated_at
        "#,
        params![
            &config.id,
            &config.name,
            config.provider_kind.as_str(),
            &config.base_url,
            &config.model,
            &config.api_key_ref,
            config.enabled as i64,
            config.is_default as i64,
            config.allow_insecure_http as i64,
            config.timeout_seconds,
            config.max_output_tokens,
            config.created_at,
            config.updated_at,
        ],
    )?;
    Ok(())
}

/// 设为默认（同时把其它提供方取消默认 —— 默认只能有一个）。
pub fn set_default_provider(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE ai_providers SET is_default = 0 WHERE id != ?1",
        [id],
    )?;
    conn.execute("UPDATE ai_providers SET is_default = 1 WHERE id = ?1", [id])?;
    Ok(())
}

/// 删除提供方。**不动** `ai_review_tasks`（历史复核要保留），
/// 密钥的清理由命令层决定（会明确询问用户是否同步删除钥匙串条目）。
pub fn delete_provider(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM ai_providers WHERE id = ?1", [id])?;
    Ok(())
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiReviewTask> {
    Ok(AiReviewTask {
        id: row.get("id")?,
        proposal_id: row.get("proposal_id")?,
        provider_id: row.get("provider_id")?,
        model: row.get("model")?,
        status: status_from_text(&row.get::<_, String>("status")?),
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        duration_ms: row.get("duration_ms")?,
        attempts: row.get("attempts")?,
        error: row.get("error")?,
        error_code: row.get("error_code")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_review_task(conn: &Connection, task: &AiReviewTask) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO ai_review_tasks (
            id, proposal_id, provider_id, model, status, started_at, finished_at,
            duration_ms, attempts, error, error_code, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(id) DO UPDATE SET
            provider_id=excluded.provider_id,
            model=excluded.model,
            status=excluded.status,
            started_at=excluded.started_at,
            finished_at=excluded.finished_at,
            duration_ms=excluded.duration_ms,
            attempts=excluded.attempts,
            error=excluded.error,
            error_code=excluded.error_code,
            updated_at=excluded.updated_at
        "#,
        params![
            &task.id,
            &task.proposal_id,
            &task.provider_id,
            &task.model,
            match task.status {
                AiTaskStatus::Idle => "idle",
                AiTaskStatus::Queued => "queued",
                AiTaskStatus::Running => "running",
                AiTaskStatus::Succeeded => "succeeded",
                AiTaskStatus::Failed => "failed",
                AiTaskStatus::Cancelled => "cancelled",
            },
            task.started_at,
            task.finished_at,
            task.duration_ms,
            task.attempts,
            &task.error,
            &task.error_code,
            task.created_at,
            task.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get_review_task(conn: &Connection, id: &str) -> Result<Option<AiReviewTask>> {
    let mut statement = conn.prepare("SELECT * FROM ai_review_tasks WHERE id = ?1")?;
    let mut rows = statement.query_map([id], task_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 某份方案最近一次复核任务（界面用它显示"上次复核的状态"）。
pub fn latest_review_task(conn: &Connection, proposal_id: &str) -> Result<Option<AiReviewTask>> {
    let mut statement = conn.prepare(
        "SELECT * FROM ai_review_tasks WHERE proposal_id = ?1
         ORDER BY created_at DESC LIMIT 1",
    )?;
    let mut rows = statement.query_map([proposal_id], task_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 钥匙串里是否已有这份配置的密钥（**只读布尔值**，永远不返回密钥本身）。
pub fn has_api_key(provider: &AiProviderConfig) -> bool {
    provider
        .api_key_ref
        .as_deref()
        .map(|reference| !reference.trim().is_empty())
        .unwrap_or(false)
        && crate::keyring::read_secret(&provider.keyring_account()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_db;

    fn provider(id: &str, name: &str) -> AiProviderConfig {
        let mut config = AiProviderConfig::new(id, name, 1);
        config.base_url = "https://api.example.com/v1".to_string();
        config.model = "model-a".to_string();
        config
    }

    #[test]
    fn providers_round_trip_without_ever_storing_a_key() {
        let conn = test_db();
        let mut config = provider("p1", "本地");
        config.api_key_ref = Some("ai-provider:p1".to_string());
        upsert_provider(&conn, &config).expect("save");

        let loaded = get_provider(&conn, "p1").expect("get").expect("found");
        assert_eq!(loaded.id, "p1");
        assert_eq!(loaded.api_key_ref.as_deref(), Some("ai-provider:p1"));
        assert_eq!(
            loaded.timeout_seconds,
            crate::deployment::ai::model::DEFAULT_TIMEOUT_SECONDS
        );

        // 表里根本没有能装密钥的字段（只有引用列）。
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(ai_providers)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>("name"))
            .unwrap()
            .map(|name| name.unwrap())
            .collect();
        assert!(columns.contains(&"api_key_ref".to_string()));
        assert!(!columns.iter().any(|name| name.contains("api_key\"")));
        assert!(!columns.contains(&"api_key".to_string()), "{columns:?}");
    }

    #[test]
    fn only_one_provider_can_be_the_default() {
        let conn = test_db();
        upsert_provider(&conn, &provider("p1", "A")).unwrap();
        upsert_provider(&conn, &provider("p2", "B")).unwrap();
        set_default_provider(&conn, "p1").unwrap();
        set_default_provider(&conn, "p2").unwrap();

        let default = default_provider(&conn).unwrap().expect("应当有默认");
        assert_eq!(default.id, "p2");
        let p1 = get_provider(&conn, "p1").unwrap().unwrap();
        assert!(!p1.is_default, "p1 不该还是默认");
    }

    #[test]
    fn a_disabled_provider_is_not_the_default() {
        let conn = test_db();
        let mut config = provider("p1", "A");
        config.enabled = false;
        upsert_provider(&conn, &config).unwrap();
        set_default_provider(&conn, "p1").unwrap();
        assert!(default_provider(&conn).unwrap().is_none());
    }

    #[test]
    fn deleting_a_provider_keeps_the_review_history() {
        let conn = test_db();
        upsert_provider(&conn, &provider("p1", "A")).unwrap();
        let task = AiReviewTask::queued("t1", "proposal-1", 1);
        upsert_review_task(&conn, &task).unwrap();

        delete_provider(&conn, "p1").unwrap();
        assert!(get_provider(&conn, "p1").unwrap().is_none());
        // 历史任务还在（审计仍然知道"当时是谁跑的"）。
        let loaded = get_review_task(&conn, "t1").unwrap().expect("任务仍在");
        assert_eq!(loaded.status, AiTaskStatus::Queued);
        assert_eq!(
            latest_review_task(&conn, "proposal-1")
                .unwrap()
                .map(|task| task.id)
                .as_deref(),
            Some("t1")
        );
    }

    #[test]
    fn review_tasks_record_status_attempts_and_a_redacted_error() {
        let conn = test_db();
        let mut task = AiReviewTask::queued("t1", "proposal-1", 1);
        task.status = AiTaskStatus::Failed;
        task.attempts = 2;
        task.error = Some("认证失败（API Key 无效）：<redacted>".to_string());
        task.error_code = Some("auth".to_string());
        upsert_review_task(&conn, &task).unwrap();
        let loaded = get_review_task(&conn, "t1").unwrap().unwrap();
        assert_eq!(loaded.status, AiTaskStatus::Failed);
        assert_eq!(loaded.attempts, 2);
        assert_eq!(loaded.error_code.as_deref(), Some("auth"));
        assert!(loaded.error.unwrap().contains("<redacted>"));
    }
}
