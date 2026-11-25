//! 极核模式的**任务历史**：部署 / 查询 / 检测 / 构建 / 文件传输各落一条，重启后还能查。
//!
//! 任务只存计划步骤 + 每步输出 + 结果 + 关键引用；对话正文单独存
//! `extreme_workspaces`（v28），这样聊天记录不再依赖 WebView 的 localStorage。
//! 大文件、完整查询结果与凭据仍不落库。
//!
//! 表结构见 `db::schema` 的 v20 / v21 / v28 迁移。

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ops_error::{OpsError, OpsResult};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolderImport {
    folder: String,
    files: Vec<WorkspaceFolderFile>,
    limited: bool,
}

#[derive(Serialize)]
struct WorkspaceFolderFile {
    path: String,
    data: String,
}

/// Only paths selected in the native picker are accepted. Do not traverse symlinks.
#[tauri::command]
pub async fn extreme_pick_workspace_folders(
    app: tauri::AppHandle,
) -> OpsResult<Vec<WorkspaceFolderImport>> {
    use tauri_plugin_dialog::DialogExt as _;

    let folders = app
        .dialog()
        .file()
        .blocking_pick_folders()
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        use std::{
            fs,
            io::{BufReader, Read as _},
        };

        const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
        let mut remaining_bytes = 16 * 1024 * 1024u64;
        let mut remaining_files = 512usize;
        let mut remaining_entries = 4096usize;
        let mut imports = Vec::new();

        for folder in folders {
            let Ok(root) = folder.into_path() else {
                continue;
            };
            let mut imported = WorkspaceFolderImport {
                folder: root.to_string_lossy().into_owned(),
                files: Vec::new(),
                limited: false,
            };
            let root_name = root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("workspace");
            let mut directories = vec![root.clone()];
            'scan: while let Some(directory) = directories.pop() {
                let Ok(entries) = fs::read_dir(directory) else {
                    imported.limited = true;
                    continue;
                };
                for entry in entries {
                    if remaining_entries == 0 || remaining_files == 0 || remaining_bytes == 0 {
                        imported.limited = true;
                        break 'scan;
                    }
                    remaining_entries -= 1;
                    let Ok(entry) = entry else {
                        imported.limited = true;
                        continue;
                    };
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name == ".git"
                        || name == "node_modules"
                        || name == ".ssh"
                        || name.starts_with(".env")
                        || name.ends_with(".key")
                        || name.ends_with(".pem")
                    {
                        imported.limited = true;
                        continue;
                    }
                    let Ok(file_type) = entry.file_type() else {
                        imported.limited = true;
                        continue;
                    };
                    let path = entry.path();
                    if file_type.is_dir() {
                        directories.push(path);
                    } else if file_type.is_file() {
                        let cap = MAX_FILE_BYTES.min(remaining_bytes);
                        let mut bytes = Vec::new();
                        let result = fs::File::open(&path).and_then(|file| {
                            if file.metadata()?.len() > cap {
                                return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
                            }
                            BufReader::new(file).take(cap + 1).read_to_end(&mut bytes)
                        });
                        if result.is_err() || bytes.len() as u64 > cap {
                            imported.limited = true;
                            continue;
                        }
                        let Ok(relative) = path.strip_prefix(&root) else {
                            continue;
                        };
                        let relative = relative
                            .components()
                            .map(|part| part.as_os_str().to_string_lossy())
                            .collect::<Vec<_>>()
                            .join("/");
                        remaining_bytes -= bytes.len() as u64;
                        remaining_files -= 1;
                        imported.files.push(WorkspaceFolderFile {
                            path: format!("{root_name}/{relative}"),
                            data: base64::engine::general_purpose::STANDARD.encode(bytes),
                        });
                    }
                }
            }
            imports.push(imported);
        }
        imports
    })
    .await
    .map_err(db_error)
}

/// 老记录（v20 之前）没有类型，只能是部署。
fn default_kind() -> String {
    "deploy".to_string()
}

/// 老记录没有风险列：按只读处理，等下一次保存时被真实步骤覆盖。
fn default_risk() -> String {
    "read".to_string()
}

/// 一条任务记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtremeTaskRecord {
    pub id: String,
    /// `deploy` / `query` / `probe` / `build` / `automation` / `transfer`。
    #[serde(default = "default_kind")]
    pub kind: String,
    /// 目标服务器展示名。
    pub server: String,
    /// 服务器配置 id（同名 / 同地址不同账号靠它区分）；旧记录为 `None`。
    #[serde(default)]
    pub server_id: Option<String>,
    /// 发起这条任务的对话（workspace）；旧记录为 `None`（未关联）。
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// 生成计划时的 SSH 会话 id（仅供关联历史，不保证仍然有效）。
    pub session_id: String,
    /// `success` / `failed` / `cancelled`，以及执行中的 `running` / `waiting`。
    pub status: String,
    /// 用户自定义名称（为空时前端显示 `goal` / `summary`）。
    #[serde(default)]
    pub name: String,
    /// 本次任务的用户目标：**类型与标题**从它来，不再按步骤风险推断。
    #[serde(default)]
    pub goal: String,
    /// 本次任务的最高风险：`read` / `write` / `danger`。与类型分开记录。
    #[serde(default = "default_risk")]
    pub risk: String,
    /// 一句话结论（成功 / 卡在几步）—— 列表里的摘要，不做标题。
    pub summary: String,
    /// 完整步骤的 JSON（含 stdout / stderr / 退出码）。
    pub plan_json: String,
    /// 终态验证结论（JSON）；旧记录为空串。
    #[serde(default)]
    pub outcome_json: String,
    /// 任务当前目录（恢复执行的起点）；旧记录为空。
    #[serde(default)]
    pub cwd: String,
    /// 毫秒时间戳。
    pub created_at: i64,
}

fn db_error(error: impl ToString) -> OpsError {
    OpsError::from_stage("io", error)
}

/// 读取全部对话（正文 / 草稿 / 上下文），按最近活跃排序。
///
/// 返回原始 JSON：前端 `ExtremeWorkspace` 字段还在演进，后端不复制一份
/// 结构体，避免每加一个字段就要改 Rust。
fn read_workspaces(conn: &rusqlite::Connection) -> OpsResult<Vec<serde_json::Value>> {
    let mut stmt = conn
        .prepare("SELECT payload_json FROM extreme_workspaces ORDER BY updated_at DESC")
        .map_err(db_error)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?;
    let mut workspaces = Vec::new();
    for row in rows {
        let raw = row.map_err(db_error)?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            workspaces.push(value);
        }
    }
    Ok(workspaces)
}

#[tauri::command]
pub fn extreme_workspace_list(state: State<'_, AppState>) -> OpsResult<Vec<serde_json::Value>> {
    let conn = state.db.open().map_err(db_error)?;
    read_workspaces(&conn)
}

/// 用前端当前的全量快照覆盖对话表。
///
/// 前端原本每 800ms 全量写一次 localStorage；这里复用同一份快照，事务内
/// 先清空再写入，删除 / 新建 / 改名都只需要一个入口，不会出现半份数据。
fn write_workspaces(
    conn: &mut rusqlite::Connection,
    workspaces: Vec<serde_json::Value>,
) -> OpsResult<()> {
    let tx = conn.transaction().map_err(db_error)?;
    tx.execute("DELETE FROM extreme_workspaces", [])
        .map_err(db_error)?;
    for workspace in workspaces {
        let Some(id) = workspace.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        let updated_at = workspace
            .get("updatedAt")
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        let payload = serde_json::to_string(&workspace).map_err(db_error)?;
        tx.execute(
            "INSERT INTO extreme_workspaces (id, payload_json, updated_at)
             VALUES (?1, ?2, ?3)",
            params![id, payload, updated_at],
        )
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(())
}

#[tauri::command]
pub fn extreme_workspace_sync(
    state: State<'_, AppState>,
    workspaces: Vec<serde_json::Value>,
) -> OpsResult<()> {
    let mut conn = state.db.open().map_err(db_error)?;
    write_workspaces(&mut conn, workspaces)
}

/// 保存（或覆盖）一条任务记录。
#[tauri::command]
pub fn extreme_task_save(state: State<'_, AppState>, task: ExtremeTaskRecord) -> OpsResult<()> {
    let conn = state.db.open().map_err(db_error)?;
    conn.execute(
        "INSERT INTO extreme_tasks (id, kind, server, server_id, workspace_id, session_id, status, name, goal, risk, summary, plan_json, outcome_json, cwd, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           server = excluded.server,
           -- 归属只在有值时补齐：旧记录第一次重存就能接回原对话，但不拿 null 覆盖。
           server_id = COALESCE(excluded.server_id, extreme_tasks.server_id),
           workspace_id = COALESCE(excluded.workspace_id, extreme_tasks.workspace_id),
           status = excluded.status,
           goal = excluded.goal,
           risk = excluded.risk,
           summary = excluded.summary,
           plan_json = excluded.plan_json,
           -- 结论/目录为空时保留上一次的：执行中的保存不能把终态结论冲掉。
           outcome_json = CASE WHEN excluded.outcome_json = '' THEN extreme_tasks.outcome_json ELSE excluded.outcome_json END,
           cwd = CASE WHEN excluded.cwd = '' THEN extreme_tasks.cwd ELSE excluded.cwd END",
        params![
            task.id,
            task.kind,
            task.server,
            task.server_id,
            task.workspace_id,
            task.session_id,
            task.status,
            task.name,
            task.goal,
            task.risk,
            task.summary,
            task.plan_json,
            task.outcome_json,
            task.cwd,
            task.created_at,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

/// 最近的任务记录（新的在前），可按类型 / 状态 / 服务器筛选。
///
/// 筛选留空或传 `all` 表示不筛。执行中的任务由前端置顶，这里统一按时间倒序。
#[tauri::command]
pub fn extreme_task_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
    kind: Option<String>,
    status: Option<String>,
    server: Option<String>,
    server_id: Option<String>,
    workspace_id: Option<String>,
) -> OpsResult<Vec<ExtremeTaskRecord>> {
    let conn = state.db.open().map_err(db_error)?;

    let mut sql = String::from(
        "SELECT id, kind, server, server_id, workspace_id, session_id, status, name, goal, risk, summary, plan_json, outcome_json, cwd, created_at FROM extreme_tasks",
    );
    let mut clauses: Vec<String> = Vec::new();
    let mut args: Vec<Value> = Vec::new();

    // 空串 / "all" 都当"不筛"，前端切筛选时不必清空参数。
    let mut push = |column: &str, value: Option<String>| {
        let Some(value) = value.filter(|value| !value.is_empty() && value != "all") else {
            return;
        };
        args.push(Value::Text(value));
        clauses.push(format!("{column} = ?{}", args.len()));
    };
    push("kind", kind);
    push("status", status);
    push("server", server);
    push("server_id", server_id);
    push("workspace_id", workspace_id);

    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    args.push(Value::Integer(limit.unwrap_or(50).clamp(1, 200)));
    sql.push_str(&format!(" ORDER BY created_at DESC LIMIT ?{}", args.len()));

    let mut statement = conn.prepare(&sql).map_err(db_error)?;
    let rows = statement
        .query_map(params_from_iter(args.iter()), |row| {
            Ok(ExtremeTaskRecord {
                id: row.get(0)?,
                kind: row.get(1)?,
                server: row.get(2)?,
                server_id: row.get(3)?,
                workspace_id: row.get(4)?,
                session_id: row.get(5)?,
                status: row.get(6)?,
                name: row.get(7)?,
                goal: row.get(8)?,
                risk: row.get(9)?,
                summary: row.get(10)?,
                plan_json: row.get(11)?,
                outcome_json: row.get(12)?,
                cwd: row.get(13)?,
                created_at: row.get(14)?,
            })
        })
        .map_err(db_error)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(db_error)?);
    }
    Ok(out)
}

/// 读一条任务记录（恢复执行用；历史列表不暴露这个入口）。
pub(crate) fn load_task_record(
    state: &AppState,
    id: &str,
) -> Result<Option<ExtremeTaskRecord>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    let row = conn.query_row(
        "SELECT id, kind, server, server_id, workspace_id, session_id, status, name, goal, risk, summary, plan_json, outcome_json, cwd, created_at
         FROM extreme_tasks WHERE id = ?1",
        params![id],
        |row| {
            Ok(ExtremeTaskRecord {
                id: row.get(0)?,
                kind: row.get(1)?,
                server: row.get(2)?,
                server_id: row.get(3)?,
                workspace_id: row.get(4)?,
                session_id: row.get(5)?,
                status: row.get(6)?,
                name: row.get(7)?,
                goal: row.get(8)?,
                risk: row.get(9)?,
                summary: row.get(10)?,
                plan_json: row.get(11)?,
                outcome_json: row.get(12)?,
                cwd: row.get(13)?,
                created_at: row.get(14)?,
            })
        },
    );
    match row {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// 保存某次任务的变更摘要 + 脱敏 Diff（应用重启后右栏还能看）。
///
/// 只更新 `changes_json`：任务记录本身由 `extreme_task_save` 维护，两条写入
/// 不互相覆盖。
pub(crate) fn save_task_changes(state: &AppState, task_id: &str, json: &str) -> Result<(), String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE extreme_tasks SET changes_json = ?1 WHERE id = ?2",
        params![json, task_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// 读取某次任务保存的变更 JSON（没有记录 / 字段为空都返回 `None`）。
pub(crate) fn load_task_changes(state: &AppState, task_id: &str) -> Result<Option<String>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    match conn.query_row(
        "SELECT changes_json FROM extreme_tasks WHERE id = ?1",
        params![task_id],
        |row| row.get::<_, Option<String>>(0),
    ) {
        Ok(value) => Ok(value.filter(|text| !text.trim().is_empty())),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// 给任务改名（空串 = 恢复显示执行摘要）。
#[tauri::command]
pub fn extreme_task_rename(state: State<'_, AppState>, id: String, name: String) -> OpsResult<()> {
    let conn = state.db.open().map_err(db_error)?;
    // 只裁掉首尾空白并限长，不做其它改写：名称是用户自己的。
    let name = name.trim().chars().take(120).collect::<String>();
    conn.execute(
        "UPDATE extreme_tasks SET name = ?1 WHERE id = ?2",
        params![name, id],
    )
    .map_err(db_error)?;
    Ok(())
}

/// 删除一条历史（用户主动清理）。
///
/// 执行中 / 等待确认的任务**不允许删**：删掉之后执行器下一次保存会把它插回来，
/// 用户看到的是"删了又出现"。返回 `false` 表示被拦下。
#[tauri::command]
pub fn extreme_task_delete(state: State<'_, AppState>, id: String) -> OpsResult<bool> {
    if let Some(handle) = state.agents.get(&id) {
        let status = handle.snapshot().status;
        if status == "running" || status == "waiting" {
            return Ok(false);
        }
    }
    let conn = state.db.open().map_err(db_error)?;
    conn.execute("DELETE FROM extreme_tasks WHERE id = ?1", params![id])
        .map_err(db_error)?;
    Ok(true)
}

#[cfg(test)]
mod workspace_tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("db");
        conn.execute_batch(
            "CREATE TABLE extreme_workspaces (
                id TEXT PRIMARY KEY NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .expect("table");
        conn
    }

    #[test]
    fn sync_replaces_snapshot_and_lists_newest_first() {
        let mut conn = db();
        write_workspaces(
            &mut conn,
            vec![
                serde_json::json!({ "id": "a", "updatedAt": 10, "messages": [] }),
                serde_json::json!({ "id": "b", "updatedAt": 20, "messages": [] }),
            ],
        )
        .expect("first sync");
        let rows = read_workspaces(&conn).expect("list");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "b");

        // 第二次快照没有 a：整表覆盖后 a 必须消失，不能残留。
        write_workspaces(
            &mut conn,
            vec![serde_json::json!({ "id": "c", "updatedAt": 30, "messages": [] })],
        )
        .expect("second sync");
        let rows = read_workspaces(&conn).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "c");
    }

    #[test]
    fn sync_skips_rows_without_an_id() {
        let mut conn = db();
        write_workspaces(
            &mut conn,
            vec![
                serde_json::json!({ "updatedAt": 1, "messages": [] }),
                serde_json::json!({ "id": "  ", "messages": [] }),
            ],
        )
        .expect("sync");
        assert_eq!(read_workspaces(&conn).expect("list").len(), 0);
    }
}
