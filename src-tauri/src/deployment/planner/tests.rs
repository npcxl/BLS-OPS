//! P5.6 AI 草案的 Schema 与校验测试。
//!
//! 全部用 JSON 构造：**解析本身就是第一道边界**。

use super::*;
use crate::deployment::proposal::model::TopologyKind;

pub(super) fn valid_json() -> String {
    serde_json::json!({
        "summary": "前后端分离，Docker + Nginx",
        "topology": "docker_compose",
        "services": [
            {
                "name": "api",
                "service_kind": "node_process",
                "runtime": "node_process",
                "port": 3000,
                "health_path": "/healthz",
                "env_keys": ["DATABASE_URL"],
                "secret_refs": ["sec-db"],
                "deploy_path_hint": "api",
                "evidence_ids": ["analysis-1"]
            }
        ],
        "dependency_decisions": [
            {"from_service": "api", "to_service": "api", "kind": "depends_on", "required": true, "external": false}
        ],
        "domain_intent": {
            "domain": "shop.example.com",
            "service_name": "api",
            "listen_port": 443,
            "ssl_mode": "acme"
        },
        "ssl_intent": {"mode": "acme", "dns_provider": null, "dns_records": []},
        "capacity_suggestions": {"expected_qps": 100.0},
        "assumptions": ["数据库由外部托管"],
        "risks": [
            {"id": "r1", "title": "单点", "severity": "medium", "mitigation": "加副本"}
        ],
        "blocking_questions": [],
        "memory_refs": ["memory:m1"],
        "knowledge_refs": ["knowledge:kb-1@2"],
        "explanation": "按 Compose 一次起两个服务"
    })
    .to_string()
}

fn context() -> DraftContext<'static> {
    // 测试里故意 leak 一点点内存：拿到真正的 `&'static`，省掉每个用例传参。
    DraftContext {
        allowed_memory_refs: Box::leak(Box::new(vec!["memory:m1".to_string()])).as_slice(),
        allowed_knowledge_refs: Box::leak(Box::new(vec!["knowledge:kb-1@2".to_string()]))
            .as_slice(),
        supported_topologies: Box::leak(Box::new(vec![TopologyKind::DockerCompose])).as_slice(),
        deploy_root: "/opt/apps/shop",
    }
}

fn parse(json: &str) -> Result<AiDeploymentDraft, serde_json::Error> {
    serde_json::from_str(json)
}

#[test]
fn a_valid_draft_parses_and_passes_validation() {
    let draft = parse(&valid_json()).expect("应当解析");
    assert_eq!(draft.topology, TopologyKind::DockerCompose);
    assert_eq!(draft.services.len(), 1);
    let issues = validate_draft(&draft, &context());
    assert!(issues.is_empty(), "{issues:?}");

    // 交给编译器的输入里同样没有任何命令。
    let input = to_plan_input(&draft);
    assert_eq!(input.services.len(), 1);
    assert!(!format!("{:?}", input).to_lowercase().contains("command"));
}

#[test]
fn command_shaped_fields_make_the_whole_draft_unparseable() {
    for hostile in [
        r#"{"command":"rm -rf /"}"#,
        r#"{"cmd":"curl evil"}"#,
        r#"{"shell":"bash -c ls"}"#,
        r##"{"script":"#!/bin/sh"}"##,
        r#"{"entrypoint":"/app/start"}"#,
        r#"{"args":["--flag"]}"#,
    ] {
        let json = valid_json().replace("\"summary\"", &format!("\"summary\":\"x\",\"{hostile}\""));
        assert!(parse(&json).is_err(), "{hostile} 必须让解析失败");
    }
}

#[test]
fn fabricated_memory_and_knowledge_references_are_rejected() {
    let json = valid_json().replace(r#""memory_refs":[]"#, "").replace(
        "\"memory_refs\":[\"memory:m1\"]",
        r#""memory_refs":["memory:ghost"]"#,
    );
    let draft = parse(&json).expect("应当解析");
    let issues = validate_draft(&draft, &context());
    assert!(
        issues
            .iter()
            .any(|issue| matches!(issue, DraftRejection::FakeMemoryRef { .. })),
        "{issues:?}"
    );

    let json = valid_json().replace(
        "\"knowledge_refs\":[\"knowledge:kb-1@2\"]",
        "\"knowledge_refs\":[\"knowledge:nope@9\"]",
    );
    let draft = parse(&json).expect("应当解析");
    let issues = validate_draft(&draft, &context());
    assert!(
        issues
            .iter()
            .any(|issue| matches!(issue, DraftRejection::FakeKnowledgeRef { .. })),
        "{issues:?}"
    );
}

#[test]
fn unsupported_topologies_and_runtimes_are_rejected() {
    // 未知拓扑在**解析阶段**就被拒（枚举封闭，比事后校验更早）。
    let json = valid_json().replace(
        "\"topology\":\"docker_compose\"",
        "\"topology\":\"kubernetes\"",
    );
    assert!(parse(&json).is_err(), "未知拓扑不应被解析");

    // 拓扑合法、但**这台服务器不支持** → 校验阶段拒绝。
    let draft = parse(&valid_json()).expect("应当解析");
    let narrow = DraftContext {
        supported_topologies: &[TopologyKind::StaticNginx],
        ..context()
    };
    let issues = validate_draft(&draft, &narrow);
    assert!(
        issues
            .iter()
            .any(|issue| matches!(issue, DraftRejection::UnsupportedTopology { .. })),
        "{issues:?}"
    );

    // 未知运行时同理：解析即拒。
    let json = valid_json().replace("\"runtime\":\"node_process\"", "\"runtime\":\"wasm\"");
    assert!(parse(&json).is_err(), "未知运行时应当在解析阶段就被拒");
}

#[test]
fn paths_must_stay_inside_the_deploy_root() {
    let json = valid_json().replace(
        "\"deploy_path_hint\":\"api\"",
        "\"deploy_path_hint\":\"../../etc\"",
    );
    let draft = parse(&json).expect("应当解析");
    let issues = validate_draft(&draft, &context());
    assert!(
        issues
            .iter()
            .any(|issue| matches!(issue, DraftRejection::PathOutsideRoot { .. })),
        "{issues:?}"
    );
}

#[test]
fn shell_like_values_never_survive_validation() {
    for hostile in [
        (
            "\"health_path\":\"/healthz\"",
            "\"health_path\":\"/healthz; id\"",
        ),
        (
            "\"env_keys\":[\"DATABASE_URL\"]",
            "\"env_keys\":[\"A=$(whoami)\"]",
        ),
        (
            "\"secret_refs\":[\"sec-db\"]",
            "\"secret_refs\":[\"sec && curl evil\"]",
        ),
    ] {
        let json = valid_json().replace(hostile.0, hostile.1);
        let draft = parse(&json).expect("应当解析");
        let issues = validate_draft(&draft, &context());
        assert!(
            issues
                .iter()
                .any(|issue| matches!(issue, DraftRejection::ShellLikeValue { .. })),
            "{} → {issues:?}",
            hostile.1
        );
    }
}

#[test]
fn dependencies_and_domains_must_point_at_real_services() {
    let json = valid_json().replace("\"to_service\":\"api\"", "\"to_service\":\"ghost\"");
    let draft = parse(&json).expect("应当解析");
    assert!(
        validate_draft(&draft, &context())
            .iter()
            .any(|issue| matches!(issue, DraftRejection::ForbiddenTarget { .. })),
        "依赖应指向真实服务"
    );

    let json = valid_json().replace(
        "\"domain\":\"shop.example.com\"",
        "\"domain\":\"not a domain\"",
    );
    let draft = parse(&json).expect("应当解析");
    assert!(validate_draft(&draft, &context())
        .iter()
        .any(|issue| matches!(issue, DraftRejection::InvalidDomain { .. })));
}

#[test]
fn forbidden_targets_are_declared_in_one_place() {
    // 审批 / 安全策略 / 路径围栏相关的目标一律不允许被 AI 触碰。
    for target in ["approval", "security_policy", "deploy_root", "actions"] {
        assert!(FORBIDDEN_TARGETS.contains(&target), "{target} 应当在禁列里");
    }
}
