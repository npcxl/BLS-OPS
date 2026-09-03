//! P4.0–P4.3 Linux 命令智能中心。
//!
//! # 定位
//!
//! 不是"Linux 命令大全"，而是部署、排障、自动化与 AI 共用的**命令基座**：
//! 输入时快速提示（知识库 + FTS5 检索），执行后把杂乱终端输出转成结构化 UI，
//! 同时**永久保留原始输出**。
//!
//! # 安全模型（P4.0 核心，不可绕过）
//!
//! 1. **前端只传 `knowledgeId` + 结构化参数**（容器名 / 单元名 / 绝对路径），
//!    永远没有 shell 字符串通道 —— [`KnowledgeExec::capability`] 是知识库到
//!    [`safe::Capability`] 的**唯一**翻译点，命令字符串仍只拼在 `safe.rs`。
//! 2. **风险分级**（[`RiskLevel`]）：`readonly` 直接执行；`medium`
//!    （restart / reload）前端必须 ConfirmDialog；`high` / `destructive`
//!    **第一批不收录** —— 删除类命令要等 P4.4 软删除流程落地后才入库。
//! 3. **数据不删减、不伪造**：结构化展示只是第二种视图，原始 stdout/stderr、
//!    实际执行命令、退出码全部返回给前端留档。
//! 4. 机器可读优先：Docker 用 `--format` 表格（safe.rs 固定模板）、git 用
//!    `--porcelain=v2`，绝不做空格切割。

mod catalog;
mod model;
pub(crate) mod search;
mod tests;

pub use model::{
    build_exec, CommandCategory, CommandKnowledge, CommandParams, CommandSearchHit, ExecKind,
    KnowledgeExec, Mutability, RiskLevel,
};

use crate::safe::ProbeTool;

/// 编译期内置知识库（首批，P4.1）。
pub fn builtin_catalog() -> &'static [CommandKnowledge] {
    catalog::CATALOG
}

/// 知识条目的执行能力需求（转成前端可读的工具名列表）。
pub fn requires_tools(knowledge: &CommandKnowledge) -> Vec<String> {
    knowledge
        .requires
        .iter()
        .map(|tool| tool.name().to_string())
        .collect()
}
