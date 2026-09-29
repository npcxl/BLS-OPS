//! 每个动作的**执行契约**：风险、幂等性、超时、重试、可取消性、前置条件、
//! 审计事件、补偿动作。
//!
//! # 为什么是穷尽 `match` 而不是一 Jackson 表
//!
//! 这张表是安全评审的入口：新增一个动作**必须**在这里回答"它有多危险、
//! 失败了怎么办、能不能重试、能不能取消"。用 `match` 而不是 `HashMap`，
//! 编译期就能拦住"新加动作忘了声明补偿动作"这种事。
//!
//! # 幂等性的三种含义（必须区分，否则重试就是赌博）
//!
//! * [`Idempotency::Safe`]：只读。跑多少次都不会改变服务器。
//! * [`Idempotency::Idempotent`]：可以重复执行并收敛到同一结果
//!   （`mkdir -p`、`ln -sfn`、`certbot --keep-until-expiring`、写文件）。
//! * [`Idempotency::Conditional`]：重复执行"通常没事"但会改变现场
//!   （`docker compose up` 会重建容器、`systemctl restart` 会重启进程）。
//!   重试允许，但**必须在日志里说明现场被改过**。
//! * [`Idempotency::NotIdempotent`]：不允许自动重试（证书签发、提升版本）。

use std::time::Duration;

use crate::deployment::model::RiskLevel;

use super::model::{ActionKind, RequiredTool};

/// 动作在流水线里的位置（预检、变更、提升、回滚）。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum ActionPhase {
    /// 只读预检：确认服务器上有什么。
    Preflight,
    /// 准备目录 / 上传 / 解包 / 拉镜像。
    Prepare,
    /// 写配置。
    Configure,
    /// 起服务。
    Provision,
    /// 网关（Nginx）。
    Gateway,
    /// 域名与证书。
    Certificate,
    /// 健康检查。
    Health,
    /// 提升版本、停旧版本。
    Promote,
    /// 回滚。
    Rollback,
}

impl ActionPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            ActionPhase::Preflight => "preflight",
            ActionPhase::Prepare => "prepare",
            ActionPhase::Configure => "configure",
            ActionPhase::Provision => "provision",
            ActionPhase::Gateway => "gateway",
            ActionPhase::Certificate => "certificate",
            ActionPhase::Health => "health",
            ActionPhase::Promote => "promote",
            ActionPhase::Rollback => "rollback",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ActionPhase::Preflight => "预检",
            ActionPhase::Prepare => "准备制品",
            ActionPhase::Configure => "写入配置",
            ActionPhase::Provision => "启动服务",
            ActionPhase::Gateway => "网关配置",
            ActionPhase::Certificate => "域名与证书",
            ActionPhase::Health => "健康检查",
            ActionPhase::Promote => "提升版本",
            ActionPhase::Rollback => "回滚",
        }
    }
}

/// 幂等性（见模块文档）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Idempotency {
    Safe,
    Idempotent,
    Conditional,
    NotIdempotent,
}

impl Idempotency {
    pub fn as_str(self) -> &'static str {
        match self {
            Idempotency::Safe => "safe",
            Idempotency::Idempotent => "idempotent",
            Idempotency::Conditional => "conditional",
            Idempotency::NotIdempotent => "not_idempotent",
        }
    }

    /// 自动重试是否可接受（`NotIdempotent` 只能由人来点"重试本节点"）。
    pub fn allows_automatic_retry(self) -> bool {
        !matches!(self, Idempotency::NotIdempotent)
    }
}

/// 重试策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// 总尝试次数（含第一次）。
    pub max_attempts: u32,
    /// 两次尝试之间的等待。
    pub backoff: Duration,
}

impl RetryPolicy {
    pub const fn once() -> Self {
        Self {
            max_attempts: 1,
            backoff: Duration::ZERO,
        }
    }

    pub const fn attempts(max_attempts: u32, backoff_secs: u64) -> Self {
        Self {
            max_attempts,
            backoff: Duration::from_secs(backoff_secs),
        }
    }
}

/// 前置条件 —— 引擎在跑这个动作之前必须为真的东西。
///
/// 机械可判的（服务器连着、工具在、备份在、旧版本存在）由引擎查；
/// 其余（人工确认）必须由人给出，引擎**不会**默认放行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Precondition {
    ServerConnected,
    ToolPresent(RequiredTool),
    ArtifactUploaded,
    ChecksumVerified,
    ReleaseDirectoryReady,
    CurrentReleaseExists,
    NginxBackupPresent,
    NginxConfigValid,
    DomainResolved,
    ContainerRunning,
    ManualAcknowledgement,
}

impl Precondition {
    pub fn as_str(self) -> &'static str {
        match self {
            Precondition::ServerConnected => "server_connected",
            Precondition::ToolPresent(_) => "tool_present",
            Precondition::ArtifactUploaded => "artifact_uploaded",
            Precondition::ChecksumVerified => "checksum_verified",
            Precondition::ReleaseDirectoryReady => "release_directory_ready",
            Precondition::CurrentReleaseExists => "current_release_exists",
            Precondition::NginxBackupPresent => "nginx_backup_present",
            Precondition::NginxConfigValid => "nginx_config_valid",
            Precondition::DomainResolved => "domain_resolved",
            Precondition::ContainerRunning => "container_running",
            Precondition::ManualAcknowledgement => "manual_acknowledgement",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Precondition::ServerConnected => "SSH 会话已连接",
            Precondition::ToolPresent(_) => "服务器上存在所需工具",
            Precondition::ArtifactUploaded => "制品已上传到服务器",
            Precondition::ChecksumVerified => "制品哈希已校验",
            Precondition::ReleaseDirectoryReady => "发布目录已准备好",
            Precondition::CurrentReleaseExists => "存在可回退的当前版本",
            Precondition::NginxBackupPresent => "Nginx 配置已有备份",
            Precondition::NginxConfigValid => "Nginx 配置已通过 nginx -t",
            Precondition::DomainResolved => "域名已解析到本机",
            Precondition::ContainerRunning => "容器正在运行",
            Precondition::ManualAcknowledgement => "已人工确认",
        }
    }
}

/// 动作的执行契约。
#[derive(Debug, Clone)]
pub struct ActionSpec {
    pub kind: ActionKind,
    pub phase: ActionPhase,
    pub risk: RiskLevel,
    pub idempotency: Idempotency,
    pub timeout: Duration,
    pub retry: RetryPolicy,
    /// 能不能中途取消。`false` 的动作一旦开始就必须等它结束（结果照样记录）。
    pub cancellable: bool,
    /// 动作本身是否要求人工确认（生产环境另外叠加策略，见 [`approval_required`]）。
    pub requires_approval: bool,
    /// 失败/回滚时要跑的补偿动作（没有就是 `None`，UI 会显示"无需补偿"）。
    pub compensation: Option<ActionKind>,
    pub preconditions: &'static [Precondition],
    /// 这个动作需要服务器上存在哪些工具。
    pub required_tools: &'static [RequiredTool],
}

impl ActionSpec {
    pub fn mutates_server(&self) -> bool {
        self.kind.mutates_server()
    }

    /// 用于日志/审计的"幂等性 + 补偿"摘要。
    pub fn contract_summary(&self) -> String {
        format!(
            "{}；超时 {} 秒；最多尝试 {} 次；{}；补偿：{}",
            self.idempotency.as_str(),
            self.timeout.as_secs(),
            self.retry.max_attempts,
            if self.cancellable {
                "可取消"
            } else {
                "开始后不可取消"
            },
            match self.compensation {
                Some(kind) => kind.label(),
                None => "无需补偿",
            }
        )
    }
}

/// 这个动作在给定环境下的最终审批要求。
///
/// **生产环境（`Production`）叠加一层**：高风险（`High` / `Critical`）且会改动
/// 服务器的动作必须单独确认 —— 即使动作自己没声明 `requires_approval`。
pub fn approval_required(
    spec: &ActionSpec,
    environment: crate::deployment::model::EnvironmentKind,
) -> bool {
    if spec.requires_approval {
        return true;
    }
    environment == crate::deployment::model::EnvironmentKind::Production
        && spec.mutates_server()
        && spec.risk >= RiskLevel::High
}

/// 动作契约表（穷尽 `match`）。
pub fn spec(kind: ActionKind) -> ActionSpec {
    use ActionKind::*;
    use ActionPhase::*;
    use Idempotency::*;
    use Precondition as Pre;
    use RequiredTool as Tool;

    // 常用组合，避免每行都写重复的 `&[]`。
    const NO_TOOLS: &[RequiredTool] = &[];
    const DOCKER: &[RequiredTool] = &[Tool::Docker];
    const NGINX: &[RequiredTool] = &[Tool::Nginx];

    match kind {
        CheckDependencies => ActionSpec {
            kind,
            phase: Preflight,
            risk: RiskLevel::Low,
            idempotency: Safe,
            timeout: Duration::from_secs(60),
            retry: RetryPolicy::attempts(3, 1),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: NO_TOOLS,
        },
        EnsureDirectory => ActionSpec {
            kind,
            phase: Prepare,
            risk: RiskLevel::Low,
            idempotency: Idempotent,
            timeout: Duration::from_secs(30),
            retry: RetryPolicy::attempts(2, 1),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: NO_TOOLS,
        },
        PrepareReleaseDirectory => ActionSpec {
            kind,
            phase: Prepare,
            risk: RiskLevel::Low,
            idempotency: Idempotent,
            timeout: Duration::from_secs(60),
            retry: RetryPolicy::attempts(2, 1),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: NO_TOOLS,
        },
        UploadArtifact => ActionSpec {
            kind,
            phase: Prepare,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(1800),
            retry: RetryPolicy::attempts(3, 5),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: &[Tool::Sha256Sum],
        },
        VerifyChecksum => ActionSpec {
            kind,
            phase: Prepare,
            risk: RiskLevel::Low,
            idempotency: Safe,
            timeout: Duration::from_secs(300),
            retry: RetryPolicy::attempts(2, 2),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected, Pre::ArtifactUploaded],
            required_tools: &[Tool::Sha256Sum],
        },
        ExtractArchive => ActionSpec {
            kind,
            phase: Prepare,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(600),
            retry: RetryPolicy::once(),
            cancellable: false,
            requires_approval: false,
            compensation: None,
            preconditions: &[
                Pre::ServerConnected,
                Pre::ArtifactUploaded,
                Pre::ChecksumVerified,
            ],
            required_tools: &[Tool::Unzip, Tool::Tar],
        },
        BuildDockerImage => ActionSpec {
            kind,
            phase: Prepare,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(1800),
            retry: RetryPolicy::once(),
            cancellable: false,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected, Pre::ArtifactUploaded],
            required_tools: DOCKER,
        },
        PullDockerImage => ActionSpec {
            kind,
            phase: Prepare,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(900),
            retry: RetryPolicy::attempts(3, 5),
            cancellable: false,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: DOCKER,
        },
        WriteRuntimeConfig => ActionSpec {
            kind,
            phase: Configure,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(60),
            retry: RetryPolicy::attempts(2, 1),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected, Pre::ReleaseDirectoryReady],
            required_tools: NO_TOOLS,
        },
        WriteComposeFile => ActionSpec {
            kind,
            phase: Configure,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(60),
            retry: RetryPolicy::attempts(2, 1),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected, Pre::ReleaseDirectoryReady],
            required_tools: NO_TOOLS,
        },
        ComposeUp => ActionSpec {
            kind,
            phase: Provision,
            risk: RiskLevel::Medium,
            idempotency: Conditional,
            timeout: Duration::from_secs(600),
            retry: RetryPolicy::once(),
            cancellable: false,
            requires_approval: false,
            compensation: Some(ComposeDown),
            preconditions: &[Pre::ServerConnected],
            required_tools: DOCKER,
        },
        ComposeDown => ActionSpec {
            kind,
            phase: Rollback,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(300),
            retry: RetryPolicy::attempts(2, 2),
            cancellable: false,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: DOCKER,
        },
        WaitContainerHealthy => ActionSpec {
            kind,
            phase: Health,
            risk: RiskLevel::Low,
            idempotency: Safe,
            timeout: Duration::from_secs(300),
            retry: RetryPolicy::once(),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected, Pre::ContainerRunning],
            required_tools: DOCKER,
        },
        RestartSystemdUnit => ActionSpec {
            kind,
            phase: Provision,
            risk: RiskLevel::Medium,
            idempotency: Conditional,
            timeout: Duration::from_secs(60),
            retry: RetryPolicy::once(),
            cancellable: false,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: &[Tool::Systemctl],
        },
        BackupNginxConfig => ActionSpec {
            kind,
            phase: Gateway,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(30),
            retry: RetryPolicy::attempts(2, 1),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: NGINX,
        },
        WriteNginxConfig => ActionSpec {
            kind,
            phase: Gateway,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(60),
            retry: RetryPolicy::attempts(2, 1),
            cancellable: true,
            // 写网关配置在**生产环境必须单独确认**（这里就直接标上，
            // 因为它可能把整站打挂，与"高风险"无关）。
            requires_approval: true,
            compensation: Some(RestoreNginxBackup),
            preconditions: &[
                Pre::ServerConnected,
                Pre::NginxBackupPresent,
                Pre::ReleaseDirectoryReady,
            ],
            required_tools: NGINX,
        },
        RestoreNginxBackup => ActionSpec {
            kind,
            phase: Rollback,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(30),
            retry: RetryPolicy::attempts(2, 1),
            cancellable: false,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: NGINX,
        },
        TestNginxConfig => ActionSpec {
            kind,
            phase: Gateway,
            risk: RiskLevel::Low,
            idempotency: Safe,
            timeout: Duration::from_secs(30),
            retry: RetryPolicy::attempts(2, 2),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: NGINX,
        },
        ReloadNginx => ActionSpec {
            kind,
            phase: Gateway,
            risk: RiskLevel::Medium,
            idempotency: Conditional,
            timeout: Duration::from_secs(30),
            retry: RetryPolicy::once(),
            cancellable: false,
            requires_approval: false,
            compensation: None,
            // 硬前提：没通过 `nginx -t` 绝不允许 reload（引擎还会再挡一次）。
            preconditions: &[Pre::ServerConnected, Pre::NginxConfigValid],
            required_tools: NGINX,
        },
        VerifyDnsRecord => ActionSpec {
            kind,
            phase: Certificate,
            risk: RiskLevel::Low,
            idempotency: Safe,
            timeout: Duration::from_secs(60),
            retry: RetryPolicy::attempts(3, 5),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: NO_TOOLS,
        },
        IssueCertificate => ActionSpec {
            kind,
            phase: Certificate,
            risk: RiskLevel::High,
            // 签发会消耗 CA 的速率配额，重复签发不是"收敛到同一结果"。
            idempotency: NotIdempotent,
            timeout: Duration::from_secs(300),
            retry: RetryPolicy::once(),
            cancellable: false,
            requires_approval: true,
            compensation: None,
            preconditions: &[Pre::ServerConnected, Pre::DomainResolved],
            required_tools: &[Tool::Certbot],
        },
        RenewCertificate => ActionSpec {
            kind,
            phase: Certificate,
            risk: RiskLevel::High,
            idempotency: NotIdempotent,
            timeout: Duration::from_secs(300),
            retry: RetryPolicy::once(),
            cancellable: false,
            requires_approval: true,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: &[Tool::Certbot],
        },
        HttpHealthCheck => ActionSpec {
            kind,
            phase: Health,
            risk: RiskLevel::Low,
            idempotency: Safe,
            timeout: Duration::from_secs(90),
            retry: RetryPolicy::once(),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: &[Tool::Curl],
        },
        TcpHealthCheck => ActionSpec {
            kind,
            phase: Health,
            risk: RiskLevel::Low,
            idempotency: Safe,
            timeout: Duration::from_secs(30),
            retry: RetryPolicy::once(),
            cancellable: true,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: NO_TOOLS,
        },
        SwitchReleaseSymlink => ActionSpec {
            kind,
            phase: Promote,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(30),
            retry: RetryPolicy::attempts(2, 1),
            cancellable: true,
            requires_approval: false,
            // 切链是"当前版本"的一步，失败要能把链接指回去。
            compensation: Some(RollbackRelease),
            preconditions: &[Pre::ServerConnected, Pre::ReleaseDirectoryReady],
            required_tools: NO_TOOLS,
        },
        PromoteRelease => ActionSpec {
            kind,
            phase: Promote,
            risk: RiskLevel::High,
            idempotency: NotIdempotent,
            timeout: Duration::from_secs(60),
            retry: RetryPolicy::once(),
            cancellable: false,
            requires_approval: true,
            compensation: Some(RollbackRelease),
            preconditions: &[
                Pre::ServerConnected,
                Pre::ReleaseDirectoryReady,
                Pre::CurrentReleaseExists,
            ],
            required_tools: NO_TOOLS,
        },
        StopPreviousRelease => ActionSpec {
            kind,
            phase: Promote,
            risk: RiskLevel::Medium,
            idempotency: Idempotent,
            timeout: Duration::from_secs(120),
            retry: RetryPolicy::attempts(2, 2),
            cancellable: false,
            requires_approval: false,
            compensation: None,
            preconditions: &[Pre::ServerConnected],
            required_tools: NO_TOOLS,
        },
        RollbackRelease => ActionSpec {
            kind,
            phase: Rollback,
            risk: RiskLevel::High,
            idempotency: NotIdempotent,
            timeout: Duration::from_secs(120),
            retry: RetryPolicy::once(),
            cancellable: false,
            requires_approval: true,
            compensation: None,
            preconditions: &[Pre::ServerConnected, Pre::CurrentReleaseExists],
            required_tools: NO_TOOLS,
        },
        RequireManualStep => ActionSpec {
            kind,
            phase: Preflight,
            risk: RiskLevel::High,
            idempotency: Safe,
            timeout: Duration::from_secs(0),
            retry: RetryPolicy::once(),
            cancellable: true,
            requires_approval: true,
            compensation: None,
            preconditions: &[Pre::ManualAcknowledgement],
            required_tools: NO_TOOLS,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::model::EnvironmentKind;

    #[test]
    fn every_action_kind_declares_a_complete_contract() {
        for kind in ActionKind::ALL {
            let spec = spec(*kind);
            assert_eq!(spec.kind, *kind);
            assert!(
                !spec.contract_summary().is_empty(),
                "{kind:?} 必须能描述自己的契约"
            );
            if spec.mutates_server() && spec.risk == RiskLevel::Low {
                // 低风险动作不应改动服务器（除非明确声明）。
                assert!(
                    !spec.requires_approval,
                    "{kind:?} 低风险却要求审批，检查是否标错了风险"
                );
            }
            if spec.idempotency == Idempotency::NotIdempotent {
                assert_eq!(
                    spec.retry.max_attempts, 1,
                    "{kind:?} 非幂等动作不允许自动重试"
                );
            }
        }
    }

    #[test]
    fn nginx_reload_cannot_run_without_a_valid_config() {
        let spec = spec(ActionKind::ReloadNginx);
        assert!(spec.preconditions.contains(&Precondition::NginxConfigValid));
    }

    #[test]
    fn production_escalates_high_risk_actions_to_individual_approval() {
        let promote = spec(ActionKind::PromoteRelease);
        assert!(approval_required(&promote, EnvironmentKind::Staging) == promote.requires_approval);
        assert!(approval_required(&promote, EnvironmentKind::Production));

        // 低风险的读操作在生产也不会被要求审批。
        let health = spec(ActionKind::HttpHealthCheck);
        assert!(!approval_required(&health, EnvironmentKind::Production));
    }

    #[test]
    fn gateway_writes_always_need_confirmation_and_declare_their_compensation() {
        let write = spec(ActionKind::WriteNginxConfig);
        assert!(write.requires_approval);
        assert_eq!(write.compensation, Some(ActionKind::RestoreNginxBackup));

        let symlink = spec(ActionKind::SwitchReleaseSymlink);
        assert_eq!(symlink.compensation, Some(ActionKind::RollbackRelease));
        assert_eq!(symlink.retry.max_attempts, 2, "切软链是幂等的，可以重试");
    }
}
