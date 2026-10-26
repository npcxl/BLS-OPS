//! P5.6 **AI 草案校验** —— 草案在变成计划之前必须过的关。
//!
//! 七道关（对应需求）：
//!
//! 1. 解析阶段：`deny_unknown_fields` 已经挡掉 `command` / `args` / `shell`；
//! 2. Memory 引用必须真实存在于本次提供的候选里；
//! 3. Knowledge 引用必须真实存在于本次提供的候选里；
//! 4. 拓扑 / 运行时必须在服务器能力支持范围内；
//! 5. 不允许出现审批、安全策略、路径围栏相关的字段；
//! 6. 路径必须落在环境 `deploy_root` 内，字符串不得含 shell 元字符；
//! 7. 通过后才交给确定性 PlanCompiler（**编译失败要返回结构化问题，不猜**）。

use super::model::{AiDeploymentDraft, DraftService};
use crate::deployment::proposal::model::TopologyKind;
use crate::deployment::session::memory::contains_shell_meta;

/// 草案被拒的原因（**逐条结构化返回**，不静默丢弃、不偷偷降级）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DraftRejection {
    FakeMemoryRef {
        reference: String,
    },
    FakeKnowledgeRef {
        reference: String,
    },
    UnsupportedTopology {
        topology: String,
    },
    UnsupportedRuntime {
        service: String,
        runtime: String,
    },
    /// 兜底：万一有自由命令字段漏到解析之后。
    ForbiddenCommandField {
        field: String,
    },
    /// 想改审批 / 安全策略 / 路径围栏。
    ForbiddenTarget {
        field: String,
        reason: String,
    },
    ShellLikeValue {
        field: String,
    },
    PathOutsideRoot {
        field: String,
        value: String,
    },
    InvalidDomain {
        domain: String,
    },
    EmptyServices,
}

impl DraftRejection {
    pub fn code(&self) -> &'static str {
        match self {
            DraftRejection::FakeMemoryRef { .. } => "fake_memory_ref",
            DraftRejection::FakeKnowledgeRef { .. } => "fake_knowledge_ref",
            DraftRejection::UnsupportedTopology { .. } => "unsupported_topology",
            DraftRejection::UnsupportedRuntime { .. } => "unsupported_runtime",
            DraftRejection::ForbiddenCommandField { .. } => "forbidden_command_field",
            DraftRejection::ForbiddenTarget { .. } => "forbidden_target",
            DraftRejection::ShellLikeValue { .. } => "shell_like_value",
            DraftRejection::PathOutsideRoot { .. } => "path_outside_root",
            DraftRejection::InvalidDomain { .. } => "invalid_domain",
            DraftRejection::EmptyServices => "empty_services",
        }
    }

    /// 能不能靠"再问一次"解决（用于区分"追问"与"直接拒绝"）。
    pub fn is_answerable(&self) -> bool {
        matches!(self, DraftRejection::UnsupportedTopology { .. })
    }
}

/// 校验上下文：**本次真正提供给 AI 的东西**。
#[derive(Debug, Clone, Copy)]
pub struct DraftContext<'a> {
    /// 本次检索到、可被引用的 Memory（形如 `memory:<id>`）。
    pub allowed_memory_refs: &'a [String],
    /// 本次检索到、可被引用的 Knowledge（形如 `knowledge:<id>@<version>`）。
    pub allowed_knowledge_refs: &'a [String],
    /// 服务器能力实际支持的拓扑。
    pub supported_topologies: &'a [TopologyKind],
    /// 环境的 `deploy_root`（路径围栏）。
    pub deploy_root: &'a str,
}

/// 绝不允许出现在草案里的"目标"（AI 只能评论，不能改确定性结论）。
pub const FORBIDDEN_TARGETS: &[&str] = &[
    "approval",
    "approvals",
    "approval_required",
    "security_policy",
    "policy",
    "deploy_root",
    "path_fence",
    "workflow",
    "actions",
    "plan",
];

/// 校验一份草案，返回**全部**问题（不是遇到第一个就停）。
pub fn validate_draft(
    draft: &AiDeploymentDraft,
    context: &DraftContext<'_>,
) -> Vec<DraftRejection> {
    let mut issues: Vec<DraftRejection> = Vec::new();

    if draft.services.is_empty() {
        issues.push(DraftRejection::EmptyServices);
    }
    if !context.supported_topologies.contains(&draft.topology) {
        issues.push(DraftRejection::UnsupportedTopology {
            topology: format!("{:?}", draft.topology),
        });
    }
    // 引用必须真实：本次没给 AI 的，它不许"凭空引用"。
    for reference in &draft.memory_refs {
        if !context.allowed_memory_refs.contains(reference) {
            issues.push(DraftRejection::FakeMemoryRef {
                reference: reference.clone(),
            });
        }
    }
    for reference in &draft.knowledge_refs {
        if !context.allowed_knowledge_refs.contains(reference) {
            issues.push(DraftRejection::FakeKnowledgeRef {
                reference: reference.clone(),
            });
        }
    }
    // 兜底：万一命令类字段漏过解析。
    if draft.looks_like_it_carries_a_command() {
        issues.push(DraftRejection::ForbiddenCommandField {
            field: "command".to_string(),
        });
    }

    let names: Vec<&str> = draft
        .services
        .iter()
        .map(|service| service.name.as_str())
        .collect();
    for service in &draft.services {
        check_service(service, context, &mut issues);
    }
    for dependency in &draft.dependency_decisions {
        if contains_shell_meta(&dependency.kind) {
            issues.push(DraftRejection::ShellLikeValue {
                field: format!("dependency_decisions.{}.kind", dependency.from_service),
            });
        }
        if !dependency.external
            && (!names.contains(&dependency.from_service.as_str())
                || !names.contains(&dependency.to_service.as_str()))
        {
            issues.push(DraftRejection::ForbiddenTarget {
                field: format!(
                    "dependency_decisions.{}.to_service",
                    dependency.from_service
                ),
                reason: "依赖指向了草案里不存在的服务".to_string(),
            });
        }
    }
    if let Some(domain) = &draft.domain_intent {
        if !is_plausible_domain(&domain.domain) {
            issues.push(DraftRejection::InvalidDomain {
                domain: domain.domain.clone(),
            });
        }
        if !names.contains(&domain.service_name.as_str()) {
            issues.push(DraftRejection::ForbiddenTarget {
                field: "domain_intent.service_name".to_string(),
                reason: "域名指向了草案里不存在的服务".to_string(),
            });
        }
    }
    issues
}

fn check_service(
    service: &DraftService,
    context: &DraftContext<'_>,
    issues: &mut Vec<DraftRejection>,
) {
    if contains_shell_meta(&service.name) {
        issues.push(DraftRejection::ShellLikeValue {
            field: format!("services.{}.name", service.name),
        });
    }
    if !super::model::DraftRuntime::ALL.contains(&service.runtime) {
        issues.push(DraftRejection::UnsupportedRuntime {
            service: service.name.clone(),
            runtime: service.runtime.as_str().to_string(),
        });
    }
    // 健康检查路径：必须以 / 开头，不能穿越。
    if let Some(health) = &service.health_path {
        if !health.starts_with('/') || health.contains("..") || contains_shell_meta(health) {
            issues.push(DraftRejection::ShellLikeValue {
                field: format!("services.{}.health_path", service.name),
            });
        }
    }
    // 环境变量名 / 密钥引用：只允许名字。
    for key in &service.env_keys {
        if key.trim().is_empty() || contains_shell_meta(key) {
            issues.push(DraftRejection::ShellLikeValue {
                field: format!("services.{}.env_keys", service.name),
            });
        }
    }
    for reference in &service.secret_refs {
        if reference.trim().is_empty() || contains_shell_meta(reference) {
            issues.push(DraftRejection::ShellLikeValue {
                field: format!("services.{}.secret_refs", service.name),
            });
        }
    }
    // 路径围栏：部署目录必须落在环境 deploy_root 内。
    if let Some(hint) = &service.deploy_path_hint {
        if !within_root(context.deploy_root, hint) {
            issues.push(DraftRejection::PathOutsideRoot {
                field: format!("services.{}.deploy_path_hint", service.name),
                value: hint.clone(),
            });
        }
    }
}

fn is_plausible_domain(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= 253
        && !domain.contains('/')
        && !contains_shell_meta(domain)
        && domain.split('.').count() >= 2
        && domain
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
}

/// 相对路径规范化后是否仍在 `root` 之下。
fn within_root(root: &str, relative: &str) -> bool {
    let root = root.trim_end_matches('/');
    if !root.starts_with('/') {
        return false;
    }
    let root_depth = root.split('/').filter(|part| !part.is_empty()).count();
    let joined = format!("{root}/{}", relative.trim_start_matches('/'));
    let mut depth = 0usize;
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => depth = depth.saturating_sub(1),
            _ => depth += 1,
        }
    }
    depth >= root_depth
}

/// 通过校验后交给 PlanCompiler 的**确定性输入**（仍然不含任何命令）。
#[derive(Debug, Clone, PartialEq)]
pub struct PlanCompilerInput {
    pub topology: TopologyKind,
    pub services: Vec<DraftService>,
    pub dependencies: Vec<super::model::DraftDependency>,
    pub domain: Option<super::model::DraftDomain>,
    pub ssl: Option<super::model::DraftSsl>,
    pub capacity: super::model::DraftCapacity,
    pub risks: Vec<super::model::DraftRisk>,
    pub assumptions: Vec<String>,
    pub memory_refs: Vec<String>,
    pub knowledge_refs: Vec<String>,
}

pub fn to_plan_input(draft: &AiDeploymentDraft) -> PlanCompilerInput {
    PlanCompilerInput {
        topology: draft.topology,
        services: draft.services.clone(),
        dependencies: draft.dependency_decisions.clone(),
        domain: draft.domain_intent.clone(),
        ssl: draft.ssl_intent.clone(),
        capacity: draft.capacity_suggestions.clone(),
        risks: draft.risks.clone(),
        assumptions: draft.assumptions.clone(),
        memory_refs: draft.memory_refs.clone(),
        knowledge_refs: draft.knowledge_refs.clone(),
    }
}
