//! Projects and deployment runs (P3-2.2, P3-2.3).
//!
//! Deployment steps live here as a JSON array, but they are meaningless on
//! their own: `safe::validate_deploy_step` must accept every one of them before
//! a project is saved, and again before each run.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::model::{DeploymentRecord, ProjectRecord};
use super::schema::AppDb;

/// Deployment status values used across the app.
pub const DEPLOY_RUNNING: &str = "running";
pub const DEPLOY_SUCCESS: &str = "success";
pub const DEPLOY_FAILED: &str = "failed";

// -- projects ----------------------------------------------------------------

pub fn list_projects(conn: &Connection) -> Result<Vec<ProjectRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM projects ORDER BY name ASC")?;
    let rows = stmt.query_map([], project_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_project(conn: &Connection, id: &str) -> Result<Option<ProjectRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM projects WHERE id = ?1")?;
    let mut rows = stmt.query_map([id], project_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRecord> {
    Ok(ProjectRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        server_id: row.get("server_id")?,
        repo_url: row.get("repo_url")?,
        branch: row.get("branch")?,
        deploy_path: row.get("deploy_path")?,
        commands_json: row.get("commands")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert_or_replace_project(conn: &Connection, project: &ProjectRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO projects (id, name, description, server_id, repo_url, branch, deploy_path, commands, status, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            description=excluded.description,
            server_id=excluded.server_id,
            repo_url=excluded.repo_url,
            branch=excluded.branch,
            deploy_path=excluded.deploy_path,
            commands=excluded.commands,
            status=excluded.status,
            updated_at=excluded.updated_at
        "#,
        params![
            project.id,
            project.name,
            project.description,
            project.server_id,
            project.repo_url,
            project.branch,
            project.deploy_path,
            project.commands_json,
            project.status,
            project.created_at,
            project.updated_at,
        ],
    )?;
    Ok(())
}

/// Mirrors the last deployment outcome onto the project, so the list shows
/// "failed" without loading the whole history.
pub fn set_project_status(conn: &Connection, id: &str, status: &str) -> Result<()> {
    conn.execute(
        "UPDATE projects SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![status, AppDb::now(), id],
    )?;
    Ok(())
}

/// Removes a project together with its deployment history — history without
/// its project would be an orphan the UI cannot explain.
pub fn delete_project_cascade(conn: &Connection, id: &str) -> Result<i64> {
    let deployments: i64 = conn
        .prepare("SELECT COUNT(*) FROM deployments WHERE project_id = ?1")?
        .query_row([id], |row| row.get(0))?;
    conn.execute("DELETE FROM deployments WHERE project_id = ?1", [id])?;
    conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    Ok(deployments)
}

// -- project reviews ---------------------------------------------------------

/// One人工复核结论: 用户说"这是我的项目"或"这不是项目"的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectReviewRecord {
    pub server_id: String,
    pub path: String,
    /// `confirmed` | `ignored` | `pending`
    pub review: String,
    pub name: String,
    pub project_type: String,
    pub note: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn review_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectReviewRecord> {
    Ok(ProjectReviewRecord {
        server_id: row.get("server_id")?,
        path: row.get("path")?,
        review: row.get("review")?,
        name: row.get("name")?,
        project_type: row.get("project_type")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 某台服务器上所有的人工复核结论。扫描时据此给候选打标。
pub fn list_project_reviews(
    conn: &Connection,
    server_id: &str,
) -> Result<Vec<ProjectReviewRecord>> {
    let mut stmt =
        conn.prepare("SELECT * FROM project_reviews WHERE server_id = ?1 ORDER BY path ASC")?;
    let rows = stmt.query_map([server_id], review_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 写入（或覆盖）一条复核结论。同一个 (server, path) 只保留最新结论，
/// 因此"取消忽略"就是把它写回 `pending`。
pub fn upsert_project_review(conn: &Connection, record: &ProjectReviewRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO project_reviews (server_id, path, review, name, project_type, note, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(server_id, path) DO UPDATE SET
            review=excluded.review,
            name=excluded.name,
            project_type=excluded.project_type,
            note=excluded.note,
            updated_at=excluded.updated_at
        "#,
        params![
            record.server_id,
            record.path,
            record.review,
            record.name,
            record.project_type,
            record.note,
            record.created_at,
            record.updated_at,
        ],
    )?;
    Ok(())
}

/// 删除一条复核结论（回到"未处理"）。
pub fn delete_project_review(conn: &Connection, server_id: &str, path: &str) -> Result<bool> {
    let changed = conn.execute(
        "DELETE FROM project_reviews WHERE server_id = ?1 AND path = ?2",
        params![server_id, path],
    )?;
    Ok(changed > 0)
}

// -- project inventory cache ------------------------------------------------

/// 某台服务器最近一次扫描的快照缓存（JSON 负载 + 时间戳）。
#[derive(Debug, Clone)]
pub struct ProjectInventoryCache {
    pub server_id: String,
    pub payload: String,
    pub completed_at: i64,
    pub updated_at: i64,
}

/// 读取某台服务器的快照缓存（没有则 `None`）。前端打开"服务器项目"时立即展示，
/// 后台再增量复核覆盖。
pub fn get_project_inventory(
    conn: &Connection,
    server_id: &str,
) -> Result<Option<ProjectInventoryCache>> {
    let mut stmt = conn.prepare(
        "SELECT server_id, payload, completed_at, updated_at FROM project_inventory WHERE server_id = ?1",
    )?;
    let mut rows = stmt.query_map([server_id], |row| {
        Ok(ProjectInventoryCache {
            server_id: row.get("server_id")?,
            payload: row.get("payload")?,
            completed_at: row.get("completed_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

/// 写入（覆盖）某台服务器的快照缓存。整段扫描结果以 JSON 存储，后端解析即可。
pub fn upsert_project_inventory(
    conn: &Connection,
    server_id: &str,
    payload: &str,
    completed_at: i64,
) -> Result<()> {
    let now = AppDb::now();
    conn.execute(
        r#"
        INSERT INTO project_inventory (server_id, payload, completed_at, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(server_id) DO UPDATE SET
            payload=excluded.payload,
            completed_at=excluded.completed_at,
            updated_at=excluded.updated_at
        "#,
        params![server_id, payload, completed_at, now],
    )?;
    Ok(())
}

// -- deployments -------------------------------------------------------------

pub fn insert_deployment(conn: &Connection, deployment: &DeploymentRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO deployments (id, project_id, project_name, server_id, server_name, status, trigger_source, branch, commit_sha, started_at, finished_at, duration_ms, log, error_message, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        "#,
        params![
            deployment.id,
            deployment.project_id,
            deployment.project_name,
            deployment.server_id,
            deployment.server_name,
            deployment.status,
            deployment.trigger_source,
            deployment.branch,
            deployment.commit_sha,
            deployment.started_at,
            deployment.finished_at,
            deployment.duration_ms,
            deployment.log,
            deployment.error_message,
            deployment.created_at,
        ],
    )?;
    Ok(())
}

/// Appends to the log and updates status/timing. Called repeatedly as a run
/// progresses so a crash mid-deploy still leaves a record.
pub fn update_deployment_progress(
    conn: &Connection,
    id: &str,
    status: &str,
    log: &str,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    error_message: Option<&str>,
) -> Result<()> {
    let duration_ms = match (started_at, finished_at) {
        (Some(started), Some(finished)) => Some((finished - started).max(0)),
        _ => None,
    };
    conn.execute(
        r#"
        UPDATE deployments
        SET status = ?1, log = ?2, started_at = COALESCE(?3, started_at),
            finished_at = ?4, duration_ms = ?5, error_message = ?6
        WHERE id = ?7
        "#,
        params![
            status,
            log,
            started_at,
            finished_at,
            duration_ms,
            error_message,
            id
        ],
    )?;
    Ok(())
}

pub fn get_deployment(conn: &Connection, id: &str) -> Result<Option<DeploymentRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM deployments WHERE id = ?1")?;
    let mut rows = stmt.query_map([id], deployment_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Deployment history, newest first. `project_id` narrows it to one project.
pub fn list_deployments(
    conn: &Connection,
    project_id: Option<&str>,
    limit: i64,
) -> Result<Vec<DeploymentRecord>> {
    // Collect inside the branch: `MappedRows` borrows the statement, so it
    // must not outlive the branch that owns it.
    match project_id {
        Some(project_id) => {
            let mut stmt = conn.prepare(
                "SELECT * FROM deployments WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2",
            )?;
            let mut records = Vec::new();
            for row in stmt.query_map(params![project_id, limit], deployment_from_row)? {
                records.push(row?);
            }
            Ok(records)
        }
        None => {
            let mut stmt =
                conn.prepare("SELECT * FROM deployments ORDER BY created_at DESC LIMIT ?1")?;
            let mut records = Vec::new();
            for row in stmt.query_map([limit], deployment_from_row)? {
                records.push(row?);
            }
            Ok(records)
        }
    }
}

pub fn deployment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentRecord> {
    Ok(DeploymentRecord {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        project_name: row.get("project_name")?,
        server_id: row.get("server_id")?,
        server_name: row.get("server_name")?,
        status: row.get("status")?,
        trigger_source: row.get("trigger_source")?,
        branch: row.get("branch")?,
        commit_sha: row.get("commit_sha")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        duration_ms: row.get("duration_ms")?,
        log: row.get("log")?,
        error_message: row.get("error_message")?,
        created_at: row.get("created_at")?,
    })
}
