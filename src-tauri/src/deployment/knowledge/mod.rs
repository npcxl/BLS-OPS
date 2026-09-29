//! P5.5 —— **用户可管理知识库**（UserKnowledge）。
//!
//! # 与系统知识的关系（一句话）
//!
//! * [`crate::deployment::proposal::knowledge`] = **SystemKnowledge**：编译期常量、
//!   随代码发版、参与确定性决策、用户改不了。
//! * 本模块 = **UserKnowledge**：SQLite 里、用户随时改、只用于
//!   **AI 复核的背景与引用**，不参与任何确定性决策。
//!
//! 因此用户知识**永远不能**：关掉审批、放开 Secret 保护、挪动路径围栏、
//! 允许任意命令、改变拓扑评分。它连进入决策路径的入口都没有 ——
//! 检索结果只流向 [`crate::deployment::proposal::ai::build_prompt`]，
//! 而 AI 的答复又只能以"建议"身份出现（见 `proposal::ai::merge_into`）。
//!
//! # 版本
//!
//! 保存 = 新版本，旧版本永不覆盖；删除 = 软删除（归档），历史引用仍可追溯。
//! 方案指纹记录 `knowledge:<id>@<version>`，所以"当时的方案引用了哪一版"
//! 是能查出来的。
//!
//! # 检索
//!
//! [`retrieve::search`]：本地 BM25（整数化、稳定排序），无 Embedding、无向量库。
//! 预算（Top K / 片段长度 / 总字符数）在**入库前**就施加，
//! 保证"不会把整套知识库发给模型"。

pub mod model;
pub mod retrieve;

pub use model::{
    KnowledgeBudget, KnowledgeCategory, KnowledgeDocStatus, KnowledgeDocument, KnowledgeHit,
    KnowledgeQueryInput, KnowledgeScope, KnowledgeSourceType, KnowledgeUsageRecord,
    KnowledgeVersion, STALE_AFTER_MS,
};
pub use retrieve::{search, terms_from_context, to_references};
