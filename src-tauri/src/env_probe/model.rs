//! 数据结构与**纯判定**（零 I/O）。
//!
//! 镜像引用拆分、Nginx 家族识别、证据加权、环境分类 —— 全部是
//! "证据 → 结论"的函数，没有任何针对固定服务器或固定容器名的规则。

use serde::{Deserialize, Serialize};

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
