//! P5.1 制品导入与多服务项目识别。
//!
//! # 一句话
//!
//! 把"用户手上的一坨东西"（本地文件夹 / ZIP / TAR / dist / JAR / 二进制 /
//! Dockerfile / Compose / 镜像引用 / 服务器已有目录）变成**可确认的结构化事实**：
//! 指纹、安全报告、技术栈、构建与启动建议、端口/健康检查/环境变量名/依赖，
//! 以及**一个应用下的多个服务候选**（每个候选独立制品）。
//!
//! # 流程（与用户确认过的顺序一致）
//!
//! ```text
//! 选择来源
//!   → 建任务（tasks::TaskRegistry，可取消 / 可重试 / 有进度）
//!   → fingerprint：算 SHA-256（流式，分块）
//!   → source  + secrets：安全清点 + 敏感内容扫描（含脱敏）
//!   → inspect：技术栈 / 构建 / 启动 / 端口 / 健康 / 环境变量名 / 依赖 / 服务候选
//!   → 返回识别结果（UI 展示，阻断项一票否决）
//!   → 用户确认（勾选要建的服务）
//!   → 保存 ArtifactRecord（与内容哈希绑定）
//!   → 需要上传时：remote::upload（.part → 校验哈希 → 原子改名）
//! ```
//!
//! # 四条不可回退的约束
//!
//! 1. **不解压到磁盘、不执行、不加载**：归档只读元数据与少量文件内容
//!    （见 `source.rs` 顶部表格）。
//! 2. **识别结果只能是结构化建议**：`BuildStep` / `StartOption` 是判别枚举，
//!    字段经过 `deployment::validate`；没有任何"自由命令"入口。
//! 3. **敏感内容只留存在性 + 掩码证据**：明文不进模型、不进日志、不回前端。
//! 4. **上传复用既有 SFTP 设施**（`SshSessionManager`），只是补上
//!    `.part` + 流式 + 哈希校验 + 原子改名这条事务语义，不另起第二套上传通道。

pub mod limits;
pub mod model;

pub mod fingerprint;
pub mod inspect;
pub mod remote;
pub mod secrets;
pub mod source;
pub mod tasks;

#[cfg(test)]
mod tests;

pub use model::*;
pub use source::{
    scan_directory, ArchiveFormat, ArchiveSource, ContentSource, DirectorySource, FileSource,
    Inventory, SourceEntry,
};
