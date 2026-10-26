//! P5.6 部署会话与用户 Memory 的持久化。
//!
//! 两张表都只存**结构化字段**：`current_question_json` 存受控问题、`value_json`
//! 存已过校验的 Memory 值、事件 `detail` 只允许脱敏摘要（绝不写 Secret）。

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::deployment::session::memory::{
    DeploymentMemory, MemoryKey, MemoryKind, MemoryScope, MemorySourceType, MemoryStatus,
};
use crate::deployment::session::model::{
    DeploymentSession, DeploymentSessionEvent, QuestionKind, SessionEventKind, SessionQuestion,
    SessionStatus,
};

/// 用一个枚举的 `ALL` + `as_str` 反查（避免为每个枚举再写一遍 match）。
fn parse_enum<T: Copy>(all: &[T], text: &str, as_str: fn(T) -> &'static str) -> Option<T> {
    all.iter().copied().find(|item| as_str(*item) == text)
}

fn parse_status(text: &str) -> SessionStatus {
    parse_enum(SessionStatus::ALL, text, |value| value.as_str()).unwrap_or(SessionStatus::Created)
}

fn parse_event_kind(text: &str) -> SessionEventKind {
    parse_enum(SessionEventKind::ALL, text, |value| value.as_str())
        .unwrap_or(SessionEventKind::StatusChanged)
}

fn parse_question_kind(text: &str) -> QuestionKind {
    match text {
        "environment_kind" => QuestionKind::EnvironmentKind,
        "domain" => QuestionKind::Domain,
        "capacity" => QuestionKind::Capacity,
        "port" => QuestionKind::Port,
        "secret_reference" => QuestionKind::SecretReference,
        "database_hosting" => QuestionKind::DatabaseHosting,
        "dns_ownership" => QuestionKind::DnsOwnership,
        _ => QuestionKind::Other,
    }
}

fn parse_memory_kind(text: &str) -> MemoryKind {
    parse_enum(MemoryKind::ALL, text, |value| value.as_str()).unwrap_or(MemoryKind::Preference)
}

fn parse_memory_scope(text: &str) -> MemoryScope {
    parse_enum(MemoryScope::ALL, text, |value| value.as_str()).unwrap_or(MemoryScope::Global)
}

fn parse_memory_status(text: &str) -> MemoryStatus {
    parse_enum(MemoryStatus::ALL, text, |value| value.as_str()).unwrap_or(MemoryStatus::Pending)
}

fn parse_source_type(text: &str) -> MemorySourceType {
    match text {
        "explicit" => MemorySourceType::Explicit,
        "repeated_choice" => MemorySourceType::RepeatedChoice,
        "proposal_edit" => MemorySourceType::ProposalEdit,
        _ => MemorySourceType::DeploymentResult,
    }
}

// -- 会话 --------------------------------------------------------------------

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentSession> {
    let status: String = row.get("status")?;
    let question: Option<String> = row.get("current_question_json")?;
    Ok(DeploymentSession {
        id: row.get("id")?,
        source_snapshot_id: row.get("source_snapshot_id")?,
        application_id: row.get("application_id")?,
        environment_id: row.get("environment_id")?,
        server_id: row.get("server_id")?,
        user_description: row.get("user_description")?,
        status: parse_status(&status),
        current_question: question.and_then(|text| serde_json::from_str(&text).ok()),
        proposal_id: row.get("proposal_id")?,
        plan_id: row.get("plan_id")?,
        run_id: row.get("run_id")?,
        input_fingerprint: row.get("input_fingerprint")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_session(conn: &Connection, session: &DeploymentSession) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO deployment_sessions (
            id, source_snapshot_id, application_id, environment_id, server_id, user_description,
            status, current_question_json, proposal_id, plan_id, run_id, input_fingerprint,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
            source_snapshot_id=excluded.source_snapshot_id,
            application_id=excluded.application_id,
            environment_id=excluded.environment_id,
            server_id=excluded.server_id,
            user_description=excluded.user_description,
            status=excluded.status,
            current_question_json=excluded.current_question_json,
            proposal_id=excluded.proposal_id,
            plan_id=excluded.plan_id,
            run_id=excluded.run_id,
            input_fingerprint=excluded.input_fingerprint,
            updated_at=excluded.updated_at
        "#,
        params![
            &session.id,
            &session.source_snapshot_id,
            &session.application_id,
            &session.environment_id,
            &session.server_id,
            &session.user_description,
            session.status.as_str(),
            serde_json::to_string(&session.current_question).ok(),
            &session.proposal_id,
            &session.plan_id,
            &session.run_id,
            &session.input_fingerprint,
            session.created_at,
            session.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get_session(conn: &Connection, id: &str) -> Result<Option<DeploymentSession>> {
    let mut statement = conn.prepare("SELECT * FROM deployment_sessions WHERE id = ?1")?;
    let mut rows = statement.query_map([id], session_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 最近的会话（界面默认入口用）。
pub fn list_sessions(conn: &Connection, limit: usize) -> Result<Vec<DeploymentSession>> {
    let mut statement =
        conn.prepare("SELECT * FROM deployment_sessions ORDER BY updated_at DESC LIMIT ?1")?;
    let rows = statement.query_map([limit as i64], session_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 有未完成会话时优先返回它（避免用户丢失进度）。
pub fn latest_active_session(conn: &Connection) -> Result<Option<DeploymentSession>> {
    let mut statement = conn.prepare(
        "SELECT * FROM deployment_sessions
         WHERE status NOT IN ('succeeded','failed','rolled_back','cancelled')
         ORDER BY updated_at DESC LIMIT 1",
    )?;
    let mut rows = statement.query_map([], session_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 幂等：用确认键找回同一次确认的会话（防双击产生两次部署）。
pub fn find_session_by_confirm_key(
    conn: &Connection,
    key: &str,
) -> Result<Option<DeploymentSession>> {
    let mut statement =
        conn.prepare("SELECT * FROM deployment_sessions WHERE confirm_idempotency_key = ?1")?;
    let mut rows = statement.query_map([key], session_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 读取上一次确认的结果 JSON（幂等重放时直接返回它）。
pub fn get_confirm_result(conn: &Connection, session_id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT confirm_result_json FROM deployment_sessions WHERE id = ?1",
        [session_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .or_else(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.into()),
    })
}

/// 记录一次确认（键 + 结果），供幂等重放。
pub fn set_confirm_result(
    conn: &Connection,
    session_id: &str,
    key: &str,
    result_json: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE deployment_sessions SET confirm_idempotency_key = ?2, confirm_result_json = ?3
         WHERE id = ?1",
        params![session_id, key, result_json],
    )?;
    Ok(())
}

// -- 事件 --------------------------------------------------------------------

fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentSessionEvent> {
    let kind: String = row.get("kind")?;
    let from: Option<String> = row.get("from_status")?;
    let to: Option<String> = row.get("to_status")?;
    Ok(DeploymentSessionEvent {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        kind: parse_event_kind(&kind),
        from_status: from.as_deref().map(parse_status),
        to_status: to.as_deref().map(parse_status),
        detail: row.get("detail")?,
        created_at: row.get("created_at")?,
    })
}

pub fn append_event(conn: &Connection, event: &DeploymentSessionEvent) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO deployment_session_events (
            id, session_id, kind, from_status, to_status, detail, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![
            &event.id,
            &event.session_id,
            event.kind.as_str(),
            event.from_status.map(|status| status.as_str()),
            event.to_status.map(|status| status.as_str()),
            &event.detail,
            event.created_at,
        ],
    )?;
    Ok(())
}

pub fn list_events(conn: &Connection, session_id: &str) -> Result<Vec<DeploymentSessionEvent>> {
    let mut statement = conn.prepare(
        "SELECT * FROM deployment_session_events WHERE session_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = statement.query_map([session_id], event_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// -- Memory ------------------------------------------------------------------

fn memory_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentMemory> {
    let kind: String = row.get("kind")?;
    let scope: String = row.get("scope")?;
    let key: String = row.get("key")?;
    let status: String = row.get("status")?;
    let source_type: String = row.get("source_type")?;
    let value: String = row.get("value_json")?;
    Ok(DeploymentMemory {
        id: row.get("id")?,
        kind: parse_memory_kind(&kind),
        scope: parse_memory_scope(&scope),
        scope_id: row.get("scope_id")?,
        key: MemoryKey::parse(&key).unwrap_or(MemoryKey::PreferredRuntime),
        value_json: serde_json::from_str(&value).unwrap_or(serde_json::Value::Null),
        confidence: row.get::<_, i64>("confidence")?.clamp(0, 100) as u8,
        source_type: parse_source_type(&source_type),
        source_event_id: row.get("source_event_id")?,
        status: parse_memory_status(&status),
        success_count: row.get::<_, i64>("success_count")?.max(0) as u32,
        failure_count: row.get::<_, i64>("failure_count")?.max(0) as u32,
        last_used_at: row.get("last_used_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_memory(conn: &Connection, memory: &DeploymentMemory) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO deployment_memory (
            id, kind, scope, scope_id, key, value_json, confidence, source_type,
            source_event_id, status, success_count, failure_count, last_used_at,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        ON CONFLICT(id) DO UPDATE SET
            kind=excluded.kind,
            scope=excluded.scope,
            scope_id=excluded.scope_id,
            key=excluded.key,
            value_json=excluded.value_json,
            confidence=excluded.confidence,
            source_type=excluded.source_type,
            source_event_id=excluded.source_event_id,
            status=excluded.status,
            success_count=excluded.success_count,
            failure_count=excluded.failure_count,
            last_used_at=excluded.last_used_at,
            updated_at=excluded.updated_at
        "#,
        params![
            &memory.id,
            memory.kind.as_str(),
            memory.scope.as_str(),
            &memory.scope_id,
            memory.key.as_str(),
            serde_json::to_string(&memory.value_json).unwrap_or_else(|_| "null".to_string()),
            memory.confidence as i64,
            memory.source_type.as_str(),
            &memory.source_event_id,
            memory.status.as_str(),
            memory.success_count as i64,
            memory.failure_count as i64,
            memory.last_used_at,
            memory.created_at,
            memory.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get_memory(conn: &Connection, id: &str) -> Result<Option<DeploymentMemory>> {
    let mut statement = conn.prepare("SELECT * FROM deployment_memory WHERE id = ?1")?;
    let mut rows = statement.query_map([id], memory_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn list_memory(conn: &Connection, include_inactive: bool) -> Result<Vec<DeploymentMemory>> {
    let sql = if include_inactive {
        "SELECT * FROM deployment_memory ORDER BY confidence DESC, updated_at DESC"
    } else {
        "SELECT * FROM deployment_memory WHERE status = 'active'
         ORDER BY confidence DESC, updated_at DESC"
    };
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map([], memory_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 同 scope + scope_id + key 的唯一记忆（写入时的 upsert 目标）。
pub fn find_memory(
    conn: &Connection,
    scope: MemoryScope,
    scope_id: Option<&str>,
    key: MemoryKey,
) -> Result<Option<DeploymentMemory>> {
    let mut statement = conn.prepare(
        "SELECT * FROM deployment_memory
         WHERE scope = ?1 AND COALESCE(scope_id, '') = ?2 AND key = ?3 AND status != 'rejected'
         ORDER BY updated_at DESC LIMIT 1",
    )?;
    let mut rows = statement.query_map(
        params![scope.as_str(), scope_id.unwrap_or(""), key.as_str()],
        memory_from_row,
    )?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 生成草案时真正可用的 Memory（只取 `active`，按作用域优先级排序）。
pub fn active_memory_for(
    conn: &Connection,
    server_id: Option<&str>,
    application_id: Option<&str>,
    environment_id: Option<&str>,
) -> Result<Vec<DeploymentMemory>> {
    let mut statement = conn.prepare(
        "SELECT * FROM deployment_memory
         WHERE status = 'active'
           AND (
             scope = 'global'
             OR (scope = 'server' AND scope_id = ?1)
             OR (scope = 'application' AND scope_id = ?2)
             OR (scope = 'environment' AND scope_id = ?3)
           )",
    )?;
    let rows = statement.query_map(
        params![server_id, application_id, environment_id],
        memory_from_row,
    )?;
    let mut list = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    // 环境 > 应用 > 服务器 > 全局；同级按置信度。
    list.sort_by(|left, right| {
        right
            .scope
            .priority()
            .cmp(&left.scope.priority())
            .then(right.confidence.cmp(&left.confidence))
            .then(left.key.cmp(&right.key))
    });
    Ok(list)
}

pub fn delete_memory(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM deployment_memory WHERE id = ?1", [id])?;
    Ok(())
}

/// 清空 Memory：默认**只清非生效项**（`active` 需要显式确认）。
pub fn clear_memory(conn: &Connection, include_active: bool) -> Result<usize> {
    let affected = if include_active {
        conn.execute("DELETE FROM deployment_memory", [])?
    } else {
        conn.execute("DELETE FROM deployment_memory WHERE status != 'active'", [])?
    };
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_db;
    use crate::deployment::session::memory::explicit_preference;

    fn session(id: &str) -> DeploymentSession {
        let mut session = DeploymentSession::new(id, 1);
        session.server_id = Some("srv-1".to_string());
        session.user_description = "Docker + Nginx + HTTPS".to_string();
        session.current_question = Some(SessionQuestion {
            id: "q1".to_string(),
            kind: QuestionKind::DnsOwnership,
            question: "域名 DNS 由你手工配置吗？".to_string(),
            options: vec!["是".to_string(), "否".to_string()],
        });
        session
    }

    fn memory(
        id: &str,
        scope: MemoryScope,
        scope_id: Option<&str>,
        key: MemoryKey,
    ) -> DeploymentMemory {
        let value = match key {
            MemoryKey::PreferredRuntime => serde_json::json!("node"),
            MemoryKey::PreferredHealthPath => serde_json::json!("/healthz"),
            _ => serde_json::json!("docker_compose"),
        };
        let base = DeploymentMemory::new(
            id,
            MemoryKind::Preference,
            scope,
            scope_id.map(str::to_string),
            key,
            value,
            MemorySourceType::Explicit,
            1,
        );
        explicit_preference(base, 1)
    }

    #[test]
    fn a_fresh_database_has_the_p5_6_tables() {
        let conn = test_db();
        for table in [
            "deployment_sessions",
            "deployment_session_events",
            "deployment_memory",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "{table} 应当存在");
        }
    }

    #[test]
    fn a_session_round_trips_with_its_blocking_question() {
        let conn = test_db();
        upsert_session(&conn, &session("s1")).unwrap();
        let loaded = get_session(&conn, "s1").unwrap().expect("found");
        assert_eq!(loaded.server_id.as_deref(), Some("srv-1"));
        assert_eq!(loaded.user_description, "Docker + Nginx + HTTPS");
        let question = loaded.current_question.clone().expect("问题应当往返");
        assert_eq!(question.kind, QuestionKind::DnsOwnership);
        assert_eq!(question.options.len(), 2);

        // 状态更新后能读回新状态。
        let mut moved = loaded.clone();
        moved.status = SessionStatus::Analyzing;
        moved.updated_at = 2;
        upsert_session(&conn, &moved).unwrap();
        assert_eq!(
            get_session(&conn, "s1").unwrap().unwrap().status,
            SessionStatus::Analyzing
        );
    }

    #[test]
    fn events_are_appended_in_order() {
        let conn = test_db();
        upsert_session(&conn, &session("s1")).unwrap();
        for (index, kind) in [SessionEventKind::Created, SessionEventKind::QuestionAsked]
            .iter()
            .enumerate()
        {
            let mut event = DeploymentSessionEvent::new(
                format!("e{index}"),
                "s1",
                *kind,
                format!("事件 {index}"),
                index as i64,
            );
            if index == 1 {
                event = event.with_status(SessionStatus::Analyzing, SessionStatus::NeedsInput);
            }
            append_event(&conn, &event).unwrap();
        }
        let events = list_events(&conn, "s1").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, SessionEventKind::Created);
        assert_eq!(events[1].to_status, Some(SessionStatus::NeedsInput));
    }

    #[test]
    fn only_active_memory_in_scope_is_returned_and_environment_wins() {
        let conn = test_db();
        upsert_memory(
            &conn,
            &memory(
                "m-global",
                MemoryScope::Global,
                None,
                MemoryKey::PreferredRuntime,
            ),
        )
        .unwrap();
        upsert_memory(
            &conn,
            &memory(
                "m-env",
                MemoryScope::Environment,
                Some("env-1"),
                MemoryKey::PreferredHealthPath,
            ),
        )
        .unwrap();
        // 另一个环境的记忆不该出现。
        upsert_memory(
            &conn,
            &memory(
                "m-other-env",
                MemoryScope::Environment,
                Some("env-2"),
                MemoryKey::PreferredHealthPath,
            ),
        )
        .unwrap();
        // pending 的记忆不参与草案。
        let mut pending = memory(
            "m-pending",
            MemoryScope::Global,
            None,
            MemoryKey::PreferredTopology,
        );
        pending.status = MemoryStatus::Pending;
        upsert_memory(&conn, &pending).unwrap();

        let hits = active_memory_for(&conn, Some("srv-1"), Some("app-1"), Some("env-1")).unwrap();
        let ids: Vec<&str> = hits.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["m-env", "m-global"], "环境优先，且只要 active");
    }

    #[test]
    fn clearing_memory_keeps_active_ones_unless_asked() {
        let conn = test_db();
        upsert_memory(
            &conn,
            &memory(
                "m-active",
                MemoryScope::Global,
                None,
                MemoryKey::PreferredRuntime,
            ),
        )
        .unwrap();
        let mut pending = memory(
            "m-pending",
            MemoryScope::Global,
            None,
            MemoryKey::PreferredTopology,
        );
        pending.status = MemoryStatus::Pending;
        upsert_memory(&conn, &pending).unwrap();

        assert_eq!(clear_memory(&conn, false).unwrap(), 1);
        assert!(get_memory(&conn, "m-active").unwrap().is_some());
        assert!(get_memory(&conn, "m-pending").unwrap().is_none());

        assert_eq!(clear_memory(&conn, true).unwrap(), 1);
        assert!(list_memory(&conn, true).unwrap().is_empty());
    }

    #[test]
    fn the_confirm_key_makes_starting_idempotent() {
        let conn = test_db();
        upsert_session(&conn, &session("s1")).unwrap();
        assert!(find_session_by_confirm_key(&conn, "idem-1")
            .unwrap()
            .is_none());

        set_confirm_result(&conn, "s1", "idem-1", r#"{"ok":true}"#).unwrap();
        let found = find_session_by_confirm_key(&conn, "idem-1")
            .unwrap()
            .expect("同一个键应当找回同一次确认");
        assert_eq!(found.id, "s1");
        assert_eq!(
            get_confirm_result(&conn, "s1").unwrap().as_deref(),
            Some(r#"{"ok":true}"#)
        );
    }
}
