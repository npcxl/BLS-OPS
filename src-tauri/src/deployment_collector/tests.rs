//! Collector parsing tests (moved verbatim from `deployment_collector.rs`).
//!
//! These lock in the two rules that make the output trustworthy: a container
//! with no host-side evidence is reported as "source unknown" rather than
//! guessed, and container-internal paths never masquerade as host paths.

use super::*;
use serde_json::json;

// -- Docker inspect ------------------------------------------------------

#[test]
fn docker_compose_container_yields_source_paths() {
    let value = json!({
        "Id": "a81c3f8deadbeef0000000000000000000000000000000000000000000000000",
        "Name": "/order-api",
        "State": { "Status": "running" },
        "Config": {
            "Image": "registry.example.com/order-api:1.4",
            "WorkingDir": "/app",
            "Labels": {
                "com.docker.compose.project": "order-platform",
                "com.docker.compose.service": "order-api",
                "com.docker.compose.project.working_dir": "/srv/order-platform",
                "com.docker.compose.project.config_files": "/srv/order-platform/docker-compose.yml"
            }
        },
        "NetworkSettings": { "Ports": { "8082/tcp": [ { "HostPort": "8082" } ] } },
        "Mounts": [
            { "Type": "bind", "Source": "/srv/order-platform/order-api", "Destination": "/app" },
            { "Type": "volume", "Source": "/var/lib/docker/volumes/site/_data", "Destination": "/var/www" }
        ]
    });
    let instance = docker_instance_from_inspect(&value).expect("应解析出实例");
    assert_eq!(instance.name, "order-api");
    assert_eq!(instance.kind, "docker");
    assert_eq!(instance.status, "running");
    assert!(instance.source_known);
    assert!(instance
        .source_paths
        .contains(&"/srv/order-platform".to_string()));
    assert!(instance
        .source_paths
        .contains(&"/srv/order-platform/order-api".to_string()));
    assert_eq!(
        instance.config_files,
        vec!["/srv/order-platform/docker-compose.yml"]
    );
    assert_eq!(instance.ports, vec![8082]);
    assert!(instance.detail.contains("order-platform"));
    // 容器内路径绝不冒充宿主路径。
    assert!(!instance.source_paths.contains(&"/app".to_string()));
    assert!(!instance.working_directories.contains(&"/app".to_string()));
}

#[test]
fn docker_image_only_container_has_unknown_source() {
    let value = json!({
        "Id": "f20d7a1fffff",
        "Name": "/mystery",
        "State": { "Status": "exited" },
        "Config": { "Image": "nginx:latest" },
        "NetworkSettings": { "Ports": {} },
        "Mounts": []
    });
    let instance = docker_instance_from_inspect(&value).expect("应解析出实例");
    assert!(!instance.source_known, "没有宿主线索时不得伪造路径");
    assert!(instance.source_paths.is_empty());
    assert_eq!(instance.status, "exited");
}

#[test]
fn docker_runtime_paths_are_rejected() {
    assert!(!is_host_project_path("/var/lib/docker/volumes/x/_data"));
    assert!(!is_host_project_path("/etc/nginx/conf.d"));
    assert!(!is_host_project_path("relative/path"));
    assert!(!is_host_project_path("/srv/app; rm -rf /"));
    assert!(is_host_project_path("/srv/order-platform"));
}

// -- systemctl show ------------------------------------------------------

#[test]
fn systemd_show_blocks_are_split_and_classified() {
    let output = "\
Id=order.service
FragmentPath=/etc/systemd/system/order.service
WorkingDirectory=/srv/order-service
ExecStart=/usr/bin/java -jar /srv/order-service/app.jar (unquoted; argument: \"x\")
EnvironmentFiles=/srv/order-service/.env (ignore_errors=no)

Id=systemd-journald.service
FragmentPath=/usr/lib/systemd/system/systemd-journald.service
WorkingDirectory=
ExecStart=/usr/lib/systemd/systemd-journald
EnvironmentFiles=
";
    let blocks = parse_systemd_show(output);
    assert_eq!(blocks.len(), 2);

    let order = &blocks[0];
    let instance =
        systemd_instance("order.service", "active", "running", &order.1).expect("业务服务");
    assert!(instance.source_known);
    assert!(instance
        .source_paths
        .contains(&"/srv/order-service".to_string()));
    // ExecStart 指向 /usr/bin（bin 目录不算项目目录，但其父路径判定在业务根外）
    assert!(instance
        .config_files
        .contains(&"/etc/systemd/system/order.service".to_string()));
    assert!(instance
        .config_files
        .contains(&"/srv/order-service/.env".to_string()));
    assert!(instance.detail.contains("java"));

    // 系统服务（路径不在业务根下）不进入项目发现。
    let journald = &blocks[1];
    assert!(
        systemd_instance("systemd-journald.service", "active", "running", &journald.1).is_none()
    );
}

// -- nginx -T ------------------------------------------------------------

#[test]
fn nginx_static_and_proxy_sites_are_parsed() {
    let config = "\
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# configuration file /etc/nginx/nginx.conf:
user www-data;
http {
# configuration file /etc/nginx/conf.d/admin.conf:
    server {
        listen 80;
        server_name admin.example.com;
        root /var/www/admin-web/dist;
        location / { try_files $uri $uri/ /index.html; }
    }
# configuration file /etc/nginx/conf.d/api.conf:
    server {
        listen 443 ssl;
        server_name api.example.com;
        location / {
            proxy_pass http://127.0.0.1:8082;
        }
    }
}
";
    let sites = parse_nginx_effective(config);
    assert_eq!(sites.len(), 2, "两个 server 块都应被识别");

    let admin = &sites[0];
    assert_eq!(admin.name, "admin.example.com");
    assert_eq!(admin.listen_ports, vec![80]);
    assert_eq!(admin.root.as_deref(), Some("/var/www/admin-web/dist"));
    assert_eq!(
        admin.config_file.as_deref(),
        Some("/etc/nginx/conf.d/admin.conf")
    );

    let api = &sites[1];
    assert_eq!(api.root, None);
    assert_eq!(api.proxy_ports, vec![8082]);
    assert_eq!(api.listen_ports, vec![443]);
}

#[test]
fn ss_listen_extracts_pids() {
    let output = "\
State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      128        0.0.0.0:8082       0.0.0.0:*    users:((\"java\",pid=4321,fd=45))
LISTEN 0      128          0.0.0.0:80         0.0.0.0:*    users:((\"nginx\",pid=100,fd=6),(\"nginx\",pid=101,fd=6))
LISTEN 0      128             [::]:22            [::]:*    users:((\"sshd\",pid=9,fd=3))
";
    let map = parse_ss_listen(output);
    assert_eq!(map.get(&8082), Some(&4321));
    assert_eq!(map.get(&80), Some(&100), "取第一个 pid");
    assert_eq!(map.get(&22), Some(&9));
    assert!(map.get(&443).is_none());
}

#[test]
fn exec_paths_skip_annotations() {
    let paths =
        extract_exec_paths("/usr/bin/java -jar /srv/app/main.jar (unquoted; argument: \"x\")");
    assert_eq!(paths, vec!["/usr/bin/java", "/srv/app/main.jar"]);
}
