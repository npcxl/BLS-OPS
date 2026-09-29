//! 计划图 → 类型化动作序列。
//!
//! # 为什么要有"编译"这一步
//!
//! P5.0 的计划节点是**粗粒度**的（`ApplyNginxSite`、`ComposeUp`），因为那是给
//! 人看的；执行侧需要的是**细粒度、可单独重试**的动作（"备份配置"和"写配置"
//! 必须能分别重试、分别补偿）。编译层就是这两者之间的桥：一个计划节点可以展开
//! 成多个动作步骤，但**展开规则是确定的、可测的**，不是运行时即兴发挥。
//!
//! # 两条入口，一条出口
//!
//! 1. **计划字典入口**（`PlanActionKind`）：提案生成的工作流走这里。
//! 2. **显式动作入口**：节点 `params_json` 里带 `"action": "<动作标识>"` 时，
//!    按 [`ActionKind`] 反序列化出**独立输入类型**。它让 29 个动作全部可达
//!    （包括 `BackupNginxConfig` 这种字典里没有的动作），同时参数仍然要过
//!    `deny_unknown_fields` + [`super::validate::validate_action`]。
//!
//! 两个入口都不接受自由命令：旧 P3 的 `commands_json` 从头到尾没有进入本模块的
//! 通道 —— 这里的输入只有 `PlanNode`（而 `PlanNode.params_json` 在保存时已经过
//! `validate_params_json`，`command`/`cmd`/`shell`/`args` 这些键直接是错误）。

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, Result};

use crate::deployment::model::{
    ArtifactKind, ArtifactRecord, ConfigDefinition, ConfigSourceKind, DeploymentPlanGraph,
    DomainBinding, EdgeCondition, EnvironmentKind, PlanActionKind, PlanNode, PortMapping,
    RiskLevel, ServiceRuntime, ServiceUnit,
};
use crate::deployment::proposal::rules::ServiceFacts;

use super::model::*;
use super::spec::{approval_required, spec, ActionPhase};
use super::validate::validate_action;

/// 服务器上的目录布局（**唯一约定**，执行器与编译器共用）。
///
/// ```text
/// <deploy_root>/releases/<版本标签>   每个版本一个目录
/// <deploy_root>/current               指向当前版本的软链
/// <deploy_root>/shared                跨版本共享（环境变量、compose 文件）
/// /etc/nginx/sites-available/<站点名> 网关配置（不在部署根内）
/// ```
pub mod layout {
    /// `/x/` → `/x`。
    fn trim(root: &str) -> &str {
        root.trim_end_matches('/')
    }

    pub fn releases_root(deploy_root: &str) -> String {
        format!("{}/releases", trim(deploy_root))
    }

    pub fn release_dir(deploy_root: &str, version_label: &str) -> String {
        format!("{}/releases/{}", trim(deploy_root), version_label)
    }

    pub fn current_link(deploy_root: &str) -> String {
        format!("{}/current", trim(deploy_root))
    }

    pub fn shared_root(deploy_root: &str) -> String {
        format!("{}/shared", trim(deploy_root))
    }

    /// 运行时环境变量文件（`mode 600`：里面可能有密钥）。
    pub fn runtime_env_file(deploy_root: &str, service_name: &str) -> String {
        format!("{}/shared/{}.env", trim(deploy_root), service_name)
    }

    pub fn compose_path(deploy_root: &str) -> String {
        format!("{}/shared/docker-compose.yml", trim(deploy_root))
    }

    /// Nginx 站点配置路径。站点名已经过 `validate_token`，不含路径分隔符。
    pub fn nginx_site_path(site_name: &str) -> String {
        format!("/etc/nginx/sites-available/{site_name}")
    }

    /// HTTP-01 用的 webroot：放在部署根下，Nginx 只需要能读到它。
    pub fn acme_webroot(deploy_root: &str) -> String {
        format!("{}/shared/acme-webroot", trim(deploy_root))
    }
}

/// 编译需要的上下文（全部来自数据库中的既有实体，**不重新采集**）。
pub struct CompileContext<'a> {
    pub environment_kind: EnvironmentKind,
    pub deploy_root: String,
    /// 本次运行的版本标签（同时是发布目录名）。
    pub version_label: String,
    /// 镜像命名前缀（通常是应用名规范化后的结果）。
    pub image_namespace: String,
    pub services: &'a [ServiceUnit],
    pub artifacts: &'a [ArtifactRecord],
    pub domains: &'a [DomainBinding],
    pub configs: &'a [ConfigDefinition],
    /// P5.2 还原出来的服务事实（端口 / 健康检查目标）。
    pub facts: &'a [ServiceFacts],
}

impl CompileContext<'_> {
    fn service(&self, name: &str) -> Result<&ServiceUnit> {
        self.services
            .iter()
            .find(|service| service.name == name)
            .ok_or_else(|| anyhow!("计划里引用了不存在的服务：{name}"))
    }

    fn artifact_for(&self, service: &ServiceUnit) -> Result<&ArtifactRecord> {
        let id = service
            .artifact_id
            .as_deref()
            .ok_or_else(|| anyhow!("服务 {} 还没有关联制品，无法编译部署动作", service.name))?;
        self.artifacts
            .iter()
            .find(|artifact| artifact.id == id)
            .ok_or_else(|| anyhow!("服务 {} 关联的制品已不存在", service.name))
    }

    fn facts_for(&self, service_id: &str) -> Option<&ServiceFacts> {
        self.facts
            .iter()
            .find(|facts| facts.service_unit_id == service_id)
    }

    fn ports_of(&self, service: &ServiceUnit) -> Vec<PortMapping> {
        self.facts_for(&service.id)
            .map(|facts| facts.ports.clone())
            .unwrap_or_default()
    }
}

/// 编译出来的一步。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledStep {
    /// 运行节点 key（自动展开时带后缀，保证唯一）。
    pub node_key: String,
    /// 它来自哪个计划节点（可追溯）。
    pub source_node_key: String,
    pub title: String,
    pub action: DeploymentAction,
    pub service_unit_id: Option<String>,
    pub risk_level: RiskLevel,
    pub approval_required: bool,
    pub phase: ActionPhase,
    pub position: i64,
}

/// 编译结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledPlan {
    /// 主链（按 DAG 拓扑序展开后的动作序列）。
    pub steps: Vec<CompiledStep>,
    /// 回滚链：由 `on_failure` 边可达的节点（通常是"回滚到上一个版本"）。
    pub rollback_steps: Vec<CompiledStep>,
    /// 编译期的说明（哪些节点没编译、为什么）。
    pub notes: Vec<String>,
}

/// 编译整张计划图。
pub fn compile_graph(
    graph: &DeploymentPlanGraph,
    ctx: &CompileContext<'_>,
) -> Result<CompiledPlan> {
    let order = topological_order(graph)?;
    let mut steps: Vec<CompiledStep> = Vec::new();
    let mut rollback_node_ids: BTreeSet<String> = BTreeSet::new();
    let mut notes: Vec<String> = Vec::new();

    // 主链：只走 on_success / always 边。on_failure 边指向的节点是回滚链。
    let main_ids: Vec<String> = order.main.clone();
    let by_id: BTreeMap<&str, &PlanNode> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();

    // 先记下回滚链的节点 key（展开时用同一套规则）。
    for node_id in &order.rollback {
        if let Some(node) = by_id.get(node_id.as_str()) {
            rollback_node_ids.insert(node.node_key.clone());
        }
    }

    let mut position: i64 = 0;
    for node_id in &main_ids {
        let Some(node) = by_id.get(node_id.as_str()) else {
            continue;
        };
        let expanded = compile_node(node, ctx)?;
        if expanded.is_empty() {
            notes.push(format!(
                "节点 {} 在当前条件下没有需要执行的动作",
                node.node_key
            ));
        }
        for (index, action) in expanded.into_iter().enumerate() {
            let node_key = if index == 0 {
                node.node_key.clone()
            } else {
                format!("{}_{}", node.node_key, action.kind().as_str())
            };
            let action_spec = spec(action.kind());
            steps.push(CompiledStep {
                node_key,
                source_node_key: node.node_key.clone(),
                title: action.title().to_string(),
                approval_required: approval_required(&action_spec, ctx.environment_kind),
                risk_level: action_spec.risk,
                phase: action_spec.phase,
                service_unit_id: node.service_unit_id.clone(),
                action,
                position,
            });
            position += 1;
        }
    }

    let mut rollback_steps: Vec<CompiledStep> = Vec::new();
    for node in graph
        .nodes
        .iter()
        .filter(|node| rollback_node_ids.contains(&node.node_key))
    {
        for action in compile_node(node, ctx)? {
            let action_spec = spec(action.kind());
            rollback_steps.push(CompiledStep {
                node_key: format!("rollback_{}", node.node_key),
                source_node_key: node.node_key.clone(),
                title: action.title().to_string(),
                approval_required: approval_required(&action_spec, ctx.environment_kind),
                risk_level: action_spec.risk,
                phase: ActionPhase::Rollback,
                service_unit_id: node.service_unit_id.clone(),
                action,
                position,
            });
            position += 1;
        }
    }

    if steps.is_empty() {
        return Err(anyhow!("计划图编译后没有任何可执行动作"));
    }
    Ok(CompiledPlan {
        steps,
        rollback_steps,
        notes,
    })
}

/// DAG 拓扑序：主链与回滚链分开。
struct Order {
    main: Vec<String>,
    rollback: Vec<String>,
}

fn topological_order(graph: &DeploymentPlanGraph) -> Result<Order> {
    // 回滚链 = "只能通过 on_failure 到达"的节点（入边全是 on_failure）。
    let mut incoming: BTreeMap<&str, Vec<(&str, EdgeCondition)>> = BTreeMap::new();
    for node in &graph.nodes {
        incoming.entry(node.id.as_str()).or_default();
    }
    for edge in &graph.edges {
        incoming
            .entry(edge.to_node_id.as_str())
            .or_default()
            .push((edge.from_node_id.as_str(), edge.condition));
    }
    let rollback_ids: BTreeSet<&str> = incoming
        .iter()
        .filter(|(_, edges)| {
            !edges.is_empty()
                && edges
                    .iter()
                    .all(|(_, condition)| *condition == EdgeCondition::OnFailure)
        })
        .map(|(id, _)| *id)
        .collect();
    // 只能靠 `manual` 边进入的节点：必须由人推动，**不参加自动主链**。
    let manual_ids: BTreeSet<&str> = incoming
        .iter()
        .filter(|(_, edges)| {
            !edges.is_empty()
                && edges
                    .iter()
                    .all(|(_, condition)| *condition == EdgeCondition::Manual)
        })
        .map(|(id, _)| *id)
        .collect();

    // Kahn：只看 on_success / always 边（manual 边需要人工推动，不自动进主链）。
    let mut indegree: BTreeMap<&str, usize> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), 0usize))
        .collect();
    for edge in &graph.edges {
        if !matches!(
            edge.condition,
            EdgeCondition::OnSuccess | EdgeCondition::Always
        ) {
            continue;
        }
        if let Some(entry) = indegree.get_mut(edge.to_node_id.as_str()) {
            *entry += 1;
        }
    }
    // 入度为 0 的节点是主链起点，但回滚链与"只能人工触发"的节点不是：
    // 把它们放进起点会让自动运行去跑本该由人决定的东西。
    let mut queue: Vec<&str> = indegree
        .iter()
        .filter(|(id, count)| {
            **count == 0 && !rollback_ids.contains(*id) && !manual_ids.contains(*id)
        })
        .map(|(id, _)| *id)
        .collect();
    // 稳定顺序：按节点位置，保证同一张图两次编译得到同一条序列。
    queue.sort_by_key(|id| {
        graph
            .nodes
            .iter()
            .find(|node| node.id == *id)
            .map(|node| node.position)
            .unwrap_or(i64::MAX)
    });

    let mut main: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    while cursor < queue.len() {
        let id = queue[cursor];
        cursor += 1;
        main.push(id.to_string());
        let mut ready: Vec<&str> = Vec::new();
        for edge in &graph.edges {
            if edge.from_node_id != id {
                continue;
            }
            if !matches!(
                edge.condition,
                EdgeCondition::OnSuccess | EdgeCondition::Always
            ) {
                continue;
            }
            if let Some(entry) = indegree.get_mut(edge.to_node_id.as_str()) {
                *entry = entry.saturating_sub(1);
                if *entry == 0 {
                    ready.push(edge.to_node_id.as_str());
                }
            }
        }
        ready.sort_by_key(|id| {
            graph
                .nodes
                .iter()
                .find(|node| node.id == *id)
                .map(|node| node.position)
                .unwrap_or(i64::MAX)
        });
        queue.extend(ready);
    }

    let reached: BTreeSet<&str> = main
        .iter()
        .map(String::as_str)
        .chain(rollback_ids.iter().copied())
        .collect();
    let stuck: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|node| {
            !reached.contains(node.id.as_str()) && !manual_ids.contains(node.id.as_str())
        })
        .map(|node| node.node_key.as_str())
        .collect();
    if !stuck.is_empty() {
        return Err(anyhow!(
            "计划图里有无法自动到达的节点（检查是否存在环或断开的边）：{}",
            stuck.join("、")
        ));
    }
    let manual_stuck: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|node| manual_ids.contains(node.id.as_str()))
        .map(|node| node.node_key.as_str())
        .collect();
    if !manual_stuck.is_empty() {
        return Err(anyhow!(
            "计划里有只能人工触发的节点（manual 入边），无法自动执行：{}",
            manual_stuck.join("、")
        ));
    }

    // 回滚链按位置排序。
    let mut rollback: Vec<String> = rollback_ids.iter().map(|id| id.to_string()).collect();
    rollback.sort_by_key(|id| {
        graph
            .nodes
            .iter()
            .find(|node| node.id == *id)
            .map(|node| node.position)
            .unwrap_or(i64::MAX)
    });
    Ok(Order { main, rollback })
}

/// 一个计划节点 → 一个或多个类型化动作。
pub fn compile_node(node: &PlanNode, ctx: &CompileContext<'_>) -> Result<Vec<DeploymentAction>> {
    // 显式动作入口：`params_json` 里带 `action` 时以它为准。
    if let Some(kind) = explicit_action_kind(node)? {
        let action = compile_explicit(kind, node, ctx)?;
        validate_action(&action, Some(&ctx.deploy_root))
            .map_err(|error| anyhow!("节点 {} 的动作参数不合法：{error}", node.node_key))?;
        return Ok(vec![action]);
    }

    let actions = compile_plan_kind(node, ctx)?;
    for action in &actions {
        validate_action(action, Some(&ctx.deploy_root))
            .map_err(|error| anyhow!("节点 {} 的动作参数不合法：{error}", node.node_key))?;
    }
    Ok(actions)
}

/// 节点是否走"显式动作"入口。
fn explicit_action_kind(node: &PlanNode) -> Result<Option<ActionKind>> {
    let params: serde_json::Value = serde_json::from_str(&node.params_json)
        .map_err(|error| anyhow!("节点 {} 的参数不是 JSON：{error}", node.node_key))?;
    let Some(value) = params.get("action") else {
        return Ok(None);
    };
    let key = value
        .as_str()
        .ok_or_else(|| anyhow!("节点 {} 的 action 必须是字符串", node.node_key))?;
    let kind = ActionKind::ALL
        .iter()
        .copied()
        .find(|kind| kind.as_str() == key)
        .ok_or_else(|| anyhow!("节点 {} 引用了未知动作：{key}", node.node_key))?;
    Ok(Some(kind))
}

/// 按动作标识反序列化出**独立输入类型**（多一个字段就报错）。
fn compile_explicit(
    kind: ActionKind,
    node: &PlanNode,
    ctx: &CompileContext<'_>,
) -> Result<DeploymentAction> {
    let mut params: serde_json::Value = serde_json::from_str(&node.params_json)
        .map_err(|error| anyhow!("节点 {} 的参数不是 JSON：{error}", node.node_key))?;
    // `action` 自己不是输入字段，反序列化之前摘掉（`deny_unknown_fields` 会拒绝它）。
    if let Some(object) = params.as_object_mut() {
        object.remove("action");
    }
    // `null` 参数（无参动作）等价于空对象，其余原样交给 `from_value`。
    let decode = |value: &serde_json::Value| -> serde_json::Value {
        if value.is_null() {
            serde_json::json!({})
        } else {
            value.clone()
        }
    };

    use ActionKind::*;
    let action = match kind {
        CheckDependencies => DeploymentAction::CheckDependencies(from_value::<
            CheckDependenciesInput,
        >(&decode(&params))?),
        EnsureDirectory => {
            DeploymentAction::EnsureDirectory(from_value::<EnsureDirectoryInput>(&decode(&params))?)
        }
        PrepareReleaseDirectory => {
            let mut input = from_value::<PrepareReleaseDirectoryInput>(&decode(&params))?;
            // 发布根目录没写就按布局约定补全（仍要过路径校验）。
            if input.release_root.is_empty() {
                input.release_root = layout::releases_root(&ctx.deploy_root);
            }
            DeploymentAction::PrepareReleaseDirectory(input)
        }
        UploadArtifact => {
            DeploymentAction::UploadArtifact(from_value::<UploadArtifactInput>(&decode(&params))?)
        }
        VerifyChecksum => {
            DeploymentAction::VerifyChecksum(from_value::<VerifyChecksumInput>(&decode(&params))?)
        }
        ExtractArchive => {
            DeploymentAction::ExtractArchive(from_value::<ExtractArchiveInput>(&decode(&params))?)
        }
        BuildDockerImage => DeploymentAction::BuildDockerImage(
            from_value::<BuildDockerImageInput>(&decode(&params))?,
        ),
        PullDockerImage => {
            DeploymentAction::PullDockerImage(from_value::<PullDockerImageInput>(&decode(&params))?)
        }
        WriteRuntimeConfig => DeploymentAction::WriteRuntimeConfig(from_value::<
            WriteRuntimeConfigInput,
        >(&decode(&params))?),
        WriteComposeFile => DeploymentAction::WriteComposeFile(
            from_value::<WriteComposeFileInput>(&decode(&params))?,
        ),
        ComposeUp => DeploymentAction::ComposeUp(from_value::<ComposeUpInput>(&decode(&params))?),
        ComposeDown => {
            DeploymentAction::ComposeDown(from_value::<ComposeDownInput>(&decode(&params))?)
        }
        WaitContainerHealthy => {
            DeploymentAction::WaitContainerHealthy(from_value::<WaitContainerHealthyInput>(
                &decode(&params),
            )?)
        }
        RestartSystemdUnit => DeploymentAction::RestartSystemdUnit(from_value::<
            RestartSystemdUnitInput,
        >(&decode(&params))?),
        BackupNginxConfig => DeploymentAction::BackupNginxConfig(from_value::<
            BackupNginxConfigInput,
        >(&decode(&params))?),
        WriteNginxConfig => DeploymentAction::WriteNginxConfig(
            from_value::<WriteNginxConfigInput>(&decode(&params))?,
        ),
        RestoreNginxBackup => DeploymentAction::RestoreNginxBackup(from_value::<
            RestoreNginxBackupInput,
        >(&decode(&params))?),
        TestNginxConfig => {
            DeploymentAction::TestNginxConfig(from_value::<TestNginxConfigInput>(&decode(&params))?)
        }
        ReloadNginx => {
            DeploymentAction::ReloadNginx(from_value::<ReloadNginxInput>(&decode(&params))?)
        }
        VerifyDnsRecord => {
            DeploymentAction::VerifyDnsRecord(from_value::<VerifyDnsRecordInput>(&decode(&params))?)
        }
        IssueCertificate => DeploymentAction::IssueCertificate(
            from_value::<IssueCertificateInput>(&decode(&params))?,
        ),
        RenewCertificate => DeploymentAction::RenewCertificate(
            from_value::<RenewCertificateInput>(&decode(&params))?,
        ),
        HttpHealthCheck => {
            DeploymentAction::HttpHealthCheck(from_value::<HttpHealthCheckInput>(&decode(&params))?)
        }
        TcpHealthCheck => {
            DeploymentAction::TcpHealthCheck(from_value::<TcpHealthCheckInput>(&decode(&params))?)
        }
        SwitchReleaseSymlink => {
            DeploymentAction::SwitchReleaseSymlink(from_value::<SwitchReleaseSymlinkInput>(
                &decode(&params),
            )?)
        }
        PromoteRelease => {
            DeploymentAction::PromoteRelease(from_value::<PromoteReleaseInput>(&decode(&params))?)
        }
        StopPreviousRelease => DeploymentAction::StopPreviousRelease(from_value::<
            StopPreviousReleaseInput,
        >(&decode(&params))?),
        RollbackRelease => {
            DeploymentAction::RollbackRelease(from_value::<RollbackReleaseInput>(&decode(&params))?)
        }
        RequireManualStep => DeploymentAction::RequireManualStep(from_value::<
            RequireManualStepInput,
        >(&decode(&params))?),
    };
    Ok(action)
}

fn from_value<T: serde::de::DeserializeOwned>(value: &serde_json::Value) -> Result<T> {
    serde_json::from_value(value.clone())
        .map_err(|error| anyhow!("动作参数不合法（多写、少写或类型不对都会报错）：{error}"))
}

/// 计划字典 → 动作（提案生成的工作流走这条）。
fn compile_plan_kind(node: &PlanNode, ctx: &CompileContext<'_>) -> Result<Vec<DeploymentAction>> {
    use PlanActionKind as Kind;
    let params = params_of(node)?;
    let service_name = params
        .get("service")
        .and_then(|value| value.as_str())
        .map(str::to_string);

    match node.action {
        Kind::CheckDependencies => Ok(vec![DeploymentAction::CheckDependencies(
            CheckDependenciesInput {
                tools: required_tools_for(ctx),
            },
        )]),

        Kind::UploadArtifact => {
            let service = require_service(ctx, &service_name)?;
            let artifact = ctx.artifact_for(service)?;
            let release_dir = layout::release_dir(&ctx.deploy_root, &ctx.version_label);
            let file_name = artifact
                .file_name
                .clone()
                .unwrap_or_else(|| format!("{}.artifact", service.name));
            let mut actions = vec![
                DeploymentAction::EnsureDirectory(EnsureDirectoryInput {
                    path: release_dir.clone(),
                    mode: Some(0o755),
                }),
                DeploymentAction::UploadArtifact(UploadArtifactInput {
                    local_path: artifact.source_ref.clone(),
                    remote_dir: release_dir.clone(),
                    file_name: file_name.clone(),
                    expected_sha256: artifact.sha256.clone(),
                }),
            ];
            if let Some(hash) = artifact.sha256.clone() {
                actions.push(DeploymentAction::VerifyChecksum(VerifyChecksumInput {
                    remote_path: format!("{release_dir}/{file_name}"),
                    expected_sha256: hash,
                }));
            }
            Ok(actions)
        }

        Kind::ExtractArtifact => {
            let service = require_service(ctx, &service_name)?;
            let artifact = ctx.artifact_for(service)?;
            let format = archive_format(artifact.kind)?;
            let release_dir = layout::release_dir(&ctx.deploy_root, &ctx.version_label);
            let file_name = artifact
                .file_name
                .clone()
                .unwrap_or_else(|| format!("{}.artifact", service.name));
            Ok(vec![DeploymentAction::ExtractArchive(
                ExtractArchiveInput {
                    archive_path: format!("{release_dir}/{file_name}"),
                    dest_dir: release_dir,
                    format,
                },
            )])
        }

        Kind::PullImage => {
            let service = require_service(ctx, &service_name)?;
            let (image, tag) = docker_image_of(service)?;
            Ok(vec![DeploymentAction::PullDockerImage(
                PullDockerImageInput {
                    image: format!("{image}:{tag}"),
                    expected_digest: None,
                },
            )])
        }

        Kind::BuildImage => {
            let service = require_service(ctx, &service_name)?;
            let release_dir = layout::release_dir(&ctx.deploy_root, &ctx.version_label);
            Ok(vec![DeploymentAction::BuildDockerImage(
                BuildDockerImageInput {
                    dockerfile: format!("{release_dir}/Dockerfile"),
                    context_dir: release_dir,
                    image_tag: image_tag(ctx, &service.name),
                },
            )])
        }

        Kind::ResolveConfig | Kind::RenderEnvFile => {
            let service = require_service(ctx, &service_name)?;
            let entries = config_entries(ctx, &service.id);
            if entries.is_empty() {
                return Ok(Vec::new());
            }
            Ok(vec![DeploymentAction::WriteRuntimeConfig(
                WriteRuntimeConfigInput {
                    path: layout::runtime_env_file(&ctx.deploy_root, &service.name),
                    mode: 0o600,
                    entries,
                },
            )])
        }

        // 数据库迁移：**引擎不执行任何迁移脚本**。这里把它变成一个必须人工
        // 审批的门，审批人确认"迁移已由人工完成"之后流程才继续。
        Kind::DatabaseMigration => Ok(vec![DeploymentAction::RequireManualStep(
            RequireManualStepInput {
                reason:
                    "数据库迁移必须由人工执行：本工具不执行迁移脚本（避免任意命令进入执行路径）"
                        .to_string(),
                acknowledged: false,
            },
        )]),

        Kind::ProvisionService | Kind::StartService | Kind::RestartService => {
            let service = require_service(ctx, &service_name)?;
            provision_actions(service, ctx)
        }

        Kind::StopService => {
            let service = require_service(ctx, &service_name)?;
            Ok(vec![DeploymentAction::StopPreviousRelease(
                StopPreviousReleaseInput {
                    target: stop_target(service)?,
                },
            )])
        }

        Kind::ComposeUp => {
            let services = compose_service_names(ctx);
            if services.is_empty() {
                return Err(anyhow!(
                    "Compose 拓扑下没有可编排的服务（检查服务运行方式是否声明了容器形态）"
                ));
            }
            let compose_path = compose_path_for(ctx);
            let mut actions = Vec::new();
            // 计划里没有写 Compose 文件时，先由引擎生成一份（结构化渲染，
            // 不做原文透传）。`DockerCompose` 运行方式用的是用户自己的文件，
            // 路径不同，因此不会被覆盖。
            if compose_path == layout::compose_path(&ctx.deploy_root) {
                actions.push(DeploymentAction::WriteComposeFile(WriteComposeFileInput {
                    compose_path: compose_path.clone(),
                    project_name: project_name(ctx),
                    services: compose_specs(ctx)?,
                    internal_network: format!("{}-internal", project_name(ctx)),
                }));
            }
            actions.push(DeploymentAction::ComposeUp(ComposeUpInput {
                compose_path,
                project_name: project_name(ctx),
                services,
            }));
            Ok(actions)
        }

        Kind::ComposeDown => Ok(vec![DeploymentAction::ComposeDown(ComposeDownInput {
            compose_path: compose_path_for(ctx),
            project_name: project_name(ctx),
        })]),

        Kind::ApplyNginxSite => {
            let service = require_service(ctx, &service_name)?;
            let site = nginx_site_for(service, ctx)?;
            let config_path = layout::nginx_site_path(&site.site_name);
            Ok(vec![
                // 先备份再写：这是硬顺序，执行器还会再确认一次备份存在。
                DeploymentAction::BackupNginxConfig(BackupNginxConfigInput {
                    config_path: config_path.clone(),
                }),
                DeploymentAction::WriteNginxConfig(WriteNginxConfigInput {
                    config_path,
                    site,
                    enable_site: true,
                }),
            ])
        }

        Kind::TestNginxConfig => Ok(vec![DeploymentAction::TestNginxConfig(
            TestNginxConfigInput {},
        )]),

        Kind::ReloadNginx => Ok(vec![DeploymentAction::ReloadNginx(ReloadNginxInput {})]),

        Kind::BindDomain => {
            let domain = primary_domain(ctx)
                .ok_or_else(|| anyhow!("计划要求绑定域名，但环境里没有任何域名绑定"))?;
            Ok(vec![DeploymentAction::VerifyDnsRecord(
                VerifyDnsRecordInput {
                    domain: domain.domain.clone(),
                    expected_ip: None,
                },
            )])
        }

        Kind::RequestCertificate => {
            let domain = primary_domain(ctx)
                .ok_or_else(|| anyhow!("计划要求签发证书，但环境里没有任何域名绑定"))?;
            let domains: Vec<String> = ctx
                .domains
                .iter()
                .filter(|binding| binding.ssl_mode == crate::deployment::model::SslMode::Acme)
                .map(|binding| binding.domain.clone())
                .collect();
            let domains = if domains.is_empty() {
                vec![domain.domain.clone()]
            } else {
                domains
            };
            let wildcard = domains.iter().any(|domain| domain.starts_with("*."));
            let challenge = if wildcard {
                CertificateChallenge::Dns01
            } else {
                CertificateChallenge::Http01
            };
            let mut actions = Vec::new();
            // HTTP-01 的前置：域名**必须**已经解析到本机，否则 CA 回调不到。
            if challenge == CertificateChallenge::Http01 {
                actions.push(DeploymentAction::VerifyDnsRecord(VerifyDnsRecordInput {
                    domain: domain.domain.clone(),
                    expected_ip: None,
                }));
            }
            actions.push(DeploymentAction::IssueCertificate(IssueCertificateInput {
                domains,
                email: acme_email(ctx),
                webroot: layout::acme_webroot(&ctx.deploy_root),
                challenge,
                dns_provider: Some("manual".to_string()),
            }));
            Ok(actions)
        }

        Kind::RenewCertificate => Ok(vec![DeploymentAction::RenewCertificate(
            RenewCertificateInput { cert_name: None },
        )]),

        Kind::HttpHealthCheck => {
            let service = require_service(ctx, &service_name)?;
            let target = health_target(ctx, service, &params)?;
            Ok(vec![DeploymentAction::HttpHealthCheck(
                HttpHealthCheckInput {
                    url: http_health_url(service, &target, ctx),
                    expected_status: 200,
                    timeout_secs: 10,
                    attempts: 5,
                },
            )])
        }

        Kind::TcpHealthCheck => {
            let service = require_service(ctx, &service_name)?;
            let target = health_target(ctx, service, &params)?;
            let port = tcp_health_port(&target, ctx, service)?;
            Ok(vec![DeploymentAction::TcpHealthCheck(
                TcpHealthCheckInput {
                    host: "127.0.0.1".to_string(),
                    port,
                    timeout_secs: 5,
                    attempts: 5,
                },
            )])
        }

        Kind::ContainerHealthCheck => {
            let service = require_service(ctx, &service_name)?;
            Ok(vec![DeploymentAction::WaitContainerHealthy(
                WaitContainerHealthyInput {
                    container: container_name(service)?,
                    timeout_secs: 180,
                    interval_secs: 5,
                },
            )])
        }

        Kind::ActivateRelease => Ok(vec![DeploymentAction::PromoteRelease(
            PromoteReleaseInput {
                release_root: layout::releases_root(&ctx.deploy_root),
                current_link: layout::current_link(&ctx.deploy_root),
                version_label: ctx.version_label.clone(),
                service_unit_id: node.service_unit_id.clone(),
            },
        )]),

        Kind::RestoreRelease => Ok(vec![DeploymentAction::RollbackRelease(
            RollbackReleaseInput {
                service_unit_id: node.service_unit_id.clone(),
                target_dir: layout::release_dir(&ctx.deploy_root, &previous_version_label(ctx)),
                current_link: layout::current_link(&ctx.deploy_root),
                data_note: None,
            },
        )]),

        Kind::RestoreNginxBackup => {
            let site_name = service_name
                .as_deref()
                .and_then(|name| ctx.services.iter().find(|unit| unit.name == name))
                .and_then(|service| match &service.runtime {
                    ServiceRuntime::StaticNginx { site_name, .. } => Some(site_name.clone()),
                    _ => None,
                })
                .ok_or_else(|| anyhow!("还原 Nginx 备份需要指定一个静态站点服务"))?;
            Ok(vec![DeploymentAction::RestoreNginxBackup(
                RestoreNginxBackupInput {
                    config_path: layout::nginx_site_path(&site_name),
                },
            )])
        }

        Kind::FetchSource | Kind::BuildArtifact | Kind::PackageArtifact | Kind::PushImage => {
            Err(anyhow!(
                "动作 {:?}（节点 {}）在当前版本没有实现：源码拉取与镜像推送不在 V1 范围内，\
                 请在 CI 里完成这一步，再把产物作为制品导入",
                node.action,
                node.node_key
            ))
        }
    }
}

// -- 计划字典路径用到的解析助手 ------------------------------------------------

fn params_of(node: &PlanNode) -> Result<serde_json::Value> {
    serde_json::from_str(&node.params_json)
        .map_err(|error| anyhow!("节点 {} 的参数不是 JSON：{error}", node.node_key))
}

fn require_service<'a>(
    ctx: &'a CompileContext<'_>,
    name: &Option<String>,
) -> Result<&'a ServiceUnit> {
    let name = name
        .as_deref()
        .ok_or_else(|| anyhow!("这个计划节点必须声明 service 参数"))?;
    ctx.service(name)
}

fn archive_format(kind: ArtifactKind) -> Result<ArchiveFormat> {
    match kind {
        ArtifactKind::Zip => Ok(ArchiveFormat::Zip),
        ArtifactKind::Tar => Ok(ArchiveFormat::Tar),
        ArtifactKind::TarGz => Ok(ArchiveFormat::TarGz),
        other => Err(anyhow!("{other:?} 不是归档，不能解包")),
    }
}

fn docker_image_of(service: &ServiceUnit) -> Result<(String, String)> {
    match &service.runtime {
        ServiceRuntime::DockerImage { image, tag, .. } => Ok((image.clone(), tag.clone())),
        other => Err(anyhow!(
            "服务 {} 的运行方式不是镜像（{other:?}），不能拉取镜像",
            service.name
        )),
    }
}

fn container_name(service: &ServiceUnit) -> Result<String> {
    match &service.runtime {
        ServiceRuntime::DockerImage { container_name, .. } => Ok(container_name.clone()),
        other => Err(anyhow!(
            "服务 {} 不是容器形态（{other:?}），无法等待容器健康",
            service.name
        )),
    }
}

/// 镜像标签：`<命名空间>/<服务名>:<版本标签>`（版本标签已被校验为单段名字）。
fn image_tag(ctx: &CompileContext<'_>, service_name: &str) -> String {
    format!(
        "{}/{}:{}",
        ctx.image_namespace.trim_matches('/'),
        service_name,
        ctx.version_label
    )
}

/// 服务名规范化成 compose 项目名（`[A-Za-z0-9._-]`）。
fn project_name(ctx: &CompileContext<'_>) -> String {
    let raw = ctx.image_namespace.trim_matches('/');
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "blsops".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 部署时总要有的工具（按服务形态推导，不猜）。
fn required_tools_for(ctx: &CompileContext<'_>) -> Vec<RequiredTool> {
    let mut tools: BTreeSet<RequiredTool> = BTreeSet::new();
    tools.insert(RequiredTool::Sha256Sum);
    for service in ctx
        .services
        .iter()
        .filter(|service| service.status != "disabled")
    {
        match &service.runtime {
            ServiceRuntime::DockerImage { .. } | ServiceRuntime::DockerCompose { .. } => {
                tools.insert(RequiredTool::Docker);
                tools.insert(RequiredTool::DockerCompose);
            }
            ServiceRuntime::SystemdUnit { .. } => {
                tools.insert(RequiredTool::Systemctl);
            }
            ServiceRuntime::StaticNginx { .. } => {
                tools.insert(RequiredTool::Nginx);
            }
            ServiceRuntime::NativeProcess { .. } | ServiceRuntime::External { .. } => {}
        }
    }
    if ctx
        .domains
        .iter()
        .any(|binding| binding.ssl_mode == crate::deployment::model::SslMode::Acme)
    {
        tools.insert(RequiredTool::Certbot);
        tools.insert(RequiredTool::Curl);
    }
    if ctx.artifacts.iter().any(|artifact| {
        matches!(
            artifact.kind,
            ArtifactKind::Zip | ArtifactKind::Tar | ArtifactKind::TarGz
        )
    }) {
        tools.insert(RequiredTool::Unzip);
        tools.insert(RequiredTool::Tar);
    }
    tools.into_iter().collect()
}

/// 服务级 provision 动作（按运行方式分流）。
fn provision_actions(
    service: &ServiceUnit,
    ctx: &CompileContext<'_>,
) -> Result<Vec<DeploymentAction>> {
    match &service.runtime {
        ServiceRuntime::SystemdUnit { unit } => Ok(vec![DeploymentAction::RestartSystemdUnit(
            RestartSystemdUnitInput { unit: unit.clone() },
        )]),
        ServiceRuntime::DockerCompose {
            compose_path,
            project_name,
            service: compose_service,
        } => Ok(vec![DeploymentAction::ComposeUp(ComposeUpInput {
            compose_path: compose_path.clone(),
            project_name: project_name.clone(),
            services: vec![compose_service.clone()],
        })]),
        ServiceRuntime::DockerImage { .. } => {
            let mut actions: Vec<DeploymentAction> = Vec::new();
            if let Some(specs) = compose_specs_opt(ctx) {
                actions.push(DeploymentAction::WriteComposeFile(WriteComposeFileInput {
                    compose_path: layout::compose_path(&ctx.deploy_root),
                    project_name: project_name(ctx),
                    services: specs,
                    internal_network: format!("{}-internal", project_name(ctx)),
                }));
            }
            actions.push(DeploymentAction::ComposeUp(ComposeUpInput {
                compose_path: layout::compose_path(&ctx.deploy_root),
                project_name: project_name(ctx),
                services: vec![service.name.clone()],
            }));
            Ok(actions)
        }
        ServiceRuntime::StaticNginx { site_name, .. } => {
            let site = nginx_site_for(service, ctx)?;
            let config_path = layout::nginx_site_path(site_name);
            Ok(vec![
                DeploymentAction::BackupNginxConfig(BackupNginxConfigInput {
                    config_path: config_path.clone(),
                }),
                DeploymentAction::WriteNginxConfig(WriteNginxConfigInput {
                    config_path,
                    site,
                    enable_site: true,
                }),
            ])
        }
        ServiceRuntime::NativeProcess { .. } => Err(anyhow!(
            "服务 {} 是原生进程形态：本版本不创建 systemd 单元（那需要写单元文件与提权），\
             请先在服务器上准备好单元文件并把运行方式改成 systemd，或改用容器形态",
            service.name
        )),
        ServiceRuntime::External { endpoint } => Err(anyhow!(
            "服务 {} 是外部托管（{endpoint}），不该出现在部署工作流里",
            service.name
        )),
    }
}

fn stop_target(service: &ServiceUnit) -> Result<StopTarget> {
    Ok(match &service.runtime {
        ServiceRuntime::DockerImage { container_name, .. } => StopTarget::Container {
            container: container_name.clone(),
        },
        ServiceRuntime::SystemdUnit { unit } => StopTarget::SystemdUnit { unit: unit.clone() },
        ServiceRuntime::DockerCompose {
            compose_path,
            project_name,
            ..
        } => StopTarget::ComposeStack {
            compose_path: compose_path.clone(),
            project_name: project_name.clone(),
        },
        other => {
            return Err(anyhow!(
                "服务 {} 的运行方式不支持停止（{other:?}）",
                service.name
            ))
        }
    })
}

/// 运行时配置条目（来自 P5.0 的 `ConfigDefinition`）。
fn config_entries(ctx: &CompileContext<'_>, service_unit_id: &str) -> Vec<RuntimeConfigEntry> {
    ctx.configs
        .iter()
        .filter(|config| {
            config.service_unit_id.as_deref() == Some(service_unit_id)
                || config.service_unit_id.is_none()
        })
        .map(|config| RuntimeConfigEntry {
            key: config.key.clone(),
            value: if config.secret || config.source_kind == ConfigSourceKind::SecretRef {
                None
            } else {
                config.default_value.clone()
            },
            secret: config.secret || config.source_kind == ConfigSourceKind::SecretRef,
            secret_ref_id: if config.source_kind == ConfigSourceKind::SecretRef {
                config.source_ref.clone()
            } else {
                None
            },
            required: config.required,
        })
        .collect()
}

/// Compose 编排里的服务名（容器形态才进栈）。
fn compose_service_names(ctx: &CompileContext<'_>) -> Vec<String> {
    ctx.services
        .iter()
        .filter(|service| {
            service.status != "disabled"
                && matches!(
                    service.runtime,
                    ServiceRuntime::DockerImage { .. } | ServiceRuntime::DockerCompose { .. }
                )
        })
        .map(|service| service.name.clone())
        .collect()
}

/// Compose 文件放哪：镜像形态用我们生成的文件，compose 形态用用户自己的。
fn compose_path_for(ctx: &CompileContext<'_>) -> String {
    ctx.services
        .iter()
        .find_map(|service| match &service.runtime {
            ServiceRuntime::DockerCompose { compose_path, .. } => Some(compose_path.clone()),
            _ => None,
        })
        .unwrap_or_else(|| layout::compose_path(&ctx.deploy_root))
}

fn compose_specs_opt(ctx: &CompileContext<'_>) -> Option<Vec<ComposeServiceSpec>> {
    compose_specs(ctx).ok().filter(|specs| !specs.is_empty())
}

/// 由服务定义生成 Compose 规格。
///
/// **只暴露必要端口**：只有 Web / Gateway / Static 角色的服务才发布宿主机端口，
/// 其余一律 `internal_only`（后端之间通过内部网络用服务名互联）。
fn compose_specs(ctx: &CompileContext<'_>) -> Result<Vec<ComposeServiceSpec>> {
    use crate::deployment::model::ServiceRole as Role;
    let mut specs: Vec<ComposeServiceSpec> = Vec::new();
    for service in ctx.services.iter().filter(|service| {
        service.status != "disabled"
            && matches!(service.runtime, ServiceRuntime::DockerImage { .. })
    }) {
        let ServiceRuntime::DockerImage {
            image, tag, ports, ..
        } = &service.runtime
        else {
            continue;
        };
        let publishes = matches!(role_of(service), Role::Web | Role::Gateway | Role::Static);
        let publish_ports = if publishes { ports.clone() } else { Vec::new() };
        let env_file = layout::runtime_env_file(&ctx.deploy_root, &service.name);
        let has_config = ctx
            .configs
            .iter()
            .any(|config| config.service_unit_id.as_deref() == Some(service.id.as_str()));
        specs.push(ComposeServiceSpec {
            name: service.name.clone(),
            image: Some(format!("{image}:{tag}")),
            build_context: None,
            dockerfile: None,
            publish_ports,
            expose_ports: ports.iter().map(|mapping| mapping.container_port).collect(),
            env_file: if has_config { Some(env_file) } else { None },
            depends_on: Vec::new(),
            healthcheck_path: ctx
                .facts_for(&service.id)
                .and_then(|facts| facts.health_target.clone())
                .filter(|target| target.starts_with('/')),
            networks: Vec::new(),
            internal_only: !publishes,
        });
    }
    if specs.is_empty() {
        return Err(anyhow!("没有容器形态的服务，无法生成 Compose 文件"));
    }
    Ok(specs)
}

fn role_of(service: &ServiceUnit) -> crate::deployment::model::ServiceRole {
    service.role
}

/// Nginx 站点规格（静态站点 / 反代）。
fn nginx_site_for(service: &ServiceUnit, ctx: &CompileContext<'_>) -> Result<NginxSiteSpec> {
    let site_name = match &service.runtime {
        ServiceRuntime::StaticNginx { site_name, .. } => site_name.clone(),
        // 反代站点：用项目名 + 服务名生成一个稳定、可读的站点名。
        _ => format!("{}-{}", project_name(ctx), sanitize_slug(&service.name)),
    };
    let binding = ctx
        .domains
        .iter()
        .find(|binding| binding.service_unit_id.as_deref() == Some(service.id.as_str()))
        .or_else(|| ctx.domains.first())
        .ok_or_else(|| {
            anyhow!(
                "站点 {} 没有绑定任何域名，无法生成 Nginx 配置",
                service.name
            )
        })?;
    // 静态站点直接从 current 软链读文件：切换版本 = 切软链，不需要改 Nginx。
    let root = match &service.runtime {
        ServiceRuntime::StaticNginx { root, .. } => root.clone(),
        _ => format!("{}/public", layout::current_link(&ctx.deploy_root)),
    };
    // 反代目标：优先用识别出来的端口，其次用服务运行方式里的端口。
    let proxy_pass = match &service.runtime {
        ServiceRuntime::StaticNginx { .. } => None,
        _ => {
            let ports = ctx.ports_of(service);
            ports
                .first()
                .map(|mapping| format!("127.0.0.1:{}", mapping.host_port))
        }
    };
    Ok(NginxSiteSpec {
        site_name,
        server_names: vec![binding.domain.clone()],
        listen_port: binding.listen_port,
        path_prefix: binding.path_prefix.clone(),
        // 校验要求"静态根目录"与"反向代理"二选一。
        root: if proxy_pass.is_none() {
            Some(root)
        } else {
            None
        },
        proxy_pass,
        ssl_certificate: None,
        ssl_certificate_key: None,
        client_max_body_size_mb: None,
    })
}

fn sanitize_slug(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn primary_domain<'a>(ctx: &CompileContext<'a>) -> Option<&'a DomainBinding> {
    ctx.domains.first()
}

fn acme_email(ctx: &CompileContext<'_>) -> String {
    // 没有配置邮箱时用一个明确无效的占位 —— certbot 会拒绝，用户会被要求补填。
    // 与其编一个 fake@example.com 让 CA 发提醒到黑洞，不如让这一步显式失败。
    ctx.configs
        .iter()
        .find(|config| config.key == "ACME_EMAIL")
        .and_then(|config| config.default_value.clone())
        .unwrap_or_else(|| "acme@invalid".to_string())
}

/// 健康检查目标：优先识别结果，其次节点参数。
fn health_target(
    ctx: &CompileContext<'_>,
    service: &ServiceUnit,
    params: &serde_json::Value,
) -> Result<String> {
    if let Some(facts) = ctx.facts_for(&service.id) {
        if let Some(target) = facts.health_target.clone() {
            return Ok(target);
        }
    }
    params
        .get("path")
        .or_else(|| params.get("target"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            anyhow!(
                "服务 {} 没有健康检查目标（识别结果与节点参数里都没有）",
                service.name
            )
        })
}

fn http_health_url(service: &ServiceUnit, target: &str, ctx: &CompileContext<'_>) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    // 域名绑定优先（本机 Nginx 已就位时这就是真实入口）。
    if let Some(binding) = ctx
        .domains
        .iter()
        .find(|binding| binding.service_unit_id.as_deref() == Some(service.id.as_str()))
        .or_else(|| ctx.domains.first())
    {
        let scheme = if binding.ssl_mode == crate::deployment::model::SslMode::None {
            "http"
        } else {
            "https"
        };
        let port = if binding.listen_port == 80 || binding.listen_port == 443 {
            String::new()
        } else {
            format!(":{}", binding.listen_port)
        };
        return format!("{scheme}://{}{port}{target}", binding.domain);
    }
    format!("http://127.0.0.1{target}")
}

fn tcp_health_port(target: &str, ctx: &CompileContext<'_>, service: &ServiceUnit) -> Result<u16> {
    if let Some((_, port)) = target.rsplit_once(':') {
        if let Ok(port) = port.parse::<u16>() {
            return Ok(port);
        }
    }
    ctx.ports_of(service)
        .first()
        .map(|mapping| mapping.host_port)
        .ok_or_else(|| anyhow!("服务 {} 没有可检查的端口", service.name))
}

/// 回滚目标版本标签：`current` 软链的上一版由发布目录里的邻居决定，
/// 编译期无法知道，因此交给解释阶段（这里用 `previous` 占位，执行器会用
/// 真实的上一版覆盖它）。**不允许静默猜一个不存在的目录。**
fn previous_version_label(_ctx: &CompileContext<'_>) -> String {
    "previous".to_string()
}
