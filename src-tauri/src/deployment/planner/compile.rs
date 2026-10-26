//! P5.6 **确定性编译**：把通过校验的草案翻译成既有 [`ServiceRuntime`]。
//!
//! # 这里最重要的三件事
//!
//! 1. **可执行文件名由白名单决定**，不是 AI 写的 —— AI 只能"选一种运行时"，
//!    不能指定 `entry`（那是 `NativeProcess` 里最敏感的字段）。
//! 2. **镜像引用必须已在目录里登记**（来自制品 / 镜像引用），AI 不能凭空造镜像名。
//! 3. **args 一律为空**：草案里没有命令，编译期也不产生命令。
//!
//! 编译失败返回**结构化问题**，调用方据此回到"追问"或"拒绝"，
//! 绝不偷偷降级成"随便挑一个运行时"。

use crate::deployment::model::{PortMapping, PortProtocol, ServiceRuntime};

use super::model::DraftRuntime;
use super::validate::PlanCompilerInput;

/// 语言运行时 → **固定**可执行文件名（AI 不可自定义）。
pub const EXECUTABLE_BY_RUNTIME: &[(DraftRuntime, &str)] = &[
    (DraftRuntime::NodeProcess, "node"),
    (DraftRuntime::JavaProcess, "java"),
    (DraftRuntime::PythonProcess, "python3"),
    (DraftRuntime::GoProcess, "go"),
    (DraftRuntime::PhpProcess, "php"),
];

pub fn executable_for(runtime: DraftRuntime) -> Option<&'static str> {
    EXECUTABLE_BY_RUNTIME
        .iter()
        .find(|(candidate, _)| *candidate == runtime)
        .map(|(_, executable)| *executable)
}

/// 编译期需要的"外部事实"（**由系统提供，不是 AI 提供**）。
#[derive(Debug, Clone, Copy)]
pub struct RuntimeCatalog<'a> {
    /// 服务名 → 已登记的镜像引用（来自制品 / 镜像登记，AI 不能凭空造）。
    pub service_images: &'a [(&'a str, &'a str)],
    /// 环境 `deploy_root`（绝对路径）。
    pub deploy_root: &'a str,
    /// compose 文件的相对路径约定（默认 `docker-compose.yml`）。
    pub compose_relative_path: &'a str,
    /// compose 项目名（由应用 id 推导，不来自 AI）。
    pub compose_project: &'a str,
}

/// 编译问题（结构化，不静默降级）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompileIssue {
    /// 容器服务没有给镜像引用。
    MissingImage { service: String },
    /// 镜像不在已登记目录里。
    ImageNotAllowed { service: String, image: String },
    /// 外部依赖缺少 endpoint。
    MissingEndpoint { service: String },
    /// 部署路径无效。
    InvalidDeployPath { service: String, value: String },
    /// 服务名不合法（会变成容器名 / 站点名 / 单元名）。
    InvalidServiceName { service: String },
}

impl CompileIssue {
    pub fn code(&self) -> &'static str {
        match self {
            CompileIssue::MissingImage { .. } => "missing_image",
            CompileIssue::ImageNotAllowed { .. } => "image_not_allowed",
            CompileIssue::MissingEndpoint { .. } => "missing_endpoint",
            CompileIssue::InvalidDeployPath { .. } => "invalid_deploy_path",
            CompileIssue::InvalidServiceName { .. } => "invalid_service_name",
        }
    }
}

/// 编译产物：一个服务对应一个既有 `ServiceRuntime`（**不含命令**）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledService {
    pub name: String,
    pub runtime: ServiceRuntime,
    pub deploy_path: String,
    pub port: Option<u16>,
    pub health_path: Option<String>,
    pub env_keys: Vec<String>,
    pub secret_refs: Vec<String>,
}

/// 编译入口。**全成功或全失败**：有任何一个服务编不过就整体返回问题列表。
pub fn compile_services(
    input: &PlanCompilerInput,
    catalog: &RuntimeCatalog<'_>,
) -> Result<Vec<CompiledService>, Vec<CompileIssue>> {
    let mut issues: Vec<CompileIssue> = Vec::new();
    let mut compiled: Vec<CompiledService> = Vec::new();
    let root = catalog.deploy_root.trim_end_matches('/');

    for service in &input.services {
        if !is_safe_identifier(&service.name) {
            issues.push(CompileIssue::InvalidServiceName {
                service: service.name.clone(),
            });
            continue;
        }
        let deploy_path = match &service.deploy_path_hint {
            Some(hint) => {
                let trimmed = hint.trim_matches('/');
                if trimmed.contains("..") || trimmed.is_empty() {
                    issues.push(CompileIssue::InvalidDeployPath {
                        service: service.name.clone(),
                        value: hint.clone(),
                    });
                    continue;
                }
                format!("{root}/{trimmed}")
            }
            None => format!("{root}/{}", service.name),
        };

        let runtime = match service.runtime {
            DraftRuntime::StaticSite => ServiceRuntime::StaticNginx {
                site_name: service.name.clone(),
                root: deploy_path.clone(),
            },
            DraftRuntime::NodeProcess
            | DraftRuntime::JavaProcess
            | DraftRuntime::PythonProcess
            | DraftRuntime::GoProcess
            | DraftRuntime::PhpProcess => ServiceRuntime::NativeProcess {
                // 可执行名来自白名单；**args 永远为空**（草案无命令，编译期也不产生）。
                entry: executable_for(service.runtime)
                    .expect("白名单内才会走到这里")
                    .to_string(),
                args: Vec::new(),
            },
            DraftRuntime::DockerImage => {
                // 镜像**必须**来自登记表：AI 选了容器运行时不等于它可以造镜像名。
                match catalog
                    .service_images
                    .iter()
                    .find(|(service_name, _)| *service_name == service.name)
                {
                    Some((_, reference)) => {
                        let (image, tag) = split_image(reference);
                        ServiceRuntime::DockerImage {
                            image,
                            tag,
                            container_name: service.name.clone(),
                            ports: service
                                .port
                                .map(|port| {
                                    vec![PortMapping {
                                        host_port: port,
                                        container_port: port,
                                        protocol: PortProtocol::Tcp,
                                    }]
                                })
                                .unwrap_or_default(),
                        }
                    }
                    None => {
                        issues.push(CompileIssue::ImageNotAllowed {
                            service: service.name.clone(),
                            image: "<未登记>".to_string(),
                        });
                        continue;
                    }
                }
            }
            DraftRuntime::DockerCompose => ServiceRuntime::DockerCompose {
                compose_path: format!("{deploy_path}/{}", catalog.compose_relative_path),
                project_name: catalog.compose_project.to_string(),
                service: service.name.clone(),
            },
            DraftRuntime::ExternalManaged => {
                issues.push(CompileIssue::MissingEndpoint {
                    service: service.name.clone(),
                });
                continue;
            }
        };

        compiled.push(CompiledService {
            name: service.name.clone(),
            runtime,
            deploy_path,
            port: service.port,
            health_path: service.health_path.clone(),
            env_keys: service.env_keys.clone(),
            secret_refs: service.secret_refs.clone(),
        });
    }

    if issues.is_empty() {
        Ok(compiled)
    } else {
        Err(issues)
    }
}

/// 名字会变成容器名 / 站点名 / 单元名 —— 只允许保守字符。
fn is_safe_identifier(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 48
        && name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

fn split_image(reference: &str) -> (String, String) {
    match reference.rsplit_once(':') {
        Some((name, tag)) => (name.to_string(), tag.to_string()),
        None => (reference.to_string(), "latest".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::planner::model::DraftService;
    use crate::deployment::planner::validate::PlanCompilerInput;
    use crate::deployment::proposal::model::TopologyKind;
    use crate::deployment::session::model::QuestionKind;

    fn service(name: &str, runtime: DraftRuntime) -> DraftService {
        DraftService {
            name: name.to_string(),
            service_kind: crate::deployment::model::ServiceKind::NodeProcess,
            runtime,
            port: Some(3000),
            health_path: Some("/healthz".to_string()),
            env_keys: vec!["DATABASE_URL".to_string()],
            secret_refs: vec!["sec-db".to_string()],
            deploy_path_hint: Some(name.to_string()),
            evidence_ids: vec![],
        }
    }

    fn input(services: Vec<DraftService>) -> PlanCompilerInput {
        PlanCompilerInput {
            topology: TopologyKind::DockerCompose,
            services,
            dependencies: vec![],
            domain: None,
            ssl: None,
            capacity: Default::default(),
            risks: vec![],
            assumptions: vec![],
            memory_refs: vec![],
            knowledge_refs: vec![],
        }
    }

    fn catalog<'a>(images: &'a [(&'a str, &'a str)]) -> RuntimeCatalog<'a> {
        RuntimeCatalog {
            service_images: images,
            deploy_root: "/opt/apps/shop",
            compose_relative_path: "docker-compose.yml",
            compose_project: "shop",
        }
    }

    #[test]
    fn a_language_runtime_maps_to_a_whitelisted_executable_with_no_args() {
        let compiled = compile_services(
            &input(vec![service("api", DraftRuntime::NodeProcess)]),
            &catalog(&[]),
        )
        .expect("应当编译");
        match &compiled[0].runtime {
            ServiceRuntime::NativeProcess { entry, args } => {
                // 可执行名来自白名单，**args 永远为空**。
                assert_eq!(entry, "node");
                assert!(args.is_empty());
            }
            other => panic!("运行时不对：{other:?}"),
        }
        assert_eq!(compiled[0].deploy_path, "/opt/apps/shop/api");
    }

    #[test]
    fn the_ai_can_never_choose_the_executable_or_any_argument() {
        // 草案里根本没有 entry/args 字段：解析阶段就会失败。
        let json = valid_draft_json_with(
            "\"runtime\":\"node_process\"",
            "\"runtime\":\"node_process\",\"entry\":\"/usr/bin/curl\"",
        );
        assert!(
            serde_json::from_str::<super::super::model::AiDeploymentDraft>(&json).is_err(),
            "AI 不允许指定 entry"
        );
    }

    #[test]
    fn an_image_must_be_registered_before_it_can_be_used() {
        let error = compile_services(
            &input(vec![service("api", DraftRuntime::DockerImage)]),
            &catalog(&[]),
        )
        .expect_err("未登记镜像应当失败");
        assert!(
            error
                .iter()
                .any(|issue| matches!(issue, CompileIssue::ImageNotAllowed { .. })),
            "{error:?}"
        );

        // 登记之后就能编译，且镜像名来自登记表。
        let images = [("api", "registry.example.com/shop-api:1.2.3")];
        let compiled = compile_services(
            &input(vec![service("api", DraftRuntime::DockerImage)]),
            &catalog(&images),
        )
        .expect("登记后应当编译");
        match &compiled[0].runtime {
            ServiceRuntime::DockerImage { image, tag, .. } => {
                assert_eq!(image, "registry.example.com/shop-api");
                assert_eq!(tag, "1.2.3");
            }
            other => panic!("运行时不对：{other:?}"),
        }
    }

    #[test]
    fn service_names_and_paths_must_be_conservative() {
        let error = compile_services(
            &input(vec![service("API; rm -rf /", DraftRuntime::NodeProcess)]),
            &catalog(&[]),
        )
        .expect_err("非法服务名应当失败");
        assert!(
            error
                .iter()
                .any(|issue| matches!(issue, CompileIssue::InvalidServiceName { .. })),
            "{error:?}"
        );

        let mut escaping = service("api", DraftRuntime::NodeProcess);
        escaping.deploy_path_hint = Some("../../etc".to_string());
        let error =
            compile_services(&input(vec![escaping]), &catalog(&[])).expect_err("越界路径应当失败");
        assert!(
            error
                .iter()
                .any(|issue| matches!(issue, CompileIssue::InvalidDeployPath { .. })),
            "{error:?}"
        );
    }

    #[test]
    fn compose_projects_and_external_services_are_not_guessed() {
        let compiled = compile_services(
            &input(vec![service("api", DraftRuntime::DockerCompose)]),
            &catalog(&[]),
        )
        .expect("compose 应当能编译");
        match &compiled[0].runtime {
            ServiceRuntime::DockerCompose {
                compose_path,
                project_name,
                service,
            } => {
                // 项目名来自系统（应用 id 推导），不是 AI。
                assert_eq!(project_name, "shop");
                assert_eq!(service, "api");
                assert!(compose_path.ends_with("docker-compose.yml"));
            }
            other => panic!("运行时不对：{other:?}"),
        }

        // 外部托管必须有 endpoint，缺了就报结构化问题而不是瞎填。
        let error = compile_services(
            &input(vec![service("db", DraftRuntime::ExternalManaged)]),
            &catalog(&[]),
        )
        .expect_err("外部依赖缺 endpoint");
        assert!(
            error
                .iter()
                .any(|issue| matches!(issue, CompileIssue::MissingEndpoint { .. })),
            "{error:?}"
        );
        let _ = QuestionKind::Other;
    }

    fn valid_draft_json_with(from: &str, to: &str) -> String {
        super::super::tests::valid_json().replace(from, to)
    }
}
