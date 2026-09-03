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

// -- confirmed projects (持久化已确认项目资产) --------------------------------

/// 一条已确认项目的完整快照。即使后续扫描没有再次发现该路径，项目也必须继续
/// 存在，直到用户主动取消确认（写回 review=pending）或软删除（`deleted_at`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmedProjectRecord {
    pub id: String,
    pub server_id: String,
    /// 统一规范化后的路径（末尾斜杠去掉、重复斜杠合并）。review / inventory /
    /// confirmed 全部使用它，避免 `/opt/app` 与 `/opt/app/` 被当成两个项目。
    pub canonical_path: String,
    pub name: String,
    pub project_type: String,
    /// `ProjectCandidate` 的完整 JSON 快照（含 deploy_instances / markers / 证据）。
    pub candidate_payload: String,
    /// active | missing | inaccessible | changed。
    pub scan_state: String,
    pub confirmed_at: i64,
    pub updated_at: i64,
    pub last_seen_at: i64,
    pub missing_since: Option<i64>,
    pub deleted_at: Option<i64>,
}

fn confirmed_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConfirmedProjectRecord> {
    Ok(ConfirmedProjectRecord {
        id: row.get("id")?,
        server_id: row.get("server_id")?,
        canonical_path: row.get("canonical_path")?,
        name: row.get("name")?,
        project_type: row.get("project_type")?,
        candidate_payload: row.get("candidate_payload")?,
        scan_state: row.get("scan_state")?,
        confirmed_at: row.get("confirmed_at")?,
        updated_at: row.get("updated_at")?,
        last_seen_at: row.get("last_seen_at")?,
        missing_since: row.get("missing_since")?,
        deleted_at: row.get("deleted_at")?,
    })
}

/// 某台服务器上所有未软删除的已确认项目（按 canonical_path 升序）。
pub fn list_confirmed_projects(
    conn: &Connection,
    server_id: &str,
) -> Result<Vec<ConfirmedProjectRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM confirmed_projects WHERE server_id = ?1 AND deleted_at IS NULL ORDER BY canonical_path ASC",
    )?;
    let rows = stmt.query_map([server_id], confirmed_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 按 (server_id, canonical_path) 取出唯一的已确认项目（含已软删除的）。
pub fn get_confirmed_project(
    conn: &Connection,
    server_id: &str,
    canonical_path: &str,
) -> Result<Option<ConfirmedProjectRecord>> {
    let mut stmt = conn
        .prepare("SELECT * FROM confirmed_projects WHERE server_id = ?1 AND canonical_path = ?2")?;
    let mut rows = stmt.query_map(params![server_id, canonical_path], confirmed_from_row)?;
    Ok(rows.next().transpose()?)
}

/// 写入（或覆盖）一条已确认项目。同一个 (server_id, canonical_path) 只保留最新，
/// 因此"重新确认"会刷新快照与状态。软删除的项目被重新确认时会被复活。
pub fn upsert_confirmed_project(conn: &Connection, record: &ConfirmedProjectRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO confirmed_projects
            (id, server_id, canonical_path, name, project_type, candidate_payload,
             scan_state, confirmed_at, updated_at, last_seen_at, missing_since, deleted_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(server_id, canonical_path) DO UPDATE SET
            name=excluded.name,
            project_type=excluded.project_type,
            candidate_payload=excluded.candidate_payload,
            scan_state=excluded.scan_state,
            confirmed_at=excluded.confirmed_at,
            updated_at=excluded.updated_at,
            last_seen_at=excluded.last_seen_at,
            missing_since=excluded.missing_since,
            deleted_at=excluded.deleted_at
        "#,
        params![
            record.id,
            record.server_id,
            record.canonical_path,
            record.name,
            record.project_type,
            record.candidate_payload,
            record.scan_state,
            record.confirmed_at,
            record.updated_at,
            record.last_seen_at,
            record.missing_since,
            record.deleted_at,
        ],
    )?;
    Ok(())
}

/// 软删除一条已确认项目（用户主动取消确认）。保留行以便审计，但不再出现在列表。
pub fn soft_delete_confirmed_project(
    conn: &Connection,
    server_id: &str,
    canonical_path: &str,
    deleted_at: i64,
) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE confirmed_projects SET deleted_at = ?3, updated_at = ?3 WHERE server_id = ?1 AND canonical_path = ?2 AND deleted_at IS NULL",
        params![server_id, canonical_path, deleted_at],
    )?;
    Ok(changed > 0)
}

/// 更新已确认项目的扫描状态（active / missing / inaccessible / changed）与
/// last_seen_at / missing_since，不动快照本身。
pub fn update_confirmed_scan_state(
    conn: &Connection,
    server_id: &str,
    canonical_path: &str,
    scan_state: &str,
    last_seen_at: i64,
    missing_since: Option<i64>,
) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE confirmed_projects SET scan_state = ?3, last_seen_at = ?4, missing_since = ?5, updated_at = ?4 WHERE server_id = ?1 AND canonical_path = ?2 AND deleted_at IS NULL",
        params![server_id, canonical_path, scan_state, last_seen_at, missing_since],
    )?;
    Ok(changed > 0)
}

/// 本次扫描对某个路径的判定摘要（`reconcile_confirmed_after_scan` 的输入）。
#[derive(Debug, Clone)]
pub struct ScannedCandidateInfo {
    pub name: String,
    pub project_type: String,
    /// 序列化后的 `ProjectKind`（application / infrastructure / unknown）。
    pub project_kind: String,
}

/// 一次成功扫描后的已确认项目状态对账（**完整四态流转**）：
///
/// - 本次发现且 `name` / `project_type` / 快照 `project_kind` 都没变 → `active`；
/// - 本次发现但关键信息变了（改名 / 类型变化 / 被重新分类为基础设施）→
///   `changed`（保留行与快照，等用户复核）；
/// - 本次没发现 → `missing`，`missing_since` 保留首次时间。
pub fn reconcile_confirmed_after_scan(
    conn: &Connection,
    server_id: &str,
    found: &std::collections::BTreeMap<String, ScannedCandidateInfo>,
    now: i64,
) -> Result<()> {
    let confirmed = list_confirmed_projects(conn, server_id)?;
    for cp in confirmed {
        let (scan_state, missing_since) = match found.get(&cp.canonical_path) {
            Some(info) => {
                let kind_changed = snapshot_kind_differs(&cp.candidate_payload, &info.project_kind);
                let info_changed = info.name != cp.name || info.project_type != cp.project_type;
                if (info_changed || kind_changed) && !cp.name.is_empty() {
                    ("changed".to_string(), None)
                } else {
                    ("active".to_string(), None)
                }
            }
            None => {
                let missing_since = cp.missing_since.unwrap_or(now);
                ("missing".to_string(), Some(missing_since))
            }
        };
        update_confirmed_scan_state(
            conn,
            server_id,
            &cp.canonical_path,
            &scan_state,
            now,
            missing_since,
        )?;
    }
    Ok(())
}

/// 快照 JSON 里的 `project_kind` 是否与本次扫描的判定不一致（changed 依据之一）。
/// 旧快照没有该字段时视为一致（不因缺字段误报"信息有变化"）。
fn snapshot_kind_differs(candidate_payload: &str, current_kind: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate_payload) else {
        return false;
    };
    match value.get("project_kind") {
        Some(serde_json::Value::String(kind)) => kind != current_kind,
        // 无字段（旧快照）或 null：不判变化。
        _ => false,
    }
}

/// 扫描**失败**（连接断开 / SSH 错误，不含用户取消）时，把该服务器上仍标记为
/// `active` 的已确认项目置为 `inaccessible` —— 服务器暂不可访问，无法判断
/// 项目是否还在，绝不能假装"没变化"。`missing` 行保持不变（此前已确认缺失）。
pub fn mark_confirmed_inaccessible(conn: &Connection, server_id: &str, now: i64) -> Result<u32> {
    let changed = conn.execute(
        "UPDATE confirmed_projects SET scan_state = 'inaccessible', updated_at = ?2 WHERE server_id = ?1 AND scan_state = 'active' AND deleted_at IS NULL",
        params![server_id, now],
    )?;
    Ok(changed as u32)
}

// -- project merges (人工合并/拆分项目) --------------------------------------

/// 一条人工合并关系：`child_path` 被用户并入 `parent_path`（路径均为 canonical）。
/// 拆分 = 删除该行。后续扫描回填候选的 `merged_into` 标注，人工决定不被覆盖。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMergeRecord {
    pub id: String,
    pub server_id: String,
    pub child_path: String,
    pub parent_path: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn merge_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectMergeRecord> {
    Ok(ProjectMergeRecord {
        id: row.get("id")?,
        server_id: row.get("server_id")?,
        child_path: row.get("child_path")?,
        parent_path: row.get("parent_path")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 某台服务器上的全部人工合并关系（按 child_path 升序）。
pub fn list_project_merges(conn: &Connection, server_id: &str) -> Result<Vec<ProjectMergeRecord>> {
    let mut stmt =
        conn.prepare("SELECT * FROM project_merges WHERE server_id = ?1 ORDER BY child_path ASC")?;
    let rows = stmt.query_map([server_id], merge_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 写入（或更新）一条人工合并关系：一个子目录只能并入一个父项目，
/// 重复合并会覆盖旧的父项目（用户改主意是合法操作）。
pub fn upsert_project_merge(
    conn: &Connection,
    server_id: &str,
    child_path: &str,
    parent_path: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO project_merges (id, server_id, child_path, parent_path, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        ON CONFLICT(server_id, child_path) DO UPDATE SET
            parent_path=excluded.parent_path,
            updated_at=excluded.updated_at
        "#,
        params![
            format!("{server_id}:{child_path}"),
            server_id,
            child_path,
            parent_path,
            now
        ],
    )?;
    Ok(())
}

/// 拆分：删除一条人工合并关系，子目录恢复独立。返回是否确有删除。
pub fn delete_project_merge(conn: &Connection, server_id: &str, child_path: &str) -> Result<bool> {
    let changed = conn.execute(
        "DELETE FROM project_merges WHERE server_id = ?1 AND child_path = ?2",
        params![server_id, child_path],
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
