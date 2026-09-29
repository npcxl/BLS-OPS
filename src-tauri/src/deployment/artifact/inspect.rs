//! 技术栈 / 构建 / 启动 / 端口 / 健康检查 / 环境变量名 / 依赖 / **多服务候选**识别。
//!
//! # 输入输出
//!
//! 输入是 [`ContentSource`]（本地目录 / ZIP / TAR / 单文件 —— 三种来源共用同一套
//! 识别逻辑），输出是 [`ArtifactInspection`]。
//!
//! # 五条纪律
//!
//! 1. **只给结构化建议**：`BuildStep` / `StartOption` 是判别枚举，字段只有脚本名、
//!    目标名、入口路径这类受校验的短标识。**没有任何字段能装下一条命令行。**
//! 2. **相对路径以 `/` 开头占位**：识别时还不知道服务器上的部署根目录，
//!    `StaticNginx { root }` 这类绝对路径字段用 `/相对目录` 占位（`/dist`），
//!    并写进 `open_questions` 让用户确认。落库前仍会被
//!    `validate::validate_under_root` 挡一道。
//! 3. **猜出来的一定标**：`confidence` 只用证据算，不做"感觉很准"；
//!    证据不足时对应检查项落 `Unknown`，绝不默认 `Ready`。
//! 4. **环境变量只有名字**：值永远不进模型 —— 这里连字段都没有。
//! 5. **尽力而为**：缺一个文件不该让整次识别失败，缺什么如实写进检查项。

use std::collections::{BTreeMap, BTreeSet};

use super::limits;
use super::model::{
    ArtifactInspection, BuildStep, DependencyGuess, DependencyKind, EnvKeyGuess, HealthGuess,
    HealthKind, InspectionCheck, Language, PackageManager, PortGuess, ServiceCandidate,
    StackProfile, StartOption,
};
use super::secrets::secret_like_key;
use super::source::{decode_text, ContentSource, SourceEntry};
use crate::deployment::model::{
    ArtifactKind, ArtifactSourceKind, PortMapping, PortProtocol, ServiceKind, ServiceRole,
    ServiceRuntime,
};
use crate::project_readiness::CheckState;

/// 需要读内容的小清单文件（识别全靠它们）。
const WANTED_NAMES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "go.mod",
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    "manage.py",
    "composer.json",
    "Gemfile",
    "Cargo.toml",
    "Procfile",
    "dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    "nginx.conf",
    "application.properties",
    "application.yml",
    "application.yaml",
];

/// 一致性检查用的固定条目（id 稳定，前端按 id 排布）。
const CHECK_RUNTIME: &str = "runtime";
const CHECK_ENTRY: &str = "entry";
const CHECK_PORT: &str = "port";
const CHECK_ENV: &str = "env";
const CHECK_SECRETS: &str = "secrets";
const CHECK_COVERAGE: &str = "coverage";

/// 识别入口。
pub fn inspect(
    source: &dyn ContentSource,
    artifact_kind: ArtifactKind,
    source_kind: ArtifactSourceKind,
    display_name: &str,
    now: i64,
    scan_truncated: bool,
) -> ArtifactInspection {
    let texts = load_texts(source);
    let view = View {
        entries: source.entries(),
        texts,
    };

    let stack = detect_stack(&view);
    let mut services = Vec::new();
    for root in candidate_roots(&view) {
        services.extend(candidates_in_root(&view, &root, display_name));
    }
    if services.is_empty() {
        services.push(fallback_candidate(&view, artifact_kind, display_name));
    }
    dedupe_candidates(&mut services);
    services.truncate(limits::MAX_SERVICE_CANDIDATES);
    for (position, candidate) in services.iter_mut().enumerate() {
        if candidate.id.is_empty() {
            candidate.id = format!("candidate-{}", position + 1);
        }
    }

    let build = detect_build(&view, &stack);
    let start: Vec<StartOption> = services.iter().map(start_option_of).collect();
    let ports = collect_ports(&services);
    let health: Vec<HealthGuess> = services
        .iter()
        .flat_map(|candidate| candidate.health.clone())
        .collect();
    let env_keys = collect_env_keys(&view, &services);
    let dependencies = detect_dependencies(&view);

    let truncated = scan_truncated || services.len() >= limits::MAX_SERVICE_CANDIDATES;
    let open_questions = open_questions(&view, &services, artifact_kind);
    let checks = build_checks(&view, &services, truncated, scan_truncated);

    ArtifactInspection {
        artifact_kind,
        source_kind,
        stack,
        build,
        start,
        ports,
        health,
        env_keys,
        dependencies,
        services,
        checks,
        open_questions,
        files_seen: view.entries.len() as u64,
        truncated,
        inspected_at: now,
    }
}

// -- 只读视图 ---------------------------------------------------------------

/// 清单 + 少量文本内容。识别代码只依赖它，因此三种来源行为一致。
struct View<'a> {
    entries: &'a [SourceEntry],
    texts: BTreeMap<String, String>,
}

impl<'a> View<'a> {
    fn text(&self, path: &str) -> Option<&str> {
        self.texts.get(path).map(String::as_str)
    }

    fn has(&self, path: &str) -> bool {
        self.entries.iter().any(|entry| entry.path == path)
    }

    /// 某目录下（`root` 为空 = 清单根）名字匹配的第一个条目。
    fn under(&self, root: &str, name: &str) -> Option<&'a SourceEntry> {
        let lower = name.to_ascii_lowercase();
        self.entries.iter().find(|entry| {
            parent_of(&entry.path) == root && entry.lower_name() == lower && !entry.is_dir
        })
    }

    fn text_under(&self, root: &str, name: &str) -> Option<(&'a str, &str)> {
        let entry = self.under(root, name)?;
        let text = self.text(&entry.path)?;
        Some((entry.path.as_str(), text))
    }

    /// 某子树下第一个扩展名匹配的文件（递归：`target/release/app.jar` 也算）。
    fn first_with_extension(&self, root: &str, extension: &str) -> Option<&'a SourceEntry> {
        self.entries.iter().find(|entry| {
            !entry.is_dir
                && under_root(&entry.path, root)
                && entry.path.to_ascii_lowercase().ends_with(extension)
        })
    }

    /// 某子树下的所有文件（递归、按路径排序，浅的在前）。
    fn files_in(&self, root: &str) -> Vec<&'a SourceEntry> {
        let mut files: Vec<&SourceEntry> = self
            .entries
            .iter()
            .filter(|entry| !entry.is_dir && under_root(&entry.path, root))
            .collect();
        files.sort_by(|left, right| left.path.cmp(&right.path));
        files
    }
}

/// `path` 是否位于 `root` 之下（`root` 为空 = 整个清单）。
fn under_root(path: &str, root: &str) -> bool {
    if root.is_empty() {
        return true;
    }
    path.starts_with(&format!("{root}/"))
}

fn parent_of(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some((parent, _)) => parent,
        None => "",
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn leaf(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

/// 读一小批清单文件的内容（有文件数与单文件上限）。
fn load_texts(source: &dyn ContentSource) -> BTreeMap<String, String> {
    let mut wanted: Vec<String> = Vec::new();
    for entry in source.entries() {
        if entry.is_dir || wanted.len() >= limits::MAX_INSPECT_FILES {
            continue;
        }
        if entry.size as usize > limits::MAX_INSPECT_BYTES_PER_FILE {
            continue;
        }
        if !is_wanted_name(&entry.path) {
            continue;
        }
        wanted.push(entry.path.clone());
    }
    let mut texts = BTreeMap::new();
    for (path, bytes) in source.read_many(&wanted, limits::MAX_INSPECT_BYTES_PER_FILE) {
        if let Some(text) = decode_text(&bytes) {
            texts.insert(path, text);
        }
    }
    texts
}

fn is_wanted_name(path: &str) -> bool {
    let lower = basename(path).to_ascii_lowercase();
    if lower == ".env" || lower.starts_with(".env") {
        return true;
    }
    if lower.starts_with("dockerfile") || lower.starts_with("docker-compose") {
        return true;
    }
    if lower.starts_with("compose.") || lower.starts_with("compose-") {
        return true;
    }
    if lower.starts_with("application.") {
        return true;
    }
    WANTED_NAMES.contains(&lower.as_str())
}

// -- 技术栈 -----------------------------------------------------------------

fn detect_stack(view: &View<'_>) -> StackProfile {
    let mut markers: Vec<String> = Vec::new();
    let mut language = Language::Unknown;
    let mut package_manager = None;
    let mut framework = None;

    if view
        .entries
        .iter()
        .any(|entry| entry.path == "package.json")
        || view
            .entries
            .iter()
            .any(|entry| entry.lower_name() == "package.json")
    {
        language = Language::Node;
        markers.push("package.json".to_string());
        if view.has("pnpm-lock.yaml") {
            package_manager = Some(PackageManager::Pnpm);
            markers.push("pnpm-lock.yaml".to_string());
        } else if view.has("yarn.lock") {
            package_manager = Some(PackageManager::Yarn);
            markers.push("yarn.lock".to_string());
        } else {
            package_manager = Some(PackageManager::Npm);
        }
        if let Some((_, text)) = view.text_under("", "package.json") {
            framework = node_framework(text);
        }
    } else if let Some(entry) = view
        .entries
        .iter()
        .find(|entry| entry.lower_name() == "pom.xml")
    {
        language = Language::Java;
        package_manager = Some(PackageManager::Maven);
        markers.push(entry.path.clone());
        if let Some(text) = view.text(&entry.path) {
            if text.contains("spring-boot") || text.contains("springframework") {
                framework = Some("spring-boot".to_string());
            }
        }
    } else if let Some(entry) = view
        .entries
        .iter()
        .find(|entry| entry.lower_name().starts_with("build.gradle"))
    {
        language = Language::Java;
        package_manager = Some(PackageManager::Gradle);
        markers.push(entry.path.clone());
    } else if let Some(entry) = view
        .entries
        .iter()
        .find(|entry| entry.lower_name() == "go.mod")
    {
        language = Language::Go;
        markers.push(entry.path.clone());
    } else if let Some(entry) = view.entries.iter().find(|entry| {
        matches!(
            entry.lower_name().as_str(),
            "requirements.txt" | "pyproject.toml" | "manage.py"
        )
    }) {
        language = Language::Python;
        package_manager = Some(if entry.lower_name() == "pyproject.toml" {
            PackageManager::Poetry
        } else {
            PackageManager::Pip
        });
        markers.push(entry.path.clone());
    } else if let Some(entry) = view
        .entries
        .iter()
        .find(|entry| entry.lower_name() == "cargo.toml")
    {
        language = Language::Rust;
        package_manager = Some(PackageManager::Cargo);
        markers.push(entry.path.clone());
    } else if let Some(entry) = view
        .entries
        .iter()
        .find(|entry| matches!(entry.lower_name().as_str(), "composer.json"))
    {
        language = Language::Php;
        package_manager = Some(PackageManager::Composer);
        markers.push(entry.path.clone());
    } else if let Some(entry) = view
        .entries
        .iter()
        .find(|entry| entry.lower_name() == "gemfile")
    {
        language = Language::Ruby;
        package_manager = Some(PackageManager::Bundler);
        markers.push(entry.path.clone());
    } else if let Some(entry) = view
        .entries
        .iter()
        .find(|entry| entry.lower_path().ends_with(".csproj"))
    {
        language = Language::Dotnet;
        package_manager = Some(PackageManager::Nuget);
        markers.push(entry.path.clone());
    } else if has_static_assets(view) {
        language = Language::Static;
    }

    StackProfile {
        language,
        package_manager,
        framework,
        markers,
    }
}

/// 从 `package.json` 里读"决定产物形态"的那个名字。
///
/// 既可能是框架（`next` / `vue`），也可能是打包器（`vite`）—— 对"这个 dist
/// 是怎么来的"这个问题，两者都是答案，所以放在同一个字段里，UI 按字符串展示。
fn node_framework(text: &str) -> Option<String> {
    for (needle, name) in [
        ("\"next\"", "next"),
        ("\"nuxt\"", "nuxt"),
        ("\"@nestjs/core\"", "nestjs"),
        ("\"vite\"", "vite"),
        ("\"vue\"", "vue"),
        ("\"react\"", "react"),
        ("\"express\"", "express"),
        ("\"koa\"", "koa"),
        ("\"fastify\"", "fastify"),
    ] {
        if text.contains(needle) {
            return Some(name.to_string());
        }
    }
    None
}

fn has_static_assets(view: &View<'_>) -> bool {
    view.entries
        .iter()
        .any(|entry| entry.lower_name() == "index.html")
}

// -- 候选根 -----------------------------------------------------------------

/// 项目根：**所有直接含项目标记的目录**，去掉被更浅的根包含的那些。
///
/// 这样 monorepo（`apps/web/package.json` + `apps/api/pom.xml`）会得到两个根、
/// 两个服务候选，而不会退化成"整包一个服务"。空串（包根）不遮蔽任何子目录 ——
/// 一个仓库同时有根 `package.json` 与子包是很常见的。
fn candidate_roots(view: &View<'_>) -> Vec<String> {
    let mut roots: BTreeSet<String> = BTreeSet::new();
    for entry in view.entries {
        if entry.is_dir || !is_marker_name(&entry.path) {
            continue;
        }
        roots.insert(parent_of(&entry.path).to_string());
    }
    let candidates: Vec<String> = roots.iter().cloned().collect();
    let mut kept: Vec<String> = Vec::new();
    for root in candidates {
        let nested_inside = kept
            .iter()
            .any(|other| root.starts_with(&format!("{other}/")));
        if !nested_inside {
            kept.push(root);
        }
    }
    if kept.is_empty() {
        kept.push(String::new());
    }
    kept
}

/// 哪些文件名算"这里是一个项目"。
fn is_marker_name(path: &str) -> bool {
    let lower = basename(path).to_ascii_lowercase();
    if lower.ends_with(".jar") {
        return true;
    }
    if lower.starts_with("dockerfile") || lower.starts_with("compose") {
        return true;
    }
    matches!(
        lower.as_str(),
        "package.json"
            | "pom.xml"
            | "build.gradle"
            | "build.gradle.kts"
            | "go.mod"
            | "requirements.txt"
            | "pyproject.toml"
            | "manage.py"
            | "composer.json"
            | "gemfile"
            | "cargo.toml"
            | "index.html"
    )
}

fn candidates_in_root(view: &View<'_>, root: &str, display_name: &str) -> Vec<ServiceCandidate> {
    let base = sanitize_name(&leaf(display_name));
    let prefix = if root.is_empty() {
        base.clone()
    } else {
        sanitize_name(&format!("{base}-{root}"))
    };
    let mut out = Vec::new();

    // 1) Docker Compose：一个 compose 文件的每个 service 各成一个候选。
    let compose = [
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
    ]
    .iter()
    .find_map(|name| view.under(root, name));
    if let Some(entry) = compose {
        let text = view.text(&entry.path).unwrap_or("");
        let parsed = parse_compose(text);
        if !parsed.services.is_empty() {
            let project = sanitize_name(&if root.is_empty() {
                base.clone()
            } else {
                root.to_string()
            });
            for service in &parsed.services {
                let external = service.external_kind.is_some();
                let role = role_for(&service.name, service.image.as_deref(), external);
                let runtime = if let Some((_, port)) = service.external_kind {
                    ServiceRuntime::External {
                        endpoint: format!("{}:{}", sanitize_name(&service.name), port),
                    }
                } else {
                    ServiceRuntime::DockerCompose {
                        compose_path: format!("/{}", entry.path),
                        project_name: project.clone(),
                        service: service.name.clone(),
                    }
                };
                out.push(ServiceCandidate {
                    id: format!("{}/{}/{}", entry.path, project, service.name),
                    name: sanitize_name(&format!("{project}-{}", service.name)),
                    role,
                    service_kind: if external {
                        ServiceKind::ExternalManaged
                    } else {
                        ServiceKind::DockerCompose
                    },
                    runtime,
                    artifact_kind: ArtifactKind::ComposeFile,
                    source_path: root.to_string(),
                    ports: service
                        .ports
                        .iter()
                        .map(|port| PortMapping {
                            host_port: port.0,
                            container_port: port.1,
                            protocol: PortProtocol::Tcp,
                        })
                        .collect(),
                    env_keys: service.env_keys.clone(),
                    dependencies: service.depends_on.clone(),
                    health: Vec::new(),
                    confidence: if external { 90 } else { 95 },
                    evidence: vec![entry.path.clone()],
                    selected_by_default: !external,
                });
            }
            return out;
        }
    }

    // 2) JAR。
    if let Some(entry) = view.first_with_extension(root, ".jar") {
        out.push(ServiceCandidate {
            id: entry.path.clone(),
            name: sanitize_name(&format!("{prefix}-app")),
            role: ServiceRole::Api,
            service_kind: ServiceKind::JavaJar,
            runtime: ServiceRuntime::NativeProcess {
                entry: format!("/{}", entry.path),
                args: Vec::new(),
            },
            artifact_kind: ArtifactKind::Jar,
            source_path: root.to_string(),
            ports: vec![PortMapping {
                host_port: 8080,
                container_port: 8080,
                protocol: PortProtocol::Tcp,
            }],
            env_keys: Vec::new(),
            dependencies: Vec::new(),
            health: vec![HealthGuess {
                kind: HealthKind::Http,
                target: "/actuator/health".to_string(),
                evidence: format!("{}（Spring Boot 惯用）", entry.path),
            }],
            confidence: 80,
            evidence: vec![entry.path.clone()],
            selected_by_default: true,
        });
        return out;
    }

    // 3) 静态站点（含 dist / build / out / public）。
    if let Some((html, static_root, is_build)) = static_site(view, root) {
        let mut build_evidence = vec![html.clone()];
        if is_build {
            if let Some(marker) = view
                .entries
                .iter()
                .find(|entry| entry.lower_name() == "package.json")
            {
                build_evidence.push(marker.path.clone());
            }
        }
        out.push(ServiceCandidate {
            id: format!("{static_root}/index.html"),
            name: sanitize_name(&format!("{prefix}-web")),
            role: ServiceRole::Static,
            service_kind: ServiceKind::StaticNginx,
            runtime: ServiceRuntime::StaticNginx {
                site_name: sanitize_name(&format!("{prefix}-web")),
                root: format!("/{static_root}"),
            },
            artifact_kind: if is_build {
                ArtifactKind::Dist
            } else {
                ArtifactKind::Folder
            },
            source_path: static_root.clone(),
            ports: vec![PortMapping {
                host_port: 80,
                container_port: 80,
                protocol: PortProtocol::Tcp,
            }],
            env_keys: Vec::new(),
            dependencies: Vec::new(),
            health: vec![HealthGuess {
                kind: HealthKind::Http,
                target: "/".to_string(),
                evidence: html.clone(),
            }],
            confidence: 90,
            evidence: build_evidence,
            selected_by_default: true,
        });
        return out;
    }

    // 4) Node。
    if let Some((path, text)) = view.text_under(root, "package.json") {
        let scripts = json_script_names(text);
        let has_start = scripts.iter().any(|name| name == "start");
        out.push(ServiceCandidate {
            id: path.to_string(),
            name: sanitize_name(&format!("{prefix}-api")),
            role: ServiceRole::Api,
            service_kind: ServiceKind::NodeProcess,
            runtime: ServiceRuntime::NativeProcess {
                entry: "node".to_string(),
                args: Vec::new(),
            },
            artifact_kind: ArtifactKind::Folder,
            source_path: root.to_string(),
            ports: vec![PortMapping {
                host_port: 3000,
                container_port: 3000,
                protocol: PortProtocol::Tcp,
            }],
            env_keys: Vec::new(),
            dependencies: Vec::new(),
            health: vec![HealthGuess {
                kind: HealthKind::Tcp,
                target: "3000".to_string(),
                evidence: "Node 默认端口（请确认）".to_string(),
            }],
            confidence: if has_start { 75 } else { 60 },
            evidence: vec![path.to_string()],
            selected_by_default: true,
        });
        return out;
    }

    // 5) Python。
    if let Some((path, _)) = ["requirements.txt", "pyproject.toml", "manage.py"]
        .iter()
        .find_map(|name| view.text_under(root, name))
    {
        out.push(ServiceCandidate {
            id: path.to_string(),
            name: sanitize_name(&format!("{prefix}-app")),
            role: ServiceRole::Api,
            service_kind: ServiceKind::PythonVenv,
            runtime: ServiceRuntime::NativeProcess {
                entry: "python3".to_string(),
                args: Vec::new(),
            },
            artifact_kind: ArtifactKind::Folder,
            source_path: root.to_string(),
            ports: vec![PortMapping {
                host_port: 8000,
                container_port: 8000,
                protocol: PortProtocol::Tcp,
            }],
            env_keys: Vec::new(),
            dependencies: Vec::new(),
            health: vec![HealthGuess {
                kind: HealthKind::Tcp,
                target: "8000".to_string(),
                evidence: "Python/WSGI 惯用端口（请确认）".to_string(),
            }],
            confidence: 65,
            evidence: vec![path.to_string()],
            selected_by_default: true,
        });
        return out;
    }

    // 6) 只有 Dockerfile：交给镜像构建。**必须排在"原生二进制"前面** ——
    //    `Dockerfile` 本身没有扩展名，否则会被误判成一个可执行文件。
    if let Some((path, text)) = view.text_under(root, "Dockerfile") {
        let name = sanitize_name(&format!("{prefix}-app"));
        out.push(ServiceCandidate {
            id: path.to_string(),
            name: name.clone(),
            role: ServiceRole::Api,
            service_kind: ServiceKind::DockerImage,
            runtime: ServiceRuntime::DockerImage {
                image: name.clone(),
                tag: "latest".to_string(),
                container_name: name,
                ports: Vec::new(),
            },
            artifact_kind: ArtifactKind::Dockerfile,
            source_path: root.to_string(),
            ports: dockerfile_expose(text)
                .into_iter()
                .map(|port| PortMapping {
                    host_port: port,
                    container_port: port,
                    protocol: PortProtocol::Tcp,
                })
                .collect(),
            env_keys: Vec::new(),
            dependencies: Vec::new(),
            health: Vec::new(),
            confidence: 85,
            evidence: vec![path.to_string()],
            selected_by_default: true,
        });
        return out;
    }

    // 7) 原生二进制（无扩展名、不带清单语义的文件）。
    if let Some(entry) = view.files_in(root).into_iter().find(|entry| {
        !entry.lower_name().contains('.')
            && entry.size > 0
            && !is_wanted_name(&entry.path)
            && !is_marker_name(&entry.path)
    }) {
        out.push(ServiceCandidate {
            id: entry.path.clone(),
            name: sanitize_name(&format!("{prefix}-app")),
            role: ServiceRole::Api,
            service_kind: ServiceKind::NativeBinary,
            runtime: ServiceRuntime::NativeProcess {
                entry: format!("/{}", entry.path),
                args: Vec::new(),
            },
            artifact_kind: ArtifactKind::Binary,
            source_path: root.to_string(),
            ports: Vec::new(),
            env_keys: Vec::new(),
            dependencies: Vec::new(),
            health: Vec::new(),
            confidence: 55,
            evidence: vec![entry.path.clone()],
            selected_by_default: true,
        });
        return out;
    }

    out
}

fn static_site(view: &View<'_>, root: &str) -> Option<(String, String, bool)> {
    for dir in ["", "dist", "build", "out", "public", "www"] {
        let candidate = match (root.is_empty(), dir.is_empty()) {
            (_, true) => root.to_string(),
            (true, false) => dir.to_string(),
            (false, false) => format!("{root}/{dir}"),
        };
        if let Some(entry) = view
            .entries
            .iter()
            .find(|entry| parent_of(&entry.path) == candidate && entry.lower_name() == "index.html")
        {
            return Some((entry.path.clone(), candidate, !dir.is_empty()));
        }
    }
    None
}

fn fallback_candidate(
    _view: &View<'_>,
    artifact_kind: ArtifactKind,
    display_name: &str,
) -> ServiceCandidate {
    let name = sanitize_name(&leaf(display_name));
    ServiceCandidate {
        id: "candidate-fallback".to_string(),
        name: name.clone(),
        role: ServiceRole::Other,
        service_kind: ServiceKind::NativeBinary,
        runtime: ServiceRuntime::NativeProcess {
            entry: format!("/{name}"),
            args: Vec::new(),
        },
        artifact_kind,
        source_path: String::new(),
        ports: Vec::new(),
        env_keys: Vec::new(),
        dependencies: Vec::new(),
        health: Vec::new(),
        confidence: 10,
        evidence: Vec::new(),
        selected_by_default: false,
    }
}

fn dedupe_candidates(candidates: &mut Vec<ServiceCandidate>) {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    candidates.retain(|candidate| seen.insert(candidate.name.clone()));
}

fn start_option_of(candidate: &ServiceCandidate) -> StartOption {
    match &candidate.runtime {
        ServiceRuntime::StaticNginx { root, .. } => StartOption::NginxSite {
            site_name: candidate.name.clone(),
            root: root.clone(),
        },
        ServiceRuntime::SystemdUnit { unit } => StartOption::SystemdUnit { unit: unit.clone() },
        ServiceRuntime::DockerImage {
            image, tag, ports, ..
        } => StartOption::DockerImage {
            image: image.clone(),
            tag: tag.clone(),
            ports: ports.clone(),
        },
        ServiceRuntime::DockerCompose {
            compose_path,
            project_name,
            service,
        } => StartOption::DockerCompose {
            compose_path: compose_path.clone(),
            project_hint: project_name.clone(),
            services: vec![service.clone()],
        },
        ServiceRuntime::NativeProcess { entry, .. } => match candidate.service_kind {
            ServiceKind::JavaJar => StartOption::Jar { jar: entry.clone() },
            ServiceKind::NodeProcess => StartOption::Node {
                entry: entry.clone(),
                manager: PackageManager::Npm,
            },
            ServiceKind::PythonVenv => StartOption::Python {
                entry: entry.clone(),
                module: false,
            },
            _ => StartOption::Binary {
                entry: entry.clone(),
            },
        },
        ServiceRuntime::External { endpoint } => StartOption::External {
            endpoint_hint: endpoint.clone(),
        },
    }
}

// -- 构建 / 端口 / 环境变量 / 依赖 ------------------------------------------

fn detect_build(view: &View<'_>, stack: &StackProfile) -> Vec<BuildStep> {
    let mut steps = Vec::new();

    if let Some(entry) = view
        .entries
        .iter()
        .find(|entry| entry.lower_name() == "package.json")
    {
        if let Some(text) = view.text(&entry.path) {
            // 只认脚本**名**：`build` / `compile` 都能产出可部署产物。
            if let Some(script) = json_script_names(text)
                .into_iter()
                .find(|name| name == "build" || name == "compile")
            {
                steps.push(BuildStep::NpmScript {
                    manager: stack.package_manager.unwrap_or(PackageManager::Npm),
                    script,
                });
            }
        }
    }
    if view
        .entries
        .iter()
        .any(|entry| entry.lower_name() == "pom.xml")
    {
        steps.push(BuildStep::Maven {
            goals: vec!["package".to_string()],
            wrapper: view
                .entries
                .iter()
                .any(|entry| entry.lower_name() == "mvnw"),
        });
    }
    if view
        .entries
        .iter()
        .any(|entry| entry.lower_name().starts_with("build.gradle"))
    {
        steps.push(BuildStep::Gradle {
            tasks: vec!["build".to_string()],
            wrapper: view
                .entries
                .iter()
                .any(|entry| entry.lower_name() == "gradlew"),
        });
    }
    if view
        .entries
        .iter()
        .any(|entry| entry.lower_name() == "cargo.toml")
    {
        steps.push(BuildStep::Cargo {
            release: true,
            target: None,
        });
    }
    if view
        .entries
        .iter()
        .any(|entry| entry.lower_name() == "go.mod")
    {
        steps.push(BuildStep::GoBuild {
            package: "./...".to_string(),
            output: None,
        });
    }
    if let Some(entry) = view
        .entries
        .iter()
        .find(|entry| entry.lower_name() == "requirements.txt")
    {
        steps.push(BuildStep::PythonVenv {
            requirements: entry.path.clone(),
        });
    }
    if let Some((path, _)) = view.text_under("", "Dockerfile") {
        steps.push(BuildStep::DockerBuild {
            dockerfile: path.to_string(),
            context: parent_of(path).to_string(),
        });
    }

    if steps.is_empty() {
        steps.push(BuildStep::None);
    }
    steps
}

fn collect_ports(candidates: &[ServiceCandidate]) -> Vec<PortGuess> {
    let mut out: Vec<PortGuess> = Vec::new();
    for candidate in candidates {
        for mapping in &candidate.ports {
            if out.iter().any(|guess| guess.port == mapping.host_port) {
                continue;
            }
            out.push(PortGuess {
                port: mapping.host_port,
                protocol: "tcp".to_string(),
                evidence: format!("来自服务候选 {}（请确认）", candidate.name),
            });
        }
    }
    out
}

fn collect_env_keys(view: &View<'_>, candidates: &[ServiceCandidate]) -> Vec<EnvKeyGuess> {
    let mut out: Vec<EnvKeyGuess> = Vec::new();
    let mut push = |key: &str, evidence: String| {
        if key.is_empty() || out.iter().any(|guess| guess.key == key) {
            return;
        }
        out.push(EnvKeyGuess {
            key: key.to_string(),
            required: false,
            secret_like: secret_like_key(key),
            evidence,
        });
    };

    // 1) `.env` 文件里的键名（只有名字，值不读）。
    for (path, text) in &view.texts {
        let lower = basename(path).to_ascii_lowercase();
        if !(lower == ".env" || lower.starts_with(".env")) {
            continue;
        }
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, _)) = line.split_once('=') {
                let key = key.trim().trim_start_matches("export ").trim();
                if is_env_key(key) {
                    push(key, path.clone());
                }
            }
        }
    }

    // 2) compose / 配置里的 `${VAR}`。
    for (path, text) in &view.texts {
        let mut rest = text.as_str();
        while let Some(position) = rest.find("${") {
            rest = &rest[position + 2..];
            let end = rest.find('}').unwrap_or(rest.len());
            let key = &rest[..end];
            if is_env_key(key) {
                push(key, path.clone());
            }
        }
    }

    // 3) 候选自身的 env_keys。
    for candidate in candidates {
        for key in &candidate.env_keys {
            if is_env_key(key) {
                push(key, format!("docker-compose（{}）", candidate.name));
            }
        }
    }

    out.truncate(64);
    out
}

fn is_env_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.starts_with(|ch: char| ch.is_ascii_alphabetic() || ch == '_')
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn detect_dependencies(view: &View<'_>) -> Vec<DependencyGuess> {
    let mut out: Vec<DependencyGuess> = Vec::new();
    let mut push = |name: &str, kind: DependencyKind, evidence: String| {
        if out.iter().any(|guess| guess.name == name) {
            return;
        }
        out.push(DependencyGuess {
            name: name.to_string(),
            kind,
            evidence,
        });
    };

    for entry in view.entries {
        let lower = entry.lower_path();
        let name = entry.lower_name();
        if !name.starts_with(".env") && !lower.contains(".env") {
            continue;
        }
        let Some(text) = view.text(&entry.path) else {
            continue;
        };
        for (needle, dependency, kind) in [
            ("postgres", "postgresql", DependencyKind::Database),
            ("mysql", "mysql", DependencyKind::Database),
            ("mongodb", "mongodb", DependencyKind::Database),
            ("redis", "redis", DependencyKind::Cache),
            ("rabbitmq", "rabbitmq", DependencyKind::Queue),
            ("kafka", "kafka", DependencyKind::Queue),
            ("elasticsearch", "elasticsearch", DependencyKind::Search),
            ("s3", "object-storage", DependencyKind::ObjectStorage),
            ("smtp", "smtp", DependencyKind::Mail),
        ] {
            if text.to_ascii_lowercase().contains(needle) {
                push(dependency, kind, entry.path.clone());
            }
        }
    }

    for (path, text) in &view.texts {
        let lower = basename(path).to_ascii_lowercase();
        if !lower.starts_with("docker-compose") && !lower.starts_with("compose") {
            continue;
        }
        let parsed = parse_compose(text);
        for service in &parsed.services {
            if let Some((description, _)) = service.external_kind {
                let kind = match description {
                    "database" => DependencyKind::Database,
                    "cache" => DependencyKind::Cache,
                    "message broker" => DependencyKind::Queue,
                    _ => DependencyKind::Other,
                };
                push(&service.name, kind, path.clone());
            }
        }
    }

    out
}

// -- 检查项 -----------------------------------------------------------------

fn build_checks(
    view: &View<'_>,
    services: &[ServiceCandidate],
    truncated: bool,
    scan_truncated: bool,
) -> Vec<InspectionCheck> {
    let mut checks = Vec::new();

    let low_confidence: Vec<&ServiceCandidate> = services
        .iter()
        .filter(|service| service.confidence < 70)
        .collect();
    checks.push(InspectionCheck {
        id: CHECK_RUNTIME.to_string(),
        label: "Runtime recognised".to_string(),
        state: if low_confidence.len() == services.len() && !services.is_empty() {
            CheckState::Unknown
        } else if low_confidence.is_empty() {
            CheckState::Ready
        } else {
            CheckState::Unknown
        },
        detail: if low_confidence.is_empty() {
            format!(
                "{} runtime candidate(s) with clear evidence.",
                services.len()
            )
        } else {
            format!(
                "{} of {} runtime candidate(s) need confirmation: {}",
                low_confidence.len(),
                services.len(),
                low_confidence
                    .iter()
                    .map(|service| service.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        },
    });

    let has_entry = services.iter().any(|service| match &service.runtime {
        ServiceRuntime::DockerCompose { .. } => true,
        ServiceRuntime::External { .. } => true,
        ServiceRuntime::StaticNginx { .. } => true,
        ServiceRuntime::SystemdUnit { .. } => true,
        ServiceRuntime::DockerImage { .. } => true,
        ServiceRuntime::NativeProcess { entry, .. } => !entry.trim().is_empty(),
    });
    checks.push(InspectionCheck {
        id: CHECK_ENTRY.to_string(),
        label: "Entry point located".to_string(),
        state: if has_entry {
            CheckState::Ready
        } else {
            CheckState::Unknown
        },
        detail: if has_entry {
            "Every candidate carries a typed entry point.".to_string()
        } else {
            "No entry point was found; confirm it manually before deploying.".to_string()
        },
    });

    let ports: BTreeSet<u16> = services
        .iter()
        .flat_map(|service| service.ports.iter().map(|mapping| mapping.host_port))
        .collect();
    checks.push(InspectionCheck {
        id: CHECK_PORT.to_string(),
        label: "Ports identified".to_string(),
        state: if ports.is_empty() {
            CheckState::Unknown
        } else {
            CheckState::Ready
        },
        detail: if ports.is_empty() {
            "No port was declared; nothing will be published until you set one.".to_string()
        } else {
            format!(
                "Declared ports: {}",
                ports
                    .iter()
                    .map(u16::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        },
    });

    let env_keys = collect_env_keys(view, services);
    let secret_like = env_keys.iter().filter(|guess| guess.secret_like).count();
    checks.push(InspectionCheck {
        id: CHECK_ENV.to_string(),
        label: "Environment keys".to_string(),
        state: if env_keys.is_empty() {
            CheckState::Unknown
        } else {
            CheckState::Ready
        },
        detail: if env_keys.is_empty() {
            "No environment key was found (values are never read).".to_string()
        } else {
            format!(
                "{} key name(s) discovered, {} of them look secret-like.",
                env_keys.len(),
                secret_like
            )
        },
    });

    checks.push(InspectionCheck {
        id: CHECK_SECRETS.to_string(),
        label: "Sensitive content".to_string(),
        state: if scan_truncated {
            CheckState::Unknown
        } else {
            CheckState::Ready
        },
        detail: if scan_truncated {
            "The secret scan hit its budget and stopped early; treat the result as partial."
                .to_string()
        } else {
            "Secret scan covered the text files inside the artifact.".to_string()
        },
    });

    checks.push(InspectionCheck {
        id: CHECK_COVERAGE.to_string(),
        label: "Inventory coverage".to_string(),
        state: if truncated {
            CheckState::Unknown
        } else {
            CheckState::Ready
        },
        detail: if truncated {
            "The inventory was truncated by a limit; some files were never inspected.".to_string()
        } else {
            format!("{} entr(ies) inspected in full.", view.entries.len())
        },
    });

    checks
}

fn open_questions(
    view: &View<'_>,
    services: &[ServiceCandidate],
    artifact_kind: ArtifactKind,
) -> Vec<String> {
    let mut questions = Vec::new();
    if services
        .iter()
        .any(|service| matches!(service.runtime, ServiceRuntime::StaticNginx { .. }))
    {
        questions.push(
            "Confirm the absolute nginx site root under the environment deploy root.".to_string(),
        );
    }
    if services.iter().any(|service| {
        matches!(service.runtime, ServiceRuntime::NativeProcess { .. })
            && matches!(
                service.service_kind,
                ServiceKind::NodeProcess | ServiceKind::PythonVenv
            )
    }) {
        questions.push(
            "Confirm the entry script / module and the process manager (systemd unit name)."
                .to_string(),
        );
    }
    if services
        .iter()
        .any(|service| matches!(service.service_kind, ServiceKind::DockerImage))
        && artifact_kind == ArtifactKind::Dockerfile
    {
        questions.push(
            "Confirm the image name and tag: the image is built in a later stage, never during import."
                .to_string(),
        );
    }
    if services
        .iter()
        .any(|service| matches!(service.service_kind, ServiceKind::ExternalManaged))
    {
        questions.push(
            "Externally managed dependencies are declared and health-checked only; they are never deployed by this tool."
                .to_string(),
        );
    }
    if view.entries.is_empty() {
        questions.push("The artifact contains no file at all.".to_string());
    }
    questions
}

// -- 命名 -------------------------------------------------------------------

/// 服务名 / 站点名 / 容器名的安全化：只留小写字母数字与 `-`。
pub fn sanitize_name(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    let trimmed = if trimmed.len() > 48 {
        &trimmed[..48]
    } else {
        trimmed.as_str()
    };
    let trimmed = trimmed.trim_matches('-');
    if trimmed.is_empty() {
        "service".to_string()
    } else {
        trimmed.to_string()
    }
}

fn role_for(name: &str, image: Option<&str>, external: bool) -> ServiceRole {
    let haystack = format!(
        "{} {}",
        name.to_ascii_lowercase(),
        image.unwrap_or("").to_ascii_lowercase()
    );
    if haystack.contains("nginx") || haystack.contains("traefik") || haystack.contains("caddy") {
        return ServiceRole::Gateway;
    }
    if external {
        if haystack.contains("redis")
            || haystack.contains("memcached")
            || haystack.contains("valkey")
        {
            return ServiceRole::Cache;
        }
        return ServiceRole::Database;
    }
    if haystack.contains("worker") || haystack.contains("consumer") {
        return ServiceRole::Worker;
    }
    if haystack.contains("cron") || haystack.contains("scheduler") {
        return ServiceRole::Scheduler;
    }
    if haystack.contains("web") || haystack.contains("front") {
        return ServiceRole::Web;
    }
    if haystack.contains("api") || haystack.contains("server") || haystack.contains("app") {
        return ServiceRole::Api;
    }
    ServiceRole::Other
}

// -- 极简 JSON / Dockerfile / Compose 解析 ----------------------------------

/// 从 `package.json` 的 `scripts` 对象里读出**脚本名**（键名）。
///
/// 刻意只取键名、不取脚本内容：`"build": "vite build --mode prod"` 里的
/// 值本身就是一条命令行片段，把它存进模型等于给"自由命令"开了一个口子
/// （P5.0 的铁律）。键名（`build`）是受校验的短标识，可以安全地进模型。
pub fn json_script_names(text: &str) -> Vec<String> {
    let Some(start) = text.find("\"scripts\"") else {
        return Vec::new();
    };
    let Some(open) = text[start..].find('{') else {
        return Vec::new();
    };
    let body = &text[start + open..];
    let bytes = body.as_bytes();
    let mut names: Vec<String> = Vec::new();
    let mut depth = 0usize;
    let mut index = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut current = String::new();
    let mut closed_at_top = false;

    while index < bytes.len() {
        let ch = bytes[index] as char;
        if in_string {
            if escaped {
                escaped = false;
                if depth == 1 {
                    current.push(ch);
                }
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
                closed_at_top = depth == 1;
            } else if depth == 1 {
                current.push(ch);
            }
            index += 1;
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                current.clear();
                closed_at_top = false;
            }
            '{' => {
                depth += 1;
                closed_at_top = false;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                closed_at_top = false;
                if depth == 0 {
                    break;
                }
            }
            ':' => {
                if depth == 1 && closed_at_top && is_identifier(&current) {
                    names.push(current.clone());
                }
                closed_at_top = false;
                current.clear();
            }
            ',' | '[' | ']' => {
                closed_at_top = false;
                current.clear();
            }
            _ => {}
        }
        index += 1;
    }
    names
}

/// Dockerfile 的 `EXPOSE` 端口。
pub fn dockerfile_expose(text: &str) -> Vec<u16> {
    let mut ports = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        let Some(rest) = lower.strip_prefix("expose") else {
            continue;
        };
        for token in rest.split_whitespace() {
            let digits: String = token.chars().take_while(|ch| ch.is_ascii_digit()).collect();
            if let Ok(port) = digits.parse::<u16>() {
                if port > 0 && !ports.contains(&port) {
                    ports.push(port);
                }
            }
        }
    }
    ports
}

/// compose 里解析出来的一个服务。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ComposeService {
    pub name: String,
    pub image: Option<String>,
    /// `(宿主机端口, 容器端口)`。
    pub ports: Vec<(u16, u16)>,
    pub depends_on: Vec<String>,
    pub env_keys: Vec<String>,
    /// `Some((描述, 默认端口))` = 外部托管（数据库 / 缓存 / 队列）。
    pub external_kind: Option<(&'static str, u16)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ComposeParse {
    pub services: Vec<ComposeService>,
}

/// 解析 compose 的 `services:` 段：服务名 / 镜像 / 端口 / 依赖 / 环境变量名。
///
/// 刻意只做这几件事 —— 这是"提示器"不是 YAML 引擎。缩进歧义一律跳过，
/// 绝不猜：猜错的代价是给用户一份看起来专业、实则错误的部署建议。
pub fn parse_compose(text: &str) -> ComposeParse {
    let mut result = ComposeParse::default();
    let mut in_services = false;
    let mut services_indent = 0usize;
    let mut current: Option<ComposeService> = None;
    let mut block_indent = 0usize;
    let mut ports_indent: Option<usize> = None;
    let mut depends_indent: Option<usize> = None;
    let mut env_indent: Option<usize> = None;

    for raw_line in text.lines() {
        let code = match raw_line.find('#') {
            Some(position) => &raw_line[..position],
            None => raw_line,
        };
        if code.trim().is_empty() {
            continue;
        }
        let indent = code.len() - code.trim_start().len();
        let trimmed = code.trim();

        if !in_services {
            if trimmed == "services:" {
                in_services = true;
                services_indent = indent;
            }
            continue;
        }
        if indent <= services_indent {
            break;
        }
        if current.is_none() {
            block_indent = indent;
        }
        if indent == block_indent {
            if let Some(name) = trimmed.strip_suffix(':') {
                if let Some(finished) = current.take() {
                    result.services.push(finished);
                }
                current = Some(ComposeService {
                    name: name.trim().to_string(),
                    ..ComposeService::default()
                });
                ports_indent = None;
                depends_indent = None;
                env_indent = None;
                continue;
            }
        }
        let Some(service) = current.as_mut() else {
            continue;
        };
        if let Some(value) = trimmed.strip_prefix("image:") {
            service.image = Some(value.trim().trim_matches(['"', '\'']).to_string());
            continue;
        }
        if trimmed.starts_with("ports:") {
            ports_indent = Some(indent);
            depends_indent = None;
            env_indent = None;
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("depends_on:") {
            depends_indent = Some(indent);
            ports_indent = None;
            env_indent = None;
            for name in value
                .trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
            {
                let name = name.trim().trim_matches(['"', '\'']);
                if is_identifier(name)
                    && !service.depends_on.iter().any(|existing| existing == name)
                {
                    service.depends_on.push(name.to_string());
                }
            }
            continue;
        }
        if trimmed.starts_with("environment:") {
            env_indent = Some(indent);
            ports_indent = None;
            depends_indent = None;
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("- ") {
            let value = value.trim().trim_matches(['"', '\'']);
            if ports_indent.is_some_and(|start| indent > start) {
                if let Some(pair) = parse_port_mapping(value) {
                    if !service.ports.contains(&pair) {
                        service.ports.push(pair);
                    }
                }
                continue;
            }
            if depends_indent.is_some_and(|start| indent > start) {
                if is_identifier(value) && !service.depends_on.iter().any(|name| name == value) {
                    service.depends_on.push(value.to_string());
                }
                continue;
            }
            if env_indent.is_some_and(|start| indent > start) {
                if let Some((key, _)) = value.split_once('=') {
                    let key = key.trim();
                    if is_env_key(key) && !service.env_keys.iter().any(|existing| existing == key) {
                        service.env_keys.push(key.to_string());
                    }
                }
            }
            continue;
        }
        // `KEY: value` 形式的 environment（映射写法）。
        if env_indent.is_some_and(|start| indent > start) {
            if let Some((key, _)) = trimmed.split_once(':') {
                let key = key.trim();
                if is_env_key(key) && !service.env_keys.iter().any(|existing| existing == key) {
                    service.env_keys.push(key.to_string());
                }
            }
        }
    }
    if let Some(finished) = current.take() {
        result.services.push(finished);
    }

    for service in result.services.iter_mut() {
        let haystack = format!(
            "{} {}",
            service.name.to_ascii_lowercase(),
            service
                .image
                .clone()
                .unwrap_or_default()
                .to_ascii_lowercase()
        );
        service.external_kind = if haystack.contains("postgres")
            || haystack.contains("mysql")
            || haystack.contains("mariadb")
            || haystack.contains("mongo")
            || haystack.contains("clickhouse")
        {
            Some(("database", 5432))
        } else if haystack.contains("redis")
            || haystack.contains("memcached")
            || haystack.contains("valkey")
        {
            Some(("cache", 6379))
        } else if haystack.contains("rabbitmq")
            || haystack.contains("kafka")
            || haystack.contains("nats")
        {
            Some(("message broker", 5672))
        } else {
            None
        };
        if let Some((_, port)) = service.external_kind {
            if service.ports.is_empty() {
                service.ports.push((port, port));
            }
        }
    }
    result
}

fn parse_port_mapping(value: &str) -> Option<(u16, u16)> {
    let body = value.split('/').next().unwrap_or(value);
    let parts: Vec<&str> = body.split(':').collect();
    let (host, container) = match parts.as_slice() {
        [single] => (single.to_string(), single.to_string()),
        [host, container] => (host.to_string(), container.to_string()),
        [_, host, container] => (host.to_string(), container.to_string()),
        _ => return None,
    };
    let host = last_number(&host)?;
    let container = last_number(&container)?;
    if host == 0 || container == 0 {
        return None;
    }
    Some((host, container))
}

/// 取字符串末尾的连续数字（`${PORT:-8080}` → 8080，`8080-8090` → 8090 的头部）。
fn last_number(value: &str) -> Option<u16> {
    let head = value.split('-').next().unwrap_or(value);
    let digits: String = head.chars().filter(|ch| ch.is_ascii_digit()).collect();
    digits.parse::<u16>().ok()
}

fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}
