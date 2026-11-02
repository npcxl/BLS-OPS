//! 协议驱动层（目前只有 MySQL 实现）。
//!
//! 目录约定：
//!
//! | 路径 | 职责 |
//! |---|---|
//! | `driver/mysql.rs` | 连接参数、TLS、认证、错误映射、标识符/只读规则委托 |
//! | `driver/mysql/codec.rs` | MySQL 协议值 → 通用 `DbValue`（NULL/大整数/DECIMAL/二进制） |
//!
//! 这一层的目标是**只有它认识具体驱动类型**：`session` / `runtime` / `query`
//! 依赖的是连接身份、取消令牌与事务状态（见 `protocol`），而不是 `mysql_async::Conn`。
//! 目前 `run_script` 仍在 `query` 里直接驱动 MySQL 流。执行层模板（DDL/DML 的
//! 引擎差异）先由 `adapter::AdapterSet` 承担；把流式执行下沉到 `DriverConnection`
//! trait 排在 AdapterSet 稳定之后 —— 否则只有 MySQL 一个实现时，trait 很容易
//! 被抽成"MySQL 的形状"。
//!
//! 未来新增 `driver/postgres.rs`、`driver/sqlite.rs` 时只在这里加模块，
//! 上层按 `engine_registry` 的驱动系列选择实现。

pub mod mysql;

pub use mysql::codec;
pub use mysql::*;
