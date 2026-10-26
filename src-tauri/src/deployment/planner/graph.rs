//! 把**通过校验的** AI 草案映射成确定性的计划图输入（纯函数）。
//!
//! # 这里没有 AI 的自由度
//!
//! 草案里唯一被采纳的是"有哪几个服务、每个服务什么运行方式、要不要证书"，
//! 而这些都要先过 [`super::validate_draft`]。映射表本身是**写死的**：
//! `DockerImage → 拉镜像`、`StaticSite → 静态站点`，没有任何"模型说了算"的分支。
//!
//! 节点与 `params_json` 由 [`crate::deployment::proposal::workflow`] 生成 ——
//! 那是 P5.3 就存在的确定性构造器，本模块**不重新发明**一套。
//!
//! # 制品是否存在不在这里判断
//!
//! 映射只回答"打算怎么搬"，**不回答"搬得动吗"**。镜像/制品是否真实存在，
//! 由 [`crate::deployment::session::confirm`] 的预检门禁在服务器上核实 ——
//! 计划阶段看不到服务器，就不该假装看得见。

use crate::deployment::proposal::model::TopologyKind;
use crate::deployment::proposal::rules::ArtifactDisposition;
use crate::deployment::proposal::workflow::{WorkflowInputs, WorkflowService};

use super::model::{AiDeploymentDraft, DraftRuntime, DraftService};

/// 映射结果（自带所有权，方便调用方先存下来再借给 `workflow::build`）。
pub struct WorkflowPlan {
    pub topology: TopologyKind,
    pub services: Vec<WorkflowService>,
    /// 要不要签发证书（`ssl_mode` 不是 `none` 就要）。
    pub certificate_required: bool,
    /// 有没有自建数据库（决定要不要 `DatabaseMigration` 节点）。
    pub self_hosted_database: bool,
    /// 有服务声明了健康检查就做。
    pub require_health_check: bool,
    /// 保守起见一律要求可回滚 —— 少一个回滚选项比多一个安全。
    pub require_rollback: bool,
}

/// 草案 → 工作流输入。
///
/// `draft` 必须**已经过** [`super::validate_draft`]；本函数不再重复校验，
/// 但也不会因为脏数据 panic（缺的字段退化成"不做健康检查"这类安全侧）。
pub fn to_workflow_plan(draft: &AiDeploymentDraft) -> WorkflowPlan {
    let services: Vec<WorkflowService> = draft.services.iter().map(map_service).collect();
    let certificate_required = draft
        .ssl_intent
        .as_ref()
        .map(|ssl| ssl.mode != crate::deployment::model::SslMode::None)
        .unwrap_or(false);
    // 「有没有自建数据库」只从**依赖声明**里推断：`kind == "database"` 且不是外部托管。
    // 不靠服务名猜（`db` / `mysql` / `pg`… 什么写法都有，猜就是埋雷）。
    // 判断不了就不加迁移节点 —— 少一个节点安全，漏一个迁移会由 preflight 报出来。
    let self_hosted_database = draft
        .dependency_decisions
        .iter()
        .any(|dependency| dependency.kind == "database" && !dependency.external);
    WorkflowPlan {
        topology: draft.topology,
        services,
        certificate_required,
        self_hosted_database,
        require_health_check: draft
            .services
            .iter()
            .any(|service| service.health_path.is_some()),
        require_rollback: true,
    }
}

/// 借给 `workflow::build` 用（[`WorkflowPlan`] → `WorkflowInputs`）。
pub fn as_inputs<'a>(plan: &'a WorkflowPlan) -> WorkflowInputs<'a> {
    WorkflowInputs {
        topology: plan.topology,
        services: &plan.services,
        certificate_required: plan.certificate_required,
        self_hosted_database: plan.self_hosted_database,
        require_health_check: plan.require_health_check,
        require_rollback: plan.require_rollback,
    }
}

fn is_external(service: &DraftService) -> bool {
    service.runtime == DraftRuntime::ExternalManaged
}

fn map_service(service: &DraftService) -> WorkflowService {
    let key = crate::deployment::proposal::workflow::node_key_for(&service.name);
    let container = matches!(
        service.runtime,
        DraftRuntime::DockerImage | DraftRuntime::DockerCompose
    );
    let static_files = service.runtime == DraftRuntime::StaticSite;
    let external = is_external(service);
    // 制品处置是**写死的映射表**，不是模型建议。
    let disposition = match service.runtime {
        // 容器镜像：从镜像仓库拉，模型不能编镜像名（`validate_draft` 已拦）。
        DraftRuntime::DockerImage => ArtifactDisposition::Pull,
        // compose 项目：上传一份 compose 包。
        DraftRuntime::DockerCompose => ArtifactDisposition::Extract,
        // 外部托管：不用搬。
        DraftRuntime::ExternalManaged => ArtifactDisposition::None,
        // 静态站点与各类进程：上传产物。
        DraftRuntime::StaticSite
        | DraftRuntime::NodeProcess
        | DraftRuntime::JavaProcess
        | DraftRuntime::PythonProcess
        | DraftRuntime::GoProcess
        | DraftRuntime::PhpProcess => ArtifactDisposition::Upload,
    };
    WorkflowService {
        key,
        name: service.name.clone(),
        role: format!("{:?}", service.service_kind),
        disposition,
        env_keys: service.env_keys.clone(),
        static_files,
        container,
        external,
        health_target: health_target(service),
    }
}

/// 健康检查目标：优先用声明的路径（可带端口），没有就只记路径。
fn health_target(service: &DraftService) -> Option<String> {
    let path = service.health_path.as_ref()?;
    Some(match service.port {
        Some(port) if !path.contains(':') => format!("127.0.0.1:{port}{path}"),
        _ => path.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::model::SslMode;

    /// 用 JSON 造草案：字段多，逐个手写容易漏掉必填项。
    fn draft(json: &str) -> AiDeploymentDraft {
        serde_json::from_str(json).expect("草案应当可解析")
    }

    /// 造一个服务条目。`service_kind` 必须与 `runtime` 对得上（Schema 是 snake_case）。
    fn service(runtime: &str, name: &str) -> String {
        let kind = match runtime {
            "static_site" => "static_nginx",
            "external_managed" => "external_managed",
            "docker_compose" => "docker_compose",
            _ => "docker_image",
        };
        format!(
            r#"{{"name":"{name}","service_kind":"{kind}","runtime":"{runtime}","port":8080,"health_path":"/healthz","env_keys":["APP_ENV"]}}"#
        )
    }

    #[test]
    fn a_container_service_becomes_a_pull_disposition() {
        let draft = draft(&format!(
            r#"{{"summary":"s","topology":"docker_compose","services":[{}],"risks":[]}}"#,
            service("docker_image", "api")
        ));
        let plan = to_workflow_plan(&draft);
        let api = &plan.services[0];
        assert_eq!(api.disposition, ArtifactDisposition::Pull);
        assert!(api.container);
        assert!(!api.static_files);
        assert_eq!(api.env_keys, vec!["APP_ENV".to_string()]);
    }

    #[test]
    fn a_static_site_is_not_a_container_and_still_needs_its_files() {
        let draft = draft(&format!(
            r#"{{"summary":"s","topology":"static_nginx","services":[{}],"risks":[]}}"#,
            service("static_site", "web")
        ));
        let plan = to_workflow_plan(&draft);
        assert!(plan.services[0].static_files);
        assert!(!plan.services[0].container);
        assert_eq!(
            plan.services[0].disposition,
            ArtifactDisposition::Upload,
            "静态文件要上传，不能凭空 Pull"
        );
    }

    #[test]
    fn an_external_managed_service_needs_no_artifact_at_all() {
        let draft = draft(&format!(
            r#"{{"summary":"s","topology":"docker_compose","services":[{}],"risks":[]}}"#,
            service("external_managed", "redis")
        ));
        let plan = to_workflow_plan(&draft);
        assert!(plan.services[0].external);
        assert_eq!(plan.services[0].disposition, ArtifactDisposition::None);
    }

    #[test]
    fn the_health_target_keeps_the_declared_path_and_port() {
        let draft = draft(&format!(
            r#"{{"summary":"s","topology":"docker_compose","services":[{}],"risks":[]}}"#,
            service("docker_image", "api")
        ));
        let plan = to_workflow_plan(&draft);
        assert_eq!(
            plan.services[0].health_target.as_deref(),
            Some("127.0.0.1:8080/healthz")
        );
        assert!(plan.require_health_check);
    }

    #[test]
    fn a_certificate_is_only_required_when_ssl_is_not_none() {
        let plain = draft(&format!(
            r#"{{"summary":"s","topology":"docker_compose","services":[{}],"ssl_intent":{{"mode":"none"}},"risks":[]}}"#,
            service("docker_image", "api")
        ));
        assert!(!to_workflow_plan(&plain).certificate_required);
        // 没写 ssl_intent 也一样不签。
        assert!(
            !to_workflow_plan(&draft(&format!(
                r#"{{"summary":"s","topology":"docker_compose","services":[{}],"risks":[]}}"#,
                service("docker_image", "api")
            )))
            .certificate_required
        );

        let tls = draft(&format!(
            r#"{{"summary":"s","topology":"docker_compose","services":[{}],"ssl_intent":{{"mode":"acme"}},"risks":[]}}"#,
            service("docker_image", "api")
        ));
        assert!(to_workflow_plan(&tls).certificate_required);
    }

    #[test]
    fn a_self_hosted_database_is_inferred_from_dependency_declarations_only() {
        // 自建：kind=database 且不是外部托管。
        let self_hosted = draft(&format!(
            r#"{{"summary":"s","topology":"docker_compose","services":[{}],"dependency_decisions":[{{"from_service":"api","to_service":"db","kind":"database","required":true,"external":false}}],"risks":[]}}"#,
            service("docker_image", "api")
        ));
        assert!(to_workflow_plan(&self_hosted).self_hosted_database);

        // 托管数据库不算 —— 迁移不是我们的事。
        let managed = draft(&format!(
            r#"{{"summary":"s","topology":"docker_compose","services":[{}],"dependency_decisions":[{{"from_service":"api","to_service":"rds","kind":"database","required":true,"external":true}}],"risks":[]}}"#,
            service("docker_image", "api")
        ));
        assert!(!to_workflow_plan(&managed).self_hosted_database);
    }

    #[test]
    fn the_mapping_is_deterministic() {
        let json = format!(
            r#"{{"summary":"s","topology":"docker_compose","services":[{},{}],"risks":[]}}"#,
            service("docker_image", "api"),
            service("static_site", "web")
        );
        let parsed = draft(&json);
        let first = to_workflow_plan(&parsed);
        let second = to_workflow_plan(&parsed);
        assert_eq!(first.topology, second.topology);
        assert_eq!(first.services.len(), second.services.len());
        for (left, right) in first.services.iter().zip(second.services.iter()) {
            assert_eq!(left.key, right.key);
            assert_eq!(left.disposition, right.disposition);
            assert_eq!(left.health_target, right.health_target);
        }
        assert_eq!(first.require_rollback, true, "默认一律要求可回滚");
        assert!(matches!(SslMode::Acme, SslMode::Acme), "占位：枚举可见");
    }
}
