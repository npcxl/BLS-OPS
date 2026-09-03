//! Read-only project discovery: structured evidence, deterministic scoring and scan state.

use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Mutex;

use crate::service_catalog::{is_plausible_project_root, DetectedService, InstanceRuntime};

/// 统一规范化项目路径，确保 review / inventory / confirmed_projects 使用同一把
/// 钥匙，避免 `/opt/app` 与 `/opt/app/` 被当成两个项目：
///
/// - 去掉末尾斜杠（根目录 `/` 除外）；
/// - 合并连续的斜杠（`/opt//app` → `/opt/app`）；
/// - 保留前导 `/`，不做 realpath（服务器侧 realpath 需联网，在扫描命令里完成，
///   这里只保证本地字符串一致）。
pub fn canonicalize_project_path(path: &str) -> String {
    let trimmed = path.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut prev_slash = false;
    for ch in trimmed.chars() {
        if ch == '/' {
            if prev_slash {
                continue; // 跳过重复斜杠
            }
            prev_slash = true;
        } else {
            prev_slash = false;
        }
        out.push(ch);
    }
    // 去掉末尾斜杠（根目录 / 除外）
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    if out.is_empty() {
        return "/".to_string();
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfidenceLevel {
    High,
    Likely,
    Possible,
}

/// 最终发现结论（证据等级），界面按它输出，**不只用分数**。
///
/// 分数只用于内部排序。`confidence`/`score` 是"扫描器有多确信这是个项目"，
/// 而这里是"给用户看的结论"。两者的关键区别：
/// - 用户**人工确认**后统一为 `Confirmed`，优先级最高，评分不再覆盖它；
/// - 有完整项目清单但没运行关联 → `NeedsConfirm`（待确认项目）；
/// - 只有清单/目录特征但证据链不完整 → `PossibleDir`（可能目录）；
/// - 只有运行实例、没有任何宿主源码线索 → `RunningService`（运行服务）。
///
/// 规则表见 `derive_status`，与 `score_candidate` 内部的分数阈值解耦。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryStatus {
    /// 用户已人工确认：最高优先级，不再显示"可能项目"。
    Confirmed,
    /// 项目清单 + 精确运行实例关联 / Git 根 + 源码结构 / Compose·systemd 工作目录。
    HighConfidence,
    /// 有完整项目清单但没运行关联；或有精确运行目录但缺源码清单。
    NeedsConfirm,
    /// 只有 Nginx root、静态文件或弱目录特征，证据不足以认定项目。
    PossibleDir,
    /// 只有容器/进程、没有宿主源码路径。
    RunningService,
    /// 既不是项目，也不是运行服务（仅 Docker/Nginx 已安装信息、数据/缓存/日志目录）。
    NotProject,
}

impl DiscoveryStatus {
    /// 展示用中文标签。
    pub fn label(self) -> &'static str {
        match self {
            DiscoveryStatus::Confirmed => "已确认",
            DiscoveryStatus::HighConfidence => "高可信",
            DiscoveryStatus::NeedsConfirm => "待确认",
            DiscoveryStatus::PossibleDir => "可能目录",
            DiscoveryStatus::RunningService => "运行服务",
            DiscoveryStatus::NotProject => "非项目",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectEvidence {
    pub id: String,
    pub kind: String,
    pub source: String,
    pub summary: String,
    pub weight: i32,
    pub verified_at: String,
    pub sensitive: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectPenalty {
    pub kind: String,
    pub summary: String,
    pub weight: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Process,
    Systemd,
    Docker,
    Nginx,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeLink {
    pub kind: RuntimeKind,
    pub name: String,
    pub status: Option<String>,
    pub ports: Vec<u16>,
    pub source: String,
    /// 实例跑在哪里：宿主机 / 容器 / Kubernetes。
    #[serde(default)]
    pub runtime: InstanceRuntime,
    /// 识别出的服务（MySQL / Redis / Nginx …）；识别不出为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<DetectedService>,
}

impl RuntimeLink {
    /// 该运行时关联是否来自基础设施（数据库 / 缓存 / 网关 / 监控 …），
    /// 而不是用户部署的业务应用。
    pub fn is_infrastructure(&self) -> bool {
        self.service
            .as_ref()
            .map(|service| service.group.is_infrastructure())
            .unwrap_or(false)
    }
}

/// 候选项目性质：业务应用，还是"跑在这台机器上的基础设施"。
///
/// 一台服务器上 "MySQL 容器" 和 "订单服务" 是完全不同的东西：前者是依赖，
/// 不该出现在"要不要部署这个项目"的清单里。区分不出来就返回 `Unknown`，
/// 绝不把基础设施说成业务应用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectKind {
    /// 业务应用：用户自己的代码。
    Application,
    /// 基础设施：数据库、缓存、消息队列、网关、监控、CI 等。
    Infrastructure,
    /// 证据不足以判断。
    Unknown,
}

/// 用户对一个候选目录的人工复核结论。
///
/// 与 `ProjectKind`（系统识别出的性质）是两件事：这个是**人**说了算，并且
/// 会存进数据库、下次扫描沿用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState {
    /// 还没处理。
    #[default]
    Pending,
    /// 用户确认"这是我的项目"。
    Confirmed,
    /// 用户标记为"不是项目"，之后不再出现在候选里。
    Ignored,
}

impl ReviewState {
    pub fn label(self) -> &'static str {
        match self {
            ReviewState::Pending => "待处理",
            ReviewState::Confirmed => "已确认",
            ReviewState::Ignored => "已忽略",
        }
    }

    /// 从数据库里的文本形态（`pending`/`confirmed`/`ignored`）还原枚举。
    /// 未知值回退到 `Pending`，保证旧数据或损坏行不会导致整次扫描失败。
    pub fn from_db_str(value: &str) -> Self {
        match value {
            "confirmed" => ReviewState::Confirmed,
            "ignored" => ReviewState::Ignored,
            _ => ReviewState::Pending,
        }
    }

    /// 存进数据库时使用的文本形态（与 `from_db_str` 互逆）。
    pub fn to_db_str(self) -> &'static str {
        match self {
            ReviewState::Pending => "pending",
            ReviewState::Confirmed => "confirmed",
            ReviewState::Ignored => "ignored",
        }
    }
}

impl ProjectKind {
    pub fn label(self) -> &'static str {
        match self {
            ProjectKind::Application => "业务应用",
            ProjectKind::Infrastructure => "基础设施",
            ProjectKind::Unknown => "未确定",
        }
    }

    /// 反序列化缺省值：缺少该字段的旧数据视为"未确定"。
    fn default() -> Self {
        ProjectKind::Unknown
    }
}

/// 候选项目关联到的一个部署实例。UI 用它提供"查看项目文件 / Docker 配置 /
/// Nginx 配置 / unit 文件"的跳转入口 —— 配置文件路径在这里，点开就能到目录。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CandidateInstance {
    /// `docker:<id>` / `systemd:<unit>` / `nginx:<site>` / `k8s:<ns>/<pod>`
    pub id: String,
    /// `docker` / `systemd` / `nginx` / `k8s`
    pub kind: String,
    pub name: String,
    pub status: String,
    pub runtime: InstanceRuntime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<DetectedService>,
    pub ports: Vec<u16>,
    /// 宿主机上的配置文件（Compose / unit 片段 / Nginx 配置）。镜像运行的
    /// 实例**没有**宿主机配置文件，此时为空 —— 前端要如实说"没有配置文件"，
    /// 而不是给一个假的入口。
    #[serde(default)]
    pub config_files: Vec<String>,
    #[serde(default)]
    pub working_directories: Vec<String>,
    pub detail: String,
}

impl CandidateInstance {
    /// 该实例是否有任何宿主机上的配置文件可看。
    pub fn has_config(&self) -> bool {
        !self.config_files.is_empty()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectModule {
    pub id: String,
    pub name: String,
    pub path: String,
    pub project_type: String,
    pub deployable: bool,
    pub children: Vec<ProjectModule>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeploymentReadiness {
    pub score: u8,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
    pub confirmed_facts: Vec<String>,
    pub unknown_facts: Vec<String>,
}
/// 候选项目的发现类别（部署实例优先流程的产物分桶）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateCategory {
    /// 已部署：与真实部署实例（容器/服务/站点）建立了运行时关联。
    Deployed,
    /// 仅源码：有项目标志文件，但没有关联到任何运行实例。
    SourceOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectCandidate {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub path: String,
    pub project_type: String,
    pub score: u8,
    pub confidence: ConfidenceLevel,
    /// 最终发现结论（证据等级），界面按它输出，不只用分数。确认覆盖一切。
    pub status: DiscoveryStatus,
    /// 已部署（关联实例）或仅源码。
    pub category: CandidateCategory,
    /// 业务应用 / 基础设施 / 未确定。MySQL、Redis、Nginx 这类是**依赖**而不是
    /// 项目，必须与业务应用分开放，否则"要不要部署"清单里会混进一堆中间件。
    #[serde(default = "ProjectKind::default")]
    pub project_kind: ProjectKind,
    /// 关联到的部署实例（含配置文件路径，供 UI 跳转查看）。
    #[serde(default)]
    pub deploy_instances: Vec<CandidateInstance>,
    /// 目录下命中的项目标志（小写）。**项目级部署准备检查的依据** —— 有没有
    /// Dockerfile / compose / 构建清单都看它，前端和后端都不猜。
    #[serde(default)]
    pub markers: Vec<String>,
    /// 所有关联实例的配置文件汇总（去重、有序）。
    #[serde(default)]
    pub config_files: Vec<String>,
    /// 人工复核结论。用户点"确认项目"或"忽略目录"后写入数据库，下次扫描沿用。
    #[serde(default)]
    pub review: ReviewState,
    pub evidence: Vec<ProjectEvidence>,
    pub penalties: Vec<ProjectPenalty>,
    pub runtime_links: Vec<RuntimeLink>,
    pub modules: Vec<ProjectModule>,
    pub detected_ports: Vec<u16>,
    pub required_environment_names: Vec<String>,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
    pub readiness: DeploymentReadiness,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ScanState {
    Queued,
    Running,
    Completed,
    Cancelled,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScanProgress {
    pub phase: String,
    pub progress: u8,
    pub checked_directories: u32,
    pub discovered_candidates: u32,
    pub current_path: Option<String>,
    pub warnings: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectScanStatus {
    pub id: String,
    pub server_id: String,
    pub state: ScanState,
    pub progress: ScanProgress,
    pub error: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectScanResult {
    pub scan_id: String,
    pub server_id: String,
    pub candidates: Vec<ProjectCandidate>,
    pub warnings: Vec<String>,
    pub completed_at: i64,
    pub incremental: bool,
    /// 第一/二层产物：服务器能力图谱。扫描先做能力前置识别，再按需启用收集器。
    /// 未做能力识别（旧路径或被取消）时为 `None`。
    pub capability: Option<crate::capability_probe::ServerCapabilityProfile>,
    /// 第一轮产物：服务器上真实存在的部署实例（容器/服务/站点）。
    /// `source_known == false` 的实例即"只有运行实例，源码未知"。
    pub instances: Vec<crate::deployment_collector::DeploymentInstance>,
    /// Nginx 网关路由（server block）：网关实例与路由分离后的产物，
    /// 项目详情的"访问入口"用它展示。旧快照无此字段（serde default）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gateway_routes: Vec<crate::deployment_collector::GatewayRoute>,
}

impl ProjectScanResult {
    /// 便捷构造：能力图谱与实例默认为空。
    pub fn with(
        scan_id: String,
        server_id: String,
        candidates: Vec<ProjectCandidate>,
        warnings: Vec<String>,
        completed_at: i64,
        incremental: bool,
    ) -> Self {
        Self {
            scan_id,
            server_id,
            candidates,
            warnings,
            completed_at,
            incremental,
            capability: None,
            instances: Vec::new(),
            gateway_routes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CandidateInput {
    pub path: String,
    pub name: String,
    pub server_id: String,
    pub markers: Vec<String>,
    pub source: String,
    pub runtime_links: Vec<RuntimeLink>,
    /// 与 `runtime_links` 一一对应的部署实例（含配置文件路径）。
    pub instances: Vec<CandidateInstance>,
    /// 该目录此前的人工复核结论（从数据库读出）。被忽略的目录不再进候选列表。
    pub review: ReviewState,
    pub modules: Vec<ProjectModule>,
    pub env_names: Vec<String>,
    pub ports: Vec<u16>,
}

pub fn score_candidate(input: CandidateInput, now: &str) -> Option<ProjectCandidate> {
    let markers: HashSet<String> = input
        .markers
        .iter()
        .map(|m| m.to_ascii_lowercase())
        .collect();
    let noisy = [
        "node_modules",
        "target",
        "dist",
        "build",
        ".cache",
        "vendor",
        "venv",
        ".venv",
    ];
    if noisy
        .iter()
        .any(|part| input.path.split('/').any(|p| p == *part))
    {
        return None;
    }
    // **操作系统自带的目录不是项目**。`find /home /srv /opt …` 会命中
    // `/usr/local/lib/python3/.../package.json` 这类属于发行版的东西，列出来
    // 只会淹没真正的业务代码。判定规则集中在 `service_catalog`，与"什么算
    // 依赖目录"共用同一张表。
    if is_plausible_project_root(&input.path).is_err() {
        return None;
    }
    // 用户明确说过"这不是项目"的目录，不再出现在候选里 —— 复核结论必须跨扫描
    // 生效，否则每次重扫都要重新处理一遍同样的噪声。
    if input.review == ReviewState::Ignored {
        return None;
    }
    let mut evidence = Vec::new();
    let mut penalties = Vec::new();
    let mut add = |kind: &str, source: &str, summary: &str, weight: i32| {
        evidence.push(ProjectEvidence {
            id: format!("{kind}:{source}"),
            kind: kind.into(),
            source: source.into(),
            summary: summary.into(),
            weight,
            verified_at: now.into(),
            sensitive: false,
        })
    };
    let mut sums = BTreeMap::<&str, i32>::new();
    // 标志在入口处已全部转为小写，下面的匹配表必须同样小写 —— 一旦写出
    // "Cargo.toml" 这类大小写形式，规则将永远匹配不到（历史上真实发生过）。
    let mut identity: Vec<String> = [
        ".git",
        "package.json",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "cargo.toml",
        "go.mod",
        "pyproject.toml",
        "setup.py",
        "requirements.txt",
        "composer.json",
        "dockerfile",
        "docker-compose.yml",
        "compose.yml",
        "compose.yaml",
        "procfile",
    ]
    .into_iter()
    .filter(|m| markers.contains(*m))
    .map(str::to_string)
    .collect();
    // .sln / .csproj / .fsproj 的前缀是任意的项目名，只能按**后缀**识别，
    // 不能拿固定文件名去比。
    for marker in &markers {
        if is_dotnet_project_file(marker) && !identity.iter().any(|known| known == marker) {
            identity.push(marker.clone());
        }
    }
    if !identity.is_empty() {
        add(
            "project_identity",
            &input.source,
            &format!("发现项目标志：{}", identity.join("、")),
            20,
        );
        sums.insert("identity", 20);
    }
    let source_markers = [
        "src",
        "app",
        "main",
        "index.js",
        "main.go",
        "main.py",
        "application.java",
    ];
    let source_count = source_markers
        .iter()
        .filter(|m| markers.contains(**m))
        .count();
    if source_count > 0 {
        let w = (5 + source_count as i32 * 3).min(15);
        add(
            "source_structure",
            &input.source,
            "发现源码目录或入口文件",
            w,
        );
        sums.insert("source", w);
    }
    let deploy_markers = [
        "dockerfile",
        "docker-compose.yml",
        "compose.yml",
        "compose.yaml",
        "systemd",
        "nginx.conf",
        "procfile",
    ];
    let deploy_count = deploy_markers
        .iter()
        .filter(|m| markers.contains(**m))
        .count();
    if deploy_count > 0 {
        let w = (5 + deploy_count as i32 * 5).min(20);
        add("deployment", &input.source, "发现部署或启动配置", w);
        sums.insert("deployment", w);
    }
    if markers.contains(".git") {
        add("repository", &input.source, "Git 工作区根目录", 10);
        sums.insert("repository", 10);
    }
    let complete = [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "cargo.lock",
        "poetry.lock",
        "readme.md",
        ".env.example",
        ".github",
    ]
    .iter()
    .filter(|m| markers.contains(**m))
    .count();
    if complete > 0 {
        let w = (complete as i32 * 2).min(10);
        add("integrity", &input.source, "发现锁文件、说明或环境模板", w);
        sums.insert("integrity", w);
    }
    for link in &input.runtime_links {
        let w = match link.kind {
            // 运行中的进程/服务是最强的"这是个真项目"证据。
            RuntimeKind::Process | RuntimeKind::Systemd => 25,
            _ => 20,
        };
        add(
            "runtime",
            &link.source,
            &format!("运行时关联：{}", link.name),
            w,
        );
        *sums.entry("runtime").or_default() += w;
    }
    if markers
        .iter()
        .all(|m| ["jar", "dist", "build"].contains(&m.as_str()))
        && identity.is_empty()
    {
        penalties.push(ProjectPenalty {
            kind: "artifact_only".into(),
            summary: "只有构建产物，没有项目清单或源码结构".into(),
            weight: 30,
        });
    }
    if markers
        .iter()
        .all(|m| ["node_modules", ".cache", "vendor"].contains(&m.as_str()))
    {
        return None;
    }
    let positive: i32 = sums.values().sum::<i32>().min(100);
    let penalty: i32 = penalties.iter().map(|p| p.weight).sum();
    let score = (positive - penalty).clamp(0, 100) as u8;
    // 过滤规则不是"总分低于某个阈值就丢"。旧的 `score < 35` 会把
    // `package.json + src`（20 + 8 = 28）这种再正常不过的项目直接丢弃。
    // 现在的规则是证据驱动的三条：
    //   1. 既没有项目标志、也没有部署实例关联的目录不是项目 —— 例如一个孤零零
    //      的 `src` 目录，或只有锁文件/README 的目录。
    //   2. 有项目标志就必须保留。只有 `package.json` 的目录也是项目，只是证据
    //      少，以低置信度（Possible）展示，而不是直接消失。
    //   3. 被部署实例明确关联（WorkingDirectory / 挂载 / 站点根目录）的目录，
    //      即使标志很少也不过滤：正在运行的实例本身就是最强证据。
    if identity.is_empty() && input.runtime_links.is_empty() {
        return None;
    }
    let confidence = match score {
        75..=100 => ConfidenceLevel::High,
        55..=74 => ConfidenceLevel::Likely,
        _ => ConfidenceLevel::Possible,
    };
    let project_type = detect_type(&markers);
    let readiness = readiness(&markers, &input.runtime_links, &input.env_names);
    // **项目性质由源码身份决定，运行方式由实例决定，依赖由服务关联决定**。
    // 一个订单系统关联了 Docker + Nginx + MySQL + Redis，它的性质依然是
    // "业务应用" —— 不能因为它关联了 MySQL/Redis 就被归为基础设施。
    // 判定规则：
    //   - 自身有构建清单（package.json / pom.xml / Cargo.toml …）→ 业务应用；
    //   - 没有清单、但关联实例被认成中间件（且不是项目本身）→ 基础设施；
    //   - 其余 → 未确定（绝不谎称业务应用）。
    let has_manifest = identity.iter().any(|m| is_build_manifest(m));
    let infra_links = input
        .runtime_links
        .iter()
        .filter(|link| link.is_infrastructure())
        .count();
    let project_kind = if has_manifest {
        ProjectKind::Application
    } else if infra_links > 0 {
        ProjectKind::Infrastructure
    } else {
        ProjectKind::Unknown
    };
    // **最终结论（证据等级）**：评分只用于内部排序，界面按 `status` 输出。
    // 用户人工确认优先级最高，一旦确认就不再是"可能项目"。
    let status = derive_status(
        input.review,
        has_manifest,
        input.runtime_links.is_empty(),
        source_count > 0,
        project_kind,
    );
    // 配置文件汇总：UI 的"查看 Docker 配置 / Nginx 配置"就靠它跳转。
    let mut config_files: Vec<String> = Vec::new();
    for instance in &input.instances {
        for file in &instance.config_files {
            if !config_files.contains(file) {
                config_files.push(file.clone());
            }
        }
    }
    Some(ProjectCandidate {
        id: format!("{}:{}", input.server_id, input.path),
        server_id: input.server_id,
        name: input.name,
        path: input.path,
        project_type,
        score,
        confidence,
        status,
        category: if input.runtime_links.is_empty() {
            CandidateCategory::SourceOnly
        } else {
            CandidateCategory::Deployed
        },
        project_kind,
        deploy_instances: input.instances,
        markers: {
            let mut sorted: Vec<String> = markers.iter().cloned().collect();
            sorted.sort();
            sorted
        },
        config_files,
        review: input.review,
        evidence,
        penalties,
        runtime_links: input.runtime_links,
        modules: input.modules,
        detected_ports: input.ports,
        required_environment_names: input.env_names,
        blockers: readiness.blockers.clone(),
        warnings: readiness.warnings.clone(),
        readiness,
        updated_at: now.into(),
    })
}

/// .NET 的工程文件按后缀识别（`Foo.sln` / `Foo.csproj` / `Foo.fsproj`）。
fn is_dotnet_project_file(name: &str) -> bool {
    name.ends_with(".sln") || name.ends_with(".csproj") || name.ends_with(".fsproj")
}

/// 是否为**构建清单**（能证明"这是一个项目"的源码身份文件）。
///
/// 注意：`dockerfile` / `compose.yml` 这类部署清单不算构建清单 —— 一个
/// 只有 `docker-compose.yml` 的目录可能是某个服务的部署描述，不一定是源代码
/// 项目。构建清单专指 `package.json` / `pom.xml` / `Cargo.toml` 这类"有源码要
/// 构建"的信号。
fn is_build_manifest(marker: &str) -> bool {
    matches!(
        marker,
        "package.json"
            | "pom.xml"
            | "build.gradle"
            | "build.gradle.kts"
            | "cargo.toml"
            | "go.mod"
            | "pyproject.toml"
            | "setup.py"
            | "requirements.txt"
            | "composer.json"
    ) || is_dotnet_project_file(marker)
}

/// 根据证据推导最终发现结论（证据等级）。评分只用于排序，这里才是界面结论。
///
/// 规则（与用户验收表对齐）：
/// - 用户已确认 → `Confirmed`（最高优先级，评分不可覆盖）。
/// - 有构建清单 + 精确运行实例关联 → `HighConfidence`。
/// - 有构建清单（或 Git 根 + 源码结构）→ `NeedsConfirm`（待确认项目）。
/// - 无构建清单但有运行关联，且没有宿主源码清单 → `RunningService`（运行服务）。
/// - 无构建清单且自身是基础设施（数据/缓存目录）→ `NotProject`（非项目）。
/// - 其余只有目录/静态文件特征的 → `PossibleDir`（可能目录）。
fn derive_status(
    review: ReviewState,
    has_manifest: bool,
    no_runtime_link: bool,
    has_source: bool,
    project_kind: ProjectKind,
) -> DiscoveryStatus {
    // 人工确认优先级最高：一旦确认，它不再是"可能项目"。
    if review == ReviewState::Confirmed {
        return DiscoveryStatus::Confirmed;
    }
    if !has_manifest {
        if !no_runtime_link {
            // 只有容器/进程、没有宿主源码清单。
            return DiscoveryStatus::RunningService;
        }
        if project_kind == ProjectKind::Infrastructure {
            // MySQL / Redis 数据目录、缓存、日志、构建产物等。
            return DiscoveryStatus::NotProject;
        }
        return DiscoveryStatus::PossibleDir;
    }
    if !no_runtime_link {
        return DiscoveryStatus::HighConfidence;
    }
    // 有构建清单；Git 根 + 源码结构也算高可信，否则待确认。
    if has_source {
        DiscoveryStatus::HighConfidence
    } else {
        DiscoveryStatus::NeedsConfirm
    }
}

fn detect_type(m: &HashSet<String>) -> String {
    if m.contains("pom.xml") {
        "Java Maven"
    } else if m.contains("build.gradle") || m.contains("build.gradle.kts") {
        "Java Gradle"
    } else if m.contains("package.json") {
        "Node.js"
    } else if m.contains("pyproject.toml")
        || m.contains("setup.py")
        || m.contains("requirements.txt")
    {
        "Python"
    } else if m.contains("go.mod") {
        "Go"
    } else if m.contains("cargo.toml") {
        "Rust"
    } else if m.contains("composer.json") {
        "PHP"
    } else if m.iter().any(|name| is_dotnet_project_file(name)) {
        ".NET"
    } else if m.contains("dockerfile") || m.contains("compose.yml") || m.contains("compose.yaml") {
        "Docker"
    } else {
        "未知项目"
    }
    .into()
}
fn readiness(m: &HashSet<String>, links: &[RuntimeLink], env: &[String]) -> DeploymentReadiness {
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let mut confirmed = Vec::new();
    let mut unknown = Vec::new();
    if m.contains("package.json")
        || m.contains("pom.xml")
        || m.contains("build.gradle")
        || m.contains("cargo.toml")
        || m.contains("go.mod")
        || m.contains("pyproject.toml")
        || m.contains("composer.json")
        || m.iter().any(|name| is_dotnet_project_file(name))
    {
        confirmed.push("存在构建清单".into());
    } else {
        blockers.push("未识别构建清单".into());
    }
    if [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "cargo.lock",
    ]
    .iter()
    .any(|x| m.contains(*x))
    {
        confirmed.push("存在锁文件".into());
    } else {
        warnings.push("未发现锁文件".into());
    }
    if !links.is_empty() {
        confirmed.push("已关联运行服务".into());
    } else {
        unknown.push("尚未关联运行服务".into());
    }
    if env.is_empty() {
        unknown.push("未识别必要环境变量".into());
    } else {
        confirmed.push(format!("识别 {} 个环境变量名称", env.len()));
    }
    let score =
        (100i32 - blockers.len() as i32 * 35 - warnings.len() as i32 * 10).clamp(0, 100) as u8;
    DeploymentReadiness {
        score,
        blockers,
        warnings,
        confirmed_facts: confirmed,
        unknown_facts: unknown,
    }
}

pub fn merge_candidates(mut candidates: Vec<ProjectCandidate>) -> Vec<ProjectCandidate> {
    candidates.sort_by(|a, b| {
        a.path
            .matches('/')
            .count()
            .cmp(&b.path.matches('/').count())
            .then_with(|| b.score.cmp(&a.score))
    });
    let mut roots: Vec<ProjectCandidate> = Vec::new();
    for c in candidates {
        if let Some(parent) = roots.iter_mut().find(|p| {
            c.path.starts_with(&(p.path.clone() + "/"))
                && p.modules.iter().all(|m| m.path != c.path)
        }) {
            parent.modules.push(ProjectModule {
                id: c.id,
                name: c.name,
                path: c.path,
                project_type: c.project_type,
                deployable: !c.blockers.is_empty() || c.runtime_links.len() > 0,
                children: c.modules,
            });
            parent.score = parent.score.max(c.score);
        } else {
            roots.push(c);
        }
    }
    roots
}

#[derive(Clone, Default)]
pub struct ScanRegistry {
    pub tasks: Arc<Mutex<HashMap<String, ProjectScanStatus>>>,
    pub results: Arc<Mutex<HashMap<String, ProjectScanResult>>>,
    pub active_by_server: Arc<Mutex<HashMap<String, String>>>,
    pub cancel: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// 每台服务器最近一次**成功**的扫描结果。项目级部署准备检查按
    /// (server_id, path) 从这里取候选，不必重新扫一遍。
    pub last_by_server: Arc<Mutex<HashMap<String, ProjectScanResult>>>,
}
impl ScanRegistry {
    pub async fn start(&self, status: ProjectScanStatus) -> Result<Arc<AtomicBool>, String> {
        let mut active = self.active_by_server.lock().await;
        if active.contains_key(&status.server_id) {
            return Err("该服务器已有扫描任务正在运行".into());
        }
        let token = Arc::new(AtomicBool::new(false));
        active.insert(status.server_id.clone(), status.id.clone());
        self.cancel
            .lock()
            .await
            .insert(status.id.clone(), token.clone());
        self.tasks.lock().await.insert(status.id.clone(), status);
        Ok(token)
    }
    pub async fn cancel(&self, id: &str) -> bool {
        if let Some(token) = self.cancel.lock().await.get(id) {
            token.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
    /// 记录该服务器最近一次成功结果，供项目级部署准备检查复用。
    pub async fn remember(&self, server: &str, result: ProjectScanResult) {
        self.last_by_server
            .lock()
            .await
            .insert(server.to_string(), result);
    }

    /// 取该服务器最近一次成功扫描中某个路径的候选。
    pub async fn candidate_for(
        &self,
        server: &str,
        path: &str,
    ) -> Option<(
        ProjectCandidate,
        crate::capability_probe::ServerCapabilityProfile,
    )> {
        let results = self.last_by_server.lock().await;
        let result = results.get(server)?;
        let candidate = result
            .candidates
            .iter()
            .find(|candidate| candidate.path == path)?
            .clone();
        Some((candidate, result.capability.clone()?))
    }

    pub async fn finish(&self, id: &str, server: &str, state: ScanState, error: Option<String>) {
        self.active_by_server.lock().await.remove(server);
        self.cancel.lock().await.remove(id);
        if let Some(s) = self.tasks.lock().await.get_mut(id) {
            s.state = state;
            s.error = error;
            s.finished_at = Some(chrono_like_now());
        }
    }
}
pub fn chrono_like_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(path: &str, markers: &[&str]) -> CandidateInput {
        CandidateInput {
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap_or("项目").to_string(),
            server_id: "srv-1".to_string(),
            markers: markers.iter().map(|m| m.to_string()).collect(),
            source: "test".to_string(),
            runtime_links: Vec::new(),
            instances: Vec::new(),
            modules: Vec::new(),
            env_names: Vec::new(),
            ports: Vec::new(),
            review: ReviewState::Pending,
        }
    }

    /// 构造一个带服务身份的运行时关联（模拟收集器识别出的实例）。
    fn link_with_service(name: &str, service_id: Option<&str>) -> RuntimeLink {
        RuntimeLink {
            kind: RuntimeKind::Docker,
            name: name.to_string(),
            status: Some("running".into()),
            ports: Vec::new(),
            source: "deployment_instance".into(),
            runtime: InstanceRuntime::Container,
            service: service_id.map(|id| DetectedService {
                id: id.to_string(),
                label: id.to_string(),
                group: crate::service_catalog::identify_image(id)
                    .map(|identity| identity.group)
                    .unwrap_or(crate::service_catalog::ServiceGroup::Application),
            }),
        }
    }

    /// 目录名里带 node_modules / target 这类依赖目录的，永远不是项目根目录。
    #[test]
    fn dependency_directories_are_never_candidates() {
        assert!(score_candidate(
            input("/srv/app/node_modules/left-pad", &["package.json"]),
            "0"
        )
        .is_none());
        assert!(score_candidate(input("/srv/app/target/debug", &["cargo.toml"]), "0").is_none());
    }

    /// 一个普通的 Node 项目（package.json + src，没有 .git、没有部署配置）
    /// 必须留下来当"待确认"，不能被总分阈值直接过滤掉。
    #[test]
    fn a_plain_node_project_survives_scoring() {
        let candidate = score_candidate(input("/srv/api", &["package.json", "src"]), "0")
            .expect("普通 Node 项目不能被丢弃");
        assert_eq!(candidate.project_type, "Node.js");
        assert_eq!(candidate.confidence, ConfidenceLevel::Possible);
        assert!(candidate.score >= 20, "score = {}", candidate.score);
    }

    /// 只有一个 package.json 的目录也是项目：低置信度展示，而不是消失。
    #[test]
    fn a_lone_manifest_is_a_low_confidence_candidate() {
        let candidate =
            score_candidate(input("/srv/bare", &["package.json"]), "0").expect("单个清单也应展示");
        assert_eq!(candidate.confidence, ConfidenceLevel::Possible);
    }

    /// 标志在入口被统一转小写，规则表必须同样小写 —— 否则 "Cargo.toml" 这类
    /// 磁盘上的真实大小写永远匹配不到。
    #[test]
    fn markers_match_regardless_of_the_case_on_disk() {
        let candidate = score_candidate(
            input("/srv/rust-app", &["Cargo.toml", "Cargo.lock", "src"]),
            "0",
        )
        .expect("大小写混合的标志必须能匹配");
        assert_eq!(candidate.project_type, "Rust");
        // Cargo.lock 属于"完整性"证据，说明小写规则生效了。
        assert!(
            candidate.evidence.iter().any(|e| e.kind == "integrity"),
            "{:?}",
            candidate.evidence
        );
    }

    /// .sln / .csproj 的前缀是项目名称，只能按后缀识别。
    #[test]
    fn dotnet_projects_are_recognised_by_suffix() {
        for marker in ["MyApp.sln", "MyApp.csproj", "MyApp.fsproj"] {
            let candidate = score_candidate(input("/srv/dotnet", &[marker]), "0")
                .unwrap_or_else(|| panic!("{marker} 必须被识别"));
            assert_eq!(candidate.project_type, ".NET");
        }
    }

    /// 只有目录名而没有项目标志、也没有运行实例的，不是项目。
    #[test]
    fn a_bare_source_directory_is_not_a_project() {
        assert!(score_candidate(input("/var/tmp/src", &["src", "app"]), "0").is_none());
        assert!(score_candidate(input("/var/tmp/docs", &["readme.md"]), "0").is_none());
    }

    /// 被部署实例明确关联的目录（WorkingDirectory / 挂载）即使标志很少也不能
    /// 被过滤：正在运行的实例本身就是最强证据。
    #[test]
    fn deployment_linked_directories_are_never_filtered_out() {
        let mut linked = input("/opt/deployed", &["src"]);
        linked.runtime_links.push(RuntimeLink {
            kind: RuntimeKind::Systemd,
            name: "my-app.service".into(),
            status: Some("active".into()),
            ports: vec![8080],
            source: "deployment_instance".into(),
            runtime: InstanceRuntime::Host,
            service: None,
        });
        let candidate = score_candidate(linked, "0").expect("被实例关联的目录必须保留");
        assert_eq!(candidate.category, CandidateCategory::Deployed);
        assert!(candidate.score >= 25, "score = {}", candidate.score);
    }

    /// MySQL / Redis 这类是**依赖**，不是要部署的项目。它们必须能被区分出来，
    /// 否则"要不要部署"的清单里会混进一堆数据库和缓存。
    #[test]
    fn databases_are_classified_as_infrastructure_not_projects() {
        let mut linked = input("/opt/mysql", &["docker-compose.yml"]);
        linked
            .runtime_links
            .push(link_with_service("mysql", Some("mysql")));
        let candidate = score_candidate(linked, "0").expect("仍要保留，只是性质不同");
        assert_eq!(candidate.project_kind, ProjectKind::Infrastructure);

        let mut linked = input("/opt/redis", &["docker-compose.yml"]);
        linked
            .runtime_links
            .push(link_with_service("redis", Some("redis")));
        let candidate = score_candidate(linked, "0").expect("仍要保留");
        assert_eq!(candidate.project_kind, ProjectKind::Infrastructure);
    }

    /// 项目性质由**源码身份**决定：有 package.json 就是业务应用，不会因为
    /// 关联的实例认不出服务就降级成"未确定"。
    #[test]
    fn source_identity_decides_project_kind() {
        let mut linked = input("/opt/app", &["package.json"]);
        linked
            .runtime_links
            .push(link_with_service("order-api", None));
        let candidate = score_candidate(linked, "0").expect("业务目录必须保留");
        assert_eq!(candidate.project_kind, ProjectKind::Application);
        assert_eq!(candidate.status, DiscoveryStatus::HighConfidence);
    }

    /// 操作系统自带目录下的 package.json 不是项目。
    #[test]
    fn operating_system_directories_are_never_candidates() {
        assert!(score_candidate(
            input("/usr/local/lib/node_modules/npm", &["package.json"]),
            "0"
        )
        .is_none());
        assert!(score_candidate(input("/var/lib/docker/overlay2/abc", &["src"]), "0").is_none());
        assert!(score_candidate(input("/usr/share/some-app", &["package.json"]), "0").is_none());
    }

    /// 配置文件必须随候选一起给出 —— UI 的"查看 Docker 配置 / Nginx 配置"
    /// 就是靠它跳到目录的。
    #[test]
    fn config_files_are_carried_through_to_the_candidate() {
        let mut linked = input("/srv/app", &["package.json"]);
        linked.runtime_links.push(link_with_service("app", None));
        linked.instances.push(CandidateInstance {
            id: "docker:abc123".into(),
            kind: "docker".into(),
            name: "app".into(),
            status: "running".into(),
            runtime: InstanceRuntime::Container,
            image: Some("registry.local/team/app:1.0".into()),
            service: None,
            ports: vec![8080],
            config_files: vec!["/srv/app/docker-compose.yml".into()],
            working_directories: vec!["/srv/app".into()],
            detail: "镜像 registry.local/team/app:1.0".into(),
        });
        let candidate = score_candidate(linked, "0").expect("必须保留");
        assert_eq!(
            candidate.config_files,
            vec!["/srv/app/docker-compose.yml".to_string()]
        );
        assert!(candidate
            .deploy_instances
            .first()
            .expect("实例详情必须带上")
            .has_config());
    }
}
