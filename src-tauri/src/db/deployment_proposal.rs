//! P5.2 部署方案与安全策略的持久化（migration v11）。
//!
//! # 为什么整份方案存 JSON
//!
//! 方案是一个**不可变的审计快照**：它记录"当时用哪个引擎版本、哪一版知识库、
//! 哪个模型、算出什么结论"。拆成十几张表反而会丢掉"整体一致"这件事
//! （改一条记录就破坏了历史）。指纹关键字段另存列，是为了能按哈希检索与比对。
//!
//! 安全策略只存 JSON：它是**策略**不是数据，字段会随引擎演进。

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::deployment::proposal::model::{DeploymentProposal, ProposalStatus, SecurityPolicy};

fn proposal_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentProposal> {
    let text: String = row.get("proposal_json")?;
    let mut proposal: DeploymentProposal = serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    // **状态以列为准**：`mark_proposal_confirmed` / `mark_proposal_status` 只改列
    // 不会重写整份 JSON（那是不可变快照）。若这里不覆盖，读回来的方案会一直
    // 说自己是 `draft`，于是同一条方案可以被确认第二次 —— 这正是测试抓到的洞。
    if let Ok(text) = row.get::<_, String>("status") {
        proposal.status = status_from_text(&text);
    }
    Ok(proposal)
}

fn status_from_text(text: &str) -> ProposalStatus {
    match text {
        "confirmed" => ProposalStatus::Confirmed,
        "rejected" => ProposalStatus::Rejected,
        "superseded" => ProposalStatus::Superseded,
        _ => ProposalStatus::Draft,
    }
}

/// 落库 / 覆盖一份方案。
pub fn upsert_proposal(conn: &Connection, proposal: &DeploymentProposal) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO deployment_proposals (
            id, application_id, environment_id, server_id, status, ready, approvable,
            input_hash, output_hash, model, prompt_version, knowledge_version, engine_version,
            proposal_json, plan_id, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ON CONFLICT(id) DO UPDATE SET
            application_id=excluded.application_id,
            environment_id=excluded.environment_id,
            server_id=excluded.server_id,
            status=excluded.status,
            ready=excluded.ready,
            approvable=excluded.approvable,
            input_hash=excluded.input_hash,
            output_hash=excluded.output_hash,
            model=excluded.model,
            prompt_version=excluded.prompt_version,
            knowledge_version=excluded.knowledge_version,
            engine_version=excluded.engine_version,
            proposal_json=excluded.proposal_json,
            plan_id=excluded.plan_id,
            updated_at=excluded.updated_at
        "#,
        params![
            &proposal.id,
            &proposal.application_id,
            proposal.environment_id.as_deref(),
            &proposal.server_id,
            status_text(proposal.status),
            proposal.is_ready() as i64,
            proposal.is_approvable() as i64,
            &proposal.fingerprint.input_hash,
            &proposal.fingerprint.output_hash,
            proposal.fingerprint.model.as_deref(),
            &proposal.fingerprint.prompt_version,
            &proposal.fingerprint.knowledge_version,
            &proposal.fingerprint.engine_version,
            serde_json::to_string(proposal)?,
            Option::<String>::None,
            proposal.created_at,
            proposal.created_at,
        ],
    )?;
    Ok(())
}

fn status_text(status: ProposalStatus) -> String {
    match status {
        ProposalStatus::Draft => "draft",
        ProposalStatus::Confirmed => "confirmed",
        ProposalStatus::Rejected => "rejected",
        ProposalStatus::Superseded => "superseded",
    }
    .to_string()
}

pub fn get_proposal(conn: &Connection, id: &str) -> Result<Option<DeploymentProposal>> {
    let mut statement = conn.prepare("SELECT * FROM deployment_proposals WHERE id = ?1")?;
    let mut rows = statement.query_map([id], proposal_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 列方案（按生成时间倒序）。
pub fn list_proposals(
    conn: &Connection,
    application_id: Option<&str>,
    limit: i64,
) -> Result<Vec<DeploymentProposal>> {
    let mut statement = match application_id {
        Some(_) => conn.prepare(
            "SELECT * FROM deployment_proposals WHERE application_id = ?1
             ORDER BY created_at DESC, id ASC LIMIT ?2",
        )?,
        None => conn.prepare(
            "SELECT * FROM deployment_proposals ORDER BY created_at DESC, id ASC LIMIT ?1",
        )?,
    };
    let rows = match application_id {
        Some(application) => statement.query_map(params![application, limit], proposal_from_row)?,
        None => statement.query_map([limit], proposal_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 按输入哈希找一份已有方案（"同样输入可复现"的检索入口）。
pub fn find_proposal_by_input_hash(
    conn: &Connection,
    application_id: &str,
    input_hash: &str,
) -> Result<Option<DeploymentProposal>> {
    let mut statement = conn.prepare(
        "SELECT * FROM deployment_proposals WHERE application_id = ?1 AND input_hash = ?2
         ORDER BY created_at DESC LIMIT 1",
    )?;
    let mut rows = statement.query_map(params![application_id, input_hash], proposal_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 标记方案已确认，并记下落成的计划 id。
pub fn mark_proposal_confirmed(conn: &Connection, id: &str, plan_id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE deployment_proposals SET status = 'confirmed', plan_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![plan_id, now, id],
    )?;
    Ok(())
}

pub fn mark_proposal_status(
    conn: &Connection,
    id: &str,
    status: ProposalStatus,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE deployment_proposals SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![status_text(status), now, id],
    )?;
    Ok(())
}

pub fn delete_proposal(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM deployment_proposals WHERE id = ?1", [id])?;
    Ok(())
}

// -- 安全策略 ---------------------------------------------------------------

/// 读某应用的策略；没有记录就是默认（最保守）那一档。
pub fn get_security_policy(conn: &Connection, application_id: &str) -> Result<SecurityPolicy> {
    let mut statement = conn.prepare(
        "SELECT policy_json FROM deployment_security_policies WHERE application_id = ?1",
    )?;
    let mut rows = statement.query_map([application_id], |row| row.get::<_, String>(0))?;
    match rows.next() {
        Some(row) => {
            let text = row?;
            Ok(serde_json::from_str(&text).unwrap_or_default())
        }
        None => Ok(SecurityPolicy::default()),
    }
}

pub fn upsert_security_policy(
    conn: &Connection,
    application_id: &str,
    policy: &SecurityPolicy,
    now: i64,
) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO deployment_security_policies (application_id, policy_json, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(application_id) DO UPDATE SET
            policy_json=excluded.policy_json,
            updated_at=excluded.updated_at
        "#,
        params![application_id, serde_json::to_string(policy)?, now],
    )?;
    Ok(())
}
