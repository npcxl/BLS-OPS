//! P5.6 **部署结果与学习**（确定性规则，不让 AI 直接改 Memory）。
//!
//! 一次部署结束后我们能确定地知道三件事：**哪些步骤成功了、哪些失败了、
//! 用户改了草案的哪些地方**。它们分别对应 Memory 的三种自动写入：
//!
//! * 成功 → 引用到的 Memory `success_count + 1`、置信度上调；
//! * 失败 / 回滚 → `failure_count + 1`、置信度下调（过低退回 `pending`）；
//! * 用户改过草案 → 生成一条 **correction 候选**（`pending`，**不会自动生效**）。
//!
//! AI 只能提候选（[`crate::deployment::session::memory::MemoryCandidate`]），
//! 落库前仍要过受控 key + 类型校验。

use serde::{Deserialize, Serialize};

use super::memory::{
    record_failure, record_success, DeploymentMemory, MemoryCandidate, MemoryKey, MemoryKind,
    MemorySourceType, MemoryStatus,
};
use super::model::SessionStatus;

/// 一次部署的结果（**只记事实**，不做评价）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentOutcome {
    pub session_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    /// 成功的节点 key。
    pub succeeded_steps: Vec<String>,
    /// 失败的节点 key。
    pub failed_steps: Vec<String>,
    /// 是否发生了回滚。
    pub rolled_back: bool,
    /// 实际监听的端口（服务名 → 端口）。
    pub actual_ports: Vec<(String, u16)>,
    /// 健康检查结果（目标 → 是否通过）。
    pub health_results: Vec<(String, bool)>,
    /// 本次草案引用到的 Memory。
    pub memory_refs: Vec<String>,
    /// 用户对草案做过的修改（用于生成 correction）。
    pub user_edits: Vec<String>,
}

impl DeploymentOutcome {
    pub fn succeeded(&self) -> bool {
        self.failed_steps.is_empty() && !self.rolled_back
    }

    /// 由结果推出的会话终态。
    pub fn terminal_status(&self) -> SessionStatus {
        if self.succeeded() {
            SessionStatus::Succeeded
        } else if self.rolled_back {
            SessionStatus::RolledBack
        } else {
            SessionStatus::Failed
        }
    }
}

/// 一条 Memory 该怎么因这次结果而调整（确定性）。
#[derive(Debug, Clone, PartialEq)]
pub enum MemoryAdjustment {
    /// 计数/置信度更新后的样子。
    Updated(Box<DeploymentMemory>),
    /// 由"用户改了草案"产生的 correction 候选（**pending，不自动生效**）。
    Correction(MemoryCandidate),
}

/// 把结果应用到一批 Memory 上。
///
/// * 成功 → 上调；失败 / 回滚 → 下调；
/// * 有 `user_edits` 时额外产出 correction 候选（需要用户确认才会生效）。
pub fn learn(
    outcome: &DeploymentOutcome,
    memories: &[DeploymentMemory],
    now: i64,
) -> Vec<MemoryAdjustment> {
    let mut adjustments: Vec<MemoryAdjustment> = Vec::new();
    for memory in memories {
        let updated = if outcome.succeeded() {
            record_success(memory.clone(), now)
        } else {
            record_failure(memory.clone(), now)
        };
        adjustments.push(MemoryAdjustment::Updated(Box::new(updated)));
    }
    for edit in &outcome.user_edits {
        let trimmed = edit.trim();
        if trimmed.is_empty() {
            continue;
        }
        adjustments.push(MemoryAdjustment::Correction(MemoryCandidate {
            kind: MemoryKind::Correction,
            // 作用域留给调用方细化；这里只表达"这是修正，不是既定偏好"。
            scope: crate::deployment::session::memory::MemoryScope::Global,
            scope_id: None,
            key: MemoryKey::PreferredTopology,
            value_json: serde_json::json!(trimmed),
            reason: "用户在确认前修改了草案".to_string(),
        }));
    }
    adjustments
}

/// 用户停用/拒绝一条 correction 时的统一入口（界面"不喜欢这条建议"按钮）。
pub fn reject_candidate(candidate: MemoryCandidate) -> DeploymentMemory {
    let now = 0;
    let mut memory = DeploymentMemory::new(
        format!("candidate-rejected-{}", candidate.key.as_str()),
        candidate.kind,
        candidate.scope,
        candidate.scope_id,
        candidate.key,
        candidate.value_json,
        MemorySourceType::ProposalEdit,
        now,
    );
    memory.status = MemoryStatus::Rejected;
    memory
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::session::memory::{
        explicit_preference, MemoryScope, CONFIDENCE_SUSPEND_THRESHOLD,
    };

    fn memory() -> DeploymentMemory {
        let base = DeploymentMemory::new(
            "m1",
            MemoryKind::Preference,
            MemoryScope::Global,
            None,
            MemoryKey::PreferredRuntime,
            serde_json::json!("node"),
            MemorySourceType::Explicit,
            1,
        );
        explicit_preference(base, 1)
    }

    fn outcome(failed: bool) -> DeploymentOutcome {
        DeploymentOutcome {
            session_id: "s1".to_string(),
            run_id: Some("run-1".to_string()),
            succeeded_steps: vec!["upload-artifact".to_string()],
            failed_steps: if failed {
                vec!["start-service".to_string()]
            } else {
                vec![]
            },
            rolled_back: false,
            actual_ports: vec![],
            health_results: vec![],
            memory_refs: vec!["m1".to_string()],
            user_edits: vec![],
        }
    }

    #[test]
    fn a_successful_deployment_raises_confidence_and_counts() {
        let adjustments = learn(&outcome(false), &[memory()], 100);
        match &adjustments[0] {
            MemoryAdjustment::Updated(updated) => {
                assert_eq!(updated.success_count, 1);
                assert!(updated.confidence > CONFIDENCE_SUSPEND_THRESHOLD);
            }
            other => panic!("应当是更新：{other:?}"),
        }
    }

    #[test]
    fn a_failed_or_rolled_back_deployment_lowers_confidence() {
        let mut failed = outcome(true);
        failed.rolled_back = true;
        let adjustments = learn(&failed, &[memory()], 100);
        match &adjustments[0] {
            MemoryAdjustment::Updated(updated) => {
                assert_eq!(updated.failure_count, 1);
                assert_eq!(updated.last_used_at, Some(100));
            }
            other => panic!("应当是更新：{other:?}"),
        }
        assert_eq!(failed.terminal_status(), SessionStatus::RolledBack);
    }

    #[test]
    fn repeated_failures_suspend_a_preference() {
        let mut current = memory();
        for round in 0..6 {
            current = record_failure(current, 100 + round);
        }
        assert!(current.confidence < CONFIDENCE_SUSPEND_THRESHOLD);
        assert_eq!(
            current.status,
            MemoryStatus::Pending,
            "不可靠的偏好不再自动生效"
        );
    }

    #[test]
    fn user_edits_become_pending_corrections_not_immediate_defaults() {
        let mut edited = outcome(false);
        edited.user_edits = vec!["改用 Docker Compose".to_string()];
        let adjustments = learn(&edited, &[memory()], 100);
        let correction = adjustments
            .iter()
            .find_map(|item| match item {
                MemoryAdjustment::Correction(candidate) => Some(candidate.clone()),
                _ => None,
            })
            .expect("应当产生 correction");
        assert_eq!(correction.kind, MemoryKind::Correction);
        assert!(correction.reason.contains("修改"));
        // 单次修正不改变既有 Memory 的状态。
        match &adjustments[0] {
            MemoryAdjustment::Updated(updated) => assert_eq!(updated.status, MemoryStatus::Active),
            other => panic!("应当是更新：{other:?}"),
        }
    }

    #[test]
    fn a_clean_run_is_reported_as_succeeded() {
        assert!(outcome(false).succeeded());
        assert_eq!(outcome(false).terminal_status(), SessionStatus::Succeeded);
    }
}
