//! P3 第一轮：部署实例优先发现。
//!
//! 流程（修订方案）：先由能力图谱（`capability_probe`）决定启用哪些收集器 ——
//! 只有探测确认安装的组件才会执行其命令；每个收集器枚举服务器上**真实存在**
//! 的部署实例（容器 / systemd 服务 / Nginx 站点），深入查询单个实例提取
//! ID、路径、端口与配置，输出 [`DeploymentInstance`] 供定向 marker 扫描反查
//! 源码目录。
//!
//! 铁律：**绝不伪造源码路径**。一个只有镜像、没有 Compose 标签、没有 bind
//! mount、没有工作目录线索的容器，就是 `source_known = false` 的"运行实例，
//! 源码未知"，而不是一个猜测出来的路径。
//!
//! 所有命令都经 `safe::Capability` 白名单；实例输出里的路径在进入结果前必须
//! 通过 `safe::validate_abs_path` —— 服务器返回的数据按不可信输入处理。

mod docker;
mod k8s;
mod model;
mod nginx;
mod systemd;

pub use docker::docker_instance_from_inspect;
pub use k8s::parse_kube_pods;
pub use model::{is_config_path, is_host_project_path, DeploymentInstance};
pub use nginx::{parse_nginx_effective, parse_ss_listen, NginxSiteBlock};
pub use systemd::{extract_exec_paths, parse_systemd_show, systemd_instance};

use crate::capability_probe::ServerCapabilityProfile;
use crate::ssh::SshSessionManager;

/// 按能力图谱收集所有真实部署实例。
///
/// 未安装（`Some(false)`）或无法判定（`None`）的组件**不会**执行任何命令。
/// 单个收集器失败只记 warning，不影响其它收集器 —— 部分证据好过没有证据，
/// 但失败原因必须如实呈现。
pub async fn collect_instances(
    session_id: &str,
    mgr: &SshSessionManager,
    profile: &ServerCapabilityProfile,
    warnings: &mut Vec<String>,
) -> Vec<DeploymentInstance> {
    let mut out = Vec::new();
    if profile.deployment.docker == Some(true) {
        match docker::collect_docker(session_id, mgr).await {
            Ok(mut list) => out.append(&mut list),
            Err(error) => warnings.push(format!("Docker 实例收集失败：{error}")),
        }
    }
    if profile.deployment.systemd == Some(true) {
        match systemd::collect_systemd(session_id, mgr, warnings).await {
            Ok(mut list) => out.append(&mut list),
            Err(error) => warnings.push(format!("systemd 实例收集失败：{error}")),
        }
    }
    if profile.deployment.nginx == Some(true) {
        match nginx::collect_nginx(session_id, mgr, warnings).await {
            Ok(mut list) => out.append(&mut list),
            Err(error) => warnings.push(format!("Nginx 实例收集失败：{error}")),
        }
    }
    // Kubernetes：kubectl 装了才问集群。注意这与 docker 收集器**不冲突** ——
    // k8s 用 docker/containerd 承载 Pod，所以同一台机器上两者都会产出实例，
    // 分别代表"集群视角的 Pod"与"节点上的容器"，靠 `runtime` 字段区分。
    if profile.deployment.kubernetes == Some(true) {
        match k8s::collect_k8s(session_id, mgr, warnings).await {
            Ok(mut list) => out.append(&mut list),
            Err(error) => warnings.push(format!("Kubernetes 工作负载收集失败：{error}")),
        }
    }
    out
}

#[cfg(test)]
mod tests;
