//! 协议无关的会话原语。
//!
//! 这一层回答三个问题，**都不允许用 MySQL 的概念回答**：
//!
//! 1. **这个连接叫什么**：`ConnectionIdentity`。MySQL 有 thread id，
//!    PostgreSQL 有 backend pid，SQLite 只有文件路径 —— 界面只需要一个
//!    可展示的 `label`，数值 id 是可选的。
//! 2. **怎么取消**：`CancelHandle`。MySQL 是 `KILL QUERY <thread_id>`，
//!    PostgreSQL 是独立 socket 上的 cancel 请求，SQLite 是 interrupt handle。
//!    驱动不支持取消时必须显式给出原因，不能假装成功。
//! 3. **事务处于什么状态**：`TransactionState`。取值必须来自驱动读到的
//!    真实状态（MySQL 的 OK 包 / PostgreSQL 的 `ReadyForQuery` 标记），
//!    不能靠 SQL 前缀猜。
//!
//! 这些类型是 `session` / `query` / `runtime` 唯一需要知道的会话细节；
//! 具体驱动只在 `driver` 模块里出现。

use serde::{Deserialize, Serialize};

/// 一条物理连接的可展示身份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionIdentity {
    /// 界面展示用：`#42` / `pid 1234` / `file:app.db`。
    pub label: String,
    /// 协议层数值 id（如果有）。**不要**把它当成所有数据库都有。
    pub numeric: Option<u32>,
}

impl ConnectionIdentity {
    pub fn labeled(label: impl Into<String>, numeric: Option<u32>) -> Self {
        Self {
            label: label.into(),
            numeric,
        }
    }

    /// 只有数值 id、界面按 `#<id>` 展示（MySQL / MariaDB 的既有表现）。
    pub fn numbered(id: u32) -> Self {
        Self::labeled(format!("#{id}"), Some(id))
    }

    /// 没有数值 id 的引擎（SQLite 文件、MongoDB 连接串）。
    pub fn named(label: impl Into<String>) -> Self {
        Self::labeled(label, None)
    }
}

/// 事务状态。序列化值与前端既有联合类型一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionState {
    None,
    InTransaction,
    InTransactionReadOnly,
    Unknown,
}

impl TransactionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::InTransaction => "in_transaction",
            Self::InTransactionReadOnly => "in_transaction_read_only",
            Self::Unknown => "unknown",
        }
    }

    pub fn is_open(self) -> bool {
        matches!(self, Self::InTransaction | Self::InTransactionReadOnly)
    }
}

/// 取消令牌：由驱动在建立连接时产生，交给上层保存。
///
/// 上层只会把它原样传回 `runtime.cancel()`，**不解析内部字段** ——
/// 这样 PostgreSQL 的 (pid, secret) 对和 SQLite 的 interrupt handle
/// 都不需要污染 `query.rs`。
#[derive(Debug, Clone)]
pub enum CancelHandle {
    /// MySQL 协议：服务端 thread id，取消走另一条控制连接上的 `KILL QUERY`。
    MySqlThread { thread_id: u32 },
    /// 驱动没有实现服务端取消。必须带原因，取消按钮据此禁用并显示说明。
    Unsupported { reason: &'static str },
}

impl CancelHandle {
    pub fn mysql(thread_id: u32) -> Self {
        Self::MySqlThread { thread_id }
    }

    pub fn unsupported(reason: &'static str) -> Self {
        Self::Unsupported { reason }
    }

    pub fn is_supported(&self) -> bool {
        !matches!(self, Self::Unsupported { .. })
    }

    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Self::MySqlThread { .. } => None,
            Self::Unsupported { reason } => Some(reason),
        }
    }

    /// 仅 MySQL 协议使用；其它引擎返回 `None`。
    pub fn mysql_thread_id(&self) -> Option<u32> {
        match self {
            Self::MySqlThread { thread_id } => Some(*thread_id),
            Self::Unsupported { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_labels_are_display_ready() {
        assert_eq!(ConnectionIdentity::numbered(42).label, "#42");
        assert_eq!(ConnectionIdentity::numbered(42).numeric, Some(42));
        let named = ConnectionIdentity::named("file:app.db");
        assert_eq!(named.numeric, None);
        assert_eq!(named.label, "file:app.db");
    }

    #[test]
    fn transaction_state_wire_values_are_stable() {
        assert_eq!(TransactionState::None.as_str(), "none");
        assert_eq!(
            TransactionState::InTransactionReadOnly.as_str(),
            "in_transaction_read_only"
        );
        // 前端按这些字符串判断"有未提交事务"，序列化必须一致。
        assert_eq!(
            serde_json::to_string(&TransactionState::InTransaction).unwrap(),
            "\"in_transaction\""
        );
        assert!(TransactionState::InTransaction.is_open());
        assert!(!TransactionState::Unknown.is_open());
    }

    #[test]
    fn unsupported_cancel_must_carry_a_reason() {
        let handle = CancelHandle::unsupported("服务端不支持取消");
        assert!(!handle.is_supported());
        assert_eq!(handle.reason(), Some("服务端不支持取消"));
        assert_eq!(handle.mysql_thread_id(), None);

        let mysql = CancelHandle::mysql(7);
        assert!(mysql.is_supported());
        assert_eq!(mysql.mysql_thread_id(), Some(7));
    }
}
