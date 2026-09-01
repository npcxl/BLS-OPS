//! P3 第四层：部署适配器注册系统。
//!
//! 部署方式**不写死成无限列表**，而是以 `DeploymentAdapter` trait 注册。
//! 后续新增部署方式时只新增一个适配器变体 + 实现，不改动项目发现核心。
//!
//! 重要原则（来自修订方案）：
//! - 对于服务器实际未安装的能力（见 `capability_probe`），对应适配器**不会**被启用。
//! - 无法识别的运行服务，显示「检测到未知运行服务，暂无匹配适配器，可看证据或手动指定」，
//!   **绝不为了声称"全部支持"而猜测**。

use serde::{Deserialize, Serialize};

use crate::capability_probe::ServerCapabilityProfile;

/// 部署适配器标识。新增部署方式时在此加变体即可。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeploymentAdapterId {
    StaticFiles,
    NativeBinary,
    JavaJar,
    NodeProcess,
    PythonVenv,
    Systemd,
    Pm2,
    Supervisor,
    Docker,
    DockerCompose,
    Podman,
    Nginx,
    Apache,
    Caddy,
    KubernetesHelm,
}

impl DeploymentAdapterId {
    pub fn display_name(&self) -> &'static str {
        match self {
            DeploymentAdapterId::StaticFiles => "静态文件部署",
            DeploymentAdapterId::NativeBinary => "原生二进制部署",
            DeploymentAdapterId::JavaJar => "Java JAR/WAR",
            DeploymentAdapterId::NodeProcess => "Node.js 进程",
            DeploymentAdapterId::PythonVenv => "Python 虚拟环境",
            DeploymentAdapterId::Systemd => "systemd",
            DeploymentAdapterId::Pm2 => "PM2",
            DeploymentAdapterId::Supervisor => "Supervisor",
            DeploymentAdapterId::Docker => "Docker",
            DeploymentAdapterId::DockerCompose => "Docker Compose",
            DeploymentAdapterId::Podman => "Podman",
            DeploymentAdapterId::Nginx => "Nginx",
            DeploymentAdapterId::Apache => "Apache",
            DeploymentAdapterId::Caddy => "Caddy",
            DeploymentAdapterId::KubernetesHelm => "Kubernetes / Helm",
        }
    }

    /// 该适配器依赖的服务器能力字段名（对应 `DeploymentCapabilities`）。
    /// 仅当该能力为 `Some(true)` 时，适配器才被启用。
    /// `None` 表示不依赖特定能力（如「静态文件」「原生二进制」始终可用）。
    pub fn required_capability(&self) -> Option<&'static str> {
        match self {
            DeploymentAdapterId::StaticFiles | DeploymentAdapterId::NativeBinary => None,
            DeploymentAdapterId::JavaJar => None, // 由运行时 java 判定，见 is_applicable
            DeploymentAdapterId::NodeProcess => None,
            DeploymentAdapterId::PythonVenv => None,
            DeploymentAdapterId::Systemd => Some("systemd"),
            DeploymentAdapterId::Pm2 => Some("pm2"),
            DeploymentAdapterId::Supervisor => Some("supervisor"),
            DeploymentAdapterId::Docker => Some("docker"),
            DeploymentAdapterId::DockerCompose => Some("docker_compose"),
            DeploymentAdapterId::Podman => Some("podman"),
            DeploymentAdapterId::Nginx => Some("nginx"),
            DeploymentAdapterId::Apache => Some("apache"),
            DeploymentAdapterId::Caddy => Some("caddy"),
            DeploymentAdapterId::KubernetesHelm => Some("kubernetes"),
        }
    }
}

/// 部署准备度结论（P3.8）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessVerdict {
    /// 服务器已具备直接部署条件。
    Ready,
    /// 需要先在服务器安装依赖（如 docker 未装但需要 docker）。
    NeedsInstall,
    /// 与现有环境冲突。
    Conflict,
    /// 无法确认（信息不足，绝不猜测为支持）。
    Unconfirmed,
}

/// 单个部署适配器的就绪评估。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdapterReadiness {
    pub adapter: DeploymentAdapterId,
    pub verdict: ReadinessVerdict,
    pub note: String,
}

/// 部署适配器：项目发现核心通过它了解"这个服务器能用哪些方式部署"。
///
/// 当前阶段只实现 `id` / `display_name` / `required_capability`，`detect` /
/// `collect_evidence` / `assess_readiness` 的实际逻辑在 P4 中落地；P3 仅做
/// **能力可用性判定**（基于已探测的 `ServerCapabilityProfile`），不执行任何
/// 猜测性命令。
pub struct DeploymentAdapter {
    pub id: DeploymentAdapterId,
}

impl DeploymentAdapter {
    /// 注册表：首批 15 个适配器。新增方式只在此处追加。
    pub fn all() -> &'static [DeploymentAdapterId] {
        &[
            DeploymentAdapterId::StaticFiles,
            DeploymentAdapterId::NativeBinary,
            DeploymentAdapterId::JavaJar,
            DeploymentAdapterId::NodeProcess,
            DeploymentAdapterId::PythonVenv,
            DeploymentAdapterId::Systemd,
            DeploymentAdapterId::Pm2,
            DeploymentAdapterId::Supervisor,
            DeploymentAdapterId::Docker,
            DeploymentAdapterId::DockerCompose,
            DeploymentAdapterId::Podman,
            DeploymentAdapterId::Nginx,
            DeploymentAdapterId::Apache,
            DeploymentAdapterId::Caddy,
            DeploymentAdapterId::KubernetesHelm,
        ]
    }

    /// 该适配器在当前服务器能力下是否被启用（能力已安装）。
    /// 返回 `false` 表示即使项目需要，服务器也不具备该方式，P4 不应推荐。
    pub fn is_applicable(&self, profile: &ServerCapabilityProfile) -> bool {
        // 运行时类适配器由运行时版本判定（不依赖 deployment capability 字段）。
        match self.id {
            DeploymentAdapterId::JavaJar => return profile.runtimes.java.is_some(),
            DeploymentAdapterId::NodeProcess => return profile.runtimes.node.is_some(),
            DeploymentAdapterId::PythonVenv => return profile.runtimes.python.is_some(),
            _ => {}
        }
        match self.id.required_capability() {
            None => true, // 静态文件 / 原生二进制始终可用
            Some(cap) => capability_enabled(profile, cap),
        }
    }

    /// 评估该适配器对"给定项目需求"的准备度。
    /// `project_requires` 表示项目是否声明需要此方式（来自证据）。
    pub fn assess_readiness(
        &self,
        profile: &ServerCapabilityProfile,
        project_requires: bool,
    ) -> AdapterReadiness {
        let applicable = self.is_applicable(profile);
        let verdict = if !project_requires {
            ReadinessVerdict::Unconfirmed
        } else if applicable {
            ReadinessVerdict::Ready
        } else {
            ReadinessVerdict::NeedsInstall
        };
        let note = match verdict {
            ReadinessVerdict::Ready => format!("服务器已安装 {}", self.id.display_name()),
            ReadinessVerdict::NeedsInstall => {
                format!("项目需要 {}，但服务器未安装", self.id.display_name())
            }
            ReadinessVerdict::Conflict => "与现有环境存在冲突".to_string(),
            ReadinessVerdict::Unconfirmed => "未确认是否需要此部署方式".to_string(),
        };
        AdapterReadiness {
            adapter: self.id,
            verdict,
            note,
        }
    }
}

fn capability_enabled(profile: &ServerCapabilityProfile, cap: &str) -> bool {
    let d = &profile.deployment;
    let v = match cap {
        "systemd" => &d.systemd,
        "openrc" => &d.openrc,
        "supervisor" => &d.supervisor,
        "pm2" => &d.pm2,
        "runit" => &d.runit,
        "windows_service" => &d.windows_service,
        "docker" => &d.docker,
        "docker_compose" => &d.docker_compose,
        "podman" => &d.podman,
        "containerd" => &d.containerd,
        "kubernetes" => &d.kubernetes,
        "k3s" => &d.k3s,
        "helm" => &d.helm,
        "nomad" => &d.nomad,
        "nginx" => &d.nginx,
        "apache" => &d.apache,
        "caddy" => &d.caddy,
        "traefik" => &d.traefik,
        "haproxy" => &d.haproxy,
        "iis" => &d.iis,
        "mysql" => &d.mysql,
        "postgresql" => &d.postgresql,
        "redis" => &d.redis,
        "mongodb" => &d.mongodb,
        "elasticsearch" => &d.elasticsearch,
        "rabbitmq" => &d.rabbitmq,
        "kafka" => &d.kafka,
        _ => return false,
    };
    *v == Some(true)
}
