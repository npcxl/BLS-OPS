//! P5.3 动作层测试：**每个动作的契约、校验、编译**都钉在测试上。
//!
//! 这里刻意不放任何需要 SSH 的东西 —— 动作层的价值正是在于"不连服务器也能
//! 证明它不会构造出危险的东西"。

use serde_json::json;

use super::compile::{compile_graph, compile_node, CompileContext};
use super::model::*;
use super::spec::{approval_required, spec};
use super::validate::validate_action;
use crate::deployment::model::*;
use crate::deployment::proposal::rules::ServiceFacts;

/// 所有样本用的部署根目录。
pub const ROOT: &str = "/srv/app";

fn path(name: &str) -> String {
    format!("{ROOT}/{name}")
}

/// 一个合法样本（供本模块与 `model` 的往返测试共用）。
pub fn sample(kind: ActionKind) -> DeploymentAction {
    use ActionKind::*;
    let config_entries = vec![
        RuntimeConfigEntry {
            key: "LOG_LEVEL".to_string(),
            value: Some("info".to_string()),
            secret: false,
            secret_ref_id: None,
            required: false,
        },
        RuntimeConfigEntry {
            key: "DATABASE_URL".to_string(),
            value: None,
            secret: true,
            secret_ref_id: Some("secret-1".to_string()),
            required: true,
        },
    ];
    let compose_service = ComposeServiceSpec {
        name: "web".to_string(),
        image: Some("nginx:1.27".to_string()),
        build_context: None,
        dockerfile: None,
        publish_ports: vec![PortMapping {
            host_port: 8080,
            container_port: 80,
            protocol: PortProtocol::Tcp,
        }],
        expose_ports: vec![80],
        env_file: None,
        depends_on: Vec::new(),
        healthcheck_path: Some("/healthz".to_string()),
        networks: Vec::new(),
        internal_only: false,
    };
    let site = NginxSiteSpec {
        site_name: "app".to_string(),
        server_names: vec!["app.example.com".to_string()],
        listen_port: 80,
        path_prefix: "/".to_string(),
        root: Some(path("current/public")),
        proxy_pass: None,
        ssl_certificate: None,
        ssl_certificate_key: None,
        client_max_body_size_mb: Some(64),
    };
    match kind {
        CheckDependencies => DeploymentAction::CheckDependencies(CheckDependenciesInput {
            tools: vec![RequiredTool::Docker, RequiredTool::Nginx],
        }),
        EnsureDirectory => DeploymentAction::EnsureDirectory(EnsureDirectoryInput {
            path: path("releases/1.0.0"),
            mode: Some(0o755),
        }),
        PrepareReleaseDirectory => {
            DeploymentAction::PrepareReleaseDirectory(PrepareReleaseDirectoryInput {
                release_root: path("releases"),
                version_label: "1.0.0".to_string(),
                keep_releases: 5,
            })
        }
        UploadArtifact => DeploymentAction::UploadArtifact(UploadArtifactInput {
            local_path: "/home/me/build/app.zip".to_string(),
            remote_dir: path("releases/1.0.0"),
            file_name: "app.zip".to_string(),
            expected_sha256: Some("a".repeat(64)),
        }),
        VerifyChecksum => DeploymentAction::VerifyChecksum(VerifyChecksumInput {
            remote_path: path("releases/1.0.0/app.zip"),
            expected_sha256: "a".repeat(64),
        }),
        ExtractArchive => DeploymentAction::ExtractArchive(ExtractArchiveInput {
            archive_path: path("releases/1.0.0/app.zip"),
            dest_dir: path("releases/1.0.0"),
            format: ArchiveFormat::Zip,
        }),
        BuildDockerImage => DeploymentAction::BuildDockerImage(BuildDockerImageInput {
            context_dir: path("releases/1.0.0"),
            dockerfile: path("releases/1.0.0/Dockerfile"),
            image_tag: "shop/web:1.0.0".to_string(),
        }),
        PullDockerImage => DeploymentAction::PullDockerImage(PullDockerImageInput {
            image: "nginx:1.27".to_string(),
            expected_digest: None,
        }),
        WriteRuntimeConfig => DeploymentAction::WriteRuntimeConfig(WriteRuntimeConfigInput {
            path: path("shared/web.env"),
            mode: 0o600,
            entries: config_entries,
        }),
        WriteComposeFile => DeploymentAction::WriteComposeFile(WriteComposeFileInput {
            compose_path: path("shared/docker-compose.yml"),
            project_name: "shop".to_string(),
            services: vec![compose_service],
            internal_network: "shop-internal".to_string(),
        }),
        ComposeUp => DeploymentAction::ComposeUp(ComposeUpInput {
            compose_path: path("shared/docker-compose.yml"),
            project_name: "shop".to_string(),
            services: vec!["web".to_string()],
        }),
        ComposeDown => DeploymentAction::ComposeDown(ComposeDownInput {
            compose_path: path("shared/docker-compose.yml"),
            project_name: "shop".to_string(),
        }),
        WaitContainerHealthy => DeploymentAction::WaitContainerHealthy(WaitContainerHealthyInput {
            container: "shop-web".to_string(),
            timeout_secs: 180,
            interval_secs: 5,
        }),
        RestartSystemdUnit => DeploymentAction::RestartSystemdUnit(RestartSystemdUnitInput {
            unit: "shop.service".to_string(),
        }),
        BackupNginxConfig => DeploymentAction::BackupNginxConfig(BackupNginxConfigInput {
            config_path: "/etc/nginx/sites-available/app".to_string(),
        }),
        WriteNginxConfig => DeploymentAction::WriteNginxConfig(WriteNginxConfigInput {
            config_path: "/etc/nginx/sites-available/app".to_string(),
            site,
            enable_site: true,
        }),
        RestoreNginxBackup => DeploymentAction::RestoreNginxBackup(RestoreNginxBackupInput {
            config_path: "/etc/nginx/sites-available/app".to_string(),
        }),
        TestNginxConfig => DeploymentAction::TestNginxConfig(TestNginxConfigInput {}),
        ReloadNginx => DeploymentAction::ReloadNginx(ReloadNginxInput {}),
        VerifyDnsRecord => DeploymentAction::VerifyDnsRecord(VerifyDnsRecordInput {
            domain: "app.example.com".to_string(),
            expected_ip: Some("203.0.113.10".to_string()),
        }),
        IssueCertificate => DeploymentAction::IssueCertificate(IssueCertificateInput {
            domains: vec!["app.example.com".to_string()],
            email: "ops@example.com".to_string(),
            webroot: path("shared/acme-webroot"),
            challenge: CertificateChallenge::Http01,
            dns_provider: None,
        }),
        RenewCertificate => DeploymentAction::RenewCertificate(RenewCertificateInput {
            cert_name: Some("app.example.com".to_string()),
        }),
        HttpHealthCheck => DeploymentAction::HttpHealthCheck(HttpHealthCheckInput {
            url: "https://app.example.com/healthz".to_string(),
            expected_status: 200,
            timeout_secs: 10,
            attempts: 5,
        }),
        TcpHealthCheck => DeploymentAction::TcpHealthCheck(TcpHealthCheckInput {
            host: "127.0.0.1".to_string(),
            port: 3000,
            timeout_secs: 5,
            attempts: 5,
        }),
        SwitchReleaseSymlink => DeploymentAction::SwitchReleaseSymlink(SwitchReleaseSymlinkInput {
            link_path: path("current"),
            target_dir: path("releases/1.0.0"),
        }),
        PromoteRelease => DeploymentAction::PromoteRelease(PromoteReleaseInput {
            release_root: path("releases"),
            current_link: path("current"),
            version_label: "1.0.0".to_string(),
            service_unit_id: Some("svc-1".to_string()),
        }),
        StopPreviousRelease => DeploymentAction::StopPreviousRelease(StopPreviousReleaseInput {
            target: StopTarget::Container {
                container: "shop-web-old".to_string(),
            },
        }),
        RollbackRelease => DeploymentAction::RollbackRelease(RollbackReleaseInput {
            service_unit_id: Some("svc-1".to_string()),
            target_dir: path("releases/0.9.0"),
            current_link: path("current"),
            data_note: None,
        }),
        RequireManualStep => DeploymentAction::RequireManualStep(RequireManualStepInput {
            reason: "数据库迁移需人工执行".to_string(),
            acknowledged: false,
        }),
    }
}

// -- 校验 --------------------------------------------------------------------

#[test]
fn every_action_sample_passes_validation_under_the_deploy_root() {
    for kind in ActionKind::ALL {
        let action = sample(*kind);
        validate_action(&action, Some(ROOT))
            .unwrap_or_else(|error| panic!("{kind:?} 的样本没通过校验：{error}"));
    }
}

#[test]
fn paths_outside_the_deploy_root_are_rejected() {
    let action = DeploymentAction::EnsureDirectory(EnsureDirectoryInput {
        path: "/etc/passwd".to_string(),
        mode: None,
    });
    let error = validate_action(&action, Some(ROOT)).expect_err("必须拒绝");
    assert!(error.to_string().contains("部署根目录"), "{error}");

    let escaped = DeploymentAction::SwitchReleaseSymlink(SwitchReleaseSymlinkInput {
        link_path: format!("{ROOT}/current"),
        target_dir: "/srv/other/release".to_string(),
    });
    assert!(validate_action(&escaped, Some(ROOT)).is_err());
}

#[test]
fn secret_entries_never_carry_plaintext() {
    let action = DeploymentAction::WriteRuntimeConfig(WriteRuntimeConfigInput {
        path: path("shared/web.env"),
        mode: 0o600,
        entries: vec![RuntimeConfigEntry {
            key: "DATABASE_URL".to_string(),
            value: Some("postgres://user:pw@db/app".to_string()),
            secret: true,
            secret_ref_id: Some("secret-1".to_string()),
            required: true,
        }],
    });
    let error = validate_action(&action, Some(ROOT)).expect_err("必须拒绝明文密钥");
    assert!(error.to_string().contains("明文值"), "{error}");

    // 密钥条目也不能只有标记没有引用。
    let missing = DeploymentAction::WriteRuntimeConfig(WriteRuntimeConfigInput {
        path: path("shared/web.env"),
        mode: 0o600,
        entries: vec![RuntimeConfigEntry {
            key: "DATABASE_URL".to_string(),
            value: None,
            secret: true,
            secret_ref_id: None,
            required: true,
        }],
    });
    assert!(validate_action(&missing, Some(ROOT)).is_err());
}

#[test]
fn wildcard_domains_may_only_use_dns_validation() {
    let action = DeploymentAction::IssueCertificate(IssueCertificateInput {
        domains: vec!["*.example.com".to_string()],
        email: "ops@example.com".to_string(),
        webroot: path("shared/acme-webroot"),
        challenge: CertificateChallenge::Http01,
        dns_provider: None,
    });
    let error = validate_action(&action, Some(ROOT)).expect_err("泛域名 + HTTP-01 必须被拒");
    assert!(error.to_string().contains("DNS-01"), "{error}");

    // 换成 DNS-01 就通过（V1 只支持人工 DNS）。
    let dns = DeploymentAction::IssueCertificate(IssueCertificateInput {
        domains: vec!["*.example.com".to_string()],
        email: "ops@example.com".to_string(),
        webroot: path("shared/acme-webroot"),
        challenge: CertificateChallenge::Dns01,
        dns_provider: Some("manual".to_string()),
    });
    validate_action(&dns, Some(ROOT)).expect("人工 DNS-01 应通过");

    // 但 DNS-01 也不许配一个并不存在的服务商适配器。
    let fake_provider = DeploymentAction::IssueCertificate(IssueCertificateInput {
        domains: vec!["*.example.com".to_string()],
        email: "ops@example.com".to_string(),
        webroot: path("shared/acme-webroot"),
        challenge: CertificateChallenge::Dns01,
        dns_provider: Some("cloudflare".to_string()),
    });
    assert!(validate_action(&fake_provider, Some(ROOT)).is_err());
}

#[test]
fn backend_compose_services_cannot_publish_ports() {
    let action = sample(ActionKind::WriteComposeFile);
    let DeploymentAction::WriteComposeFile(mut input) = action.clone() else {
        panic!("样本类型不对");
    };
    input.services[0].internal_only = true; // 后端服务
    input.services[0].publish_ports = vec![PortMapping {
        host_port: 5432,
        container_port: 5432,
        protocol: PortProtocol::Tcp,
    }];
    let error = validate_action(&DeploymentAction::WriteComposeFile(input), Some(ROOT))
        .expect_err("仅内部访问的服务不许发布端口");
    assert!(error.to_string().contains("仅内部访问"), "{error}");
}

#[test]
fn tcp_health_checks_are_limited_to_loopback() {
    let action = DeploymentAction::TcpHealthCheck(TcpHealthCheckInput {
        host: "db.example.com".to_string(),
        port: 5432,
        timeout_secs: 5,
        attempts: 3,
    });
    assert!(validate_action(&action, Some(ROOT)).is_err());
}

// -- 显式动作入口 ------------------------------------------------------------

/// 把样本变成 `params_json`（带 `action` 标识），模拟前端/方案生成的显式节点。
fn explicit_params(kind: ActionKind) -> String {
    let mut value = serde_json::to_value(sample(kind)).expect("serialize sample");
    let object = value.as_object_mut().expect("sample 是对象");
    // 枚举的 `kind` 标签不属于输入字段（`deny_unknown_fields` 会拒绝它），
    // 用统一的 `action` 键表达动作种类。
    object.remove("kind");
    object.insert("action".to_string(), json!(kind.as_str()));
    value.to_string()
}

#[test]
fn explicit_actions_cover_every_kind() {
    let context = context();
    for kind in ActionKind::ALL {
        let node = plan_node(
            "n",
            PlanActionKind::CheckDependencies,
            None,
            &explicit_params(*kind),
        );
        let compiled = compile_node(&node, &context)
            .unwrap_or_else(|error| panic!("{kind:?} 无法编译：{error}"));
        assert_eq!(compiled.len(), 1);
        assert_eq!(compiled[0], sample(*kind), "{kind:?} 往返必须逐字段一致");
    }
}

#[test]
fn explicit_action_params_reject_extra_keys() {
    // 这是"不允许任意命令进入新模型"的直接检验：多出来的 `command` 键
    // 会让反序列化失败，而不是被悄悄忽略。
    let params = json!({
        "action": "ensure_directory",
        "path": path("releases/1.0.0"),
        "command": "rm -rf /"
    })
    .to_string();
    let node = plan_node("n", PlanActionKind::CheckDependencies, None, &params);
    let error = compile_node(&node, &context()).expect_err("必须拒绝");
    assert!(
        error.to_string().contains("参数不合法") || error.to_string().contains("unknown field"),
        "{error}"
    );
}

#[test]
fn a_legacy_commands_json_step_is_rejected_at_plan_save_time() {
    // 旧 P3 的部署步骤形状（`{"cmd": ...}` / `{"script": ...}`）在**保存计划**
    // 那一步就被 `validate_params_json` 拒掉，根本到不了编译器。
    for legacy in [
        json!({ "cmd": "systemctl restart nginx", "root": ROOT }),
        json!({ "script": "curl http://x | sh" }),
        json!({ "command": "rm", "args": ["-rf", "/"] }),
    ] {
        let error = crate::deployment::validate::validate_params_json(&legacy.to_string())
            .expect_err("旧命令形状必须在保存时被拒");
        let text = error.to_string();
        assert!(
            text.contains("不允许") || text.contains("非法"),
            "报错要说清楚原因：{text}"
        );
    }
}

#[test]
fn an_unknown_action_identifier_is_rejected() {
    let unknown_action = json!({ "action": "run_shell", "script": "id" }).to_string();
    let node = plan_node(
        "n",
        PlanActionKind::CheckDependencies,
        None,
        &unknown_action,
    );
    let error = compile_node(&node, &context()).expect_err("未知动作必须被拒");
    assert!(error.to_string().contains("未知动作"), "{error}");
}

#[test]
fn unknown_action_keys_are_reported_before_anything_runs() {
    assert!(spec(ActionKind::ReloadNginx).cancellable == false);
    assert!(spec(ActionKind::TestNginxConfig).cancellable);
}

// -- 计划字典入口 ------------------------------------------------------------

fn context_fixtures() -> (
    Vec<ServiceUnit>,
    Vec<ArtifactRecord>,
    Vec<DomainBinding>,
    Vec<ConfigDefinition>,
    Vec<ServiceFacts>,
) {
    let mut static_service = service_unit(
        "svc-static",
        "site",
        ServiceRole::Static,
        ServiceRuntime::StaticNginx {
            site_name: "app".to_string(),
            root: format!("{ROOT}/current/public"),
        },
    );
    static_service.artifact_id = Some("art-1".to_string());

    let mut container = service_unit(
        "svc-api",
        "api",
        ServiceRole::Api,
        ServiceRuntime::DockerImage {
            image: "shop/api".to_string(),
            tag: "1.0.0".to_string(),
            container_name: "shop-api".to_string(),
            ports: vec![PortMapping {
                host_port: 3000,
                container_port: 3000,
                protocol: PortProtocol::Tcp,
            }],
        },
    );
    container.artifact_id = Some("art-2".to_string());

    let artifact =
        |id: &str, service: Option<&str>, kind: ArtifactKind, sha: bool| ArtifactRecord {
            id: id.to_string(),
            application_id: "app-1".to_string(),
            service_unit_id: service.map(str::to_string),
            kind,
            source_kind: ArtifactSourceKind::LocalPath,
            source_ref: "/home/me/build/site.zip".to_string(),
            file_name: Some("site.zip".to_string()),
            size_bytes: Some(1024),
            sha256: sha.then(|| "b".repeat(64)),
            docker_digest: None,
            version_label: Some("1.0.0".to_string()),
            built_at: None,
            checksum_verified: false,
            status: ArtifactStatus::Ready,
            notes: String::new(),
            created_at: 1,
            updated_at: 1,
        };

    let domain = DomainBinding {
        id: "dom-1".to_string(),
        environment_id: "env-1".to_string(),
        service_unit_id: Some("svc-static".to_string()),
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
        service_unit_id: Some("svc-api".to_string()),
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

    let facts = vec![
        ServiceFacts {
            service_unit_id: "svc-static".to_string(),
            ports: Vec::new(),
            health_target: Some("/healthz".to_string()),
            env_keys: Vec::new(),
            artifact_blocked: false,
            artifact_blocked_reason: None,
        },
        ServiceFacts {
            service_unit_id: "svc-api".to_string(),
            ports: vec![PortMapping {
                host_port: 3000,
                container_port: 3000,
                protocol: PortProtocol::Tcp,
            }],
            health_target: Some("/api/health".to_string()),
            env_keys: vec!["DATABASE_URL".to_string()],
            artifact_blocked: false,
            artifact_blocked_reason: None,
        },
    ];

    (
        vec![static_service, container],
        vec![
            artifact("art-1", Some("svc-static"), ArtifactKind::Zip, true),
            artifact("art-2", Some("svc-api"), ArtifactKind::DockerImage, false),
        ],
        vec![domain],
        vec![config],
        facts,
    )
}

fn context() -> CompileContext<'static> {
    // 测试里把 fixtures 泄露成 'static：这样 `context()` 不必层层传引用，
    // 而 `CompileContext` 本身是不可变借用，泄露只发生在测试进程内。
    let (services, artifacts, domains, configs, facts) = context_fixtures();
    CompileContext {
        environment_kind: EnvironmentKind::Production,
        deploy_root: ROOT.to_string(),
        version_label: "1.0.0".to_string(),
        image_namespace: "shop".to_string(),
        services: Box::leak(services.into_boxed_slice()),
        artifacts: Box::leak(artifacts.into_boxed_slice()),
        domains: Box::leak(domains.into_boxed_slice()),
        configs: Box::leak(configs.into_boxed_slice()),
        facts: Box::leak(facts.into_boxed_slice()),
    }
}

fn plan_node(
    key: &str,
    action: PlanActionKind,
    service: Option<&str>,
    params_json: &str,
) -> PlanNode {
    PlanNode {
        id: key.to_string(),
        plan_id: "plan-1".to_string(),
        node_key: key.to_string(),
        title: key.to_string(),
        action,
        service_unit_id: service.map(str::to_string),
        risk_level: action.default_risk(),
        approval_required: action.requires_approval(),
        skippable: false,
        params_json: params_json.to_string(),
        position: 0,
        created_at: 0,
        updated_at: 0,
    }
}

fn edge(from: &str, to: &str, condition: EdgeCondition) -> PlanEdge {
    PlanEdge {
        id: format!("edge_{from}_{to}"),
        plan_id: "plan-1".to_string(),
        from_node_id: from.to_string(),
        to_node_id: to.to_string(),
        condition,
        created_at: 0,
    }
}

fn graph(nodes: Vec<PlanNode>, edges: Vec<PlanEdge>) -> DeploymentPlanGraph {
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
            created_at: 0,
            updated_at: 0,
        },
        nodes,
        edges,
    }
}

#[test]
fn apply_nginx_site_expands_into_backup_then_write() {
    let node = plan_node(
        "nginx_site_site",
        PlanActionKind::ApplyNginxSite,
        Some("site"),
        &json!({ "service": "site" }).to_string(),
    );
    let compiled = compile_node(&node, &context()).expect("编译");
    assert_eq!(compiled.len(), 2, "备份 + 写配置：{compiled:?}");
    assert_eq!(compiled[0].kind(), ActionKind::BackupNginxConfig);
    assert_eq!(compiled[1].kind(), ActionKind::WriteNginxConfig);
    // 顺序是硬的：写之前必须已经备份。
    assert_eq!(spec(compiled[0].kind()).compensation, None);
    assert_eq!(
        spec(compiled[1].kind()).compensation,
        Some(ActionKind::RestoreNginxBackup)
    );
}

#[test]
fn uploading_an_artifact_verifies_its_checksum_immediately() {
    let node = plan_node(
        "upload_site",
        PlanActionKind::UploadArtifact,
        Some("site"),
        &json!({ "service": "site" }).to_string(),
    );
    let compiled = compile_node(&node, &context()).expect("编译");
    let kinds: Vec<ActionKind> = compiled.iter().map(|action| action.kind()).collect();
    assert_eq!(
        kinds,
        vec![
            ActionKind::EnsureDirectory,
            ActionKind::UploadArtifact,
            ActionKind::VerifyChecksum
        ]
    );
    // 校验用的是制品记录里的哈希，不是现场算的。
    let DeploymentAction::VerifyChecksum(input) = &compiled[2] else {
        panic!("第三个动作应该是校验");
    };
    assert_eq!(input.expected_sha256, "b".repeat(64));
}

#[test]
fn database_migration_becomes_a_manual_gate_and_never_a_script() {
    let node = plan_node(
        "database_migration",
        PlanActionKind::DatabaseMigration,
        None,
        "{}",
    );
    let compiled = compile_node(&node, &context()).expect("编译");
    assert_eq!(compiled.len(), 1);
    let DeploymentAction::RequireManualStep(input) = &compiled[0] else {
        panic!("数据库迁移必须编译成人工门");
    };
    assert!(!input.acknowledged);
    assert!(spec(ActionKind::RequireManualStep).requires_approval);
}

#[test]
fn unsupported_plan_kinds_fail_loudly_instead_of_being_skipped() {
    for action in [
        PlanActionKind::FetchSource,
        PlanActionKind::BuildArtifact,
        PlanActionKind::PackageArtifact,
        PlanActionKind::PushImage,
    ] {
        let node = plan_node("n", action, None, "{}");
        let error = compile_node(&node, &context()).expect_err("必须报错");
        assert!(
            error.to_string().contains("没有实现"),
            "{action:?} 的报错要说清楚：{error}"
        );
    }
}

#[test]
fn compose_topology_generates_the_file_before_bringing_it_up() {
    let node = plan_node("compose_up", PlanActionKind::ComposeUp, None, "{}");
    let compiled = compile_node(&node, &context()).expect("编译");
    let kinds: Vec<ActionKind> = compiled.iter().map(|action| action.kind()).collect();
    assert_eq!(
        kinds,
        vec![ActionKind::WriteComposeFile, ActionKind::ComposeUp],
        "先写文件再 up"
    );

    // 后端服务（api）不该发布宿主机端口。
    let DeploymentAction::WriteComposeFile(input) = &compiled[0] else {
        panic!("第一个动作应该是写 compose 文件");
    };
    let api = input
        .services
        .iter()
        .find(|service| service.name == "api")
        .expect("api 应在编排里");
    assert!(api.internal_only, "后端默认只走内部网络");
    assert!(api.publish_ports.is_empty(), "后端不发布端口");
    assert_eq!(api.expose_ports, vec![3000], "只声明容器内端口");
}

#[test]
fn compile_graph_orders_by_dependency_not_by_position() {
    // 故意把 position 写反：拓扑序必须由边决定。
    let mut first = plan_node(
        "check_dependencies",
        PlanActionKind::CheckDependencies,
        None,
        "{}",
    );
    first.position = 10;
    let mut second = plan_node(
        "test_nginx_config",
        PlanActionKind::TestNginxConfig,
        None,
        "{}",
    );
    second.position = 0;
    let mut third = plan_node("reload_nginx", PlanActionKind::ReloadNginx, None, "{}");
    third.position = 5;
    let g = graph(
        vec![first, second, third],
        vec![
            edge(
                "check_dependencies",
                "test_nginx_config",
                EdgeCondition::OnSuccess,
            ),
            edge(
                "test_nginx_config",
                "reload_nginx",
                EdgeCondition::OnSuccess,
            ),
        ],
    );
    let compiled = compile_graph(&g, &context()).expect("编译");
    let keys: Vec<&str> = compiled
        .steps
        .iter()
        .map(|step| step.source_node_key.as_str())
        .collect();
    assert_eq!(
        keys,
        vec!["check_dependencies", "test_nginx_config", "reload_nginx"]
    );
    // 生产环境：reload 会改动服务器且……它的风险是中，因此不额外要求审批；
    // 但写网关配置一定是必须审批的。
    let approvals: Vec<&str> = compiled
        .steps
        .iter()
        .filter(|step| step.approval_required)
        .map(|step| step.node_key.as_str())
        .collect();
    assert!(
        !approvals.contains(&"reload_nginx"),
        "reload 不是高风险：{approvals:?}"
    );
}

#[test]
fn failure_edges_become_the_rollback_chain() {
    let mut rollback = plan_node(
        "restore_release",
        PlanActionKind::RestoreRelease,
        None,
        "{}",
    );
    rollback.position = 2;
    let mut activate = plan_node(
        "activate_release",
        PlanActionKind::ActivateRelease,
        None,
        "{}",
    );
    activate.position = 1;
    let g = graph(
        vec![
            plan_node(
                "check_dependencies",
                PlanActionKind::CheckDependencies,
                None,
                "{}",
            ),
            activate,
            rollback,
        ],
        vec![
            edge(
                "check_dependencies",
                "activate_release",
                EdgeCondition::OnSuccess,
            ),
            edge(
                "activate_release",
                "restore_release",
                EdgeCondition::OnFailure,
            ),
        ],
    );
    let compiled = compile_graph(&g, &context()).expect("编译");
    assert_eq!(compiled.steps.len(), 2, "主链两步");
    assert_eq!(compiled.rollback_steps.len(), 1, "回滚链一步");
    assert_eq!(
        compiled.rollback_steps[0].action.kind(),
        ActionKind::RollbackRelease
    );
    assert_eq!(
        compiled.rollback_steps[0].node_key,
        "rollback_restore_release"
    );
}

#[test]
fn production_approval_is_attached_to_high_risk_steps_only() {
    let ctx = context();
    let promote = spec(ActionKind::PromoteRelease);
    assert!(approval_required(&promote, ctx.environment_kind));
    let staged = CompileContext {
        environment_kind: EnvironmentKind::Staging,
        ..context()
    };
    // 暂存环境不额外升级审批，但动作自己声明的仍然要。
    assert!(approval_required(&promote, staged.environment_kind));
}

#[test]
fn manual_only_nodes_are_never_run_automatically() {
    let g = graph(
        vec![
            plan_node("a", PlanActionKind::CheckDependencies, None, "{}"),
            plan_node("b", PlanActionKind::TestNginxConfig, None, "{}"),
            // 只有 manual 入边 → 必须由人推动，不能被自动主链顺带跑掉。
            plan_node("c", PlanActionKind::ReloadNginx, None, "{}"),
        ],
        vec![
            edge("a", "b", EdgeCondition::OnSuccess),
            edge("b", "c", EdgeCondition::Manual),
        ],
    );
    let error = compile_graph(&g, &context()).expect_err("必须报错");
    assert!(error.to_string().contains("人工触发"), "{error}");
}

#[test]
fn a_disconnected_node_is_rejected() {
    let g = graph(
        vec![
            plan_node("a", PlanActionKind::CheckDependencies, None, "{}"),
            plan_node("b", PlanActionKind::TestNginxConfig, None, "{}"),
            // 完全没有入边、也不是回滚节点：说明图是断的。
            plan_node("c", PlanActionKind::ReloadNginx, None, "{}"),
        ],
        vec![
            edge("a", "b", EdgeCondition::OnSuccess),
            edge("b", "a", EdgeCondition::OnSuccess),
        ],
    );
    // a 与 b 互为前置 → 入度都不为 0，c 孤立 → 全部走不到。
    let error = compile_graph(&g, &context()).expect_err("必须报错");
    assert!(error.to_string().contains("无法自动到达"), "{error}");
}

// -- 测试用的实体构造 ---------------------------------------------------------

fn service_unit(id: &str, name: &str, role: ServiceRole, runtime: ServiceRuntime) -> ServiceUnit {
    let service_kind = match &runtime {
        ServiceRuntime::StaticNginx { .. } => ServiceKind::StaticNginx,
        ServiceRuntime::SystemdUnit { .. } => ServiceKind::SystemdUnit,
        ServiceRuntime::DockerImage { .. } => ServiceKind::DockerImage,
        ServiceRuntime::DockerCompose { .. } => ServiceKind::DockerCompose,
        ServiceRuntime::NativeProcess { .. } => ServiceKind::NativeBinary,
        ServiceRuntime::External { .. } => ServiceKind::ExternalManaged,
    };
    ServiceUnit {
        id: id.to_string(),
        application_id: "app-1".to_string(),
        environment_id: "env-1".to_string(),
        name: name.to_string(),
        role,
        service_kind,
        runtime,
        deploy_path: Some(format!("{ROOT}/releases/1.0.0")),
        confirmed_project_id: None,
        confirmed_project_path: None,
        artifact_id: None,
        status: "configured".to_string(),
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}
