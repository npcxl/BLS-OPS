//! P5.2 规则引擎与 Schema 的单元测试。
//!
//! 六条主线（每一条都对应一条产品承诺）：
//!
//! 1. **结构**：产出必须符合 [`super::checks::PROPOSAL_JSON_SCHEMA`]；缺字段就挡下来。
//! 2. **可复现**：同样输入两次生成逐字节一致（哈希相等）；输入一变哈希就变。
//! 3. **不静默**：知识库冲突、能力未探测、缺关键字段都必须变成 `open_questions`，
//!    且此时**没有可执行工作流**。
//! 4. **事实优先**：服务器没装 Docker，就算知识库偏好 compose 也不能推荐它。
//! 5. **无 shell**：方案里出现命令键 / 命令替换 → `Shell` 违规且挡住计划。
//! 6. **AI 只是建议**：批注要过校验、不合格要留痕、且改不动拓扑。

use serde_json::json;

use super::ai::{AiNote, AiSuggestion, ProposalAdvisor};
use super::capacity::{self, CapacityInput};
use super::checks;
use super::engine::{self, ProposalInputs};
use super::knowledge::{self, KnowledgeQuery};
use super::model::*;
use super::rules::{self, RuleInputs, ServiceFacts};
use super::{facts, workflow};
use crate::capability_probe::{
    BuildToolProfile, DeploymentCapabilities, RuntimeProfile, ServerCapabilityProfile,
    SystemProfile, VersionManagerProfile,
};
use crate::deployment::artifact::model::{
    ArtifactImportTask, ArtifactInspection, BuildStep, EnvKeyGuess, FindingKind, FindingSeverity,
    HealthGuess, HealthKind, ImportProgress, ImportSource, ImportStage, ImportStatus, Language,
    PackageManager, PortGuess, SecurityFinding, SecurityScanReport, ServiceCandidate, StackProfile,
};
use crate::deployment::model::{
    ApplicationKind, ArtifactKind, ArtifactRecord, ArtifactSourceKind, ArtifactStatus,
    CapacityProfile, DeploymentApplication, DeploymentEnvironment, EnvironmentKind,
    EstimationBasis, PortMapping, PortProtocol, ServiceKind, ServiceRelation, ServiceRelationKind,
    ServiceRole, ServiceRuntime, ServiceUnit, SslMode, SslStatus,
};

// -- 脚手架 -----------------------------------------------------------------

fn application() -> DeploymentApplication {
    DeploymentApplication {
        id: "app-1".to_string(),
        server_id: "srv-1".to_string(),
        name: "shop".to_string(),
        description: String::new(),
        application_kind: ApplicationKind::FullStack,
        source_kind: crate::deployment::model::SourceKind::LocalUpload,
        source_ref: String::new(),
        default_branch: "main".to_string(),
        confirmed_project_path: None,
        status: "active".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn environment(kind: EnvironmentKind) -> DeploymentEnvironment {
    DeploymentEnvironment {
        id: "env-1".to_string(),
        application_id: "app-1".to_string(),
        server_id: "srv-1".to_string(),
        name: "prod".to_string(),
        kind,
        deploy_root: "/opt/shop".to_string(),
        capacity_profile_id: None,
        notes: String::new(),
        status: "active".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn service(id: &str, name: &str, kind: ServiceKind, runtime: ServiceRuntime) -> ServiceUnit {
    ServiceUnit {
        id: id.to_string(),
        application_id: "app-1".to_string(),
        environment_id: "env-1".to_string(),
        name: name.to_string(),
        role: match kind {
            ServiceKind::StaticNginx => ServiceRole::Static,
            ServiceKind::JavaJar | ServiceKind::NodeProcess => ServiceRole::Api,
            ServiceKind::DockerImage | ServiceKind::DockerCompose => ServiceRole::Api,
            ServiceKind::ExternalManaged => ServiceRole::Database,
            _ => ServiceRole::Other,
        },
        service_kind: kind,
        runtime,
        deploy_path: Some(format!("/opt/shop/{name}")),
        confirmed_project_id: None,
        confirmed_project_path: None,
        artifact_id: None,
        status: "configured".to_string(),
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

fn static_service() -> ServiceUnit {
    service(
        "svc-web",
        "web",
        ServiceKind::StaticNginx,
        ServiceRuntime::StaticNginx {
            site_name: "web".to_string(),
            root: "/opt/shop/web".to_string(),
        },
    )
}

fn node_service() -> ServiceUnit {
    service(
        "svc-api",
        "api",
        ServiceKind::NodeProcess,
        ServiceRuntime::NativeProcess {
            entry: "node".to_string(),
            args: Vec::new(),
        },
    )
}

fn compose_service() -> ServiceUnit {
    service(
        "svc-stack",
        "stack",
        ServiceKind::DockerCompose,
        ServiceRuntime::DockerCompose {
            compose_path: "/opt/shop/docker-compose.yml".to_string(),
            project_name: "shop".to_string(),
            service: "api".to_string(),
        },
    )
}

fn artifact(id: &str) -> ArtifactRecord {
    ArtifactRecord {
        id: id.to_string(),
        application_id: "app-1".to_string(),
        service_unit_id: None,
        kind: ArtifactKind::Zip,
        source_kind: ArtifactSourceKind::LocalPath,
        source_ref: "/local/artifact.zip".to_string(),
        file_name: Some("artifact.zip".to_string()),
        size_bytes: Some(1024),
        sha256: Some("a".repeat(64)),
        docker_digest: None,
        version_label: Some("v1".to_string()),
        built_at: None,
        checksum_verified: false,
        status: ArtifactStatus::Ready,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

fn capability(
    docker: Option<bool>,
    nginx: Option<bool>,
    systemd: Option<bool>,
) -> ServerCapabilityProfile {
    ServerCapabilityProfile {
        system: SystemProfile {
            family: "linux".to_string(),
            os: "Ubuntu 24.04".to_string(),
            arch: "x86_64".to_string(),
            kernel: "6.8".to_string(),
            init_system: "systemd".to_string(),
            user: "root".to_string(),
            sudo: Some(true),
            package_manager: "apt".to_string(),
            security_module: "apparmor".to_string(),
            cgroup_version: "v2".to_string(),
        },
        runtimes: RuntimeProfile {
            node: Some("20.11".to_string()),
            ..RuntimeProfile::default()
        },
        version_managers: VersionManagerProfile::default(),
        build_tools: BuildToolProfile::default(),
        deployment: DeploymentCapabilities {
            docker,
            docker_compose: docker,
            nginx,
            systemd,
            ..DeploymentCapabilities::default()
        },
        warnings: Vec::new(),
    }
}

fn capacity_profile(peak_qps: Option<f64>) -> CapacityProfile {
    CapacityProfile {
        id: "cap-1".to_string(),
        environment_id: "env-1".to_string(),
        expected_dau: Some(10_000),
        concurrent_users: Some(200),
        peak_qps,
        avg_qps: Some(20.0),
        websocket_connections: None,
        response_target_ms: None,
        monthly_bandwidth_gb: Some(300.0),
        monthly_upload_gb: None,
        monthly_data_growth_gb: Some(20.0),
        availability_target: Some("99.9".to_string()),
        rpo_minutes: Some(1440),
        rto_minutes: Some(60),
        monthly_budget: Some(200.0),
        budget_currency: Some("CNY".to_string()),
        estimation_basis: EstimationBasis::UserProvided,
        assumptions: Vec::new(),
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

struct Params {
    environment: Option<DeploymentEnvironment>,
    services: Vec<ServiceUnit>,
    relations: Vec<ServiceRelation>,
    artifacts: Vec<ArtifactRecord>,
    facts: Vec<ServiceFacts>,
    capability: Option<ServerCapabilityProfile>,
    capacity: Option<CapacityProfile>,
    policy: SecurityPolicy,
    observed: Option<ServerResourceFacts>,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            environment: Some(environment(EnvironmentKind::Production)),
            services: vec![static_service()],
            relations: Vec::new(),
            artifacts: Vec::new(),
            facts: Vec::new(),
            capability: Some(capability(Some(true), Some(true), Some(true))),
            capacity: Some(capacity_profile(Some(80.0))),
            policy: SecurityPolicy::default(),
            observed: Some(ServerResourceFacts {
                cpu_cores: 8.0,
                memory_mb: 16_384,
                disk_free_gb: 200.0,
            }),
        }
    }
}

fn inputs(params: Params) -> ProposalInputs {
    ProposalInputs {
        application: application(),
        environment: params.environment,
        server_id: "srv-1".to_string(),
        services: params.services,
        relations: params.relations,
        artifacts: params.artifacts,
        domains: Vec::new(),
        facts: params.facts,
        capability: params.capability,
        capacity: params.capacity,
        policy: params.policy,
        observed: params.observed,
        now: 1_700_000_000_000,
    }
}

/// 一个可控的假提供方（**只在测试里**：真实提供方属于装配层）。
struct FakeAdvisor {
    suggestion: Result<AiSuggestion, String>,
}

impl ProposalAdvisor for FakeAdvisor {
    fn model(&self) -> String {
        "fake-model-1".to_string()
    }

    fn review(&self, _prompt: &super::AiPrompt) -> Result<AiSuggestion, String> {
        self.suggestion.clone()
    }
}

fn clean_advisor() -> FakeAdvisor {
    FakeAdvisor {
        suggestion: Ok(AiSuggestion {
            notes: vec![AiNote {
                text: "建议把备份演练写进上线清单，目前方案只覆盖了版本回滚。".to_string(),
                target: Some("rollback".to_string()),
            }],
            alternatives: vec!["如果后续要做多机冗余，可以把静态站点先放到对象存储。".to_string()],
        }),
    }
}

// -- 1. 结构 -----------------------------------------------------------------

#[test]
fn proposal_matches_its_json_schema() {
    let outcome = engine::generate(&inputs(Params::default()), None);
    let value = serde_json::to_value(&outcome.proposal).expect("serialize");
    let validation = checks::validate_schema(&value);
    assert!(
        validation.violations.is_empty(),
        "方案必须符合自己的 schema：{:?}",
        validation.violations
    );

    // schema 的必需字段与实际产出一一对应（防止 schema 漂移）。
    let schema: serde_json::Value =
        serde_json::from_str(checks::PROPOSAL_JSON_SCHEMA).expect("schema 是合法 JSON");
    let required: Vec<String> = schema["required"]
        .as_array()
        .expect("required")
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect();
    let actual = value.as_object().expect("object");
    for key in &required {
        assert!(actual.contains_key(key), "schema 要求 {key}，产出里没有");
    }
    assert_eq!(
        value["schema_version"],
        json!(super::PROPOSAL_SCHEMA_VERSION)
    );
}

#[test]
fn schema_validation_rejects_a_broken_proposal() {
    let mut value = json!({ "schema_version": "deployment-proposal/1" });
    let validation = checks::validate_schema(&value);
    assert!(validation.blocks_plan());
    assert!(validation
        .violations
        .iter()
        .any(|violation| violation.kind == ViolationKind::Schema));

    // 结构版本对不上也要拦（旧 schema 的方案不许拿去执行）。
    value = json!({
        "schema_version": "deployment-proposal/0",
        "recommended_topology": { "kind": "static_nginx", "name": "x", "feasible": true },
        "capacity_recommendation": { "vcpu": 1, "memory_mb": 1, "disk_gb": 1, "headroom_percent": 30 },
        "workflow": { "nodes": [], "edges": [] },
        "rollback_strategy": { "automatic": false, "steps": [] },
        "validation": { "checks": [], "violations": [] },
        "summary": { "headline": "x", "statements": [] },
    });
    assert!(checks::validate_schema(&value).blocks_plan());
}

// -- 2. 可复现 ---------------------------------------------------------------

#[test]
fn the_same_input_produces_the_same_hashes() {
    let first = engine::generate(&inputs(Params::default()), None);
    let second = engine::generate(&inputs(Params::default()), None);
    assert_eq!(
        first.proposal.fingerprint.input_hash,
        second.proposal.fingerprint.input_hash
    );
    assert_eq!(
        first.proposal.fingerprint.output_hash, second.proposal.fingerprint.output_hash,
        "同样输入必须逐字节可复现"
    );
    assert_eq!(first.ready, second.ready);
    assert_eq!(
        first.proposal.fingerprint.engine_version,
        super::ENGINE_VERSION
    );
    assert_eq!(
        first.proposal.fingerprint.knowledge_version,
        super::KNOWLEDGE_VERSION
    );

    // 输入变一点，两个哈希都得变。
    let mut changed = Params::default();
    changed.capacity = Some(capacity_profile(Some(800.0)));
    let third = engine::generate(&inputs(changed), None);
    assert_ne!(
        first.proposal.fingerprint.input_hash,
        third.proposal.fingerprint.input_hash
    );
    assert_ne!(
        first.proposal.fingerprint.output_hash,
        third.proposal.fingerprint.output_hash
    );
}

// -- 3. 不静默：缺字段 / 冲突 ------------------------------------------------

#[test]
fn a_missing_environment_blocks_the_plan_and_leaves_no_workflow() {
    let mut params = Params::default();
    params.environment = None;
    let outcome = engine::generate(&inputs(params), None);

    assert!(!outcome.ready);
    assert!(
        outcome.proposal.workflow.nodes.is_empty(),
        "缺关键字段时绝不能给出可执行计划"
    );
    assert!(outcome.proposal.workflow.edges.is_empty());
    assert!(outcome
        .open_questions
        .iter()
        .any(|question| question.id == "q-environment"));
    // 挡在这里的是"必须回答的问题"，不是校验违规 —— 两者都要能表达出来。
    assert!(outcome
        .open_questions
        .iter()
        .any(|question| question.severity == UnknownSeverity::BlocksPlan));
}

#[test]
fn production_without_a_capacity_profile_asks_instead_of_guessing() {
    let mut params = Params::default();
    params.capacity = None;
    let production = engine::generate(&inputs(params), None);
    assert!(!production.ready);
    assert!(production
        .open_questions
        .iter()
        .any(|question| question.id == "q-capacity-profile"));
    assert!(production.proposal.workflow.nodes.is_empty());

    // 同一个应用放在开发环境里就不该被挡：缺数据只是缺数据。
    let mut dev = Params::default();
    dev.capacity = None;
    dev.environment = Some(environment(EnvironmentKind::Development));
    let development = engine::generate(&inputs(dev), None);
    assert!(
        !development
            .open_questions
            .iter()
            .any(|question| question.severity == UnknownSeverity::BlocksPlan),
        "开发环境不该因为没填问卷就挡住计划"
    );
}

#[test]
fn an_unresolved_knowledge_conflict_is_surfaced_and_blocks_the_plan() {
    // 单服务 compose：知识库一边说"compose 成套管理"、一边说"单进程别上容器"。
    let mut params = Params::default();
    params.services = vec![compose_service()];
    params.capability = Some(capability(None, Some(true), Some(true)));
    let outcome = engine::generate(&inputs(params), None);

    assert!(
        !outcome.proposal.knowledge_conflicts.is_empty(),
        "知识库冲突必须被摆出来"
    );
    let unresolved: Vec<&KnowledgeConflict> = outcome
        .proposal
        .knowledge_conflicts
        .iter()
        .filter(|conflict| conflict.resolution == ConflictResolution::Unresolved)
        .collect();
    assert!(!unresolved.is_empty(), "没装 Docker 时冲突无法用事实裁定");
    assert!(outcome
        .open_questions
        .iter()
        .any(|question| question.id.starts_with("q-conflict")));
    assert!(!outcome.ready);
    assert!(outcome.proposal.workflow.nodes.is_empty());
}

#[test]
fn a_server_fact_resolves_the_conflict_instead_of_the_user() {
    // 装了 Docker：冲突应当被"实时事实"直接裁定，不该再问用户。
    let mut params = Params::default();
    params.services = vec![compose_service()];
    params.capability = Some(capability(Some(true), Some(true), Some(true)));
    let outcome = engine::generate(&inputs(params), None);
    let resolved: Vec<&KnowledgeConflict> = outcome
        .proposal
        .knowledge_conflicts
        .iter()
        .filter(|conflict| conflict.resolution == ConflictResolution::ServerFactWins)
        .collect();
    assert!(
        !resolved.is_empty(),
        "有事实就该用事实裁定：{:?}",
        outcome.proposal.knowledge_conflicts
    );
    for conflict in resolved {
        assert!(!conflict.resolved_by.is_empty(), "裁定必须带依据");
    }
    assert!(!outcome
        .open_questions
        .iter()
        .any(|question| question.id.starts_with("q-conflict")));
}

// -- 4. 事实优先 -------------------------------------------------------------

#[test]
fn missing_docker_makes_the_knowledge_preference_feasible_only_as_an_alternative() {
    let mut params = Params::default();
    params.services = vec![static_service(), compose_service()];
    // 没装 Docker，但装了 Nginx。
    params.capability = Some(capability(Some(false), Some(true), Some(true)));
    let outcome = engine::generate(&inputs(params), None);

    let recommended = &outcome.proposal.recommended_topology;
    assert_ne!(
        recommended.kind,
        TopologyKind::DockerCompose,
        "服务器没装 Docker，绝不能推荐 compose"
    );

    let compose = outcome
        .proposal
        .alternative_topologies
        .iter()
        .find(|option| option.kind == TopologyKind::DockerCompose)
        .expect("compose 应当作为备选出现（并说明为什么不行）");
    assert!(!compose.feasible);
    assert!(!compose.blockers.is_empty());
    assert!(compose
        .blockers
        .iter()
        .any(|blocker| blocker.contains("deployment.docker")));

    // 必须解释"为什么没听知识库的"。
    assert!(outcome
        .proposal
        .summary
        .statements
        .iter()
        .any(|statement| statement.id == "topo-fact-overrides-knowledge"));
}

#[test]
fn an_unprobed_capability_is_flagged_rather_than_assumed() {
    let mut params = Params::default();
    params.capability = None;
    let outcome = engine::generate(&inputs(params), None);
    assert!(outcome
        .open_questions
        .iter()
        .any(|question| question.id == "q-capability"));
    assert!(outcome
        .proposal
        .recommended_topology
        .evidence
        .iter()
        .any(|evidence| evidence.class == EvidenceClass::Unknown));
}

// -- 5. 无 shell -------------------------------------------------------------

#[test]
fn shell_like_content_is_rejected_and_blocks_the_plan() {
    let mut value = json!({
        "schema_version": "deployment-proposal/1",
        "workflow": {
            "nodes": [
                { "node_key": "run", "params_json": "{\"command\":\"rm -rf /\"}" }
            ],
            "edges": []
        }
    });
    let validation = checks::validate_no_shell(&value);
    assert!(validation.blocks_plan());
    assert!(validation
        .violations
        .iter()
        .all(|violation| violation.kind == ViolationKind::Shell));
    // 禁用键藏在节点的 params_json 里：定位到的是**节点**，说明里带上是哪个键。
    assert!(validation
        .violations
        .iter()
        .any(|violation| violation.location == "run" && violation.detail.contains("command")));

    // 命令替换：在**会进入部署动作**的位置必须拦。
    value = json!({ "domains": [{ "domain": "shop.example.com", "path_prefix": "/$(whoami)" }] });
    assert!(checks::validate_no_shell(&value).blocks_plan());

    // 但散文里的反引号不拦：风险说明里引用一个文档名不该挡下生产方案
    // （假阳性比漏报更伤信任 —— 用户会学会无视警告）。
    let prose = json!({
        "risks": [{ "title": "见 nginx 文档 `try_files`", "mitigation": "参考官方文档" }],
        "knowledge_references": [{ "source": "Docker 官方文档：`name@sha256:…`" }]
    });
    assert!(
        !checks::validate_no_shell(&prose).blocks_plan(),
        "散文里的反引号不该被当成命令"
    );
    // 但禁用键在哪儿都不行，包括散文对象里。
    // 注意 `args` **不在**禁用键里：它是 P5.0 模型里逐项校验过的合法字段，
    // 真正该禁 `args` 的地方是计划节点的 params_json（上面那条用例）。
    let banned_in_prose = json!({ "summary": { "headline": "x", "command": "rm -rf /" } });
    assert!(checks::validate_no_shell(&banned_in_prose).blocks_plan());
    let legal_args =
        json!({ "services": [{ "runtime": { "kind": "native_process", "args": [] } }] });
    assert!(
        !checks::validate_no_shell(&legal_args).blocks_plan(),
        "NativeProcess.args 是模型的一部分，不该被当成自由命令"
    );

    // 正常方案一个都不该报。
    let outcome = engine::generate(&inputs(Params::default()), None);
    let clean = serde_json::to_value(&outcome.proposal).expect("serialize");
    assert!(checks::validate_no_shell(&clean).violations.is_empty());
}

#[test]
fn generated_node_params_pass_the_p5_0_validator() {
    let mut params = Params::default();
    params.services = vec![static_service(), node_service()];
    let outcome = engine::generate(&inputs(params), None);
    assert!(!outcome.proposal.workflow.nodes.is_empty());
    for node in &outcome.proposal.workflow.nodes {
        crate::deployment::validate::validate_params_json(&node.params_json)
            .unwrap_or_else(|error| panic!("节点 {} 的参数不合规：{error}", node.node_key));
        crate::deployment::validate::validate_node_key(&node.node_key).expect("节点 key 合法");
    }
}

// -- 工作流 -----------------------------------------------------------------

#[test]
fn the_workflow_is_a_valid_dag_with_a_failure_only_rollback() {
    let mut params = Params::default();
    params.services = vec![static_service(), node_service()];
    let outcome = engine::generate(&inputs(params), None);
    let workflow = &outcome.proposal.workflow;
    assert!(
        !workflow.notes.iter().any(|note| note.id == "wf-invalid"),
        "工作流自检没过：{:?}",
        workflow.notes
    );
    assert!(
        workflow.nodes.len() > 4,
        "节点 {} 个；unknowns={:?}；violations={:?}",
        workflow.nodes.len(),
        outcome.proposal.unknowns,
        outcome.proposal.validation.violations
    );

    // 用 P5.0 的图校验器再验一遍（生成时已自检，这里是回归钉子）。
    let graph = crate::deployment::model::DeploymentPlanGraph {
        plan: crate::deployment::model::DeploymentPlan {
            id: String::new(),
            application_id: "app-1".to_string(),
            environment_id: "env-1".to_string(),
            name: "plan".to_string(),
            version: 1,
            status: crate::deployment::model::PlanStatus::Draft,
            proposal_source: crate::deployment::model::ProposalSource::Template,
            risk_level: workflow::highest_risk(&workflow.nodes),
            notes: String::new(),
            created_at: 0,
            updated_at: 0,
        },
        nodes: workflow.nodes.clone(),
        edges: workflow.edges.clone(),
    };
    crate::deployment::validate::validate_plan_graph(&graph).expect("生成的图必须是合法 DAG");

    // 回滚节点只能从失败边进入。
    let rollback = workflow
        .nodes
        .iter()
        .find(|node| node.node_key == "restore_release")
        .expect("应当有回滚节点");
    let incoming: Vec<&crate::deployment::model::PlanEdge> = workflow
        .edges
        .iter()
        .filter(|edge| edge.to_node_id == rollback.id)
        .collect();
    assert!(!incoming.is_empty());
    assert!(incoming
        .iter()
        .all(|edge| edge.condition == crate::deployment::model::EdgeCondition::OnFailure));

    // 节点 id 是确定性的（哈希要复现，不能用 uuid）。
    assert_eq!(rollback.id, rollback.node_key);
}

#[test]
fn self_hosted_database_adds_a_migration_node_that_requires_approval() {
    let mut params = Params::default();
    let mut database = service(
        "svc-db",
        "db",
        ServiceKind::DockerCompose,
        ServiceRuntime::DockerCompose {
            compose_path: "/opt/shop/docker-compose.yml".to_string(),
            project_name: "shop".to_string(),
            service: "db".to_string(),
        },
    );
    database.role = ServiceRole::Database;
    params.services = vec![static_service(), database];
    let outcome = engine::generate(&inputs(params), None);

    let migration = outcome
        .proposal
        .workflow
        .nodes
        .iter()
        .find(|node| node.node_key == "database_migration")
        .unwrap_or_else(|| {
            panic!(
                "自建数据库必须有迁移节点；当前 {} 个节点，unknowns={:?}，violations={:?}，notes={:?}",
                outcome.proposal.workflow.nodes.len(),
                outcome.proposal.unknowns,
                outcome.proposal.validation.violations,
                outcome.proposal.workflow.notes
            )
        });
    assert!(migration.approval_required);
    assert!(outcome
        .proposal
        .approvals
        .iter()
        .any(|approval| approval.node_key.as_deref() == Some("database_migration")));
    assert!(outcome
        .proposal
        .risks
        .iter()
        .any(|risk| risk.id == "risk-db-migration" && risk.blocks_approval));
}

// -- 容量 -------------------------------------------------------------------

#[test]
fn peak_qps_is_a_fact_when_given_and_an_inference_when_derived() {
    let knowledge = knowledge::retrieve(&KnowledgeQuery {
        languages: vec!["node".to_string()],
        service_kinds: vec!["node_process".to_string()],
        tags: vec!["capacity".to_string()],
        production_like: true,
    });

    let profile = capacity_profile(Some(120.0));
    let estimate = capacity::estimate(&CapacityInput {
        profile: Some(&profile),
        production_like: true,
        environment_name: "prod",
        service_count: 1,
        containers: false,
        jvm: false,
        observed: None,
        min_headroom_percent: 30,
        require_backup: true,
        knowledge: &knowledge,
    });
    assert_eq!(estimate.recommendation.peak_qps, Some(120.0));
    assert_eq!(estimate.recommendation.peak_qps_basis, EvidenceClass::Fact);
    assert!(estimate.recommendation.assumptions.is_empty());
    assert!(estimate.recommendation.headroom_percent >= 30);
    assert!(estimate.recommendation.vcpu > 0.0);

    // 只有 DAU 可用：给出估算 + 显式假设，而不是拒绝。
    // （问卷里只要填了平均值或并发，就会优先用更精确的那一档 —— 所以这里
    //  把更精确的字段清掉，专门验证"只剩 DAU 时"的行为。）
    let mut derived = capacity_profile(None);
    derived.avg_qps = None;
    derived.concurrent_users = None;
    let estimate = capacity::estimate(&CapacityInput {
        profile: Some(&derived),
        production_like: true,
        environment_name: "prod",
        service_count: 1,
        containers: false,
        jvm: false,
        observed: None,
        min_headroom_percent: 30,
        require_backup: true,
        knowledge: &knowledge,
    });
    let peak = estimate.recommendation.peak_qps.expect("应当估算出峰值");
    // 10000 DAU × 5% = 500 并发 ÷ 0.5 秒 = 1000 QPS。
    assert!((peak - 1000.0).abs() < 1.0, "估算值 {peak}");
    assert_eq!(
        estimate.recommendation.peak_qps_basis,
        EvidenceClass::Inference
    );
    assert!(estimate
        .recommendation
        .assumptions
        .iter()
        .any(|assumption| assumption.id == "as-dau-concurrency"));
    // 每条假设都必须写清"假设不成立会怎样"。
    assert!(estimate
        .recommendation
        .assumptions
        .iter()
        .all(|assumption| !assumption.if_wrong.trim().is_empty()));
}

#[test]
fn insufficient_server_resources_become_a_violation_not_a_warning() {
    let mut params = Params::default();
    params.services = vec![node_service()];
    params.observed = Some(ServerResourceFacts {
        cpu_cores: 0.5,
        memory_mb: 256,
        disk_free_gb: 1.0,
    });
    let outcome = engine::generate(&inputs(params), None);
    assert_eq!(
        outcome.proposal.capacity_recommendation.fits_on_server,
        Some(false)
    );
    assert!(outcome
        .proposal
        .risks
        .iter()
        .any(|risk| risk.id == "risk-capacity"));
    assert!(outcome
        .proposal
        .validation
        .violations
        .iter()
        .any(|violation| violation.kind == ViolationKind::Capability));
    assert!(!outcome.approvable);
}

// -- 审批 / 策略 -------------------------------------------------------------

#[test]
fn production_always_requires_a_human_approval_and_the_policy_cannot_be_loosened() {
    let mut params = Params::default();
    params.policy.production_requires_approval = false;
    params.policy.forbid_secrets_in_artifact = false;
    let outcome = engine::generate(&inputs(params), None);

    let approval = outcome
        .proposal
        .approvals
        .iter()
        .find(|approval| approval.id == "approval-production-deploy")
        .expect("生产部署必须有方案级审批");
    assert!(approval.required, "审批不允许被关掉");
    assert!(outcome
        .proposal
        .validation
        .checks
        .iter()
        .any(|check| check.id == "policy-hardened"));

    let (hardened, downgraded) = SecurityPolicy {
        production_requires_approval: false,
        forbid_secrets_in_artifact: false,
        min_headroom_percent: 0,
        ..SecurityPolicy::default()
    }
    .hardened();
    assert!(hardened.production_requires_approval);
    assert!(hardened.forbid_secrets_in_artifact);
    assert!(hardened.min_headroom_percent >= 10);
    assert_eq!(downgraded.len(), 3);
}

#[test]
fn a_high_availability_target_on_a_single_node_is_a_blocking_risk() {
    let outcome = engine::generate(&inputs(Params::default()), None);
    let risk = outcome
        .proposal
        .risks
        .iter()
        .find(|risk| risk.id == "risk-single-node-ha")
        .expect("99.9% + 单机必须报警");
    assert!(risk.blocks_approval);
    assert!(!risk.evidence.is_empty());
    assert!(!outcome.approvable);
}

#[test]
fn secrets_inside_an_artifact_block_approval_with_a_reason() {
    let mut params = Params::default();
    params.facts = vec![ServiceFacts {
        service_unit_id: "svc-web".to_string(),
        ports: vec![PortMapping {
            host_port: 80,
            container_port: 80,
            protocol: PortProtocol::Tcp,
        }],
        health_target: Some("/".to_string()),
        env_keys: Vec::new(),
        artifact_blocked: true,
        artifact_blocked_reason: Some("制品里有私钥".to_string()),
    }];
    let outcome = engine::generate(&inputs(params), None);
    let violation = outcome
        .proposal
        .validation
        .violations
        .iter()
        .find(|violation| violation.kind == ViolationKind::Secret)
        .expect("必须报 Secret 违规");
    assert!(!violation.blocks_plan, "计划可以看，但不能批");
    assert!(violation.blocks_approval);
    assert!(violation.detail.contains("私钥"));
    assert!(!outcome.approvable);
}

#[test]
fn production_domains_without_tls_are_flagged() {
    let mut input = inputs(Params::default());
    input.domains = vec![crate::deployment::model::DomainBinding {
        id: "dom-1".to_string(),
        environment_id: "env-1".to_string(),
        service_unit_id: Some("svc-web".to_string()),
        domain: "shop.example.com".to_string(),
        listen_port: 80,
        path_prefix: "/".to_string(),
        dns_credential_ref: None,
        dns_status: crate::deployment::model::DnsStatus::Unknown,
        dns_checked_at: None,
        ssl_mode: SslMode::None,
        ssl_status: SslStatus::NotApplicable,
        ssl_expires_at: None,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }];
    let outcome = engine::generate(&input, None);
    assert!(outcome
        .proposal
        .validation
        .violations
        .iter()
        .any(|violation| violation.kind == ViolationKind::Risk
            && violation.location == "shop.example.com"));
    assert!(outcome
        .proposal
        .risks
        .iter()
        .any(|risk| risk.id == "risk-no-tls"));
    assert!(!outcome.approvable);
}

// -- 知识库 -----------------------------------------------------------------

#[test]
fn knowledge_retrieval_is_deterministic_and_topic_specific() {
    let query = KnowledgeQuery {
        languages: vec!["node".to_string()],
        service_kinds: vec!["node_process".to_string()],
        tags: vec!["single-service".to_string(), "simple".to_string()],
        production_like: false,
    };
    let first = knowledge::retrieve(&query);
    let second = knowledge::retrieve(&query);
    assert_eq!(first.references, second.references);
    assert!(first
        .references
        .iter()
        .any(|reference| reference.entry_id == "kb-node-process"));
    // 通用条目（容量口径、安全纪律）任何查询都带上。
    assert!(first
        .references
        .iter()
        .any(|reference| reference.entry_id == "kb-secrets-hygiene"));
    // 单服务时不该命中"多服务用 compose"这条。
    assert!(!first
        .references
        .iter()
        .any(|reference| reference.entry_id == "kb-compose-multi"));
    assert!(first
        .preferred
        .iter()
        .any(|(kind, _, _)| *kind == TopologyKind::SystemdProcesses));
}

#[test]
fn a_resolved_conflict_records_who_resolved_it() {
    let query = KnowledgeQuery {
        languages: Vec::new(),
        service_kinds: vec!["docker_compose".to_string()],
        tags: vec!["self-hosted".to_string(), "database".to_string()],
        production_like: true,
    };
    let known = knowledge::retrieve(&query);
    assert!(
        !known.conflicts.is_empty(),
        "这套查询应当命中自带数据库与外部托管的冲突"
    );

    let profile = capability(Some(true), Some(true), Some(true));
    let resolved = knowledge::resolve_conflicts(
        known.conflicts.clone(),
        Some(&profile),
        &SecurityPolicy::default(),
    );
    assert!(resolved.iter().all(|conflict| {
        conflict.resolution != ConflictResolution::Unresolved || !conflict.explanation.is_empty()
    }));
    // 生产 + 策略要求备份 → 外部托管那条胜出，并且带依据。
    let external = resolved
        .iter()
        .find(|conflict| conflict.topic == "topology.external")
        .expect("应当有 topology.external 冲突");
    assert_eq!(external.resolution, ConflictResolution::PolicyWins);
    assert!(!external.resolved_by.is_empty());
}

// -- AI ---------------------------------------------------------------------

#[test]
fn an_ai_note_can_be_added_but_never_changes_the_decision() {
    let without = engine::generate(&inputs(Params::default()), None);
    let advisor = clean_advisor();
    let with_ai = engine::generate(&inputs(Params::default()), Some(&advisor));

    assert_eq!(
        without.proposal.recommended_topology.kind, with_ai.proposal.recommended_topology.kind,
        "AI 不允许改动推荐形态"
    );
    assert_eq!(
        without.proposal.workflow.nodes.len(),
        with_ai.proposal.workflow.nodes.len()
    );
    assert_eq!(without.proposal.approvals, with_ai.proposal.approvals);

    let review = with_ai.proposal.ai_review.expect("应当有 AI 记录");
    assert_eq!(review.model, "fake-model-1");
    assert_eq!(review.prompt_version, super::PROMPT_VERSION);
    assert_eq!(review.prompt_hash.len(), 64);
    assert_eq!(review.accepted, 2);
    assert!(review.rejected.is_empty());
    assert!(with_ai
        .proposal
        .summary
        .statements
        .iter()
        .any(|statement| statement.id.starts_with("ai-")
            && statement.class == EvidenceClass::Recommendation));
    assert_eq!(
        with_ai.proposal.fingerprint.model.as_deref(),
        Some("fake-model-1")
    );
}

#[test]
fn an_ai_note_that_contains_a_command_is_rejected_and_recorded() {
    let advisor = FakeAdvisor {
        suggestion: Ok(AiSuggestion {
            notes: vec![
                AiNote {
                    text: "直接执行 rm -rf /opt/shop/old 清理旧版本即可。".to_string(),
                    target: Some("rollback".to_string()),
                },
                AiNote {
                    text: "建议把健康检查的超时从 5 秒调到 3 秒。".to_string(),
                    target: Some("topology".to_string()),
                },
            ],
            alternatives: Vec::new(),
        }),
    };
    let outcome = engine::generate(&inputs(Params::default()), Some(&advisor));
    let review = outcome.proposal.ai_review.expect("应当有 AI 记录");
    assert_eq!(review.accepted, 1);
    assert_eq!(review.rejected.len(), 1);
    assert!(review.rejected[0].text.contains("rm -rf"));
    assert!(review.rejected[0].reason.contains("可执行片段"));
    // 被拒的批注不许出现在方案正文里。
    assert!(!outcome
        .proposal
        .summary
        .statements
        .iter()
        .any(|statement| statement.text.contains("rm -rf")));
}

#[test]
fn an_advisor_failure_is_recorded_rather_than_silently_dropped() {
    let advisor = FakeAdvisor {
        suggestion: Err("provider timeout".to_string()),
    };
    let outcome = engine::generate(&inputs(Params::default()), Some(&advisor));
    let review = outcome.proposal.ai_review.expect("失败也要留痕");
    assert_eq!(review.accepted, 0);
    assert_eq!(review.rejected.len(), 1);
    assert!(review.rejected[0].reason.contains("timeout"));
}

#[test]
fn without_an_advisor_the_proposal_is_still_complete_and_says_so() {
    let outcome = engine::generate(&inputs(Params::default()), None);
    assert!(outcome.proposal.ai_review.is_none());
    assert!(outcome.proposal.fingerprint.model.is_none());
    assert!(outcome.ready, "没有 AI 也必须能出完整方案");
    assert!(!outcome.proposal.workflow.nodes.is_empty());
    // AI 文本校验：空文本与非命令文本的边界。
    assert!(checks::validate_ai_text("   ").is_err());
    assert!(checks::validate_ai_text("把备份演练写进上线清单。").is_ok());
    assert!(checks::validate_ai_text("运行 `ls`").is_err());
}

// -- 规则引擎直测 -----------------------------------------------------------

#[test]
fn rules_prefer_the_simplest_feasible_topology() {
    // 一个静态 + 一个 Node：两族都装了能力，单机首选应当是 systemd（比容器少活动部件）。
    let mut params = Params::default();
    params.services = vec![static_service(), node_service()];
    let outcome = engine::generate(&inputs(params), None);
    let recommended = outcome.proposal.recommended_topology.kind;
    assert!(
        matches!(
            recommended,
            TopologyKind::StaticNginx | TopologyKind::SystemdProcesses
        ),
        "不该为一个静态站 + 一个进程引入容器：{recommended:?}"
    );
    assert!(
        !outcome.proposal.alternative_topologies.is_empty()
            || outcome.proposal.recommended_topology.feasible,
        "备选方案要么存在，要么已经是最优"
    );
}

#[test]
fn rules_output_is_stable_for_the_same_inputs() {
    let mut params = Params::default();
    params.services = vec![static_service(), node_service()];
    let profile = capability(Some(true), Some(true), Some(true));
    let query = KnowledgeQuery {
        languages: vec!["node".to_string(), "static".to_string()],
        service_kinds: vec!["node_process".to_string(), "static_nginx".to_string()],
        tags: vec!["multi-service".to_string()],
        production_like: true,
    };
    let known = knowledge::retrieve(&query);
    let conflicts = knowledge::resolve_conflicts(
        known.conflicts.clone(),
        Some(&profile),
        &SecurityPolicy::default(),
    );
    let capacity_profile_value = capacity_profile(Some(80.0));
    let estimate = capacity::estimate(&CapacityInput {
        profile: Some(&capacity_profile_value),
        production_like: true,
        environment_name: "prod",
        service_count: 2,
        containers: false,
        jvm: false,
        observed: None,
        min_headroom_percent: 30,
        require_backup: true,
        knowledge: &known,
    });

    let environment_value = environment(EnvironmentKind::Production);
    let build = || {
        rules::plan(&RuleInputs {
            application_id: "app-1".to_string(),
            environment: Some(&environment_value),
            server_id: "srv-1".to_string(),
            services: &params.services,
            relations: &params.relations,
            artifacts: &params.artifacts,
            domains: &[],
            facts: &[],
            capability: Some(&profile),
            capacity: &estimate,
            knowledge: &known,
            policy: &SecurityPolicy::default(),
            production_like: true,
            conflicts: &conflicts,
        })
    };
    let first = build();
    let second = build();
    assert_eq!(
        first.topology.recommended.id,
        second.topology.recommended.id
    );
    assert_eq!(first.workflow.nodes.len(), second.workflow.nodes.len());
    assert_eq!(
        serde_json::to_string(&first.workflow.nodes).expect("a"),
        serde_json::to_string(&second.workflow.nodes).expect("b")
    );
    assert_eq!(first.approvals.len(), second.approvals.len());
}

#[test]
fn dependency_declaration_gap_is_reported_as_a_question() {
    let mut params = Params::default();
    let mut external = service(
        "svc-cache",
        "cache",
        ServiceKind::ExternalManaged,
        ServiceRuntime::External {
            endpoint: "127.0.0.1:6379".to_string(),
        },
    );
    external.role = ServiceRole::Cache;
    params.services = vec![node_service(), external];
    let outcome = engine::generate(&inputs(params), None);
    assert!(outcome
        .proposal
        .unknowns
        .iter()
        .any(|question| question.id == "q-dep-cache"));
    // 依赖没声明时，工作流里不该出现依赖检查以外的编排假设。
    assert!(outcome
        .proposal
        .services
        .iter()
        .any(|service| service.service_kind == ServiceKind::ExternalManaged));
}

#[test]
fn relations_become_dependencies_with_their_failure_policy() {
    let mut params = Params::default();
    params.services = vec![node_service(), compose_service()];
    params.relations = vec![ServiceRelation {
        id: "rel-1".to_string(),
        application_id: "app-1".to_string(),
        from_service_id: "svc-api".to_string(),
        to_service_id: "svc-stack".to_string(),
        relation_kind: ServiceRelationKind::DependsOn,
        required: true,
        failure_policy: crate::deployment::model::FailurePolicy::Block,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }];
    let outcome = engine::generate(&inputs(params), None);
    let dependency = outcome
        .proposal
        .dependencies
        .iter()
        .find(|dependency| dependency.from_service == "api")
        .expect("依赖应当被带进方案");
    assert_eq!(dependency.to_service, "stack");
    assert!(dependency.required);
    assert_eq!(
        dependency.failure_policy,
        crate::deployment::model::FailurePolicy::Block
    );
    assert!(!dependency.evidence.is_empty());
}

// -- ArtifactAnalysis → 服务事实 --------------------------------------------

/// 造一条"导入任务 + 制品 + 服务"的完整链路（三者的关联键必须真的对得上）。
fn artifact_chain(
    candidate_name: &str,
    candidate_path: &str,
    blocking: Option<FindingKind>,
) -> (ArtifactImportTask, ArtifactRecord, ServiceUnit) {
    let mut unit = service(
        "svc-web",
        "web",
        ServiceKind::NodeProcess,
        ServiceRuntime::NativeProcess {
            entry: "node".to_string(),
            args: Vec::new(),
        },
    );
    unit.artifact_id = Some("art-1".to_string());
    unit.deploy_path = Some(if candidate_path.is_empty() {
        "/opt/shop".to_string()
    } else {
        format!("/opt/shop/{candidate_path}")
    });

    let artifact = ArtifactRecord {
        id: "art-1".to_string(),
        application_id: "app-1".to_string(),
        service_unit_id: Some("svc-web".to_string()),
        kind: ArtifactKind::Folder,
        source_kind: ArtifactSourceKind::LocalPath,
        // 与导入来源的引用**逐字相同** —— 这正是匹配链成立的依据。
        source_ref: "/tmp/shop".to_string(),
        file_name: None,
        size_bytes: Some(10),
        sha256: Some("a".repeat(64)),
        docker_digest: None,
        version_label: Some("v1".to_string()),
        built_at: None,
        checksum_verified: false,
        status: ArtifactStatus::Ready,
        notes: "shop".to_string(),
        created_at: 1,
        updated_at: 1,
    };

    let candidate = ServiceCandidate {
        id: "candidate-1".to_string(),
        name: candidate_name.to_string(),
        role: ServiceRole::Api,
        service_kind: ServiceKind::NodeProcess,
        runtime: ServiceRuntime::NativeProcess {
            entry: "/app.js".to_string(),
            args: Vec::new(),
        },
        artifact_kind: ArtifactKind::Dist,
        source_path: candidate_path.to_string(),
        ports: vec![PortMapping {
            host_port: 3000,
            container_port: 3000,
            protocol: PortProtocol::Tcp,
        }],
        env_keys: vec!["DATABASE_URL".to_string()],
        dependencies: Vec::new(),
        health: vec![HealthGuess {
            kind: HealthKind::Http,
            target: "/healthz".to_string(),
            evidence: "src/index.js".to_string(),
        }],
        confidence: 75,
        evidence: vec!["package.json".to_string()],
        selected_by_default: true,
    };

    let security = match blocking {
        Some(kind) => SecurityScanReport {
            findings: vec![SecurityFinding {
                kind,
                severity: FindingSeverity::Critical,
                location: ".env".to_string(),
                detail: "私钥随制品分发".to_string(),
                evidence: None,
                blocking: true,
            }],
            entries_checked: 2,
            files_scanned: 2,
            bytes_scanned: 10,
            truncated: false,
        },
        None => SecurityScanReport::empty(),
    };

    let task = ArtifactImportTask {
        id: "task-1".to_string(),
        application_id: Some("app-1".to_string()),
        service_unit_id: None,
        source: ImportSource::LocalFolder {
            path: "/tmp/shop".to_string(),
        },
        display_name: "shop".to_string(),
        stage: ImportStage::Done,
        status: ImportStatus::Succeeded,
        progress: ImportProgress::queued(),
        fingerprint: None,
        security: Some(security),
        inspection: Some(ArtifactInspection {
            artifact_kind: ArtifactKind::Folder,
            source_kind: ArtifactSourceKind::LocalPath,
            stack: StackProfile {
                language: Language::Node,
                package_manager: Some(PackageManager::Npm),
                framework: Some("express".to_string()),
                markers: vec!["package.json".to_string()],
            },
            build: vec![BuildStep::None],
            start: Vec::new(),
            ports: vec![PortGuess {
                port: 3000,
                protocol: "tcp".to_string(),
                evidence: "src/index.js".to_string(),
            }],
            health: Vec::new(),
            env_keys: vec![EnvKeyGuess {
                key: "PORT".to_string(),
                required: false,
                secret_like: false,
                evidence: "src/index.js".to_string(),
            }],
            dependencies: Vec::new(),
            services: vec![candidate],
            checks: Vec::new(),
            open_questions: Vec::new(),
            files_seen: 2,
            truncated: false,
            inspected_at: 1,
        }),
        error: None,
        can_cancel: false,
        attempt: 1,
        created_at: 1,
        updated_at: 1,
        finished_at: Some(1),
        artifact_id: Some("art-1".to_string()),
    };
    (task, artifact, unit)
}

#[test]
fn artifact_analysis_becomes_service_facts() {
    let (task, artifact, unit) = artifact_chain("web", "", None);
    let facts = facts::derive_service_facts(&[unit], &[artifact], &[task], Some("/opt/shop"));
    assert_eq!(facts.len(), 1);
    let facts = &facts[0];
    assert_eq!(facts.service_unit_id, "svc-web");
    assert_eq!(facts.ports.len(), 1);
    assert_eq!(facts.ports[0].host_port, 3000);
    assert_eq!(facts.health_target.as_deref(), Some("/healthz"));
    assert_eq!(facts.env_keys, vec!["DATABASE_URL".to_string()]);
    assert!(!facts.artifact_blocked);
    assert!(facts.artifact_blocked_reason.is_none());
}

#[test]
fn artifact_analysis_maps_a_blocking_finding_to_the_facts() {
    let (task, artifact, unit) = artifact_chain("web", "", Some(FindingKind::PrivateKey));
    let facts = facts::derive_service_facts(&[unit], &[artifact], &[task], Some("/opt/shop"));
    let facts = &facts[0];
    assert!(facts.artifact_blocked);
    let reason = facts.artifact_blocked_reason.as_deref().unwrap_or_default();
    // 种类用 snake_case 键（前端能直接翻译），并带上位置。
    assert!(reason.contains("private_key"), "{reason}");
    assert!(reason.contains(".env"), "{reason}");
}

#[test]
fn artifact_analysis_falls_back_to_path_when_the_name_was_rewritten() {
    // 环境内重名去重会改写服务名；路径仍然精确相等，所以还能对上。
    let (task, artifact, unit) = artifact_chain("web-2", "apps/web", None);
    let facts = facts::derive_service_facts(&[unit], &[artifact], &[task], Some("/opt/shop"));
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].ports.len(), 1);
}

#[test]
fn artifact_analysis_refuses_to_guess_when_nothing_matches() {
    // 服务不在这个导入的目录之下 → 不给事实（宁可少给，也不猜端口）。
    let (task, artifact, mut unit) = artifact_chain("web", "", None);
    unit.deploy_path = Some("/srv/other".to_string());
    assert!(
        facts::derive_service_facts(&[unit], &[artifact], &[task], Some("/opt/shop")).is_empty()
    );

    // 没有制品、没有任务、没有识别结果，同样不给事实。
    let (_, _, unit) = artifact_chain("web", "", None);
    assert!(facts::derive_service_facts(&[unit], &[], &[], Some("/opt/shop")).is_empty());
}

#[test]
fn rollback_strategy_is_explicit_about_data() {
    let outcome = engine::generate(&inputs(Params::default()), None);
    let rollback = &outcome.proposal.rollback_strategy;
    assert!(rollback.automatic);
    assert!(rollback.trigger.is_some());
    assert!(!rollback.steps.is_empty());
    assert!(!rollback.restores.is_empty());
    // 数据能不能回滚必须表态（不能留空让人自己猜）。
    assert!(rollback
        .data_rollback
        .as_deref()
        .is_some_and(|text| !text.trim().is_empty()));
}
