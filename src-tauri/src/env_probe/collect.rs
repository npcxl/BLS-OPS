//! 唯一有 I/O 的一层：走 `safe::Capability` 白名单 + `remote` 固定命令，
//! 全程只读，绝不修改服务器状态。

use anyhow::Result;

use crate::remote::{has_tool, run_capability};
use crate::safe::{Capability, ProbeTool};
use crate::ssh::SshSessionManager;

use super::model::*;
use super::parse::{apply_binary_probe, parse_ps_json, select_nginx_candidates};

/// 探测一次 Nginx 运行环境。全程只读：只列容器、只在候选容器里问一句
/// "有没有 nginx 可执行文件"，绝不改服务器状态。
pub async fn probe_nginx_environment(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<NginxEnvironment> {
    let mut warnings = Vec::new();

    let host_installed = Some(has_tool(manager, session_id, ProbeTool::Nginx).await);

    let docker_present = has_tool(manager, session_id, ProbeTool::Docker).await;
    if !docker_present {
        return Ok(NginxEnvironment {
            kind: classify(Vec::new(), host_installed),
            containers: Vec::new(),
            host_installed,
            docker_available: false,
            docker_reason: Some(
                "这台服务器上没有安装 docker（PATH 中找不到 docker 命令）。".to_string(),
            ),
            warnings,
        });
    }

    // 一次 `docker ps` 拿全量元数据（labels / 端口 / 挂载），比逐条 inspect 快。
    let ps = match run_capability(manager, session_id, &Capability::DockerPsJson).await {
        Ok(output) => output,
        Err(error) => {
            let reason = classify_docker_error(&error.to_string());
            return Ok(NginxEnvironment {
                // Docker 装了但读不到容器列表：仍可能装在宿主机上。
                kind: classify(Vec::new(), host_installed),
                containers: Vec::new(),
                host_installed,
                docker_available: false,
                docker_reason: Some(reason),
                warnings,
            });
        }
    };

    let all = parse_ps_json(&ps);
    let mut candidates = select_nginx_candidates(&all);

    // 候选容器里再确认一次可执行文件：镜像/名称都像、但里面其实没有 nginx
    // 的容器不该被当成 Nginx 来运维。只有运行中的容器才能 exec。
    for container in candidates.iter_mut() {
        if !container.running {
            warnings.push(format!(
                "容器 {} 未运行，跳过容器内 nginx 探测",
                container.name
            ));
            continue;
        }
        match run_capability(
            manager,
            session_id,
            &Capability::ContainerHasNginx {
                container: container.name.clone(),
            },
        )
        .await
        {
            Ok(output) => apply_binary_probe(container, output.trim().contains("yes")),
            Err(error) => warnings.push(format!(
                "无法探测容器 {} 内是否有 nginx：{error}",
                container.name
            )),
        }
    }

    // 探测过之后重新筛一遍：镜像像 nginx 但容器里没有可执行文件、又没有任何
    // 其它证据的，予以剔除（证据优先于字面）。
    let candidates: Vec<NginxContainer> = candidates
        .into_iter()
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
            // 镜像命中过的容器即使 exec 探测失败（无权限）也保留 —— 失败是
            // "不知道"，不是"没有"。
            is_nginx(&evidence) || (container.flavor.is_some() && container.has_binary.is_none())
        })
        .collect();

    let kind = classify(candidates.clone(), host_installed);
    Ok(NginxEnvironment {
        kind,
        containers: candidates,
        host_installed,
        docker_available: true,
        docker_reason: None,
        warnings,
    })
}

/// 把 Docker 的常见失败翻译成人话。**无权限与守护进程未运行必须区分** ——
/// 前者要换用户/加组，后者要启动服务，混成一句话用户没法行动。
pub fn classify_docker_error(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("permission denied") || lower.contains("access denied") {
        return "当前用户没有权限访问 Docker（不在 docker 组，也不是 root）。请联系管理员或改用有权限的账号。".to_string();
    }
    if lower.contains("cannot connect to the docker daemon")
        || lower.contains("is the docker daemon running")
    {
        return "Docker 守护进程未运行或无法连接（daemon 未启动 / socket 不可访问）。".to_string();
    }
    if lower.contains("超时") || lower.contains("timed out") || lower.contains("timeout") {
        return "读取 Docker 信息超时，服务器可能负载过高。".to_string();
    }
    format!("无法读取容器列表：{message}")
}
