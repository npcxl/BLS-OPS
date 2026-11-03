//! 高性能数据库工作台（第一阶段：MySQL 8.0 / 8.4）。
//!
//! ## 分层
//!
//! | 文件 | 职责 |
//! |---|---|
//! | `model` | IPC 协议与领域类型（值/列/批次/任务状态/导出） |
//! | `profiles` | 连接配置 SQLite CRUD + 钥匙串 + 可选 SQL 历史 |
//! | `tunnel` | SSH 回环端口转发（复用现有握手与主机指纹校验） |
//! | `driver` | 协议驱动层：`driver/mysql.rs`（参数/TLS/认证/错误）、`driver/mysql/codec.rs`（值解码） |
//! | `protocol` | 协议无关原语：连接身份、取消令牌、事务状态 |
//! | `runtime` | 一条配置的运行时：隧道 + 交互池 + 导出池 + 取消通道 |
//! | `session` | 逻辑会话 = 固定物理连接（事务/临时表/当前库） |
//! | `query` | 查询任务、分批、拉取式背压、真实取消 |
//! | `adapter` | 方言（`SqlDialect`）+ 执行模板（`AdapterSet`）+ 系统目录查询（`CatalogQueries`），无 I/O、可单测 |
//! | `metadata` | 库/表/字段/索引：目录 SQL 来自 `CatalogQueries`，结果按列名解析，按需加载 + 缓存 |
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
//! * 未适配的引擎在 `engine_registry` 里标 `ConfigOnly`：配置能保存，
//!   连接会明确拒绝并说明原因，绝不返回假成功。
//! * Redis 是与 SQL 管线平行的键值引擎（`redis_driver`）：独立的命令族
//!   `db_redis_*` 与键浏览器视图，不走 session/query/事务。
//!
//! ## 引擎相关
//!
//! | 文件 | 职责 |
//! |---|---|
//! | `capability` | 能力三态（支持/受限/不支持）+ 验证等级 + 方言事实 |
//! | `engine_registry` | 产品 → 驱动系列/方言/必填字段/能力 的唯一清单 |

pub mod adapter;
pub mod capability;
pub mod driver;
pub mod engine_registry;
pub mod export;
pub mod manager;
pub mod metadata;
pub mod model;
pub mod mutate;
pub mod postgres_meta;
pub mod postgres_table;
pub mod profiles;
pub mod protocol;
pub mod query;
pub mod redis_driver;
pub mod runtime;
pub mod schema_ops;
pub mod session;
pub mod sqlite_catalog;
pub mod sqlite_table;
pub mod table;
pub mod table_ops;
pub mod tunnel;

pub use driver::codec;
pub use manager::DatabaseManager;
pub use model::*;
pub use protocol::{CancelHandle, ConnectionIdentity, TransactionState};
pub use redis_driver::RedisManager;
