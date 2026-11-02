//! 逻辑会话：一个 SQL 编辑器标签页 = 一条**固定**的物理连接。
//!
//! 为什么必须固定：`USE db`、`SET @x := 1`、临时表、打开的事务都挂在
//! 某一条物理连接上。每次从池里随机取一条，用户会看到"上一秒还在的事务
//! 下一秒不见了"，这是不可接受的错误行为。
//!
//! 状态机：`ready → busy → ready`；任何协议层错误或取消未确认 →
//! `lost`（连接被丢弃，绝不假装事务/临时表还活着）。
//! 会话丢失后**不会**自动重连：用户必须显式重连，且界面会说明
//! "原事务/临时表已丢失"。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use mysql_async::Conn;
use tokio::sync::Mutex;

use super::driver::{self, SqliteWorker};
use super::model::{DbErrorInfo, DbSessionInfo};
use super::protocol::{CancelHandle, ConnectionIdentity, TransactionState};

pub const SESSION_READY: &str = "ready";
pub const SESSION_BUSY: &str = "busy";
pub const SESSION_CANCELLING: &str = "cancelling";
pub const SESSION_LOST: &str = "lost";

/// 会话背后的驱动类型。上层据此分派执行路径，而不是猜引擎名。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    MySql,
    Sqlite,
}

enum SessionConn {
    MySql(Conn),
    Sqlite(Arc<SqliteWorker>),
}

struct SessionInner {
    conn: Option<SessionConn>,
    state: String,
    current_database: Option<String>,
    transaction: TransactionState,
}

pub struct SessionEntry {
    pub session_id: String,
    pub profile_id: String,
    pub generation: u64,
    /// 会话背后的驱动。`acquire_conn()` 只对 MySQL 有效。
    pub kind: SessionKind,
    /// 物理连接身份（展示用），不再强制是 MySQL thread id。
    pub identity: ConnectionIdentity,
    /// 取消令牌：由驱动产生，上层只负责原样交回 `runtime.cancel`。
    pub cancel: CancelHandle,
    pub server_version: Option<String>,
    pub tls_active: bool,
    pub tls_cipher: Option<String>,
    pub tls_version: Option<String>,
    pub read_only: bool,
    /// 只读是否由**服务器**保证。产品没有只读事务（Doris/StarRocks）时
    /// 这里是 `false`：界面必须说明"仅客户端拦截"，查询入口要拦写语句。
    pub read_only_enforced: bool,
    pub opened_at: i64,
    pub last_used: Mutex<Instant>,
    inner: Mutex<SessionInner>,
}

impl SessionEntry {
    pub fn new(
        session_id: String,
        profile_id: String,
        generation: u64,
        conn: Conn,
        server_version: Option<String>,
        tls: super::model::TlsStatus,
        read_only: bool,
        read_only_enforced: bool,
    ) -> Self {
        let identity = driver::connection_identity(&conn);
        let cancel = CancelHandle::mysql(conn.id());
        let transaction = driver::transaction_state(&conn);
        Self {
            session_id,
            profile_id,
            generation,
            kind: SessionKind::MySql,
            identity,
            cancel,
            server_version,
            tls_active: tls.active,
            tls_cipher: tls.cipher,
            tls_version: tls.version,
            read_only,
            read_only_enforced,
            opened_at: crate::db::AppDb::now(),
            last_used: Mutex::new(Instant::now()),
            inner: Mutex::new(SessionInner {
                conn: Some(SessionConn::MySql(conn)),
                state: SESSION_READY.to_string(),
                current_database: None,
                transaction,
            }),
        }
    }

    /// SQLite 会话：连接跑在驱动的专用线程上，身份是文件路径。
    pub fn new_sqlite(
        session_id: String,
        profile_id: String,
        generation: u64,
        worker: Arc<SqliteWorker>,
        read_only: bool,
    ) -> Self {
        let identity = ConnectionIdentity::named(format!("file:{}", worker.path().display()));
        Self {
            session_id,
            profile_id,
            generation,
            kind: SessionKind::Sqlite,
            identity,
            // SQLite 的取消由 runtime 上的 interrupt handle 完成，令牌表示"支持"。
            cancel: CancelHandle::Sqlite,
            server_version: Some(format!("SQLite {}", worker.version())),
            tls_active: false,
            tls_cipher: None,
            tls_version: None,
            read_only,
            // 只读连接用 SQLITE_OPEN_READ_ONLY 打开，写由 SQLite 自己拒绝。
            read_only_enforced: read_only,
            opened_at: crate::db::AppDb::now(),
            last_used: Mutex::new(Instant::now()),
            inner: Mutex::new(SessionInner {
                conn: Some(SessionConn::Sqlite(worker)),
                state: SESSION_READY.to_string(),
                current_database: None,
                transaction: TransactionState::None,
            }),
        }
    }

    pub async fn info(&self) -> DbSessionInfo {
        let inner = self.inner.lock().await;
        DbSessionInfo {
            session_id: self.session_id.clone(),
            profile_id: self.profile_id.clone(),
            generation: self.generation,
            connection: self.identity.clone(),
            server_version: self.server_version.clone(),
            current_database: inner.current_database.clone(),
            tls_active: self.tls_active,
            tls_cipher: self.tls_cipher.clone(),
            tls_version: self.tls_version.clone(),
            transaction: inner.transaction,
            read_only: self.read_only,
            opened_at: self.opened_at,
        }
    }

    pub async fn state(&self) -> String {
        self.inner.lock().await.state.clone()
    }

    pub async fn set_current_database(&self, database: Option<String>) {
        self.inner.lock().await.current_database = database;
    }

    pub async fn set_cancelling(&self) {
        let mut inner = self.inner.lock().await;
        if inner.state == SESSION_BUSY {
            inner.state = SESSION_CANCELLING.to_string();
        }
    }

    /// 取走独占的 MySQL 连接。非 MySQL 会话（SQLite）明确拒绝。
    pub async fn acquire_conn(&self) -> Result<Conn, DbErrorInfo> {
        let mut inner = self.inner.lock().await;
        match inner.state.as_str() {
            SESSION_LOST => Err(DbErrorInfo::new(
                "outcome_unknown",
                "会话连接已失效：原事务与临时表状态未知，请重新连接",
            )),
            SESSION_BUSY | SESSION_CANCELLING => Err(DbErrorInfo::new(
                "query",
                "该会话正在执行另一条语句：请等待完成或先取消",
            )),
            _ => match inner.conn.take() {
                Some(SessionConn::MySql(conn)) => {
                    inner.state = SESSION_BUSY.to_string();
                    Ok(conn)
                }
                Some(SessionConn::Sqlite(worker)) => {
                    // 放回去，不能因为一次不支持的调用就丢掉会话连接。
                    inner.conn = Some(SessionConn::Sqlite(worker));
                    Err(DbErrorInfo::new(
                        "unsupported",
                        "SQLite 会话不支持该操作：结构浏览/表编辑尚未接入，SQL 执行可用",
                    ))
                }
                None => Err(DbErrorInfo::new("query", "会话连接不可用")),
            },
        }
    }

    /// 取走 SQLite 连接（工作线程句柄）。
    pub async fn acquire_sqlite(&self) -> Result<Arc<SqliteWorker>, DbErrorInfo> {
        let mut inner = self.inner.lock().await;
        match inner.state.as_str() {
            SESSION_LOST => {
                return Err(DbErrorInfo::new(
                    "outcome_unknown",
                    "会话连接已失效：请重新连接",
                ))
            }
            SESSION_BUSY | SESSION_CANCELLING => {
                return Err(DbErrorInfo::new(
                    "query",
                    "该会话正在执行另一条语句：请等待完成或先取消",
                ))
            }
            _ => {}
        }
        match inner.conn.take() {
            Some(SessionConn::Sqlite(worker)) => {
                inner.state = SESSION_BUSY.to_string();
                Ok(worker)
            }
            Some(SessionConn::MySql(conn)) => {
                inner.conn = Some(SessionConn::MySql(conn));
                Err(DbErrorInfo::new("unsupported", "该会话不是 SQLite 连接"))
            }
            None => Err(DbErrorInfo::new("query", "会话连接不可用")),
        }
    }

    /// 归还连接。`clean = false` 表示协议状态不可信 → 丢弃。
    pub async fn release_conn(&self, conn: Conn, clean: bool) {
        if !clean {
            let mut inner = self.inner.lock().await;
            inner.state = SESSION_LOST.to_string();
            inner.conn = None;
            inner.transaction = TransactionState::Unknown;
            drop(inner);
            // 关闭 socket：服务器会终止这条连接上的查询。
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(2), conn.disconnect()).await;
            return;
        }

        let transaction = driver::transaction_state(&conn);
        let mut inner = self.inner.lock().await;
        // 查询被强制标记 lost 后，后台任务即使晚到也不能把连接放回会话复用。
        if inner.state == SESSION_LOST {
            drop(inner);
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(2), conn.disconnect()).await;
            return;
        }
        inner.transaction = transaction;
        inner.state = SESSION_READY.to_string();
        inner.conn = Some(SessionConn::MySql(conn));
    }

    /// 归还 SQLite 连接。`clean = false` 表示语句被中断/结果不可信 → 丢弃会话。
    pub async fn release_sqlite(
        &self,
        worker: Arc<SqliteWorker>,
        clean: bool,
        transaction: TransactionState,
    ) {
        let mut inner = self.inner.lock().await;
        if !clean {
            inner.state = SESSION_LOST.to_string();
            inner.conn = None;
            inner.transaction = TransactionState::Unknown;
            drop(inner);
            worker.close().await;
            return;
        }
        if inner.state == SESSION_LOST {
            drop(inner);
            worker.close().await;
            return;
        }
        inner.transaction = transaction;
        inner.state = SESSION_READY.to_string();
        inner.conn = Some(SessionConn::Sqlite(worker));
    }

    /// 查询任务异常终止（panic/不可恢复错误）时把会话标记为失效，
    /// 避免 `conn=None + state=busy` 让后续语句永久拒绝执行。
    pub async fn mark_lost(&self) {
        let mut inner = self.inner.lock().await;
        inner.state = SESSION_LOST.to_string();
        inner.conn = None;
        inner.transaction = TransactionState::Unknown;
    }

    /// 主动关闭（标签页关闭时）：移除连接并尽力发送 COM_QUIT。
    pub async fn close(&self) {
        let conn = {
            let mut inner = self.inner.lock().await;
            inner.state = SESSION_LOST.to_string();
            inner.conn.take()
        };
        if let Some(conn) = conn {
            match conn {
                SessionConn::MySql(conn) => {
                    let _ =
                        tokio::time::timeout(std::time::Duration::from_secs(2), conn.disconnect())
                            .await;
                }
                SessionConn::Sqlite(worker) => worker.close().await,
            }
        }
    }

    /// 只读查询显示用：当前是否还有未提交事务（服务器 OK 包为准）。
    pub async fn transaction(&self) -> TransactionState {
        self.inner.lock().await.transaction
    }
}

#[derive(Clone, Default)]
pub struct SessionRegistry {
    entries: Arc<Mutex<HashMap<String, Arc<SessionEntry>>>>,
}

impl SessionRegistry {
    pub async fn insert(&self, entry: Arc<SessionEntry>) {
        self.entries
            .lock()
            .await
            .insert(entry.session_id.clone(), entry);
    }

    pub async fn get(&self, session_id: &str) -> Option<Arc<SessionEntry>> {
        self.entries.lock().await.get(session_id).cloned()
    }

    pub async fn remove(&self, session_id: &str) -> Option<Arc<SessionEntry>> {
        self.entries.lock().await.remove(session_id)
    }

    /// 只移除仍然指向 `entry` 的会话，避免晚到的创建流程删掉新会话。
    pub async fn remove_if_same(&self, entry: &Arc<SessionEntry>) -> Option<Arc<SessionEntry>> {
        let mut entries = self.entries.lock().await;
        if entries
            .get(&entry.session_id)
            .is_some_and(|current| Arc::ptr_eq(current, entry))
        {
            entries.remove(&entry.session_id)
        } else {
            None
        }
    }

    pub async fn for_profile(&self, profile_id: &str) -> Vec<Arc<SessionEntry>> {
        self.entries
            .lock()
            .await
            .values()
            .filter(|entry| entry.profile_id == profile_id)
            .cloned()
            .collect()
    }

    pub async fn count_for_profile(&self, profile_id: &str) -> usize {
        self.entries
            .lock()
            .await
            .values()
            .filter(|entry| entry.profile_id == profile_id)
            .count()
    }

    pub async fn all(&self) -> Vec<Arc<SessionEntry>> {
        self.entries.lock().await.values().cloned().collect()
    }

    /// 关闭某连接配置的全部会话（删除配置 / 断开连接时）。
    pub async fn close_profile(&self, profile_id: &str) {
        let entries = self.for_profile(profile_id).await;
        for entry in entries {
            self.entries.lock().await.remove(&entry.session_id);
            entry.close().await;
        }
    }
}
