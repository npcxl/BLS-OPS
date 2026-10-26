//! P5.6 **确认门禁** —— "确认并开始部署"的原子前置校验（纯逻辑，便于穷尽测试）。
//!
//! # 检查顺序是有讲究的
//!
//! 1. **幂等优先**：双击第二次进来时，同一个 `idempotency_key` 直接回放上次结果，
//!    绝不会产生第二个 Plan / Run；
//! 2. 状态必须是 `draft_ready`；
//! 3. **输入指纹必须一致** —— 项目 / 服务器 / 用户描述 / Memory 引用变过之后，
//!    旧草案一律作废，必须重新分析；
//! 4. 必须已经编译出计划；
//! 5. 预检有阻塞项 → 回到 `needs_input`，**不启动**；
//! 6. 生产 / 高风险节点 → 需要**显式审批**（AI 不能代替用户点这个确认）。

use super::model::{DeploymentSession, SessionStatus};

/// 门禁结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfirmGate {
    /// 放行：可以启动 RunExecutor。
    Proceed,
    /// 幂等命中：回放上一次的结果。
    Replay {
        result_json: String,
    },
    NotDraftReady {
        actual: SessionStatus,
    },
    /// 输入指纹不一致 —— 旧草案已失效。
    InputsChanged,
    /// 还没有编译出计划。
    NoPlan,
    PreflightBlocked {
        checks: Vec<String>,
    },
    /// 需要用户显式审批高风险 / 生产节点。
    NeedsApproval {
        nodes: Vec<String>,
    },
}

impl ConfirmGate {
    pub fn code(&self) -> &'static str {
        match self {
            ConfirmGate::Proceed => "proceed",
            ConfirmGate::Replay { .. } => "replay",
            ConfirmGate::NotDraftReady { .. } => "not_draft_ready",
            ConfirmGate::InputsChanged => "inputs_changed",
            ConfirmGate::NoPlan => "no_plan",
            ConfirmGate::PreflightBlocked { .. } => "preflight_blocked",
            ConfirmGate::NeedsApproval { .. } => "needs_approval",
        }
    }

    /// 是否应该把会话状态迁到 `needs_input`（前端据此显示"还有阻塞项"）。
    pub fn returns_to_needs_input(&self) -> bool {
        matches!(self, ConfirmGate::PreflightBlocked { .. })
    }
}

/// 门禁输入。
#[derive(Debug, Clone, Copy)]
pub struct ConfirmGateInput<'a> {
    pub session: &'a DeploymentSession,
    /// 调用方看到的**当前**输入指纹（必须与会话记录一致）。
    pub current_fingerprint: &'a str,
    /// 同一 `idempotency_key` 上一次的结果（存在即说明已经确认过）。
    pub previous_result: Option<&'a str>,
    /// 预检结论。
    pub can_run: bool,
    pub blocked_checks: &'a [String],
    /// 需要单独审批的节点。
    pub approval_nodes: &'a [String],
    /// 用户是否在高风险确认弹窗里点了"批准"。
    pub approve_high_risk: bool,
}

/// 执行门禁（**顺序固定**，见文件头）。
pub fn gate(input: ConfirmGateInput<'_>) -> ConfirmGate {
    // 1) 幂等：双击直接回放。
    if let Some(result) = input.previous_result {
        if !result.trim().is_empty() {
            return ConfirmGate::Replay {
                result_json: result.to_string(),
            };
        }
    }
    // 2) 状态。
    if input.session.status != SessionStatus::DraftReady {
        return ConfirmGate::NotDraftReady {
            actual: input.session.status,
        };
    }
    // 3) 输入指纹：变过就说明草案已过期。
    if input.session.input_fingerprint.trim().is_empty()
        || input.session.input_fingerprint != input.current_fingerprint
    {
        return ConfirmGate::InputsChanged;
    }
    // 4) 必须已经编译出计划。
    if input
        .session
        .plan_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return ConfirmGate::NoPlan;
    }
    // 5) 预检阻塞：绝不启动。
    if !input.can_run {
        return ConfirmGate::PreflightBlocked {
            checks: input.blocked_checks.to_vec(),
        };
    }
    // 6) 高风险 / 生产节点：必须用户显式批准。
    if !input.approval_nodes.is_empty() && !input.approve_high_risk {
        return ConfirmGate::NeedsApproval {
            nodes: input.approval_nodes.to_vec(),
        };
    }
    ConfirmGate::Proceed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> DeploymentSession {
        let mut session = DeploymentSession::new("s1", 1);
        session.status = SessionStatus::DraftReady;
        session.input_fingerprint = "fp-1".to_string();
        session.plan_id = Some("plan-1".to_string());
        session
    }

    fn input<'a>(
        session: &'a DeploymentSession,
        fingerprint: &'a str,
        previous: Option<&'a str>,
        can_run: bool,
        blocked: &'a [String],
        approvals: &'a [String],
        approved: bool,
    ) -> ConfirmGateInput<'a> {
        ConfirmGateInput {
            session,
            current_fingerprint: fingerprint,
            previous_result: previous,
            can_run,
            blocked_checks: blocked,
            approval_nodes: approvals,
            approve_high_risk: approved,
        }
    }

    #[test]
    fn everything_ok_lets_the_run_start() {
        let session = session();
        let gate = gate(input(&session, "fp-1", None, true, &[], &[], false));
        assert_eq!(gate, ConfirmGate::Proceed);
    }

    #[test]
    fn a_second_click_replays_the_first_result() {
        let session = session();
        // 即便状态已经变成 deploying，幂等键命中也直接回放。
        let mut moved = session.clone();
        moved.status = SessionStatus::Deploying;
        let gate = gate(input(
            &moved,
            "fp-1",
            Some(r#"{"run_id":"run-1"}"#),
            true,
            &[],
            &[],
            false,
        ));
        assert_eq!(
            gate,
            ConfirmGate::Replay {
                result_json: r#"{"run_id":"run-1"}"#.to_string()
            }
        );
    }

    #[test]
    fn only_draft_ready_may_be_confirmed() {
        let mut session = session();
        session.status = SessionStatus::Analyzing;
        assert_eq!(
            gate(input(&session, "fp-1", None, true, &[], &[], false)),
            ConfirmGate::NotDraftReady {
                actual: SessionStatus::Analyzing
            }
        );
    }

    #[test]
    fn changed_inputs_invalidate_the_draft() {
        let session = session();
        assert_eq!(
            gate(input(&session, "fp-2", None, true, &[], &[], false)),
            ConfirmGate::InputsChanged
        );
    }

    #[test]
    fn a_missing_plan_blocks_the_confirmation() {
        let mut session = session();
        session.plan_id = None;
        assert_eq!(
            gate(input(&session, "fp-1", None, true, &[], &[], false)),
            ConfirmGate::NoPlan
        );
    }

    #[test]
    fn a_blocked_preflight_never_starts_the_run() {
        let session = session();
        let blocked = vec!["缺少密钥引用 db-password".to_string()];
        let gate = gate(input(&session, "fp-1", None, false, &blocked, &[], true));
        assert_eq!(
            gate,
            ConfirmGate::PreflightBlocked {
                checks: blocked.clone()
            }
        );
        assert!(gate.returns_to_needs_input(), "阻塞应回到 needs_input");
    }

    #[test]
    fn production_and_high_risk_nodes_still_need_a_human_approval() {
        let session = session();
        let nodes = vec!["restart-service:api".to_string()];
        // 用户没点批准 → 拦住（**AI 不能代替这一步**）。
        assert_eq!(
            gate(input(&session, "fp-1", None, true, &[], &nodes, false)),
            ConfirmGate::NeedsApproval {
                nodes: nodes.clone()
            }
        );
        // 用户明确批准 → 放行。
        assert_eq!(
            gate(input(&session, "fp-1", None, true, &[], &nodes, true)),
            ConfirmGate::Proceed
        );
    }

    #[test]
    fn the_order_is_idempotency_first_then_everything_else() {
        // 状态不对 + 指纹也变了：幂等命中仍然优先回放（不产生第二次部署）。
        let mut session = session();
        session.status = SessionStatus::Deploying;
        let gate = gate(input(
            &session,
            "fp-changed",
            Some("{}"),
            false,
            &[],
            &[],
            false,
        ));
        assert!(matches!(gate, ConfirmGate::Replay { .. }), "{gate:?}");
    }
}
