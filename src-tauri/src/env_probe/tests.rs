//! env_probe 的单元测试（取样固定，覆盖"证据 → 结论"的每个分支）。

use super::*;

fn container(name: &str, image: &str) -> NginxContainer {
    let reference = parse_image_ref(image).unwrap_or_default();
    NginxContainer {
        name: name.to_string(),
        image: image.to_string(),
        image_repository: reference.repository.clone(),
        image_tag: reference.tag.clone().unwrap_or_default(),
        flavor: parse_image_ref(image).and_then(|r| flavor_of_image(&r)),
        state: "running".to_string(),
        status: "Up 5 minutes".to_string(),
        running: true,
        ..NginxContainer::default()
    }
}

const PS_JSON: &str = r#"{"ID":"3f2a1b9c8d7e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90","Names":"bls-nginx","Image":"nginx:alpine","State":"running","Status":"Up 5 minutes","Labels":{"com.docker.compose.project":"bls","com.docker.compose.service":"nginx","com.docker.compose.project.working_dir":"/srv/bls"},"Ports":[{"PrivatePort":80,"PublicPort":80,"Type":"tcp"},{"PrivatePort":443,"PublicPort":443,"Type":"tcp"}],"Mounts":[{"Source":"/srv/bls/nginx.conf","Destination":"/etc/nginx/nginx.conf","RW":false}]}"#;

const PS_JSON_REGISTRY: &str = r#"{"ID":"aa11","Names":"gw","Image":"registry.internal:5000/team/nginx:1.25","State":"running","Status":"Up 2 days","Labels":{},"Ports":[{"PrivatePort":80,"PublicPort":8080,"Type":"tcp"}],"Mounts":[]}"#;

const PS_JSON_OTHER: &str = r#"{"ID":"bb22","Names":"db","Image":"postgres:16","State":"running","Status":"Up 2 days","Labels":{},"Ports":[],"Mounts":[]}"#;

#[test]
fn splits_registry_repository_and_tag() {
    let reference = parse_image_ref("registry.internal:5000/team/nginx:1.25").unwrap();
    assert_eq!(
        reference.registry.as_deref(),
        Some("registry.internal:5000")
    );
    assert_eq!(reference.repository, "team/nginx");
    assert_eq!(reference.base(), "nginx");
    assert_eq!(reference.tag.as_deref(), Some("1.25"));

    let plain = parse_image_ref("nginx:alpine").unwrap();
    assert_eq!(plain.registry, None);
    assert_eq!(plain.repository, "nginx");
    assert_eq!(plain.tag.as_deref(), Some("alpine"));

    let hub = parse_image_ref("library/nginx").unwrap();
    assert_eq!(hub.repository, "nginx", "library/ 是 Docker Hub 默认前缀");
}

#[test]
fn digest_references_have_no_tag() {
    let reference = parse_image_ref("nginx@sha256:abc123").unwrap();
    assert!(reference.by_digest);
    assert_eq!(reference.tag, None);
    assert_eq!(flavor_of_image(&reference), Some(NginxFlavor::Nginx));
}

#[test]
fn only_the_last_repository_segment_counts() {
    // 私有仓库前缀后的实际镜像名才是判据。
    assert_eq!(
        flavor_of_image(&parse_image_ref("registry.internal:5000/team/nginx:1.25").unwrap()),
        Some(NginxFlavor::Nginx)
    );
    // ingress 控制器不是"拿来运维的 nginx"，不能误判。
    assert_eq!(
        flavor_of_image(&parse_image_ref("bitnami/nginx-ingress-controller:1.11").unwrap()),
        None
    );
    assert_eq!(
        flavor_of_image(&parse_image_ref("my-nginx-logger:1.0").unwrap()),
        None
    );
    assert_eq!(
        flavor_of_image(&parse_image_ref("openresty/openresty:alpine").unwrap()),
        Some(NginxFlavor::OpenResty)
    );
}

#[test]
fn name_tokens_ignore_compose_replica_numbers() {
    assert_eq!(name_tokens("bls-nginx"), vec!["bls", "nginx"]);
    assert_eq!(name_tokens("app_nginx_1"), vec!["app", "nginx"]);
    // 没有分隔符的连写不算 token —— 避免 sidecar 之类的误判。
    assert!(!name_tokens("nginxsidecar").contains(&"nginx".to_string()));
}

#[test]
fn weak_evidence_alone_does_not_convict() {
    let mut evidence = NginxEvidence::default();
    evidence.name_token_match = true;
    assert!(!is_nginx(&evidence), "单靠容器名不能定罪");

    evidence.compose_service_match = true;
    assert!(
        is_nginx(&evidence),
        "Compose service + 容器名两条弱证据成立"
    );

    let mut strong = NginxEvidence::default();
    strong.image_flavor = Some(NginxFlavor::Nginx);
    assert!(is_nginx(&strong));

    let mut binary = NginxEvidence::default();
    binary.has_binary = Some(true);
    assert!(is_nginx(&binary), "容器里真有 nginx 可执行文件");
}

#[test]
fn parses_docker_ps_json() {
    let containers = parse_ps_json(PS_JSON);
    assert_eq!(containers.len(), 1);

    let nginx = &containers[0];
    assert_eq!(nginx.name, "bls-nginx");
    assert_eq!(nginx.image, "nginx:alpine");
    assert_eq!(nginx.image_repository, "nginx");
    assert_eq!(nginx.image_tag, "alpine");
    assert_eq!(nginx.flavor, Some(NginxFlavor::Nginx));
    assert!(nginx.running);
    assert_eq!(nginx.published_ports(), vec![80, 443]);
    // 配置挂载：宿主机路径 → 容器内 /etc/nginx。
    assert_eq!(nginx.config_mounts().len(), 1);
    assert_eq!(nginx.config_mounts()[0].source, "/srv/bls/nginx.conf");
    assert_eq!(
        nginx.compose.as_ref().unwrap().project,
        "bls",
        "Compose 归属要读出来"
    );
    assert_eq!(nginx.compose.as_ref().unwrap().service, "nginx");
}

#[test]
fn reads_registry_prefixed_images() {
    let containers = parse_ps_json(PS_JSON_REGISTRY);
    let gateway = &containers[0];
    assert_eq!(gateway.flavor, Some(NginxFlavor::Nginx));
    assert_eq!(gateway.image_repository, "team/nginx");
    assert_eq!(gateway.published_ports(), vec![8080]);
}

#[test]
fn skips_non_nginx_containers() {
    let all = parse_ps_json(&format!("{PS_JSON}\n{PS_JSON_REGISTRY}\n{PS_JSON_OTHER}"));
    assert_eq!(all.len(), 3);
    let candidates = select_nginx_candidates(&all);
    assert_eq!(candidates.len(), 2, "postgres 不能入选");
    assert!(candidates.iter().all(|item| item.name != "db"));
}

#[test]
fn classifies_environments() {
    assert_eq!(classify(Vec::new(), Some(true)), NginxKind::Host);
    assert_eq!(classify(Vec::new(), Some(false)), NginxKind::None);
    assert_eq!(classify(Vec::new(), None), NginxKind::None);

    let mut docker = container("bls-nginx", "nginx:alpine");
    assert_eq!(
        classify(vec![docker.clone()], Some(false)),
        NginxKind::Docker
    );

    docker.compose = Some(ComposeRef {
        project: "bls".to_string(),
        service: "nginx".to_string(),
        working_dir: "/srv/bls".to_string(),
    });
    assert_eq!(
        classify(vec![docker.clone()], Some(false)),
        NginxKind::Compose
    );

    // 工作目录不可靠 → 不能算 Compose 环境（裸 compose 依赖当前目录）。
    docker.compose = Some(ComposeRef {
        project: "bls".to_string(),
        service: "nginx".to_string(),
        working_dir: String::new(),
    });
    assert_eq!(classify(vec![docker], Some(false)), NginxKind::Docker);

    let multiple = vec![
        container("a-nginx", "nginx:alpine"),
        container("b-nginx", "nginx:1.25"),
    ];
    assert_eq!(classify(multiple, Some(true)), NginxKind::Multiple);
}

#[test]
fn docker_nginx_gets_docker_exec_commands() {
    let env = NginxEnvironment {
        kind: NginxKind::Docker,
        containers: vec![container("bls-nginx", "nginx:alpine")],
        host_installed: Some(false),
        docker_available: true,
        ..NginxEnvironment::default()
    };
    let commands = nginx_commands(&env, None);
    assert!(commands
        .iter()
        .any(|item| item.command == "docker exec bls-nginx nginx -v"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker exec bls-nginx nginx -t"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker exec bls-nginx nginx -T"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker exec bls-nginx nginx -s reload"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker logs --tail 200 bls-nginx"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker logs -f bls-nginx"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker inspect bls-nginx"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker exec -it bls-nginx sh"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker port bls-nginx"));
    assert!(commands
        .iter()
        .any(|item| item.command.starts_with("docker inspect --format")));
}

#[test]
fn compose_nginx_prefers_compose_commands() {
    let mut nginx = container("bls-nginx", "nginx:alpine");
    nginx.compose = Some(ComposeRef {
        project: "bls".to_string(),
        service: "nginx".to_string(),
        working_dir: "/srv/bls".to_string(),
    });
    let env = NginxEnvironment {
        kind: NginxKind::Compose,
        containers: vec![nginx],
        docker_available: true,
        ..NginxEnvironment::default()
    };
    let commands = nginx_commands(&env, None);
    assert!(commands
        .iter()
        .any(|item| item.command == "docker compose -p bls ps nginx"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker compose -p bls logs --tail 200 nginx"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker compose -p bls exec nginx nginx -t"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker compose -p bls exec nginx nginx -s reload"));
    assert!(commands
        .iter()
        .any(|item| item.command == "docker compose -p bls restart nginx"));
}

#[test]
fn reload_and_restart_keep_real_risk() {
    let env = NginxEnvironment {
        kind: NginxKind::Docker,
        containers: vec![container("bls-nginx", "nginx:alpine")],
        docker_available: true,
        ..NginxEnvironment::default()
    };
    let commands = nginx_commands(&env, None);
    let reload = commands
        .iter()
        .find(|item| item.id == "docker.reload")
        .unwrap();
    assert_eq!(reload.risk, SuggestedRisk::Medium, "reload 会改变运行状态");
    // 只读项不能因为在同一份列表里就被升级或降级。
    for id in [
        "docker.version",
        "docker.test",
        "docker.dump",
        "docker.logs",
    ] {
        let command = commands.iter().find(|item| item.id == id).unwrap();
        assert_eq!(command.risk, SuggestedRisk::ReadOnly, "{id} 必须是只读");
    }
    // 删除类命令绝不在建议里出现。
    assert!(!commands.iter().any(|item| item.command.contains(" rm ")));
    assert!(!commands.iter().any(|item| item.command.contains("rmi")));
}

#[test]
fn multiple_containers_require_a_choice() {
    let env = NginxEnvironment {
        kind: NginxKind::Multiple,
        containers: vec![
            container("a-nginx", "nginx:alpine"),
            container("b-nginx", "nginx:1.25"),
        ],
        docker_available: true,
        ..NginxEnvironment::default()
    };
    assert!(
        nginx_commands(&env, None).is_empty(),
        "没选容器就不能给命令"
    );

    let chosen = nginx_commands(&env, Some("b-nginx"));
    assert!(!chosen.is_empty());
    assert!(
        chosen.iter().all(|item| item.command.contains("b-nginx")),
        "命令必须写进用户选的那个容器"
    );
    assert!(
        nginx_commands(&env, Some("gone")).is_empty(),
        "记住的容器不存在时选择必须失效"
    );
}

#[test]
fn container_names_are_quoted_before_reaching_the_shell() {
    let mut nginx = container("my nginx", "nginx:alpine");
    nginx.running = true;
    nginx.flavor = Some(NginxFlavor::Nginx);
    let commands = container_commands(&nginx, false);
    let version = commands
        .iter()
        .find(|item| item.id == "docker.version")
        .unwrap();
    assert_eq!(version.command, "docker exec \"my nginx\" nginx -v");
    // 正常名字不加多余引号。
    let plain = container("bls-nginx", "nginx:alpine");
    let commands = container_commands(&plain, false);
    assert!(commands
        .iter()
        .any(|item| item.command == "docker exec bls-nginx nginx -v"));
}

#[test]
fn docker_errors_are_explained() {
    let denied = classify_docker_error("Got permission denied while trying to connect");
    assert!(denied.contains("没有权限"));

    let daemon = classify_docker_error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
    assert!(daemon.contains("守护进程未运行"));

    let other = classify_docker_error("something else");
    assert!(other.starts_with("无法读取容器列表"));
}

#[test]
fn host_environment_uses_host_commands() {
    let env = NginxEnvironment {
        kind: NginxKind::Host,
        host_installed: Some(true),
        ..NginxEnvironment::default()
    };
    let commands = nginx_commands(&env, None);
    assert!(commands.iter().any(|item| item.command == "nginx -v"));
    assert!(commands.iter().any(|item| item.command == "nginx -t"));
    assert!(!commands.iter().any(|item| item.command.contains("docker")));
}

#[test]
fn images_are_reused_for_the_docker_snapshot_types() {
    // `docker::ImageInfo` 与容器视图保持同一套镜像判据。
    let image = crate::docker::ImageInfo {
        repository: "team/nginx".to_string(),
        tag: "1.25".to_string(),
        display_name: "registry.internal:5000/team/nginx:1.25".to_string(),
        ..crate::docker::ImageInfo::default()
    };
    let reference = parse_image_ref(&image.display_name).unwrap();
    assert_eq!(reference.base(), "nginx");
    assert_eq!(flavor_of_image(&reference), Some(NginxFlavor::Nginx));
    // `docker ps` 的文本格式与 JSON 格式得到同一个结论。
    let text_row = crate::docker::parse_ps(
            "3f2a1b9c8d7e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90|gw|registry.internal:5000/team/nginx:1.25|Up 2 days|running|0.0.0.0:8080->80/tcp|2024-01-15 09:12:33 +0800 CST",
        );
    assert_eq!(
        flavor_of_image(&parse_image_ref(&text_row[0].image).unwrap()),
        Some(NginxFlavor::Nginx)
    );
}

#[test]
fn binary_probe_is_recorded_as_evidence() {
    let mut nginx = container("weird", "myrepo/thing:1.0");
    assert_eq!(nginx.flavor, None);
    assert_eq!(
        select_nginx_candidates(std::slice::from_ref(&nginx)).len(),
        0
    );
    apply_binary_probe(&mut nginx, true);
    assert_eq!(
        select_nginx_candidates(std::slice::from_ref(&nginx)).len(),
        1
    );
    assert!(nginx
        .reasons
        .iter()
        .any(|reason| reason.contains("可执行文件")));
}

#[test]
fn config_mounts_are_detected() {
    let mut nginx = container("bls-nginx", "nginx:alpine");
    nginx.mounts = vec![
        MountInfo {
            source: "/srv/conf".to_string(),
            destination: "/etc/nginx".to_string(),
            read_only: true,
        },
        MountInfo {
            source: "/srv/html".to_string(),
            destination: "/usr/share/nginx/html".to_string(),
            read_only: true,
        },
    ];
    assert_eq!(nginx.config_mounts().len(), 1);
    assert_eq!(nginx.config_mounts()[0].source, "/srv/conf");
}
