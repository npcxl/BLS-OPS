//! P5.2 部署方案生成：**确定性规则引擎 + 知识库 + 可选的 AI 增强**。
//!
//! # 一句话
//!
//! 把"用户想要什么（问卷）+ 服务器是什么（能力与现状）+ 制品里有什么（识别结果）
//! + 我们知道什么（知识库）+ 我们被允许做什么（安全策略）"变成一份
//! **可审计、可复现的 [`model::DeploymentProposal`]**。
//!
//! # 四条不可回退的约束
//!
//! 1. **AI 不是决策来源**。方案由 [`rules`] / [`capacity`] 确定性推导；
//!    AI（[`ai`]）只能以 `Recommendation` 等级补充说明与备选考虑，且它的输出要过
//!    与规则引擎**同一套校验**（不许出现可执行 shell、不许出现禁用键）。
//!    没有配置 AI 时方案照样完整 —— 界面如实显示"AI 未启用"，绝不假装分析过。
//! 2. **每条关键结论自报家门**：`Statement.evidence` + [`model::EvidenceClass`]
//!    把"事实 / 推断 / 建议 / 未知"分开。没证据的不许写成事实。
//! 3. **冲突不静默**。知识库条目互相矛盾时给出 [`model::KnowledgeConflict`]；
//!    服务器实时事实与安全策略**优先于**知识库，且必须记下"为什么覆盖了它"。
//!    无法用事实或策略裁定的冲突 → 进 `open_questions` 并且不生成可执行计划。
//! 4. **缺关键字段就不出计划**。`ProposalOutcome.ready == false` 时
//!    `workflow.nodes` 一定为空（有单测钉住这条）。

pub mod ai;
pub mod capacity;
pub mod checks;
pub mod engine;
pub mod facts;
pub mod knowledge;
pub mod model;
pub mod rules;
pub mod workflow;

#[cfg(test)]
mod tests;

pub use ai::{AiPrompt, AiSuggestion, ProposalAdvisor};
pub use capacity::{CapacityEstimate, CapacityInput};
pub use engine::{generate, input_hash, output_hash, ProposalInputs};
pub use facts::derive_service_facts;
pub use knowledge::{KnowledgeQuery, KnowledgeResult, KNOWLEDGE_VERSION};
pub use model::*;
pub use rules::ServiceFacts;

/// 规则引擎版本。**方案哈希的一部分** —— 引擎逻辑一变，旧方案的
/// `output_hash` 就复现不出来，这正是我们要的（审计要的是"当时怎么算的"）。
pub const ENGINE_VERSION: &str = "p5.2-engine-1";

/// 方案结构版本（对应 [`model::DeploymentProposal::schema_version`] 与
/// `PROPOSAL_JSON_SCHEMA`）。
pub const PROPOSAL_SCHEMA_VERSION: &str = "deployment-proposal/1";

/// 提示词版本（AI 增强用）。与模型名一起进方案指纹。
///
/// * `p5.2-prompt-1`：初版（只带确定性方案摘要）。
/// * `p5.5-prompt-2`：分区提示词 + 用户知识块 + 引用/证据要求 + 输出 Schema 版本。
pub const PROMPT_VERSION: &str = "p5.5-prompt-2";
