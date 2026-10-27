//! CSV 流式导出。
//!
//! * **Rust 分批读取、流式写盘**；IPC 只传进度（前端轮询
//!   `db_export_status`），从不把导出数据搬进 WebView。
//! * 写的是 `<目标>.part-<export_id>`，只有 `flush + sync_all + rename`
//!   全部成功才发布最终文件。失败/取消删除临时文件，绝不留下半个 CSV
//!   冒充成功。
//! * 导出使用**独立的连接池（最多 1 条）**，不会把交互连接占满。
//! * 导出永远**重新查询**：界面会明确提示"数据可能已变化"。
//!   不把前端缓存的行传回来假装完整，也不重执行有副作用的 SQL。
//! * 连接上先 `START TRANSACTION READ ONLY`：即使检测失手，服务器也会
//!   拒绝写语句。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use mysql_async::prelude::Queryable;
use mysql_async::{Params, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::{watch, Mutex, RwLock};

use super::codec;
use super::driver::{is_read_only_sql, map_error, quote_identifier};
use super::model::{
    DbErrorInfo, DbTableDetail, ExportOutcome, ExportProgress, ExportRequest, ExportStarted,
};
use super::runtime::ProfileRuntime;
use super::table;

const CHECK_CANCEL_ROWS: u64 = 200;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

struct ExportTask {
    export_id: String,
    profile_id: String,
    state: RwLock<String>,
    rows: AtomicU64,
    bytes: AtomicU64,
    message: RwLock<Option<String>>,
    path: RwLock<Option<String>>,
    error: RwLock<Option<DbErrorInfo>>,
    cancel: watch::Sender<bool>,
    started: Instant,
}

#[derive(Clone, Default)]
pub struct ExportRegistry {
    entries: Arc<Mutex<HashMap<String, Arc<ExportTask>>>>,
}

impl ExportRegistry {
    pub async fn start(
        &self,
        profile: Arc<ProfileRuntime>,
        request: ExportRequest,
        detail: Option<DbTableDetail>,
    ) -> Result<ExportStarted, DbErrorInfo> {
        if request.target_path.trim().is_empty() {
            return Err(DbErrorInfo::new("config", "请选择导出文件路径"));
        }
        if request.table.is_none() && request.sql.trim().is_empty() {
            return Err(DbErrorInfo::new("config", "没有可导出的 SQL 或表"));
        }
        if request.table.is_some() && detail.is_none() {
            return Err(DbErrorInfo::new("config", "表导出缺少表结构信息"));
        }
        if request.table.is_none() && !is_read_only_sql(&request.sql) {
            return Err(DbErrorInfo::new(
                "permission",
                "只允许导出只读查询：不会重新执行 INSERT/UPDATE/DELETE 等有副作用的语句",
            ));
        }

        let export_id = uuid::Uuid::new_v4().to_string();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let task = Arc::new(ExportTask {
            export_id: export_id.clone(),
            profile_id: profile.profile_id.clone(),
            state: RwLock::new("running".to_string()),
            rows: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            message: RwLock::new(None),
            path: RwLock::new(Some(request.target_path.clone())),
            error: RwLock::new(None),
            cancel: cancel_tx,
            started: Instant::now(),
        });

        self.entries
            .lock()
            .await
            .insert(export_id.clone(), task.clone());

        let task_for_job = task.clone();
        tokio::spawn(async move {
            run_export(profile, request, detail, task_for_job, cancel_rx).await;
        });

        Ok(ExportStarted { export_id })
    }

    pub async fn cancel(&self, export_id: &str) -> Result<(), DbErrorInfo> {
        let task = self
            .entries
            .lock()
            .await
            .get(export_id)
            .cloned()
            .ok_or_else(|| DbErrorInfo::new("cancelled", "导出任务不存在"))?;
        let state = task.state.read().await.clone();
        if matches!(state.as_str(), "completed" | "cancelled" | "failed") {
            return Ok(());
        }
        *task.state.write().await = "cancelling".to_string();
        let _ = task.cancel.send(true);
        Ok(())
    }

    pub async fn status(&self, export_id: &str) -> Result<ExportProgress, DbErrorInfo> {
        let task = self
            .entries
            .lock()
            .await
            .get(export_id)
            .cloned()
            .ok_or_else(|| DbErrorInfo::new("cancelled", "导出任务不存在"))?;
        let state = { task.state.read().await.clone() };
        let message = { task.message.read().await.clone() };
        Ok(ExportProgress {
            export_id: task.export_id.clone(),
            rows: task.rows.load(Ordering::Acquire),
            bytes: task.bytes.load(Ordering::Acquire),
            state,
            message,
            elapsed_ms: task.started.elapsed().as_millis() as u64,
        })
    }

    pub async fn outcome(&self, export_id: &str) -> Result<ExportOutcome, DbErrorInfo> {
        let task = self
            .entries
            .lock()
            .await
            .get(export_id)
            .cloned()
            .ok_or_else(|| DbErrorInfo::new("cancelled", "导出任务不存在"))?;
        let state = { task.state.read().await.clone() };
        let path = { task.path.read().await.clone() };
        let error = { task.error.read().await.clone() };
        Ok(ExportOutcome {
            export_id: task.export_id.clone(),
            state,
            path,
            rows: task.rows.load(Ordering::Acquire),
            bytes: task.bytes.load(Ordering::Acquire),
            error,
            elapsed_ms: task.started.elapsed().as_millis() as u64,
        })
    }

    pub async fn remove(&self, export_id: &str) {
        if let Some(task) = self.entries.lock().await.remove(export_id) {
            let _ = task.cancel.send(true);
        }
    }

    pub async fn remove_profile(&self, profile_id: &str) {
        let ids: Vec<String> = self
            .entries
            .lock()
            .await
            .values()
            .filter(|task| task.profile_id == profile_id)
            .map(|task| task.export_id.clone())
            .collect();
        for id in ids {
            self.remove(&id).await;
        }
    }

    pub async fn active_count(&self) -> usize {
        self.entries
            .lock()
            .await
            .values()
            .filter(|task| {
                !matches!(
                    task.state.try_read().map(|state| state.clone()).as_deref(),
                    Ok("completed") | Ok("cancelled") | Ok("failed")
                )
            })
            .count()
    }
}

fn build_csv_plan(
    request: &ExportRequest,
    detail: Option<&DbTableDetail>,
) -> Result<(String, Params), DbErrorInfo> {
    if let Some(table) = &request.table {
        let detail = detail.ok_or_else(|| DbErrorInfo::new("config", "表结构缺失"))?;
        let mut params: Vec<Value> = Vec::new();
        let mut where_parts = Vec::new();
        if let Some(filters) = &request.filters {
            for filter in filters {
                if detail
                    .columns
                    .iter()
                    .all(|column| column.name != filter.column)
                {
                    return Err(DbErrorInfo::new(
                        "query",
                        format!("过滤列不存在：{}", filter.column),
                    ));
                }
                if let Some(clause) = table::filter_clause(filter, &mut params)? {
                    where_parts.push(clause);
                }
            }
        }

        let mut order_parts = Vec::new();
        if let Some(sorts) = &request.sorts {
            for sort in sorts {
                if detail
                    .columns
                    .iter()
                    .all(|column| column.name != sort.column)
                {
                    return Err(DbErrorInfo::new(
                        "query",
                        format!("排序列不存在：{}", sort.column),
                    ));
                }
                if !matches!(sort.direction.as_str(), "asc" | "desc") {
                    return Err(DbErrorInfo::new("query", "排序方向必须是 asc 或 desc"));
                }
                order_parts.push(format!(
                    "{} {}",
                    quote_identifier(&sort.column)?,
                    sort.direction.to_uppercase()
                ));
            }
        } else if let Some(keys) = &detail.reliable_key {
            for key in keys {
                order_parts.push(format!("{} ASC", quote_identifier(key)?));
            }
        }

        let sql = format!(
            "SELECT * FROM {}.{}{}{}",
            quote_identifier(&table.database)?,
            quote_identifier(&table.table)?,
            if where_parts.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", where_parts.join(" AND "))
            },
            if order_parts.is_empty() {
                String::new()
            } else {
                format!(" ORDER BY {}", order_parts.join(", "))
            }
        );
        return Ok((sql, Params::Positional(params)));
    }

    Ok((request.sql.clone(), Params::Empty))
}

async fn run_export(
    profile: Arc<ProfileRuntime>,
    request: ExportRequest,
    detail: Option<DbTableDetail>,
    task: Arc<ExportTask>,
    cancel_rx: watch::Receiver<bool>,
) {
    let started = Instant::now();
    let part_path =
        std::path::PathBuf::from(format!("{}.part-{}", request.target_path, task.export_id));
    let target_path = std::path::PathBuf::from(&request.target_path);

    let mut conn: mysql_async::Conn =
        match tokio::time::timeout(Duration::from_secs(15), profile.export_pool().get_conn()).await
        {
            Ok(Ok(conn)) => conn,
            Ok(Err(error)) => {
                fail(&task, map_error(&error, "tcp"), &part_path).await;
                return;
            }
            Err(_) => {
                fail(
                    &task,
                    DbErrorInfo::new("tcp", "导出连接超时").retryable(true),
                    &part_path,
                )
                .await;
                return;
            }
        };

    let (sql, params) = match build_csv_plan(&request, detail.as_ref()) {
        Ok(plan) => plan,
        Err(error) => {
            fail(&task, error, &part_path).await;
            return;
        }
    };

    if let Err(error) = conn.query_drop("START TRANSACTION READ ONLY").await {
        fail(&task, map_error(&error, "permission"), &part_path).await;
        return;
    }

    // 统一走预处理语句：过滤条件里的值**必须**是绑定参数，
    // 绝不能内联进 SQL。代价是导出语句必须是单条（多语句不在导出范围内）。
    let mut result = match conn.exec_iter(sql, params).await {
        Ok(result) => result,
        Err(error) => {
            let _ = conn.query_drop("ROLLBACK").await;
            fail(&task, map_error(&error, "query"), &part_path).await;
            return;
        }
    };

    let columns = result.columns_ref().to_vec();
    if columns.is_empty() {
        let _ = conn.query_drop("ROLLBACK").await;
        fail(
            &task,
            DbErrorInfo::new("query", "该语句没有结果集，无法导出为 CSV"),
            &part_path,
        )
        .await;
        return;
    }

    let file = match tokio::fs::File::create(&part_path).await {
        Ok(file) => file,
        Err(error) => {
            let _ = conn.query_drop("ROLLBACK").await;
            fail(
                &task,
                DbErrorInfo::new("config", format!("无法创建导出文件：{error}")),
                &part_path,
            )
            .await;
            return;
        }
    };
    let mut writer = tokio::io::BufWriter::with_capacity(64 * 1024, file);
    let mut written: u64 = 0;

    if request.bom.unwrap_or(true) {
        match write_text(&mut writer, "\u{feff}").await {
            Ok(bytes) => written += bytes,
            Err(error) => {
                fail(
                    &task,
                    DbErrorInfo::new("config", format!("写导出文件失败：{error}")),
                    &part_path,
                )
                .await;
                return;
            }
        }
    }

    let header = columns
        .iter()
        .map(|column| codec::csv_field(&column.name_str()))
        .collect::<Vec<_>>()
        .join(",");
    if let Err(error) = write_text(&mut writer, &format!("{header}\r\n")).await {
        fail(
            &task,
            DbErrorInfo::new("config", format!("写导出文件失败：{error}")),
            &part_path,
        )
        .await;
        return;
    }

    let mut rows: u64 = 0;
    let mut last_progress = Instant::now();
    let mut cancelled = false;
    let mut stream_error: Option<DbErrorInfo> = None;
    let mut write_error: Option<DbErrorInfo> = None;
    let mut limit_message: Option<String> = None;

    // `stream` 借用 `result`，`result` 借用 `conn`。错误先记在标志里，
    // 退出这个 match 后再统一 ROLLBACK —— 避免同时可变借用 `conn`。
    match result.stream::<mysql_async::Row>().await {
        Ok(Some(mut stream)) => loop {
            if *cancel_rx.borrow() {
                cancelled = true;
                break;
            }

            let row = match stream.try_next().await {
                Ok(Some(row)) => row,
                Ok(None) => break,
                Err(error) => {
                    stream_error = Some(map_error(&error, "query"));
                    break;
                }
            };

            let mut line = String::with_capacity(256);
            let columns_ref = row.columns_ref();
            for index in 0..columns_ref.len() {
                if index > 0 {
                    line.push(',');
                }
                let value = row
                    .as_ref(index)
                    .cloned()
                    .unwrap_or(mysql_async::Value::NULL);
                // `usize::MAX`：导出必须写完整值；单字段上限由驱动的
                // max_allowed_packet（16 MiB）兜底，超大会在这里得到明确错误。
                let cell = codec::to_value(&columns_ref[index], value, usize::MAX);
                line.push_str(&codec::csv_cell(&cell));
            }
            line.push_str("\r\n");

            match write_text(&mut writer, &line).await {
                Ok(bytes) => written += bytes,
                Err(error) => {
                    write_error = Some(DbErrorInfo::new(
                        "config",
                        format!("写导出文件失败：{error}"),
                    ));
                    break;
                }
            }
            rows += 1;
            task.rows.store(rows, Ordering::Release);
            task.bytes.store(written, Ordering::Release);

            if let Some(limit) = request.max_rows.filter(|limit| *limit > 0) {
                if rows >= limit {
                    limit_message = Some(format!("已达行数上限 {limit}，导出提前结束"));
                    break;
                }
            }

            if rows % CHECK_CANCEL_ROWS == 0 {
                if last_progress.elapsed() >= PROGRESS_INTERVAL {
                    let _ = writer.flush().await;
                    last_progress = Instant::now();
                }
                tokio::task::yield_now().await;
            }
        },
        // 空结果集是合法的：只导出表头。
        Ok(None) => {}
        Err(error) => stream_error = Some(map_error(&error, "query")),
    }

    drop(result);

    if let Some(message) = limit_message {
        *task.message.write().await = Some(message);
    }

    if cancelled {
        let _ = writer.flush().await;
        let _ = conn.query_drop("ROLLBACK").await;
        let _ = tokio::fs::remove_file(&part_path).await;
        *task.state.write().await = "cancelled".to_string();
        *task.message.write().await = Some("导出已取消，临时文件已删除".to_string());
        return;
    }
    if let Some(error) = stream_error {
        let _ = writer.flush().await;
        let _ = conn.query_drop("ROLLBACK").await;
        fail(&task, error, &part_path).await;
        return;
    }
    if let Some(error) = write_error {
        let _ = writer.flush().await;
        let _ = conn.query_drop("ROLLBACK").await;
        fail(&task, error, &part_path).await;
        return;
    }

    if let Err(error) = writer.flush().await {
        let _ = conn.query_drop("ROLLBACK").await;
        fail(
            &task,
            DbErrorInfo::new("config", format!("刷新导出文件失败：{error}")),
            &part_path,
        )
        .await;
        return;
    }
    // `sync_all` 失败（常见于磁盘满/可移动盘拔出）绝不能当成成功。
    let file = writer.into_inner();
    if let Err(error) = file.sync_all().await {
        let _ = conn.query_drop("ROLLBACK").await;
        fail(
            &task,
            DbErrorInfo::new("config", format!("同步导出文件到磁盘失败：{error}")),
            &part_path,
        )
        .await;
        return;
    }
    drop(file);
    let _ = conn.query_drop("ROLLBACK").await;

    // 原子发布：先把旧文件挪到 .bak，再改名；失败则恢复旧文件。
    let backup = target_path.with_extension("bak-ops");
    let had_old = tokio::fs::try_exists(&target_path).await.unwrap_or(false);
    if had_old {
        if let Err(error) = tokio::fs::rename(&target_path, &backup).await {
            fail(
                &task,
                DbErrorInfo::new("config", format!("无法替换已有导出文件：{error}")),
                &part_path,
            )
            .await;
            return;
        }
    }
    if let Err(error) = tokio::fs::rename(&part_path, &target_path).await {
        if had_old {
            let _ = tokio::fs::rename(&backup, &target_path).await;
        }
        fail(
            &task,
            DbErrorInfo::new("config", format!("发布导出文件失败：{error}")),
            &part_path,
        )
        .await;
        return;
    }
    if had_old {
        let _ = tokio::fs::remove_file(&backup).await;
    }

    task.bytes.store(written, Ordering::Release);
    *task.path.write().await = Some(target_path.to_string_lossy().to_string());
    *task.state.write().await = "completed".to_string();
    *task.message.write().await = Some(format!(
        "导出完成：{rows} 行，{written} 字节，耗时 {} ms（重新查询导出，数据可能与页面显示不同）",
        started.elapsed().as_millis()
    ));
}

async fn write_text(
    writer: &mut tokio::io::BufWriter<tokio::fs::File>,
    text: &str,
) -> std::io::Result<u64> {
    writer.write_all(text.as_bytes()).await?;
    Ok(text.len() as u64)
}

async fn fail(task: &ExportTask, error: DbErrorInfo, part_path: &std::path::Path) {
    *task.state.write().await = "failed".to_string();
    *task.message.write().await = Some(error.message.clone());
    *task.error.write().await = Some(error);
    if !part_path.as_os_str().is_empty() {
        let _ = tokio::fs::remove_file(part_path).await;
    }
}
