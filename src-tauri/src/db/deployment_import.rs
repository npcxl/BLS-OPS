//! P5.1 制品导入任务的持久化（migration v10）。
//!
//! # 只存最终态
//!
//! 中间进度没有持久化价值：应用一重启，任务本来就作废。这里存的是**对象快照**
//! （来源 / 指纹 / 安全报告 / 识别结果整段 JSON），目的只有一个 ——
//! **让"确认导入"在重启之后依然可做**，且用户看到的与库里的一致。
//!
//! 复用 `db/deployment.rs` 那套写法：`anyhow::Result`、serde 的 snake_case
//! 字符串落库、复杂结构走 JSON 文本。

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::deployment::artifact::model::{
    ArtifactFingerprint, ArtifactImportTask, ArtifactInspection, ImportStage, ImportStatus,
    SecurityScanReport,
};

fn to_json<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn from_json<T: DeserializeOwned>(text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn enum_to_text<T: Serialize>(value: &T) -> Result<String> {
    Ok(match serde_json::to_value(value)? {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    })
}

fn enum_from_text<T: DeserializeOwned>(text: &str) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(text.to_string())).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtifactImportTask> {
    let fingerprint: Option<String> = row.get("fingerprint_json")?;
    let security: Option<String> = row.get("security_json")?;
    let inspection: Option<String> = row.get("inspection_json")?;
    Ok(ArtifactImportTask {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        service_unit_id: row.get("service_unit_id")?,
        source: from_json(&row.get::<_, String>("source_json")?)?,
        display_name: row.get("display_name")?,
        stage: enum_from_text(&row.get::<_, String>("stage")?)?,
        status: enum_from_text(&row.get::<_, String>("status")?)?,
        progress: from_json(&row.get::<_, String>("progress_json")?)?,
        fingerprint: fingerprint
            .map(|text| from_json::<ArtifactFingerprint>(&text))
            .transpose()?,
        security: security
            .map(|text| from_json::<SecurityScanReport>(&text))
            .transpose()?,
        inspection: inspection
            .map(|text| from_json::<ArtifactInspection>(&text))
            .transpose()?,
        error: row.get("error")?,
        can_cancel: matches!(
            enum_from_text::<ImportStatus>(&row.get::<_, String>("status")?)?,
            ImportStatus::Pending | ImportStatus::Running
        ),
        attempt: row.get::<_, i64>("attempt")?.max(1) as u32,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        finished_at: row.get("finished_at")?,
        artifact_id: row.get("artifact_id")?,
    })
}

/// 落库 / 覆盖一条导入任务。
pub fn upsert_import_task(conn: &Connection, task: &ArtifactImportTask) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO artifact_import_tasks (
            id, application_id, service_unit_id, source_json, display_name, stage, status,
            progress_json, fingerprint_json, security_json, inspection_json, error, attempt,
            artifact_id, created_at, updated_at, finished_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ON CONFLICT(id) DO UPDATE SET
            application_id=excluded.application_id,
            service_unit_id=excluded.service_unit_id,
            source_json=excluded.source_json,
            display_name=excluded.display_name,
            stage=excluded.stage,
            status=excluded.status,
            progress_json=excluded.progress_json,
            fingerprint_json=excluded.fingerprint_json,
            security_json=excluded.security_json,
            inspection_json=excluded.inspection_json,
            error=excluded.error,
            attempt=excluded.attempt,
            artifact_id=excluded.artifact_id,
            updated_at=excluded.updated_at,
            finished_at=excluded.finished_at
        "#,
        params![
            &task.id,
            task.application_id.as_deref(),
            task.service_unit_id.as_deref(),
            to_json(&task.source)?,
            &task.display_name,
            enum_to_text(&task.stage)?,
            enum_to_text(&task.status)?,
            to_json(&task.progress)?,
            task.fingerprint.as_ref().map(to_json).transpose()?,
            task.security.as_ref().map(to_json).transpose()?,
            task.inspection.as_ref().map(to_json).transpose()?,
            task.error.as_deref(),
            task.attempt as i64,
            task.artifact_id.as_deref(),
            task.created_at,
            task.updated_at,
            task.finished_at,
        ],
    )?;
    Ok(())
}

pub fn get_import_task(conn: &Connection, id: &str) -> Result<Option<ArtifactImportTask>> {
    let mut statement = conn.prepare("SELECT * FROM artifact_import_tasks WHERE id = ?1")?;
    let mut rows = statement.query_map([id], task_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn list_import_tasks(
    conn: &Connection,
    application_id: Option<&str>,
    limit: i64,
) -> Result<Vec<ArtifactImportTask>> {
    let mut statement = match application_id {
        Some(_) => conn.prepare(
            "SELECT * FROM artifact_import_tasks WHERE application_id = ?1
             ORDER BY created_at DESC LIMIT ?2",
        )?,
        None => {
            conn.prepare("SELECT * FROM artifact_import_tasks ORDER BY created_at DESC LIMIT ?1")?
        }
    };
    let rows = match application_id {
        Some(application) => statement.query_map(params![application, limit], task_from_row)?,
        None => statement.query_map([limit], task_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 删除任务记录。**不删制品**：制品是独立实体，删它走 `delete_artifact`。
pub fn delete_import_task(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM artifact_import_tasks WHERE id = ?1", [id])?;
    Ok(())
}

/// 确认导入后把任务标成"已保存为制品"。
pub fn mark_import_task_confirmed(
    conn: &Connection,
    id: &str,
    artifact_id: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE artifact_import_tasks SET artifact_id = ?1, stage = ?2, updated_at = ?3 WHERE id = ?4",
        params![
            artifact_id,
            enum_to_text(&ImportStage::Done)?,
            now,
            id
        ],
    )?;
    Ok(())
}
