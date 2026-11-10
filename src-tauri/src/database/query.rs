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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{FutureExt, TryStreamExt};
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Row};
use std::panic::AssertUnwindSafe;
use tokio::sync::{mpsc, watch, Mutex, Notify, RwLock};

use super::codec;
use super::driver;
use super::driver::postgres::{decode_cell, map_error as map_pg_error};
use super::driver::SqliteWorker;
use super::model::{
    DbBatch, DbErrorInfo, DbValue, QueryBatchResponse, ResolvedBudget, STATE_CANCELLED,
    STATE_CANCELLING, STATE_COMPLETED, STATE_FAILED, STATE_OUTCOME_UNKNOWN, STATE_QUEUED,
    STATE_RUNNING, STATE_STREAMING,
};
use super::protocol::{CancelHandle, ConnectionIdentity, TransactionState};
use super::runtime::ProfileRuntime;
use super::session::{SessionEntry, SessionKind};

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
    /// 取消令牌（由驱动产生）。取消不再假设"线程 id 一定存在"。
    /// 与下面 `cancel` 的 watch 信号区分：那个只是"通知任务收尾"。
    pub cancel_token: CancelHandle,
    pub state: Arc<RwLock<String>>,
    cancel: watch::Sender<bool>,
    /// KILL QUERY 发送失败后，任务即使自行结束也不能报告 completed。
    cancel_failed: Arc<AtomicBool>,
    pub in_flight: Arc<AtomicUsize>,
    pub in_flight_bytes: Arc<AtomicUsize>,
    pub started_at: i64,
}

pub struct QueryEntry {
    pub handle: Arc<QueryHandle>,
    pub runtime: Arc<ProfileRuntime>,
    pub session: Arc<SessionEntry>,
    /// 任务是否已经真正退出（释放连接、结束计数）。
    finished: Arc<AtomicBool>,
    done: Arc<Notify>,
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
    /// 执行这条查询的物理连接身份（展示用，不再强制是 u32 thread id）。
    pub connection: ConnectionIdentity,
}

pub struct StartQueryRequest {
    pub session: Arc<SessionEntry>,
    pub runtime: Arc<ProfileRuntime>,
    pub sql: String,
    pub budget: ResolvedBudget,
}

impl QueryRegistry {
    pub async fn start(&self, request: StartQueryRequest) -> Result<QueryStarted, DbErrorInfo> {
        // SQLite 走独立执行路径：worker 线程 + interrupt 取消，没有协议流。
        // 分派必须在解构 `request` 之前，否则所有权已经离开。
        if request.session.kind == SessionKind::Sqlite {
            return self.start_sqlite(request).await;
        }
        // PostgreSQL：simple query 文本协议。
        if request.session.kind == SessionKind::Postgres {
            return self.start_postgres(request).await;
        }

        let StartQueryRequest {
            session,
            runtime,
            sql,
            budget,
        } = request;

        // 独占连接：这条 SQL 期间，该会话不会被别的请求抢走连接。
        let conn = session.acquire_conn().await?;
        // 身份与取消令牌来自会话（建连时由驱动给出），不在这里重新推导。
        let identity = session.identity.clone();
        let cancel_handle = session.cancel.clone();

        let query_id = uuid::Uuid::new_v4().to_string();
        let generation = session.generation;
        let state = Arc::new(RwLock::new(STATE_QUEUED.to_string()));
        let (tx, rx) = mpsc::channel::<DbBatch>(2);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let in_flight = Arc::new(AtomicUsize::new(0));
        let in_flight_bytes = Arc::new(AtomicUsize::new(0));
        let cancel_failed = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let done = Arc::new(Notify::new());

        let handle = Arc::new(QueryHandle {
            query_id: query_id.clone(),
            session_id: session.session_id.clone(),
            profile_id: session.profile_id.clone(),
            generation,
            cancel_token: cancel_handle,
            state: state.clone(),
            cancel: cancel_tx,
            cancel_failed: cancel_failed.clone(),
            in_flight: in_flight.clone(),
            in_flight_bytes: in_flight_bytes.clone(),
            started_at: crate::db::AppDb::now(),
        });

        self.entries.lock().await.insert(
            query_id.clone(),
            Arc::new(QueryEntry {
                handle: handle.clone(),
                runtime: runtime.clone(),
                session: session.clone(),
                finished: finished.clone(),
                done: done.clone(),
                receiver: Mutex::new(rx),
            }),
        );

        runtime.begin_query();

        let task_runtime = runtime.clone();
        let task_session = session.clone();
        let task_query_id = query_id.clone();
        let panic_session = task_session.clone();
        let panic_tx = tx.clone();
        let panic_state = state.clone();
        let task_finished = finished.clone();
        let task_done = done.clone();
        tokio::spawn(async move {
            let outcome = AssertUnwindSafe(run_script(
                conn,
                task_runtime.clone(),
                task_session,
                task_query_id,
                sql,
                budget,
                tx,
                state,
                cancel_rx,
                cancel_failed,
                in_flight,
                in_flight_bytes,
            ))
            .catch_unwind()
            .await;
            if outcome.is_err() {
                // 任务 panic 时连接已经被 unwind 丢弃；把会话标记为 lost，
                // 否则 conn=None + busy 会让后续查询永久拒绝执行。
                panic_session.mark_lost().await;
                *panic_state.write().await = STATE_FAILED.to_string();
                let _ = panic_tx.try_send(DbBatch::Error {
                    error: DbErrorInfo::new(
                        "query",
                        "查询任务异常终止，会话连接已丢弃，请重新连接",
                    ),
                });
                let _ = panic_tx.try_send(DbBatch::Finished {
                    state: STATE_FAILED.to_string(),
                    elapsed_ms: 0,
                    rows: 0,
                    bytes: 0,
                    truncated: false,
                    truncation_reason: None,
                });
            }
            task_runtime.end_query();
            task_finished.store(true, Ordering::Release);
            // notify_one 会保存一个 permit，release 在检查 finished 与
            // 创建 notified() 之间发生的完成通知不会丢失。
            task_done.notify_one();
        });

        Ok(QueryStarted {
            query_id,
            state: STATE_QUEUED.to_string(),
            generation,
            connection: identity,
        })
    }

    /// PostgreSQL 查询：`simple_query` 一次读完，按 `CommandComplete` 分组发送。
    ///
    /// **没有流式背压**：文本协议一次返回整个结果集，预算只能在发送阶段截断。
    async fn start_postgres(
        &self,
        request: StartQueryRequest,
    ) -> Result<QueryStarted, DbErrorInfo> {
        let StartQueryRequest {
            session,
            runtime,
            sql,
            budget,
        } = request;
        let conn = session.acquire_postgres().await?;
        let identity = session.identity.clone();
        let cancel_handle = session.cancel.clone();

        let query_id = uuid::Uuid::new_v4().to_string();
        let generation = session.generation;
        let state = Arc::new(RwLock::new(STATE_QUEUED.to_string()));
        let (tx, rx) = mpsc::channel::<DbBatch>(2);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let in_flight = Arc::new(AtomicUsize::new(0));
        let in_flight_bytes = Arc::new(AtomicUsize::new(0));
        let cancel_failed = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let done = Arc::new(Notify::new());

        let handle = Arc::new(QueryHandle {
            query_id: query_id.clone(),
            session_id: session.session_id.clone(),
            profile_id: session.profile_id.clone(),
            generation,
            cancel_token: cancel_handle,
            state: state.clone(),
            cancel: cancel_tx,
            cancel_failed: cancel_failed.clone(),
            in_flight: in_flight.clone(),
            in_flight_bytes: in_flight_bytes.clone(),
            started_at: crate::db::AppDb::now(),
        });

        self.entries.lock().await.insert(
            query_id.clone(),
            Arc::new(QueryEntry {
                handle: handle.clone(),
                runtime: runtime.clone(),
                session: session.clone(),
                finished: finished.clone(),
                done: done.clone(),
                receiver: Mutex::new(rx),
            }),
        );

        runtime.begin_query();

        let task_runtime = runtime.clone();
        let task_session = session.clone();
        let task_query_id = query_id.clone();
        let panic_session = task_session.clone();
        let panic_tx = tx.clone();
        let panic_state = state.clone();
        let task_finished = finished.clone();
        let task_done = done.clone();
        tokio::spawn(async move {
            let outcome = AssertUnwindSafe(async {
                let started = std::time::Instant::now();
                *state.write().await = STATE_RUNNING.to_string();

                let mut rows_total = 0u64;
                let mut bytes_total = 0usize;
                let mut truncated = false;
                let mut cancelled = false;
                let mut error_seen = false;

                // 流式读取：`prepare` 拿到 `RowDescription`，零行也有列；
                // 多语句按方言拆开逐条执行（`prepare` 不支持多语句）。
                let mut cancel_rx = cancel_rx;
                let idle_timeout = std::time::Duration::from_millis(
                    task_runtime.endpoint.profile.query_timeout_ms.max(5_000),
                );
                let mut statements = match task_runtime.adapter() {
                    Ok(adapter) => adapter.dialect().split_statements(&sql),
                    Err(_) => Vec::new(),
                };
                if statements.is_empty() {
                    statements.push(sql.clone());
                }

                let mut set_index = 0u32;
                for statement in &statements {
                    if cancelled || error_seen {
                        break;
                    }
                    if *cancel_rx.borrow() {
                        cancelled = true;
                        let _ = conn.cancel().await;
                        break;
                    }
                    let (columns, stream) = match conn.query_stream(statement).await {
                        Ok(opened) => opened,
                        Err(error) => {
                            if error.stage == "cancelled" {
                                cancelled = true;
                            } else {
                                let _ = tx.try_send(DbBatch::Error { error });
                                error_seen = true;
                            }
                            break;
                        }
                    };
                    let result_set_id = format!("{task_query_id}:{set_index}");
                    if tx
                        .send(DbBatch::ResultSet {
                            result_set_id: result_set_id.clone(),
                            index: set_index,
                            columns,
                            statement: truncate_sql(statement),
                        })
                        .await
                        .is_err()
                    {
                        cancelled = true;
                        break;
                    }
                    let mut stream = Box::pin(stream);

                    let mut sequence = 0u64;
                    let mut pending: Vec<Vec<DbValue>> = Vec::new();
                    let mut pending_bytes = 0usize;

                    while !cancelled {
                        if *cancel_rx.borrow() {
                            cancelled = true;
                            let _ = conn.cancel().await;
                            break;
                        }
                        let next = tokio::select! {
                            changed = cancel_rx.changed() => {
                                if changed.is_err() || *cancel_rx.borrow() {
                                    cancelled = true;
                                    let _ = conn.cancel().await;
                                    break;
                                }
                                continue;
                            }
                            result = tokio::time::timeout(idle_timeout, stream.try_next()) => result,
                        };
                        let row = match next {
                            Ok(Ok(Some(row))) => row,
                            Ok(Ok(None)) => break,
                            Ok(Err(error)) => {
                                let mapped = map_pg_error(&error, "query");
                                if mapped.stage == "cancelled" || *cancel_rx.borrow() {
                                    cancelled = true;
                                } else {
                                    let _ = tx.try_send(DbBatch::Error { error: mapped });
                                    error_seen = true;
                                }
                                break;
                            }
                            Err(_) => {
                                let _ = conn.cancel().await;
                                let _ = tx.try_send(DbBatch::Error {
                                    error: DbErrorInfo::new(
                                        "timeout",
                                        "读取超时：服务器长时间没有返回下一行",
                                    ),
                                });
                                error_seen = true;
                                break;
                            }
                        };

                        // 超过展示预算后继续把结果集读干净（丢弃），否则连接不能复用。
                        if truncated {
                            continue;
                        }
                        let values: Vec<DbValue> = (0..row.columns().len())
                            .map(|index| {
                                decode_cell(&row, index, budget.field_preview_bytes)
                            })
                            .collect();
                        let row_bytes: usize = values.iter().map(approximate_bytes).sum();

                        // 行/字节预算：到顶后只是**不再保留**，仍然继续读到底，
                        // 让连接回到可以发下一条命令的状态（不 KILL、不断连）。
                        if rows_total + pending.len() as u64 >= budget.max_rows
                            || (bytes_total + pending_bytes + row_bytes) as u64
                                > budget.max_bytes
                        {
                            truncated = true;
                            continue;
                        }

                        pending_bytes += row_bytes;
                        pending.push(values);

                        if pending.len() >= budget.batch_rows.max(1) {
                            let batch = std::mem::take(&mut pending);
                            let bytes = pending_bytes;
                            pending_bytes = 0;
                            in_flight.fetch_add(1, Ordering::AcqRel);
                            in_flight_bytes.fetch_add(bytes, Ordering::AcqRel);
                            let len = batch.len() as u64;
                            if tx
                                .send(DbBatch::Rows {
                                    result_set_id: result_set_id.clone(),
                                    sequence,
                                    rows: batch,
                                    bytes,
                                })
                                .await
                                .is_err()
                            {
                                cancelled = true;
                                break;
                            }
                            sequence += 1;
                            rows_total += len;
                            bytes_total += bytes;
                        }
                    }

                    if !cancelled && !pending.is_empty() {
                        let bytes = pending_bytes;
                        in_flight.fetch_add(1, Ordering::AcqRel);
                        in_flight_bytes.fetch_add(bytes, Ordering::AcqRel);
                        let len = pending.len() as u64;
                        if tx
                            .send(DbBatch::Rows {
                                result_set_id: result_set_id.clone(),
                                sequence,
                                rows: std::mem::take(&mut pending),
                                bytes,
                            })
                            .await
                            .is_ok()
                        {
                            rows_total += len;
                            bytes_total += bytes;
                        } else {
                            cancelled = true;
                        }
                    }

                    if !cancelled
                        && tx
                            .send(DbBatch::ResultSetEnd {
                                result_set_id,
                                affected_rows: 0,
                                last_insert_id: None,
                                warnings: 0,
                                info: String::new(),
                                rows: rows_total,
                                bytes: bytes_total,
                                elapsed_ms: started.elapsed().as_millis() as u64,
                            })
                            .await
                            .is_err()
                    {
                        cancelled = true;
                    }
                    set_index += 1;
                }

                if !truncated && *cancel_rx.borrow() {
                    cancelled = true;
                }
                let final_state = if cancel_failed.load(Ordering::Acquire) {
                    STATE_OUTCOME_UNKNOWN
                } else if cancelled {
                    STATE_CANCELLED
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
                    truncated.then(|| {
                        format!(
                            "已显示前 {} 行，其余结果已跳过（连接保持可用）",
                            budget.max_rows
                        )
                    }),
                )
                .await;

                let transaction = if cancelled || error_seen {
                    TransactionState::Unknown
                } else {
                    conn.transaction_state().await
                };
                task_session
                    .release_postgres(conn, !cancelled && !error_seen, transaction)
                    .await;
            })
            .catch_unwind()
            .await;

            if outcome.is_err() {
                panic_session.mark_lost().await;
                *panic_state.write().await = STATE_FAILED.to_string();
                let _ = panic_tx.try_send(DbBatch::Error {
                    error: DbErrorInfo::new(
                        "query",
                        "PostgreSQL 查询任务异常终止，会话已丢失，请重新连接",
                    ),
                });
                let _ = panic_tx.try_send(DbBatch::Finished {
                    state: STATE_FAILED.to_string(),
                    elapsed_ms: 0,
                    rows: 0,
                    bytes: 0,
                    truncated: false,
                    truncation_reason: None,
                });
            }
            task_runtime.end_query();
            task_finished.store(true, Ordering::Release);
            task_done.notify_one();
        });

        Ok(QueryStarted {
            query_id,
            state: STATE_QUEUED.to_string(),
            generation,
            connection: identity,
        })
    }

    /// SQLite 查询：worker 一次执行一条语句，结果按预算分批发送。
    ///
    /// 没有协议流，所以**没有**"前端不拉取就阻塞服务器"的背压：本地查询已在
    /// worker 内按预算截断，这里只是把内存里的行分批交给前端。
    async fn start_sqlite(&self, request: StartQueryRequest) -> Result<QueryStarted, DbErrorInfo> {
        let StartQueryRequest {
            session,
            runtime,
            sql,
            budget,
        } = request;
        let worker = session.acquire_sqlite().await?;
        let identity = session.identity.clone();
        let cancel_handle = session.cancel.clone();

        let query_id = uuid::Uuid::new_v4().to_string();
        let generation = session.generation;
        let state = Arc::new(RwLock::new(STATE_QUEUED.to_string()));
        let (tx, rx) = mpsc::channel::<DbBatch>(2);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let in_flight = Arc::new(AtomicUsize::new(0));
        let in_flight_bytes = Arc::new(AtomicUsize::new(0));
        let cancel_failed = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let done = Arc::new(Notify::new());

        let handle = Arc::new(QueryHandle {
            query_id: query_id.clone(),
            session_id: session.session_id.clone(),
            profile_id: session.profile_id.clone(),
            generation,
            cancel_token: cancel_handle,
            state: state.clone(),
            cancel: cancel_tx,
            cancel_failed: cancel_failed.clone(),
            in_flight: in_flight.clone(),
            in_flight_bytes: in_flight_bytes.clone(),
            started_at: crate::db::AppDb::now(),
        });

        self.entries.lock().await.insert(
            query_id.clone(),
            Arc::new(QueryEntry {
                handle: handle.clone(),
                runtime: runtime.clone(),
                session: session.clone(),
                finished: finished.clone(),
                done: done.clone(),
                receiver: Mutex::new(rx),
            }),
        );

        runtime.begin_query();

        let task_runtime = runtime.clone();
        let task_session = session.clone();
        let task_query_id = query_id.clone();
        let panic_session = task_session.clone();
        let panic_tx = tx.clone();
        let panic_state = state.clone();
        let task_finished = finished.clone();
        let task_done = done.clone();
        tokio::spawn(async move {
            let outcome = AssertUnwindSafe(run_sqlite_script(
                worker,
                task_runtime.clone(),
                task_session,
                task_query_id,
                sql,
                budget,
                tx,
                state,
                cancel_rx,
                cancel_failed,
                in_flight,
                in_flight_bytes,
            ))
            .catch_unwind()
            .await;
            if outcome.is_err() {
                panic_session.mark_lost().await;
                *panic_state.write().await = STATE_FAILED.to_string();
                let _ = panic_tx.try_send(DbBatch::Error {
                    error: DbErrorInfo::new(
                        "query",
                        "SQLite 查询任务异常终止，会话已丢失，请重新连接",
                    ),
                });
                let _ = panic_tx.try_send(DbBatch::Finished {
                    state: STATE_FAILED.to_string(),
                    elapsed_ms: 0,
                    rows: 0,
                    bytes: 0,
                    truncated: false,
                    truncation_reason: None,
                });
            }
            task_runtime.end_query();
            task_finished.store(true, Ordering::Release);
            task_done.notify_one();
        });

        Ok(QueryStarted {
            query_id,
            state: STATE_QUEUED.to_string(),
            generation,
            connection: identity,
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

        {
            // 状态迁移和终态判断必须同一把写锁：否则任务可能在 read 之后
            // 写入 completed，取消流程再把终态覆盖成 cancelling。
            let mut state = entry.handle.state.write().await;
            if is_terminal(&state) || entry.finished.load(Ordering::Acquire) {
                return Ok(state.clone());
            }
            *state = STATE_CANCELLING.to_string();
        }

        // **先**通知任务"用户要取消"，**再**发 KILL。
        // 反过来的话，KILL 往往先让服务器结束语句，任务在看到 cancel 信号前
        // 就已经收尾，终态会变成 completed/failed —— 用户会以为取消没生效。
        let _ = entry.handle.cancel.send(true);

        match entry.runtime.cancel(&entry.handle.cancel_token).await {
            Ok(()) => Ok(STATE_CANCELLING.to_string()),
            Err(error) => {
                // KILL 失败时任务可能已经自然完成；只在仍处于 cancelling
                // 时覆盖终态，避免把真实 completed 改写成 unknown。
                let mut state = entry.handle.state.write().await;
                if *state == STATE_CANCELLING {
                    entry.handle.cancel_failed.store(true, Ordering::Release);
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
            let _ = entry.runtime.cancel(&entry.handle.cancel_token).await;

            // 不能只把任务从注册表移除就假定资源已经释放：等任务真正退出；
            // 超时说明物理连接仍被占用，标记会话失效，绝不复用状态未知的连接。
            if !entry.finished.load(Ordering::Acquire) {
                let notified = entry.done.notified();
                if tokio::time::timeout(Duration::from_secs(2), notified)
                    .await
                    .is_err()
                    && !entry.finished.load(Ordering::Acquire)
                {
                    entry.session.mark_lost().await;
                }
            }
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

/// 执行一段 SQLite 脚本：逐条语句执行，结果按预算分批发送。
#[allow(clippy::too_many_arguments)]
async fn run_sqlite_script(
    worker: Arc<SqliteWorker>,
    runtime: Arc<ProfileRuntime>,
    session: Arc<SessionEntry>,
    query_id: String,
    sql: String,
    budget: ResolvedBudget,
    tx: mpsc::Sender<DbBatch>,
    state: Arc<RwLock<String>>,
    cancel_rx: watch::Receiver<bool>,
    cancel_failed: Arc<AtomicBool>,
    in_flight: Arc<AtomicUsize>,
    in_flight_bytes: Arc<AtomicUsize>,
) {
    let started = std::time::Instant::now();
    *state.write().await = STATE_RUNNING.to_string();

    // SQLite 的 prepare 只编译第一条语句，静默忽略其余会误导用户：
    // 按方言拆开逐条执行，每条一个结果集。
    let statements = match runtime.adapter() {
        Ok(adapter) => adapter.dialect().split_statements(&sql),
        Err(_) => vec![sql.clone()],
    };
    let statements = if statements.is_empty() {
        vec![sql.clone()]
    } else {
        statements
    };

    let mut clean = true;
    let mut rows_total = 0u64;
    let mut bytes_total = 0usize;
    let mut truncated = false;
    let mut truncation_reason: Option<String> = None;
    let mut cancelled = false;
    let mut error_seen = false;
    let mut transaction = TransactionState::None;

    for (set_index, statement) in statements.iter().enumerate() {
        if *cancel_rx.borrow() {
            cancelled = true;
            clean = false;
            break;
        }

        let remaining_rows = budget.max_rows.saturating_sub(rows_total).max(1);
        let remaining_bytes = budget
            .max_bytes
            .saturating_sub(bytes_total as u64)
            .max(1024) as usize;
        let answer = match worker
            .query(statement, remaining_rows, remaining_bytes)
            .await
        {
            Ok(answer) => answer,
            Err(error) => {
                if error.stage == "cancelled" {
                    cancelled = true;
                } else {
                    let _ = tx.try_send(DbBatch::Error { error });
                    error_seen = true;
                }
                clean = false;
                break;
            }
        };
        transaction = if answer.in_transaction {
            TransactionState::InTransaction
        } else {
            TransactionState::None
        };

        let result_set_id = format!("{query_id}:{set_index}");
        if tx
            .send(DbBatch::ResultSet {
                result_set_id: result_set_id.clone(),
                index: set_index as u32,
                columns: answer.columns.clone(),
                statement: truncate_sql(statement),
            })
            .await
            .is_err()
        {
            cancelled = true;
            clean = false;
            break;
        }

        let set_rows = answer.rows.len() as u64;
        let mut set_bytes = 0usize;
        let batch_rows = budget.batch_rows.max(1);
        let mut aborted = false;
        for (sequence, chunk) in answer.rows.chunks(batch_rows).enumerate() {
            let bytes: usize = chunk.iter().flatten().map(approximate_bytes).sum();
            in_flight.fetch_add(1, Ordering::AcqRel);
            in_flight_bytes.fetch_add(bytes, Ordering::AcqRel);
            if tx
                .send(DbBatch::Rows {
                    result_set_id: result_set_id.clone(),
                    sequence: sequence as u64,
                    rows: chunk.to_vec(),
                    bytes,
                })
                .await
                .is_err()
            {
                cancelled = true;
                clean = false;
                aborted = true;
                break;
            }
            bytes_total += bytes;
            set_bytes += bytes;
        }
        if aborted {
            break;
        }
        rows_total += set_rows;

        if tx
            .send(DbBatch::ResultSetEnd {
                result_set_id,
                affected_rows: answer.affected_rows.max(0) as u64,
                last_insert_id: None,
                warnings: 0,
                info: String::new(),
                rows: set_rows,
                bytes: set_bytes,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
            .await
            .is_err()
        {
            cancelled = true;
            clean = false;
            break;
        }

        if answer.truncated {
            truncated = true;
            truncation_reason = Some(if remaining_rows <= set_rows {
                format!("已达展示行数上限（{} 行）", budget.max_rows)
            } else {
                format!(
                    "已达展示字节预算（{} MiB）",
                    budget.max_bytes / (1024 * 1024)
                )
            });
            break;
        }
    }

    if !truncated && *cancel_rx.borrow() {
        cancelled = true;
    }

    let final_state = if cancel_failed.load(Ordering::Acquire) {
        STATE_OUTCOME_UNKNOWN
    } else if cancelled {
        STATE_CANCELLED
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

    // 被中断的语句可能在事务里，连接状态不再可信：丢弃会话（与 MySQL 同策略）。
    let keep = clean && !cancelled && transaction == TransactionState::None;
    session.release_sqlite(worker, keep, transaction).await;
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
    cancel_failed: Arc<AtomicBool>,
    in_flight: Arc<AtomicUsize>,
    in_flight_bytes: Arc<AtomicUsize>,
) {
    let started = std::time::Instant::now();
    let timeout = Duration::from_millis(runtime.endpoint.profile.query_timeout_ms);
    let deadline = tokio::time::Instant::now() + timeout;
    let cancel_handle = session.cancel.clone();

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
    //
    // **总超时必须包住"首个响应"**：服务器执行慢时 `query_iter` 自己会一直
    // 等着，之前只在后面的流循环里检查 deadline，用户会看到"查询永不超时"。
    let mut result = match tokio::time::timeout(timeout, conn.query_iter(&sql)).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
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
        Err(_) => {
            // 首个响应前超时：连接上的协议状态不可信 → 丢弃，绝不归还池。
            *state.write().await = STATE_CANCELLING.to_string();
            let killed = runtime.cancel(&cancel_handle).await.is_ok();
            *state.write().await = STATE_OUTCOME_UNKNOWN.to_string();
            let reason = if killed {
                "首个响应超时：已发送 KILL QUERY，连接已丢弃（事务/临时表状态未知）".to_string()
            } else {
                "首个响应超时：取消请求失败，服务器可能仍在执行".to_string()
            };
            send_batch(
                &tx,
                DbBatch::Error {
                    error: DbErrorInfo::new(
                        "timeout",
                        format!(
                            "查询在 {} ms 内没有收到首个响应；{}",
                            timeout.as_millis(),
                            reason
                        ),
                    )
                    .retryable(true),
                },
            )
            .await;
            finalize(
                &tx,
                STATE_OUTCOME_UNKNOWN,
                started,
                0,
                0,
                false,
                Some(reason),
            )
            .await;
            session.release_conn(conn, false).await;
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
                    if runtime.cancel(&cancel_handle).await.is_err() {
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
                        // 超过展示预算后继续把结果集读干净：只丢弃、不解码、不保留。
                        // 这是"连接不断"的代价 —— 网络照读，内存不变。
                        if truncated {
                            continue;
                        }
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
                                &mut cancel_rx,
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
                                format!(
                                    "已显示前 {} 行，其余结果已跳过（连接保持可用）",
                                    budget.max_rows
                                )
                            } else {
                                format!(
                                    "已显示前 {} MiB，其余结果已跳过（连接保持可用）",
                                    budget.max_bytes / (1024 * 1024)
                                )
                            });
                            // **不要 KILL**：MySQL 的连接必须把结果集读干净才能复用，
                            // 中途停下只能丢弃连接（用户会看到"会话连接已关闭"）。
                            // 这里继续消费剩余行但不再保留 —— 内存不变，连接干净归还。
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
                    &mut cancel_rx,
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

        let end_sent = tokio::select! {
            changed = cancel_rx.changed() => {
                let _ = changed;
                false
            }
            result = tx.send(DbBatch::ResultSetEnd {
                result_set_id,
                affected_rows: result.affected_rows(),
                last_insert_id: result.last_insert_id().map(|value| value.to_string()),
                warnings: result.warnings(),
                info: result.info().to_string(),
                rows: set_rows,
                bytes: set_bytes,
                elapsed_ms: started.elapsed().as_millis() as u64,
            }) => result.is_ok(),
        };
        if !end_sent {
            cancelled = true;
            clean = false;
            break;
        }

        set_index += 1;
    }

    // 取消信号可能与"服务器已结束"同时到达：结束前再看一眼标志，
    // 否则用户点了取消却看到 completed。
    if !outcome_unknown && !timed_out && *cancel_rx.borrow() {
        cancelled = true;
    }

    let final_state = if outcome_unknown || cancel_failed.load(Ordering::Acquire) {
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
    let keep = clean
        && !outcome_unknown
        && !timed_out
        && !cancelled
        && !truncated
        && !cancel_failed.load(Ordering::Acquire);
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
    cancel_rx: &mut watch::Receiver<bool>,
) -> bool {
    if rows.is_empty() {
        return true;
    }
    // 前端停止拉取时第三批会阻塞在 send；取消信号必须能把它叫醒。
    if *cancel_rx.borrow() {
        return false;
    }
    in_flight.fetch_add(1, Ordering::AcqRel);
    in_flight_bytes.fetch_add(bytes, Ordering::AcqRel);
    let sent = tokio::select! {
        changed = cancel_rx.changed() => {
            let _ = changed;
            false
        }
        result = tx.send(DbBatch::Rows {
            result_set_id: result_set_id.to_string(),
            sequence,
            rows,
            bytes,
        }) => result.is_ok(),
    };
    if !sent {
        in_flight.fetch_sub(1, Ordering::AcqRel);
        in_flight_bytes.fetch_sub(bytes, Ordering::AcqRel);
    }
    sent
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
    let batch = DbBatch::Finished {
        state: final_state.to_string(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        rows,
        bytes,
        truncated,
        truncation_reason: reason,
    };
    // 缓冲区只有 2 格（见模块注释）。`try_send` 一旦遇到"缓冲满"就会把终态
    // **直接丢掉**：前端收到的最后一条是 Rows/Error，永远等不到 `Finished`，
    // 界面上表现为一直停在"取消中"。MariaDB 上取消一条正在执行的语句就能稳定
    // 复现（ResultSet + Error 占满两格，Finished 是第三条）。
    //
    // 所以这里退化成**有上限**的 `send`：前端还在读就等它排空；消费者已经离开
    //（`release` 掉接收端）就立刻放弃，绝不让任务卡在这里。
    if let Err(mpsc::error::TrySendError::Full(batch)) = tx.try_send(batch) {
        const FINAL_BATCH_WAIT: Duration = Duration::from_secs(2);
        let _ = tokio::time::timeout(FINAL_BATCH_WAIT, tx.send(batch)).await;
    }
}

fn truncate_sql(sql: &str) -> String {
    let mut text = sql.trim().to_string();
    if text.chars().count() > 240 {
        text = text.chars().take(240).collect::<String>() + "…";
    }
    text
}
