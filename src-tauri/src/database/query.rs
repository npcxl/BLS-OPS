//! 查询任务：分批 + 拉取式背压 + 真实服务端取消。
//!
//! ## 背压是怎么成立的
//!
//! `mpsc::channel(2)` 是唯一的缓冲区。生产端每凑够一批就 `send().await`；
//! 前端不调用 `db_query_next` 时，第 3 批会在 `send` 上**阻塞**，
//! 于是任务停止从 MySQL socket 读取，TCP 窗口随之收缩 —— 服务器被真正
//! 减速，内存里最多只有 2 批 + 当前批。没有"缓冲超过阈值就立刻发送"的
//! 伪背压。
//!
//! 前端关闭标签页 / 主动停止展示 → `release` 移除接收端 → `send` 失败
//! → 任务立刻丢弃连接（不是把巨大结果排空完）。
//!
//! ## 取消
//!
//! `KILL QUERY <thread_id>` 走独立的控制连接，与执行连接无关。
//! 三种结果分别上报：`cancelling`（请求已发出）、`cancelled`（服务器已
//! 确认结束，通常表现为 1317）、`outcome_unknown`（5 秒内没有确认 →
//! 丢弃连接，绝不把可疑连接放回池里）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::TryStreamExt;
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Row};
use tokio::sync::{mpsc, watch, Mutex, RwLock};

use super::codec;
use super::driver;
use super::model::{
    DbBatch, DbErrorInfo, DbValue, QueryBatchResponse, ResolvedBudget, STATE_CANCELLED,
    STATE_CANCELLING, STATE_COMPLETED, STATE_FAILED, STATE_OUTCOME_UNKNOWN, STATE_QUEUED,
    STATE_RUNNING, STATE_STREAMING,
};
use super::runtime::ProfileRuntime;
use super::session::SessionEntry;

/// 取消/超时后等待服务器确认的时间。超过就判定"结果未知"。
const CANCEL_CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);
/// `db_query_next` 等待下一批的最长时间。到时返回空批次，前端可继续拉。
const NEXT_BATCH_WAIT: Duration = Duration::from_secs(20);
/// 取消/超时检查的轮询间隔。只在有查询运行时存在，开销可忽略。
const TICK: Duration = Duration::from_millis(150);

pub struct QueryHandle {
    pub query_id: String,
    pub session_id: String,
    pub profile_id: String,
    pub generation: u64,
    pub thread_id: u32,
    pub state: Arc<RwLock<String>>,
    cancel: watch::Sender<bool>,
    pub in_flight: Arc<AtomicUsize>,
    pub in_flight_bytes: Arc<AtomicUsize>,
    pub started_at: i64,
}

pub struct QueryEntry {
    pub handle: Arc<QueryHandle>,
    pub runtime: Arc<ProfileRuntime>,
    receiver: Mutex<mpsc::Receiver<DbBatch>>,
}

#[derive(Clone, Default)]
pub struct QueryRegistry {
    entries: Arc<Mutex<HashMap<String, Arc<QueryEntry>>>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct QueryStarted {
    pub query_id: String,
    pub state: String,
    pub generation: u64,
    pub connection_id: u32,
}

pub struct StartQueryRequest {
    pub session: Arc<SessionEntry>,
    pub runtime: Arc<ProfileRuntime>,
    pub sql: String,
    pub budget: ResolvedBudget,
}

impl QueryRegistry {
    pub async fn start(&self, request: StartQueryRequest) -> Result<QueryStarted, DbErrorInfo> {
        let StartQueryRequest {
            session,
            runtime,
            sql,
            budget,
        } = request;

        // 独占连接：这条 SQL 期间，该会话不会被别的请求抢走连接。
        let conn = session.acquire_conn().await?;
        let thread_id = conn.id();

        let query_id = uuid::Uuid::new_v4().to_string();
        let generation = session.generation;
        let state = Arc::new(RwLock::new(STATE_QUEUED.to_string()));
        let (tx, rx) = mpsc::channel::<DbBatch>(2);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let in_flight = Arc::new(AtomicUsize::new(0));
        let in_flight_bytes = Arc::new(AtomicUsize::new(0));

        let handle = Arc::new(QueryHandle {
            query_id: query_id.clone(),
            session_id: session.session_id.clone(),
            profile_id: session.profile_id.clone(),
            generation,
            thread_id,
            state: state.clone(),
            cancel: cancel_tx,
            in_flight: in_flight.clone(),
            in_flight_bytes: in_flight_bytes.clone(),
            started_at: crate::db::AppDb::now(),
        });

        self.entries.lock().await.insert(
            query_id.clone(),
            Arc::new(QueryEntry {
                handle: handle.clone(),
                runtime: runtime.clone(),
                receiver: Mutex::new(rx),
            }),
        );

        runtime.begin_query();

        let task_runtime = runtime.clone();
        let task_session = session.clone();
        let task_query_id = query_id.clone();
        tokio::spawn(async move {
            run_script(
                conn,
                task_runtime.clone(),
                task_session,
                task_query_id,
                sql,
                budget,
                tx,
                state,
                cancel_rx,
                in_flight,
                in_flight_bytes,
            )
            .await;
            task_runtime.end_query();
        });

        Ok(QueryStarted {
            query_id,
            state: STATE_QUEUED.to_string(),
            generation,
            connection_id: thread_id,
        })
    }

    pub async fn next(&self, query_id: &str) -> Result<QueryBatchResponse, DbErrorInfo> {
        let entry = self
            .entries
            .lock()
            .await
            .get(query_id)
            .cloned()
            .ok_or_else(|| DbErrorInfo::new("query", "查询任务不存在或已关闭"))?;

        let mut receiver = entry.receiver.lock().await;
        let outcome = tokio::time::timeout(NEXT_BATCH_WAIT, receiver.recv()).await;

        let state = entry.handle.state.read().await.clone();
        let in_flight = entry.handle.in_flight.load(Ordering::Acquire);
        let in_flight_bytes = entry.handle.in_flight_bytes.load(Ordering::Acquire);

        let batch = match outcome {
            Err(_) | Ok(None) => None,
            Ok(Some(batch)) => {
                if let DbBatch::Rows { bytes, .. } = &batch {
                    entry.handle.in_flight.fetch_sub(1, Ordering::AcqRel);
                    entry
                        .handle
                        .in_flight_bytes
                        .fetch_sub(*bytes, Ordering::AcqRel);
                }
                Some(batch)
            }
        };

        Ok(QueryBatchResponse {
            batch,
            state,
            query_id: query_id.to_string(),
            generation: entry.handle.generation,
            in_flight,
            in_flight_bytes,
        })
    }

    /// 主动取消：先发 `KILL QUERY`，再通知任务等待确认。
    pub async fn cancel(&self, query_id: &str) -> Result<String, DbErrorInfo> {
        let entry = self
            .entries
            .lock()
            .await
            .get(query_id)
            .cloned()
            .ok_or_else(|| DbErrorInfo::new("cancelled", "查询任务不存在或已关闭"))?;

        let current = entry.handle.state.read().await.clone();
        if is_terminal(&current) {
            return Ok(current);
        }

        {
            let mut state = entry.handle.state.write().await;
            *state = STATE_CANCELLING.to_string();
        }

        // **先**通知任务"用户要取消"，**再**发 KILL。
        // 反过来的话，KILL 往往先让服务器结束语句，任务在看到 cancel 信号前
        // 就已经收尾，终态会变成 completed/failed —— 用户会以为取消没生效。
        let _ = entry.handle.cancel.send(true);

        match entry.runtime.kill_query(entry.handle.thread_id).await {
            Ok(()) => Ok(STATE_CANCELLING.to_string()),
            Err(error) => {
                // 取消请求没能发出去：这条连接上的语句/事务状态不可信。
                {
                    let mut state = entry.handle.state.write().await;
                    *state = STATE_OUTCOME_UNKNOWN.to_string();
                }
                Err(error)
            }
        }
    }

    /// 关闭/停止展示。移除接收端会让生产的 `send` 失败，任务随即丢弃连接。
    pub async fn release(&self, query_id: &str) {
        let entry = self.entries.lock().await.remove(query_id);
        if let Some(entry) = entry {
            let _ = entry.handle.cancel.send(true);
            // 任务可能正卡在 socket 读取上：主动 KILL 一次，避免连接长期挂着。
            let _ = entry.runtime.kill_query(entry.handle.thread_id).await;
        }
    }

    pub async fn release_profile(&self, profile_id: &str) {
        let ids: Vec<String> = self
            .entries
            .lock()
            .await
            .values()
            .filter(|entry| entry.handle.profile_id == profile_id)
            .map(|entry| entry.handle.query_id.clone())
            .collect();
        for id in ids {
            self.release(&id).await;
        }
    }

    pub async fn release_session(&self, session_id: &str) {
        let ids: Vec<String> = self
            .entries
            .lock()
            .await
            .values()
            .filter(|entry| entry.handle.session_id == session_id)
            .map(|entry| entry.handle.query_id.clone())
            .collect();
        for id in ids {
            self.release(&id).await;
        }
    }

    pub async fn active_count(&self) -> usize {
        self.entries.lock().await.len()
    }

    pub async fn state(&self, query_id: &str) -> Option<String> {
        let entry = self.entries.lock().await.get(query_id).cloned()?;
        // 显式作用域：读锁 guard 必须在 `entry` 被 drop 之前释放。
        let state = {
            let guard = entry.handle.state.read().await;
            guard.clone()
        };
        Some(state)
    }
}

fn is_terminal(state: &str) -> bool {
    matches!(
        state,
        STATE_COMPLETED | STATE_CANCELLED | STATE_FAILED | STATE_OUTCOME_UNKNOWN
    )
}

fn approximate_bytes(cell: &DbValue) -> usize {
    match cell {
        DbValue::Null => 8,
        DbValue::Int { value, .. } | DbValue::Decimal { value } => value.len() + 24,
        DbValue::Float { .. } => 32,
        DbValue::Text { value, .. } | DbValue::Json { value, .. } => value.len() + 24,
        DbValue::Date { value } => value.len() + 24,
        DbValue::DateTime { value, .. } => value.len() + 40,
        DbValue::Time { value } => value.len() + 24,
        DbValue::Binary { base64, .. } => base64.len() + 40,
        DbValue::Bit { bits, .. } => bits.len() + 24,
        DbValue::Unsupported { preview, .. } => preview.len() + 48,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_script(
    mut conn: Conn,
    runtime: Arc<ProfileRuntime>,
    session: Arc<SessionEntry>,
    query_id: String,
    sql: String,
    budget: ResolvedBudget,
    tx: mpsc::Sender<DbBatch>,
    state: Arc<RwLock<String>>,
    mut cancel_rx: watch::Receiver<bool>,
    in_flight: Arc<AtomicUsize>,
    in_flight_bytes: Arc<AtomicUsize>,
) {
    let started = std::time::Instant::now();
    let timeout = Duration::from_millis(runtime.endpoint.profile.query_timeout_ms);
    let deadline = tokio::time::Instant::now() + timeout;
    let thread_id = session.thread_id;

    *state.write().await = STATE_RUNNING.to_string();

    let mut clean = true;
    let mut rows_total = 0u64;
    let mut bytes_total = 0usize;
    let mut truncated = false;
    let mut truncation_reason: Option<String> = None;
    let mut cancelled = false;
    let mut timed_out = false;
    let mut outcome_unknown = false;
    let mut kill_deadline: Option<tokio::time::Instant> = None;
    let mut cancel_handled = false;
    let mut error_seen = false;

    // `query_iter` 走文本协议：不依赖编译期元数据，也不改写用户 SQL。
    let mut result = match conn.query_iter(&sql).await {
        Ok(result) => result,
        Err(error) => {
            *state.write().await = STATE_FAILED.to_string();
            send_batch(
                &tx,
                DbBatch::Error {
                    error: driver::map_error(&error, "query"),
                },
            )
            .await;
            finalize(
                &tx,
                STATE_FAILED,
                started,
                rows_total,
                bytes_total,
                truncated,
                truncation_reason,
            )
            .await;
            session.release_conn(conn, !error.is_fatal()).await;
            return;
        }
    };

    let mut set_index: u32 = 0;
    'outer: loop {
        if result.is_empty() {
            break;
        }

        let columns: Vec<super::model::DbColumn> = result
            .columns_ref()
            .iter()
            .enumerate()
            .map(|(index, column)| codec::to_column(index, column, false))
            .collect();

        let result_set_id = format!("{query_id}:{set_index}");
        if tx
            .send(DbBatch::ResultSet {
                result_set_id: result_set_id.clone(),
                index: set_index,
                columns: columns.clone(),
                statement: truncate_sql(&sql),
            })
            .await
            .is_err()
        {
            cancelled = true;
            clean = false;
            break;
        }

        let mut set_rows = 0u64;
        let mut set_bytes = 0usize;
        let mut batch_rows: Vec<Vec<DbValue>> = Vec::with_capacity(budget.batch_rows);
        let mut batch_bytes = 0usize;
        let mut sequence = 0u64;

        if columns.is_empty() {
            // 没有列的结果集（UPDATE/DDL）：调用一次 `stream` 让它推进到
            // 下一个结果集，否则下一轮还会看到同一个空结果集。
            if let Err(error) = result.stream::<Row>().await {
                send_batch(
                    &tx,
                    DbBatch::Error {
                        error: driver::map_error(&error, "query"),
                    },
                )
                .await;
                error_seen = true;
                if error.is_fatal() {
                    clean = false;
                }
            }
        } else {
            let mut stream = match result.stream::<Row>().await {
                Ok(Some(stream)) => stream,
                Ok(None) => break,
                Err(error) => {
                    *state.write().await = STATE_FAILED.to_string();
                    send_batch(
                        &tx,
                        DbBatch::Error {
                            error: driver::map_error(&error, "query"),
                        },
                    )
                    .await;
                    clean = !error.is_fatal();
                    error_seen = true;
                    break;
                }
            };
            loop {
                let now = tokio::time::Instant::now();
                if let Some(confirm_deadline) = kill_deadline {
                    if now >= confirm_deadline {
                        outcome_unknown = true;
                        clean = false;
                        break 'outer;
                    }
                } else if now >= deadline {
                    timed_out = true;
                    *state.write().await = STATE_CANCELLING.to_string();
                    if runtime.kill_query(thread_id).await.is_err() {
                        outcome_unknown = true;
                        clean = false;
                        break 'outer;
                    }
                    kill_deadline = Some(now + CANCEL_CONFIRM_TIMEOUT);
                    continue;
                }

                let next = tokio::select! {
                    changed = cancel_rx.changed(), if !cancel_handled => {
                        cancel_handled = true;
                        if changed.is_err() {
                            // 接收端已释放：停止展示，不要继续读。
                            cancelled = true;
                            clean = false;
                            break 'outer;
                        }
                        if *cancel_rx.borrow() {
                            cancelled = true;
                            kill_deadline = Some(tokio::time::Instant::now() + CANCEL_CONFIRM_TIMEOUT);
                        }
                        continue;
                    }
                    _ = tokio::time::sleep(TICK) => {
                        // 只用来周期性检查上面的取消/超时计时器。
                        continue;
                    }
                    row = stream.try_next() => row,
                };

                match next {
                    Ok(Some(row)) => {
                        let columns_ref = row.columns_ref();
                        let values: Vec<DbValue> = (0..columns_ref.len())
                            .map(|index| {
                                let value = row
                                    .as_ref(index)
                                    .cloned()
                                    .unwrap_or(mysql_async::Value::NULL);
                                codec::to_value(
                                    &columns_ref[index],
                                    value,
                                    budget.field_preview_bytes,
                                )
                            })
                            .collect();

                        if rows_total == 0 {
                            *state.write().await = STATE_STREAMING.to_string();
                        }
                        let row_bytes: usize = values.iter().map(approximate_bytes).sum();
                        rows_total += 1;
                        bytes_total += row_bytes;
                        set_rows += 1;
                        set_bytes += row_bytes;
                        batch_bytes += row_bytes;
                        batch_rows.push(values);

                        if batch_rows.len() >= budget.batch_rows
                            || batch_bytes >= budget.batch_bytes
                        {
                            if !flush_batch(
                                &tx,
                                &in_flight,
                                &in_flight_bytes,
                                &result_set_id,
                                sequence,
                                std::mem::take(&mut batch_rows),
                                batch_bytes,
                            )
                            .await
                            {
                                cancelled = true;
                                clean = false;
                                break 'outer;
                            }
                            sequence += 1;
                            batch_bytes = 0;
                        }

                        if rows_total >= budget.max_rows || bytes_total >= budget.max_bytes as usize
                        {
                            truncated = true;
                            truncation_reason = Some(if rows_total >= budget.max_rows {
                                format!("已达展示行数上限（{} 行）", budget.max_rows)
                            } else {
                                format!(
                                    "已达展示字节预算（{} MiB）",
                                    budget.max_bytes / (1024 * 1024)
                                )
                            });
                            // 主动停止服务器执行：不把剩余结果读进内存。
                            let _ = runtime.kill_query(thread_id).await;
                            *state.write().await = STATE_CANCELLING.to_string();
                            break 'outer;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        if driver::is_interrupted(&error) {
                            if truncated {
                                // 达到展示预算后我们自己发的 KILL：这是预期结果。
                            } else if timed_out {
                                // 超时路径：保持 timed_out。
                            } else {
                                cancelled = true;
                            }
                        } else {
                            send_batch(
                                &tx,
                                DbBatch::Error {
                                    error: driver::map_error(&error, "query"),
                                },
                            )
                            .await;
                            error_seen = true;
                            if error.is_fatal() {
                                clean = false;
                            }
                        }
                        break;
                    }
                }
            }

            if !batch_rows.is_empty() {
                if !flush_batch(
                    &tx,
                    &in_flight,
                    &in_flight_bytes,
                    &result_set_id,
                    sequence,
                    std::mem::take(&mut batch_rows),
                    batch_bytes,
                )
                .await
                {
                    cancelled = true;
                    clean = false;
                    break;
                }
            }
            // 必须显式 drop：否则 `stream` 的借用会活到本轮作用域末尾，
            // 后面读 `result.affected_rows()` 会被借用检查器拒绝。
            drop(stream);
        }

        let _ = tx
            .send(DbBatch::ResultSetEnd {
                result_set_id,
                affected_rows: result.affected_rows(),
                last_insert_id: result.last_insert_id().map(|value| value.to_string()),
                warnings: result.warnings(),
                info: result.info().to_string(),
                rows: set_rows,
                bytes: set_bytes,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
            .await;

        set_index += 1;
    }

    // 取消信号可能与"服务器已结束"同时到达：结束前再看一眼标志，
    // 否则用户点了取消却看到 completed。
    if !outcome_unknown && !timed_out && *cancel_rx.borrow() {
        cancelled = true;
    }

    let final_state = if outcome_unknown {
        STATE_OUTCOME_UNKNOWN
    } else if cancelled {
        STATE_CANCELLED
    } else if timed_out {
        STATE_FAILED
    } else if error_seen {
        STATE_FAILED
    } else {
        STATE_COMPLETED
    };
    *state.write().await = final_state.to_string();

    finalize(
        &tx,
        final_state,
        started,
        rows_total,
        bytes_total,
        truncated,
        truncation_reason,
    )
    .await;

    // 取消/超时/截断/未知/协议致命错误：连接不可信，绝不能放回会话继续用。
    let keep = clean && !outcome_unknown && !timed_out && !cancelled && !truncated;
    session.release_conn(conn, keep).await;
}

async fn send_batch(tx: &mpsc::Sender<DbBatch>, batch: DbBatch) {
    // 错误与终态信息很小；用 `try_send` 避免"前端不拉取 → 任务永远挂住"。
    let _ = tx.try_send(batch);
}

#[allow(clippy::too_many_arguments)]
async fn flush_batch(
    tx: &mpsc::Sender<DbBatch>,
    in_flight: &AtomicUsize,
    in_flight_bytes: &AtomicUsize,
    result_set_id: &str,
    sequence: u64,
    rows: Vec<Vec<DbValue>>,
    bytes: usize,
) -> bool {
    if rows.is_empty() {
        return true;
    }
    in_flight.fetch_add(1, Ordering::AcqRel);
    in_flight_bytes.fetch_add(bytes, Ordering::AcqRel);
    tx.send(DbBatch::Rows {
        result_set_id: result_set_id.to_string(),
        sequence,
        rows,
        bytes,
    })
    .await
    .is_ok()
}

async fn finalize(
    tx: &mpsc::Sender<DbBatch>,
    final_state: &str,
    started: std::time::Instant,
    rows: u64,
    bytes: usize,
    truncated: bool,
    reason: Option<String>,
) {
    let _ = tx.try_send(DbBatch::Finished {
        state: final_state.to_string(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        rows,
        bytes,
        truncated,
        truncation_reason: reason,
    });
}

fn truncate_sql(sql: &str) -> String {
    let mut text = sql.trim().to_string();
    if text.chars().count() > 240 {
        text = text.chars().take(240).collect::<String>() + "…";
    }
    text
}
