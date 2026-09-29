//! 执行前的**预检**：把"现在到底能不能部署"变成一张可以逐条讲清楚的清单。
//!
//! 预检只做**本地可判定**的事情（数据库 + 已连接状态）。服务器上的实际能力由
//! 工作流第一步"检查服务器依赖"在执行时确认 —— 那一步没通过，运行同样会停。
//! 这样划分是因为"能不能连上去装没装 docker"必须在服务器上问，而"计划批准了吗、
//! 制品齐了吗、环境被占了吗"本地就能回答，没必要浪费一次远程往返。

use crate::deployment::model::*;
use crate::deployment::proposal::model::SecurityPolicy;
use crate::project_readiness::CheckState;

/// 一条预检结论。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PreflightCheck {
    pub id: String,
    pub label: String,
    pub state: CheckState,
    pub detail: String,
}

/// 预检报告。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PreflightReport {
    pub checks: Vec<PreflightCheck>,
    /// 只要有一条 `Blocked` 就不能开始。
    pub can_run: bool,
    /// 需要人工确认的提示（不阻断，但要在 UI 上醒目）。
    pub warnings: Vec<String>,
}

impl PreflightReport {
    pub fn blocked_checks(&self) -> Vec<&PreflightCheck> {
        self.checks
            .iter()
            .filter(|check| check.state == CheckState::Blocked)
            .collect()
    }
}

/// 预检输入（全部来自数据库 + 会话状态）。
pub struct PreflightInputs<'a> {
    pub plan: &'a DeploymentPlanGraph,
    pub services: &'a [ServiceUnit],
    pub artifacts: &'a [ArtifactRecord],
    pub domains: &'a [DomainBinding],
    pub configs: &'a [ConfigDefinition],
    pub secret_refs: &'a [SecretRef],
    pub policy: &'a SecurityPolicy,
    pub environment_kind: EnvironmentKind,
    pub session_connected: bool,
    /// 环境被哪个运行占着（`None` = 空闲）。
    pub locked_by: Option<String>,
    /// 计划编译出的回滚步骤数。
    pub rollback_steps: usize,
}

fn check(id: &str, label: &str, state: CheckState, detail: impl Into<String>) -> PreflightCheck {
    PreflightCheck {
        id: id.to_string(),
        label: label.to_string(),
        state,
        detail: detail.into(),
    }
}

/// 跑一遍预检。
pub fn preflight(input: &PreflightInputs<'_>) -> PreflightReport {
    let mut checks: Vec<PreflightCheck> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // 1. 计划必须已经批准 —— 草稿计划不允许执行。
    checks.push(match input.plan.plan.status {
        PlanStatus::Approved => check(
            "plan_status",
            "计划已批准",
            CheckState::Ready,
            "计划处于已批准状态",
        ),
        PlanStatus::Ready => check(
            "plan_status",
            "计划待批准",
            CheckState::Blocked,
            "计划已就绪但还没批准：请先在“计划”里批准，或在生成运行时勾选批准",
        ),
        PlanStatus::Draft => check(
            "plan_status",
            "计划是草稿",
            CheckState::Blocked,
            "草稿计划不能执行：请先批准",
        ),
        PlanStatus::Rejected => check(
            "plan_status",
            "计划已被否决",
            CheckState::Blocked,
            "被否决的计划不能执行",
        ),
        PlanStatus::Archived => check(
            "plan_status",
            "计划已归档",
            CheckState::Blocked,
            "归档计划不能执行",
        ),
    });

    // 2. 至少有一个待部署服务，且都关联了制品。
    let deployable: Vec<&ServiceUnit> = input
        .services
        .iter()
        .filter(|service| service.status != "disabled")
        .collect();
    let without_artifact: Vec<&str> = deployable
        .iter()
        .filter(|service| service.artifact_id.is_none())
        .map(|service| service.name.as_str())
        .collect();
    checks.push(if deployable.is_empty() {
        check(
            "services",
            "没有待部署服务",
            CheckState::Blocked,
            "这个环境里没有启用的服务",
        )
    } else {
        check(
            "services",
            "有待部署服务",
            CheckState::Ready,
            format!("{} 个服务参与本次部署", deployable.len()),
        )
    });
    checks.push(if without_artifact.is_empty() {
        check(
            "artifacts",
            "服务都关联了制品",
            CheckState::Ready,
            format!("{} 个服务都有制品", deployable.len()),
        )
    } else {
        check(
            "artifacts",
            "有服务没关联制品",
            CheckState::Blocked,
            format!("缺少制品：{}", without_artifact.join("、")),
        )
    });

    // 3. 制品必须能校验（有哈希），否则上传之后无法发现问题。
    let unhashed: Vec<&str> = deployable
        .iter()
        .filter_map(|service| {
            let artifact_id = service.artifact_id.as_deref()?;
            let artifact = input
                .artifacts
                .iter()
                .find(|artifact| artifact.id == artifact_id)?;
            match artifact.sha256.is_some() {
                true => None,
                false => Some(artifact.notes.as_str()),
            }
        })
        .collect();
    checks.push(if unhashed.is_empty() {
        check(
            "artifact_hashes",
            "制品都有内容哈希",
            CheckState::Ready,
            "上传后可以校验内容",
        )
    } else {
        check(
            "artifact_hashes",
            "有制品没有哈希",
            CheckState::Blocked,
            format!(
                "这些制品没有 sha256，无法验证上传完整性：{}",
                unhashed.join("、")
            ),
        )
    });

    // 4. 密钥：配置里声明的密钥引用必须真的存在。
    let missing_secrets: Vec<&str> = input
        .configs
        .iter()
        .filter(|config| config.secret || config.source_kind == ConfigSourceKind::SecretRef)
        .filter_map(|config| {
            let reference_id = config.source_ref.as_deref()?;
            let found = input
                .secret_refs
                .iter()
                .any(|reference| reference.id == reference_id);
            if found {
                None
            } else {
                Some(config.key.as_str())
            }
        })
        .collect();
    checks.push(if missing_secrets.is_empty() {
        check(
            "secrets",
            "密钥引用齐备",
            CheckState::Ready,
            format!("{} 个密钥引用都可解析", input.secret_refs.len()),
        )
    } else {
        check(
            "secrets",
            "有密钥引用缺失",
            CheckState::Blocked,
            format!("这些配置引用了不存在的密钥：{}", missing_secrets.join("、")),
        )
    });

    // 5. 会话。
    checks.push(if input.session_connected {
        check(
            "session",
            "SSH 会话已连接",
            CheckState::Ready,
            "可以执行远程动作",
        )
    } else {
        check(
            "session",
            "SSH 会话未连接",
            CheckState::Blocked,
            "请先连接目标服务器再执行部署",
        )
    });

    // 6. 环境锁："禁止两个部署同时修改同一环境"。
    checks.push(match &input.locked_by {
        None => check(
            "environment_lock",
            "环境空闲",
            CheckState::Ready,
            "没有其他部署占着这个环境",
        ),
        Some(holder) => check(
            "environment_lock",
            "环境被占用",
            CheckState::Blocked,
            format!("该环境已有部署在进行（运行 {holder}）：请等它结束或先取消"),
        ),
    });

    // 7. 域名与证书：只在声明的模式下判定。
    let acme_domains: Vec<&DomainBinding> = input
        .domains
        .iter()
        .filter(|binding| binding.ssl_mode != SslMode::None)
        .collect();
    let mismatched: Vec<&str> = acme_domains
        .iter()
        .filter(|binding| binding.dns_status == DnsStatus::Mismatched)
        .map(|binding| binding.domain.as_str())
        .collect();
    let unchecked: Vec<&str> = acme_domains
        .iter()
        .filter(|binding| {
            matches!(
                binding.dns_status,
                DnsStatus::Unknown | DnsStatus::Unchecked
            )
        })
        .map(|binding| binding.domain.as_str())
        .collect();
    if !mismatched.is_empty() {
        checks.push(check(
            "dns",
            "域名解析不匹配",
            CheckState::Blocked,
            format!(
                "这些域名解析到的地址与期望不符：{}（证书签发会失败）",
                mismatched.join("、")
            ),
        ));
    } else if !unchecked.is_empty() {
        checks.push(check(
            "dns",
            "域名还没验证过",
            CheckState::Unknown,
            format!(
                "这些域名尚未验证解析：{}。执行时会先验证，未生效则不会申请 HTTP-01 证书",
                unchecked.join("、")
            ),
        ));
    } else if acme_domains.is_empty() {
        checks.push(check(
            "dns",
            "没有需要证书的域名",
            CheckState::Ready,
            "本次部署不涉及 HTTPS",
        ));
    } else {
        checks.push(check(
            "dns",
            "域名解析已确认",
            CheckState::Ready,
            format!("{} 个域名已解析", acme_domains.len()),
        ));
    }

    // 8. 生产环境必须有回滚计划。
    if input.environment_kind == EnvironmentKind::Production && input.policy.require_rollback_plan {
        checks.push(if input.rollback_steps == 0 {
            check(
                "rollback",
                "缺少回滚计划",
                CheckState::Blocked,
                "生产环境要求回滚计划，但这份计划里没有回滚节点：请先在方案里确认带回滚的工作流",
            )
        } else {
            check(
                "rollback",
                "回滚计划就绪",
                CheckState::Ready,
                format!("计划里有 {} 个回滚步骤", input.rollback_steps),
            )
        });
    } else {
        checks.push(check(
            "rollback",
            "回滚要求未开启",
            CheckState::Ready,
            "当前环境不强制回滚计划",
        ));
    }

    // 9. 服务器实际能力：本地无法判定，如实标 Unknown。
    checks.push(check(
        "capability",
        "服务器依赖待执行时确认",
        CheckState::Unknown,
        "docker / nginx / systemctl 等是否存在，由工作流第一个节点在执行时确认",
    ));
    if input.environment_kind == EnvironmentKind::Production {
        warnings.push(
            "这是生产环境：高风险节点（写网关配置、签发证书、提升与回滚版本）会逐个停下等确认。"
                .to_string(),
        );
    }

    let can_run = checks
        .iter()
        .all(|check| check.state != CheckState::Blocked);
    PreflightReport {
        checks,
        can_run,
        warnings,
    }
}
