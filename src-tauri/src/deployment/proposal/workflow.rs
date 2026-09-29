//! 由拓扑 + 服务推导**部署工作流（图）**。
//!
//! # 三条纪律
//!
//! 1. **只产出 P5.0 的动作字典**（[`PlanActionKind`]）：节点不是命令，
//!    参数是 `params_json`（结构化），保存前还要过
//!    `validate::validate_params_json`。
//! 2. **确定性 id**：节点 id 就是它的 `node_key`，边 id 由两端 key 拼出来 ——
//!    同一份输入两次生成得到逐字节相同的图（方案哈希要复现，就不能用 uuid）。
//! 3. **回滚是独立汇点**：主链一路 `on_success` 走到"激活版本"，
//!    回滚节点只由**变更类节点**的 `on_failure` 边指向。这样"成功了还会回滚"
//!    这种荒唐路径在图上根本不存在（而且 `validate_plan_graph` 会验它是 DAG）。

use std::collections::BTreeSet;

use serde_json::json;

use super::model::{ProposedWorkflow, Statement, TopologyKind};
use super::rules::ArtifactDisposition;
use crate::deployment::model::{EdgeCondition, PlanActionKind, PlanEdge, PlanNode, RiskLevel};
use crate::deployment::validate;

/// 节点 key 的安全化：P5.0 要求 `[a-z0-9_]`。
///
/// 对外暴露：`rules` 用它给工作流服务起 key，两边必须是同一个函数，
/// 否则 `service_unit_id` 与节点就对不上了。
pub fn node_key_for(value: &str) -> String {
    let mut out = String::new();
    let mut last_underscore = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_underscore = false;
        } else if !last_underscore {
            out.push('_');
            last_underscore = true;
        }
    }
    let trimmed = out.trim_matches('_');
    let trimmed = if trimmed.len() > 48 {
        &trimmed[..48]
    } else {
        trimmed
    };
    if trimmed.is_empty() {
        "step".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 工作流构建器。
pub struct WorkflowInputs<'a> {
    pub topology: TopologyKind,
    /// 每个待部署服务：(规范化名字, 展示名, 运行方式大类, 制品处置, 环境变量名)。
    pub services: &'a [WorkflowService],
    /// 是否需要签发证书。
    pub certificate_required: bool,
    /// 是否存在自建（非外部托管）数据库。
    pub self_hosted_database: bool,
    /// 是否要求健康检查。
    pub require_health_check: bool,
    /// 是否要求可回滚。
    pub require_rollback: bool,
}

/// 工作流里需要的一个服务（由 `rules` 从 `ServiceUnit` 归一化而来）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowService {
    pub key: String,
    pub name: String,
    pub role: String,
    pub disposition: ArtifactDisposition,
    pub env_keys: Vec<String>,
    /// 是否静态（交给 Nginx 而不是进程）。
    pub static_files: bool,
    /// 是否是容器形态。
    pub container: bool,
    /// 是否是外部托管（不由本工具部署）。
    pub external: bool,
    /// 健康检查目标（`/healthz` 或 `127.0.0.1:3000`）；空 = 不做。
    pub health_target: Option<String>,
}

struct Builder {
    nodes: Vec<PlanNode>,
    edges: Vec<PlanEdge>,
}

impl Builder {
    fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
        }
    }

    fn push(
        &mut self,
        node_key: &str,
        title: &str,
        action: PlanActionKind,
        service_key: Option<&str>,
        params: serde_json::Value,
        skippable: bool,
    ) -> String {
        let key = node_key.to_string();
        let params_json = serde_json::to_string(&params).unwrap_or_else(|_| "{}".to_string());
        self.nodes.push(PlanNode {
            // id 就用 key：确定性、唯一、可被边直接引用。
            id: key.clone(),
            plan_id: String::new(),
            node_key: key.clone(),
            title: title.to_string(),
            action,
            service_unit_id: service_key.map(str::to_string),
            risk_level: action.default_risk(),
            approval_required: action.requires_approval(),
            skippable,
            params_json,
            position: self.nodes.len() as i64,
            created_at: 0,
            updated_at: 0,
        });
        key
    }

    fn chain(&mut self, from: &str, to: &str) {
        self.link(from, to, EdgeCondition::OnSuccess);
    }

    fn link(&mut self, from: &str, to: &str, condition: EdgeCondition) {
        let id = format!("edge_{from}_{to}_{}", condition_slug(condition));
        if self
            .edges
            .iter()
            .any(|edge| edge.from_node_id == from && edge.to_node_id == to)
        {
            return;
        }
        self.edges.push(PlanEdge {
            id,
            plan_id: String::new(),
            from_node_id: from.to_string(),
            to_node_id: to.to_string(),
            condition,
            created_at: 0,
        });
    }
}

fn condition_slug(condition: EdgeCondition) -> &'static str {
    match condition {
        EdgeCondition::Always => "always",
        EdgeCondition::OnSuccess => "success",
        EdgeCondition::OnFailure => "failure",
        EdgeCondition::Manual => "manual",
    }
}

/// 构建工作流。
pub fn build(inputs: &WorkflowInputs<'_>) -> ProposedWorkflow {
    let mut builder = Builder::new();
    let mut notes: Vec<Statement> = Vec::new();

    let mut cursor: Option<String> = None;
    let mut mutating: Vec<String> = Vec::new();

    let next = |builder: &mut Builder,
                cursor: &mut Option<String>,
                key: &str,
                title: &str,
                action: PlanActionKind,
                service: Option<&str>,
                params: serde_json::Value,
                skippable: bool| {
        let node = builder.push(key, title, action, service, params, skippable);
        if let Some(previous) = cursor.clone() {
            builder.chain(&previous, &node);
        }
        *cursor = Some(node.clone());
        node
    };

    // ---- 1. 依赖检查（永远第一步：先把"缺什么"摆出来）----
    next(
        &mut builder,
        &mut cursor,
        "check_dependencies",
        "Check server dependencies",
        PlanActionKind::CheckDependencies,
        None,
        json!({}),
        false,
    );

    let deployable: Vec<&WorkflowService> = inputs
        .services
        .iter()
        .filter(|service| !service.external)
        .collect();
    let external_count = inputs.services.len() - deployable.len();
    if external_count > 0 {
        notes.push(Statement::fact(
            "wf-external",
            format!(
                "{} 个外部托管服务只做依赖声明与健康检查，不进入工作流。",
                external_count
            ),
            vec![],
        ));
    }

    // ---- 2. 制品搬运 / 镜像 ----
    for service in &deployable {
        match service.disposition {
            ArtifactDisposition::Upload => {
                let node = next(
                    &mut builder,
                    &mut cursor,
                    &format!("upload_{}", service.key),
                    &format!("Upload artifact for {}", service.name),
                    PlanActionKind::UploadArtifact,
                    Some(&service.key),
                    json!({ "service": service.name }),
                    false,
                );
                mutating.push(node);
            }
            ArtifactDisposition::Extract => {
                let node = next(
                    &mut builder,
                    &mut cursor,
                    &format!("upload_{}", service.key),
                    &format!("Upload archive for {}", service.name),
                    PlanActionKind::UploadArtifact,
                    Some(&service.key),
                    json!({ "service": service.name }),
                    false,
                );
                mutating.push(node.clone());
                let extract = next(
                    &mut builder,
                    &mut cursor,
                    &format!("extract_{}", service.key),
                    &format!("Extract archive for {}", service.name),
                    PlanActionKind::ExtractArtifact,
                    Some(&service.key),
                    json!({ "service": service.name }),
                    false,
                );
                mutating.push(extract);
            }
            ArtifactDisposition::Pull => {
                let node = next(
                    &mut builder,
                    &mut cursor,
                    &format!("pull_{}", service.key),
                    &format!("Pull image for {}", service.name),
                    PlanActionKind::PullImage,
                    Some(&service.key),
                    json!({ "service": service.name }),
                    false,
                );
                mutating.push(node);
            }
            ArtifactDisposition::BuildImage => {
                let node = next(
                    &mut builder,
                    &mut cursor,
                    &format!("build_{}", service.key),
                    &format!("Build image for {}", service.name),
                    PlanActionKind::BuildImage,
                    Some(&service.key),
                    json!({ "service": service.name }),
                    false,
                );
                mutating.push(node);
            }
            ArtifactDisposition::None | ArtifactDisposition::AlreadyOnServer => {}
        }
    }

    // ---- 3. 配置 ----
    for service in &deployable {
        if service.env_keys.is_empty() {
            continue;
        }
        let node = next(
            &mut builder,
            &mut cursor,
            &format!("env_{}", service.key),
            &format!("Render environment for {}", service.name),
            PlanActionKind::RenderEnvFile,
            Some(&service.key),
            json!({ "service": service.name, "keys": service.env_keys }),
            false,
        );
        mutating.push(node);
    }

    // ---- 4. 数据迁移（自建数据库才有；且**必须人工审批**）----
    if inputs.self_hosted_database {
        let node = next(
            &mut builder,
            &mut cursor,
            "database_migration",
            "Run database migration",
            PlanActionKind::DatabaseMigration,
            None,
            json!({}),
            false,
        );
        mutating.push(node);
        notes.push(
            Statement::recommendation(
                "wf-migration",
                "数据库迁移是独立节点且必须人工审批：它通常不可逆，失败后回滚服务版本也回不来数据。",
                vec![],
            )
            .with_impact(super::model::StatementImpact::Blocking),
        );
    }

    // ---- 5. 服务编排 ----
    match inputs.topology {
        TopologyKind::StaticNginx => {
            for service in deployable.iter().filter(|service| service.static_files) {
                let node = next(
                    &mut builder,
                    &mut cursor,
                    &format!("nginx_site_{}", service.key),
                    &format!("Apply nginx site for {}", service.name),
                    PlanActionKind::ApplyNginxSite,
                    Some(&service.key),
                    json!({ "service": service.name }),
                    false,
                );
                mutating.push(node);
            }
        }
        TopologyKind::SystemdProcesses => {
            for service in &deployable {
                let node = next(
                    &mut builder,
                    &mut cursor,
                    &format!("provision_{}", service.key),
                    &format!("Provision unit for {}", service.name),
                    PlanActionKind::ProvisionService,
                    Some(&service.key),
                    json!({ "service": service.name }),
                    false,
                );
                mutating.push(node);
            }
        }
        TopologyKind::DockerCompose => {
            let node = next(
                &mut builder,
                &mut cursor,
                "compose_up",
                "Bring the compose stack up",
                PlanActionKind::ComposeUp,
                None,
                json!({ "services": deployable.iter().map(|service| service.name.clone()).collect::<Vec<_>>() }),
                false,
            );
            mutating.push(node);
        }
        TopologyKind::DockerImages | TopologyKind::HybridGateway => {
            // 静态部分先挂 Nginx，其它服务逐个 provision。
            for service in deployable.iter().filter(|service| service.static_files) {
                let node = next(
                    &mut builder,
                    &mut cursor,
                    &format!("nginx_site_{}", service.key),
                    &format!("Apply nginx site for {}", service.name),
                    PlanActionKind::ApplyNginxSite,
                    Some(&service.key),
                    json!({ "service": service.name }),
                    false,
                );
                mutating.push(node);
            }
            for service in deployable.iter().filter(|service| !service.static_files) {
                let node = next(
                    &mut builder,
                    &mut cursor,
                    &format!("provision_{}", service.key),
                    &format!("Provision service {}", service.name),
                    PlanActionKind::ProvisionService,
                    Some(&service.key),
                    json!({ "service": service.name }),
                    false,
                );
                mutating.push(node);
            }
        }
    }

    // ---- 6. 网关生效（有静态站点或域名时才有意义）----
    let needs_gateway =
        deployable.iter().any(|service| service.static_files) || inputs.certificate_required;
    if needs_gateway {
        let test = next(
            &mut builder,
            &mut cursor,
            "test_nginx_config",
            "Test nginx configuration",
            PlanActionKind::TestNginxConfig,
            None,
            json!({}),
            false,
        );
        let reload = next(
            &mut builder,
            &mut cursor,
            "reload_nginx",
            "Reload nginx",
            PlanActionKind::ReloadNginx,
            None,
            json!({}),
            false,
        );
        mutating.push(reload);
        let _ = test;
    }

    // ---- 7. 证书 ----
    if inputs.certificate_required {
        let node = next(
            &mut builder,
            &mut cursor,
            "request_certificate",
            "Issue TLS certificate",
            PlanActionKind::RequestCertificate,
            None,
            json!({}),
            false,
        );
        mutating.push(node);
    }

    // ---- 8. 健康检查 ----
    if inputs.require_health_check {
        for service in deployable
            .iter()
            .filter(|service| service.health_target.is_some())
        {
            let target = service.health_target.clone().unwrap_or_default();
            let (action, params) = if target.starts_with('/') {
                (
                    PlanActionKind::HttpHealthCheck,
                    json!({ "service": service.name, "path": target }),
                )
            } else if service.container {
                (
                    PlanActionKind::ContainerHealthCheck,
                    json!({ "service": service.name, "target": target }),
                )
            } else {
                (
                    PlanActionKind::TcpHealthCheck,
                    json!({ "service": service.name, "target": target }),
                )
            };
            let node = next(
                &mut builder,
                &mut cursor,
                &format!("health_{}", service.key),
                &format!("Health check {}", service.name),
                action,
                Some(&service.key),
                params,
                true,
            );
            let _ = node;
        }
    }

    // ---- 9. 激活版本 ----
    let activate = next(
        &mut builder,
        &mut cursor,
        "activate_release",
        "Activate the new release",
        PlanActionKind::ActivateRelease,
        None,
        json!({}),
        false,
    );

    // ---- 10. 回滚（独立汇点，只由失败边进入）----
    if inputs.require_rollback {
        let rollback = builder.push(
            "restore_release",
            "Roll back to the previous release",
            PlanActionKind::RestoreRelease,
            None,
            json!({}),
            true,
        );
        for node in &mutating {
            if node == &rollback {
                continue;
            }
            builder.link(node, &rollback, EdgeCondition::OnFailure);
        }
        notes.push(Statement::fact(
            "wf-rollback",
            "回滚节点是独立的汇点：只有变更类节点失败时才走到它，成功路径不会顺带回滚。",
            vec![],
        ));
    }
    if !mutating.contains(&activate) {
        mutating.push(activate);
    }
    if !inputs.require_rollback {
        notes.push(Statement::recommendation(
            "wf-no-rollback",
            "安全策略未要求回滚计划，因此工作流里没有回滚节点 —— 出问题只能人工处理。",
            vec![],
        ));
    }

    // 位置按插入顺序落定（图的可读性）。
    for (position, node) in builder.nodes.iter_mut().enumerate() {
        node.position = position as i64;
    }

    let mut workflow = ProposedWorkflow {
        nodes: builder.nodes,
        edges: builder.edges,
        notes,
    };
    // 生成即自检：跑一遍 P5.0 的图校验，保证交给用户的图一定是合法 DAG。
    // 校验要求计划的归属字段非空，这里用占位值 —— 它只影响"非空性检查"，
    // 真正的归属在确认阶段由 `deployment_proposal_confirm` 填。
    let graph = crate::deployment::model::DeploymentPlanGraph {
        plan: crate::deployment::model::DeploymentPlan {
            id: String::new(),
            application_id: "proposal".to_string(),
            environment_id: "proposal".to_string(),
            name: "Proposed workflow".to_string(),
            version: 1,
            status: crate::deployment::model::PlanStatus::Draft,
            proposal_source: crate::deployment::model::ProposalSource::Template,
            risk_level: highest_risk(&workflow.nodes),
            notes: String::new(),
            created_at: 0,
            updated_at: 0,
        },
        nodes: workflow.nodes.clone(),
        edges: workflow.edges.clone(),
    };
    if let Err(error) = validate::validate_plan_graph(&graph) {
        // 图不合法就退回空工作流 —— 宁可让用户看不到工作流，
        // 也不能交出一张跑不通或能形成环的图。原因必须带出去，否则无法排查。
        workflow.nodes.clear();
        workflow.edges.clear();
        workflow.notes.push(Statement::unknown(
            "wf-invalid",
            format!("生成的工作流没有通过图校验，已清空：{error}"),
            vec![],
        ));
    }
    workflow
}

/// 工作流里的最高风险（写进计划头，供审批界面醒目显示）。
pub fn highest_risk(nodes: &[PlanNode]) -> RiskLevel {
    nodes
        .iter()
        .map(|node| node.risk_level)
        .max()
        .unwrap_or(RiskLevel::Low)
}

/// 需要人工审批的节点 key（含 P5.0 的动作级要求与生产环境策略）。
pub fn approval_nodes(nodes: &[PlanNode]) -> Vec<(String, RiskLevel)> {
    nodes
        .iter()
        .filter(|node| node.approval_required)
        .map(|node| (node.node_key.clone(), node.risk_level))
        .collect()
}

/// 节点涉及的制品处置（供测试与展示）。
pub fn dispositions(inputs: &WorkflowInputs<'_>) -> BTreeSet<String> {
    inputs
        .services
        .iter()
        .map(|service| format!("{}:{:?}", service.key, service.disposition))
        .collect()
}
