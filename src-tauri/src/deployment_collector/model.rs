//! Shared model and path rules for every deployment collector.

use serde::{Deserialize, Serialize};

use crate::safe::validate_abs_path;
use crate::service_catalog::{
    ClassificationConfidence, ClassificationEvidence, ComponentRole, DetectedService,
    DetectedTechnology, InfrastructureCategory, InstanceOwnership, InstanceRuntime, WorkloadRole,
};

/// 一个真实存在的部署实例（容器 / systemd 服务 / Nginx 网关 / k8s 工作负载）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct DeploymentInstance {
    /// 稳定 ID：`docker:<容器ID>` / `systemd:<单元名>` / `nginx:gateway` /
    /// `k8s:<命名空间>/<Pod>/<容器>`。
    pub id: String,
    /// 部署方式：`docker` | `systemd` | `nginx` | `k8s`。
    pub kind: String,
    /// 展示名：容器名 / 单元名 / 网关名 / Pod 名。
    pub name: String,
    /// 运行状态（原样来自服务器）。
    pub status: String,
    /// **实例跑在哪里** —— 宿主机进程、Docker 容器还是 Kubernetes 里的 Pod。
    /// 一台机器上三者可以并存（`docker ps` 会同时看到普通容器和 k8s 的 Pod 容器），
    /// 只有这个字段能说清楚归属。
    pub runtime: InstanceRuntime,
    /// 容器镜像（仅容器 / k8s 实例有；宿主机进程为 `None`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// 识别出的服务（MySQL / Redis / Nginx / …）。**识别不出就是 `None`** ——
    /// 绝不把认不出来的东西猜成某个具体服务。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<DetectedService>,
    /// 是否为**操作系统自带**（sshd / cron / containerd / kubelet …）。
    /// 这类实例不是用户部署的东西，不参与项目发现。
    #[serde(default)]
    pub system_owned: bool,
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
    // ---- 分类字段（2026-09 修订；全部 serde default，旧 project_inventory 快照兼容）----
    /// 顶层互斥分类：应用服务 / 基础设施 / 系统组件 / 待归类。
    /// React 只展示，不参与判断。
    #[serde(default)]
    pub workload_role: WorkloadRole,
    /// 基础设施类别（仅 `workload_role=infrastructure` 时有值）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub infrastructure_category: Option<InfrastructureCategory>,
    /// 组件角色（frontend / backend / database / …）。
    #[serde(default)]
    pub component_role: ComponentRole,
    /// 识别出的具体技术产品（`mysql` / `node` / `ollama`…，字符串 ID）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub technology: Option<DetectedTechnology>,
    /// 共享基础设施 / 项目专属 / 未知。
    #[serde(default)]
    pub ownership: InstanceOwnership,
    /// 关联的项目路径（评分期双向回填）。
    #[serde(default)]
    pub linked_project_ids: Vec<String>,
    /// 分类依据（每条结论都能说出理由）。
    #[serde(default)]
    pub classification_evidence: Vec<ClassificationEvidence>,
    /// 分类的置信度。
    #[serde(default)]
    pub classification_confidence: ClassificationConfidence,
}

impl DeploymentInstance {
    /// 快速判断：这个实例是不是"用户部署的业务应用"（而不是数据库 / 缓存 /
    /// 监控 / 操作系统组件）。
    ///
    /// **只用 `workload_role` 判断**；`service.group` 只是 UI 配色。
    pub fn is_business_workload(&self) -> bool {
        !self.system_owned && matches!(self.workload_role, WorkloadRole::Application)
    }
}

/// Nginx 的一个站点路由（server block）。
///
/// **网关实例与路由分离**：Nginx daemon/容器是一个运行实例（顶层只出现一次，
/// 归基础设施"网关与代理"组）；每个 server block 是一条 [`GatewayRoute`]，
/// 在项目详情里作为"访问入口"展示 —— 绝不允许每个域名都变成一个
/// "基础设施服务"实例。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct GatewayRoute {
    /// 稳定 ID：`route:<server_name>`。
    pub id: String,
    /// 所属网关实例的 ID（`nginx:gateway`）。
    pub gateway_instance_id: String,
    /// server_name（域名）列表。
    #[serde(default)]
    pub server_names: Vec<String>,
    /// listen 端口。
    #[serde(default)]
    pub listen_ports: Vec<u16>,
    /// 静态站点 root（可关联前端项目）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// proxy_pass 目标（原样保留 URL）。
    #[serde(default)]
    pub proxy_targets: Vec<String>,
    /// 配置文件（宿主机路径）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_file: Option<String>,
    /// 评分期回填：这条路由属于哪个项目（路径）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_project_id: Option<String>,
    /// 定向扫描与项目关联用的宿主路径（静态 root + 代理后端 cwd）。
    #[serde(default)]
    pub linked_paths: Vec<String>,
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
