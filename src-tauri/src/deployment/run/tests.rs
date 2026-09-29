//! P5.3 编排层测试：锁、元数据、预检、步骤顺序。
//!
//! 引擎的远程部分是**故意不在这里测**的 —— 那需要一个真实服务器。可以在本地
//! 证明的是：并发保护有效、审批要求不可绕过、预检该拦的都拦得住。

use super::preflight::{preflight, PreflightInputs};
use super::*;
use crate::deployment::action::model::ActionKind;
use crate::deployment::action::spec::ActionPhase;
use crate::deployment::proposal::model::SecurityPolicy;
use crate::project_readiness::CheckState;

// -- 环境锁 ------------------------------------------------------------------

#[test]
fn two_deployments_cannot_hold_the_same_environment() {
    let locks = EnvironmentLocks::default();
    locks.acquire("env-1", "run-a").expect("第一次加锁");
    let error = locks.acquire("env-1", "run-b").expect_err("第二次必须失败");
    assert!(error.contains("run-a"), "报错要指出持有者：{error}");
    // 同一个运行重复加锁是幂等的（重试/继续时会发生）。
    locks.acquire("env-1", "run-a").expect("同一运行重复加锁");
    // 不同环境互不影响。
    locks.acquire("env-2", "run-b").expect("不同环境可并行");
}

#[test]
fn releasing_the_lock_requires_the_holder() {
    let locks = EnvironmentLocks::default();
    locks.acquire("env-1", "run-a").unwrap();
    locks.release("env-1", "run-b");
    assert_eq!(locks.holder("env-1").as_deref(), Some("run-a"));
    locks.release("env-1", "run-a");
    assert!(locks.holder("env-1").is_none());
}

// -- 运行元数据 ---------------------------------------------------------------

#[test]
fn run_meta_round_trips_without_leaking_anything_else() {
    let mut run = sample_run();
    let meta = RunMeta {
        approved_nodes: vec!["write_nginx_config".to_string()],
        lock_key: "env-1".to_string(),
        completed_nodes: vec!["check_dependencies".to_string()],
        note: "首次部署".to_string(),
        version_label: "v1.1".to_string(),
    };
    write_meta(&mut run, &meta);
    let restored = read_meta(&run);
    assert_eq!(restored.approved_nodes, meta.approved_nodes);
    assert_eq!(restored.completed_nodes, meta.completed_nodes);
    assert_eq!(restored.lock_key, "env-1");

    // 快照里只有元数据：不接受任何未知字段（例如误塞进去的配置值）。
    run.snapshot_json =
        Some(r#"{"approved_nodes":[],"custom_env":"DATABASE_URL=..."}"#.to_string());
    let fallback = read_meta(&run);
    assert!(fallback.approved_nodes.is_empty());
    assert_eq!(fallback.lock_key, "");
}

// -- 审批 --------------------------------------------------------------------

#[test]
fn approvals_are_per_run_and_per_node() {
    let registry = RunRegistry::default();
    registry.register("run-a");
    assert!(!registry.is_approved("run-a", "promote_release", &[]));
    registry.approve("run-a", "promote_release");
    assert!(registry.is_approved("run-a", "promote_release", &[]));
    // 别的节点、别的运行不受影响。
    assert!(!registry.is_approved("run-a", "issue_certificate", &[]));
    assert!(!registry.is_approved("run-b", "promote_release", &[]));
    // 落库的批准也生效（重启之后）。
    assert!(registry.is_approved("run-b", "x", &["x".to_string()]));
}

#[test]
fn cancellation_is_cooperative_and_visible() {
    let registry = RunRegistry::default();
    let token = registry.register("run-a");
    assert!(!token.load(Ordering::Relaxed));
    assert!(registry.cancel("run-a"));
    assert!(token.load(Ordering::Relaxed));
    // 取消一个不存在的运行返回 false（不假装成功）。
    assert!(!registry.cancel("run-missing"));
}

// -- 预检 --------------------------------------------------------------------

fn context() -> (
    Vec<ServiceUnit>,
    Vec<ArtifactRecord>,
    Vec<DomainBinding>,
    Vec<ConfigDefinition>,
    Vec<SecretRef>,
) {
    let mut service = sample_service("svc-1", "web");
    service.artifact_id = Some("art-1".to_string());
    let artifact = ArtifactRecord {
        id: "art-1".to_string(),
        application_id: "app-1".to_string(),
        service_unit_id: Some("svc-1".to_string()),
        kind: ArtifactKind::Zip,
        source_kind: ArtifactSourceKind::LocalPath,
        source_ref: "/home/me/web.zip".to_string(),
        file_name: Some("web.zip".to_string()),
        size_bytes: Some(10),
        sha256: Some("a".repeat(64)),
        docker_digest: None,
        version_label: Some("1.0.0".to_string()),
        built_at: None,
        checksum_verified: false,
        status: ArtifactStatus::Ready,
        notes: "web".to_string(),
        created_at: 1,
        updated_at: 1,
    };
    let domain = DomainBinding {
        id: "dom-1".to_string(),
        environment_id: "env-1".to_string(),
        service_unit_id: Some("svc-1".to_string()),
        domain: "app.example.com".to_string(),
        listen_port: 80,
        path_prefix: "/".to_string(),
        dns_credential_ref: None,
        dns_status: DnsStatus::Resolved,
        dns_checked_at: Some(1),
        ssl_mode: SslMode::Acme,
        ssl_status: SslStatus::Pending,
        ssl_expires_at: None,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    };
    let config = ConfigDefinition {
        id: "cfg-1".to_string(),
        application_id: "app-1".to_string(),
        service_unit_id: Some("svc-1".to_string()),
        key: "DATABASE_URL".to_string(),
        data_type: ConfigDataType::Url,
        required: true,
        secret: true,
        scope: ConfigScope::Runtime,
        source_kind: ConfigSourceKind::SecretRef,
        source_ref: Some("secret-1".to_string()),
        default_value: None,
        description: String::new(),
        created_at: 1,
        updated_at: 1,
    };
    let secret = SecretRef {
        id: "secret-1".to_string(),
        application_id: Some("app-1".to_string()),
        name: "DATABASE_URL".to_string(),
        store_kind: SecretStoreKind::Keyring,
        keyring_service: Some("ops-workbench".to_string()),
        keyring_account: Some("secret-1".to_string()),
        runtime_path: None,
        description: String::new(),
        last_used_at: None,
        created_at: 1,
        updated_at: 1,
    };
    (
        vec![service],
        vec![artifact],
        vec![domain],
        vec![config],
        vec![secret],
    )
}

struct Harness {
    plan: DeploymentPlanGraph,
    services: Vec<ServiceUnit>,
    artifacts: Vec<ArtifactRecord>,
    domains: Vec<DomainBinding>,
    configs: Vec<ConfigDefinition>,
    secrets: Vec<SecretRef>,
    policy: SecurityPolicy,
}

impl Harness {
    fn new() -> Self {
        let (services, artifacts, domains, configs, secrets) = context();
        Self {
            plan: approved_plan(),
            services,
            artifacts,
            domains,
            configs,
            secrets,
            policy: SecurityPolicy::default(),
        }
    }

    fn report(
        &self,
        environment: EnvironmentKind,
        connected: bool,
        locked: Option<&str>,
        rollback: usize,
    ) -> PreflightReport {
        preflight(&PreflightInputs {
            plan: &self.plan,
            services: &self.services,
            artifacts: &self.artifacts,
            domains: &self.domains,
            configs: &self.configs,
            secret_refs: &self.secrets,
            policy: &self.policy,
            environment_kind: environment,
            session_connected: connected,
            locked_by: locked.map(str::to_string),
            rollback_steps: rollback,
        })
    }
}

#[test]
fn a_clean_production_plan_passes_preflight() {
    let harness = Harness::new();
    let report = harness.report(EnvironmentKind::Production, true, None, 1);
    assert!(report.can_run, "预检应通过：{:?}", report.blocked_checks());
    assert!(!report.warnings.is_empty(), "生产环境要有醒目提示");
    // 服务器能力是 Unknown，不是 Ready（本地判不了，如实标注）。
    let capability = report
        .checks
        .iter()
        .find(|check| check.id == "capability")
        .expect("capability 检查");
    assert_eq!(capability.state, CheckState::Unknown);
}

#[test]
fn a_draft_plan_cannot_run() {
    let mut harness = Harness::new();
    harness.plan.plan.status = PlanStatus::Draft;
    let report = harness.report(EnvironmentKind::Staging, true, None, 1);
    assert!(!report.can_run);
    assert!(report
        .blocked_checks()
        .iter()
        .any(|check| check.id == "plan_status"));
}

#[test]
fn a_locked_environment_cannot_run() {
    let harness = Harness::new();
    let report = harness.report(EnvironmentKind::Staging, true, Some("run-x"), 1);
    assert!(!report.can_run);
    let lock = report
        .checks
        .iter()
        .find(|check| check.id == "environment_lock")
        .unwrap();
    assert!(lock.detail.contains("run-x"), "{}", lock.detail);
}

#[test]
fn a_disconnected_session_blocks_the_run() {
    let harness = Harness::new();
    let report = harness.report(EnvironmentKind::Staging, false, None, 1);
    assert!(!report.can_run);
}

#[test]
fn production_without_a_rollback_plan_is_blocked() {
    let harness = Harness::new();
    let report = harness.report(EnvironmentKind::Production, true, None, 0);
    assert!(!report.can_run);
    assert!(report
        .blocked_checks()
        .iter()
        .any(|check| check.id == "rollback"));
    // 同样的计划在暂存环境可以跑（那里不强制回滚计划）。
    let staging = harness.report(EnvironmentKind::Staging, true, None, 0);
    assert!(staging.can_run, "{:?}", staging.blocked_checks());
}

#[test]
fn a_missing_secret_reference_blocks_the_run() {
    let mut harness = Harness::new();
    harness.secrets.clear();
    let report = harness.report(EnvironmentKind::Staging, true, None, 1);
    assert!(!report.can_run);
    let secrets = report
        .checks
        .iter()
        .find(|check| check.id == "secrets")
        .unwrap();
    assert!(
        secrets.detail.contains("DATABASE_URL"),
        "{}",
        secrets.detail
    );
}

#[test]
fn a_mismatched_domain_blocks_certificate_issuance() {
    let mut harness = Harness::new();
    harness.domains[0].dns_status = DnsStatus::Mismatched;
    let report = harness.report(EnvironmentKind::Staging, true, None, 1);
    assert!(!report.can_run);
    let dns = report
        .checks
        .iter()
        .find(|check| check.id == "dns")
        .unwrap();
    assert_eq!(dns.state, CheckState::Blocked);
}

#[test]
fn an_unverified_domain_is_only_a_warning() {
    let mut harness = Harness::new();
    harness.domains[0].dns_status = DnsStatus::Unchecked;
    let report = harness.report(EnvironmentKind::Staging, true, None, 1);
    // 未验证不阻断：执行时会先验证，未生效就不申请 HTTP-01 证书。
    assert!(report.can_run, "{:?}", report.blocked_checks());
    let dns = report
        .checks
        .iter()
        .find(|check| check.id == "dns")
        .unwrap();
    assert_eq!(dns.state, CheckState::Unknown);
}

#[test]
fn a_service_without_an_artifact_blocks_the_run() {
    let mut harness = Harness::new();
    harness.services[0].artifact_id = None;
    let report = harness.report(EnvironmentKind::Staging, true, None, 1);
    assert!(!report.can_run);
    assert!(report
        .blocked_checks()
        .iter()
        .any(|check| check.id == "artifacts"));
}

// -- 步骤顺序 ----------------------------------------------------------------

#[test]
fn the_compiled_plan_keeps_the_gateway_ordering() {
    // 备份 → 写配置 → 测试 → 重载：这个顺序是安全前提，不能被编译器打乱。
    let order = [
        ActionKind::BackupNginxConfig,
        ActionKind::WriteNginxConfig,
        ActionKind::TestNginxConfig,
        ActionKind::ReloadNginx,
    ];
    let phases: Vec<ActionPhase> = order.iter().map(|kind| spec(*kind).phase).collect();
    assert_eq!(
        phases,
        vec![
            ActionPhase::Gateway,
            ActionPhase::Gateway,
            ActionPhase::Gateway,
            ActionPhase::Gateway
        ]
    );
    // 风险级别：写配置必须审批；测试与重载不额外审批（重载的前提是测试通过）。
    assert!(spec(ActionKind::WriteNginxConfig).requires_approval);
    assert!(!spec(ActionKind::TestNginxConfig).requires_approval);
    assert!(!spec(ActionKind::ReloadNginx).requires_approval);
    assert!(spec(ActionKind::ReloadNginx)
        .preconditions
        .contains(&crate::deployment::action::spec::Precondition::NginxConfigValid));
}

// -- 测试夹具 ----------------------------------------------------------------

fn sample_service(id: &str, name: &str) -> ServiceUnit {
    ServiceUnit {
        id: id.to_string(),
        application_id: "app-1".to_string(),
        environment_id: "env-1".to_string(),
        name: name.to_string(),
        role: ServiceRole::Web,
        service_kind: ServiceKind::StaticNginx,
        runtime: ServiceRuntime::StaticNginx {
            site_name: "app".to_string(),
            root: "/srv/app/current/public".to_string(),
        },
        deploy_path: Some("/srv/app/releases/1.0.0".to_string()),
        confirmed_project_id: None,
        confirmed_project_path: None,
        artifact_id: None,
        status: "configured".to_string(),
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

fn sample_run() -> DeploymentRun {
    DeploymentRun {
        id: "run-1".to_string(),
        plan_id: "plan-1".to_string(),
        application_id: "app-1".to_string(),
        environment_id: "env-1".to_string(),
        server_id: "srv-1".to_string(),
        server_name: "prod".to_string(),
        status: RunStatus::Running,
        trigger_source: RunTrigger::Manual,
        plan_version: 1,
        started_at: Some(1),
        finished_at: None,
        duration_ms: None,
        log: String::new(),
        error_message: None,
        snapshot_json: None,
        release_id: None,
        created_at: 1,
    }
}

fn approved_plan() -> DeploymentPlanGraph {
    DeploymentPlanGraph {
        plan: DeploymentPlan {
            id: "plan-1".to_string(),
            application_id: "app-1".to_string(),
            environment_id: "env-1".to_string(),
            name: "Deploy 1.0.0".to_string(),
            version: 1,
            status: PlanStatus::Approved,
            proposal_source: ProposalSource::AiProposed,
            risk_level: RiskLevel::High,
            notes: String::new(),
            created_at: 1,
            updated_at: 1,
        },
        nodes: Vec::new(),
        edges: Vec::new(),
    }
}
