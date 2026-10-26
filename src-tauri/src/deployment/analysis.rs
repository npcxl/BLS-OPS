//! P5.6 **统一项目分析** —— 复用既有 `artifact::inspect` 的结果，投影成一份
//! 给草案用、也给 AI 用的结构化摘要（不重新扫描、不改识别结论）。
//!
//! 边界：只有变量名没有值；证据是相对路径；源码片段走 `sanitize_fragment` 单独限额。
//! 永远不发 `.env` 值、私钥、Token、云凭据、Git 凭据、源码树、二进制。

use serde::{Deserialize, Serialize};

use crate::deployment::artifact::model::{
    ArtifactInspection, BuildStep, DependencyGuess, InspectionCheck, InspectionCheckState,
    ServiceCandidate,
};

/// 项目大类（允许 `Unknown` —— 宁可说不知道）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectKind {
    Frontend,
    Backend,
    Worker,
    Monorepo,
    StaticSite,
    Library,
    Service,
    Unknown,
}

impl ProjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectKind::Frontend => "frontend",
            ProjectKind::Backend => "backend",
            ProjectKind::Worker => "worker",
            ProjectKind::Monorepo => "monorepo",
            ProjectKind::StaticSite => "static_site",
            ProjectKind::Library => "library",
            ProjectKind::Service => "service",
            ProjectKind::Unknown => "unknown",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ProjectKind::Frontend => "前端",
            ProjectKind::Backend => "后端",
            ProjectKind::Worker => "Worker",
            ProjectKind::Monorepo => "多服务单仓",
            ProjectKind::StaticSite => "静态站点",
            ProjectKind::Library => "库",
            ProjectKind::Service => "服务",
            ProjectKind::Unknown => "待确认",
        }
    }
}

/// 阻塞 / 未知结论（都带证据）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnalysisFinding {
    pub id: String,
    pub message: String,
    #[serde(default)]
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct StackSummary {
    pub language: String,
    #[serde(default)]
    pub package_manager: Option<String>,
    #[serde(default)]
    pub framework: Option<String>,
    #[serde(default)]
    pub markers: Vec<String>,
}

/// 一个服务。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnalyzedService {
    pub name: String,
    pub role: String,
    pub service_kind: String,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub deploy_path: Option<String>,
    #[serde(default)]
    pub ports: Vec<u16>,
    #[serde(default)]
    pub health: Vec<String>,
    /// 环境变量**名称**（不含值）。
    #[serde(default)]
    pub env_keys: Vec<String>,
    /// secret-like 变量**名称**。
    #[serde(default)]
    pub secret_like_keys: Vec<String>,
    pub confidence: u8,
    #[serde(default)]
    pub evidence: Vec<String>,
}

/// 外部依赖（托管数据库、第三方 API）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ExternalDependency {
    pub name: String,
    pub kind: String,
}

/// 统一项目分析结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProjectAnalysis {
    pub project_kind: ProjectKind,
    pub stack: StackSummary,
    pub services: Vec<AnalyzedService>,
    pub ports: Vec<(String, u16)>,
    pub health_checks: Vec<(String, String)>,
    pub env_keys: Vec<String>,
    pub secret_like_keys: Vec<String>,
    pub external_dependencies: Vec<ExternalDependency>,
    /// 构建方式候选（描述，不是命令）。
    pub build_candidates: Vec<String>,
    pub start_candidates: Vec<String>,
    pub blockers: Vec<AnalysisFinding>,
    pub unknowns: Vec<AnalysisFinding>,
    pub evidence: Vec<String>,
}

impl ProjectAnalysis {
    /// 从既有识别结果投影出统一分析。
    pub fn from_inspection(inspection: &ArtifactInspection) -> Self {
        let mut analysis = Self {
            project_kind: ProjectKind::Unknown,
            stack: StackSummary {
                language: format!("{:?}", inspection.stack.language).to_lowercase(),
                package_manager: inspection
                    .stack
                    .package_manager
                    .map(|value| format!("{value:?}").to_lowercase()),
                framework: inspection.stack.framework.clone(),
                markers: inspection.stack.markers.clone(),
            },
            services: Vec::new(),
            ports: Vec::new(),
            health_checks: Vec::new(),
            env_keys: Vec::new(),
            secret_like_keys: Vec::new(),
            external_dependencies: Vec::new(),
            build_candidates: Vec::new(),
            start_candidates: Vec::new(),
            blockers: Vec::new(),
            unknowns: Vec::new(),
            evidence: Vec::new(),
        };
        for candidate in &inspection.services {
            analysis.push_service(candidate);
        }
        for dependency in &inspection.dependencies {
            analysis.push_dependency(dependency);
        }
        for check in &inspection.checks {
            analysis.push_check(check);
        }
        for (index, question) in inspection.open_questions.iter().enumerate() {
            analysis.unknowns.push(AnalysisFinding {
                id: format!("q-{}", index + 1),
                message: question.clone(),
                evidence: Vec::new(),
            });
        }
        for step in &inspection.build {
            let label = build_step_label(step);
            if !label.is_empty() && !analysis.build_candidates.contains(&label) {
                analysis.build_candidates.push(label);
            }
        }
        for option in &inspection.start {
            let label = format!("{option:?}");
            if !label.is_empty() && !analysis.start_candidates.contains(&label) {
                analysis.start_candidates.push(label);
            }
        }
        analysis.sort_and_infer();
        analysis
    }

    fn push_service(&mut self, candidate: &ServiceCandidate) {
        let ports: Vec<u16> = candidate
            .ports
            .iter()
            .map(|mapping| mapping.host_port as u16)
            .collect();
        let health: Vec<String> = candidate
            .health
            .iter()
            .map(|item| item.target.clone())
            .collect();
        let env_keys: Vec<String> = candidate.env_keys.clone();
        let secret_like: Vec<String> = env_keys
            .iter()
            .filter(|key| looks_secret_key(key))
            .cloned()
            .collect();
        self.ports
            .extend(ports.iter().map(|port| (candidate.name.clone(), *port)));
        self.health_checks.extend(
            health
                .iter()
                .map(|target| (candidate.name.clone(), target.clone())),
        );
        self.env_keys.extend(env_keys.clone());
        self.secret_like_keys.extend(secret_like.clone());
        self.evidence.extend(candidate.evidence.clone());
        self.services.push(AnalyzedService {
            name: candidate.name.clone(),
            role: format!("{:?}", candidate.role).to_lowercase(),
            service_kind: format!("{:?}", candidate.service_kind).to_lowercase(),
            runtime: Some(format!("{:?}", candidate.runtime).to_lowercase()),
            deploy_path: Some(candidate.source_path.clone()),
            ports,
            health,
            env_keys,
            secret_like_keys: secret_like,
            confidence: candidate.confidence,
            evidence: candidate.evidence.clone(),
        });
    }

    fn push_dependency(&mut self, dependency: &DependencyGuess) {
        self.external_dependencies.push(ExternalDependency {
            name: dependency.name.clone(),
            kind: format!("{:?}", dependency.kind).to_lowercase(),
        });
        self.evidence.push(dependency.evidence.clone());
    }

    fn push_check(&mut self, check: &InspectionCheck) {
        let finding = AnalysisFinding {
            id: check.id.clone(),
            message: check.label.clone(),
            evidence: vec![check.detail.clone()],
        };
        match check.state {
            // 阻塞项 = 真阻塞（不能靠猜补上）。
            InspectionCheckState::Blocked => self.blockers.push(finding),
            // 未确认 = 用明确假设，不阻断流程。
            InspectionCheckState::Unknown => self.unknowns.push(finding),
            InspectionCheckState::Ready => {}
        }
    }

    fn sort_and_infer(&mut self) {
        self.env_keys.sort();
        self.env_keys.dedup();
        self.secret_like_keys.sort();
        self.secret_like_keys.dedup();
        self.evidence.sort();
        self.evidence.dedup();
        self.project_kind = if self.services.len() > 1 {
            ProjectKind::Monorepo
        } else if self.stack.language == "static" {
            ProjectKind::StaticSite
        } else {
            match self.stack.language.as_str() {
                "node" | "php" | "ruby" => ProjectKind::Backend,
                _ => ProjectKind::Unknown,
            }
        };
    }
}

impl ProjectAnalysis {
    /// **唯一**允许进入 AI 提示词的项目侧内容（脱敏 + 限额）。
    pub fn ai_payload(&self) -> serde_json::Value {
        serde_json::json!({
            "project_kind": self.project_kind.as_str(),
            "stack": {
                "language": self.stack.language,
                "package_manager": self.stack.package_manager,
                "framework": self.stack.framework,
                "markers": take(&self.stack.markers, 20),
            },
            "services": self.services.iter().map(|service| serde_json::json!({
                "name": service.name,
                "role": service.role,
                "service_kind": service.service_kind,
                "runtime": service.runtime,
                "ports": service.ports,
                "health_checks": service.health,
                "env_keys": take(&service.env_keys, 40),
                "secret_like_keys": take(&service.secret_like_keys, 20),
                "confidence": service.confidence,
            })).collect::<Vec<_>>(),
            "ports": self.ports,
            "health_checks": self.health_checks,
            "env_keys": take(&self.env_keys, 60),
            "secret_like_keys": take(&self.secret_like_keys, 30),
            "external_dependencies": self.external_dependencies,
            "build_candidates": take(&self.build_candidates, 10),
            "start_candidates": take(&self.start_candidates, 10),
            "blockers": self.blockers,
            "unknowns": self.unknowns.iter().take(20).cloned().collect::<Vec<_>>(),
            "evidence": take(&self.evidence, 30),
        })
    }
}

fn build_step_label(step: &BuildStep) -> String {
    use BuildStep::*;
    match step {
        NpmScript { manager, script } => format!("{manager:?} run {script}"),
        Maven { goals, .. } => format!("maven {}", goals.join(" ")),
        Gradle { tasks, .. } => format!("gradle {}", tasks.join(" ")),
        Cargo { .. } => "cargo build --release".to_string(),
        GoBuild { .. } => "go build".to_string(),
        PythonVenv { .. } => "python venv + requirements".to_string(),
        Composer { script } => format!("composer {}", script.as_deref().unwrap_or("install")),
        DockerBuild { .. } => "docker build".to_string(),
        None => String::new(),
    }
}

fn take(items: &[String], limit: usize) -> Vec<String> {
    items.iter().take(limit).cloned().collect()
}

/// 变量名看起来像密钥？（**只看名字**，永远不看值 —— 值根本不在这里）
pub fn looks_secret_key(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "access_key",
        "private_key",
        "credential",
        "auth",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

// -- 允许发给 AI 的配置片段 --------------------------------------------------

/// 只允许这些**清单类**文件进入提示词（不含 `.env`、私钥、二进制）。
pub const ALLOWED_FRAGMENT_FILES: &[&str] = &[
    "package.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "go.mod",
    "cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "gemfile",
    "composer.json",
    "dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    "nginx.conf",
];

/// 片段字节上限（超出直接拒绝，不做"截断后仍然发送"）。
pub const MAX_FRAGMENT_BYTES: usize = 8 * 1024;

/// 文件名是否在允许清单里（只看 basename，大小写不敏感）。
pub fn is_allowed_fragment(path: &str) -> bool {
    let base = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    ALLOWED_FRAGMENT_FILES.contains(&base.as_str())
}

/// 片段脱敏 + 限额：不合法直接返回 `None`（绝不"截断后照发"）。
///
/// 保留疑似密钥的**键名**（模型需要知道要配什么），抹掉其值。
pub fn sanitize_fragment(path: &str, content: &str) -> Option<String> {
    if !is_allowed_fragment(path) || content.len() > MAX_FRAGMENT_BYTES {
        return None;
    }
    let mut out = String::with_capacity(content.len());
    for line in content.lines() {
        let lower = line.to_ascii_lowercase();
        let value_part = line
            .split_once(['=', ':'])
            .map(|(_, value)| value.trim())
            .unwrap_or("");
        // `postgres://user:pass@host/db` 这类连接串同样是凭据（键名未必敏感）。
        let credentialish = value_part.contains("://")
            && value_part.contains('@')
            && value_part.chars().any(|ch| ch == ':');
        let secretish = credentialish
            || [
                "password",
                "passwd",
                "secret",
                "token",
                "api_key",
                "apikey",
                "private_key",
            ]
            .iter()
            .any(|needle| lower.contains(needle));
        if secretish {
            let key = line.split(['=', ':']).next().unwrap_or("key").trim();
            out.push_str(key);
            out.push_str("=<redacted>\n");
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analysis() -> ProjectAnalysis {
        ProjectAnalysis {
            project_kind: ProjectKind::Backend,
            stack: StackSummary {
                language: "node".to_string(),
                package_manager: Some("npm".to_string()),
                framework: Some("next".to_string()),
                markers: vec!["package.json".to_string()],
            },
            services: vec![AnalyzedService {
                name: "api".to_string(),
                role: "backend".to_string(),
                service_kind: "node_process".to_string(),
                runtime: Some("node_process".to_string()),
                deploy_path: Some("apps/api".to_string()),
                ports: vec![3000],
                health: vec!["/healthz".to_string()],
                env_keys: vec!["DATABASE_URL".to_string()],
                secret_like_keys: vec!["DATABASE_URL".to_string()],
                confidence: 80,
                evidence: vec!["apps/api/package.json".to_string()],
            }],
            ports: vec![("api".to_string(), 3000)],
            health_checks: vec![("api".to_string(), "/healthz".to_string())],
            env_keys: vec!["DATABASE_URL".to_string()],
            secret_like_keys: vec!["DATABASE_URL".to_string()],
            external_dependencies: vec![],
            build_candidates: vec!["Npm run build".to_string()],
            start_candidates: vec!["StartOption { command: None }".to_string()],
            blockers: vec![],
            unknowns: vec![],
            evidence: vec!["apps/api/package.json".to_string()],
        }
    }

    #[test]
    fn the_ai_payload_only_carries_names_and_never_values() {
        let payload = analysis().ai_payload();
        let text = payload.to_string();
        // 只有名字。
        assert!(text.contains("DATABASE_URL"));
        assert!(!text.contains("postgres://"));
        assert!(payload["services"][0]["secret_like_keys"]
            .as_array()
            .is_some_and(|keys| keys.iter().any(|key| key == "DATABASE_URL")));
    }

    #[test]
    fn only_manifest_files_may_be_sent_as_fragments() {
        assert!(is_allowed_fragment("apps/api/package.json"));
        assert!(is_allowed_fragment("deploy/Dockerfile"));
        assert!(is_allowed_fragment("nginx.conf"));
        // 明确禁止的一类。
        for hostile in [
            ".env",
            "config/.env.production",
            "id_rsa",
            "server.pem",
            "apps/api/index.js",
            "dist/bundle.js",
        ] {
            assert!(!is_allowed_fragment(hostile), "{hostile} 不该被允许");
            assert_eq!(sanitize_fragment(hostile, "x = 1"), None);
        }
    }

    #[test]
    fn fragment_values_that_look_like_secrets_are_redacted() {
        let fragment = "DATABASE_URL=postgres://user:pw@host/db\nPORT=3000\nAPI_KEY=sk-abcdef\n";
        let clean = sanitize_fragment("docker-compose.yml", fragment).expect("允许清单文件");
        assert!(clean.contains("PORT=3000"), "普通配置保留：{clean}");
        assert!(clean.contains("DATABASE_URL=<redacted>"), "{clean}");
        assert!(clean.contains("API_KEY=<redacted>"), "{clean}");
        assert!(!clean.contains("postgres://"), "{clean}");
        assert!(!clean.contains("sk-abcdef"), "{clean}");
    }

    #[test]
    fn oversized_fragments_are_refused_instead_of_truncated() {
        let huge = "A".repeat(MAX_FRAGMENT_BYTES + 1);
        assert_eq!(sanitize_fragment("package.json", &huge), None);
    }
}
