//! 实例业务分类器：把收集器产出的 [`DeploymentInstance`] 划分为
//! **应用服务 / 基础设施 / 系统组件 / 待归类** 四个互斥集合。
//!
//! # 规则（优先级从高到低）
//!
//! 1. **系统组件**：`system_owned=true`（pause 沙箱、`kube-system` 命名空间、
//!    系统自带单元/平台镜像）→ `System`，默认不进任何顶层 Tab。
//! 2. **明确基础设施**：目录表（`service_catalog::CATALOG`）凭镜像 / 单元 /
//!    可执行文件**精确识别**出 MySQL、Redis、MinIO、共享 Nginx、Prometheus…
//!    → `Infrastructure` + `infrastructure_category`。即使它属于某个 Compose
//!    项目，也仍是该项目的基础设施依赖。**特例**：Nginx 若只服务于某个项目
//!    （挂载/关联该项目目录），在评分期升级为项目专属前端容器（见下）。
//! 3. **业务应用**（需项目证据，评分期回填）：
//!    - 源码目录命中项目标志（package.json / pom.xml / …）；
//!    - 或运行时技术（node/java/…）+ 宿主工作目录/源码路径。
//!    → `Application`，组件角色按 next/nuxt 配置判 frontend，其余 backend。
//! 4. **未知**：有实例但证据不足 → `Unknown`（"待归类"），**绝不**默认归基础设施。
//!
//! 铁律：分类只在后端完成，React 只展示结果；每个结论都带证据与置信度。

use std::collections::BTreeMap;

use crate::deployment_collector::DeploymentInstance;
use crate::service_catalog::{
    find_catalog_entry, ClassificationConfidence, ClassificationEvidence, ComponentRole,
    DetectedTechnology, InfrastructureCategory, InstanceOwnership, WorkloadRole,
};

/// 分类证据的来源标签常量。
const SRC_IMAGE: &str = "image";
const SRC_UNIT: &str = "unit";
const SRC_EXECUTABLE: &str = "executable";
const SRC_SYSTEM: &str = "system";
const SRC_RUNTIME: &str = "runtime";
const SRC_PROJECT_MARKER: &str = "project_marker";
const SRC_NGINX_ROOT: &str = "nginx_root";
const SRC_UNKNOWN: &str = "unknown";

/// 收集期初分类：只凭实例自带的镜像 / 单元 / 可执行 / 平台证据。
///
/// 项目证据（markers、候选关联）要等定向扫描与评分，之后由
/// [`apply_project_evidence`] 回填升级。本函数幂等。
pub fn classify_instance(instance: &mut DeploymentInstance) {
    if instance.workload_role != WorkloadRole::Unknown {
        return; // 已分类（幂等）
    }

    // 1. 系统组件。
    if instance.system_owned {
        instance.workload_role = WorkloadRole::System;
        instance.classification_confidence = ClassificationConfidence::High;
        instance.infrastructure_category = platform_category(&instance.kind);
        instance
            .classification_evidence
            .push(ClassificationEvidence::new(
                SRC_SYSTEM,
                "操作系统或容器平台自带组件".to_string(),
            ));
        return;
    }

    // 2. 明确基础设施（目录表精确识别）。
    if let Some(service) = instance.service.clone() {
        if let Some(entry) = find_catalog_entry(&service.id) {
            instance.workload_role = WorkloadRole::Infrastructure;
            instance.infrastructure_category = Some(entry.infrastructure_category);
            instance.component_role = entry.component_role;
            instance.ownership = InstanceOwnership::Shared;
            instance.classification_confidence = ClassificationConfidence::High;
            let source = match instance.kind.as_str() {
                "docker" | "k8s" => SRC_IMAGE,
                "systemd" => SRC_UNIT,
                _ => SRC_EXECUTABLE,
            };
            instance
                .classification_evidence
                .push(ClassificationEvidence::new(
                    source,
                    format!(
                        "识别为 {}（{}）",
                        entry.label,
                        entry.infrastructure_category.label()
                    ),
                ));
            return;
        }
    }

    // 3. 运行时技术 + 宿主路径线索（systemd 收集器只保留业务路径单元；
    //    docker 容器需要 working_directories/source_paths 提供 bind-mount/Compose 线索）。
    if let Some(technology) = instance.technology.clone() {
        let has_host_clue =
            !instance.working_directories.is_empty() || !instance.source_paths.is_empty();
        if has_host_clue {
            instance.workload_role = WorkloadRole::Application;
            instance.component_role = ComponentRole::Backend;
            instance.ownership = InstanceOwnership::ProjectScoped;
            instance.classification_confidence = ClassificationConfidence::Medium;
            instance
                .classification_evidence
                .push(ClassificationEvidence::new(
                    SRC_RUNTIME,
                    format!(
                        "运行时 {} 且关联宿主工作目录（待项目证据确认）",
                        technology.label
                    ),
                ));
            return;
        }
    }

    // 4. 证据不足：待归类（绝不默认基础设施）。
    instance
        .classification_evidence
        .push(ClassificationEvidence::new(
            SRC_UNKNOWN,
            "未识别出服务或项目关联，保持待归类".to_string(),
        ));
}

/// 评分期回填：用项目标志（定向扫描结果）把"待归类"升级为应用服务，
/// 并处理"项目专属 Nginx 前端容器"的特殊升级路径。
///
/// `markers_by_path`：目录 → 命中的项目标志文件列表（值为空表示无标志）。
pub fn apply_project_evidence(
    instances: &mut [DeploymentInstance],
    markers_by_path: &BTreeMap<String, Vec<String>>,
) {
    for instance in instances.iter_mut() {
        let Some(hit) = project_hit(instance, markers_by_path) else {
            continue;
        };
        match instance.workload_role {
            // 待归类 → 应用服务（源码目录命中项目标志是强证据）。
            WorkloadRole::Unknown => {
                instance.workload_role = WorkloadRole::Application;
                instance.component_role = component_for_markers(&hit.markers, instance);
                instance.ownership = InstanceOwnership::ProjectScoped;
                instance.classification_confidence = ClassificationConfidence::High;
                instance
                    .classification_evidence
                    .push(ClassificationEvidence::new(
                        SRC_PROJECT_MARKER,
                        format!("源码目录 {} 命中项目标志", hit.path),
                    ));
            }
            // 已凭运行时 + 工作目录初判为应用：marker 证据进一步确认，
            // 细化组件角色并提升置信度。
            WorkloadRole::Application => {
                instance.component_role = component_for_markers(&hit.markers, instance);
                instance.ownership = InstanceOwnership::ProjectScoped;
                instance.classification_confidence = ClassificationConfidence::High;
                instance
                    .classification_evidence
                    .push(ClassificationEvidence::new(
                        SRC_PROJECT_MARKER,
                        format!("源码目录 {} 命中项目标志", hit.path),
                    ));
            }
            // 共享 Nginx 若只服务于某项目（root/挂载命中项目目录）→ 项目专属前端容器。
            WorkloadRole::Infrastructure if is_nginx(instance) => {
                instance.workload_role = WorkloadRole::Application;
                instance.component_role = ComponentRole::Frontend;
                instance.ownership = InstanceOwnership::ProjectScoped;
                instance.classification_confidence = ClassificationConfidence::High;
                instance.infrastructure_category = None;
                instance.technology = Some(DetectedTechnology {
                    id: "nginx".to_string(),
                    label: "Nginx".to_string(),
                });
                instance
                    .classification_evidence
                    .push(ClassificationEvidence::new(
                        SRC_NGINX_ROOT,
                        format!("Nginx 提供项目 {} 的站点/构建产物", hit.path),
                    ));
            }
            // 已确认的基础设施（MySQL/Redis…）不因路径线索翻转。
            _ => {}
        }
    }
}

/// 回填 `linked_project_ids`（项目路径 ↔ 实例 双向关联）。
pub fn link_projects(instances: &mut [DeploymentInstance], project_paths: &[String]) {
    for instance in instances.iter_mut() {
        for path in project_paths {
            if instance_related_path(instance, path)
                && !instance.linked_project_ids.iter().any(|p| p == path)
            {
                instance.linked_project_ids.push(path.clone());
            }
        }
    }
}

/// 回填网关路由的 `linked_project_id`：路由的宿主路径（静态 root /
/// 代理后端 cwd）命中哪个项目目录，路由就属于哪个项目（首条命中为准）。
pub fn link_gateway_routes(
    routes: &mut [crate::deployment_collector::GatewayRoute],
    project_paths: &[String],
) {
    for route in routes.iter_mut() {
        if route.linked_project_id.is_some() {
            continue;
        }
        for path in project_paths {
            if route.linked_paths.iter().any(|p| paths_related(p, path)) {
                route.linked_project_id = Some(path.clone());
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

struct ProjectHit {
    path: String,
    markers: Vec<String>,
}

/// 实例的源码/工作目录是否命中某个有项目标志的目录。
fn project_hit(
    instance: &DeploymentInstance,
    markers_by_path: &BTreeMap<String, Vec<String>>,
) -> Option<ProjectHit> {
    for candidate_path in instance
        .source_paths
        .iter()
        .chain(instance.working_directories.iter())
    {
        for (path, markers) in markers_by_path {
            if markers.is_empty() {
                continue;
            }
            if paths_related(path, candidate_path) {
                return Some(ProjectHit {
                    path: path.clone(),
                    markers: markers.clone(),
                });
            }
        }
    }
    None
}

/// 两个宿主路径是否指向同一棵项目子树（相等或一方是另一方的前缀目录）。
fn paths_related(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim_end_matches('/'), b.trim_end_matches('/'));
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

fn instance_related_path(instance: &DeploymentInstance, path: &str) -> bool {
    instance
        .source_paths
        .iter()
        .chain(instance.working_directories.iter())
        .any(|p| paths_related(p, path))
}

fn is_nginx(instance: &DeploymentInstance) -> bool {
    instance.service.as_ref().is_some_and(|s| s.id == "nginx")
        || instance
            .technology
            .as_ref()
            .is_some_and(|t| t.id == "nginx")
}

/// 平台类实例（docker/k8s 沙箱）的基础设施类别。
fn platform_category(kind: &str) -> Option<InfrastructureCategory> {
    match kind {
        "docker" | "k8s" | "containerd" => Some(InfrastructureCategory::ContainerPlatform),
        _ => None,
    }
}

/// 根据项目标志细化组件角色：Next/Nuxt 配置文件 → 前端（SSR）；
/// 其余（API/单体）→ 后端。Worker/定时任务无法从静态标志判定，保持后端。
fn component_for_markers(markers: &[String], instance: &DeploymentInstance) -> ComponentRole {
    let is_ssr = markers.iter().any(|marker| {
        let name = marker
            .rsplit('/')
            .next()
            .unwrap_or(marker)
            .to_ascii_lowercase();
        name.starts_with("next.config") || name.starts_with("nuxt.config")
    });
    if is_ssr {
        return ComponentRole::Frontend;
    }
    // PM2/Nginx 之外的运行时默认后端。
    let _ = instance;
    ComponentRole::Backend
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment_collector::DeploymentInstance;
    use crate::service_catalog::{InstanceRuntime, ServiceGroup};

    fn base_instance(id: &str, kind: &str, name: &str) -> DeploymentInstance {
        DeploymentInstance {
            id: id.to_string(),
            kind: kind.to_string(),
            name: name.to_string(),
            status: "running".to_string(),
            runtime: InstanceRuntime::Host,
            image: None,
            service: None,
            system_owned: false,
            ports: Vec::new(),
            working_directories: Vec::new(),
            config_files: Vec::new(),
            source_paths: Vec::new(),
            source_known: false,
            detail: String::new(),
            ..Default::default()
        }
    }

    fn markers(pairs: &[(&str, Vec<&str>)]) -> BTreeMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(path, files)| {
                (
                    (*path).to_string(),
                    files.iter().map(|f| f.to_string()).collect(),
                )
            })
            .collect()
    }

    fn with_image(mut instance: DeploymentInstance, image: &str) -> DeploymentInstance {
        let identity = crate::service_catalog::identify_image(image);
        instance.image = Some(image.to_string());
        instance.service = identity.clone().map(|i| i.detected());
        instance.technology = identity
            .map(|i| DetectedTechnology {
                id: i.id.to_string(),
                label: i.label.to_string(),
            })
            .or_else(|| crate::service_catalog::identify_runtime_tech(image));
        instance
    }

    /// 1. MySQL → infrastructure/database。
    #[test]
    fn mysql_is_infrastructure_database() {
        let mut instance = with_image(base_instance("c1", "docker", "db"), "mysql:8.0");
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::Infrastructure);
        assert_eq!(
            instance.infrastructure_category,
            Some(InfrastructureCategory::Database)
        );
        assert_eq!(instance.component_role, ComponentRole::Database);
        assert_eq!(instance.ownership, InstanceOwnership::Shared);
        assert_eq!(
            instance.classification_confidence,
            ClassificationConfidence::High
        );
    }

    /// 2. Redis → infrastructure/cache。
    #[test]
    fn redis_is_infrastructure_cache() {
        let mut instance = with_image(base_instance("c2", "docker", "cache"), "redis:7");
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::Infrastructure);
        assert_eq!(
            instance.infrastructure_category,
            Some(InfrastructureCategory::Cache)
        );
    }

    /// 3. MinIO → infrastructure/object_storage。
    #[test]
    fn minio_is_infrastructure_object_storage() {
        let mut instance = with_image(base_instance("c3", "docker", "s3"), "minio/minio:latest");
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::Infrastructure);
        assert_eq!(
            instance.infrastructure_category,
            Some(InfrastructureCategory::ObjectStorage)
        );
    }

    /// 4. Kafka → infrastructure/messaging。
    #[test]
    fn kafka_is_infrastructure_messaging() {
        let mut instance = with_image(base_instance("c4", "docker", "mq"), "bitnami/kafka:3.6");
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::Infrastructure);
        assert_eq!(
            instance.infrastructure_category,
            Some(InfrastructureCategory::Messaging)
        );
    }

    /// 5. Elasticsearch → infrastructure/search。
    #[test]
    fn elasticsearch_is_infrastructure_search() {
        let mut instance = with_image(
            base_instance("c5", "docker", "search"),
            "elasticsearch:8.11",
        );
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::Infrastructure);
        assert_eq!(
            instance.infrastructure_category,
            Some(InfrastructureCategory::Search)
        );
    }

    /// 6. 共享 Nginx（无项目关联）→ infrastructure/gateway。
    #[test]
    fn shared_nginx_is_infrastructure_gateway() {
        let mut instance = with_image(base_instance("c6", "docker", "proxy"), "nginx:1.24");
        instance.working_directories.push("/srv/web".to_string());
        instance.source_paths.push("/srv/web".to_string());
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::Infrastructure);
        assert_eq!(
            instance.infrastructure_category,
            Some(InfrastructureCategory::Gateway)
        );
        assert_eq!(instance.ownership, InstanceOwnership::Shared);

        // 项目证据命中后升级为项目专属前端容器。
        let evidence = markers(&[("/srv/web", vec!["package.json"])]);
        apply_project_evidence(std::slice::from_mut(&mut instance), &evidence);
        assert_eq!(instance.workload_role, WorkloadRole::Application);
        assert_eq!(instance.component_role, ComponentRole::Frontend);
        assert_eq!(instance.ownership, InstanceOwnership::ProjectScoped);
        assert_eq!(
            instance.technology.as_ref().map(|t| t.id.as_str()),
            Some("nginx")
        );
    }

    /// 7. Node API 关联 package.json → application/backend。
    #[test]
    fn node_api_with_package_json_is_application_backend() {
        let mut instance = with_image(base_instance("c7", "docker", "api"), "node:20-alpine");
        instance.working_directories.push("/srv/api".to_string());
        instance.source_paths.push("/srv/api".to_string());
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::Application);
        assert_eq!(instance.component_role, ComponentRole::Backend);

        let evidence = markers(&[("/srv/api", vec!["package.json"])]);
        apply_project_evidence(std::slice::from_mut(&mut instance), &evidence);
        assert_eq!(instance.workload_role, WorkloadRole::Application);
        assert_eq!(instance.component_role, ComponentRole::Backend);
        assert_eq!(
            instance.classification_confidence,
            ClassificationConfidence::High
        );
    }

    /// 8. Next.js SSR → application/frontend。
    #[test]
    fn nextjs_ssr_is_application_frontend() {
        let mut instance = with_image(base_instance("c8", "docker", "web"), "node:20-alpine");
        instance.working_directories.push("/srv/web".to_string());
        instance.source_paths.push("/srv/web".to_string());
        let evidence = markers(&[("/srv/web", vec!["package.json", "next.config.mjs"])]);
        apply_project_evidence(std::slice::from_mut(&mut instance), &evidence);
        assert_eq!(instance.workload_role, WorkloadRole::Application);
        assert_eq!(instance.component_role, ComponentRole::Frontend);
        assert_eq!(
            instance.technology.as_ref().map(|t| t.id.as_str()),
            Some("node")
        );
    }

    /// 9. PM2 Node 服务 → application。
    #[test]
    fn pm2_node_service_is_application() {
        let mut instance = base_instance("systemd:pm2-root", "systemd", "pm2-root.service");
        instance
            .working_directories
            .push("/srv/node-app".to_string());
        instance.source_paths.push("/srv/node-app".to_string());
        // ExecStart=/usr/bin/pm2 → 运行时技术 node。
        instance.technology = crate::service_catalog::identify_runtime_tech("/usr/bin/pm2");
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::Application);
        assert_eq!(instance.component_role, ComponentRole::Backend);
        assert_eq!(
            instance.technology.as_ref().map(|t| t.id.as_str()),
            Some("node")
        );
    }

    /// 10. 未知自定义容器 → unknown，绝不是 infrastructure。
    #[test]
    fn unknown_custom_container_is_unknown_not_infrastructure() {
        let mut instance = base_instance("c10", "docker", "company-api");
        instance.image = Some("registry.local/team/custom-api:v3".to_string());
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::Unknown);
        assert_ne!(instance.workload_role, WorkloadRole::Infrastructure);
        assert!(instance.infrastructure_category.is_none());
        assert_eq!(
            instance.classification_confidence,
            ClassificationConfidence::Low
        );
    }

    /// 11. `company/redis-proxy-api` 不能仅凭字符串判成 Redis。
    #[test]
    fn redis_proxy_api_is_not_redis() {
        let mut instance = with_image(
            base_instance("c11", "docker", "redis-proxy-api"),
            "company/redis-proxy-api:1.0",
        );
        classify_instance(&mut instance);
        assert_ne!(instance.workload_role, WorkloadRole::Infrastructure);
        assert_eq!(instance.workload_role, WorkloadRole::Unknown);
        assert_ne!(
            instance.technology.as_ref().map(|t| t.id.as_str()),
            Some("redis")
        );
    }

    /// 12. `mysql-backup-worker.service` 不能仅凭字符串判成 MySQL。
    #[test]
    fn mysql_backup_worker_unit_is_not_mysql() {
        let mut instance = base_instance(
            "systemd:mysql-backup-worker",
            "systemd",
            "mysql-backup-worker.service",
        );
        instance.working_directories.push("/srv/jobs".to_string());
        instance.source_paths.push("/srv/jobs".to_string());
        assert!(crate::service_catalog::identify_unit("mysql-backup-worker.service").is_none());
        let evidence = markers(&[("/srv/jobs", vec!["pyproject.toml"])]);
        apply_project_evidence(std::slice::from_mut(&mut instance), &evidence);
        assert_eq!(instance.workload_role, WorkloadRole::Application);
        assert_ne!(
            instance.technology.as_ref().map(|t| t.id.as_str()),
            Some("mysql")
        );
    }

    /// 13. React/Vue 静态项目不生成虚假 Node 服务：Nginx root 命中项目 →
    /// 项目专属 Nginx 前端容器（technology=nginx，不是 node）。
    #[test]
    fn static_frontend_project_gets_nginx_container_not_fake_node_service() {
        let mut instance = with_image(base_instance("c13", "docker", "web-nginx"), "nginx:1.24");
        instance
            .working_directories
            .push("/var/www/web".to_string());
        instance.source_paths.push("/var/www/web".to_string());
        classify_instance(&mut instance);
        // 无 markers 时先是共享网关…
        assert_eq!(instance.workload_role, WorkloadRole::Infrastructure);

        let evidence = markers(&[("/var/www/web", vec!["package.json", "vite.config.ts"])]);
        apply_project_evidence(std::slice::from_mut(&mut instance), &evidence);
        // …命中项目标志后升级为项目专属前端容器，技术仍是 Nginx 而非 Node。
        assert_eq!(instance.workload_role, WorkloadRole::Application);
        assert_eq!(instance.component_role, ComponentRole::Frontend);
        assert_eq!(
            instance.technology.as_ref().map(|t| t.id.as_str()),
            Some("nginx")
        );
    }

    /// 14. 项目专用 Nginx 前端容器归 application/frontend（与 13 互补：初始即有项目路径）。
    #[test]
    fn project_scoped_nginx_frontend_container() {
        let mut instance = with_image(base_instance("c14", "docker", "fe-nginx"), "nginx:alpine");
        instance.working_directories.push("/opt/portal".to_string());
        let evidence = markers(&[("/opt/portal", vec!["package.json"])]);
        classify_instance(&mut instance);
        apply_project_evidence(std::slice::from_mut(&mut instance), &evidence);
        assert_eq!(instance.workload_role, WorkloadRole::Application);
        assert_eq!(instance.component_role, ComponentRole::Frontend);
        assert_eq!(instance.ownership, InstanceOwnership::ProjectScoped);
    }

    /// 15. 系统服务归 system（pause 沙箱 / 平台组件）。
    #[test]
    fn system_owned_instance_is_system() {
        let mut instance = base_instance("sandbox-1", "docker", "k8s_POD_x_default");
        instance.system_owned = true;
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::System);
        assert_eq!(
            instance.infrastructure_category,
            Some(InfrastructureCategory::ContainerPlatform)
        );
        assert_eq!(
            instance.classification_confidence,
            ClassificationConfidence::High
        );
    }

    /// 16. 旧 project_inventory JSON（没有新字段）可以继续反序列化。
    #[test]
    fn legacy_instance_json_still_deserializes() {
        let legacy = r#"{
            "id": "docker:old",
            "kind": "docker",
            "name": "old-container",
            "status": "running",
            "runtime": "container",
            "system_owned": false,
            "ports": [8080],
            "working_directories": ["/srv/app"],
            "config_files": [],
            "source_paths": ["/srv/app"],
            "source_known": true,
            "detail": "旧快照"
        }"#;
        let instance: DeploymentInstance = serde_json::from_str(legacy).expect("旧快照必须能解析");
        assert_eq!(instance.workload_role, WorkloadRole::Unknown);
        assert_eq!(instance.component_role, ComponentRole::Unknown);
        assert_eq!(instance.ownership, InstanceOwnership::Unknown);
        assert_eq!(
            instance.classification_confidence,
            ClassificationConfidence::Low
        );
        assert!(instance.infrastructure_category.is_none());
        assert!(instance.technology.is_none());
        assert!(instance.linked_project_ids.is_empty());
        assert!(instance.classification_evidence.is_empty());
    }

    /// 新序列化字段采用 snake_case，且 `infrastructure_category`/`technology`
    /// 在未设置时不出现在 JSON 里（skip_serializing_if）。
    #[test]
    fn classification_fields_roundtrip() {
        let mut instance = with_image(base_instance("rt", "docker", "db"), "mysql:8");
        classify_instance(&mut instance);
        let json = serde_json::to_string(&instance).unwrap();
        assert!(
            json.contains("\"workload_role\":\"infrastructure\""),
            "{json}"
        );
        assert!(
            json.contains("\"infrastructure_category\":\"database\""),
            "{json}"
        );
        assert!(json.contains("\"ownership\":\"shared\""), "{json}");

        let mut plain = base_instance("p", "docker", "x");
        classify_instance(&mut plain);
        let json = serde_json::to_string(&plain).unwrap();
        assert!(json.contains("\"workload_role\":\"unknown\""), "{json}");
        assert!(!json.contains("infrastructure_category"), "{json}");
    }

    /// 项目链接回填：只关联路径相关的实例，且幂等去重。
    #[test]
    fn link_projects_is_precise_and_idempotent() {
        let mut app = with_image(base_instance("app", "docker", "api"), "node:20");
        app.working_directories.push("/srv/api".to_string());
        let db = with_image(base_instance("db", "docker", "db"), "mysql:8");
        let mut instances = vec![app, db];
        let projects = vec!["/srv/api".to_string(), "/srv/api/sub".to_string()];
        link_projects(&mut instances, &projects);
        link_projects(&mut instances, &projects);
        assert_eq!(instances[0].linked_project_ids.len(), 2);
        assert!(instances[1].linked_project_ids.is_empty());
    }

    /// 顶层互斥的最终保证：分类完成后，一个实例只能有一个 workload_role，
    /// 且 group（UI 配色）不再参与分类。
    #[test]
    fn group_is_decoupled_from_classification() {
        let mut instance = with_image(base_instance("g", "docker", "db"), "mysql:8");
        assert_eq!(
            instance.service.as_ref().unwrap().group,
            ServiceGroup::Database
        );
        classify_instance(&mut instance);
        assert_eq!(instance.workload_role, WorkloadRole::Infrastructure);
        // 业务应用条目（group=Application）在目录里不存在，应用判定走 runtime/marker 证据。
        assert!(find_catalog_entry("node").is_none());
    }
}
