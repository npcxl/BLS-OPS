//! 确定性规则引擎：**拓扑选择 → 服务/依赖/域名 → 工作流 → 风险 → 审批 → 回滚**。
//!
//! # 为什么 AI 不在这一层
//!
//! 这一层不调用任何模型。方案是"算"出来的：同样输入必然同样输出，
//! 每条结论都能追到知识条目、服务器事实或用户输入。AI（[`super::ai`]）只在
//! 这之后做**可选增强**，且它的输出要过同一套校验。
//!
//! # 服务器事实优先于知识库
//!
//! 知识库说"多服务用 compose"，但服务器没装 Docker —— 那就不能推荐 compose。
//! 这不是"冲突"，而是**事实覆盖偏好**，会被记成一条带证据的说明
//! （[`Statement`]），用户在"为什么不是 compose"里能看到原因。

use std::collections::BTreeSet;

use super::capacity::CapacityEstimate;
use super::knowledge::{self, KnowledgeResult};
use super::model::{
    Evidence, EvidenceClass, EvidenceSource, HealthCheckPlan, KnowledgeConflict, ProposalViolation,
    ProposedApproval, ProposedDependency, ProposedDomain, ProposedRisk, ProposedService,
    ProposedWorkflow, ResourceEstimate, RollbackStrategy, SecurityPolicy, Statement,
    StatementImpact, TopologyKind, TopologyOption, TopologyPlan, Unknown, ViolationKind,
};
use super::workflow::{self, WorkflowInputs, WorkflowService};
use crate::capability_probe::ServerCapabilityProfile;
use crate::deployment::model::{
    ArtifactKind, ArtifactRecord, ArtifactSourceKind, DeploymentEnvironment, DomainBinding,
    PortMapping, PortProtocol, RiskLevel, ServiceKind, ServiceRelation, ServiceRuntime,
    ServiceUnit, SslMode, SslStatus,
};
use crate::project_readiness::CheckState;

/// 制品怎么进服务器。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactDisposition {
    /// 没有制品（或者不需要）。
    None,
    /// 上传单个文件（JAR / 二进制 / Dockerfile 之外的产物）。
    Upload,
    /// 上传压缩包并解压。
    Extract,
    /// 从镜像仓库拉取。
    Pull,
    /// 现场构建镜像（有 Dockerfile）。
    BuildImage,
    /// 服务器上本来就有，不用搬。
    AlreadyOnServer,
}

/// 命令层从 P5.1 识别结果里抽出来的"服务事实"。
///
/// 引擎不直接依赖 `ArtifactInspection`：那样会把"识别"与"规划"耦合起来，
/// 也让单测必须造一份完整的识别结果。这里只要几个数。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ServiceFacts {
    pub service_unit_id: String,
    /// 识别出来的端口（宿主机 ↔ 容器）。
    pub ports: Vec<PortMapping>,
    /// 健康检查目标（`/healthz` 或 `127.0.0.1:3000`）。
    pub health_target: Option<String>,
    /// 环境变量名。
    pub env_keys: Vec<String>,
    /// 制品里是否有阻断项（密钥 / 逃逸路径等）。
    pub artifact_blocked: bool,
    /// 阻断原因（给人看）。
    pub artifact_blocked_reason: Option<String>,
}

/// 规则引擎输入。
pub struct RuleInputs<'a> {
    pub application_id: String,
    pub environment: Option<&'a DeploymentEnvironment>,
    pub server_id: String,
    pub services: &'a [ServiceUnit],
    pub relations: &'a [ServiceRelation],
    pub artifacts: &'a [ArtifactRecord],
    pub domains: &'a [DomainBinding],
    pub facts: &'a [ServiceFacts],
    pub capability: Option<&'a ServerCapabilityProfile>,
    pub capacity: &'a CapacityEstimate,
    pub knowledge: &'a KnowledgeResult,
    pub policy: &'a SecurityPolicy,
    pub production_like: bool,
    /// 知识库冲突（已尽量用事实/策略裁定）。
    pub conflicts: &'a [KnowledgeConflict],
}

/// 规则引擎输出。
pub struct RuleOutcome {
    pub topology: TopologyPlan,
    pub services: Vec<ProposedService>,
    pub dependencies: Vec<ProposedDependency>,
    pub domains: Vec<ProposedDomain>,
    pub workflow: ProposedWorkflow,
    pub risks: Vec<ProposedRisk>,
    pub approvals: Vec<ProposedApproval>,
    pub rollback: RollbackStrategy,
    pub statements: Vec<Statement>,
    pub unknowns: Vec<Unknown>,
    pub violations: Vec<ProposalViolation>,
}

// -- 能力事实 ---------------------------------------------------------------

/// 读一个能力字段。`None` = **未探测**（既不是"有"也不是"没有"）。
fn capability(profile: Option<&ServerCapabilityProfile>, field: &str) -> Option<bool> {
    knowledge::capability_value(profile?, field)
}

fn capability_evidence(profile: Option<&ServerCapabilityProfile>, field: &str) -> Evidence {
    let value = capability(profile, field);
    let (class, detail) = match value {
        Some(true) => (EvidenceClass::Fact, format!("{field} 已安装")),
        Some(false) => (EvidenceClass::Fact, format!("{field} 未安装")),
        None => (
            EvidenceClass::Unknown,
            format!("{field} 未探测（既没确认有，也没确认没有）"),
        ),
    };
    Evidence {
        class,
        source: EvidenceSource::ServerFact {
            field: field.to_string(),
        },
        detail,
        reference: Some(field.to_string()),
    }
}

// -- 拓扑 -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Family {
    static_files: usize,
    process: usize,
    container: usize,
    external: usize,
}

impl Family {
    fn deployable(self) -> usize {
        self.static_files + self.process + self.container
    }
}

fn family_of(kind: ServiceKind) -> &'static str {
    match kind {
        ServiceKind::StaticNginx => "static",
        ServiceKind::SystemdUnit
        | ServiceKind::JavaJar
        | ServiceKind::NodeProcess
        | ServiceKind::PythonVenv
        | ServiceKind::NativeBinary => "process",
        ServiceKind::DockerImage | ServiceKind::DockerCompose => "container",
        ServiceKind::ExternalManaged => "external",
    }
}

fn family_stats(services: &[ServiceUnit]) -> Family {
    let mut family = Family::default();
    for service in services {
        match family_of(service.service_kind) {
            "static" => family.static_files += 1,
            "process" => family.process += 1,
            "container" => family.container += 1,
            _ => family.external += 1,
        }
    }
    family
}

struct Draft {
    kind: TopologyKind,
    service_names: Vec<String>,
    covers_all: bool,
    blockers: Vec<String>,
    pros: Vec<String>,
    cons: Vec<String>,
    evidence: Vec<Evidence>,
    unverified: usize,
}

fn draft_for(
    kind: TopologyKind,
    names: Vec<String>,
    family: Family,
    capability_profile: Option<&ServerCapabilityProfile>,
    _knowledge: &KnowledgeResult,
) -> Draft {
    let mut draft = Draft {
        kind,
        service_names: names,
        covers_all: false,
        blockers: Vec::new(),
        pros: Vec::new(),
        cons: Vec::new(),
        evidence: Vec::new(),
        unverified: 0,
    };

    // 需要哪些能力：`Some(false)` 一票否决；`None` 只记账（未探测）。
    let mut required: Vec<&str> = Vec::new();
    match kind {
        TopologyKind::StaticNginx => required.push("deployment.nginx"),
        TopologyKind::SystemdProcesses => required.push("deployment.systemd"),
        TopologyKind::DockerCompose => {
            required.push("deployment.docker");
            required.push("deployment.docker_compose");
        }
        TopologyKind::DockerImages => required.push("deployment.docker"),
        TopologyKind::HybridGateway => {
            required.push("deployment.nginx");
            if family.container > 0 {
                required.push("deployment.docker");
            }
            if family.process > 0 {
                required.push("deployment.systemd");
            }
        }
    }
    for field in required {
        let evidence = capability_evidence(capability_profile, field);
        match capability(capability_profile, field) {
            Some(false) => draft
                .blockers
                .push(format!("服务器上没有 {field}（实时事实）")),
            None => {
                draft.unverified += 1;
                draft.cons.push(format!("{field} 未探测：部署前必须确认"));
            }
            Some(true) => draft.pros.push(format!("{field} 已安装")),
        }
        draft.evidence.push(evidence);
    }

    draft.covers_all = draft.service_names.len() == family.deployable() && family.deployable() > 0;
    draft
}

/// 选出推荐拓扑与备选拓扑。
fn plan_topologies(inputs: &RuleInputs<'_>) -> TopologyPlan {
    let family = family_stats(inputs.services);
    let mut drafts: Vec<Draft> = Vec::new();

    let names_of = |filter: fn(&ServiceUnit) -> bool| -> Vec<String> {
        let mut names: Vec<String> = inputs
            .services
            .iter()
            .filter(|service| filter(service))
            .map(|service| service.name.clone())
            .collect();
        names.sort();
        names
    };

    let static_names = names_of(|service| family_of(service.service_kind) == "static");
    let process_names = names_of(|service| family_of(service.service_kind) == "process");
    let container_names = names_of(|service| family_of(service.service_kind) == "container");
    let all_names = names_of(|service| family_of(service.service_kind) != "external");

    if !static_names.is_empty() {
        drafts.push(draft_for(
            TopologyKind::StaticNginx,
            static_names,
            family,
            inputs.capability,
            inputs.knowledge,
        ));
    }
    if !process_names.is_empty() {
        drafts.push(draft_for(
            TopologyKind::SystemdProcesses,
            process_names,
            family,
            inputs.capability,
            inputs.knowledge,
        ));
    }
    if !container_names.is_empty() {
        drafts.push(draft_for(
            TopologyKind::DockerCompose,
            container_names.clone(),
            family,
            inputs.capability,
            inputs.knowledge,
        ));
        // 单容器形态与服务逐个领容器两种都给出，让用户看到取舍。
        if container_names.len() == 1 {
            drafts.push(draft_for(
                TopologyKind::DockerImages,
                container_names.clone(),
                family,
                inputs.capability,
                inputs.knowledge,
            ));
        }
    }
    if family.deployable() > 1
        && (family.static_files > 0 || family.process > 0)
        && family.container > 0
    {
        drafts.push(draft_for(
            TopologyKind::HybridGateway,
            all_names.clone(),
            family,
            inputs.capability,
            inputs.knowledge,
        ));
    }
    if drafts.is_empty() {
        // 没有任何可部署服务（全外部托管）：给一个"网关优先"的空壳，
        // 让用户至少能看到"这件事本工具不做"。
        drafts.push(draft_for(
            TopologyKind::StaticNginx,
            Vec::new(),
            family,
            inputs.capability,
            inputs.knowledge,
        ));
    }

    let score = |draft: &Draft| -> i32 {
        let kb_weight = inputs
            .knowledge
            .preferred
            .iter()
            .filter(|(kind, _, _)| *kind == draft.kind)
            .map(|(_, weight, _)| i32::from(*weight))
            .max()
            .unwrap_or(0);
        let avoided = inputs
            .knowledge
            .avoided
            .iter()
            .any(|(kind, _)| *kind == draft.kind);
        let mut score = kb_weight * 2;
        if draft.covers_all {
            score += 40;
        }
        score += (6 - i32::from(draft.kind.complexity())) * 4;
        if avoided {
            score -= 60;
        }
        score -= (draft.unverified as i32) * 5;
        if !draft.blockers.is_empty() {
            score -= 1000;
        }
        score
    };

    drafts.sort_by(|left, right| {
        let left_ok = left.blockers.is_empty();
        let right_ok = right.blockers.is_empty();
        right_ok
            .cmp(&left_ok)
            .then_with(|| score(right).cmp(&score(left)))
            .then_with(|| left.kind.cmp(&right.kind))
    });

    let mut options: Vec<TopologyOption> = drafts
        .into_iter()
        .map(|draft| {
            let mut cons = draft.cons.clone();
            for (kind, reason) in &inputs.knowledge.avoided {
                if *kind == draft.kind {
                    cons.push(format!("知识库不推荐该形态：{reason}"));
                }
            }
            if !draft.covers_all && !draft.service_names.is_empty() {
                cons.push("只能覆盖一部分服务，其余服务需要另一种形态".to_string());
            }
            TopologyOption {
                id: format!("topology-{}", slug(draft.kind.label())),
                kind: draft.kind,
                name: draft.kind.label().to_string(),
                description: describe(draft.kind),
                pros: dedup_sorted(draft.pros),
                cons: dedup_sorted(cons),
                complexity: draft.kind.complexity(),
                monthly_cost_hint: inputs.capacity.recommendation.monthly_cost_hint,
                feasible: draft.blockers.is_empty(),
                blockers: dedup_sorted(draft.blockers),
                service_names: draft.service_names,
                evidence: draft.evidence,
            }
        })
        .collect();
    if options.is_empty() {
        // 理论上到不了这里（上面兜过底），但绝不给一个空结构。
        options.push(TopologyOption {
            id: "topology-static".to_string(),
            kind: TopologyKind::StaticNginx,
            name: TopologyKind::StaticNginx.label().to_string(),
            description: describe(TopologyKind::StaticNginx),
            pros: Vec::new(),
            cons: vec!["没有识别到可部署服务".to_string()],
            complexity: 1,
            monthly_cost_hint: None,
            feasible: false,
            blockers: vec!["没有可部署的服务".to_string()],
            service_names: Vec::new(),
            evidence: Vec::new(),
        });
    }

    let recommended = options.remove(0);
    let mut rationale: Vec<Statement> = Vec::new();
    let mut evidence = vec![Evidence::derived(
        "rules.topology-score",
        format!(
            "在 {} 种形态里按知识库权重、覆盖度与复杂度打分，{} 得分最高",
            options.len() + 1,
            recommended.kind.label()
        ),
    )];
    evidence.extend(recommended.evidence.clone());
    rationale.push(Statement::inference(
        "topo-recommended",
        format!("推荐 {}：{}", recommended.name, recommended.description),
        evidence,
    ));

    // 知识库偏好与事实冲突时，必须说清为什么没听知识库的。
    let preferred_not_chosen: Vec<&(TopologyKind, u8, &'static str)> = inputs
        .knowledge
        .preferred
        .iter()
        .filter(|(kind, _, _)| *kind != recommended.kind)
        .collect();
    for (kind, weight, reason) in preferred_not_chosen {
        let blocked: Vec<String> = options
            .iter()
            .find(|option| option.kind == *kind)
            .map(|option| option.blockers.clone())
            .unwrap_or_default();
        if !blocked.is_empty() {
            rationale.push(Statement::inference(
                "topo-fact-overrides-knowledge",
                format!(
                    "知识库倾向「{}」（权重 {weight}），但服务器实时事实不允许，因此未采用。",
                    kind.label()
                ),
                vec![
                    Evidence::knowledge(
                        "kb-topology",
                        knowledge::KNOWLEDGE_VERSION,
                        format!("知识库理由：{reason}"),
                    ),
                    Evidence::derived("rules.fact-wins", blocked.join("；")),
                ],
            ));
        }
    }
    if !recommended.feasible {
        rationale.push(
            Statement::inference(
                "topo-no-feasible",
                "没有任何形态能在当前服务器上落地：先补上缺失的能力（或换一台机器）。",
                recommended.evidence.clone(),
            )
            .with_impact(StatementImpact::Blocking),
        );
    }

    TopologyPlan {
        recommended,
        alternatives: options,
        rationale,
    }
}

fn describe(kind: TopologyKind) -> String {
    match kind {
        TopologyKind::StaticNginx => "静态产物直接由 Nginx 托管，没有常驻应用进程".to_string(),
        TopologyKind::SystemdProcesses => {
            "每个服务一个 systemd 单元；重启、开机自启与日志交给 init 系统".to_string()
        }
        TopologyKind::DockerCompose => {
            "整组服务交给一个 compose 项目，网络与启动顺序由 compose 表达".to_string()
        }
        TopologyKind::DockerImages => "每个服务一个独立容器，逐个管理".to_string(),
        TopologyKind::HybridGateway => {
            "静态走 Nginx、进程走 systemd、容器走 Docker，网关统一在前".to_string()
        }
    }
}

fn dedup_sorted(values: Vec<String>) -> Vec<String> {
    let set: BTreeSet<String> = values.into_iter().collect();
    set.into_iter().collect()
}

fn slug(value: &str) -> String {
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
    out.trim_matches('-').to_string()
}

// -- 服务 / 依赖 / 域名 -----------------------------------------------------

fn disposition_of(unit: &ServiceUnit, artifact: Option<&ArtifactRecord>) -> ArtifactDisposition {
    if unit.service_kind == ServiceKind::ExternalManaged {
        return ArtifactDisposition::None;
    }
    let Some(artifact) = artifact else {
        // 没有制品但运行方式用的是服务器上已有的东西（systemd 单元、已有目录）。
        return match unit.runtime {
            ServiceRuntime::SystemdUnit { .. } | ServiceRuntime::External { .. } => {
                ArtifactDisposition::None
            }
            _ => ArtifactDisposition::None,
        };
    };
    match artifact.source_kind {
        ArtifactSourceKind::ServerExistingDir => ArtifactDisposition::AlreadyOnServer,
        ArtifactSourceKind::DockerRegistry => ArtifactDisposition::Pull,
        ArtifactSourceKind::GitRef => ArtifactDisposition::BuildImage,
        ArtifactSourceKind::LocalPath => match artifact.kind {
            ArtifactKind::Zip | ArtifactKind::Tar | ArtifactKind::TarGz => {
                ArtifactDisposition::Extract
            }
            ArtifactKind::Dockerfile | ArtifactKind::ComposeFile => ArtifactDisposition::BuildImage,
            _ => ArtifactDisposition::Upload,
        },
    }
}

fn health_plan(target: &str, evidence: Vec<Evidence>, policy: &SecurityPolicy) -> HealthCheckPlan {
    HealthCheckPlan {
        kind: if target.starts_with('/') {
            "http".to_string()
        } else if target.is_empty() {
            "none".to_string()
        } else {
            "tcp".to_string()
        },
        target: target.to_string(),
        interval_seconds: 30,
        timeout_seconds: 5,
        failure_threshold: 3,
        evidence: {
            let mut evidence = evidence;
            if policy.require_health_check {
                evidence.push(Evidence {
                    class: EvidenceClass::Fact,
                    source: EvidenceSource::Platform {
                        policy: "require_health_check".to_string(),
                    },
                    detail: "安全策略：所有服务必须有健康检查".to_string(),
                    reference: None,
                });
            }
            evidence
        },
    }
}

fn default_health_target(
    unit: &ServiceUnit,
    facts: Option<&ServiceFacts>,
    knowledge: &KnowledgeResult,
) -> Option<(String, Vec<Evidence>)> {
    if let Some(target) = facts.and_then(|facts| facts.health_target.clone()) {
        if !target.trim().is_empty() {
            return Some((
                target,
                vec![Evidence::fact(
                    EvidenceSource::ArtifactFact {
                        path: "inspection.health".to_string(),
                    },
                    "来自制品识别结果",
                )],
            ));
        }
    }
    // 静态站点与 Nginx 托管：首页就是健康检查。
    if unit.service_kind == ServiceKind::StaticNginx {
        return Some((
            "/".to_string(),
            vec![Evidence::knowledge(
                "kb-static-frontend",
                knowledge::KNOWLEDGE_VERSION,
                "静态站点的健康检查就是首页可取",
            )],
        ));
    }
    // 知识库按服务类型给的默认路径。
    let key = match unit.service_kind {
        ServiceKind::JavaJar => "health.api",
        ServiceKind::NodeProcess | ServiceKind::PythonVenv => "health.api",
        _ => return None,
    };
    knowledge
        .health_paths
        .iter()
        .find(|(topic, _)| *topic == key)
        .map(|(_, path)| {
            (
                (*path).to_string(),
                vec![Evidence::knowledge(
                    "kb-health-default",
                    knowledge::KNOWLEDGE_VERSION,
                    format!("知识库按服务类型给出默认健康检查路径 {path}"),
                )],
            )
        })
}

/// 服务端口：优先用识别结果，其次用运行方式里声明的端口。
fn ports_of(unit: &ServiceUnit, facts: Option<&ServiceFacts>) -> (Vec<PortMapping>, Vec<Evidence>) {
    if let Some(facts) = facts {
        if !facts.ports.is_empty() {
            return (
                facts.ports.clone(),
                vec![Evidence::fact(
                    EvidenceSource::ArtifactFact {
                        path: "inspection.ports".to_string(),
                    },
                    "端口来自制品识别结果",
                )],
            );
        }
    }
    match &unit.runtime {
        ServiceRuntime::DockerImage { ports, .. } if !ports.is_empty() => (
            ports.clone(),
            vec![Evidence::fact(
                EvidenceSource::ServerFact {
                    field: "service_units.runtime.ports".to_string(),
                },
                "端口在服务定义里显式声明",
            )],
        ),
        ServiceRuntime::StaticNginx { .. } => (
            vec![PortMapping {
                host_port: 80,
                container_port: 80,
                protocol: PortProtocol::Tcp,
            }],
            vec![Evidence::knowledge(
                "kb-static-frontend",
                knowledge::KNOWLEDGE_VERSION,
                "静态站点对外是 80/443，由 Nginx 统一监听",
            )],
        ),
        _ => (Vec::new(), Vec::new()),
    }
}

fn proposed_services(inputs: &RuleInputs<'_>) -> (Vec<ProposedService>, Vec<Unknown>) {
    let mut unknowns: Vec<Unknown> = Vec::new();
    let count = inputs.services.len().max(1) as f64;
    let total = &inputs.capacity.recommendation;
    let mut out: Vec<ProposedService> = Vec::new();

    for unit in inputs.services {
        let artifact = unit
            .artifact_id
            .as_deref()
            .and_then(|id| inputs.artifacts.iter().find(|artifact| artifact.id == id));
        let facts = inputs
            .facts
            .iter()
            .find(|facts| facts.service_unit_id == unit.id);
        let (ports, mut evidence) = ports_of(unit, facts);
        evidence.extend(
            artifact
                .map(|artifact| {
                    vec![Evidence::fact(
                        EvidenceSource::ArtifactFact {
                            path: artifact.source_ref.clone(),
                        },
                        format!("制品 {:?}（{:?}）", artifact.kind, artifact.source_kind),
                    )]
                })
                .unwrap_or_default(),
        );

        let external = unit.service_kind == ServiceKind::ExternalManaged;
        let estimate = if external {
            ResourceEstimate {
                cpu_cores: 0.0,
                memory_mb: 0,
                disk_mb: 0,
                basis: EvidenceClass::Fact,
                evidence: vec![Evidence::fact(
                    EvidenceSource::Platform {
                        policy: "external_managed".to_string(),
                    },
                    "外部托管组件不由本工具部署，不占本机资源",
                )],
            }
        } else {
            ResourceEstimate {
                // 总量按服务数均分：这是**推荐值**，不是事实。
                cpu_cores: (total.vcpu / count * 2.0).round() / 2.0,
                memory_mb: (total.memory_mb as f64 / count).round() as i64,
                disk_mb: (total.disk_gb * 1024.0 / count).round() as i64,
                basis: EvidenceClass::Inference,
                evidence: vec![Evidence::derived(
                    "rules.resource-split",
                    "按服务数均分整机容量建议（总量见容量评估）",
                )],
            }
        };

        let health_check = if external {
            // 外部组件的健康检查是"连得上"，但目标端口未知时不臆造。
            None
        } else {
            default_health_target(unit, facts, inputs.knowledge).map(|(target, target_evidence)| {
                health_plan(&target, target_evidence, inputs.policy)
            })
        };
        if !external && health_check.is_none() && inputs.policy.require_health_check {
            unknowns.push(
                Unknown::approval(
                    &format!("q-health-{}", slug(&unit.name)),
                    format!("服务「{}」的健康检查目标是什么？", unit.name),
                    "安全策略要求所有服务可被健康检查；没有它，部署成功与否只能靠人工看。",
                )
                .suggest("如果是 HTTP 服务，建议暴露 /healthz"),
            );
        }
        if !external && ports.is_empty() {
            unknowns.push(Unknown::info(
                &format!("q-port-{}", slug(&unit.name)),
                format!("服务「{}」监听哪个端口？", unit.name),
                "端口没定就无法生成网关与健康检查配置。",
            ));
        }

        let env_keys = facts
            .map(|facts| facts.env_keys.clone())
            .unwrap_or_default();

        out.push(ProposedService {
            service_unit_id: unit.id.clone(),
            name: unit.name.clone(),
            role: unit.role,
            service_kind: unit.service_kind,
            runtime: unit.runtime.clone(),
            artifact_id: unit.artifact_id.clone(),
            artifact_kind: artifact.map(|artifact| artifact.kind),
            deploy_path: unit.deploy_path.clone(),
            ports,
            health_check,
            env_keys,
            resource_estimate: estimate,
            evidence,
        });
    }
    out.sort_by(|left, right| left.name.cmp(&right.name));
    unknowns.sort_by(|left, right| left.id.cmp(&right.id));
    (out, unknowns)
}

fn proposed_dependencies(
    inputs: &RuleInputs<'_>,
    services: &[ProposedService],
) -> (Vec<ProposedDependency>, Vec<Unknown>) {
    let mut out: Vec<ProposedDependency> = Vec::new();
    let name_of = |id: &str| -> Option<String> {
        inputs
            .services
            .iter()
            .find(|service| service.id == id)
            .map(|service| service.name.clone())
    };
    for relation in inputs.relations {
        let (Some(from), Some(to)) = (
            name_of(&relation.from_service_id),
            name_of(&relation.to_service_id),
        ) else {
            continue;
        };
        out.push(ProposedDependency {
            id: format!("dep-{}-{}", slug(&from), slug(&to)),
            from_service: from,
            to_service: to,
            relation_kind: relation.relation_kind,
            required: relation.required,
            failure_policy: relation.failure_policy,
            evidence: vec![Evidence::fact(
                EvidenceSource::UserInput {
                    field: "service_relations".to_string(),
                },
                "依赖关系由用户在服务定义里声明",
            )],
        });
    }
    out.sort_by(|left, right| left.id.cmp(&right.id));

    let mut unknowns: Vec<Unknown> = Vec::new();
    let external: Vec<&ProposedService> = services
        .iter()
        .filter(|service| service.service_kind == ServiceKind::ExternalManaged)
        .collect();
    for service in external {
        let declared = out
            .iter()
            .any(|dependency| dependency.to_service == service.name);
        if !declared {
            unknowns.push(Unknown::info(
                &format!("q-dep-{}", slug(&service.name)),
                format!("外部组件「{}」没有被任何服务声明为依赖。", service.name),
                "不声明依赖，部署顺序与故障策略就只能靠猜；声明后才能在依赖不可用时按策略处理。",
            ));
        }
    }
    (out, unknowns)
}

fn proposed_domains(inputs: &RuleInputs<'_>) -> Vec<ProposedDomain> {
    let mut out: Vec<ProposedDomain> = Vec::new();
    for binding in inputs.domains {
        let service_name = binding.service_unit_id.as_deref().and_then(|id| {
            inputs
                .services
                .iter()
                .find(|service| service.id == id)
                .map(|service| service.name.clone())
        });
        out.push(ProposedDomain {
            domain: binding.domain.clone(),
            service_name,
            listen_port: binding.listen_port,
            path_prefix: binding.path_prefix.clone(),
            ssl_mode: binding.ssl_mode,
            certificate_required: binding.ssl_mode == SslMode::Acme
                && binding.ssl_status != SslStatus::Issued,
            evidence: vec![Evidence::fact(
                EvidenceSource::UserInput {
                    field: "domain_bindings".to_string(),
                },
                format!("域名绑定：{}:{}", binding.domain, binding.listen_port),
            )],
        });
    }
    out.sort_by(|left, right| left.domain.cmp(&right.domain));
    out
}

// -- 风险 / 审批 / 回滚 -----------------------------------------------------

fn risks(
    inputs: &RuleInputs<'_>,
    topology: &TopologyPlan,
    services: &[ProposedService],
    domains: &[ProposedDomain],
) -> Vec<ProposedRisk> {
    let mut out: Vec<ProposedRisk> = Vec::new();
    // 可用性目标由容量评估从问卷里读出来（这里只取事实，不再重复解析问卷）。
    let availability = inputs
        .capacity
        .recommendation
        .evidence
        .iter()
        .find(|evidence| {
            matches!(
                &evidence.source,
                EvidenceSource::UserInput { field } if field == "availability_target"
            )
        })
        .map(|evidence| evidence.detail.clone());

    // 单节点 + 高可用性目标 = 假承诺。
    let high_availability = availability
        .as_deref()
        .map(|value| value.contains("99.9") || value.contains("99.95") || value.contains("99.99"))
        .unwrap_or(false);
    if high_availability {
        out.push(ProposedRisk {
            id: "risk-single-node-ha".to_string(),
            title: "Single node cannot deliver the requested availability".to_string(),
            severity: RiskLevel::High,
            likelihood: 80,
            impact: "主机、网络或磁盘任一环节故障都会导致整站不可用，实际可用性达不到目标值。"
                .to_string(),
            mitigation: "把可用性目标调回单机可承诺的范围，或增加冗余（多机 + 负载均衡）。"
                .to_string(),
            blocks_approval: true,
            evidence: vec![
                Evidence::knowledge(
                    "kb-availability-single-node",
                    knowledge::KNOWLEDGE_VERSION,
                    "单节点无法承诺 99.9% 及以上可用性",
                ),
                Evidence::fact(
                    EvidenceSource::UserInput {
                        field: "availability_target".to_string(),
                    },
                    format!("用户目标可用性 {availability:?}"),
                ),
            ],
        });
    }

    // 生产 + 无 HTTPS。
    if inputs.production_like && inputs.policy.require_https {
        let insecure = domains
            .iter()
            .filter(|domain| domain.ssl_mode == SslMode::None)
            .count();
        if !domains.is_empty() && insecure > 0 {
            out.push(ProposedRisk {
                id: "risk-no-tls".to_string(),
                title: "Production domains without TLS".to_string(),
                severity: RiskLevel::High,
                likelihood: 90,
                impact: "明文流量会暴露会话与凭据，也会被浏览器标记为不安全。".to_string(),
                mitigation: "为每个生产域名启用证书（ACME 自动签发或手动上传）。".to_string(),
                blocks_approval: true,
                evidence: vec![Evidence {
                    class: EvidenceClass::Fact,
                    source: EvidenceSource::Platform {
                        policy: "require_https".to_string(),
                    },
                    detail: format!("安全策略要求 HTTPS，但 {insecure} 个域名是明文"),
                    reference: None,
                }],
            });
        }
        if domains.is_empty() {
            out.push(ProposedRisk {
                id: "risk-no-domain".to_string(),
                title: "No domain bound in production".to_string(),
                severity: RiskLevel::Medium,
                likelihood: 60,
                impact: "没有域名就只能靠 IP 访问，无法启用 HTTPS，也无法做平滑切换。".to_string(),
                mitigation: "先登记域名并绑定到对应服务，再生成方案。".to_string(),
                blocks_approval: false,
                evidence: vec![Evidence::fact(
                    EvidenceSource::UserInput {
                        field: "domain_bindings".to_string(),
                    },
                    "当前没有登记任何域名",
                )],
            });
        }
    }

    // 容量：装不下 / 余量不足。
    if let Some(reason) = &inputs.capacity.insufficient {
        out.push(ProposedRisk {
            id: "risk-capacity".to_string(),
            title: "The server does not have enough resources".to_string(),
            severity: RiskLevel::High,
            likelihood: 100,
            impact: format!("{reason}。部署后会出现 OOM / 磁盘写满 / 调度变慢。"),
            mitigation: "先扩配或清理磁盘，或把部分服务迁到别的机器。".to_string(),
            blocks_approval: true,
            evidence: vec![Evidence::derived("capacity.fits", reason.clone())],
        });
    }
    if inputs.capacity.recommendation.monthly_cost_hint.is_some()
        && inputs
            .capacity
            .recommendation
            .assumptions
            .iter()
            .any(|assumption| assumption.id == "as-fallback-peak")
    {
        out.push(ProposedRisk {
            id: "risk-capacity-guess".to_string(),
            title: "Capacity is estimated from a default, not from real traffic".to_string(),
            severity: RiskLevel::Medium,
            likelihood: 70,
            impact: "规格可能明显偏小或偏大；偏小会直接影响线上稳定性。".to_string(),
            mitigation: "上线前按真实流量复核规格，并设置 CPU / 内存告警。".to_string(),
            blocks_approval: false,
            evidence: vec![Evidence::derived(
                "capacity.fallback",
                "本次容量按默认档估算，缺少真实量级数据",
            )],
        });
    }

    // 缺健康检查。
    let deployable: Vec<&ProposedService> = services
        .iter()
        .filter(|service| service.service_kind != ServiceKind::ExternalManaged)
        .collect();
    let without_health = deployable
        .iter()
        .filter(|service| service.health_check.is_none())
        .count();
    if without_health > 0 {
        out.push(ProposedRisk {
            id: "risk-no-health".to_string(),
            title: "Some services have no health check".to_string(),
            severity: RiskLevel::Medium,
            likelihood: 50,
            impact: "部署动作完成后无法自动判定服务是否真的可用，失败会被当成成功。".to_string(),
            mitigation: "为这些服务补一个健康检查端点或端口探测。".to_string(),
            blocks_approval: inputs.policy.require_health_check,
            evidence: vec![Evidence::derived(
                "rules.health-coverage",
                format!("{without_health} 个服务缺少健康检查目标"),
            )],
        });
    }

    // 知识库冲突未裁定。
    let unresolved: Vec<&KnowledgeConflict> = inputs
        .conflicts
        .iter()
        .filter(|conflict| conflict.resolution == super::model::ConflictResolution::Unresolved)
        .collect();
    if !unresolved.is_empty() {
        out.push(ProposedRisk {
            id: "risk-knowledge-conflict".to_string(),
            title: "Knowledge base conflict is unresolved".to_string(),
            severity: RiskLevel::High,
            likelihood: 100,
            impact: "两条知识给出相反结论，方案采用的是其中一条 —— 在用户裁定前不该上线。"
                .to_string(),
            mitigation: "在方案里选择一条结论，或补上能裁定的事实（例如探测服务器能力）。"
                .to_string(),
            blocks_approval: true,
            evidence: unresolved
                .iter()
                .map(|conflict| {
                    Evidence::derived(
                        "knowledge.conflict",
                        format!("{}：{}", conflict.topic, conflict.statements.join(" / ")),
                    )
                })
                .collect(),
        });
    }

    // 自建数据库的迁移不可逆。
    let self_hosted_db = inputs.services.iter().any(|service| {
        service.role == crate::deployment::model::ServiceRole::Database
            && service.service_kind != ServiceKind::ExternalManaged
    });
    if self_hosted_db {
        out.push(ProposedRisk {
            id: "risk-db-migration".to_string(),
            title: "Database migration is not automatically reversible".to_string(),
            severity: RiskLevel::High,
            likelihood: 60,
            impact: "迁移一旦执行，回滚服务版本也回不来数据；失败同时可能造成数据损坏。"
                .to_string(),
            mitigation: "迁移前做一次可验证的备份，并把迁移作为独立节点人工审批。".to_string(),
            blocks_approval: true,
            evidence: vec![Evidence::derived(
                "rules.self-hosted-db",
                "存在非外部托管的数据库服务",
            )],
        });
    }

    // 没有回滚计划。
    if !inputs.policy.require_rollback_plan {
        out.push(ProposedRisk {
            id: "risk-no-rollback".to_string(),
            title: "No rollback plan required by policy".to_string(),
            severity: RiskLevel::Medium,
            likelihood: 40,
            impact: "出问题时只能人工逆向操作，恢复时间不可预期。".to_string(),
            mitigation: "开启「要求回滚计划」，方案会自动带上版本回滚节点。".to_string(),
            blocks_approval: false,
            evidence: vec![Evidence {
                class: EvidenceClass::Fact,
                source: EvidenceSource::Platform {
                    policy: "require_rollback_plan".to_string(),
                },
                detail: "安全策略未要求回滚计划".to_string(),
                reference: None,
            }],
        });
    }

    // 拓扑本身不可行。
    if !topology.recommended.feasible {
        out.push(ProposedRisk {
            id: "risk-no-topology".to_string(),
            title: "No deployable topology on this server".to_string(),
            severity: RiskLevel::Critical,
            likelihood: 100,
            impact: "缺少必需组件（如 Docker / Nginx），方案无法落地。".to_string(),
            mitigation: "先在该服务器安装缺失组件，或改用其它部署形态。".to_string(),
            blocks_approval: true,
            evidence: topology
                .recommended
                .blockers
                .iter()
                .map(|blocker| Evidence::derived("rules.topology-blocker", blocker.clone()))
                .collect(),
        });
    }

    out.sort_by(|left, right| {
        right
            .severity
            .cmp(&left.severity)
            .then_with(|| left.id.cmp(&right.id))
    });
    out
}

fn approvals(inputs: &RuleInputs<'_>, workflow: &ProposedWorkflow) -> Vec<ProposedApproval> {
    let mut out: Vec<ProposedApproval> = Vec::new();
    for (node_key, risk) in workflow::approval_nodes(&workflow.nodes) {
        out.push(ProposedApproval {
            id: format!("approval-{}", slug(&node_key)),
            node_key: Some(node_key.clone()),
            reason: format!("节点「{node_key}」的风险级别是 {risk:?}，必须人工确认"),
            required_role: "operator".to_string(),
            // 恒为 true：审批不能被"关掉"，只能被人满足。
            required: true,
            evidence: vec![Evidence::derived(
                "rules.approval-by-action",
                "P5.0 规定数据库迁移 / 镜像推送 / 回滚必须审批",
            )],
        });
    }
    if inputs.production_like && inputs.policy.production_requires_approval {
        out.push(ProposedApproval {
            id: "approval-production-deploy".to_string(),
            node_key: None,
            reason: "这是生产类环境的部署，必须有人确认后才能执行。".to_string(),
            required_role: "owner".to_string(),
            required: true,
            evidence: vec![Evidence {
                class: EvidenceClass::Fact,
                source: EvidenceSource::Platform {
                    policy: "production_requires_approval".to_string(),
                },
                detail: "安全策略：生产部署一律人工审批（不可关闭）".to_string(),
                reference: None,
            }],
        });
    }
    out.sort_by(|left, right| left.id.cmp(&right.id));
    out
}

fn rollback_strategy(
    inputs: &RuleInputs<'_>,
    workflow: &ProposedWorkflow,
    self_hosted_db: bool,
) -> RollbackStrategy {
    let automatic = workflow
        .nodes
        .iter()
        .any(|node| node.node_key == "restore_release");
    let mut steps: Vec<Statement> = Vec::new();
    let mut restores: Vec<String> = Vec::new();

    if automatic {
        steps.push(Statement::inference(
            "rb-auto",
            "变更类节点失败时自动回到上一个版本：上一版本仍在服务器上，回滚不改数据。",
            vec![Evidence::derived(
                "rules.rollback-node",
                "工作流里存在 restore_release 节点且只有失败边能到它",
            )],
        ));
        restores.push("previous release".to_string());
    } else {
        steps.push(Statement::recommendation(
            "rb-manual",
            "没有配置自动回滚：出问题需要人工重新部署上一个版本。",
            vec![],
        ));
    }

    let has_static = inputs
        .services
        .iter()
        .any(|service| service.service_kind == ServiceKind::StaticNginx);
    if has_static {
        steps.push(Statement::inference(
            "rb-nginx",
            "重新挂载上一个 Nginx 站点目录并回退配置；改动前先备份配置，reload 前先 nginx -t。",
            vec![Evidence::derived(
                "rules.rollback-nginx",
                "存在 Nginx 托管的静态站点",
            )],
        ));
        restores.push("previous nginx config and site root".to_string());
    }

    let has_image = inputs.services.iter().any(|service| {
        matches!(
            service.service_kind,
            ServiceKind::DockerImage | ServiceKind::DockerCompose
        )
    });
    if has_image {
        steps.push(Statement::inference(
            "rb-image",
            "把容器换回上一个镜像 digest 并重新 up；镜像按 digest 固定过才回得去。",
            vec![Evidence::knowledge(
                "kb-registry-image",
                knowledge::KNOWLEDGE_VERSION,
                "镜像按 digest 固定，回滚才有确定落点",
            )],
        ));
        restores.push("previous image digest".to_string());
    }

    let data_rollback = if self_hosted_db {
        Some(
            "数据不能自动回滚：迁移通常不可逆。只能从迁移前的备份恢复，且会丢失备份之后写入的数据。"
                .to_string(),
        )
    } else {
        Some("数据不在本机（外部托管），本方案的部署动作不涉及数据回滚。".to_string())
    };

    RollbackStrategy {
        automatic,
        steps,
        restores,
        data_rollback,
        trigger: if automatic {
            Some("任一变更类节点失败时触发".to_string())
        } else {
            None
        },
    }
}

// -- 校验（规则侧）----------------------------------------------------------

fn validate(
    inputs: &RuleInputs<'_>,
    services: &[ProposedService],
    domains: &[ProposedDomain],
    topology: &TopologyPlan,
) -> Vec<ProposalViolation> {
    let mut out: Vec<ProposalViolation> = Vec::new();

    macro_rules! violation {
        ($kind:expr, $severity:expr, $location:expr, $detail:expr) => {{
            let kind: ViolationKind = $kind;
            let location: String = $location;
            out.push(ProposalViolation {
                id: format!(
                    "v-{}-{}",
                    kind.label().to_ascii_lowercase(),
                    slug(&location)
                ),
                kind,
                severity: $severity,
                source: match kind {
                    ViolationKind::Capability => "capability",
                    ViolationKind::Path => "path",
                    ViolationKind::Secret => "secret",
                    ViolationKind::Permission => "permission",
                    ViolationKind::Risk => "risk",
                    ViolationKind::Schema => "schema",
                    ViolationKind::Shell => "shell",
                }
                .to_string(),
                location,
                detail: $detail,
                blocks_plan: kind.blocks_plan(),
                blocks_approval: kind.blocks_approval(),
            });
        }};
    }

    // 1) 拓扑必须能落地。
    if !topology.recommended.feasible {
        for blocker in &topology.recommended.blockers {
            violation!(
                ViolationKind::Capability,
                RiskLevel::Critical,
                topology.recommended.id.clone(),
                blocker.clone()
            );
        }
    }

    // 2) 资源够不够。
    if let Some(reason) = &inputs.capacity.insufficient {
        violation!(
            ViolationKind::Capability,
            RiskLevel::High,
            inputs.server_id.clone(),
            reason.clone()
        );
    }

    // 3) 制品里的阻断项（密钥 / 逃逸路径）。
    if inputs.policy.forbid_secrets_in_artifact {
        for facts in inputs.facts.iter().filter(|facts| facts.artifact_blocked) {
            let name = inputs
                .services
                .iter()
                .find(|service| service.id == facts.service_unit_id)
                .map(|service| service.name.clone())
                .unwrap_or_else(|| facts.service_unit_id.clone());
            violation!(
                ViolationKind::Secret,
                RiskLevel::Critical,
                name.clone(),
                facts
                    .artifact_blocked_reason
                    .clone()
                    .unwrap_or_else(|| "制品里存在阻断项".to_string())
            );
        }
    }

    // 4) 端口是否在策略允许范围内。
    if !inputs.policy.allowed_ports.is_empty() {
        for service in services {
            for port in &service.ports {
                if !inputs.policy.allowed_ports.contains(&port.host_port) {
                    violation!(
                        ViolationKind::Permission,
                        RiskLevel::High,
                        service.name.clone(),
                        format!(
                            "端口 {} 不在安全策略允许的范围内（{:?}）",
                            port.host_port, inputs.policy.allowed_ports
                        )
                    );
                }
            }
        }
    }

    // 5) 路径必须落在环境根目录内（P5.0 已有的围栏，这里再确认一遍）。
    if let Some(environment) = inputs.environment {
        for service in inputs.services {
            if let Some(path) = &service.deploy_path {
                if !path.starts_with(environment.deploy_root.trim_end_matches('/')) {
                    violation!(
                        ViolationKind::Path,
                        RiskLevel::High,
                        service.name.clone(),
                        format!(
                            "服务目录 {path} 不在环境根目录 {} 内",
                            environment.deploy_root
                        )
                    );
                }
            }
        }
    }

    // 6) 生产环境要求 HTTPS。
    if inputs.production_like && inputs.policy.require_https {
        for domain in domains {
            if domain.ssl_mode == SslMode::None {
                violation!(
                    ViolationKind::Risk,
                    RiskLevel::High,
                    domain.domain.clone(),
                    "安全策略要求 HTTPS，但该域名没有配置证书".to_string()
                );
            }
        }
    }

    // 7) 未裁定的知识库冲突：不许静默选一条。
    for conflict in inputs
        .conflicts
        .iter()
        .filter(|conflict| conflict.resolution == super::model::ConflictResolution::Unresolved)
    {
        violation!(
            ViolationKind::Risk,
            RiskLevel::High,
            conflict.topic.clone(),
            format!(
                "知识库冲突未裁定（{}）：{}",
                conflict.entries.join(" vs "),
                conflict.statements.join(" / ")
            )
        );
    }

    out.sort_by(|left, right| left.id.cmp(&right.id));
    out
}

// -- 入口 -------------------------------------------------------------------

/// 跑一遍规则引擎。
pub fn plan(inputs: &RuleInputs<'_>) -> RuleOutcome {
    let topology = plan_topologies(inputs);
    let (services, service_unknowns) = proposed_services(inputs);
    let (dependencies, dependency_unknowns) = proposed_dependencies(inputs, &services);
    let domains = proposed_domains(inputs);
    let self_hosted_db = inputs.services.iter().any(|service| {
        service.role == crate::deployment::model::ServiceRole::Database
            && service.service_kind != ServiceKind::ExternalManaged
    });

    let workflow_services: Vec<WorkflowService> = inputs
        .services
        .iter()
        .map(|unit| {
            let artifact = unit
                .artifact_id
                .as_deref()
                .and_then(|id| inputs.artifacts.iter().find(|artifact| artifact.id == id));
            let proposed = services
                .iter()
                .find(|service| service.service_unit_id == unit.id);
            WorkflowService {
                key: workflow::node_key_for(&unit.name),

                name: unit.name.clone(),
                role: format!("{:?}", unit.role).to_ascii_lowercase(),
                disposition: disposition_of(unit, artifact),
                env_keys: proposed
                    .map(|service| service.env_keys.clone())
                    .unwrap_or_default(),
                static_files: unit.service_kind == ServiceKind::StaticNginx,
                container: matches!(
                    unit.service_kind,
                    ServiceKind::DockerImage | ServiceKind::DockerCompose
                ),
                external: unit.service_kind == ServiceKind::ExternalManaged,
                health_target: proposed
                    .and_then(|service| service.health_check.clone())
                    .map(|plan| plan.target),
            }
        })
        .collect();

    let certificate_required = domains.iter().any(|domain| domain.certificate_required);
    let workflow = workflow::build(&WorkflowInputs {
        topology: topology.recommended.kind,
        services: &workflow_services,
        certificate_required,
        self_hosted_database: self_hosted_db,
        require_health_check: inputs.policy.require_health_check,
        require_rollback: inputs.policy.require_rollback_plan,
    });

    let risk_list = risks(inputs, &topology, &services, &domains);
    let approval_list = approvals(inputs, &workflow);
    let rollback = rollback_strategy(inputs, &workflow, self_hosted_db);
    let violations = validate(inputs, &services, &domains, &topology);

    let mut unknowns = service_unknowns;
    unknowns.extend(dependency_unknowns);
    unknowns.sort_by(|left, right| left.id.cmp(&right.id));

    let mut statements = topology.rationale.clone();
    statements.extend(inputs.capacity.statements.clone());
    statements.sort_by(|left, right| left.id.cmp(&right.id));

    RuleOutcome {
        topology,
        services,
        dependencies,
        domains,
        workflow,
        risks: risk_list,
        approvals: approval_list,
        rollback,
        statements,
        unknowns,
        violations,
    }
}

/// 供引擎检查：策略里是否有"未探测但已用上"的能力。
pub fn unverified_capabilities(
    topology: &TopologyPlan,
    conflicts: &[KnowledgeConflict],
) -> Vec<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    for evidence in &topology.recommended.evidence {
        if evidence.class == EvidenceClass::Unknown {
            out.insert(evidence.detail.clone());
        }
    }
    for conflict in conflicts {
        if conflict.resolution == super::model::ConflictResolution::Unresolved {
            if let Some(capability) = &conflict.capability {
                out.insert(format!("{capability} 未探测，冲突无法裁定"));
            }
        }
    }
    out.into_iter().collect()
}

/// 检查项（三态），与项目识别同一套词汇。
pub fn checks(outcome: &RuleOutcome) -> Vec<super::model::ProposalCheck> {
    let mut checks = Vec::new();
    checks.push(super::model::ProposalCheck {
        id: "topology".to_string(),
        label: "Deployment topology".to_string(),
        state: if !outcome.topology.recommended.feasible {
            CheckState::Blocked
        } else if outcome.topology.alternatives.is_empty() {
            CheckState::Unknown
        } else {
            CheckState::Ready
        },
        detail: format!(
            "推荐 {}，另有 {} 个备选",
            outcome.topology.recommended.name,
            outcome.topology.alternatives.len()
        ),
    });
    checks.push(super::model::ProposalCheck {
        id: "workflow".to_string(),
        label: "Workflow".to_string(),
        state: if outcome.workflow.nodes.is_empty() {
            CheckState::Blocked
        } else {
            CheckState::Ready
        },
        detail: format!(
            "{} 个节点 / {} 条连线",
            outcome.workflow.nodes.len(),
            outcome.workflow.edges.len()
        ),
    });
    checks.push(super::model::ProposalCheck {
        id: "health".to_string(),
        label: "Health checks".to_string(),
        state: {
            let deployable = outcome
                .services
                .iter()
                .filter(|service| service.service_kind != ServiceKind::ExternalManaged);
            let with_health = deployable
                .clone()
                .filter(|service| service.health_check.is_some())
                .count();
            let total = deployable.count();
            if total == 0 || with_health == total {
                CheckState::Ready
            } else if with_health == 0 {
                CheckState::Blocked
            } else {
                CheckState::Unknown
            }
        },
        detail: "健康检查覆盖率见风险列表".to_string(),
    });
    checks
}
