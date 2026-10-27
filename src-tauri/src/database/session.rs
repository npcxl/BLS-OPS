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

use super::driver;
use super::model::{DbErrorInfo, DbSessionInfo};

pub const SESSION_READY: &str = "ready";
pub const SESSION_BUSY: &str = "busy";
pub const SESSION_CANCELLING: &str = "cancelling";
pub const SESSION_LOST: &str = "lost";

struct SessionInner {
    conn: Option<Conn>,
    state: String,
    current_database: Option<String>,
    transaction: String,
}

pub struct SessionEntry {
    pub session_id: String,
    pub profile_id: String,
    pub generation: u64,
    pub thread_id: u32,
    pub server_version: Option<String>,
    pub tls_active: bool,
    pub tls_cipher: Option<String>,
    pub tls_version: Option<String>,
    pub read_only: bool,
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
    ) -> Self {
        let thread_id = conn.id();
        let transaction = driver::transaction_state(&conn).to_string();
        Self {
            session_id,
            profile_id,
            generation,
            thread_id,
            server_version,
            tls_active: tls.active,
            tls_cipher: tls.cipher,
            tls_version: tls.version,
            read_only,
            opened_at: crate::db::AppDb::now(),
            last_used: Mutex::new(Instant::now()),
            inner: Mutex::new(SessionInner {
                conn: Some(conn),
                state: SESSION_READY.to_string(),
                current_database: None,
                transaction,
            }),
        }
    }

    pub async fn info(&self) -> DbSessionInfo {
        let inner = self.inner.lock().await;
        DbSessionInfo {
            session_id: self.session_id.clone(),
            profile_id: self.profile_id.clone(),
            generation: self.generation,
            connection_id: self.thread_id,
            server_version: self.server_version.clone(),
            current_database: inner.current_database.clone(),
            tls_active: self.tls_active,
            tls_cipher: self.tls_cipher.clone(),
            tls_version: self.tls_version.clone(),
            transaction: inner.transaction.clone(),
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

    /// 取走独占连接。会话正忙时返回错误 —— 同一个编辑器不并发跑两条 SQL。
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
                Some(conn) => {
                    inner.state = SESSION_BUSY.to_string();
                    Ok(conn)
                }
                None => Err(DbErrorInfo::new("query", "会话连接不可用")),
            },
        }
    }

    /// 归还连接。`clean = false` 表示协议状态不可信 → 丢弃。
    pub async fn release_conn(&self, conn: Conn, clean: bool) {
        if !clean {
            let mut inner = self.inner.lock().await;
            inner.state = SESSION_LOST.to_string();
            inner.conn = None;
            inner.transaction = "unknown".to_string();
            drop(inner);
            // 关闭 socket：服务器会终止这条连接上的查询。
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(2), conn.disconnect()).await;
            return;
        }

        let transaction = driver::transaction_state(&conn).to_string();
        let mut inner = self.inner.lock().await;
        inner.transaction = transaction;
        inner.state = SESSION_READY.to_string();
        inner.conn = Some(conn);
    }

    /// 主动关闭（标签页关闭时）：移除连接并尽力发送 COM_QUIT。
    pub async fn close(&self) {
        let conn = {
            let mut inner = self.inner.lock().await;
            inner.state = SESSION_LOST.to_string();
            inner.conn.take()
        };
        if let Some(conn) = conn {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(2), conn.disconnect()).await;
        }
    }

    /// 只读查询显示用：当前是否还有未提交事务（服务器 OK 包为准）。
    pub async fn transaction(&self) -> String {
        self.inner.lock().await.transaction.clone()
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
