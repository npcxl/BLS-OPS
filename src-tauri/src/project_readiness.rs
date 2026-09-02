//! 项目级部署准备检查（P3.8 的正确形态）。
//!
//! 之前的"部署可行性图谱"是**按整台服务器**评估所有部署适配器 —— 装了 Docker
//! 就说 Docker 可部署。这不代表任何具体项目真的能部署：一个 Java 项目即使
//! 服务器装了 Docker，也可能没有 Dockerfile、没有构建环境、端口冲突。
//!
//! 这里改成**围绕一个具体项目**做检查，只输出三选一结论：
//! 可以生成部署方案 / 需要用户确认 / 存在阻塞项，外加一条"推荐部署方式 +
//! 原因"。全部是纯判定，不执行任何命令。

use serde::{Deserialize, Serialize};

use crate::capability_probe::ServerCapabilityProfile;
use crate::project_discovery::{CandidateInstance, ProjectKind};
use crate::service_catalog::InstanceRuntime;

/// 单项检查的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    /// 证据充分，这一项没问题。
    Ready,
    /// 证据不足 —— **必须如实说"未确认"，绝不猜成通过**。
    Unknown,
    /// 明确缺失或冲突。
    Blocked,
}

impl CheckState {
    pub fn label(self) -> &'static str {
        match self {
            CheckState::Ready => "已确认",
            CheckState::Unknown => "未确认",
            CheckState::Blocked => "阻塞",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadinessCheck {
    pub id: String,
    pub label: String,
    pub state: CheckState,
    /// 判定的依据或缺失的原因。
    pub detail: String,
}

/// 最终结论：只给三种，不给"15 种适配器谁可用"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessVerdict {
    /// 可以生成部署方案。
    Ready,
    /// 需要用户确认若干项。
    NeedsConfirm,
    /// 存在阻塞项。
    Blocked,
}

impl ReadinessVerdict {
    pub fn label(self) -> &'static str {
        match self {
            ReadinessVerdict::Ready => "可以生成部署方案",
            ReadinessVerdict::NeedsConfirm => "需要你确认",
            ReadinessVerdict::Blocked => "存在阻塞项",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecommendedMethod {
    pub id: String,
    pub label: String,
    /// 为什么推荐它 —— 必须由证据支撑，不能凭空断言。
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectReadinessReport {
    pub path: String,
    pub verdict: ReadinessVerdict,
    pub checks: Vec<ReadinessCheck>,
    /// 基础设施（MySQL / Redis / 网关…）不是要部署的项目，不给推荐方式。
    pub recommended: Option<RecommendedMethod>,
    /// 需要用户确认的事项（来自 `Unknown` 检查项）。
    pub open_questions: Vec<String>,
}

/// 依赖服务：项目里出现了它的客户端库或配置，但不一定在本机。
const DEPENDENCY_HINTS: &[(&str, &str)] = &[
    ("mysql", "MySQL"),
    ("mariadb", "MariaDB"),
    ("postgres", "PostgreSQL"),
    ("redis", "Redis"),
    ("mongodb", "MongoDB"),
    ("elasticsearch", "Elasticsearch"),
    ("rabbitmq", "RabbitMQ"),
    ("kafka", "Kafka"),
    ("nacos", "Nacos"),
];

/// 源码完整性：有哪些清单文件，就知道是什么技术栈、能不能构建。
fn check_source(markers: &[String], project_type: &str) -> ReadinessCheck {
    let has_manifest = markers.iter().any(|m| {
        matches!(
            m.as_str(),
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
        ) || m.ends_with(".csproj")
            || m.ends_with(".sln")
    });
    let has_source = markers.iter().any(|m| m == "src" || m == "app");
    if has_manifest && has_source {
        ReadinessCheck {
            id: "source".into(),
            label: "源码完整性".into(),
            state: CheckState::Ready,
            detail: format!("识别为 {project_type}，构建清单与源码目录都存在"),
        }
    } else if has_manifest {
        ReadinessCheck {
            id: "source".into(),
            label: "源码完整性".into(),
            state: CheckState::Unknown,
            detail: format!(
                "识别为 {project_type}，有构建清单但没看到源码目录，需要你确认目录是否完整"
            ),
        }
    } else {
        ReadinessCheck {
            id: "source".into(),
            label: "源码完整性".into(),
            state: CheckState::Blocked,
            detail: "没有找到构建清单（package.json / pom.xml / Cargo.toml 等），无法判断构建方式"
                .into(),
        }
    }
}

/// 启动方式：看有没有 Dockerfile / compose / Procfile / systemd，以及服务器
/// 是否具备对应能力。**有文件但服务器没装 = 阻塞；都没有 = 未确认**。
fn check_launch(markers: &[String], profile: &ServerCapabilityProfile) -> ReadinessCheck {
    let compose = markers.iter().any(|m| {
        m == "docker-compose.yml"
            || m == "compose.yml"
            || m == "compose.yaml"
            || m.starts_with("docker-compose")
    });
    let dockerfile = markers.iter().any(|m| m == "dockerfile");
    let procfile = markers.iter().any(|m| m == "procfile");
    let has_systemd = profile.deployment.systemd == Some(true);
    let has_docker = profile.deployment.docker == Some(true);
    let has_compose = profile.deployment.docker_compose == Some(true);

    if compose && has_compose {
        ReadinessCheck {
            id: "launch".into(),
            label: "启动方式".into(),
            state: CheckState::Ready,
            detail: "存在 Compose 文件，服务器已安装 Docker Compose".into(),
        }
    } else if compose && !has_compose {
        ReadinessCheck {
            id: "launch".into(),
            label: "启动方式".into(),
            state: CheckState::Blocked,
            detail: "存在 Compose 文件，但服务器没有可用的 Docker Compose".into(),
        }
    } else if dockerfile && has_docker {
        ReadinessCheck {
            id: "launch".into(),
            label: "启动方式".into(),
            state: CheckState::Ready,
            detail: "存在 Dockerfile，服务器已安装 Docker".into(),
        }
    } else if dockerfile && !has_docker {
        ReadinessCheck {
            id: "launch".into(),
            label: "启动方式".into(),
            state: CheckState::Blocked,
            detail: "存在 Dockerfile，但服务器没有可用的 Docker".into(),
        }
    } else if procfile {
        ReadinessCheck {
            id: "launch".into(),
            label: "启动方式".into(),
            state: CheckState::Unknown,
            detail: "存在 Procfile，但本机没有识别到匹配的进程管理器（PM2 / Supervisor）".into(),
        }
    } else if has_systemd {
        ReadinessCheck {
            id: "launch".into(),
            label: "启动方式".into(),
            state: CheckState::Unknown,
            detail: "没有容器化描述文件；服务器有 systemd，需要你确认是否用 unit 托管".into(),
        }
    } else {
        ReadinessCheck {
            id: "launch".into(),
            label: "启动方式".into(),
            state: CheckState::Unknown,
            detail: "没有找到 Dockerfile / Compose / Procfile，也没有识别到进程管理器".into(),
        }
    }
}

/// 端口：项目要监听的端口是否与已监听端口冲突。正在被**别的**实例占用才是问题。
fn check_ports(ports: &[u16], instances: &[CandidateInstance]) -> ReadinessCheck {
    if ports.is_empty() {
        return ReadinessCheck {
            id: "ports".into(),
            label: "端口".into(),
            state: CheckState::Unknown,
            detail: "没有识别到项目监听端口，需要你确认服务端口".into(),
        };
    }
    let owned: std::collections::HashSet<u16> = instances
        .iter()
        .flat_map(|instance| instance.ports.iter().copied())
        .collect();
    let conflicts: Vec<u16> = ports
        .iter()
        .copied()
        .filter(|port| !owned.contains(port))
        .collect();
    if conflicts.is_empty() {
        ReadinessCheck {
            id: "ports".into(),
            label: "端口".into(),
            state: CheckState::Ready,
            detail: format!("端口 {} 已由该项目自身的运行实例监听", join_ports(ports)),
        }
    } else {
        ReadinessCheck {
            id: "ports".into(),
            label: "端口".into(),
            state: CheckState::Unknown,
            detail: format!(
                "端口 {} 没有对应的运行实例，部署前需要确认是否被其他服务占用",
                join_ports(&conflicts)
            ),
        }
    }
}

/// 环境变量：只统计变量名是否存在，**绝不读取值**（密码不回传前端）。
fn check_env(markers: &[String]) -> ReadinessCheck {
    let has_env_example = markers.iter().any(|m| m == ".env.example");
    if has_env_example {
        ReadinessCheck {
            id: "env".into(),
            label: "环境变量".into(),
            state: CheckState::Ready,
            detail: "存在 .env.example，可据此补齐环境变量（只识别变量名，不读取值）".into(),
        }
    } else {
        ReadinessCheck {
            id: "env".into(),
            label: "环境变量".into(),
            state: CheckState::Unknown,
            detail: "没有环境变量模板，需要你确认需要哪些环境变量".into(),
        }
    }
}

/// 网关：Nginx / Caddy 是否在本机，且是否有配置文件落在这个项目里。
fn check_gateway(markers: &[String], profile: &ServerCapabilityProfile) -> ReadinessCheck {
    let local_conf = markers.iter().any(|m| m == "nginx.conf");
    let d = &profile.deployment;
    let installed = [d.nginx, d.caddy, d.apache, d.traefik]
        .iter()
        .any(|v| *v == Some(true));
    match (local_conf, installed) {
        (true, true) => ReadinessCheck {
            id: "gateway".into(),
            label: "网关配置".into(),
            state: CheckState::Ready,
            detail: "项目内有 Nginx 配置，服务器已安装网关".into(),
        },
        (false, true) => ReadinessCheck {
            id: "gateway".into(),
            label: "网关配置".into(),
            state: CheckState::Unknown,
            detail: "服务器有网关，但项目内没有配置文件 —— 需要你确认是否由网关反代".into(),
        },
        (true, false) => ReadinessCheck {
            id: "gateway".into(),
            label: "网关配置".into(),
            state: CheckState::Blocked,
            detail: "项目内有 Nginx 配置，但服务器没有安装对应网关".into(),
        },
        (false, false) => ReadinessCheck {
            id: "gateway".into(),
            label: "网关配置".into(),
            state: CheckState::Unknown,
            detail: "服务器没有识别到网关，也没有项目内配置 —— 未确认对外暴露方式".into(),
        },
    }
}

/// 依赖服务：从配置片段里提到的名字推断，**只报"可能需要"，不报"已就绪"**。
fn check_dependencies(markers: &[String], profile: &ServerCapabilityProfile) -> ReadinessCheck {
    let mentioned: Vec<&str> = markers
        .iter()
        .filter_map(|marker| {
            DEPENDENCY_HINTS
                .iter()
                .find(|(needle, _)| marker.contains(needle))
                .map(|(_, label)| *label)
        })
        .collect();
    if mentioned.is_empty() {
        return ReadinessCheck {
            id: "dependencies".into(),
            label: "依赖服务".into(),
            state: CheckState::Unknown,
            detail: "没有发现数据库 / 缓存 / 消息队列的线索，需要你确认项目依赖".into(),
        };
    }
    let d = &profile.deployment;
    let installed = |v: &Option<bool>| *v == Some(true);
    let missing: Vec<&str> = mentioned
        .iter()
        .copied()
        .filter(|label| match *label {
            "MySQL" | "MariaDB" => !installed(&d.mysql),
            "PostgreSQL" => !installed(&d.postgresql),
            "Redis" => !installed(&d.redis),
            "MongoDB" => !installed(&d.mongodb),
            "Elasticsearch" => !installed(&d.elasticsearch),
            "RabbitMQ" => !installed(&d.rabbitmq),
            "Kafka" => !installed(&d.kafka),
            _ => false,
        })
        .collect();
    if missing.is_empty() {
        ReadinessCheck {
            id: "dependencies".into(),
            label: "依赖服务".into(),
            state: CheckState::Ready,
            detail: format!(
                "项目可能依赖 {}，这些服务在服务器上都有",
                mentioned.join("、")
            ),
        }
    } else {
        ReadinessCheck {
            id: "dependencies".into(),
            label: "依赖服务".into(),
            state: CheckState::Unknown,
            detail: format!(
                "项目可能依赖 {}，其中 {} 在本服务器没有识别到 —— 可能部署在别处，需要你确认",
                mentioned.join("、"),
                missing.join("、")
            ),
        }
    }
}

/// 回滚条件：有没有旧版本或制品。绝大多数情况下我们看不到，就如实说未确认。
fn check_rollback(instances: &[CandidateInstance]) -> ReadinessCheck {
    let has_image = instances
        .iter()
        .any(|instance| instance.image.is_some() || instance.runtime != InstanceRuntime::Host);
    if has_image {
        ReadinessCheck {
            id: "rollback".into(),
            label: "回滚条件".into(),
            state: CheckState::Ready,
            detail: "运行实例基于镜像，回滚到上一个镜像标签即可".into(),
        }
    } else {
        ReadinessCheck {
            id: "rollback".into(),
            label: "回滚条件".into(),
            state: CheckState::Unknown,
            detail: "没有找到旧版本或制品，回滚方式需要你在部署前确定".into(),
        }
    }
}

fn join_ports(ports: &[u16]) -> String {
    ports
        .iter()
        .map(|port| port.to_string())
        .collect::<Vec<_>>()
        .join("、")
}

/// 推荐部署方式：**必须由证据支撑**。有 compose 且装了 compose 就推荐 compose，
/// 已有同类运行实例也是一条证据。推不出来就返回 `None`，不硬猜。
fn recommend(
    markers: &[String],
    instances: &[CandidateInstance],
    profile: &ServerCapabilityProfile,
) -> Option<RecommendedMethod> {
    let compose = markers
        .iter()
        .any(|m| m == "docker-compose.yml" || m == "compose.yml" || m == "compose.yaml");
    let dockerfile = markers.iter().any(|m| m == "dockerfile");
    let has_compose = profile.deployment.docker_compose == Some(true);
    let has_docker = profile.deployment.docker == Some(true);
    let has_systemd = profile.deployment.systemd == Some(true);

    if compose && has_compose {
        let mut reason = "项目存在 Compose 文件，服务器已安装 Docker Compose".to_string();
        if instances
            .iter()
            .any(|instance| instance.runtime == InstanceRuntime::Container)
        {
            reason.push_str("，且已有容器化的运行实例");
        }
        return Some(RecommendedMethod {
            id: "docker-compose".into(),
            label: "Docker Compose".into(),
            reason,
        });
    }
    if dockerfile && has_docker {
        return Some(RecommendedMethod {
            id: "docker".into(),
            label: "Docker 镜像".into(),
            reason: "项目存在 Dockerfile，服务器已安装 Docker".into(),
        });
    }
    if has_systemd && instances.iter().any(|instance| instance.kind == "systemd") {
        return Some(RecommendedMethod {
            id: "systemd".into(),
            label: "systemd 服务".into(),
            reason: "服务器有 systemd，且该项目已有 systemd 运行实例".into(),
        });
    }
    None
}

/// 围绕**一个具体项目**做部署准备检查。
///
/// 基础设施（MySQL / Redis / Nginx 站点）不是要部署的项目，会直接给出
/// `Blocked` + 说明，并省略推荐方式。
pub fn assess_project_readiness(
    path: &str,
    markers: &[String],
    ports: &[u16],
    instances: &[CandidateInstance],
    project_type: &str,
    project_kind: ProjectKind,
    profile: &ServerCapabilityProfile,
) -> ProjectReadinessReport {
    let lower: Vec<String> = markers.iter().map(|m| m.to_ascii_lowercase()).collect();

    if project_kind == ProjectKind::Infrastructure {
        return ProjectReadinessReport {
            path: path.into(),
            verdict: ReadinessVerdict::Blocked,
            checks: vec![ReadinessCheck {
                id: "kind".into(),
                label: "对象类型".into(),
                state: CheckState::Blocked,
                detail: "这是服务器上的依赖（数据库 / 缓存 / 网关等），不是要部署的业务项目".into(),
            }],
            recommended: None,
            open_questions: vec!["这个目录是基础设施，不应该作为项目部署".into()],
        };
    }

    let checks = vec![
        check_source(&lower, project_type),
        check_launch(&lower, profile),
        check_ports(ports, instances),
        check_env(&lower),
        check_dependencies(&lower, profile),
        check_gateway(&lower, profile),
        check_rollback(instances),
    ];

    let blocked = checks
        .iter()
        .filter(|check| check.state == CheckState::Blocked)
        .count();
    let unknown = checks
        .iter()
        .filter(|check| check.state == CheckState::Unknown)
        .count();

    // 只要有阻塞项就是 Blocked；否则有未确认项就是 NeedsConfirm；全通过才 Ready。
    let verdict = if blocked > 0 {
        ReadinessVerdict::Blocked
    } else if unknown > 0 {
        ReadinessVerdict::NeedsConfirm
    } else {
        ReadinessVerdict::Ready
    };

    let open_questions = checks
        .iter()
        .filter(|check| check.state != CheckState::Ready)
        .map(|check| format!("{}：{}", check.label, check.detail))
        .collect();

    ProjectReadinessReport {
        path: path.into(),
        verdict,
        checks,
        recommended: recommend(&lower, instances, profile),
        open_questions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability_probe::{DeploymentCapabilities, ServerCapabilityProfile, SystemProfile};

    fn profile_with(
        docker: Option<bool>,
        compose: Option<bool>,
        systemd: Option<bool>,
        nginx: Option<bool>,
    ) -> ServerCapabilityProfile {
        ServerCapabilityProfile {
            system: SystemProfile::default(),
            runtimes: Default::default(),
            version_managers: Default::default(),
            build_tools: Default::default(),
            deployment: DeploymentCapabilities {
                docker,
                docker_compose: compose,
                systemd,
                nginx,
                ..Default::default()
            },
            warnings: Vec::new(),
        }
    }

    fn markers(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_java_project_is_not_ready_just_because_the_server_has_docker() {
        // 这正是旧的"全局部署可行性图谱"会误判的场景：服务器装了 Docker，
        // 但项目没有 Dockerfile、没有构建环境。
        let report = assess_project_readiness(
            "/srv/order",
            &markers(&["pom.xml", "src"]),
            &[8080],
            &[],
            "Java Maven",
            ProjectKind::Unknown,
            &profile_with(Some(true), Some(true), Some(true), None),
        );
        assert_eq!(report.verdict, ReadinessVerdict::NeedsConfirm);
        assert!(
            report.recommended.is_none(),
            "没有 Docker 相关证据就不该推荐容器化：{:?}",
            report.recommended
        );
        let launch = report
            .checks
            .iter()
            .find(|check| check.id == "launch")
            .expect("必须有启动方式检查");
        assert_eq!(launch.state, CheckState::Unknown);
    }

    #[test]
    fn compose_project_on_a_compose_server_is_ready() {
        let report = assess_project_readiness(
            "/srv/api",
            &markers(&["package.json", "src", "docker-compose.yml", ".env.example"]),
            &[3000],
            &[],
            "Node.js",
            ProjectKind::Application,
            &profile_with(Some(true), Some(true), None, None),
        );
        assert_eq!(report.verdict, ReadinessVerdict::NeedsConfirm);
        let recommended = report.recommended.expect("有 compose 就该推荐 compose");
        assert_eq!(recommended.id, "docker-compose");
        assert!(recommended.reason.contains("Compose 文件"));
    }

    #[test]
    fn compose_file_without_compose_installed_is_blocked() {
        let report = assess_project_readiness(
            "/srv/api",
            &markers(&["package.json", "src", "docker-compose.yml"]),
            &[3000],
            &[],
            "Node.js",
            ProjectKind::Application,
            &profile_with(Some(true), None, None, None),
        );
        assert_eq!(report.verdict, ReadinessVerdict::Blocked);
    }

    #[test]
    fn infrastructure_is_never_treated_as_deployable() {
        let report = assess_project_readiness(
            "/opt/mysql",
            &markers(&["docker-compose.yml"]),
            &[3306],
            &[],
            "Docker",
            ProjectKind::Infrastructure,
            &profile_with(Some(true), Some(true), None, None),
        );
        assert_eq!(report.verdict, ReadinessVerdict::Blocked);
        assert!(report.recommended.is_none());
    }

    #[test]
    fn a_project_without_any_manifest_is_blocked() {
        let report = assess_project_readiness(
            "/srv/unknown",
            &markers(&["src"]),
            &[],
            &[],
            "未知项目",
            ProjectKind::Unknown,
            &profile_with(None, None, None, None),
        );
        let source = report
            .checks
            .iter()
            .find(|check| check.id == "source")
            .expect("必须有源码检查");
        assert_eq!(source.state, CheckState::Blocked);
        assert_eq!(report.verdict, ReadinessVerdict::Blocked);
    }

    #[test]
    fn unknown_items_are_never_reported_as_ready() {
        // 端口没有对应运行实例时，只能说"未确认"，不能说"已确认"。
        let report = assess_project_readiness(
            "/srv/api",
            &markers(&["package.json", "src"]),
            &[8080],
            &[],
            "Node.js",
            ProjectKind::Application,
            &profile_with(None, None, None, None),
        );
        let ports = report
            .checks
            .iter()
            .find(|check| check.id == "ports")
            .expect("必须有端口检查");
        assert_eq!(ports.state, CheckState::Unknown);
        assert!(!report.open_questions.is_empty());
    }
}
