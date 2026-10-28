//! 数据库工作台的 Tauri 命令层。
//!
//! 这一层只做三件事：同步读 SQLite（`open_db` 不跨 await）、把 plan 交给
//! `DatabaseManager`、把 `DbErrorInfo` 原样返回。**没有任何 SQL 拼接**。

use tauri::State;

use super::open_db;
use crate::database::runtime::ProfileRuntime;
use crate::database::session::SessionEntry;
use crate::database::{
    driver, metadata, model::*, mutate, profiles, query, schema_ops, table, table_ops,
};
use crate::state::AppState;
use std::sync::Arc;

fn db_error(error: impl std::fmt::Display) -> DbErrorInfo {
    DbErrorInfo::new("config", error.to_string())
}

/// 同步阶段读出连接计划（`rusqlite::Connection` 在块结束时析构）。
fn plan_for(state: &AppState, profile_id: &str) -> Result<driver::EndpointPlan, DbErrorInfo> {
    let conn = open_db(state).map_err(db_error)?;
    driver::plan_from_db(&conn, profile_id)
}

async fn session_and_runtime(
    state: &AppState,
    session_id: &str,
) -> Result<(Arc<SessionEntry>, Arc<ProfileRuntime>), DbErrorInfo> {
    let session = state.database.session(session_id).await?;
    let plan = plan_for(state, &session.profile_id)?;
    let runtime = state.database.runtime(plan).await?;
    Ok((session, runtime))
}

async fn runtime_for(
    state: &AppState,
    profile_id: &str,
) -> Result<Arc<ProfileRuntime>, DbErrorInfo> {
    let plan = plan_for(state, profile_id)?;
    state.database.runtime(plan).await
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_profile_list(state: State<'_, AppState>) -> Result<Vec<DatabaseProfile>, DbErrorInfo> {
    let conn = open_db(&state).map_err(db_error)?;
    profiles::list_profiles(&conn).map_err(db_error)
}

#[tauri::command]
pub fn db_profile_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DatabaseProfile>, DbErrorInfo> {
    let conn = open_db(&state).map_err(db_error)?;
    profiles::get_profile(&conn, &id).map_err(db_error)
}

fn connection_fields_changed(old: &DatabaseProfile, new: &DatabaseProfile) -> bool {
    old.host != new.host
        || old.port != new.port
        || old.username != new.username
        || old.default_database != new.default_database
        || old.ssh_server_id != new.ssh_server_id
        || old.tls_mode != new.tls_mode
        || old.tls_ca_path != new.tls_ca_path
        || old.tls_server_name != new.tls_server_name
        || old.read_only != new.read_only
        || old.connect_timeout_ms != new.connect_timeout_ms
        || old.query_timeout_ms != new.query_timeout_ms
}

#[tauri::command]
pub async fn db_profile_save(
    state: State<'_, AppState>,
    request: SaveProfileRequest,
) -> Result<DatabaseProfile, DbErrorInfo> {
    let (saved, old) = {
        let conn = open_db(&state).map_err(db_error)?;
        profiles::validate_profile(&conn, &request.profile)?;
        let old = profiles::get_profile(&conn, &request.profile.id).map_err(db_error)?;
        let saved = profiles::save_profile(&conn, &request.profile, request.password.as_deref())
            .map_err(db_error)?;
        (saved, old)
    };

    // 连接参数变了：旧的池、隧道与会话都不再代表新配置，必须断开。
    // 只改名字/注释则保留会话，用户不会因为重命名丢掉正在编辑的查询。
    let reset = old
        .as_ref()
        .map(|old| connection_fields_changed(old, &saved))
        .unwrap_or(false);
    if reset {
        state.database.close_profile(&saved.id).await;
    }
    Ok(saved)
}

#[tauri::command]
pub async fn db_profile_delete(state: State<'_, AppState>, id: String) -> Result<(), DbErrorInfo> {
    state.database.close_profile(&id).await;
    let conn = open_db(&state).map_err(db_error)?;
    profiles::delete_profile(&conn, &id).map_err(db_error)
}

#[tauri::command]
pub async fn db_test_connection(
    state: State<'_, AppState>,
    request: TestConnectionRequest,
) -> Result<ConnectionTestResult, DbErrorInfo> {
    let plan = {
        let conn = open_db(&state).map_err(db_error)?;
        profiles::validate_profile(&conn, &request.profile)?;
        driver::plan_from_profile(&conn, &request.profile, request.password.as_deref())?
    };
    Ok(state.database.test_connection(plan).await)
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_connect(
    state: State<'_, AppState>,
    profile_id: String,
    session_id: String,
) -> Result<DbSessionInfo, DbErrorInfo> {
    let plan = plan_for(&state, &profile_id)?;
    state.database.open_session(plan, &session_id).await
}

#[tauri::command]
pub async fn db_session_info(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<DbSessionInfo, DbErrorInfo> {
    Ok(state.database.session(&session_id).await?.info().await)
}

#[tauri::command]
pub async fn db_disconnect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), DbErrorInfo> {
    state.database.close_session(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn db_profile_status(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<ProfileRuntimeStatus, DbErrorInfo> {
    Ok(state.database.profile_status(&profile_id).await)
}

#[tauri::command]
pub async fn db_profile_close(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), DbErrorInfo> {
    state.database.close_profile(&profile_id).await;
    Ok(())
}

#[tauri::command]
pub async fn db_use_database(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> Result<DbSessionInfo, DbErrorInfo> {
    state.database.use_database(&session_id, &database).await
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_metadata_databases(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<DbDatabase>, DbErrorInfo> {
    let runtime = runtime_for(&state, &profile_id).await?;
    metadata::list_databases(&runtime, &state.database.metadata).await
}

#[tauri::command]
pub async fn db_metadata_tables(
    state: State<'_, AppState>,
    profile_id: String,
    database: String,
) -> Result<Vec<DbTable>, DbErrorInfo> {
    let runtime = runtime_for(&state, &profile_id).await?;
    metadata::list_tables(&runtime, &state.database.metadata, &database).await
}

#[tauri::command]
pub async fn db_metadata_table(
    state: State<'_, AppState>,
    profile_id: String,
    database: String,
    table: String,
) -> Result<DbTableDetail, DbErrorInfo> {
    let runtime = runtime_for(&state, &profile_id).await?;
    metadata::table_detail(&runtime, &state.database.metadata, &database, &table).await
}

#[tauri::command]
pub fn db_schema_change_preview(
    request: schema_ops::SchemaChange,
) -> Result<schema_ops::SchemaPreview, DbErrorInfo> {
    schema_ops::preview(&request)
}

#[tauri::command]
pub async fn db_schema_change_apply(
    state: State<'_, AppState>,
    session_id: String,
    request: schema_ops::SchemaChange,
) -> Result<schema_ops::SchemaOutcome, DbErrorInfo> {
    let (session, _runtime) = session_and_runtime(&state, &session_id).await?;
    let outcome = schema_ops::apply(&session, &request).await?;
    state
        .database
        .metadata
        .invalidate(Some(&session.profile_id))
        .await;
    Ok(outcome)
}

#[tauri::command]
pub async fn db_table_operation_preview(
    state: State<'_, AppState>,
    session_id: String,
    request: table_ops::TableOperationRequest,
) -> Result<table_ops::TableOperationPreview, DbErrorInfo> {
    let (_session, runtime) = session_and_runtime(&state, &session_id).await?;
    let detail = metadata::table_detail(
        &runtime,
        &state.database.metadata,
        &request.database,
        &request.table,
    )
    .await?;
    table_ops::preview(&detail, &request)
}

#[tauri::command]
pub async fn db_table_operation_apply(
    state: State<'_, AppState>,
    session_id: String,
    request: table_ops::TableOperationRequest,
) -> Result<table_ops::TableOperationOutcome, DbErrorInfo> {
    let (session, runtime) = session_and_runtime(&state, &session_id).await?;
    let detail = metadata::table_detail(
        &runtime,
        &state.database.metadata,
        &request.database,
        &request.table,
    )
    .await?;
    let outcome = table_ops::apply(&session, &detail, &request).await?;
    state
        .database
        .metadata
        .invalidate(Some(&session.profile_id))
        .await;
    Ok(outcome)
}

#[tauri::command]
pub async fn db_metadata_invalidate(
    state: State<'_, AppState>,
    profile_id: Option<String>,
) -> Result<MetadataCacheStatus, DbErrorInfo> {
    let target = profile_id.unwrap_or_default();
    state
        .database
        .metadata
        .invalidate(if target.is_empty() {
            None
        } else {
            Some(&target)
        })
        .await;
    Ok(state.database.metadata.status(&target).await)
}

// ---------------------------------------------------------------------------
// 表数据 / 单元格详情
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_table_browse(
    state: State<'_, AppState>,
    request: BrowseRequest,
) -> Result<BrowseResult, DbErrorInfo> {
    let (_session, runtime) = session_and_runtime(&state, &request.session_id).await?;
    let detail = metadata::table_detail(
        &runtime,
        &state.database.metadata,
        &request.database,
        &request.table,
    )
    .await?;
    let budget = ResolvedBudget::resolve(None);
    table::browse(&runtime, &detail, &request, &budget).await
}

#[tauri::command]
pub async fn db_read_cell(
    state: State<'_, AppState>,
    profile_id: String,
    database: String,
    table: String,
    key_values: Vec<Option<String>>,
    column: String,
    max_bytes: Option<usize>,
) -> Result<DbValue, DbErrorInfo> {
    let runtime = runtime_for(&state, &profile_id).await?;
    let detail =
        metadata::table_detail(&runtime, &state.database.metadata, &database, &table).await?;
    let (value, _total) = table::read_cell(
        &runtime,
        &detail,
        &key_values,
        &column,
        max_bytes.unwrap_or(256 * 1024),
    )
    .await?;
    Ok(value)
}

// ---------------------------------------------------------------------------
// 查询任务
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_query_start(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    budget: Option<QueryBudget>,
) -> Result<query::QueryStarted, DbErrorInfo> {
    if sql.trim().is_empty() {
        return Err(DbErrorInfo::new("query", "SQL 不能为空"));
    }
    let (session, runtime) = session_and_runtime(&state, &session_id).await?;
    let budget = ResolvedBudget::resolve(budget.as_ref());
    state
        .database
        .queries
        .start(query::StartQueryRequest {
            session,
            runtime,
            sql,
            budget,
        })
        .await
}

#[tauri::command]
pub async fn db_query_next(
    state: State<'_, AppState>,
    query_id: String,
) -> Result<QueryBatchResponse, DbErrorInfo> {
    state.database.queries.next(&query_id).await
}

#[tauri::command]
pub async fn db_query_cancel(
    state: State<'_, AppState>,
    query_id: String,
) -> Result<String, DbErrorInfo> {
    state.database.queries.cancel(&query_id).await
}

#[tauri::command]
pub async fn db_query_release(
    state: State<'_, AppState>,
    query_id: String,
) -> Result<(), DbErrorInfo> {
    state.database.queries.release(&query_id).await;
    Ok(())
}

#[tauri::command]
pub async fn db_query_state(
    state: State<'_, AppState>,
    query_id: String,
) -> Result<Option<String>, DbErrorInfo> {
    Ok(state.database.queries.state(&query_id).await)
}

// ---------------------------------------------------------------------------
// 数据修改
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_mutate_apply(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    table: String,
    rows: Vec<RowMutation>,
    allow_non_transactional: Option<bool>,
) -> Result<MutationResult, DbErrorInfo> {
    if rows.is_empty() {
        return Err(DbErrorInfo::new("query", "没有待提交的修改"));
    }
    let (session, runtime) = session_and_runtime(&state, &session_id).await?;
    let detail =
        metadata::table_detail(&runtime, &state.database.metadata, &database, &table).await?;
    let request = MutationRequest {
        session_id,
        database,
        table,
        rows,
        allow_non_transactional,
    };
    let (result, _info) = mutate::apply(&runtime, &session, &detail, &request).await?;
    Ok(result)
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

fn export_file_name(suggested: &str) -> String {
    let trimmed = suggested.trim();
    let base = std::path::Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("export.csv");
    if base.to_ascii_lowercase().ends_with(".csv") {
        base.to_string()
    } else {
        format!("{base}.csv")
    }
}

/// 导出路径必须由用户在系统“另存为”对话框中明确选择。
#[tauri::command]
pub async fn db_pick_export_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    suggested_name: String,
) -> Result<Option<String>, DbErrorInfo> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .set_file_name(export_file_name(&suggested_name))
        .add_filter("CSV", &["csv"])
        .blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let mut path = picked
        .into_path()
        .map_err(|error| db_error(format!("无法解析导出路径：{error}")))?;
    if path.extension().is_none() {
        path.set_extension("csv");
    }
    let path = path.to_string_lossy().to_string();
    state
        .export_paths
        .lock()
        .map_err(|_| DbErrorInfo::new("config", "导出路径授权状态不可用"))?
        .insert(path.clone());
    Ok(Some(path))
}

#[tauri::command]
pub async fn db_export_start(
    state: State<'_, AppState>,
    profile_id: String,
    request: ExportRequest,
) -> Result<ExportStarted, DbErrorInfo> {
    if !state
        .export_paths
        .lock()
        .map_err(|_| DbErrorInfo::new("config", "导出路径授权状态不可用"))?
        .contains(&request.target_path)
    {
        return Err(DbErrorInfo::new(
            "permission",
            "导出路径必须通过系统“另存为”对话框选择",
        ));
    }
    let runtime = runtime_for(&state, &profile_id).await?;
    let detail = match &request.table {
        Some(target) => Some(
            metadata::table_detail(
                &runtime,
                &state.database.metadata,
                &target.database,
                &target.table,
            )
            .await?,
        ),
        None => None,
    };
    state.database.exports.start(runtime, request, detail).await
}

#[tauri::command]
pub async fn db_export_status(
    state: State<'_, AppState>,
    export_id: String,
) -> Result<ExportProgress, DbErrorInfo> {
    state.database.exports.status(&export_id).await
}

#[tauri::command]
pub async fn db_export_outcome(
    state: State<'_, AppState>,
    export_id: String,
) -> Result<ExportOutcome, DbErrorInfo> {
    state.database.exports.outcome(&export_id).await
}

#[tauri::command]
pub async fn db_export_cancel(
    state: State<'_, AppState>,
    export_id: String,
) -> Result<(), DbErrorInfo> {
    state.database.exports.cancel(&export_id).await
}

#[tauri::command]
pub async fn db_export_remove(
    state: State<'_, AppState>,
    export_id: String,
) -> Result<(), DbErrorInfo> {
    state.database.exports.remove(&export_id).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// SQL 历史（显式、可清空）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_history_list(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<profiles::QueryHistoryEntry>, DbErrorInfo> {
    let conn = open_db(&state).map_err(db_error)?;
    profiles::list_history(&conn, &profile_id).map_err(db_error)
}

#[tauri::command]
pub fn db_history_record(
    state: State<'_, AppState>,
    request: profiles::HistoryWrite,
) -> Result<profiles::QueryHistoryEntry, DbErrorInfo> {
    let conn = open_db(&state).map_err(db_error)?;
    profiles::record_history_request(&conn, &request).map_err(db_error)
}

#[tauri::command]
pub fn db_history_clear(
    state: State<'_, AppState>,
    profile_id: Option<String>,
) -> Result<(), DbErrorInfo> {
    let conn = open_db(&state).map_err(db_error)?;
    profiles::clear_history(&conn, profile_id.as_deref()).map_err(db_error)
}

// ---------------------------------------------------------------------------
// SQL 文件（对话框由 Rust 打开，前端不能自行指定任意路径）
// ---------------------------------------------------------------------------

/// 单个 SQL 文件的上限：防止误选一个巨大文件把编辑器卡死。
const MAX_SQL_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFilePayload {
    pub path: String,
    pub content: String,
}

fn sql_file_name(suggested: &str) -> String {
    let trimmed = suggested.trim();
    let base = std::path::Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("query.sql");
    if base.to_ascii_lowercase().ends_with(".sql") {
        base.to_string()
    } else {
        format!("{base}.sql")
    }
}

async fn read_sql_file_at(path: &std::path::Path) -> Result<String, DbErrorInfo> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| DbErrorInfo::new("config", format!("无法读取 SQL 文件：{error}")))?;
    if metadata.len() > MAX_SQL_FILE_BYTES {
        return Err(DbErrorInfo::new(
            "config",
            format!(
                "SQL 文件超过 {} MiB，拒绝打开",
                MAX_SQL_FILE_BYTES / 1024 / 1024
            ),
        ));
    }
    tokio::fs::read_to_string(path).await.map_err(|error| {
        DbErrorInfo::new(
            "config",
            format!("SQL 文件不是 UTF-8 文本或无法读取：{error}"),
        )
    })
}

async fn write_sql_file_at(path: &std::path::Path, sql: &str) -> Result<(), DbErrorInfo> {
    if sql.len() as u64 > MAX_SQL_FILE_BYTES {
        return Err(DbErrorInfo::new(
            "config",
            format!(
                "SQL 内容超过 {} MiB，拒绝写入",
                MAX_SQL_FILE_BYTES / 1024 / 1024
            ),
        ));
    }
    tokio::fs::write(path, sql)
        .await
        .map_err(|error| DbErrorInfo::new("config", format!("写入 SQL 文件失败：{error}")))
}

#[tauri::command]
pub async fn db_open_sql_file(
    app: tauri::AppHandle,
) -> Result<Option<SqlFilePayload>, DbErrorInfo> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .add_filter("SQL", &["sql"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| db_error(format!("无法解析文件路径：{error}")))?;
    let content = read_sql_file_at(&path).await?;
    Ok(Some(SqlFilePayload {
        path: path.to_string_lossy().to_string(),
        content,
    }))
}

#[tauri::command]
pub async fn db_save_sql_file(
    app: tauri::AppHandle,
    sql: String,
    suggested_name: String,
) -> Result<Option<String>, DbErrorInfo> {
    use tauri_plugin_dialog::DialogExt;

    if sql.len() as u64 > MAX_SQL_FILE_BYTES {
        return Err(DbErrorInfo::new(
            "config",
            format!(
                "SQL 内容超过 {} MiB，拒绝写入",
                MAX_SQL_FILE_BYTES / 1024 / 1024
            ),
        ));
    }
    let picked = app
        .dialog()
        .file()
        .set_file_name(sql_file_name(&suggested_name))
        .add_filter("SQL", &["sql"])
        .blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let mut path = picked
        .into_path()
        .map_err(|error| db_error(format!("无法解析文件路径：{error}")))?;
    if path.extension().is_none() {
        path.set_extension("sql");
    }
    write_sql_file_at(&path, &sql).await?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 供前端检查同名命令是否注册（调试用；不参与业务）。
#[tauri::command]
pub fn db_module_info() -> serde_json::Value {
    serde_json::json!({
        "engine": "mysql",
        "driver": "mysql_async 0.37 (rustls, ring)",
        "supports": ["mysql8"],
        "postgres": "unimplemented"
    })
}

#[cfg(test)]
mod tests {
    use super::{export_file_name, sql_file_name};

    #[test]
    fn sql_file_name_never_contains_path_segments() {
        assert_eq!(sql_file_name("query"), "query.sql");
        assert_eq!(sql_file_name("../secret.sql"), "secret.sql");
        assert_eq!(sql_file_name(r"C:\Users\me\query.SQL"), "query.SQL");
        assert_eq!(sql_file_name("   "), "query.sql");
    }

    #[test]
    fn export_file_name_never_contains_path_segments() {
        assert_eq!(export_file_name("orders"), "orders.csv");
        assert_eq!(export_file_name("../../orders.csv"), "orders.csv");
        assert_eq!(export_file_name(r"C:\exports\orders.CSV"), "orders.CSV");
        assert_eq!(export_file_name("  "), "export.csv");
    }
}
