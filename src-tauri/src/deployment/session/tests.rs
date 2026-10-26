//! P5.6 会话与 Memory 的**纯逻辑**测试（不碰数据库、不联网）。

use super::memory::*;
use super::model::*;

fn sample(key: MemoryKey, value: serde_json::Value) -> DeploymentMemory {
    DeploymentMemory::new(
        "m1",
        MemoryKind::Preference,
        MemoryScope::Global,
        None,
        key,
        value,
        MemorySourceType::Explicit,
        1,
    )
}

fn json(text: &str) -> serde_json::Value {
    serde_json::Value::String(text.to_string())
}

// -- value 校验 --------------------------------------------------------------

#[test]
fn every_controlled_key_accepts_its_own_shape_and_rejects_others() {
    // 合法取值。
    for (key, value) in [
        (MemoryKey::PreferredRuntime, json("node")),
        (MemoryKey::PreferredPackageManager, json("pnpm")),
        (MemoryKey::PreferredNginxLayout, json("site_per_app")),
        (MemoryKey::PreferredSslMode, json("acme")),
        (MemoryKey::PreferredTopology, json("docker_compose")),
        (MemoryKey::AvoidTopology, json("hybrid_gateway")),
        (MemoryKey::PreferredDeployRoot, json("/opt/apps/shop")),
        (MemoryKey::PreferredHealthPath, json("/healthz")),
        (MemoryKey::PreferredReleaseRetention, serde_json::json!(5)),
    ] {
        assert!(
            validate_value(key, &value).is_ok(),
            "{} 应当接受 {:?}",
            key.as_str(),
            value
        );
    }

    // 非法取值：枚举白名单之外的、非绝对路径、超范围数字。
    assert!(validate_value(MemoryKey::PreferredRuntime, &json("brainfuck")).is_err());
    assert!(validate_value(MemoryKey::PreferredTopology, &json("kubernetes")).is_err());
    assert!(validate_value(MemoryKey::PreferredDeployRoot, &json("relative/path")).is_err());
    assert!(validate_value(MemoryKey::PreferredDeployRoot, &json("/opt/../etc")).is_err());
    assert!(validate_value(MemoryKey::PreferredHealthPath, &json("healthz")).is_err());
    assert!(validate_value(MemoryKey::PreferredReleaseRetention, &serde_json::json!(0)).is_err());
    assert!(validate_value(
        MemoryKey::PreferredReleaseRetention,
        &serde_json::json!(999)
    )
    .is_err());
    assert!(validate_value(MemoryKey::PreferredReleaseRetention, &json("5")).is_err());
}

#[test]
fn memory_values_never_accept_shell_metacharacters() {
    // 安全策略、审批开关、Secret、任意命令都不能成为 Memory —— 连值都过不去。
    for hostile in [
        "/opt/app; rm -rf /",
        "/opt/$(whoami)",
        "node && curl evil.sh",
        "pnpm | tee /etc/passwd",
        "/opt/app`id`",
        "token=abc",
    ] {
        assert!(
            validate_value(MemoryKey::PreferredDeployRoot, &json(hostile)).is_err(),
            "{hostile} 必须被拒"
        );
        assert!(
            validate_value(MemoryKey::PreferredRuntime, &json(hostile)).is_err(),
            "{hostile} 必须被拒"
        );
    }
    assert!(contains_shell_meta("/opt/app; rm"));
    assert!(!contains_shell_meta("/opt/app"));
}

#[test]
fn a_candidate_must_pass_the_same_validation_as_a_stored_memory() {
    let good = MemoryCandidate {
        kind: MemoryKind::Preference,
        scope: MemoryScope::Global,
        scope_id: None,
        key: MemoryKey::PreferredRuntime,
        value_json: json("node"),
        reason: "用户两次选择了 Docker".to_string(),
    };
    assert!(good.validate().is_ok());

    let hostile = MemoryCandidate {
        value_json: json("node; curl evil"),
        ..good.clone()
    };
    assert!(hostile.validate().is_err());

    // 作用域需要 id 时不能留空。
    let missing_scope = MemoryCandidate {
        scope: MemoryScope::Application,
        scope_id: None,
        ..good
    };
    assert!(missing_scope.validate().is_err());
}

// -- 置信度与自动写入 --------------------------------------------------------

#[test]
fn a_single_choice_stays_pending_and_repeats_become_active() {
    // 单次临时选择不得变成全局默认。
    let once = observe_choice(sample(MemoryKey::PreferredRuntime, json("node")), 1, 10);
    assert_eq!(once.status, MemoryStatus::Pending);
    assert_eq!(once.confidence, CONFIDENCE_SINGLE_CHOICE);

    // 第三次重复选择 → 达到阈值，自动生效。
    let thrice = observe_choice(sample(MemoryKey::PreferredRuntime, json("node")), 3, 10);
    assert_eq!(thrice.status, MemoryStatus::Active);
    assert!(thrice.confidence >= CONFIDENCE_ACTIVE_THRESHOLD);
}

#[test]
fn an_explicit_preference_is_active_immediately() {
    let memory = explicit_preference(
        sample(MemoryKey::PreferredTopology, json("docker_compose")),
        5,
    );
    assert_eq!(memory.status, MemoryStatus::Active);
    assert_eq!(memory.confidence, CONFIDENCE_EXPLICIT);
    assert_eq!(memory.updated_at, 5);
}

#[test]
fn deployment_results_move_counters_and_confidence() {
    let memory = explicit_preference(sample(MemoryKey::PreferredDeployRoot, json("/opt/apps")), 1);

    let succeeded = record_success(memory.clone(), 100);
    assert_eq!(succeeded.success_count, 1);
    assert!(succeeded.confidence >= memory.confidence);
    assert_eq!(succeeded.last_used_at, Some(100));

    // 连续失败把置信度压到阈值以下 → 退回 pending（不再自动生效）。
    let mut failing = memory.clone();
    for _ in 0..6 {
        failing = record_failure(failing, 200);
    }
    assert_eq!(failing.failure_count, 6);
    assert!(failing.confidence < CONFIDENCE_SUSPEND_THRESHOLD);
    assert_eq!(failing.status, MemoryStatus::Pending);
}

// -- 状态机 ------------------------------------------------------------------

#[test]
fn the_state_machine_only_allows_declared_transitions() {
    use SessionStatus::*;
    assert!(Created.can_transition_to(Importing));
    assert!(Importing.can_transition_to(Analyzing));
    assert!(Analyzing.can_transition_to(DraftReady));
    assert!(DraftReady.can_transition_to(Confirming));
    assert!(Confirming.can_transition_to(Preflight));
    assert!(Preflight.can_transition_to(Deploying));
    assert!(Deploying.can_transition_to(Succeeded));
    // 预检有阻塞 → 回 needs_input，绝不直接部署。
    assert!(Preflight.can_transition_to(NeedsInput));
    // 输入变化 → 草案失效，回到 analyzing。
    assert!(DraftReady.can_transition_to(Analyzing));

    // 非法跳步。
    assert!(!Created.can_transition_to(Deploying));
    assert!(!DraftReady.can_transition_to(Deploying));
    assert!(!Analyzing.can_transition_to(Confirming));
    assert!(!Succeeded.can_transition_to(Deploying));
    // 不能原地打转。
    assert!(!Analyzing.can_transition_to(Analyzing));
}

#[test]
fn every_status_has_a_stable_string_and_the_full_set_is_present() {
    assert_eq!(SessionStatus::ALL.len(), 12);
    for status in SessionStatus::ALL {
        assert!(!status.label().is_empty());
        assert!(!status.as_str().is_empty());
    }
    assert!(SessionStatus::Succeeded.is_terminal());
    assert!(SessionStatus::RolledBack.is_terminal());
    assert!(!SessionStatus::Deploying.is_terminal());
    assert!(SessionStatus::Deploying.is_active());
}

// -- 输入指纹 ----------------------------------------------------------------

#[test]
fn changing_any_draft_input_changes_the_fingerprint() {
    let base = DraftInputs {
        source_fingerprint: "sha256:abc".to_string(),
        server_id: "srv-1".to_string(),
        capability_hash: "cap-1".to_string(),
        user_description: "Docker + Nginx + HTTPS".to_string(),
        memory_refs: vec!["m1@1".to_string()],
        knowledge_refs: vec!["kb-1@2".to_string()],
        capacity_fingerprint: "cap-req".to_string(),
        policy_fingerprint: "policy-1".to_string(),
    };
    let baseline = base.fingerprint();
    assert_eq!(base.fingerprint(), baseline, "同一输入必须得到同一指纹");

    // Memory 引用变化（顺序无关，但内容变化）→ 指纹变化。
    let mut changed_memory = base.clone();
    changed_memory.memory_refs = vec!["m2@1".to_string()];
    assert_ne!(changed_memory.fingerprint(), baseline);

    // 顺序不影响结果。
    let mut reordered = base.clone();
    reordered.knowledge_refs = vec!["kb-1@2".to_string()];
    reordered.memory_refs = vec!["m1@1".to_string()];
    assert_eq!(reordered.fingerprint(), baseline);

    for mutate in [
        (|inputs: &mut DraftInputs| inputs.source_fingerprint = "sha256:def".to_string())
            as fn(&mut DraftInputs),
        |inputs: &mut DraftInputs| inputs.server_id = "srv-2".to_string(),
        |inputs: &mut DraftInputs| inputs.user_description = "只要静态站点".to_string(),
        |inputs: &mut DraftInputs| inputs.capability_hash = "cap-2".to_string(),
        |inputs: &mut DraftInputs| inputs.capacity_fingerprint = "cap-req-2".to_string(),
        |inputs: &mut DraftInputs| inputs.policy_fingerprint = "policy-2".to_string(),
        |inputs: &mut DraftInputs| inputs.knowledge_refs = vec!["kb-1@3".to_string()],
    ] {
        let mut next = base.clone();
        mutate(&mut next);
        assert_ne!(next.fingerprint(), baseline);
    }
}

#[test]
fn a_draft_is_invalid_once_the_inputs_move() {
    let inputs = DraftInputs {
        source_fingerprint: "sha256:abc".to_string(),
        server_id: "srv-1".to_string(),
        ..DraftInputs::default()
    };
    let mut session = DeploymentSession::new("s1", 1);
    assert!(!draft_is_valid(&session, &inputs), "还没生成过草案");

    session.input_fingerprint = inputs.fingerprint();
    assert!(draft_is_valid(&session, &inputs));

    let mut moved = inputs.clone();
    moved.user_description = "换了需求".to_string();
    assert!(!draft_is_valid(&session, &moved), "输入变了旧草案必须失效");
}

// -- 事件脱敏守卫 ------------------------------------------------------------

#[test]
fn secret_like_text_is_detected_before_writing_events() {
    assert!(looks_like_secret("token=abc123"));
    assert!(looks_like_secret("Bearer abcdef"));
    assert!(looks_like_secret("sk-1234567890"));
    assert!(looks_like_secret("0123456789abcdef0123456789abcdef"));
    assert!(!looks_like_secret("用户选择 Docker + Nginx"));
    assert!(!looks_like_secret("端口 3000，健康检查 /healthz"));
}
