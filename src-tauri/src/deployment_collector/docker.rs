//! Docker collector — `docker ps` then one deep `inspect` per container.

use serde_json::Value;

use super::model::{is_config_path, is_host_project_path, push_unique, DeploymentInstance};
use crate::remote::run_on_linux;
use crate::safe::Capability;
use crate::service_catalog::{identify_image, parse_k8s_container_name, InstanceRuntime};
use crate::ssh::SshSessionManager;

/// 每批 inspect 的容器上限（`safe::Capability::DockerInspectMany` 的校验上限）。
const INSPECT_BATCH: usize = 20;

pub(crate) async fn collect_docker(
    session_id: &str,
    mgr: &SshSessionManager,
) -> anyhow::Result<Vec<DeploymentInstance>> {
    // 第一步：列出全部容器（含已停止），拿到稳定 ID。
    let listing = run_on_linux(mgr, session_id, &Capability::DockerPs).await?;
    let containers = crate::docker::parse_ps(&listing);
    let mut instances = Vec::new();
    if containers.is_empty() {
        return Ok(instances);
    }

    // 第二步：按 ID 深查。分批一次 inspect 多个容器，每行一个 JSON 对象。
    for chunk in containers.chunks(INSPECT_BATCH) {
        let ids: Vec<String> = chunk.iter().map(|c| c.id.clone()).collect();
        let output = run_on_linux(
            mgr,
            session_id,
            &Capability::DockerInspectMany {
                containers: ids.clone(),
            },
        )
        .await?;
        for line in output.lines() {
            let line = line.trim();
            if !line.starts_with('{') {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(value) => {
                    if let Some(instance) = docker_instance_from_inspect(&value) {
                        instances.push(instance);
                    }
                }
                Err(_) => continue, // 一行坏 JSON 不拖垮整批
            }
        }
    }
    Ok(instances)
}

/// 把 `docker inspect` 的单个 JSON 对象解析成实例。
///
/// 关键点：只有 **宿主机路径**（Compose working_dir、bind mount 的 Source、
/// Compose 配置文件）才进入 `source_paths` / `config_files`；
/// `Config.WorkingDir` 是容器内路径，只进摘要，绝不冒充宿主路径。
pub fn docker_instance_from_inspect(value: &Value) -> Option<DeploymentInstance> {
    let id = value.get("Id")?.as_str()?.to_string();
    let name = value
        .get("Name")
        .and_then(Value::as_str)
        .map(|n| n.trim_start_matches('/').to_string())
        .unwrap_or_else(|| id.chars().take(12).collect());
    let status = value
        .pointer("/State/Status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let image = value
        .pointer("/Config/Image")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    let labels = value.pointer("/Config/Labels").and_then(Value::as_object);
    let label = |key: &str| {
        labels
            .and_then(|map| map.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let compose_project = label("com.docker.compose.project");
    let compose_service = label("com.docker.compose.service");
    let compose_workdir = label("com.docker.compose.project.working_dir");
    let compose_files = label("com.docker.compose.project.config_files");

    // Compose 配置文件是冒号分隔的宿主机绝对路径列表。
    let config_files: Vec<String> = compose_files
        .as_deref()
        .map(|raw| {
            raw.split(':')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    // 宿主端口映射：NetworkSettings.Ports 的值数组里取 HostPort。
    let mut ports: Vec<u16> = Vec::new();
    if let Some(map) = value
        .pointer("/NetworkSettings/Ports")
        .and_then(Value::as_object)
    {
        for bindings in map.values() {
            if let Some(list) = bindings.as_array() {
                for binding in list {
                    if let Some(host_port) = binding
                        .get("HostPort")
                        .and_then(Value::as_str)
                        .and_then(|p| p.parse::<u16>().ok())
                    {
                        if !ports.contains(&host_port) {
                            ports.push(host_port);
                        }
                    }
                }
            }
        }
    }
    ports.sort_unstable();

    // bind mount 的 Source 是宿主机路径 → 源码候选。
    let mut source_paths: Vec<String> = Vec::new();
    if let Some(mounts) = value.get("Mounts").and_then(Value::as_array) {
        for mount in mounts {
            let source = mount.get("Source").and_then(Value::as_str).unwrap_or("");
            if is_host_project_path(source) {
                push_unique(&mut source_paths, source.to_string());
            }
        }
    }

    // Compose working_dir 是最强的源码位置证据。
    let mut working_directories: Vec<String> = Vec::new();
    if let Some(dir) = compose_workdir.as_deref() {
        if is_host_project_path(dir) {
            push_unique(&mut working_directories, dir.to_string());
            push_unique(&mut source_paths, dir.to_string());
        }
    }

    // **归属判定**：容器名以 `k8s_` 开头说明它其实是 Kubernetes 的 Pod 容器，
    // 只是恰好由 docker/containerd 运行。同一台机器上 `docker ps` 会同时列出
    // 普通容器和 k8s 工作负载，容器名是唯一能区分二者的依据（除非再跑 kubectl）。
    let k8s = parse_k8s_container_name(&name);
    let runtime = if k8s.is_some() {
        InstanceRuntime::Kubernetes
    } else {
        InstanceRuntime::Container
    };

    let mut detail = format!("镜像 {image}");
    if let Some(k8s) = &k8s {
        // Pod 沙箱（pause）容器没有业务进程，明确标注，避免被当成服务。
        if k8s.is_sandbox {
            detail = format!(
                "Kubernetes Pod {}/{} · 沙箱容器 · {detail}",
                k8s.namespace, k8s.pod
            );
        } else {
            detail = format!(
                "Kubernetes {}/{} · 容器 {} · {detail}",
                k8s.namespace, k8s.pod, k8s.container
            );
        }
    }
    if let (Some(project), Some(service)) = (&compose_project, &compose_service) {
        detail = format!("Compose 项目 {project} · 服务 {service} · {detail}");
    } else if let Some(project) = &compose_project {
        detail = format!("Compose 项目 {project} · {detail}");
    }

    // 识别镜像跑的是什么服务：MySQL / Redis / Nginx …。识别不出就是 None。
    let service = identify_image(image).map(|identity| identity.detected());

    // 源码已知 = 有任一宿主候选路径；否则就是"运行实例，源码未知"。
    let source_known = !source_paths.is_empty();
    Some(DeploymentInstance {
        id: format!("docker:{id}"),
        kind: "docker".into(),
        name,
        status,
        runtime,
        image: Some(image.to_string()),
        service,
        // k8s 的 pause 沙箱容器属于集群基础设施，不是用户部署的东西。
        system_owned: k8s.as_ref().map(|k| k.is_sandbox).unwrap_or(false),
        ports,
        working_directories,
        config_files: config_files
            .into_iter()
            .filter(|p| is_config_path(p))
            .collect(),
        source_paths,
        source_known,
        detail,
    })
}
