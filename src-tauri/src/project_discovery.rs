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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectCandidate {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub path: String,
    pub project_type: String,
    pub score: u8,
    pub confidence: ConfidenceLevel,
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
#[serde(rename_all = "snake_case", tag = "state")]
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
    /// 第三张图谱：每个已注册部署适配器的准备度评估（部署可行性图谱）。
    pub deployment_readiness: Vec<crate::deployment_adapter::AdapterReadiness>,
}

impl ProjectScanResult {
    /// 便捷构造：能力图谱与可行性图谱默认为空。
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
    let identity: Vec<&str> = [
        ".git",
        "package.json",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "composer.json",
        ".sln",
        ".csproj",
    ]
    .into_iter()
    .filter(|m| markers.contains(*m))
    .collect();
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
        "Application.java",
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
        "Dockerfile",
        "docker-compose.yml",
        "compose.yml",
        "systemd",
        "nginx.conf",
        "Procfile",
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
        "Cargo.lock",
        "poetry.lock",
        "README.md",
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
            RuntimeKind::Process | RuntimeKind::Systemd => 15,
            _ => 10,
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
    if score < 35 {
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

fn detect_type(m: &HashSet<String>) -> String {
    if m.contains("pom.xml") {
        "Java Maven"
    } else if m.contains("build.gradle") || m.contains("build.gradle.kts") {
        "Java Gradle"
    } else if m.contains("package.json") {
        "Node.js"
    } else if m.contains("pyproject.toml") {
        "Python"
    } else if m.contains("go.mod") {
        "Go"
    } else if m.contains("Cargo.toml") {
        "Rust"
    } else if m.contains("composer.json") {
        "PHP"
    } else if m.contains(".csproj") || m.contains(".sln") {
        ".NET"
    } else if m.contains("Dockerfile") || m.contains("compose.yml") {
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
        || m.contains("Cargo.toml")
        || m.contains("go.mod")
    {
        confirmed.push("存在构建清单".into());
    } else {
        blockers.push("未识别构建清单".into());
    }
    if [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "Cargo.lock",
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
    pub async fn finish(&self, id: &str, server: &str, state: ScanState) {
        self.active_by_server.lock().await.remove(server);
        self.cancel.lock().await.remove(id);
        if let Some(s) = self.tasks.lock().await.get_mut(id) {
            s.state = state;
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
