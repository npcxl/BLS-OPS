//! Shared model and path rules for every deployment collector.

use serde::{Deserialize, Serialize};

use crate::safe::validate_abs_path;

/// 一个真实存在的部署实例（容器 / systemd 服务 / Nginx 站点）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeploymentInstance {
    /// 稳定 ID：`docker:<容器ID>` / `systemd:<单元名>` / `nginx:<站点名>`。
    pub id: String,
    /// 部署方式：`docker` | `systemd` | `nginx`。
    pub kind: String,
    /// 展示名：容器名 / 单元名 / server_name。
    pub name: String,
    /// 运行状态（原样来自服务器）。
    pub status: String,
    /// 实例对外端口（容器宿主映射端口 / systemd 监听未知为空 / Nginx listen）。
    pub ports: Vec<u16>,
    /// 宿主机上的工作目录（绝不包含容器内路径）。
    pub working_directories: Vec<String>,
    /// 配置文件（宿主机路径）：Compose 文件、unit 片段、Nginx 配置。
    pub config_files: Vec<String>,
    /// 第一轮定向扫描的候选源码目录。
    pub source_paths: Vec<String>,
    /// `false` = 只有运行实例，源码位置未知（不伪造路径）。
    pub source_known: bool,
    /// 人读摘要：Compose 项目/服务、镜像、ExecStart、代理目标等。
    pub detail: String,
}

/// 宿主机上"像业务目录"的根。systemd 服务的 WorkingDirectory / ExecStart 只有
/// 落在这些根下才视为业务服务（否则是系统服务，不进入项目发现）。
pub(crate) const APP_ROOTS: &[&str] = &[
    "/home",
    "/srv",
    "/opt",
    "/app",
    "/apps",
    "/var/www",
    "/data",
    "/usr/local",
    "/root",
    "/workspace",
];

/// 挂载源黑名单前缀：这些路径下的 bind mount 是运行时细节，不是项目目录。
const MOUNT_SOURCE_BLOCKLIST: &[&str] = &[
    "/var/lib/docker",
    "/var/lib/containerd",
    "/var/lib/kubelet",
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/etc",
];

/// 宿主项目路径判定：必须是能通过 `validate_abs_path` 的绝对路径，
/// 且不在运行时目录黑名单下。服务器返回的任何字符串都先过这一关。
/// 仅用于**源码/工作目录**候选；配置文件见 [`is_config_path`]。
pub fn is_host_project_path(path: &str) -> bool {
    if path.is_empty() || !path.starts_with('/') {
        return false;
    }
    if MOUNT_SOURCE_BLOCKLIST
        .iter()
        .any(|root| path == *root || path.starts_with(&format!("{root}/")))
    {
        return false;
    }
    validate_abs_path(path, "实例路径").is_ok()
}

/// 配置文件路径判定：只要求是合法的绝对路径（fragment、compose 文件、
/// 环境文件都在 /etc 下很常见，不受挂载黑名单约束）。
pub fn is_config_path(path: &str) -> bool {
    !path.is_empty() && path.starts_with('/') && validate_abs_path(path, "配置路径").is_ok()
}

/// 路径是否落在"像业务目录"的根下。
pub(crate) fn is_app_path(path: &str) -> bool {
    APP_ROOTS
        .iter()
        .any(|root| path == *root || path.starts_with(&format!("{root}/")))
}

pub(crate) fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}
