//! AI 增强层：**可选、只读、有边界**。
//!
//! # 边界（这是本模块存在的全部意义）
//!
//! AI **不能**：改拓扑、改工作流、改审批、改容量数字、产出可执行片段。
//! AI **只能**：补充说明、指出被忽略的检查项、提出备选考虑。
//!
//! 因此这里的流程是"**先算再问**"：方案已经由确定性引擎产出，AI 只是在上面
//! 加批注；它的每条批注都要过 [`checks::validate_ai_text`]（与规则引擎同一把尺子），
//! 不合格的**记进 `rejected` 而不是悄悄丢掉**（审计要看得见被拒了什么）。
//!
//! # 没有配置提供方时
//!
//! `advisor = None` → `ai_review = None`，界面照实显示"AI 未启用"。
//! **绝不用模板文案假装 AI 分析过。**

use serde::{Deserialize, Serialize};

use super::checks;
use super::model::{
    AiRejection, AiReview, DeploymentProposal, Evidence, EvidenceSource, Statement,
};
use super::PROMPT_VERSION;
use crate::deployment::artifact::fingerprint;

/// 给提供方的提示词。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiPrompt {
    /// 系统提示（含全部硬约束）。
    pub system: String,
    /// 结构化输入（方案的确定性结果摘要；**不含密钥**）。
    pub payload: serde_json::Value,
}

/// 一条 AI 批注。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiNote {
    pub text: String,
    /// 针对哪一块（`topology` / `capacity` / `risk` / `rollback` / `other`）。
    pub target: Option<String>,
}

/// AI 的回复。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiSuggestion {
    pub notes: Vec<AiNote>,
    /// 备选考虑（不进拓扑评分，只作为建议展示）。
    pub alternatives: Vec<String>,
}

/// 提供方适配器。
///
/// 具体实现（HTTP 调模型 / 本地模型 / 人工复核）放在这一层之外；
/// 引擎只认这个接口，因此**没有 AI 也能跑完整流程**。
pub trait ProposalAdvisor: Send + Sync {
    /// 返回模型名（进方案指纹，审计要能追到"哪个模型说的"）。
    fn model(&self) -> String;
    fn review(&self, prompt: &AiPrompt) -> Result<AiSuggestion, String>;
}

/// 系统提示词。**每一条硬约束都必须写进去**，并要求结构化输出。
pub const SYSTEM_PROMPT: &str = r#"你是部署方案的复核者，不是决策者。
已经存在一份由确定性规则引擎产出的方案；你的任务是挑毛病与补充信息。

硬约束（违反即被系统丢弃）：
1. 不得输出任何可执行命令、脚本、shell 片段或代码块。
2. 不得修改推荐的部署形态、工作流节点、审批项与容量数字 —— 你只能评论。
3. 不确定就明确说"不确定"，不要编造事实。
4. 每条结论都要说清依据；没有依据的猜测必须标注为猜测。
5. 只输出 JSON：{"notes":[{"text":"...","target":"topology|capacity|risk|rollback|other"}],"alternatives":["..."]}
6. 用中文表达，每条不超过 300 字。

重点关注：单点故障、容量是否够用、备份与回滚是否真的可执行、密钥与端口暴露面、依赖不可用时的行为。"#;

/// 组装提示词：**只带方案摘要**，不带密钥与制品内容。
pub fn build_prompt(proposal: &DeploymentProposal) -> AiPrompt {
    let payload = serde_json::json!({
        "schema_version": proposal.schema_version,
        "application_id": proposal.application_id,
        "environment_id": proposal.environment_id,
        "summary": proposal.summary,
        "recommended_topology": {
            "kind": proposal.recommended_topology.kind,
            "name": proposal.recommended_topology.name,
            "feasible": proposal.recommended_topology.feasible,
            "blockers": proposal.recommended_topology.blockers,
        },
        "alternative_topologies": proposal
            .alternative_topologies
            .iter()
            .map(|option| serde_json::json!({
                "kind": option.kind,
                "feasible": option.feasible,
                "complexity": option.complexity,
            }))
            .collect::<Vec<_>>(),
        "services": proposal
            .services
            .iter()
            .map(|service| serde_json::json!({
                "name": service.name,
                "role": service.role,
                "service_kind": service.service_kind,
                "ports": service.ports,
                "health_check": service.health_check.as_ref().map(|plan| plan.target.clone()),
                "env_keys": service.env_keys,
            }))
            .collect::<Vec<_>>(),
        "capacity_recommendation": proposal.capacity_recommendation,
        "domains": proposal.domains,
        "risks": proposal
            .risks
            .iter()
            .map(|risk| serde_json::json!({
                "id": risk.id,
                "title": risk.title,
                "severity": risk.severity,
                "blocks_approval": risk.blocks_approval,
            }))
            .collect::<Vec<_>>(),
        "unknowns": proposal.unknowns,
        "knowledge_references": proposal
            .knowledge_references
            .iter()
            .map(|reference| reference.entry_id.clone())
            .collect::<Vec<_>>(),
    });
    AiPrompt {
        system: SYSTEM_PROMPT.to_string(),
        payload,
    }
}

/// 跑一次 AI 复核并写回方案。
///
/// 返回 `None` = 没有配置提供方（`ai_review` 保持为空，界面照实说明）。
/// 提供方报错时**也会**留下一条记录：`rejected` 里写明失败原因，
/// 这样"AI 那次到底跑没跑、为什么没结果"是可查的。
pub fn apply(advisor: &dyn ProposalAdvisor, proposal: &mut DeploymentProposal) -> Option<AiReview> {
    let prompt = build_prompt(proposal);
    let prompt_text = format!(
        "{}\n{}",
        prompt.system,
        serde_json::to_string(&prompt.payload).unwrap_or_default()
    );
    let prompt_hash = fingerprint::hash_bytes(prompt_text.as_bytes());
    let model = advisor.model();

    let mut review = AiReview {
        model: model.clone(),
        prompt_version: PROMPT_VERSION.to_string(),
        prompt_hash,
        accepted: 0,
        rejected: Vec::new(),
        notes: Vec::new(),
    };

    let suggestion = match advisor.review(&prompt) {
        Ok(suggestion) => suggestion,
        Err(error) => {
            review.rejected.push(AiRejection {
                text: "(AI 复核请求失败)".to_string(),
                reason: error,
            });
            return Some(review);
        }
    };

    let mut index = 0usize;
    let mut push_note = |text: String, target: Option<String>, review: &mut AiReview| {
        match checks::validate_ai_text(&text) {
            Ok(()) => {
                index += 1;
                review.notes.push(
                    Statement::recommendation(
                        &format!("ai-{index}"),
                        text,
                        vec![Evidence {
                            class: super::model::EvidenceClass::Recommendation,
                            source: EvidenceSource::Ai {
                                model: model.clone(),
                                prompt_version: PROMPT_VERSION.to_string(),
                            },
                            detail: "AI 复核建议（不参与决策，仅供人工参考）".to_string(),
                            reference: target.clone(),
                        }],
                    )
                    .with_impact(super::model::StatementImpact::Info),
                );
                review.accepted += 1;
            }
            Err(reason) => review.rejected.push(AiRejection { text, reason }),
        }
    };

    for note in suggestion.notes {
        push_note(note.text, note.target, &mut review);
    }
    for alternative in suggestion.alternatives {
        push_note(alternative, Some("alternative".to_string()), &mut review);
    }

    Some(review)
}
