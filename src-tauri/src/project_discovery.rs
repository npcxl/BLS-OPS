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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfidenceLevel {
    High,
    Likely,
    Possible,
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
    /// 已部署（关联实例）或仅源码。
    pub category: CandidateCategory,
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
    /// 第三张图谱：每个已注册部署适配器的准备度评估（部署可行性图谱）。
    pub deployment_readiness: Vec<crate::deployment_adapter::AdapterReadiness>,
}

impl ProjectScanResult {
    /// 便捷构造：能力图谱、实例与可行性图谱默认为空。
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
            deployment_readiness: Vec::new(),
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
    Some(ProjectCandidate {
        id: format!("{}:{}", input.server_id, input.path),
        server_id: input.server_id,
        name: input.name,
        path: input.path,
        project_type,
        score,
        confidence,
        category: if input.runtime_links.is_empty() {
            CandidateCategory::SourceOnly
        } else {
            CandidateCategory::Deployed
        },
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
            modules: Vec::new(),
            env_names: Vec::new(),
            ports: Vec::new(),
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
        });
        let candidate = score_candidate(linked, "0").expect("被实例关联的目录必须保留");
        assert_eq!(candidate.category, CandidateCategory::Deployed);
        assert!(candidate.score >= 25, "score = {}", candidate.score);
    }
}
