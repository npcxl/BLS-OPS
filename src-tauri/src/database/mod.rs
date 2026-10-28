//! 高性能数据库工作台（第一阶段：MySQL 8.0 / 8.4）。
//!
//! ## 分层
//!
//! | 文件 | 职责 |
//! |---|---|
//! | `model` | IPC 协议与领域类型（值/列/批次/任务状态/导出） |
//! | `profiles` | 连接配置 SQLite CRUD + 钥匙串 + 可选 SQL 历史 |
//! | `tunnel` | SSH 回环端口转发（复用现有握手与主机指纹校验） |
//! | `driver` | MySQL 驱动参数、TLS、阶段化错误、标识符引用 |
//! | `runtime` | 一条配置的运行时：隧道 + 交互池 + 导出池 + 取消通道 |
//! | `session` | 逻辑会话 = 固定物理连接（事务/临时表/当前库） |
//! | `query` | 查询任务、分批、拉取式背压、真实取消 |
//! | `codec` | 驱动值 → 带类型协议值（NULL/大整数/DECIMAL/日期/二进制） |
//! | `metadata` | 库/表/字段/索引，按需加载 + 缓存 |
//! | `table` | 表数据浏览（keyset/OFFSET、过滤、大字段投影预算） |
//! | `mutate` | 单表增删改（事务、影响行数、乐观并发） |
//! | `export` | CSV 流式导出（独立连接、原子发布、进度） |
//! | `manager` | 运行时/会话/查询/导出的编排与生命周期 |
//!
//! ## 不做什么
//!
//! * 不通过 SSH 执行 `mysql` CLI 再解析文本：走原生协议。
//! * 不用编译期宏（`sqlx::query!`）：运行时连接用户自己的库。
//! * 不自动重试写 SQL / 提交事务。
//! * 不把"取消前端 Promise"当作服务器取消（见 `query` 的 KILL 流程）。
//! * PostgreSQL 只在模型里留了枚举值：连接会被明确拒绝，绝不返回假成功。

pub mod codec;
pub mod driver;
pub mod export;
pub mod manager;
pub mod metadata;
pub mod model;
pub mod mutate;
pub mod profiles;
pub mod query;
pub mod runtime;
pub mod session;
pub mod table;
pub mod table_ops;
pub mod tunnel;

pub use manager::DatabaseManager;
pub use model::*;
