//! P5.0 部署中心：模型与校验的单元测试。
//!
//! 重点覆盖"结构化模型"这条承诺的边界：任何含 shell 元字符的文本、任何
//! `command` / `shell` / `exec` 形态的字段、任何明文密钥、任何越出环境根目录的
//! 路径，以及任何不成图的方案，都必须在校验层被拒。

use super::model::*;
use super::validate::*;

fn application() -> DeploymentApplication {
    DeploymentApplication {
        id: "app-1".to_string(),
        server_id: "srv-1".to_string(),
        name: "官网".to_string(),
        description: String::new(),
        application_kind: ApplicationKind::Frontend,
        source_kind: SourceKind::ExistingRemoteDir,
        source_ref: "/opt/web".to_string(),
        default_branch: "main".to_string(),
        confirmed_project_path: Some("/opt/web".to_string()),
        status: "active".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn environment() -> DeploymentEnvironment {
    DeploymentEnvironment {
        id: "env-1".to_string(),
        application_id: "app-1".to_string(),
        server_id: "srv-1".to_string(),
        name: "生产".to_string(),
        kind: EnvironmentKind::Production,
        deploy_root: "/opt/web".to_string(),
        capacity_profile_id: None,
        notes: String::new(),
        status: "active".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn service_unit(runtime: ServiceRuntime) -> ServiceUnit {
    ServiceUnit {
        id: "svc-1".to_string(),
        application_id: "app-1".to_string(),
        environment_id: "env-1".to_string(),
        name: "web".to_string(),
        role: ServiceRole::Static,
        service_kind: ServiceKind::StaticNginx,
        runtime,
        deploy_path: Some("/opt/web/current".to_string()),
        confirmed_project_id: None,
        confirmed_project_path: None,
        artifact_id: None,
        status: "configured".to_string(),
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

fn capacity() -> CapacityProfile {
    CapacityProfile {
        id: "cap-1".to_string(),
        environment_id: "env-1".to_string(),
        expected_dau: Some(10_000),
        concurrent_users: Some(500),
        peak_qps: Some(120.0),
        avg_qps: Some(20.0),
        websocket_connections: None,
        response_target_ms: None,
        monthly_bandwidth_gb: Some(800.0),
        monthly_upload_gb: Some(20.0),
        monthly_data_growth_gb: Some(5.0),
        availability_target: Some("99.9".to_string()),
        rpo_minutes: Some(60),
        rto_minutes: Some(30),
        monthly_budget: Some(2000.0),
        budget_currency: Some("CNY".to_string()),
        estimation_basis: EstimationBasis::UserProvided,
        assumptions: vec![],
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

fn node(key: &str, action: PlanActionKind, from: &str, to: &str) -> (PlanNode, Vec<PlanEdge>) {
    let node = PlanNode {
        id: format!("node-{key}"),
        plan_id: "plan-1".to_string(),
        node_key: key.to_string(),
        title: key.to_string(),
        action,
        service_unit_id: None,
        risk_level: action.default_risk(),
        approval_required: action.requires_approval(),
        skippable: true,
        params_json: "{}".to_string(),
        position: 0,
        created_at: 1,
        updated_at: 1,
    };
    let edges = if from.is_empty() {
        vec![]
    } else {
        vec![PlanEdge {
            id: format!("edge-{key}"),
            plan_id: "plan-1".to_string(),
            from_node_id: format!("node-{from}"),
            to_node_id: format!("node-{to}"),
            condition: EdgeCondition::OnSuccess,
            created_at: 1,
        }]
    };
    (node, edges)
}

fn plan() -> DeploymentPlan {
    DeploymentPlan {
        id: "plan-1".to_string(),
        application_id: "app-1".to_string(),
        environment_id: "env-1".to_string(),
        name: "标准静态发布".to_string(),
        version: 1,
        status: PlanStatus::Draft,
        proposal_source: ProposalSource::Manual,
        risk_level: RiskLevel::Low,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

// -- 文本与标识 -------------------------------------------------------------

#[test]
fn shell_metacharacters_are_rejected() {
    for text in [
        "npm run build; rm -rf /",
        "echo $(whoami)",
        "a && b",
        "cat /etc/passwd | mail",
        "`id`",
        "x > /etc/passwd",
        "line\nbreak",
    ] {
        assert!(
            reject_shell_text(text, "字段").is_err(),
            "{text} 应该被拒绝"
        );
    }
    // 正常的路径与参数不受影响。
    assert!(reject_shell_text("/opt/web/current", "字段").is_ok());
    assert!(reject_shell_text("-Xmx512m", "字段").is_ok());
}

#[test]
fn names_and_keys_have_shape_rules() {
    assert!(validate_name("", "应用名称").is_err());
    assert!(validate_name("   ", "应用名称").is_err());
    assert!(validate_name("官网", "应用名称").is_ok());

    assert!(validate_node_key("fetch_source").is_ok());
    assert!(validate_node_key("FetchSource").is_err());
    assert!(validate_node_key("fetch-source").is_err());
    assert!(validate_node_key("").is_err());

    assert!(validate_config_key("DATABASE_URL").is_ok());
    assert!(validate_config_key("database_url").is_err());
    assert!(validate_config_key("1BAD").is_err());
    assert!(validate_config_key("OK1").is_ok());
}

#[test]
fn domains_are_strict() {
    assert!(validate_domain("app.example.com").is_ok());
    assert!(validate_domain("APP.example.com").is_err());
    assert!(validate_domain("app").is_err()); // 单段
    assert!(validate_domain("https://app.example.com").is_err());
    assert!(validate_domain("app.example.com:443").is_err());
    assert!(validate_domain("-app.example.com").is_err());
    assert!(validate_domain("app..example.com").is_err());
}

#[test]
fn sha256_must_be_64_lowercase_hex() {
    let ok = "a".repeat(64);
    assert!(validate_sha256(&ok, "SHA-256").is_ok());
    assert!(validate_sha256(&"A".repeat(64), "SHA-256").is_err());
    assert!(validate_sha256("abc", "SHA-256").is_err());
}

// -- 参数 JSON（"不允许任意 command 字符串"的机械保障） ---------------------

#[test]
fn params_json_rejects_command_like_keys() {
    for json in [
        r#"{"command":"npm run build"}"#,
        r#"{"cmd":"rm -rf /"}"#,
        r#"{"shell":"bash -c x"}"#,
        r#"{"script":"deploy.sh"}"#,
        r#"{"exec":"/bin/sh"}"#,
        r#"{"args":["-c","x"]}"#,
        r#"{"nested":{"command":"x"}}"#,
    ] {
        assert!(validate_params_json(json).is_err(), "{json} 应该被拒绝");
    }
}

#[test]
fn params_json_rejects_shell_text_in_any_string_value() {
    assert!(validate_params_json(r#"{"note":"a; rm -rf /"}"#).is_err());
    assert!(validate_params_json(r#"{"list":["ok","bad $(x)"]}"#).is_err());
    assert!(validate_params_json(r#"{"nested":{"note":"a && b"}}"#).is_err());
}

#[test]
fn params_json_accepts_structured_values() {
    assert!(validate_params_json("{}").is_ok());
    assert!(validate_params_json("").is_ok());
    assert!(
        validate_params_json(r#"{"unit":"api","port":8080,"retries":3,"enabled":true}"#).is_ok()
    );
    assert!(validate_params_json(r#"{"targets":["/opt/web/current","/opt/web/prev"]}"#).is_ok());
}

#[test]
fn params_json_must_be_an_object() {
    assert!(validate_params_json("[1,2]").is_err());
    assert!(validate_params_json(r#""just a string""#).is_err());
    assert!(validate_params_json("not json").is_err());
}

// -- 路径围栏 ---------------------------------------------------------------

#[test]
fn service_paths_must_stay_under_the_environment_root() {
    assert!(validate_under_root("/opt/web/current", "/opt/web", "服务目录").is_ok());
    assert!(validate_under_root("/opt/web", "/opt/web", "服务目录").is_ok());
    assert!(validate_under_root("/etc/nginx", "/opt/web", "服务目录").is_err());
    assert!(validate_under_root("/opt/web/../etc/passwd", "/opt/web", "服务目录").is_err());
    assert!(validate_under_root("relative/path", "/opt/web", "服务目录").is_err());
}

#[test]
fn runtime_secret_files_only_allow_run_or_dev_shm() {
    assert!(validate_runtime_secret_path("/run/bls-ops/prod.env").is_ok());
    assert!(validate_runtime_secret_path("/dev/shm/bls-ops.env").is_ok());
    assert!(validate_runtime_secret_path("/tmp/key.env").is_err());
    assert!(validate_runtime_secret_path("/opt/web/key.env").is_err());
    assert!(validate_runtime_secret_path("/run/../etc/passwd").is_err());
}

// -- 运行时 -----------------------------------------------------------------

#[test]
fn docker_runtime_is_validated() {
    let ok = ServiceRuntime::DockerImage {
        image: "registry.example.com/acme/web".to_string(),
        tag: "v1.2.3".to_string(),
        container_name: "web-prod".to_string(),
        ports: vec![PortMapping {
            host_port: 8080,
            container_port: 80,
            protocol: PortProtocol::Tcp,
        }],
    };
    assert!(validate_runtime(&ok).is_ok());

    let bad_port = ServiceRuntime::DockerImage {
        image: "acme/web".to_string(),
        tag: "v1".to_string(),
        container_name: "web".to_string(),
        ports: vec![PortMapping {
            host_port: 0,
            container_port: 80,
            protocol: PortProtocol::Tcp,
        }],
    };
    assert!(validate_runtime(&bad_port).is_err());

    let bad_container = ServiceRuntime::DockerImage {
        image: "acme/web".to_string(),
        tag: "v1".to_string(),
        container_name: "web; rm -rf /".to_string(),
        ports: vec![],
    };
    assert!(validate_runtime(&bad_container).is_err());
}

#[test]
fn native_runtime_rejects_shell_arguments() {
    let ok = ServiceRuntime::NativeProcess {
        entry: "java".to_string(),
        args: vec![
            "-jar".to_string(),
            "app.jar".to_string(),
            "--port=8080".to_string(),
        ],
    };
    assert!(validate_runtime(&ok).is_ok());

    let injected = ServiceRuntime::NativeProcess {
        entry: "java".to_string(),
        args: vec!["-jar".to_string(), "app.jar; rm -rf /".to_string()],
    };
    assert!(validate_runtime(&injected).is_err());

    let piped = ServiceRuntime::NativeProcess {
        entry: "sh".to_string(),
        args: vec!["-c".to_string(), "curl x | bash".to_string()],
    };
    assert!(validate_runtime(&piped).is_err());
}

#[test]
fn external_runtimes_need_a_host_and_port() {
    assert!(validate_runtime(&ServiceRuntime::External {
        endpoint: "db-prod-01:5432".to_string(),
    })
    .is_ok());
    assert!(validate_runtime(&ServiceRuntime::External {
        endpoint: "db-prod-01".to_string(),
    })
    .is_err());
    assert!(validate_runtime(&ServiceRuntime::External {
        endpoint: "db-prod-01:5432; rm -rf /".to_string(),
    })
    .is_err());
}

#[test]
fn static_and_systemd_runtimes_are_validated() {
    assert!(validate_runtime(&ServiceRuntime::StaticNginx {
        site_name: "web-prod".to_string(),
        root: "/opt/web/current".to_string(),
    })
    .is_ok());
    assert!(validate_runtime(&ServiceRuntime::StaticNginx {
        site_name: "bad/name".to_string(),
        root: "/opt/web".to_string(),
    })
    .is_err());
    assert!(validate_runtime(&ServiceRuntime::SystemdUnit {
        unit: "api.service".to_string(),
    })
    .is_ok());
}

// -- 密钥与配置 -------------------------------------------------------------

#[test]
fn secret_refs_need_an_account_or_a_runtime_path() {
    let keyring = SecretRef {
        id: "sec-1".to_string(),
        application_id: Some("app-1".to_string()),
        name: "数据库口令".to_string(),
        store_kind: SecretStoreKind::Keyring,
        keyring_service: Some("ops-workbench".to_string()),
        keyring_account: Some("db-prod-password".to_string()),
        runtime_path: None,
        description: String::new(),
        last_used_at: None,
        created_at: 1,
        updated_at: 1,
    };
    assert!(validate_secret_ref(&keyring).is_ok());

    let missing_account = SecretRef {
        keyring_account: None,
        ..keyring.clone()
    };
    assert!(validate_secret_ref(&missing_account).is_err());

    let runtime = SecretRef {
        id: "sec-2".to_string(),
        application_id: None,
        name: "运行时文件".to_string(),
        store_kind: SecretStoreKind::RuntimeTempFile,
        keyring_service: None,
        keyring_account: None,
        runtime_path: Some("/run/bls-ops/prod.env".to_string()),
        description: String::new(),
        last_used_at: None,
        created_at: 1,
        updated_at: 1,
    };
    assert!(validate_secret_ref(&runtime).is_ok());

    let tmp = SecretRef {
        runtime_path: Some("/tmp/key.env".to_string()),
        ..runtime.clone()
    };
    assert!(validate_secret_ref(&tmp).is_err());

    // 两种方式不能混用参数。
    let mixed = SecretRef {
        keyring_account: Some("x".to_string()),
        ..runtime
    };
    assert!(validate_secret_ref(&mixed).is_err());
}

/// 密钥引用**永远不含明文**：序列化结果里不能出现 value / secret / password 字段。
#[test]
fn secret_ref_serialisation_has_no_plaintext_field() {
    let reference = SecretRef {
        id: "sec-1".to_string(),
        application_id: None,
        name: "k".to_string(),
        store_kind: SecretStoreKind::Keyring,
        keyring_service: None,
        keyring_account: Some("acct".to_string()),
        runtime_path: None,
        description: String::new(),
        last_used_at: None,
        created_at: 1,
        updated_at: 1,
    };
    let json = serde_json::to_value(&reference).unwrap();
    let object = json.as_object().unwrap();
    for banned in ["value", "secret", "password", "token", "private_key"] {
        assert!(!object.contains_key(banned), "密钥引用不该有 {banned} 字段");
    }
    assert_eq!(object["store_kind"], "keyring");
}

#[test]
fn config_definitions_forbid_plaintext_secrets() {
    let secret_with_default = ConfigDefinition {
        id: "cfg-1".to_string(),
        application_id: "app-1".to_string(),
        service_unit_id: None,
        key: "JWT_SECRET".to_string(),
        data_type: ConfigDataType::String,
        required: true,
        secret: true,
        scope: ConfigScope::Runtime,
        source_kind: ConfigSourceKind::SecretRef,
        source_ref: Some("sec-1".to_string()),
        default_value: Some("明文口令".to_string()),
        description: String::new(),
        created_at: 1,
        updated_at: 1,
    };
    assert!(validate_config(&secret_with_default).is_err());

    let secret_without_source = ConfigDefinition {
        default_value: None,
        source_kind: ConfigSourceKind::Literal,
        ..secret_with_default.clone()
    };
    assert!(validate_config(&secret_without_source).is_err());

    let good = ConfigDefinition {
        default_value: None,
        source_kind: ConfigSourceKind::SecretRef,
        source_ref: Some("sec-1".to_string()),
        ..secret_with_default
    };
    assert!(validate_config(&good).is_ok());

    let plain = ConfigDefinition {
        id: "cfg-2".to_string(),
        key: "API_BASE_URL".to_string(),
        secret: false,
        source_kind: ConfigSourceKind::Literal,
        source_ref: None,
        default_value: Some("https://api.example.com".to_string()),
        ..good.clone()
    };
    assert!(validate_config(&plain).is_ok());
}

// -- 容量问卷 ---------------------------------------------------------------

#[test]
fn estimated_capacity_must_show_its_assumptions() {
    let mut profile = capacity();
    profile.estimation_basis = EstimationBasis::Estimated;
    profile.assumptions = vec![];
    let error = validate_capacity(&profile).expect_err("估算没有假设必须报错");
    assert!(error.to_string().contains("假设"));

    profile.assumptions = vec!["按 3 倍峰值系数由 DAU 推算 QPS".to_string()];
    assert!(validate_capacity(&profile).is_ok());

    // 未知也允许，但同样不能"既说不知道又填数字"——这里只保证不谎报假设。
    profile.estimation_basis = EstimationBasis::Unknown;
    profile.assumptions = vec![];
    assert!(validate_capacity(&profile).is_ok());
}

#[test]
fn capacity_rejects_impossible_numbers() {
    let mut profile = capacity();
    profile.expected_dau = Some(-1);
    assert!(validate_capacity(&profile).is_err());

    let mut profile = capacity();
    profile.peak_qps = Some(f64::NAN);
    assert!(validate_capacity(&profile).is_err());

    let mut profile = capacity();
    profile.availability_target = Some("99.999".to_string());
    assert!(validate_capacity(&profile).is_err());
}

#[test]
fn acme_requires_a_dns_credential() {
    let binding = DomainBinding {
        id: "dom-1".to_string(),
        environment_id: "env-1".to_string(),
        service_unit_id: Some("svc-1".to_string()),
        domain: "app.example.com".to_string(),
        listen_port: 443,
        path_prefix: "/".to_string(),
        dns_credential_ref: None,
        dns_status: DnsStatus::Unchecked,
        dns_checked_at: None,
        ssl_mode: SslMode::Acme,
        ssl_status: SslStatus::Pending,
        ssl_expires_at: None,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    };
    assert!(validate_domain_binding(&binding, None).is_err());

    let with_credential = DomainBinding {
        dns_credential_ref: Some("sec-dns".to_string()),
        ..binding.clone()
    };
    assert!(validate_domain_binding(&with_credential, None).is_ok());

    let bad_prefix = DomainBinding {
        ssl_mode: SslMode::None,
        ssl_status: SslStatus::NotApplicable,
        dns_credential_ref: None,
        path_prefix: "app".to_string(),
        ..binding
    };
    assert!(validate_domain_binding(&bad_prefix, None).is_err());
}

// -- 制品 -------------------------------------------------------------------

#[test]
fn artifacts_are_validated() {
    let good = ArtifactRecord {
        id: "art-1".to_string(),
        application_id: "app-1".to_string(),
        service_unit_id: None,
        kind: ArtifactKind::TarGz,
        source_kind: ArtifactSourceKind::ServerExistingDir,
        source_ref: "/opt/web/releases/v1.tar.gz".to_string(),
        file_name: Some("v1.tar.gz".to_string()),
        size_bytes: Some(1024),
        sha256: Some("b".repeat(64)),
        docker_digest: None,
        version_label: Some("v1.2.3".to_string()),
        built_at: None,
        checksum_verified: true,
        status: ArtifactStatus::Ready,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    };
    assert!(validate_artifact(&good).is_ok());

    let bad_hash = ArtifactRecord {
        sha256: Some("xyz".to_string()),
        ..good.clone()
    };
    assert!(validate_artifact(&bad_hash).is_err());

    let image_from_local = ArtifactRecord {
        kind: ArtifactKind::DockerImage,
        source_kind: ArtifactSourceKind::LocalPath,
        source_ref: "/tmp/image.tar".to_string(),
        ..good.clone()
    };
    assert!(validate_artifact(&image_from_local).is_err());

    let file_name_with_slash = ArtifactRecord {
        file_name: Some("../escape.tar.gz".to_string()),
        ..good
    };
    assert!(validate_artifact(&file_name_with_slash).is_err());
}

// -- 方案图 -----------------------------------------------------------------

#[test]
fn a_valid_plan_graph_passes() {
    let (fetch, mut edges) = node("fetch_source", PlanActionKind::FetchSource, "", "");
    let (build, build_edges) = node(
        "build",
        PlanActionKind::BuildArtifact,
        "fetch_source",
        "build",
    );
    let (upload, upload_edges) = node("upload", PlanActionKind::UploadArtifact, "build", "upload");
    let (health, health_edges) = node(
        "http_health",
        PlanActionKind::HttpHealthCheck,
        "upload",
        "http_health",
    );
    edges.extend(build_edges);
    edges.extend(upload_edges);
    edges.extend(health_edges);

    let graph = DeploymentPlanGraph {
        plan: plan(),
        nodes: vec![fetch, build, upload, health],
        edges,
    };
    if let Err(error) = validate_plan_graph(&graph) {
        panic!("合法方案图被拒绝：{error}");
    }
}

#[test]
fn plan_graphs_must_be_acyclic_and_unique() {
    let (a, _) = node("a", PlanActionKind::FetchSource, "", "");
    let (b, _) = node("b", PlanActionKind::BuildArtifact, "", "");
    let edge = |from: &str, to: &str| PlanEdge {
        id: format!("edge-{from}-{to}"),
        plan_id: "plan-1".to_string(),
        from_node_id: format!("node-{from}"),
        to_node_id: format!("node-{to}"),
        condition: EdgeCondition::OnSuccess,
        created_at: 1,
    };

    // 重复 key。
    let duplicate = DeploymentPlanGraph {
        plan: plan(),
        nodes: vec![a.clone(), a.clone()],
        edges: vec![],
    };
    assert!(validate_plan_graph(&duplicate).is_err());

    // 自环。
    let self_loop = DeploymentPlanGraph {
        plan: plan(),
        nodes: vec![a.clone()],
        edges: vec![edge("a", "a")],
    };
    assert!(validate_plan_graph(&self_loop).is_err());

    // 重复边。
    let duplicated_edge = DeploymentPlanGraph {
        plan: plan(),
        nodes: vec![a.clone(), b.clone()],
        edges: vec![edge("a", "b"), edge("a", "b")],
    };
    assert!(validate_plan_graph(&duplicated_edge).is_err());

    // 环：a → b → a。
    let cycle = DeploymentPlanGraph {
        plan: plan(),
        nodes: vec![a.clone(), b.clone()],
        edges: vec![edge("a", "b"), edge("b", "a")],
    };
    let error = validate_plan_graph(&cycle).expect_err("有环必须报错");
    assert!(error.to_string().contains("环"));
}

#[test]
fn risk_cannot_be_downgraded_and_approval_cannot_be_dropped() {
    let (mut migration, _) = node("db_migration", PlanActionKind::DatabaseMigration, "", "");
    assert!(migration.risk_level == RiskLevel::High);
    assert!(migration.approval_required);

    let downgraded = DeploymentPlanGraph {
        plan: plan(),
        nodes: vec![PlanNode {
            risk_level: RiskLevel::Low,
            ..migration.clone()
        }],
        edges: vec![],
    };
    assert!(validate_plan_graph(&downgraded).is_err());

    let no_approval = DeploymentPlanGraph {
        plan: plan(),
        nodes: vec![PlanNode {
            approval_required: false,
            ..migration.clone()
        }],
        edges: vec![],
    };
    assert!(validate_plan_graph(&no_approval).is_err());

    // 默认形态（风险不降、审批保留）通过。
    let ok = DeploymentPlanGraph {
        plan: plan(),
        nodes: vec![migration],
        edges: vec![],
    };
    assert!(validate_plan_graph(&ok).is_ok());
}

#[test]
fn plan_graph_edges_must_reference_the_same_plan() {
    let (a, _) = node("a", PlanActionKind::FetchSource, "", "");
    let graph = DeploymentPlanGraph {
        plan: plan(),
        nodes: vec![PlanNode {
            plan_id: "other-plan".to_string(),
            ..a
        }],
        edges: vec![],
    };
    assert!(validate_plan_graph(&graph).is_err());
}

// -- serde 契约（与 TypeScript 一一对应） -----------------------------------

#[test]
fn enums_serialise_as_snake_case_strings() {
    assert_eq!(
        serde_json::to_value(ApplicationKind::ScheduledTask).unwrap(),
        serde_json::json!("scheduled_task")
    );
    assert_eq!(
        serde_json::to_value(ServiceRole::Api).unwrap(),
        serde_json::json!("api")
    );
    assert_eq!(
        serde_json::to_value(ConfigSourceKind::SecretRef).unwrap(),
        serde_json::json!("secret_ref")
    );
    assert_eq!(
        serde_json::to_value(PlanActionKind::HttpHealthCheck).unwrap(),
        serde_json::json!("http_health_check")
    );
    assert_eq!(
        serde_json::to_value(RunStatus::RolledBack).unwrap(),
        serde_json::json!("rolled_back")
    );
}

#[test]
fn service_runtime_round_trips_as_a_tagged_object() {
    let runtime = ServiceRuntime::DockerCompose {
        compose_path: "/opt/web/docker-compose.yml".to_string(),
        project_name: "web".to_string(),
        service: "api".to_string(),
    };
    let json = serde_json::to_value(&runtime).unwrap();
    assert_eq!(json["kind"], "docker_compose");
    assert_eq!(json["service"], "api");
    let back: ServiceRuntime = serde_json::from_value(json).unwrap();
    assert_eq!(back, runtime);

    let native = ServiceRuntime::NativeProcess {
        entry: "node".to_string(),
        args: vec!["server.js".to_string()],
    };
    let json = serde_json::to_value(&native).unwrap();
    assert_eq!(json["kind"], "native_process");
    assert_eq!(json["args"][0], "server.js");
}

#[test]
fn entities_round_trip_through_serde() {
    let application = application();
    let json = serde_json::to_string(&application).unwrap();
    // 字段是 snake_case，前端直接用。
    assert!(json.contains("\"application_kind\":\"frontend\""));
    assert!(json.contains("\"source_kind\":\"existing_remote_dir\""));
    let back: DeploymentApplication = serde_json::from_str(&json).unwrap();
    assert_eq!(back, application);

    let unit = service_unit(ServiceRuntime::StaticNginx {
        site_name: "web".to_string(),
        root: "/opt/web/current".to_string(),
    });
    let back: ServiceUnit = serde_json::from_str(&serde_json::to_string(&unit).unwrap()).unwrap();
    assert_eq!(back, unit);

    assert!(validate_application(&application).is_ok());
    assert!(validate_environment(&environment()).is_ok());
    assert!(validate_service_unit(&unit, Some("/opt/web")).is_ok());
}

#[test]
fn environments_flag_production_like_kinds() {
    assert!(EnvironmentKind::Production.is_production_like());
    assert!(EnvironmentKind::Staging.is_production_like());
    assert!(!EnvironmentKind::Development.is_production_like());
    assert!(!EnvironmentKind::Testing.is_production_like());
}

#[test]
fn applications_reject_bad_sources() {
    let mut git = application();
    git.source_kind = SourceKind::Git;
    git.source_ref = "https://github.com/acme/web.git".to_string();
    assert!(validate_application(&git).is_ok());

    let mut bad_url = git.clone();
    bad_url.source_ref = "git@github.com:acme/web.git; rm -rf /".to_string();
    assert!(validate_application(&bad_url).is_err());

    let mut bad_dir = application();
    bad_dir.source_ref = "relative/dir".to_string();
    assert!(validate_application(&bad_dir).is_err());

    let mut no_server = application();
    no_server.server_id = String::new();
    assert!(validate_application(&no_server).is_err());
}
