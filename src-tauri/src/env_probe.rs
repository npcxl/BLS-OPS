//! 服务器运行环境探测 —— **按真实环境生成命令建议**，而不是猜。
//!
//! 分两层，与项目其它模块一致：
//!
//! * **纯逻辑**（本文件上半部分，零 I/O、可单测）：镜像引用拆分、Nginx
//!   容器识别、环境分类、命令生成；
//! * **采集**（下半部分）：走 `safe::Capability` 白名单 + `remote` 固定命令，
//!   只读，绝不修改服务器。
//!
//! # 为什么不能 `contains("nginx")`
//!
//! 镜像名有仓库前缀与标签：`registry.internal:5000/team/nginx:1.25-alpine`、
//! `library/nginx`、`bitnami/nginx-ingress-controller`。直接对整个字符串
//! 做子串匹配会把 `my-nginx-logger`（一个日志采集器）也当成 Nginx。
//! 所以这里拆成 registry / repository / tag 三段，**只对 repository 的最后
//! 一段**做等值比较，再与容器名 token、Compose service label、容器内
//! 可执行文件三项证据加权合并。
//!
//! 全部判定都是"证据 → 结论"，没有任何针对固定服务器或固定容器名的规则。

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::remote::{has_tool, run_capability};
use crate::safe::{Capability, ProbeTool};
use crate::ssh::SshSessionManager;

// -- 镜像引用 ---------------------------------------------------------------

/// 拆分后的镜像引用。
///
/// `registry.internal:5000/team/nginx:1.25-alpine`
/// → registry `registry.internal:5000`、repository `team/nginx`、tag
/// `1.25-alpine`、base（最后一段）`nginx`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImageRef {
    /// 带端口或点号的第一个分段才是仓库地址，`docker.io` 与 `library` 是
    /// Docker Hub 的默认值，归一化时去掉。
    pub registry: Option<String>,
    pub repository: String,
    pub tag: Option<String>,
    /// `true` 表示引用按 digest 给出（`nginx@sha256:…`），此时没有 tag。
    pub by_digest: bool,
}

impl ImageRef {
    /// repository 的最后一段：`team/nginx` → `nginx`。
    pub fn base(&self) -> &str {
        self.repository
            .rsplit('/')
            .next()
            .unwrap_or(&self.repository)
    }
}

/// 解析镜像引用。无法解析时返回 `None`（调用方按"未知镜像"处理，绝不猜测）。
pub fn parse_image_ref(image: &str) -> Option<ImageRef> {
    let image = image.trim();
    if image.is_empty() {
        return None;
    }
    // `nginx@sha256:abc…` —— digest 形式没有 tag。
    let (without_digest, by_digest) = match image.split_once('@') {
        Some((name, _digest)) => (name, true),
        None => (image, false),
    };
    // 只有 registry 段里可能出现 `:`，tag 一定在最后一个 `/` 之后。
    let (path, tag) = match without_digest.rsplit_once('/') {
        Some((head, tail)) => match tail.split_once(':') {
            Some((name, tag)) => (format!("{head}/{name}"), Some(tag.to_string())),
            None => (without_digest.to_string(), None),
        },
        None => match without_digest.split_once(':') {
            Some((name, tag)) => (name.to_string(), Some(tag.to_string())),
            None => (without_digest.to_string(), None),
        },
    };

    let segments: Vec<&str> = path.split('/').collect();
    // registry 的判据：有 `/` 且第一段含 `.` 或 `:` 或就是 `localhost`。
    let (registry, repository) = if segments.len() > 1
        && (segments[0].contains('.') || segments[0].contains(':') || segments[0] == "localhost")
    {
        (Some(segments[0].to_string()), segments[1..].join("/"))
    } else {
        (None, path.clone())
    };
    // Docker Hub 的默认值省掉：`library/nginx` → `nginx`。
    let repository = match repository.strip_prefix("library/") {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => repository,
    };
    if repository.is_empty() {
        return None;
    }
    Some(ImageRef {
        registry,
        repository,
        tag,
        by_digest,
    })
}

/// 镜像家族。只有真正会被当成 Nginx 来运维的两类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NginxFlavor {
    Nginx,
    OpenResty,
}

impl NginxFlavor {
    pub fn label(self) -> &'static str {
        match self {
            NginxFlavor::Nginx => "Nginx",
            NginxFlavor::OpenResty => "OpenResty",
        }
    }

    /// 容器里 nginx 可执行文件的位置（OpenResty 自带同名可执行文件）。
    pub fn binary(self) -> &'static str {
        match self {
            NginxFlavor::Nginx => "nginx",
            NginxFlavor::OpenResty => "nginx",
        }
    }
}

/// 由镜像引用判定家族。**只对 repository 最后一段**做等值比较。
///
/// `nginx` / `nginx-alpine` 不算 —— 那是另一个镜像；但
/// `bitnami/nginx-ingress-controller` 的 base 是
/// `nginx-ingress-controller`，也不等于 `nginx`，因此同样不算：它是
/// ingress 控制器，不该用 `nginx -t` 去运维。宁可漏，不可错。
pub fn flavor_of_image(image: &ImageRef) -> Option<NginxFlavor> {
    let base = image.base().to_ascii_lowercase();
    match base.as_str() {
        "nginx" => Some(NginxFlavor::Nginx),
        "openresty" => Some(NginxFlavor::OpenResty),
        _ => None,
    }
}

// -- 容器证据 ---------------------------------------------------------------

/// 一个容器上收集到的 Nginx 证据。
#[derive(Debug, Clone, Default)]
pub struct NginxEvidence {
    /// 镜像家族（repository 最后一段等值匹配）。最强的一条证据。
    pub image_flavor: Option<NginxFlavor>,
    /// Compose service 名等于 `nginx`（大小写不敏感）。
    pub compose_service_match: bool,
    /// 容器名里出现完整 token `nginx`（按 `-_.` 切分后比较，避免
    /// `nginxsidecar` 之类的误判）。
    pub name_token_match: bool,
    /// 容器内确实存在 nginx 可执行文件（`docker exec` 探测结果）。
    pub has_binary: Option<bool>,
}

/// 把容器名切成 token：`bls-nginx` → [bls, nginx]，`app_nginx_1` →
/// [app, nginx, 1]。数字后缀是 Compose 的副本序号，不参与匹配。
pub fn name_tokens(name: &str) -> Vec<String> {
    name.split(|c: char| c == '-' || c == '_' || c == '.')
        .filter(|token| !token.is_empty() && !token.chars().all(|c| c.is_ascii_digit()))
        .map(|token| token.to_ascii_lowercase())
        .collect()
}

/// 证据合并：**任一条强证据即可认定**（镜像 base 命中 / 容器内有 nginx
/// 可执行文件）；弱证据（容器名 token、Compose service）需要两条同时成立。
///
/// 单靠容器名包含 nginx 就下结论会把 `nginx-exporter` 之类算进来，因此弱
/// 证据不单独定罪。
pub fn is_nginx(evidence: &NginxEvidence) -> bool {
    if evidence.image_flavor.is_some() {
        return true;
    }
    if evidence.has_binary == Some(true) {
        return true;
    }
    evidence.compose_service_match && evidence.name_token_match
}

// -- 容器视图 ---------------------------------------------------------------

/// 端口映射：`80/tcp -> 0.0.0.0:8080` 中的宿主机端口 `8080`。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PortBinding {
    /// 容器内部端口（`docker ps` 的 `80/tcp`）。
    pub container_port: u16,
    /// 宿主机端口；`None` 表示未发布到宿主机。
    pub host_port: Option<u16>,
    pub protocol: String,
}

/// 配置挂载：宿主机路径 → 容器内路径。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MountInfo {
    pub source: String,
    pub destination: String,
    pub read_only: bool,
}

impl MountInfo {
    /// 挂载到容器内的 Nginx 配置目录（`/etc/nginx` 及其子路径）。
    pub fn is_nginx_config(&self) -> bool {
        self.destination == "/etc/nginx"
            || self.destination.starts_with("/etc/nginx/")
            || self.destination == "/usr/local/nginx/conf"
            || self.destination.starts_with("/usr/local/nginx/conf/")
    }
}

/// Compose 归属。只有 project 与 service **同时**可靠时才建议 compose 命令。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposeRef {
    pub project: String,
    pub service: String,
    /// Compose 文件所在目录（label `com.docker.compose.project.working_dir`）。
    /// 为空时不能用裸 `docker compose` —— 那依赖当前目录。
    pub working_dir: String,
}

/// 一个被识别为 Nginx 的容器，及生成命令所需的全部事实。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxContainer {
    pub name: String,
    pub short_id: String,
    pub image: String,
    /// 解析后的镜像引用（前端展示用）。
    pub image_repository: String,
    pub image_tag: String,
    pub flavor: Option<NginxFlavor>,
    pub state: String,
    pub status: String,
    pub running: bool,
    pub ports: Vec<PortBinding>,
    pub mounts: Vec<MountInfo>,
    pub compose: Option<ComposeRef>,
    /// 容器内是否真的有 nginx 可执行文件；`None` = 没探测（容器没在跑、
    /// 或探测失败），**绝不当成 true**。
    pub has_binary: Option<bool>,
    /// 判定依据（给人看的解释，不参与逻辑）。
    pub reasons: Vec<String>,
}

impl NginxContainer {
    /// 容器内配置目录挂载（宿主机路径 → 容器路径）。
    pub fn config_mounts(&self) -> Vec<&MountInfo> {
        self.mounts
            .iter()
            .filter(|mount| mount.is_nginx_config())
            .collect()
    }

    /// 对外发布的端口（去重、升序），用于展示"端口：80、443"。
    pub fn published_ports(&self) -> Vec<u16> {
        let mut ports: Vec<u16> = self
            .ports
            .iter()
            .filter_map(|port| port.host_port)
            .collect();
        ports.sort_unstable();
        ports.dedup();
        ports
    }
}

// -- 环境分类 ---------------------------------------------------------------

/// Nginx 环境类别。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NginxKind {
    /// 未检测到 Nginx —— 也是"还没探测"的诚实默认值。
    #[default]
    None,
    /// 只装在宿主机上（无容器）。
    Host,
    /// Docker 容器（非 Compose，或 Compose 信息不可靠）。
    Docker,
    /// Compose 管理的容器：project + service + 工作目录都确认过。
    Compose,
    /// 多个 Nginx 容器：必须先让用户选，绝不替他挑第一个。
    Multiple,
}

impl NginxKind {
    pub fn label(self) -> &'static str {
        match self {
            NginxKind::Host => "宿主机 Nginx",
            NginxKind::Docker => "Docker Nginx",
            NginxKind::Compose => "Docker Compose Nginx",
            NginxKind::Multiple => "多个 Nginx 容器",
            NginxKind::None => "未检测到 Nginx",
        }
    }

    /// 是否为"未检测到"（含"还没探测"）。
    pub fn is_none(self) -> bool {
        matches!(self, NginxKind::None)
    }
}

/// 一次探测的完整结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxEnvironment {
    pub kind: NginxKind,
    pub containers: Vec<NginxContainer>,
    /// 宿主机是否装了 nginx 可执行文件（`None` = 无法判定）。
    pub host_installed: Option<bool>,
    /// Docker 是否可用。
    pub docker_available: bool,
    /// Docker 不可用/无权限的**具体原因**（要显示给用户，绝不静默）。
    pub docker_reason: Option<String>,
    /// 探测过程中降级的原因（如某个容器没能 exec 探测）。
    pub warnings: Vec<String>,
}

impl NginxEnvironment {
    /// 已选中的容器（`Multiple` 时为空，必须先让用户选）。
    pub fn single(&self) -> Option<&NginxContainer> {
        if self.containers.len() == 1 {
            self.containers.first()
        } else {
            None
        }
    }

    /// 按名字找容器。用于校验"记住的选择"是否仍然存在且仍在运行。
    pub fn find(&self, name: &str) -> Option<&NginxContainer> {
        self.containers.iter().find(|item| item.name == name)
    }
}

/// 分类：**证据 → 结论**。容器数为 0 时看宿主机，1 个看归属，多个一律
/// `Multiple`（由前端弹选择器）。
pub fn classify(containers: Vec<NginxContainer>, host_installed: Option<bool>) -> NginxKind {
    match containers.len() {
        0 => match host_installed {
            Some(true) => NginxKind::Host,
            _ => NginxKind::None,
        },
        1 => match containers[0].compose {
            // 只有 project + service + 工作目录都可靠，才叫 Compose 环境。
            Some(ref compose)
                if !compose.project.is_empty()
                    && !compose.service.is_empty()
                    && !compose.working_dir.is_empty() =>
            {
                NginxKind::Compose
            }
            _ => NginxKind::Docker,
        },
        _ => NginxKind::Multiple,
    }
}

// -- 命令生成 ---------------------------------------------------------------

/// 与知识库一致的风险等级（snake_case，前端联合类型逐字对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestedRisk {
    ReadOnly,
    Low,
    Medium,
    High,
}

impl SuggestedRisk {
    pub fn label(self) -> &'static str {
        match self {
            SuggestedRisk::ReadOnly => "只读",
            SuggestedRisk::Low => "低风险",
            SuggestedRisk::Medium => "需确认",
            SuggestedRisk::High => "危险",
        }
    }
}

/// 建议动作：唯一标识 + 命令 + 真实风险。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedCommand {
    pub id: String,
    pub title: String,
    pub command: String,
    pub risk: SuggestedRisk,
    /// 补充说明（如"需先选择容器"）。
    pub note: Option<String>,
    /// 该命令依赖容器名；`Multiple` 环境下必须先选定容器。
    pub needs_container: bool,
}

/// 生成某个容器的运维命令。
///
/// Compose 环境优先给 `docker compose`（带 `-p` 指定项目，**不依赖当前
/// 工作目录**），并保留"进入项目目录后用裸 compose"的说明；工作目录不可
/// 靠时一律退回 `docker exec`（可执行性优先于形式）。
///
/// 风险等级保持真实：`-v` / `-t` / `-T` / 日志 / inspect / port 只读；
/// `reload` / `restart` 修改运行状态 → medium（执行前必须确认）；
/// 删除类**不生成**（危险操作不允许自动建议）。
pub fn container_commands(container: &NginxContainer, compose: bool) -> Vec<SuggestedCommand> {
    let name = shell_quote(&container.name);
    let mut out: Vec<SuggestedCommand> = Vec::new();

    if compose {
        if let Some(compose_ref) = &container.compose {
            let project = &compose_ref.project;
            let service = &compose_ref.service;
            let cd = format!(
                "cd {} && docker compose",
                shell_quote(&compose_ref.working_dir)
            );
            let mut push = |id: &str,
                            title: &str,
                            command: String,
                            risk: SuggestedRisk,
                            note: Option<String>| {
                out.push(SuggestedCommand {
                    id: id.to_string(),
                    title: title.to_string(),
                    command,
                    risk,
                    note,
                    needs_container: false,
                });
            };
            push(
                "compose.ps",
                "查看 Compose 服务状态",
                format!("docker compose -p {project} ps {service}"),
                SuggestedRisk::ReadOnly,
                Some(format!("等价写法：{cd} ps {service}")),
            );
            push(
                "compose.logs",
                "查看最近 200 行日志",
                format!("docker compose -p {project} logs --tail 200 {service}"),
                SuggestedRisk::ReadOnly,
                Some(format!("等价写法：{cd} logs --tail 200 {service}")),
            );
            push(
                "compose.test",
                "校验配置（nginx -t）",
                format!("docker compose -p {project} exec {service} nginx -t"),
                SuggestedRisk::ReadOnly,
                None,
            );
            push(
                "compose.reload",
                "平滑重载配置",
                format!("docker compose -p {project} exec {service} nginx -s reload"),
                SuggestedRisk::Medium,
                Some("会改变运行中的服务状态，执行前请确认".to_string()),
            );
            push(
                "compose.restart",
                "重启服务",
                format!("docker compose -p {project} restart {service}"),
                SuggestedRisk::Medium,
                Some("重启会短暂中断连接，执行前请确认".to_string()),
            );
        }
    }

    let binary = container
        .flavor
        .map(|flavor| flavor.binary())
        .unwrap_or("nginx");
    let mut push =
        |id: &str, title: &str, command: String, risk: SuggestedRisk, note: Option<String>| {
            out.push(SuggestedCommand {
                id: id.to_string(),
                title: title.to_string(),
                command,
                risk,
                note,
                needs_container: false,
            });
        };

    push(
        "docker.version",
        "查看版本",
        format!("docker exec {name} {binary} -v"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.test",
        "校验配置",
        format!("docker exec {name} {binary} -t"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.dump",
        "查看完整配置",
        format!("docker exec {name} {binary} -T"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.reload",
        "平滑重载",
        format!("docker exec {name} {binary} -s reload"),
        SuggestedRisk::Medium,
        Some("会改变运行中的服务状态，执行前请确认".to_string()),
    );
    push(
        "docker.logs",
        "查看日志（最近 200 行）",
        format!("docker logs --tail 200 {name}"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.logs.follow",
        "实时跟踪日志",
        format!("docker logs -f {name}"),
        SuggestedRisk::ReadOnly,
        Some("持续输出，按 Ctrl+C 退出".to_string()),
    );
    push(
        "docker.inspect",
        "查看容器详情",
        format!("docker inspect {name}"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.exec",
        "进入容器",
        format!("docker exec -it {name} sh"),
        SuggestedRisk::Low,
        Some("交互式命令，不会生成结果快照".to_string()),
    );
    push(
        "docker.port",
        "查看端口映射",
        format!("docker port {name}"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.mounts",
        "查看配置挂载",
        format!(
            "docker inspect --format '{{{{range .Mounts}}}}{{{{println .Source}}}} {{{{.Destination}}}}{{{{end}}}}' {name}"
        ),
        SuggestedRisk::ReadOnly,
        None,
    );
    out
}

/// 宿主机 Nginx 的命令（无容器时使用）。
pub fn host_commands() -> Vec<SuggestedCommand> {
    vec![
        SuggestedCommand {
            id: "host.version".to_string(),
            title: "查看版本".to_string(),
            command: "nginx -v".to_string(),
            risk: SuggestedRisk::ReadOnly,
            note: None,
            needs_container: false,
        },
        SuggestedCommand {
            id: "host.test".to_string(),
            title: "校验配置".to_string(),
            command: "nginx -t".to_string(),
            risk: SuggestedRisk::ReadOnly,
            note: None,
            needs_container: false,
        },
        SuggestedCommand {
            id: "host.dump".to_string(),
            title: "查看完整配置".to_string(),
            command: "nginx -T".to_string(),
            risk: SuggestedRisk::ReadOnly,
            note: None,
            needs_container: false,
        },
        SuggestedCommand {
            id: "host.status".to_string(),
            title: "查看运行状态".to_string(),
            command: "systemctl status nginx".to_string(),
            risk: SuggestedRisk::ReadOnly,
            note: None,
            needs_container: false,
        },
        SuggestedCommand {
            id: "host.reload".to_string(),
            title: "平滑重载配置".to_string(),
            command: "nginx -s reload".to_string(),
            risk: SuggestedRisk::Medium,
            note: Some("会改变运行中的服务状态，执行前请确认".to_string()),
            needs_container: false,
        },
    ]
}

/// 按环境生成命令。
///
/// `selection` 是用户在多个容器里选的那个（或上一次记住的选择）。
/// `Multiple` 且没有选择 → 返回空命令，由前端先弹容器选择器：绝不替用户
/// 挑第一个容器。
pub fn nginx_commands(env: &NginxEnvironment, selection: Option<&str>) -> Vec<SuggestedCommand> {
    match env.kind {
        NginxKind::None => Vec::new(),
        NginxKind::Host => host_commands(),
        NginxKind::Docker | NginxKind::Compose => match env.single() {
            Some(container) => container_commands(container, env.kind == NginxKind::Compose),
            None => Vec::new(),
        },
        NginxKind::Multiple => match selection.and_then(|name| env.find(name)) {
            Some(container) => {
                let compose = container.compose.is_some();
                // 选定容器后仍要标明这是"已选容器"，避免用户误以为是全局命令。
                let mut commands = container_commands(container, compose);
                for command in &mut commands {
                    command.note = Some(match command.note.take() {
                        Some(note) => format!("容器 {} · {}", container.name, note),
                        None => format!("容器 {}", container.name),
                    });
                }
                commands
            }
            None => Vec::new(),
        },
    }
}

/// 单个容器名/路径的 shell 引号。`docker exec` 的参数来自服务器输出，
/// 可能含空格，必须转义后才能进命令行。
pub(crate) fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':'))
    {
        return value.to_string();
    }
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "\\$")
        .replace('`', "\\`");
    format!("\"{escaped}\"")
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn container(name: &str, image: &str) -> NginxContainer {
        let reference = parse_image_ref(image).unwrap_or_default();
        NginxContainer {
            name: name.to_string(),
            image: image.to_string(),
            image_repository: reference.repository.clone(),
            image_tag: reference.tag.clone().unwrap_or_default(),
            flavor: parse_image_ref(image).and_then(|r| flavor_of_image(&r)),
            state: "running".to_string(),
            status: "Up 5 minutes".to_string(),
            running: true,
            ..NginxContainer::default()
        }
    }

    const PS_JSON: &str = r#"{"ID":"3f2a1b9c8d7e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90","Names":"bls-nginx","Image":"nginx:alpine","State":"running","Status":"Up 5 minutes","Labels":{"com.docker.compose.project":"bls","com.docker.compose.service":"nginx","com.docker.compose.project.working_dir":"/srv/bls"},"Ports":[{"PrivatePort":80,"PublicPort":80,"Type":"tcp"},{"PrivatePort":443,"PublicPort":443,"Type":"tcp"}],"Mounts":[{"Source":"/srv/bls/nginx.conf","Destination":"/etc/nginx/nginx.conf","RW":false}]}"#;

    const PS_JSON_REGISTRY: &str = r#"{"ID":"aa11","Names":"gw","Image":"registry.internal:5000/team/nginx:1.25","State":"running","Status":"Up 2 days","Labels":{},"Ports":[{"PrivatePort":80,"PublicPort":8080,"Type":"tcp"}],"Mounts":[]}"#;

    const PS_JSON_OTHER: &str = r#"{"ID":"bb22","Names":"db","Image":"postgres:16","State":"running","Status":"Up 2 days","Labels":{},"Ports":[],"Mounts":[]}"#;

    #[test]
    fn splits_registry_repository_and_tag() {
        let reference = parse_image_ref("registry.internal:5000/team/nginx:1.25").unwrap();
        assert_eq!(
            reference.registry.as_deref(),
            Some("registry.internal:5000")
        );
        assert_eq!(reference.repository, "team/nginx");
        assert_eq!(reference.base(), "nginx");
        assert_eq!(reference.tag.as_deref(), Some("1.25"));

        let plain = parse_image_ref("nginx:alpine").unwrap();
        assert_eq!(plain.registry, None);
        assert_eq!(plain.repository, "nginx");
        assert_eq!(plain.tag.as_deref(), Some("alpine"));

        let hub = parse_image_ref("library/nginx").unwrap();
        assert_eq!(hub.repository, "nginx", "library/ 是 Docker Hub 默认前缀");
    }

    #[test]
    fn digest_references_have_no_tag() {
        let reference = parse_image_ref("nginx@sha256:abc123").unwrap();
        assert!(reference.by_digest);
        assert_eq!(reference.tag, None);
        assert_eq!(flavor_of_image(&reference), Some(NginxFlavor::Nginx));
    }

    #[test]
    fn only_the_last_repository_segment_counts() {
        // 私有仓库前缀后的实际镜像名才是判据。
        assert_eq!(
            flavor_of_image(&parse_image_ref("registry.internal:5000/team/nginx:1.25").unwrap()),
            Some(NginxFlavor::Nginx)
        );
        // ingress 控制器不是"拿来运维的 nginx"，不能误判。
        assert_eq!(
            flavor_of_image(&parse_image_ref("bitnami/nginx-ingress-controller:1.11").unwrap()),
            None
        );
        assert_eq!(
            flavor_of_image(&parse_image_ref("my-nginx-logger:1.0").unwrap()),
            None
        );
        assert_eq!(
            flavor_of_image(&parse_image_ref("openresty/openresty:alpine").unwrap()),
            Some(NginxFlavor::OpenResty)
        );
    }

    #[test]
    fn name_tokens_ignore_compose_replica_numbers() {
        assert_eq!(name_tokens("bls-nginx"), vec!["bls", "nginx"]);
        assert_eq!(name_tokens("app_nginx_1"), vec!["app", "nginx"]);
        // 没有分隔符的连写不算 token —— 避免 sidecar 之类的误判。
        assert!(!name_tokens("nginxsidecar").contains(&"nginx".to_string()));
    }

    #[test]
    fn weak_evidence_alone_does_not_convict() {
        let mut evidence = NginxEvidence::default();
        evidence.name_token_match = true;
        assert!(!is_nginx(&evidence), "单靠容器名不能定罪");

        evidence.compose_service_match = true;
        assert!(
            is_nginx(&evidence),
            "Compose service + 容器名两条弱证据成立"
        );

        let mut strong = NginxEvidence::default();
        strong.image_flavor = Some(NginxFlavor::Nginx);
        assert!(is_nginx(&strong));

        let mut binary = NginxEvidence::default();
        binary.has_binary = Some(true);
        assert!(is_nginx(&binary), "容器里真有 nginx 可执行文件");
    }

    #[test]
    fn parses_docker_ps_json() {
        let containers = parse_ps_json(PS_JSON);
        assert_eq!(containers.len(), 1);

        let nginx = &containers[0];
        assert_eq!(nginx.name, "bls-nginx");
        assert_eq!(nginx.image, "nginx:alpine");
        assert_eq!(nginx.image_repository, "nginx");
        assert_eq!(nginx.image_tag, "alpine");
        assert_eq!(nginx.flavor, Some(NginxFlavor::Nginx));
        assert!(nginx.running);
        assert_eq!(nginx.published_ports(), vec![80, 443]);
        // 配置挂载：宿主机路径 → 容器内 /etc/nginx。
        assert_eq!(nginx.config_mounts().len(), 1);
        assert_eq!(nginx.config_mounts()[0].source, "/srv/bls/nginx.conf");
        assert_eq!(
            nginx.compose.as_ref().unwrap().project,
            "bls",
            "Compose 归属要读出来"
        );
        assert_eq!(nginx.compose.as_ref().unwrap().service, "nginx");
    }

    #[test]
    fn reads_registry_prefixed_images() {
        let containers = parse_ps_json(PS_JSON_REGISTRY);
        let gateway = &containers[0];
        assert_eq!(gateway.flavor, Some(NginxFlavor::Nginx));
        assert_eq!(gateway.image_repository, "team/nginx");
        assert_eq!(gateway.published_ports(), vec![8080]);
    }

    #[test]
    fn skips_non_nginx_containers() {
        let all = parse_ps_json(&format!("{PS_JSON}\n{PS_JSON_REGISTRY}\n{PS_JSON_OTHER}"));
        assert_eq!(all.len(), 3);
        let candidates = select_nginx_candidates(&all);
        assert_eq!(candidates.len(), 2, "postgres 不能入选");
        assert!(candidates.iter().all(|item| item.name != "db"));
    }

    #[test]
    fn classifies_environments() {
        assert_eq!(classify(Vec::new(), Some(true)), NginxKind::Host);
        assert_eq!(classify(Vec::new(), Some(false)), NginxKind::None);
        assert_eq!(classify(Vec::new(), None), NginxKind::None);

        let mut docker = container("bls-nginx", "nginx:alpine");
        assert_eq!(
            classify(vec![docker.clone()], Some(false)),
            NginxKind::Docker
        );

        docker.compose = Some(ComposeRef {
            project: "bls".to_string(),
            service: "nginx".to_string(),
            working_dir: "/srv/bls".to_string(),
        });
        assert_eq!(
            classify(vec![docker.clone()], Some(false)),
            NginxKind::Compose
        );

        // 工作目录不可靠 → 不能算 Compose 环境（裸 compose 依赖当前目录）。
        docker.compose = Some(ComposeRef {
            project: "bls".to_string(),
            service: "nginx".to_string(),
            working_dir: String::new(),
        });
        assert_eq!(classify(vec![docker], Some(false)), NginxKind::Docker);

        let multiple = vec![
            container("a-nginx", "nginx:alpine"),
            container("b-nginx", "nginx:1.25"),
        ];
        assert_eq!(classify(multiple, Some(true)), NginxKind::Multiple);
    }

    #[test]
    fn docker_nginx_gets_docker_exec_commands() {
        let env = NginxEnvironment {
            kind: NginxKind::Docker,
            containers: vec![container("bls-nginx", "nginx:alpine")],
            host_installed: Some(false),
            docker_available: true,
            ..NginxEnvironment::default()
        };
        let commands = nginx_commands(&env, None);
        assert!(commands
            .iter()
            .any(|item| item.command == "docker exec bls-nginx nginx -v"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker exec bls-nginx nginx -t"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker exec bls-nginx nginx -T"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker exec bls-nginx nginx -s reload"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker logs --tail 200 bls-nginx"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker logs -f bls-nginx"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker inspect bls-nginx"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker exec -it bls-nginx sh"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker port bls-nginx"));
        assert!(commands
            .iter()
            .any(|item| item.command.starts_with("docker inspect --format")));
    }

    #[test]
    fn compose_nginx_prefers_compose_commands() {
        let mut nginx = container("bls-nginx", "nginx:alpine");
        nginx.compose = Some(ComposeRef {
            project: "bls".to_string(),
            service: "nginx".to_string(),
            working_dir: "/srv/bls".to_string(),
        });
        let env = NginxEnvironment {
            kind: NginxKind::Compose,
            containers: vec![nginx],
            docker_available: true,
            ..NginxEnvironment::default()
        };
        let commands = nginx_commands(&env, None);
        assert!(commands
            .iter()
            .any(|item| item.command == "docker compose -p bls ps nginx"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker compose -p bls logs --tail 200 nginx"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker compose -p bls exec nginx nginx -t"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker compose -p bls exec nginx nginx -s reload"));
        assert!(commands
            .iter()
            .any(|item| item.command == "docker compose -p bls restart nginx"));
    }

    #[test]
    fn reload_and_restart_keep_real_risk() {
        let env = NginxEnvironment {
            kind: NginxKind::Docker,
            containers: vec![container("bls-nginx", "nginx:alpine")],
            docker_available: true,
            ..NginxEnvironment::default()
        };
        let commands = nginx_commands(&env, None);
        let reload = commands
            .iter()
            .find(|item| item.id == "docker.reload")
            .unwrap();
        assert_eq!(reload.risk, SuggestedRisk::Medium, "reload 会改变运行状态");
        // 只读项不能因为在同一份列表里就被升级或降级。
        for id in [
            "docker.version",
            "docker.test",
            "docker.dump",
            "docker.logs",
        ] {
            let command = commands.iter().find(|item| item.id == id).unwrap();
            assert_eq!(command.risk, SuggestedRisk::ReadOnly, "{id} 必须是只读");
        }
        // 删除类命令绝不在建议里出现。
        assert!(!commands.iter().any(|item| item.command.contains(" rm ")));
        assert!(!commands.iter().any(|item| item.command.contains("rmi")));
    }

    #[test]
    fn multiple_containers_require_a_choice() {
        let env = NginxEnvironment {
            kind: NginxKind::Multiple,
            containers: vec![
                container("a-nginx", "nginx:alpine"),
                container("b-nginx", "nginx:1.25"),
            ],
            docker_available: true,
            ..NginxEnvironment::default()
        };
        assert!(
            nginx_commands(&env, None).is_empty(),
            "没选容器就不能给命令"
        );

        let chosen = nginx_commands(&env, Some("b-nginx"));
        assert!(!chosen.is_empty());
        assert!(
            chosen.iter().all(|item| item.command.contains("b-nginx")),
            "命令必须写进用户选的那个容器"
        );
        assert!(
            nginx_commands(&env, Some("gone")).is_empty(),
            "记住的容器不存在时选择必须失效"
        );
    }

    #[test]
    fn container_names_are_quoted_before_reaching_the_shell() {
        let mut nginx = container("my nginx", "nginx:alpine");
        nginx.running = true;
        nginx.flavor = Some(NginxFlavor::Nginx);
        let commands = container_commands(&nginx, false);
        let version = commands
            .iter()
            .find(|item| item.id == "docker.version")
            .unwrap();
        assert_eq!(version.command, "docker exec \"my nginx\" nginx -v");
        // 正常名字不加多余引号。
        let plain = container("bls-nginx", "nginx:alpine");
        let commands = container_commands(&plain, false);
        assert!(commands
            .iter()
            .any(|item| item.command == "docker exec bls-nginx nginx -v"));
    }

    #[test]
    fn docker_errors_are_explained() {
        let denied = classify_docker_error("Got permission denied while trying to connect");
        assert!(denied.contains("没有权限"));

        let daemon = classify_docker_error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
        assert!(daemon.contains("守护进程未运行"));

        let other = classify_docker_error("something else");
        assert!(other.starts_with("无法读取容器列表"));
    }

    #[test]
    fn host_environment_uses_host_commands() {
        let env = NginxEnvironment {
            kind: NginxKind::Host,
            host_installed: Some(true),
            ..NginxEnvironment::default()
        };
        let commands = nginx_commands(&env, None);
        assert!(commands.iter().any(|item| item.command == "nginx -v"));
        assert!(commands.iter().any(|item| item.command == "nginx -t"));
        assert!(!commands.iter().any(|item| item.command.contains("docker")));
    }

    #[test]
    fn images_are_reused_for_the_docker_snapshot_types() {
        // `docker::ImageInfo` 与容器视图保持同一套镜像判据。
        let image = crate::docker::ImageInfo {
            repository: "team/nginx".to_string(),
            tag: "1.25".to_string(),
            display_name: "registry.internal:5000/team/nginx:1.25".to_string(),
            ..crate::docker::ImageInfo::default()
        };
        let reference = parse_image_ref(&image.display_name).unwrap();
        assert_eq!(reference.base(), "nginx");
        assert_eq!(flavor_of_image(&reference), Some(NginxFlavor::Nginx));
        // `docker ps` 的文本格式与 JSON 格式得到同一个结论。
        let text_row = crate::docker::parse_ps(
            "3f2a1b9c8d7e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90|gw|registry.internal:5000/team/nginx:1.25|Up 2 days|running|0.0.0.0:8080->80/tcp|2024-01-15 09:12:33 +0800 CST",
        );
        assert_eq!(
            flavor_of_image(&parse_image_ref(&text_row[0].image).unwrap()),
            Some(NginxFlavor::Nginx)
        );
    }

    #[test]
    fn binary_probe_is_recorded_as_evidence() {
        let mut nginx = container("weird", "myrepo/thing:1.0");
        assert_eq!(nginx.flavor, None);
        assert_eq!(
            select_nginx_candidates(std::slice::from_ref(&nginx)).len(),
            0
        );
        apply_binary_probe(&mut nginx, true);
        assert_eq!(
            select_nginx_candidates(std::slice::from_ref(&nginx)).len(),
            1
        );
        assert!(nginx
            .reasons
            .iter()
            .any(|reason| reason.contains("可执行文件")));
    }

    #[test]
    fn config_mounts_are_detected() {
        let mut nginx = container("bls-nginx", "nginx:alpine");
        nginx.mounts = vec![
            MountInfo {
                source: "/srv/conf".to_string(),
                destination: "/etc/nginx".to_string(),
                read_only: true,
            },
            MountInfo {
                source: "/srv/html".to_string(),
                destination: "/usr/share/nginx/html".to_string(),
                read_only: true,
            },
        ];
        assert_eq!(nginx.config_mounts().len(), 1);
        assert_eq!(nginx.config_mounts()[0].source, "/srv/conf");
    }
}
