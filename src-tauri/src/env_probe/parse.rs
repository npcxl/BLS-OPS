//! `docker ps --format '{{json .}}'` 解析（纯逻辑，零 I/O）。

use serde::Deserialize;

use super::model::*;

// -- `docker ps --format '{{json .}}'` 解析 ----------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
struct PsRow {
    #[serde(default)]
    #[serde(alias = "ID")]
    id: String,
    #[serde(default)]
    #[serde(alias = "Names")]
    names: String,
    #[serde(default)]
    #[serde(alias = "Image")]
    image: String,
    #[serde(default)]
    #[serde(alias = "State")]
    state: String,
    #[serde(default)]
    #[serde(alias = "Status")]
    status: String,
    #[serde(default, alias = "Labels")]
    labels: Labels,
    #[serde(default, alias = "Ports")]
    ports: Vec<PsPort>,
    #[serde(default, alias = "Mounts")]
    mounts: Vec<PsMount>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct Labels(std::collections::HashMap<String, String>);

#[derive(Debug, Clone, Default, Deserialize)]
struct PsPort {
    #[serde(default, alias = "PrivatePort")]
    private_port: u16,
    #[serde(default, alias = "PublicPort")]
    public_port: Option<u16>,
    #[serde(default, rename = "Type", alias = "type")]
    protocol: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct PsMount {
    #[serde(default, alias = "Source")]
    source: String,
    #[serde(default, alias = "Destination")]
    destination: String,
    /// `docker ps` 的挂载条目用 `RW` 表示可写；缺失时保守按只读处理。
    #[serde(default, rename = "RW", alias = "rw")]
    rw: bool,
}

/// 解析 `docker ps -a --no-trunc --format '{{json .}}'`。
///
/// 每个字段都容忍缺失/改名：Docker 版本差异不该让整次探测失败，宁可少一点
/// 元数据，也不能把页面变成一片空白。
pub fn parse_ps_json(input: &str) -> Vec<NginxContainer> {
    let mut out = Vec::new();
    for line in input.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let row: PsRow = match serde_json::from_str(line) {
            Ok(row) => row,
            Err(_) => continue,
        };
        if row.id.is_empty() && row.names.is_empty() {
            continue;
        }
        let image_ref = parse_image_ref(&row.image).unwrap_or_default();
        let flavor = parse_image_ref(&row.image).and_then(|reference| flavor_of_image(&reference));
        let compose = compose_of(&row.labels.0);
        let name = row.names.clone();
        let running = row.state == "running";

        let mut reasons = Vec::new();
        if let Some(flavor) = flavor {
            reasons.push(format!(
                "镜像 {} 是 {}",
                image_ref.repository,
                flavor.label()
            ));
        }
        if let Some(ref compose) = compose {
            if compose.service.eq_ignore_ascii_case("nginx")
                || compose.service.eq_ignore_ascii_case("openresty")
            {
                reasons.push(format!("Compose service 为 {}", compose.service));
            }
        }
        if name_tokens(&name)
            .iter()
            .any(|token| token == "nginx" || token == "openresty")
        {
            reasons.push(format!("容器名包含 nginx：{name}"));
        }

        out.push(NginxContainer {
            short_id: row.id.chars().take(12).collect(),
            name,
            image: row.image.clone(),
            image_repository: image_ref.repository.clone(),
            image_tag: image_ref.tag.clone().unwrap_or_default(),
            flavor,
            running,
            state: row.state.clone(),
            status: row.status.clone(),
            ports: row
                .ports
                .iter()
                .map(|port| PortBinding {
                    container_port: port.private_port,
                    host_port: port.public_port,
                    protocol: port.protocol.clone(),
                })
                .collect(),
            mounts: row
                .mounts
                .iter()
                .map(|mount| MountInfo {
                    source: mount.source.clone(),
                    destination: mount.destination.clone(),
                    // `docker ps` 的 Mounts 用 `RW` 表示可写；缺失时保守认为只读。
                    read_only: !mount.rw,
                })
                .collect(),
            compose,
            has_binary: None,
            reasons,
        });
    }
    out
}

/// 从容器 labels 里读 Compose 归属。任一项缺失就是 `None` —— 宁可退回
/// `docker exec`，也不生成跑不起来的 compose 命令。
fn compose_of(labels: &std::collections::HashMap<String, String>) -> Option<ComposeRef> {
    let project = labels.get("com.docker.compose.project")?.trim().to_string();
    let service = labels.get("com.docker.compose.service")?.trim().to_string();
    if project.is_empty() || service.is_empty() {
        return None;
    }
    let working_dir = labels
        .get("com.docker.compose.project.working_dir")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    Some(ComposeRef {
        project,
        service,
        working_dir,
    })
}

/// 把 `docker exec` 探测到的可执行文件结果合并进容器视图。
pub fn apply_binary_probe(container: &mut NginxContainer, present: bool) {
    container.has_binary = Some(present);
    if present {
        container
            .reasons
            .push("容器内存在 nginx 可执行文件".to_string());
    }
}

/// 用镜像 + 名称 + Compose 三条证据筛出 Nginx 容器。
///
/// 这一步**不看容器内可执行文件**（那要 `docker exec`，只对候选做）。
pub fn select_nginx_candidates(containers: &[NginxContainer]) -> Vec<NginxContainer> {
    containers
        .iter()
        .filter(|container| {
            let evidence = NginxEvidence {
                image_flavor: container.flavor,
                compose_service_match: container
                    .compose
                    .as_ref()
                    .map(|compose| {
                        compose.service.eq_ignore_ascii_case("nginx")
                            || compose.service.eq_ignore_ascii_case("openresty")
                    })
                    .unwrap_or(false),
                name_token_match: name_tokens(&container.name)
                    .iter()
                    .any(|token| token == "nginx" || token == "openresty"),
                has_binary: container.has_binary,
            };
            is_nginx(&evidence)
        })
        .cloned()
        .collect()
}

// -- 采集 -------------------------------------------------------------------
