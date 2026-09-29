//! 方案生成主流程：**输入 → 知识库 → 容量 → 规则引擎 → 校验 → 指纹**。
//!
//! # 顺序不能换
//!
//! 1. 安全策略先**钉硬**（用户改松的字段在这里被恢复，并留下违规记录）；
//! 2. 知识库检索 + 冲突裁定（事实/策略优先，裁不了就进 open_questions）；
//! 3. 容量评估（带显式假设）；
//! 4. 规则引擎出拓扑 / 服务 / 工作流 / 风险 / 审批 / 回滚；
//! 5. 组装方案 → （可选）AI 批注 → JSON Schema + 无 shell 校验；
//! 6. 判定 `ready`：不 ready 就把工作流清空（**绝不给出"半可执行"的计划**）；
//! 7. 指纹：输入哈希 + 输出哈希（**不含时间戳**，所以两次生成可以逐字节比对）。
//!
//! 第 7 步放在最后，是因为"清空工作流"会改变输出 —— 哈希必须反映最终产物。

use serde::{Deserialize, Serialize};

use super::ai::ProposalAdvisor;
use super::capacity::{self, CapacityInput};
use super::checks;
use super::knowledge::{self, KnowledgeQuery, KnowledgeResult};
use super::model::{
    Assumption, DeploymentProposal, Evidence, EvidenceClass, EvidenceSource, InputSnapshot,
    KnowledgeConflict, ProposalCheck, ProposalFingerprint, ProposalOutcome, ProposalStatus,
    ProposalSummary, ProposalValidation, ProposedWorkflow, SecurityPolicy, ServerResourceFacts,
    Statement, Unknown, UnknownSeverity,
};
use super::rules::{self, ServiceFacts};
use super::{ENGINE_VERSION, PROMPT_VERSION, PROPOSAL_SCHEMA_VERSION};
use crate::capability_probe::ServerCapabilityProfile;
use crate::deployment::artifact::fingerprint;
use crate::deployment::model::{
    ArtifactRecord, CapacityProfile, DeploymentApplication, DeploymentEnvironment, DomainBinding,
    ServiceKind, ServiceRelation, ServiceUnit,
};

/// 方案生成的输入（一次生成所需的一切）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposalInputs {
    pub application: DeploymentApplication,
    pub environment: Option<DeploymentEnvironment>,
    pub server_id: String,
    pub services: Vec<ServiceUnit>,
    pub relations: Vec<ServiceRelation>,
    pub artifacts: Vec<ArtifactRecord>,
    pub domains: Vec<DomainBinding>,
    /// 命令层从 P5.1 识别结果里抽出来的事实（可为空 = 还没导入过制品）。
    pub facts: Vec<ServiceFacts>,
    pub capability: Option<ServerCapabilityProfile>,
    pub capacity: Option<CapacityProfile>,
    pub policy: SecurityPolicy,
    /// 实测到的服务器资源（没采集就是 `None`）。
    pub observed: Option<ServerResourceFacts>,
    /// 生成时间（**不参与哈希**）。
    pub now: i64,
}

/// 生成一份部署方案。
///
/// **纯函数**：同样的输入（含同样的 `knowledge` 结果与同样的 advisor 行为）
/// 一定得到同样的 `input_hash` / `output_hash`。这也是"可复现审计"的实现方式。
pub fn generate(inputs: &ProposalInputs, advisor: Option<&dyn ProposalAdvisor>) -> ProposalOutcome {
    // ---- 1. 安全策略钉硬 ----
    let (policy, downgraded) = inputs.policy.clone().hardened();
    let production_like = inputs
        .environment
        .as_ref()
        .map(|environment| environment.kind.is_production_like())
        .unwrap_or(false);

    // ---- 2. 知识库 ----
    let query = knowledge_query(inputs, production_like);
    let known = knowledge::retrieve(&query);
    let conflicts =
        knowledge::resolve_conflicts(known.conflicts.clone(), inputs.capability.as_ref(), &policy);
    let knowledge = KnowledgeResult {
        conflicts: conflicts.clone(),
        ..known
    };

    // ---- 3. 容量 ----
    let jvm = inputs
        .services
        .iter()
        .any(|service| service.service_kind == ServiceKind::JavaJar);
    let containers = inputs.services.iter().any(|service| {
        matches!(
            service.service_kind,
            ServiceKind::DockerImage | ServiceKind::DockerCompose
        )
    });
    let capacity_estimate = capacity::estimate(&CapacityInput {
        profile: inputs.capacity.as_ref(),
        production_like,
        environment_name: inputs
            .environment
            .as_ref()
            .map(|environment| environment.name.as_str())
            .unwrap_or(""),
        service_count: inputs.services.len(),
        containers,
        jvm,
        observed: inputs.observed.as_ref(),
        min_headroom_percent: policy.min_headroom_percent,
        require_backup: policy.require_backup_for_production && production_like,
        knowledge: &knowledge,
    });

    // ---- 4. 规则引擎 ----
    let outcome = rules::plan(&rules::RuleInputs {
        application_id: inputs.application.id.clone(),
        environment: inputs.environment.as_ref(),
        server_id: inputs.server_id.clone(),
        services: &inputs.services,
        relations: &inputs.relations,
        artifacts: &inputs.artifacts,
        domains: &inputs.domains,
        facts: &inputs.facts,
        capability: inputs.capability.as_ref(),
        capacity: &capacity_estimate,
        knowledge: &knowledge,
        policy: &policy,
        production_like,
        conflicts: &conflicts,
    });

    // ---- 5. 组装 ----
    let mut unknowns = capacity_estimate.unknowns.clone();
    unknowns.extend(outcome.unknowns.clone());
    unknowns.extend(engine_unknowns(inputs, &conflicts, &knowledge));
    unknowns.sort_by(|left, right| left.id.cmp(&right.id));
    unknowns.dedup_by(|left, right| left.id == right.id);

    let mut statements: Vec<Statement> = outcome.statements.clone();
    statements.extend(outcome.workflow.notes.clone());
    statements.sort_by(|left, right| left.id.cmp(&right.id));
    statements.dedup_by(|left, right| left.id == right.id);

    let headline = headline_of(inputs, &outcome, production_like);
    statements.insert(
        0,
        Statement::fact(
            "summary-scope",
            format!(
                "共 {} 个服务（其中 {} 个外部托管）、{} 个端口规划、{} 个域名绑定。",
                inputs.services.len(),
                inputs
                    .services
                    .iter()
                    .filter(|service| service.service_kind == ServiceKind::ExternalManaged)
                    .count(),
                outcome
                    .services
                    .iter()
                    .map(|service| service.ports.len())
                    .sum::<usize>(),
                inputs.domains.len()
            ),
            vec![Evidence {
                class: EvidenceClass::Fact,
                source: EvidenceSource::UserInput {
                    field: "services".to_string(),
                },
                detail: "来自部署中心的模型数据".to_string(),
                reference: None,
            }],
        ),
    );

    let snapshot = InputSnapshot {
        application_id: inputs.application.id.clone(),
        application_kind: format!("{:?}", inputs.application.application_kind).to_ascii_lowercase(),
        environment_id: inputs
            .environment
            .as_ref()
            .map(|environment| environment.id.clone()),
        environment_kind: inputs
            .environment
            .as_ref()
            .map(|environment| format!("{:?}", environment.kind).to_ascii_lowercase()),
        server_id: inputs.server_id.clone(),
        service_count: inputs.services.len() as i64,
        domain_count: inputs.domains.len() as i64,
        has_capability_profile: inputs.capability.is_some(),
        has_capacity_profile: inputs.capacity.is_some(),
        domains: inputs
            .domains
            .iter()
            .map(|binding| super::model::DomainReference {
                binding_id: binding.id.clone(),
                domain: binding.domain.clone(),
            })
            .collect(),
        observed_resources: inputs.observed.clone(),
    };

    let mut proposal = DeploymentProposal {
        id: String::new(),
        schema_version: PROPOSAL_SCHEMA_VERSION.to_string(),
        application_id: inputs.application.id.clone(),
        environment_id: snapshot.environment_id.clone(),
        server_id: inputs.server_id.clone(),
        status: ProposalStatus::Draft,
        summary: ProposalSummary {
            headline,
            statements,
        },
        assumptions: capacity_estimate.recommendation.assumptions.clone(),
        unknowns: unknowns.clone(),
        recommended_topology: outcome.topology.recommended.clone(),
        alternative_topologies: outcome.topology.alternatives.clone(),
        services: outcome.services.clone(),
        dependencies: outcome.dependencies.clone(),
        capacity_recommendation: capacity_estimate.recommendation.clone(),
        domains: outcome.domains.clone(),
        workflow: outcome.workflow.clone(),
        risks: outcome.risks.clone(),
        approvals: outcome.approvals.clone(),
        rollback_strategy: outcome.rollback.clone(),
        knowledge_references: knowledge.references.clone(),
        knowledge_conflicts: conflicts.clone(),
        validation: ProposalValidation::empty(),
        ai_review: None,
        inputs: snapshot.clone(),
        fingerprint: ProposalFingerprint {
            engine_version: ENGINE_VERSION.to_string(),
            schema_version: PROPOSAL_SCHEMA_VERSION.to_string(),
            model: advisor.map(|advisor| advisor.model()),
            prompt_version: PROMPT_VERSION.to_string(),
            knowledge_version: knowledge.version.clone(),
            input_hash: input_hash(inputs, &knowledge),
            output_hash: String::new(),
            generated_at: inputs.now,
        },
        created_at: inputs.now,
    };

    // ---- 6. AI 批注（可选，且只加不改）----
    if let Some(advisor) = advisor {
        if let Some(review) = super::ai::apply(advisor, &mut proposal) {
            // 批注以"建议"身份进摘要，等级是 Recommendation，不参与任何决策。
            proposal
                .summary
                .statements
                .extend(review.notes.iter().cloned());
            proposal.ai_review = Some(review);
        }
    }

    // ---- 7. 校验 ----
    let mut validation = ProposalValidation {
        checks: rules::checks(&outcome),
        violations: outcome.violations.clone(),
    };
    if !downgraded.is_empty() {
        validation.checks.push(ProposalCheck {
            id: "policy-hardened".to_string(),
            label: "Security policy".to_string(),
            state: crate::project_readiness::CheckState::Blocked,
            detail: format!(
                "以下策略项被尝试放松，已强制恢复为安全默认值：{}",
                downgraded.join(", ")
            ),
        });
    }
    let value = serde_json::to_value(&proposal).unwrap_or(serde_json::Value::Null);
    let full = checks::merge(vec![
        validation,
        checks::validate_schema(&value),
        checks::validate_no_shell(&value),
    ]);
    proposal.validation = full;

    // ---- 8. ready / approvable，并清空不可执行的工作流 ----
    let blocking_unknowns: Vec<Unknown> = proposal
        .unknowns
        .iter()
        .filter(|unknown| unknown.severity == UnknownSeverity::BlocksPlan)
        .cloned()
        .collect();
    let blockers: Vec<_> = proposal
        .validation
        .violations
        .iter()
        .filter(|violation| violation.blocks_plan)
        .cloned()
        .collect();
    let ready =
        blocking_unknowns.is_empty() && blockers.is_empty() && !proposal.workflow.nodes.is_empty();
    if !ready {
        // **缺关键字段就不给可执行计划**：清空节点与边，只留说明。
        proposal.workflow = ProposedWorkflow {
            nodes: Vec::new(),
            edges: Vec::new(),
            notes: outcome.workflow.notes.clone(),
        };
    }
    let approvable = ready
        && !proposal.validation.blocks_approval()
        && !proposal
            .unknowns
            .iter()
            .any(|unknown| unknown.severity == UnknownSeverity::BlocksApproval)
        && !proposal.risks.iter().any(|risk| risk.blocks_approval);

    // ---- 9. 输出哈希（在"清空工作流"之后算，反映最终产物）----
    proposal.fingerprint.output_hash = output_hash(&proposal);

    ProposalOutcome {
        ready,
        approvable,
        open_questions: proposal
            .unknowns
            .iter()
            .filter(|unknown| unknown.severity != UnknownSeverity::Info)
            .cloned()
            .collect(),
        blockers,
        proposal,
    }
}

fn headline_of(
    inputs: &ProposalInputs,
    outcome: &rules::RuleOutcome,
    production_like: bool,
) -> String {
    let environment = inputs
        .environment
        .as_ref()
        .map(|environment| environment.name.clone())
        .unwrap_or_else(|| "(no environment)".to_string());
    format!(
        "Deploy {} service(s) to {} on {} using {}",
        inputs.services.len(),
        environment,
        inputs.server_id,
        outcome.topology.recommended.name,
    ) + if production_like {
        " — production-like, human approval required"
    } else {
        ""
    }
}

/// 引擎自己的"不知道"（与容量、规则引擎的都不同）。
fn engine_unknowns(
    inputs: &ProposalInputs,
    conflicts: &[KnowledgeConflict],
    knowledge: &KnowledgeResult,
) -> Vec<Unknown> {
    let mut out: Vec<Unknown> = Vec::new();
    if inputs.services.is_empty() {
        out.push(
            Unknown::blocking(
                "q-services",
                "这个应用还没有任何服务，先在「服务」里建一个。",
                "没有服务就没有可部署的东西，方案只能是空的。",
            )
            .suggest("至少建一个服务并指定运行方式"),
        );
    }
    if inputs.environment.is_none() {
        out.push(
            Unknown::blocking(
                "q-environment",
                "这个应用还没有环境（部署到哪台机器、哪个根目录）。",
                "服务目录、域名与容量都以环境为边界，没有环境就无法校验路径与规格。",
            )
            .suggest("先建一个环境并填部署根目录"),
        );
    }
    if inputs.capability.is_none() {
        out.push(
            Unknown::approval(
                "q-capability",
                "还没有这台服务器的能力图谱（装了什么运行时 / Docker / Nginx）。",
                "没有能力事实，推荐形态只能靠猜；「以实时事实为准」这条规则也就无从执行。",
            )
            .suggest("在「服务器项目」里跑一次扫描，或确保连接着服务器再生成方案"),
        );
    }
    for conflict in conflicts
        .iter()
        .filter(|conflict| conflict.resolution == super::model::ConflictResolution::Unresolved)
    {
        out.push(
            Unknown::blocking(
                &format!("q-conflict-{}", conflict.topic.replace('.', "-")),
                format!(
                    "知识库有两条结论冲突，需要你选一条（{}）：{}",
                    conflict.entries.join(" vs "),
                    conflict.statements.join(" / ")
                ),
                "冲突不裁定就生成计划，等于替你静默做了一次取舍 —— 那是不允许的。",
            )
            .suggest("如果服务器已装 Docker，通常选容器那条；否则选进程托管。"),
        );
    }
    // 知识库给出了硬性检查项，但方案里没有对应动作时，提醒用户。
    for (id, statement) in &knowledge.checklist {
        if statement.contains("备份") {
            out.push(Unknown::info(
                &format!("q-checklist-{}", id.replace('.', "-")),
                format!("检查项：{statement}"),
                "这是知识库给出的上线前检查项，方案本身不含备份动作。",
            ));
        }
    }
    out.sort_by(|left, right| left.id.cmp(&right.id));
    out
}

/// 检索条件（从输入里汇总，全部是确定性映射）。
fn knowledge_query(inputs: &ProposalInputs, production_like: bool) -> KnowledgeQuery {
    let mut languages: Vec<String> = Vec::new();
    let mut service_kinds: Vec<String> = Vec::new();
    let mut tags: Vec<String> = Vec::new();
    for service in &inputs.services {
        let kind = format!("{:?}", service.service_kind).to_ascii_lowercase();
        // Rust 的 snake_case 与知识库里的写法一致（`service_kind: "static_nginx"`）。
        let kind = kind
            .replace("staticnginx", "static_nginx")
            .replace("systemdunit", "systemd_unit")
            .replace("dockerimage", "docker_image")
            .replace("dockercompose", "docker_compose")
            .replace("javajar", "java_jar")
            .replace("nodeprocess", "node_process")
            .replace("pythonvenv", "python_venv")
            .replace("nativebinary", "native_binary")
            .replace("externalmanaged", "external_managed");
        service_kinds.push(kind.clone());
        match kind.as_str() {
            "static_nginx" => languages.push("static".to_string()),
            "node_process" => languages.push("node".to_string()),
            "python_venv" => languages.push("python".to_string()),
            "java_jar" => languages.push("java".to_string()),
            _ => {}
        }
        if kind == "external_managed" {
            tags.push("external".to_string());
        }
    }

    let deployable = inputs
        .services
        .iter()
        .filter(|service| service.service_kind != ServiceKind::ExternalManaged)
        .count();
    if deployable > 1 {
        tags.push("multi-service".to_string());
    } else {
        tags.push("single-service".to_string());
        tags.push("simple".to_string());
    }
    if inputs.services.iter().any(|service| {
        matches!(
            service.service_kind,
            ServiceKind::DockerImage | ServiceKind::DockerCompose
        )
    }) {
        tags.push("container".to_string());
    }
    if inputs
        .services
        .iter()
        .any(|service| service.service_kind == ServiceKind::StaticNginx)
    {
        tags.push("frontend".to_string());
    }
    if inputs.services.iter().any(|service| {
        matches!(
            service.role,
            crate::deployment::model::ServiceRole::Database
                | crate::deployment::model::ServiceRole::Cache
        )
    }) {
        tags.push("database".to_string());
    }
    if inputs.artifacts.iter().any(|artifact| {
        artifact.source_kind == crate::deployment::model::ArtifactSourceKind::DockerRegistry
    }) {
        tags.push("registry".to_string());
    }
    if inputs
        .capacity
        .as_ref()
        .and_then(|profile| profile.availability_target.as_deref())
        .is_some_and(|target| {
            target.contains("99.9") || target.contains("99.95") || target.contains("99.99")
        })
    {
        tags.push("ha".to_string());
        tags.push("availability".to_string());
    }
    if production_like {
        tags.push("backup".to_string());
        tags.push("dr".to_string());
    }

    languages.sort();
    languages.dedup();
    service_kinds.sort();
    service_kinds.dedup();
    tags.sort();
    tags.dedup();
    KnowledgeQuery {
        languages,
        service_kinds,
        tags,
        production_like,
    }
}

/// 输入哈希：**规范化后的输入快照**（排序 + 去掉时间戳）。
pub fn input_hash(inputs: &ProposalInputs, knowledge: &KnowledgeResult) -> String {
    let mut services: Vec<serde_json::Value> = inputs
        .services
        .iter()
        .map(|service| serde_json::to_value(service).unwrap_or(serde_json::Value::Null))
        .collect();
    services.sort_by_key(|value| value.to_string());

    let mut artifacts: Vec<String> = inputs
        .artifacts
        .iter()
        .map(|artifact| {
            format!(
                "{}|{:?}|{:?}|{}|{}",
                artifact.id,
                artifact.kind,
                artifact.source_kind,
                artifact.source_ref,
                artifact.sha256.clone().unwrap_or_default()
            )
        })
        .collect();
    artifacts.sort();

    let mut domains: Vec<String> = inputs
        .domains
        .iter()
        .map(|binding| {
            format!(
                "{}|{}|{}",
                binding.domain, binding.listen_port, binding.path_prefix
            )
        })
        .collect();
    domains.sort();

    let mut relations: Vec<String> = inputs
        .relations
        .iter()
        .map(|relation| {
            format!(
                "{}|{}|{:?}",
                relation.from_service_id, relation.to_service_id, relation.relation_kind
            )
        })
        .collect();
    relations.sort();

    let mut facts: Vec<String> = inputs
        .facts
        .iter()
        .map(|facts| {
            format!(
                "{}|{:?}|{}",
                facts.service_unit_id, facts.ports, facts.artifact_blocked
            )
        })
        .collect();
    facts.sort();

    let canonical = serde_json::json!({
        "engine_version": ENGINE_VERSION,
        "knowledge_version": knowledge.version,
        "application": inputs.application,
        "environment": inputs.environment,
        "server_id": inputs.server_id,
        "services": services,
        "artifacts": artifacts,
        "domains": domains,
        "relations": relations,
        "facts": facts,
        "capability": inputs.capability,
        "capacity": inputs.capacity,
        "policy": inputs.policy,
        "observed": inputs.observed,
    });
    fingerprint::hash_bytes(canonical.to_string().as_bytes())
}

/// 输出哈希：**去掉 id / 时间戳**后的方案正文。
pub fn output_hash(proposal: &DeploymentProposal) -> String {
    let mut clone = proposal.clone();
    clone.id = String::new();
    clone.created_at = 0;
    clone.fingerprint.generated_at = 0;
    clone.fingerprint.output_hash = String::new();
    let text = serde_json::to_string(&clone).unwrap_or_default();
    fingerprint::hash_bytes(text.as_bytes())
}

/// 兼容旧签名：`Assumption` 在引擎外被复用时不必重新导入模型层。
pub fn assumptions_of(proposal: &DeploymentProposal) -> &[Assumption] {
    &proposal.assumptions
}
