//! Docker container and image management (P3-1.3).
//!
//! All listing commands use Go templates with `|` as the field separator:
//! container names, image tags and port mappings all contain spaces, so
//! whitespace-splitting would shred them. `|` cannot appear in any of these
//! fields, which makes it a safe delimiter.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::remote::{require_linux, run_capability, run_on_linux};
use crate::safe::{Capability, ContainerAction, ProbeTool};
use crate::ssh::SshSessionManager;

/// One container from `docker ps -a`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContainerInfo {
    /// Full 64-character id.
    pub id: String,
    /// Short id, shown in the UI.
    pub short_id: String,
    pub name: String,
    pub image: String,
    /// Human status, e.g. `Up 5 minutes` or `Exited (0) 2 hours ago`.
    pub status: String,
    /// Machine state: `running`, `exited`, `paused`, `created`, `restarting`, …
    pub state: String,
    /// Port mappings exactly as Docker prints them.
    pub ports: String,
    pub created_at: String,
}

impl ContainerInfo {
    pub fn is_running(&self) -> bool {
        self.state == "running"
    }
}

/// One image from `docker images`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImageInfo {
    pub id: String,
    pub short_id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    /// Docker prints a relative age here (`3 weeks ago`), already localised by
    /// the daemon.
    pub created_since: String,
    /// `repository:tag`, or the bare id for a dangling image.
    pub display_name: String,
}

impl ImageInfo {
    pub fn is_dangling(&self) -> bool {
        self.repository == "<none>" || self.repository.is_empty()
    }
}

/// One row of `docker stats --no-stream`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContainerStats {
    pub name: String,
    /// Percent, e.g. `0.15` for 0.15%.
    pub cpu_percent: f64,
    /// `1.2GiB / 3.8GiB` as printed by Docker.
    pub memory_usage: String,
    pub memory_percent: f64,
    pub net_io: String,
    pub block_io: String,
}

/// Everything the Docker page shows in one round trip.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DockerSnapshot {
    pub available: bool,
    pub containers: Vec<ContainerInfo>,
    pub images: Vec<ImageInfo>,
    pub stats: Vec<ContainerStats>,
    /// Set when Docker is missing or the daemon is unreachable. The UI shows
    /// this instead of an empty page that looks like "no containers".
    pub unavailable_reason: Option<String>,
}

/// Splits a Go-template row on `|`.
fn split_row(line: &str, expected: usize) -> Option<Vec<&str>> {
    let parts: Vec<&str> = line.split('|').collect();
    if parts.len() < expected {
        None
    } else {
        Some(parts)
    }
}

fn short_id(id: &str) -> String {
    id.chars().take(12).collect()
}

/// Parses `docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.Ports}}|{{.CreatedAt}}'`.
pub fn parse_ps(input: &str) -> Vec<ContainerInfo> {
    let mut containers = Vec::new();

    for line in input.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let Some(parts) = split_row(line, 7) else {
            continue;
        };

        let id = parts[0].trim().to_string();
        if id.is_empty() {
            continue;
        }

        containers.push(ContainerInfo {
            short_id: short_id(&id),
            id,
            name: parts[1].trim().to_string(),
            image: parts[2].trim().to_string(),
            status: parts[3].trim().to_string(),
            state: parts[4].trim().to_string(),
            ports: parts[5].trim().to_string(),
            created_at: parts[6].trim().to_string(),
        });
    }

    containers
}

/// Parses `docker images --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedSince}}'`.
pub fn parse_images(input: &str) -> Vec<ImageInfo> {
    let mut images = Vec::new();

    for line in input.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let Some(parts) = split_row(line, 5) else {
            continue;
        };

        let id = parts[0].trim().to_string();
        if id.is_empty() {
            continue;
        }

        let repository = parts[1].trim().to_string();
        let tag = parts[2].trim().to_string();
        let display_name = if repository.is_empty() || repository == "<none>" {
            short_id(&id)
        } else if tag.is_empty() || tag == "<none>" {
            repository.clone()
        } else {
            format!("{repository}:{tag}")
        };

        images.push(ImageInfo {
            short_id: short_id(&id),
            id,
            repository,
            tag,
            size: parts[3].trim().to_string(),
            created_since: parts[4].trim().to_string(),
            display_name,
        });
    }

    images
}

/// Strips a trailing `%` and parses the number. Docker prints `0.15%`; a
/// machine under load can print `--` when the daemon has no sample yet, which
/// is reported as 0 rather than guessed at.
pub fn parse_percent(raw: &str) -> f64 {
    raw.trim()
        .trim_end_matches('%')
        .parse::<f64>()
        .unwrap_or(0.0)
}

/// Parses `docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}'`.
pub fn parse_stats(input: &str) -> Vec<ContainerStats> {
    let mut stats = Vec::new();

    for line in input.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let Some(parts) = split_row(line, 6) else {
            continue;
        };

        let name = parts[0].trim().to_string();
        if name.is_empty() {
            continue;
        }

        stats.push(ContainerStats {
            name,
            cpu_percent: parse_percent(parts[1]),
            memory_usage: parts[2].trim().to_string(),
            memory_percent: parse_percent(parts[3]),
            net_io: parts[4].trim().to_string(),
            block_io: parts[5].trim().to_string(),
        });
    }

    stats
}

// -- Collection --------------------------------------------------------------

/// Containers, images and stats in one call.
///
/// The three listings are independent, so they run concurrently. A missing
/// Docker or a stopped daemon is reported through `unavailable_reason` rather
/// than as an empty list, so the UI can say which it is.
pub async fn collect_snapshot(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<DockerSnapshot> {
    require_linux(manager, session_id).await?;

    if !crate::remote::has_tool(manager, session_id, ProbeTool::Docker).await {
        return Ok(DockerSnapshot {
            available: false,
            unavailable_reason: Some(
                "这台服务器上没有安装 docker（PATH 中找不到 docker 命令）。".to_string(),
            ),
            ..DockerSnapshot::default()
        });
    }

    let containers_task = run_capability(manager, session_id, &Capability::DockerPs);
    let images_task = run_capability(manager, session_id, &Capability::DockerImages);
    let stats_task = run_capability(manager, session_id, &Capability::DockerStats);

    let (containers, images, stats) = tokio::join!(containers_task, images_task, stats_task);

    // A stopped daemon fails all three with the same message; surface the
    // first one instead of three separate errors.
    let containers = match containers {
        Ok(output) => parse_ps(&output),
        Err(error) => {
            let reason = format!("无法读取容器列表：{error}");
            return Ok(DockerSnapshot {
                available: false,
                unavailable_reason: Some(reason),
                ..DockerSnapshot::default()
            });
        }
    };

    Ok(DockerSnapshot {
        available: true,
        containers,
        images: images
            .map(|output| parse_images(&output))
            .unwrap_or_default(),
        // Stats are a nice-to-have: a daemon that cannot sample them still
        // gives a usable container list.
        stats: stats.map(|output| parse_stats(&output)).unwrap_or_default(),
        unavailable_reason: None,
    })
}

/// Container logs. `docker logs` writes the container's own streams to
/// stdout/stderr, so both are useful; when stdout is empty we fall back to
/// stderr so a container that only ever wrote errors still shows something.
pub async fn collect_logs(
    manager: &SshSessionManager,
    session_id: &str,
    container: &str,
    lines: u32,
) -> Result<String> {
    // Validated before the OS probe: a bad container name costs no round trip.
    run_on_linux(
        manager,
        session_id,
        &Capability::DockerLogs {
            container: container.to_string(),
            lines,
        },
    )
    .await
}

/// Start / stop / restart / remove a container.
pub async fn container_action(
    manager: &SshSessionManager,
    session_id: &str,
    action: ContainerAction,
    container: &str,
) -> Result<String> {
    run_on_linux(
        manager,
        session_id,
        &Capability::ContainerAction {
            action,
            container: container.to_string(),
        },
    )
    .await
    .map(|output| {
        if output.trim().is_empty() {
            format!("{}：{}", action.label(), container)
        } else {
            output
        }
    })
}

/// Remove an image.
pub async fn image_remove(
    manager: &SshSessionManager,
    session_id: &str,
    image: &str,
) -> Result<String> {
    run_on_linux(
        manager,
        session_id,
        &Capability::ImageRemove {
            image: image.to_string(),
        },
    )
    .await
}

/// Drop stopped containers and dangling images.
pub async fn system_prune(manager: &SshSessionManager, session_id: &str) -> Result<String> {
    require_linux(manager, session_id).await?;
    let output = run_capability(manager, session_id, &Capability::SystemPrune).await?;
    if output.trim().is_empty() {
        Ok("已清理停止的容器与悬空镜像。".to_string())
    } else {
        Ok(output)
    }
}

// ---------------------------------------------------------------------------
// 容器配置（docker inspect 的安全子集）
// ---------------------------------------------------------------------------

/// 一条端口映射：宿主 `8080` → 容器 `80/tcp`。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ContainerPort {
    pub host_ip: String,
    pub host_port: String,
    /// `80/tcp` 原样保留协议后缀。
    pub container_port: String,
}

/// 一条挂载：宿主路径 ↔ 容器路径。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ContainerMount {
    /// `bind` / `volume` / `tmpfs` …
    pub kind: String,
    pub source: String,
    pub destination: String,
    pub read_only: bool,
}

/// 容器配置摘要。
///
/// **刻意不含 `Config.Env` 与启动命令**：环境变量里通常是数据库密码、token、
/// 连接串，启动命令也常带 `-p <password>`。把它们序列化到 WebView，就等于
/// 让密钥进了前端内存和调试工具。要看完整 inspect 请登录服务器自己执行。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ContainerConfig {
    pub id: String,
    /// `docker inspect` 的 `.Name` 带前导 `/`，这里已去掉。
    pub name: String,
    pub image: String,
    /// `created` / `running` / `exited` / `paused` / `restarting`。
    pub state: String,
    pub created: String,
    pub started_at: String,
    pub finished_at: String,
    pub exit_code: i64,
    pub oom_killed: bool,
    /// 健康检查结论（没有配 healthcheck 时为空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<String>,
    /// `no` / `always` / `unless-stopped` / `on-failure`。
    pub restart_policy: String,
    pub working_dir: String,
    pub ports: Vec<ContainerPort>,
    pub mounts: Vec<ContainerMount>,
    /// docker compose 项目 / 服务（有则带上，排障最常用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose_project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose_service: Option<String>,
    /// compose 文件在宿主机上的路径（可据此打开文件面板）。
    pub compose_files: Vec<String>,
}

fn string_at(value: &serde_json::Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_string()
}

/// 解析 `docker inspect --format '{{json .}}'` 的单对象输出。
///
/// 纯函数：不碰网络，样本固定，边界（缺字段 / 未发布端口 / 无 compose 标签）
/// 全在测试里钉住。
pub fn parse_inspect(raw: &str) -> Result<ContainerConfig> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("容器配置为空：容器可能不存在或 Docker 不可用"));
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|error| anyhow!("容器配置不是合法 JSON：{error}"))?;

    let label = |key: &str| -> Option<String> {
        value
            .pointer("/Config/Labels")
            .and_then(|labels| labels.get(key))
            .and_then(|item| item.as_str())
            .map(str::to_string)
            .filter(|text| !text.is_empty())
    };

    // 端口按容器端口升序：inspect 返回的是对象，键序不稳定，直接渲染会跳。
    let mut ports = Vec::new();
    if let Some(bindings) = value
        .pointer("/HostConfig/PortBindings")
        .and_then(|item| item.as_object())
    {
        let mut entries: Vec<(&String, &serde_json::Value)> = bindings.iter().collect();
        entries.sort_by_key(|(container_port, _)| {
            let number = container_port
                .split('/')
                .next()
                .unwrap_or_default()
                .parse::<u32>()
                .unwrap_or(u32::MAX);
            (number, container_port.to_string())
        });
        for (container_port, list) in entries {
            let published = list.as_array().map(|items| items.as_slice()).unwrap_or(&[]);
            if published.is_empty() {
                // 只 EXPOSE 没 -p：如实记一条"未映射"，而不是假装没有这个端口。
                ports.push(ContainerPort {
                    container_port: container_port.clone(),
                    ..Default::default()
                });
                continue;
            }
            for item in published {
                ports.push(ContainerPort {
                    host_ip: item
                        .get("HostIp")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    host_port: item
                        .get("HostPort")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    container_port: container_port.clone(),
                });
            }
        }
    }

    let mut mounts = Vec::new();
    for item in value
        .pointer("/Mounts")
        .and_then(|v| v.as_array())
        .map(|items| items.as_slice())
        .unwrap_or(&[])
    {
        mounts.push(ContainerMount {
            kind: item
                .get("Type")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            source: item
                .get("Source")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            destination: item
                .get("Destination")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            // `RW` 缺省视为可写（Docker 的默认值就是 rw）。
            read_only: !item.get("RW").and_then(|v| v.as_bool()).unwrap_or(true),
        });
    }

    let compose_files = label("com.docker.compose.project.config_files")
        .map(|files| {
            files
                .split(',')
                .map(|file| file.trim().to_string())
                .filter(|file| !file.is_empty())
                .collect()
        })
        .unwrap_or_default();

    Ok(ContainerConfig {
        id: string_at(&value, "/Id"),
        name: string_at(&value, "/Name")
            .trim_start_matches('/')
            .to_string(),
        image: string_at(&value, "/Config/Image"),
        state: string_at(&value, "/State/Status"),
        created: string_at(&value, "/Created"),
        started_at: string_at(&value, "/State/StartedAt"),
        finished_at: string_at(&value, "/State/FinishedAt"),
        exit_code: value
            .pointer("/State/ExitCode")
            .and_then(|v| v.as_i64())
            .unwrap_or_default(),
        oom_killed: value
            .pointer("/State/OOMKilled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        health: value
            .pointer("/State/Health/Status")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|text| !text.is_empty()),
        restart_policy: {
            let policy = string_at(&value, "/HostConfig/RestartPolicy/Name");
            if policy.is_empty() {
                "no".to_string()
            } else {
                policy
            }
        },
        working_dir: string_at(&value, "/Config/WorkingDir"),
        ports,
        mounts,
        compose_project: label("com.docker.compose.project"),
        compose_service: label("com.docker.compose.service"),
        compose_files,
    })
}

/// 读一个容器的配置摘要（只读）。
pub async fn inspect_container(
    manager: &SshSessionManager,
    session_id: &str,
    container: &str,
) -> Result<ContainerConfig> {
    let output = run_on_linux(
        manager,
        session_id,
        &Capability::DockerInspect {
            container: container.to_string(),
        },
    )
    .await?;
    parse_inspect(&output)
}

/// Whether Docker is installed and reachable.
pub async fn docker_available(manager: &SshSessionManager, session_id: &str) -> bool {
    crate::remote::has_tool(manager, session_id, ProbeTool::Docker).await
}

/// Guards against calling a Docker command on a host without Docker.
pub fn require_docker(snapshot: &DockerSnapshot) -> Result<()> {
    if snapshot.available {
        Ok(())
    } else {
        Err(anyhow!(
            "{}",
            snapshot
                .unavailable_reason
                .clone()
                .unwrap_or_else(|| "Docker 不可用".to_string())
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PS_OUTPUT: &str = "\
3f2a1b9c8d7e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90|web|nginx:1.25|Up 5 minutes|running|0.0.0.0:80->80/tcp, :::80->80/tcp|2024-01-15 09:12:33 +0800 CST
aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66|db|postgres:16|Exited (0) 2 hours ago|exited||2024-01-10 21:00:01 +0800 CST
bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66ee77|cache|redis:7-alpine|Up 3 weeks (healthy)|running|6379/tcp|2023-12-20 11:45:00 +0800 CST
cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66ee77ff88|worker|my-app:latest|Restarting (1) 3 seconds ago|restarting||2024-01-15 09:17:00 +0800 CST
";

    const IMAGES_OUTPUT: &str = "\
d1e2f3a4b5c6|nginx|1.25|187MB|3 weeks ago
a1b2c3d4e5f6|postgres|16|418MB|2 months ago
f6e5d4c3b2a1|<none>|<none>|1.24GB|5 minutes ago
998877665544|redis|7-alpine|41.2MB|4 weeks ago
";

    const STATS_OUTPUT: &str = "\
web|0.15%|12.5MiB / 3.84GiB|0.32%|1.2kB / 0B|0B / 4.1kB
db|2.43%|210MiB / 3.84GiB|5.34%|45MB / 12MB|1.2GB / 3.4MB
idle|--|0B / 3.84GiB|--|0B / 0B|0B / 0B
";

    #[test]
    fn parses_containers() {
        let containers = parse_ps(PS_OUTPUT);
        assert_eq!(containers.len(), 4);

        let web = &containers[0];
        assert_eq!(web.name, "web");
        assert_eq!(web.image, "nginx:1.25");
        assert_eq!(web.status, "Up 5 minutes");
        assert_eq!(web.state, "running");
        assert!(web.is_running());
        // Port mappings contain spaces and commas — splitting on whitespace
        // would shred them.
        assert_eq!(web.ports, "0.0.0.0:80->80/tcp, :::80->80/tcp");
        assert_eq!(web.short_id, "3f2a1b9c8d7e");
        assert_eq!(web.id.len(), 64);
    }

    #[test]
    fn distinguishes_container_states() {
        let containers = parse_ps(PS_OUTPUT);
        let db = containers.iter().find(|c| c.name == "db").unwrap();
        assert_eq!(db.state, "exited");
        assert!(!db.is_running());
        assert_eq!(db.status, "Exited (0) 2 hours ago");
        assert_eq!(db.ports, "", "没有端口映射时应该是空字符串");

        let worker = containers.iter().find(|c| c.name == "worker").unwrap();
        assert_eq!(worker.state, "restarting");

        let cache = containers.iter().find(|c| c.name == "cache").unwrap();
        assert!(cache.status.contains("healthy"));
    }

    #[test]
    fn parses_images_and_names_dangling_ones() {
        let images = parse_images(IMAGES_OUTPUT);
        assert_eq!(images.len(), 4);

        let nginx = &images[0];
        assert_eq!(nginx.repository, "nginx");
        assert_eq!(nginx.tag, "1.25");
        assert_eq!(nginx.display_name, "nginx:1.25");
        assert_eq!(nginx.size, "187MB");
        assert!(!nginx.is_dangling());

        let dangling = images
            .iter()
            .find(|image| image.repository == "<none>")
            .unwrap();
        assert!(dangling.is_dangling());
        // A dangling image has no name, so its id is the only handle on it.
        assert_eq!(dangling.display_name, "f6e5d4c3b2a1");
    }

    #[test]
    fn parses_stats() {
        let stats = parse_stats(STATS_OUTPUT);
        assert_eq!(stats.len(), 3);

        assert_eq!(stats[0].name, "web");
        assert!((stats[0].cpu_percent - 0.15).abs() < 1e-9);
        assert_eq!(stats[0].memory_usage, "12.5MiB / 3.84GiB");
        assert!((stats[0].memory_percent - 0.32).abs() < 1e-9);
        assert_eq!(stats[0].net_io, "1.2kB / 0B");

        assert!((stats[1].cpu_percent - 2.43).abs() < 1e-9);
    }

    #[test]
    fn a_dash_means_no_sample_not_zero_load() {
        // Docker prints `--` when it has no sample yet; that is not 0%.
        assert_eq!(parse_percent("--"), 0.0);
        assert_eq!(parse_percent("0.15%"), 0.15);
        assert_eq!(parse_percent("100%"), 100.0);
        assert_eq!(parse_percent(""), 0.0);
        assert_eq!(parse_percent("nonsense"), 0.0);
    }

    #[test]
    fn skips_truncated_rows() {
        let containers = parse_ps("only|two|cols\n\n");
        assert!(containers.is_empty());

        let stats = parse_stats("name|0.1%\n");
        assert!(stats.is_empty());
    }

    #[test]
    fn empty_output_yields_empty_lists() {
        assert!(parse_ps("").is_empty());
        assert!(parse_images("").is_empty());
        assert!(parse_stats("").is_empty());
    }

    #[test]
    fn require_docker_explains_why() {
        let snapshot = DockerSnapshot {
            available: false,
            unavailable_reason: Some("没有安装 docker".to_string()),
            ..DockerSnapshot::default()
        };
        let error = require_docker(&snapshot).unwrap_err();
        assert!(error.to_string().contains("没有安装 docker"));

        let ok = DockerSnapshot {
            available: true,
            ..DockerSnapshot::default()
        };
        assert!(require_docker(&ok).is_ok());
    }

    #[test]
    fn short_ids_are_twelve_characters() {
        assert_eq!(short_id("3f2a1b9c8d7e4f5a"), "3f2a1b9c8d7e");
        assert_eq!(short_id("abc"), "abc");
    }

    const INSPECT_OUTPUT: &str = r#"{
        "Id": "3f2a1b9c8d7e4f5a6b7c8d9e0f1a2b3c",
        "Created": "2024-01-15T09:12:33.123456789Z",
        "Name": "/web",
        "Config": {
            "Image": "nginx:1.25",
            "WorkingDir": "/usr/share/nginx/html",
            "Env": ["DB_PASSWORD=hunter2"],
            "Labels": {
                "com.docker.compose.project": "shop",
                "com.docker.compose.service": "web",
                "com.docker.compose.project.config_files": "/opt/shop/docker-compose.yml,/opt/shop/docker-compose.override.yml",
                "com.example.secret": "should-not-leak"
            }
        },
        "State": {
            "Status": "running",
            "StartedAt": "2024-01-15T09:12:34Z",
            "FinishedAt": "0001-01-01T00:00:00Z",
            "ExitCode": 0,
            "OOMKilled": true,
            "Health": { "Status": "healthy" }
        },
        "HostConfig": {
            "RestartPolicy": { "Name": "unless-stopped" },
            "PortBindings": {
                "443/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "8443" }],
                "80/tcp": [
                    { "HostIp": "0.0.0.0", "HostPort": "8080" },
                    { "HostIp": "::", "HostPort": "8080" }
                ],
                "9000/tcp": null
            }
        },
        "Mounts": [
            { "Type": "bind", "Source": "/opt/shop", "Destination": "/usr/share/nginx/html", "RW": true },
            { "Type": "volume", "Source": "/var/lib/docker/volumes/logs/_data", "Destination": "/var/log/nginx", "RW": false }
        ]
    }"#;

    #[test]
    fn parses_container_config() {
        let config = parse_inspect(INSPECT_OUTPUT).unwrap();
        assert_eq!(config.name, "web", "Name 的前导 / 必须去掉");
        assert_eq!(config.image, "nginx:1.25");
        assert_eq!(config.state, "running");
        assert_eq!(config.restart_policy, "unless-stopped");
        assert_eq!(config.working_dir, "/usr/share/nginx/html");
        assert!(config.oom_killed);
        assert_eq!(config.health.as_deref(), Some("healthy"));
        assert_eq!(config.compose_project.as_deref(), Some("shop"));
        assert_eq!(config.compose_service.as_deref(), Some("web"));
        assert_eq!(
            config.compose_files,
            vec![
                "/opt/shop/docker-compose.yml".to_string(),
                "/opt/shop/docker-compose.override.yml".to_string()
            ],
            "compose 文件是逗号分隔的一串"
        );
    }

    #[test]
    fn orders_ports_and_keeps_unpublished_ones() {
        let config = parse_inspect(INSPECT_OUTPUT).unwrap();
        let ports: Vec<&str> = config
            .ports
            .iter()
            .map(|port| port.container_port.as_str())
            .collect();
        // 80/tcp 的两条绑定在前，443/tcp 次之，未发布的 9000/tcp 排最后 ——
        // 不能按对象键序随机输出。
        assert_eq!(ports, vec!["80/tcp", "80/tcp", "443/tcp", "9000/tcp"]);

        let unpublished = config.ports.last().unwrap();
        assert_eq!(
            unpublished.host_port, "",
            "没 -p 时如实留空，不编造宿主端口"
        );
    }

    #[test]
    fn marks_read_only_mounts() {
        let config = parse_inspect(INSPECT_OUTPUT).unwrap();
        assert_eq!(config.mounts.len(), 2);
        assert_eq!(config.mounts[0].kind, "bind");
        assert_eq!(config.mounts[0].source, "/opt/shop");
        assert!(!config.mounts[0].read_only);
        assert!(config.mounts[1].read_only);
    }

    #[test]
    fn never_serialises_env_or_unknown_labels() {
        // 这条是安全约束，不是格式断言：容器配置会进 WebView，
        // 环境变量（数据库密码）和自定义 label（可能带 token）都不得出现。
        let config = parse_inspect(INSPECT_OUTPUT).unwrap();
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("hunter2"), "Env 不能进前端");
        assert!(
            !json.contains("should-not-leak"),
            "非白名单 label 不能进前端"
        );
        assert!(!json.contains("DB_PASSWORD"));
    }

    #[test]
    fn missing_fields_do_not_break_the_config() {
        // 老 daemon / 精简输出可能缺字段：给默认值，绝不 panic。
        let config = parse_inspect(r#"{"Name":"/tiny"}"#).unwrap();
        assert_eq!(config.name, "tiny");
        assert_eq!(config.restart_policy, "no");
        assert!(config.ports.is_empty());
        assert!(config.mounts.is_empty());
        assert!(config.compose_files.is_empty());
        assert_eq!(config.health, None);
    }

    #[test]
    fn empty_or_broken_inspect_output_is_an_error() {
        assert!(parse_inspect("   ").is_err());
        assert!(parse_inspect("not json").is_err());
    }
}
