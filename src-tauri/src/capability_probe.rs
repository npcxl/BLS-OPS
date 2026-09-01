//! P3 能力识别前置（第一层 / 第二层）。
//!
//! 这是整个 P3 流水线的起点：**先搞清楚"这是一台什么服务器、装了什么"，
//! 再决定启用哪些收集器**。Docker、Nginx、systemd、Caddy、Podman、Kubernetes
//! 等都只是"探测到安装后才启用"的可选能力适配器，绝不在未安装时执行其命令。
//!
//! 所有探测都走 `safe::Capability` + `remote` 的固定命令，且每个探测都用
//! `has_tool` 守卫（见 `ProbeTool`），因此未安装的组件不会产生无意义报错。

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::remote::{has_tool, run_on_linux};
use crate::safe::{Capability, ProbeTool};
use crate::ssh::SshSessionManager;

/// 服务器基础档案（第一层：操作系统与系统环境）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SystemProfile {
    /// 操作系统家族：`linux` | `windows` | `macos` | `unknown`。
    pub family: String,
    /// 发行版 + 版本，如 `Rocky Linux 9.4`；Windows 为 `Windows Server 2022`。
    pub os: String,
    /// 架构：`x86_64` | `aarch64` …。
    pub arch: String,
    /// 内核版本。
    pub kernel: String,
    /// init 系统：`systemd` | `openrc` | `runit` | `windows-service` | `unknown`。
    pub init_system: String,
    /// 当前用户。
    pub user: String,
    /// 是否拥有 sudo 能力（`None` 表示无法判定，绝不假装为 false）。
    pub sudo: Option<bool>,
    /// 包管理器：`apt` | `dnf` | `yum` | `apk` | `pacman` | `zypper` | `brew` | `winget` | `choco` | `unknown`。
    pub package_manager: String,
    /// 安全模块：`SELinux Enforcing` | `AppArmor` | `none` | `unknown`。
    pub security_module: String,
    /// cgroup 版本：`v1` | `v2` | `unknown`。
    pub cgroup_version: String,
}

/// 检测到的运行时与版本（第二层：语言运行环境）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RuntimeProfile {
    pub java: Option<String>,
    pub node: Option<String>,
    pub python: Option<String>,
    pub go: Option<String>,
    pub rust: Option<String>,
    pub php: Option<String>,
    pub dotnet: Option<String>,
    pub ruby: Option<String>,
}

/// 检测到的版本管理器。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct VersionManagerProfile {
    pub nvm: Option<String>,
    pub fnm: Option<String>,
    pub pyenv: Option<String>,
    pub uv: Option<String>,
    pub sdkman: Option<String>,
    pub rustup: Option<String>,
}

/// 检测到的构建工具（第二层：构建工具）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BuildToolProfile {
    pub maven: Option<String>,
    pub gradle: Option<String>,
    pub npm: Option<String>,
    pub pnpm: Option<String>,
    pub yarn: Option<String>,
    pub cargo: Option<String>,
    pub pip: Option<String>,
    pub poetry: Option<String>,
    pub composer: Option<String>,
}

/// 第二层：部署与服务能力。每个字段为 `Some(true/false)` 表示已探测，
/// `None` 表示无法判定（例如非 Linux 平台）。`false` 一律意味着"已探测且未安装"，
/// 因此 `false` 的组件**不会**被启用收集器。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct DeploymentCapabilities {
    // 进程与服务管理
    pub systemd: Option<bool>,
    pub openrc: Option<bool>,
    pub supervisor: Option<bool>,
    pub pm2: Option<bool>,
    pub runit: Option<bool>,
    pub windows_service: Option<bool>,
    // 容器与编排
    pub docker: Option<bool>,
    pub docker_compose: Option<bool>,
    pub podman: Option<bool>,
    pub containerd: Option<bool>,
    pub kubernetes: Option<bool>,
    pub k3s: Option<bool>,
    pub helm: Option<bool>,
    pub nomad: Option<bool>,
    // Web 与网关
    pub nginx: Option<bool>,
    pub apache: Option<bool>,
    pub caddy: Option<bool>,
    pub traefik: Option<bool>,
    pub haproxy: Option<bool>,
    pub iis: Option<bool>,
    // 数据与中间件
    pub mysql: Option<bool>,
    pub postgresql: Option<bool>,
    pub redis: Option<bool>,
    pub mongodb: Option<bool>,
    pub elasticsearch: Option<bool>,
    pub rabbitmq: Option<bool>,
    pub kafka: Option<bool>,
}

/// 完整的服务器能力图谱（第一层 + 第二层）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ServerCapabilityProfile {
    pub system: SystemProfile,
    pub runtimes: RuntimeProfile,
    pub version_managers: VersionManagerProfile,
    pub build_tools: BuildToolProfile,
    pub deployment: DeploymentCapabilities,
    /// 探测过程中收集到的告警（如无法判定某项能力）。
    pub warnings: Vec<String>,
}

impl ServerCapabilityProfile {
    /// 仅启用被探测为已安装（= `Some(true)`）的部署能力收集器。
    /// 未探测（`None`）或 `false` 的组件一律跳过。
    pub fn enabled_collectors(&self) -> Vec<String> {
        let mut out = Vec::new();
        let d = &self.deployment;
        let push = |v: &Option<bool>, name: &str, out: &mut Vec<String>| {
            if *v == Some(true) {
                out.push(name.to_string());
            }
        };
        push(&d.systemd, "systemd", &mut out);
        push(&d.openrc, "openrc", &mut out);
        push(&d.supervisor, "supervisor", &mut out);
        push(&d.pm2, "pm2", &mut out);
        push(&d.runit, "runit", &mut out);
        push(&d.windows_service, "windows-service", &mut out);
        push(&d.docker, "docker", &mut out);
        push(&d.docker_compose, "docker-compose", &mut out);
        push(&d.podman, "podman", &mut out);
        push(&d.containerd, "containerd", &mut out);
        push(&d.kubernetes, "kubernetes", &mut out);
        push(&d.k3s, "k3s", &mut out);
        push(&d.helm, "helm", &mut out);
        push(&d.nomad, "nomad", &mut out);
        push(&d.nginx, "nginx", &mut out);
        push(&d.apache, "apache", &mut out);
        push(&d.caddy, "caddy", &mut out);
        push(&d.traefik, "traefik", &mut out);
        push(&d.haproxy, "haproxy", &mut out);
        push(&d.iis, "iis", &mut out);
        push(&d.mysql, "mysql", &mut out);
        push(&d.postgresql, "postgresql", &mut out);
        push(&d.redis, "redis", &mut out);
        push(&d.mongodb, "mongodb", &mut out);
        push(&d.elasticsearch, "elasticsearch", &mut out);
        push(&d.rabbitmq, "rabbitmq", &mut out);
        push(&d.kafka, "kafka", &mut out);
        out
    }
}

/// 探测服务器能力。所有命令经 `Capability` 白名单，未安装组件用 `has_tool` 守卫，
/// 不会产生无意义报错。返回 `ServerCapabilityProfile`。
pub async fn probe_capabilities(
    session_id: &str,
    mgr: &SshSessionManager,
) -> Result<ServerCapabilityProfile> {
    let mut profile = ServerCapabilityProfile::default();
    let mut warnings = Vec::new();

    // ---- 第一层：系统档案 ----
    match run_on_linux(mgr, session_id, &Capability::CapabilitySystemInfo).await {
        Ok(out) => parse_system_info(&out, &mut profile.system, &mut warnings),
        Err(e) => warnings.push(format!("系统信息探测失败：{e}")),
    }

    // ---- 第二层：包管理器（由 which 探测）----
    profile.system.package_manager = detect_package_manager(session_id, mgr).await;

    // ---- 第二层：运行时与版本 ----
    profile.runtimes.java = detect_version(session_id, mgr, ProbeTool::Java).await;
    profile.runtimes.node = detect_version(session_id, mgr, ProbeTool::Node).await;
    profile.runtimes.python = detect_version(session_id, mgr, ProbeTool::Python).await;
    profile.runtimes.go = detect_version(session_id, mgr, ProbeTool::Go).await;
    profile.runtimes.rust = detect_version(session_id, mgr, ProbeTool::Rustc).await;
    profile.runtimes.php = detect_version(session_id, mgr, ProbeTool::Php).await;
    profile.runtimes.dotnet = detect_version(session_id, mgr, ProbeTool::Dotnet).await;
    profile.runtimes.ruby = detect_version(session_id, mgr, ProbeTool::Ruby).await;

    // ---- 第二层：版本管理器 ----
    profile.version_managers.nvm = detect_tool(session_id, mgr, ProbeTool::Nvm).await;
    profile.version_managers.fnm = detect_tool(session_id, mgr, ProbeTool::Fnm).await;
    profile.version_managers.pyenv = detect_tool(session_id, mgr, ProbeTool::Pyenv).await;
    profile.version_managers.uv = detect_tool(session_id, mgr, ProbeTool::Uv).await;
    profile.version_managers.sdkman = detect_tool(session_id, mgr, ProbeTool::Sdkman).await;
    profile.version_managers.rustup = detect_tool(session_id, mgr, ProbeTool::Rustup).await;

    // ---- 第二层：构建工具 ----
    profile.build_tools.maven = detect_version(session_id, mgr, ProbeTool::Maven).await;
    profile.build_tools.gradle = detect_version(session_id, mgr, ProbeTool::Gradle).await;
    profile.build_tools.npm = detect_version(session_id, mgr, ProbeTool::Npm).await;
    profile.build_tools.pnpm = detect_version(session_id, mgr, ProbeTool::Pnpm).await;
    profile.build_tools.yarn = detect_version(session_id, mgr, ProbeTool::Yarn).await;
    profile.build_tools.cargo = detect_version(session_id, mgr, ProbeTool::Cargo).await;
    profile.build_tools.pip = detect_tool(session_id, mgr, ProbeTool::Pip).await;
    profile.build_tools.poetry = detect_tool(session_id, mgr, ProbeTool::Poetry).await;
    profile.build_tools.composer = detect_tool(session_id, mgr, ProbeTool::Composer).await;

    // ---- 第三层：部署与服务能力（仅探测，标记 Some(true/false)）----
    let d = &mut profile.deployment;
    d.systemd = capability_flag(session_id, mgr, ProbeTool::Systemctl).await;
    d.openrc = capability_flag(session_id, mgr, ProbeTool::Openrc).await;
    d.supervisor = capability_flag(session_id, mgr, ProbeTool::Supervisor).await;
    d.pm2 = capability_flag(session_id, mgr, ProbeTool::Pm2).await;
    d.runit = capability_flag(session_id, mgr, ProbeTool::Runit).await;
    d.windows_service = capability_flag(session_id, mgr, ProbeTool::Sc).await;
    d.docker = capability_flag(session_id, mgr, ProbeTool::Docker).await;
    d.docker_compose = capability_flag(session_id, mgr, ProbeTool::DockerCompose).await;
    d.podman = capability_flag(session_id, mgr, ProbeTool::Podman).await;
    d.containerd = capability_flag(session_id, mgr, ProbeTool::Containerd).await;
    d.kubernetes = capability_flag(session_id, mgr, ProbeTool::Kubectl).await;
    d.k3s = capability_flag(session_id, mgr, ProbeTool::K3s).await;
    d.helm = capability_flag(session_id, mgr, ProbeTool::Helm).await;
    d.nomad = capability_flag(session_id, mgr, ProbeTool::Nomad).await;
    d.nginx = capability_flag(session_id, mgr, ProbeTool::Nginx).await;
    d.apache = capability_flag(session_id, mgr, ProbeTool::Apache).await;
    d.caddy = capability_flag(session_id, mgr, ProbeTool::Caddy).await;
    d.traefik = capability_flag(session_id, mgr, ProbeTool::Traefik).await;
    d.haproxy = capability_flag(session_id, mgr, ProbeTool::Haproxy).await;
    d.iis = capability_flag(session_id, mgr, ProbeTool::Iis).await;
    d.mysql = capability_flag(session_id, mgr, ProbeTool::Mysql).await;
    d.postgresql = capability_flag(session_id, mgr, ProbeTool::Psql).await;
    d.redis = capability_flag(session_id, mgr, ProbeTool::Redis).await;
    d.mongodb = capability_flag(session_id, mgr, ProbeTool::Mongo).await;
    d.elasticsearch = capability_flag(session_id, mgr, ProbeTool::Elasticsearch).await;
    d.rabbitmq = capability_flag(session_id, mgr, ProbeTool::Rabbitmq).await;
    d.kafka = capability_flag(session_id, mgr, ProbeTool::Kafka).await;

    profile.warnings = warnings;
    Ok(profile)
}

/// 返回 `Some(true)`（已安装）/ `Some(false)`（已探测但未安装）。
/// 探测失败（连接/非 Linux）保守记为 `Some(false)`，不假装为"已安装"。
async fn capability_flag(
    session_id: &str,
    mgr: &SshSessionManager,
    tool: ProbeTool,
) -> Option<bool> {
    Some(has_tool(mgr, session_id, tool).await)
}

/// 返回工具版本（`Some("17.0.12")`）或 `None`（未安装/无法判定）。
async fn detect_version(
    session_id: &str,
    mgr: &SshSessionManager,
    tool: ProbeTool,
) -> Option<String> {
    // 先确认工具存在，避免对不存在的工具执行 `--version` 产生噪音。
    if !has_tool(mgr, session_id, tool).await {
        return None;
    }
    match run_on_linux(mgr, session_id, &Capability::ToolVersion(tool)).await {
        Ok(out) => Some(strip_version(&out)),
        Err(_) => None,
    }
}

/// 只判断工具是否存在，不取版本（`Some` 表示存在）。
async fn detect_tool(session_id: &str, mgr: &SshSessionManager, tool: ProbeTool) -> Option<String> {
    if has_tool(mgr, session_id, tool).await {
        Some("installed".to_string())
    } else {
        None
    }
}

async fn detect_package_manager(session_id: &str, mgr: &SshSessionManager) -> String {
    for (tool, name) in [
        (ProbeTool::Apt, "apt"),
        (ProbeTool::Dnf, "dnf"),
        (ProbeTool::Yum, "yum"),
        (ProbeTool::Apk, "apk"),
        (ProbeTool::Pacman, "pacman"),
        (ProbeTool::Zypper, "zypper"),
        (ProbeTool::Brew, "brew"),
        (ProbeTool::Winget, "winget"),
        (ProbeTool::Choco, "choco"),
    ] {
        if has_tool(mgr, session_id, tool).await {
            return name.to_string();
        }
    }
    "unknown".to_string()
}

/// 解析 `CapabilitySystemInfo` 的固定输出，填充系统档案。
fn parse_system_info(stdout: &str, sys: &mut SystemProfile, warnings: &mut Vec<String>) {
    // 默认家族按 os 字符串判断。
    sys.family = "unknown".to_string();
    sys.init_system = "unknown".to_string();
    sys.security_module = "unknown".to_string();
    sys.cgroup_version = "unknown".to_string();

    for line in stdout.lines() {
        let line = line.trim();
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            let v = v.trim().trim_matches('"');
            match k {
                "OS" => {
                    sys.os = v.to_string();
                    let low = v.to_lowercase();
                    if low.contains("linux") {
                        sys.family = "linux".to_string();
                    } else if low.contains("windows") {
                        sys.family = "windows".to_string();
                    } else if low.contains("darwin") || low.contains("macos") {
                        sys.family = "macos".to_string();
                    }
                }
                "ARCH" => sys.arch = v.to_string(),
                "KERNEL" => sys.kernel = v.to_string(),
                "USER" => sys.user = v.to_string(),
                "INIT" => sys.init_system = v.to_string(),
                "PKG" => {
                    if sys.package_manager == "unknown" {
                        sys.package_manager = v.to_string();
                    }
                }
                "SECURITY" => sys.security_module = v.to_string(),
                "CGROUP" => sys.cgroup_version = v.to_string(),
                "SUDO" => sys.sudo = Some(v == "true" || v == "yes"),
                _ => {}
            }
        }
    }
    if sys.os.is_empty() {
        warnings.push("无法判定操作系统".to_string());
    }
    if sys.user.is_empty() {
        warnings.push("无法判定当前用户".to_string());
    }
}

/// 从 `--version` 风格输出中提取第一个看起来像版本的 token。
fn strip_version(stdout: &str) -> String {
    for token in stdout.split_whitespace() {
        let t = token.trim_matches(',');
        if t.chars().any(|c| c.is_ascii_digit())
            && (t.contains('.')
                || t.chars()
                    .next()
                    .map(|c| c.is_ascii_digit())
                    .unwrap_or(false))
        {
            return t.to_string();
        }
    }
    "unknown".to_string()
}
