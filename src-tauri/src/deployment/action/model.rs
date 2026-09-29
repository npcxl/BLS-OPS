//! 类型化部署动作：**每个动作一个独立输入类型，没有任何自由命令字段**。
//!
//! # 与 P5.0 的关系
//!
//! P5.0 的 [`crate::deployment::model::PlanActionKind`] 是"动作字典"——它只有
//! 名字，参数放在 `PlanNode.params_json` 里（只做结构化校验）。本模块是
//! **它的类型化落地**：`compile` 把 `(PlanActionKind, params_json)` 编译成这里的
//! 一个变体，编译器拿不准的参数宁可报错，也不塞进一个宽松的 map。
//!
//! # 三条铁律（与 P5.0 一脉相承）
//!
//! 1. **没有命令字段**。没有 `command` / `cmd` / `script` / `args` / `shell`：
//!    compose 与 systemd 单元也不接受 `command:` 行（那等于换个地方写命令）。
//! 2. **Secret 只有引用**。[`WriteRuntimeConfig`] 的条目要么是明文（非敏感），
//!    要么是 `secret_ref_id` + `secret: true` —— 值由执行器从钥匙串取，取完
//!    只写文件，不进日志、不进快照（见 [`crate::deployment::exec::redact`]）。
//! 3. **路径必须绝对且在部署根之下**（执行器逐条用 `safe::validate_abs_path`
//!    与 `safe::is_within` 复核，模型层不做"信任"假设）。
//!
//! 旧 P3 的 `commands_json`（`projects.commands`）**不参与本模型**：编译器只接受
//! [`crate::deployment::model::PlanActionKind`]，旧记录里的命令字符串没有任何
//! 入口进入这里（`compile` 的参数就是类型化的计划节点）。

use serde::{Deserialize, Serialize};

use crate::deployment::model::PortMapping;

// -- 子结构 ------------------------------------------------------------------

/// 运行时配置文件里的一条配置。
///
/// `secret = true` 时**必须**给 `secret_ref_id`，且 `value` 必须为空 ——
/// 明文密钥只存在钥匙串里，模型与快照里永远不会出现它的值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RuntimeConfigEntry {
    pub key: String,
    /// 明文值（仅 `secret = false` 时允许）。
    pub value: Option<String>,
    pub secret: bool,
    /// `crate::deployment::model::SecretRef::id`。
    pub secret_ref_id: Option<String>,
    pub required: bool,
}

/// Compose 服务规格 —— **渲染器的唯一输入**，不是 YAML 文本。
///
/// 刻意没有 `command` / `entrypoint` 字段：容器里跑什么由镜像自己决定。
/// `publish_ports` 只允许出现在"对外网关"服务上（渲染器按 `internal` 网络
/// 组织服务，后端默认不发布端口），这是"只暴露必要端口"的落地方式。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ComposeServiceSpec {
    pub name: String,
    /// 镜像引用；与 `build_context` 二选一。
    pub image: Option<String>,
    /// 本地构建上下文（绝对路径）。
    pub build_context: Option<String>,
    /// 构建用的 Dockerfile（必须位于 `build_context` 内）。
    pub dockerfile: Option<String>,
    /// 宿主机端口映射 —— **只有网关服务才该有**。
    pub publish_ports: Vec<PortMapping>,
    /// 容器内监听端口（不发布，只声明，供依赖方连线）。
    pub expose_ports: Vec<u16>,
    /// 环境变量文件（绝对路径，由 `WriteRuntimeConfig` 先写好）。
    pub env_file: Option<String>,
    pub depends_on: Vec<String>,
    /// HTTP 健康检查路径（渲染成 compose healthcheck）。
    pub healthcheck_path: Option<String>,
    /// 加入的网络名（空 = 只加入内部网络）。
    pub networks: Vec<String>,
    /// 是否只走内部网络（默认 `true`：后端服务不该暴露端口）。
    pub internal_only: bool,
}

/// Nginx 站点规格 —— 同样是"结构化输入 → 渲染"，没有原文透传。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct NginxSiteSpec {
    pub site_name: String,
    /// `server_name`（可多个，第一个作为主域名）。
    pub server_names: Vec<String>,
    pub listen_port: u16,
    pub path_prefix: String,
    /// 静态站点根目录（与 `proxy_pass` 二选一）。
    pub root: Option<String>,
    /// 反向代理目标，形如 `127.0.0.1:3000`（与 `root` 二选一）。
    pub proxy_pass: Option<String>,
    pub ssl_certificate: Option<String>,
    pub ssl_certificate_key: Option<String>,
    pub client_max_body_size_mb: Option<u32>,
}

/// 停止旧版本的三种形态（P5.0 `ServiceRuntime` 的执行侧投影）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StopTarget {
    Container {
        container: String,
    },
    SystemdUnit {
        unit: String,
    },
    ComposeStack {
        compose_path: String,
        project_name: String,
    },
}

/// 依赖检查要确认存在的工具。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequiredTool {
    Docker,
    DockerCompose,
    Nginx,
    Systemctl,
    Curl,
    Certbot,
    Unzip,
    Tar,
    /// `sha256sum`（coreutils，一般都有，但仍然要问一句）。
    Sha256Sum,
}

/// 证书挑战方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CertificateChallenge {
    /// HTTP-01：需要域名已解析到本机，且 80 端口可达。
    Http01,
    /// DNS-01：V1 **只产出人工指引 + 解析验证**，不调用任何服务商 API。
    Dns01,
}

/// 归档格式（与 `safe::ArchiveFormat` 一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveFormat {
    Zip,
    Tar,
    TarGz,
}

// -- 各动作的独立输入类型 ------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct UploadArtifactInput {
    pub local_path: String,
    pub remote_dir: String,
    pub file_name: String,
    /// 上传前后都要校验的内容哈希。
    pub expected_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct VerifyChecksumInput {
    pub remote_path: String,
    pub expected_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct EnsureDirectoryInput {
    pub path: String,
    pub mode: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct PrepareReleaseDirectoryInput {
    pub release_root: String,
    pub version_label: String,
    /// 保留最近几个版本目录（含本次）。`< 1` 会被校验拒绝。
    pub keep_releases: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ExtractArchiveInput {
    pub archive_path: String,
    pub dest_dir: String,
    pub format: ArchiveFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct BuildDockerImageInput {
    pub context_dir: String,
    pub dockerfile: String,
    pub image_tag: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct PullDockerImageInput {
    pub image: String,
    /// 期望 digest（`sha256:...`）；给了就必须一致，否则判失败。
    pub expected_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct WriteComposeFileInput {
    pub compose_path: String,
    pub project_name: String,
    pub services: Vec<ComposeServiceSpec>,
    /// 内部网络名（服务之间通过它互联，后端不发布端口）。
    pub internal_network: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ComposeUpInput {
    pub compose_path: String,
    pub project_name: String,
    pub services: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ComposeDownInput {
    pub compose_path: String,
    pub project_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct WaitContainerHealthyInput {
    pub container: String,
    pub timeout_secs: u32,
    pub interval_secs: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct WriteRuntimeConfigInput {
    pub path: String,
    pub mode: u32,
    pub entries: Vec<RuntimeConfigEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct BackupNginxConfigInput {
    pub config_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct WriteNginxConfigInput {
    pub config_path: String,
    pub site: NginxSiteSpec,
    /// 是否同时建立 `sites-enabled` 软链。
    pub enable_site: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TestNginxConfigInput {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ReloadNginxInput {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct VerifyDnsRecordInput {
    pub domain: String,
    /// 期望解析到的 IPv4（可空 = 只要求"能解析出地址"）。
    pub expected_ip: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct IssueCertificateInput {
    pub domains: Vec<String>,
    pub email: String,
    /// HTTP-01 的 webroot 目录（绝对路径）。
    pub webroot: String,
    pub challenge: CertificateChallenge,
    /// DNS-01 的服务商适配器 id；V1 只接受 `manual`。
    pub dns_provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RenewCertificateInput {
    pub cert_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct HttpHealthCheckInput {
    pub url: String,
    pub expected_status: u16,
    pub timeout_secs: u32,
    pub attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TcpHealthCheckInput {
    /// 只支持本机（`127.0.0.1` / `localhost` / `0.0.0.0`）——见
    /// `safe::Capability::CheckTcpPort` 的说明。
    pub host: String,
    pub port: u16,
    pub timeout_secs: u32,
    pub attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct SwitchReleaseSymlinkInput {
    pub link_path: String,
    pub target_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RestartSystemdUnitInput {
    pub unit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct PromoteReleaseInput {
    pub release_root: String,
    /// 指向"当前版本"的软链（如 `<root>/current`）。
    pub current_link: String,
    pub version_label: String,
    pub service_unit_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct StopPreviousReleaseInput {
    pub target: StopTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RollbackReleaseInput {
    pub service_unit_id: Option<String>,
    /// 要指回去的版本目录（绝对路径）。
    pub target_dir: String,
    pub current_link: String,
    /// 数据侧是否可回退（人工填写的说明，**不是**要执行的命令）。
    pub data_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RestoreNginxBackupInput {
    pub config_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CheckDependenciesInput {
    pub tools: Vec<RequiredTool>,
}

/// 需要人工完成的步骤（例如数据库迁移）。
///
/// **这不是"随便写个命令让用户去跑"**：它只是把"这里有件事必须人来做"
/// 变成工作流里一个显式的、需要审批的门，而不是让引擎偷偷跳过它。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RequireManualStepInput {
    /// 为什么需要人工（面向审批人）。
    pub reason: String,
    /// 人工确认已完成。引擎只认这个布尔值，不执行任何脚本。
    pub acknowledged: bool,
}

// -- 动作 --------------------------------------------------------------------

/// 一个可执行的部署动作。
///
/// 变体顺序与呈现顺序一致（预检 → 制品 → 配置 → 服务 → 网关 → 证书 →
/// 健康检查 → 提升 → 回滚），方便阅读与测试。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeploymentAction {
    // 预检 / 准备
    CheckDependencies(CheckDependenciesInput),
    EnsureDirectory(EnsureDirectoryInput),
    PrepareReleaseDirectory(PrepareReleaseDirectoryInput),
    // 制品
    UploadArtifact(UploadArtifactInput),
    VerifyChecksum(VerifyChecksumInput),
    ExtractArchive(ExtractArchiveInput),
    BuildDockerImage(BuildDockerImageInput),
    PullDockerImage(PullDockerImageInput),
    // 配置
    WriteRuntimeConfig(WriteRuntimeConfigInput),
    // 服务（容器）
    WriteComposeFile(WriteComposeFileInput),
    ComposeUp(ComposeUpInput),
    ComposeDown(ComposeDownInput),
    WaitContainerHealthy(WaitContainerHealthyInput),
    // 服务（systemd）
    RestartSystemdUnit(RestartSystemdUnitInput),
    // 网关
    BackupNginxConfig(BackupNginxConfigInput),
    WriteNginxConfig(WriteNginxConfigInput),
    RestoreNginxBackup(RestoreNginxBackupInput),
    TestNginxConfig(TestNginxConfigInput),
    ReloadNginx(ReloadNginxInput),
    // 域名与证书
    VerifyDnsRecord(VerifyDnsRecordInput),
    IssueCertificate(IssueCertificateInput),
    RenewCertificate(RenewCertificateInput),
    // 健康检查
    HttpHealthCheck(HttpHealthCheckInput),
    TcpHealthCheck(TcpHealthCheckInput),
    // 提升与回滚
    SwitchReleaseSymlink(SwitchReleaseSymlinkInput),
    PromoteRelease(PromoteReleaseInput),
    StopPreviousRelease(StopPreviousReleaseInput),
    RollbackRelease(RollbackReleaseInput),
    // 人工门
    RequireManualStep(RequireManualStepInput),
}

impl DeploymentAction {
    /// 动作的稳定标识（`snake_case`，与前端 `ACTION_KIND_LABELS` 同一套取值）。
    ///
    /// 手写而不是靠 `serde` 反射：这个字符串会进数据库与审计，必须显式、
    /// 可 grep、不能因为重构字段名而漂移。
    pub fn kind(&self) -> ActionKind {
        match self {
            DeploymentAction::CheckDependencies(_) => ActionKind::CheckDependencies,
            DeploymentAction::EnsureDirectory(_) => ActionKind::EnsureDirectory,
            DeploymentAction::PrepareReleaseDirectory(_) => ActionKind::PrepareReleaseDirectory,
            DeploymentAction::UploadArtifact(_) => ActionKind::UploadArtifact,
            DeploymentAction::VerifyChecksum(_) => ActionKind::VerifyChecksum,
            DeploymentAction::ExtractArchive(_) => ActionKind::ExtractArchive,
            DeploymentAction::BuildDockerImage(_) => ActionKind::BuildDockerImage,
            DeploymentAction::PullDockerImage(_) => ActionKind::PullDockerImage,
            DeploymentAction::WriteRuntimeConfig(_) => ActionKind::WriteRuntimeConfig,
            DeploymentAction::WriteComposeFile(_) => ActionKind::WriteComposeFile,
            DeploymentAction::ComposeUp(_) => ActionKind::ComposeUp,
            DeploymentAction::ComposeDown(_) => ActionKind::ComposeDown,
            DeploymentAction::WaitContainerHealthy(_) => ActionKind::WaitContainerHealthy,
            DeploymentAction::RestartSystemdUnit(_) => ActionKind::RestartSystemdUnit,
            DeploymentAction::BackupNginxConfig(_) => ActionKind::BackupNginxConfig,
            DeploymentAction::WriteNginxConfig(_) => ActionKind::WriteNginxConfig,
            DeploymentAction::RestoreNginxBackup(_) => ActionKind::RestoreNginxBackup,
            DeploymentAction::TestNginxConfig(_) => ActionKind::TestNginxConfig,
            DeploymentAction::ReloadNginx(_) => ActionKind::ReloadNginx,
            DeploymentAction::VerifyDnsRecord(_) => ActionKind::VerifyDnsRecord,
            DeploymentAction::IssueCertificate(_) => ActionKind::IssueCertificate,
            DeploymentAction::RenewCertificate(_) => ActionKind::RenewCertificate,
            DeploymentAction::HttpHealthCheck(_) => ActionKind::HttpHealthCheck,
            DeploymentAction::TcpHealthCheck(_) => ActionKind::TcpHealthCheck,
            DeploymentAction::SwitchReleaseSymlink(_) => ActionKind::SwitchReleaseSymlink,
            DeploymentAction::PromoteRelease(_) => ActionKind::PromoteRelease,
            DeploymentAction::StopPreviousRelease(_) => ActionKind::StopPreviousRelease,
            DeploymentAction::RollbackRelease(_) => ActionKind::RollbackRelease,
            DeploymentAction::RequireManualStep(_) => ActionKind::RequireManualStep,
        }
    }

    /// 人类可读标题（审计与 UI 用）。
    pub fn title(&self) -> &'static str {
        self.kind().label()
    }

    /// 这个动作是否会改动服务器状态（预检/读取不是）。
    pub fn mutates_server(&self) -> bool {
        self.kind().mutates_server()
    }
}

/// 动作种类（无参数）——元数据与审计都以它为准。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    CheckDependencies,
    EnsureDirectory,
    PrepareReleaseDirectory,
    UploadArtifact,
    VerifyChecksum,
    ExtractArchive,
    BuildDockerImage,
    PullDockerImage,
    WriteRuntimeConfig,
    WriteComposeFile,
    ComposeUp,
    ComposeDown,
    WaitContainerHealthy,
    RestartSystemdUnit,
    BackupNginxConfig,
    WriteNginxConfig,
    RestoreNginxBackup,
    TestNginxConfig,
    ReloadNginx,
    VerifyDnsRecord,
    IssueCertificate,
    RenewCertificate,
    HttpHealthCheck,
    TcpHealthCheck,
    SwitchReleaseSymlink,
    PromoteRelease,
    StopPreviousRelease,
    RollbackRelease,
    RequireManualStep,
}

impl ActionKind {
    /// 全部取值（测试与前端标签表一致性检查都靠它）。
    pub const ALL: &'static [ActionKind] = &[
        ActionKind::CheckDependencies,
        ActionKind::EnsureDirectory,
        ActionKind::PrepareReleaseDirectory,
        ActionKind::UploadArtifact,
        ActionKind::VerifyChecksum,
        ActionKind::ExtractArchive,
        ActionKind::BuildDockerImage,
        ActionKind::PullDockerImage,
        ActionKind::WriteRuntimeConfig,
        ActionKind::WriteComposeFile,
        ActionKind::ComposeUp,
        ActionKind::ComposeDown,
        ActionKind::WaitContainerHealthy,
        ActionKind::RestartSystemdUnit,
        ActionKind::BackupNginxConfig,
        ActionKind::WriteNginxConfig,
        ActionKind::RestoreNginxBackup,
        ActionKind::TestNginxConfig,
        ActionKind::ReloadNginx,
        ActionKind::VerifyDnsRecord,
        ActionKind::IssueCertificate,
        ActionKind::RenewCertificate,
        ActionKind::HttpHealthCheck,
        ActionKind::TcpHealthCheck,
        ActionKind::SwitchReleaseSymlink,
        ActionKind::PromoteRelease,
        ActionKind::StopPreviousRelease,
        ActionKind::RollbackRelease,
        ActionKind::RequireManualStep,
    ];

    /// 稳定字符串（进数据库、审计与前端标签表）。
    pub fn as_str(self) -> &'static str {
        match self {
            ActionKind::CheckDependencies => "check_dependencies",
            ActionKind::EnsureDirectory => "ensure_directory",
            ActionKind::PrepareReleaseDirectory => "prepare_release_directory",
            ActionKind::UploadArtifact => "upload_artifact",
            ActionKind::VerifyChecksum => "verify_checksum",
            ActionKind::ExtractArchive => "extract_archive",
            ActionKind::BuildDockerImage => "build_docker_image",
            ActionKind::PullDockerImage => "pull_docker_image",
            ActionKind::WriteRuntimeConfig => "write_runtime_config",
            ActionKind::WriteComposeFile => "write_compose_file",
            ActionKind::ComposeUp => "compose_up",
            ActionKind::ComposeDown => "compose_down",
            ActionKind::WaitContainerHealthy => "wait_container_healthy",
            ActionKind::RestartSystemdUnit => "restart_systemd_unit",
            ActionKind::BackupNginxConfig => "backup_nginx_config",
            ActionKind::WriteNginxConfig => "write_nginx_config",
            ActionKind::RestoreNginxBackup => "restore_nginx_backup",
            ActionKind::TestNginxConfig => "test_nginx_config",
            ActionKind::ReloadNginx => "reload_nginx",
            ActionKind::VerifyDnsRecord => "verify_dns_record",
            ActionKind::IssueCertificate => "issue_certificate",
            ActionKind::RenewCertificate => "renew_certificate",
            ActionKind::HttpHealthCheck => "http_health_check",
            ActionKind::TcpHealthCheck => "tcp_health_check",
            ActionKind::SwitchReleaseSymlink => "switch_release_symlink",
            ActionKind::PromoteRelease => "promote_release",
            ActionKind::StopPreviousRelease => "stop_previous_release",
            ActionKind::RollbackRelease => "rollback_release",
            ActionKind::RequireManualStep => "require_manual_step",
        }
    }

    /// 唯一审计事件名（每次执行都会记一条，成功与失败都记）。
    pub fn audit_event(self) -> String {
        format!("deployment.action.{}", self.as_str())
    }

    /// 审计 / UI 用的中文短标签。
    pub fn label(self) -> &'static str {
        match self {
            ActionKind::CheckDependencies => "检查服务器依赖",
            ActionKind::EnsureDirectory => "创建目录",
            ActionKind::PrepareReleaseDirectory => "准备发布目录",
            ActionKind::UploadArtifact => "上传制品",
            ActionKind::VerifyChecksum => "校验制品哈希",
            ActionKind::ExtractArchive => "解包归档",
            ActionKind::BuildDockerImage => "构建镜像",
            ActionKind::PullDockerImage => "拉取镜像",
            ActionKind::WriteRuntimeConfig => "写入运行时配置",
            ActionKind::WriteComposeFile => "生成 Compose 文件",
            ActionKind::ComposeUp => "启动 Compose 栈",
            ActionKind::ComposeDown => "停止 Compose 栈",
            ActionKind::WaitContainerHealthy => "等待容器健康",
            ActionKind::RestartSystemdUnit => "重启服务单元",
            ActionKind::BackupNginxConfig => "备份 Nginx 配置",
            ActionKind::WriteNginxConfig => "写入 Nginx 配置",
            ActionKind::RestoreNginxBackup => "还原 Nginx 备份",
            ActionKind::TestNginxConfig => "测试 Nginx 配置",
            ActionKind::ReloadNginx => "重载 Nginx",
            ActionKind::VerifyDnsRecord => "验证 DNS 解析",
            ActionKind::IssueCertificate => "签发证书",
            ActionKind::RenewCertificate => "续期证书",
            ActionKind::HttpHealthCheck => "HTTP 健康检查",
            ActionKind::TcpHealthCheck => "TCP 健康检查",
            ActionKind::SwitchReleaseSymlink => "切换版本软链",
            ActionKind::PromoteRelease => "提升版本",
            ActionKind::StopPreviousRelease => "停止旧版本",
            ActionKind::RollbackRelease => "回滚版本",
            ActionKind::RequireManualStep => "人工确认步骤",
        }
    }

    /// 是否会改动服务器状态。预检类动作是只读的。
    pub fn mutates_server(self) -> bool {
        !matches!(
            self,
            ActionKind::CheckDependencies
                | ActionKind::VerifyChecksum
                | ActionKind::WaitContainerHealthy
                | ActionKind::TestNginxConfig
                | ActionKind::VerifyDnsRecord
                | ActionKind::HttpHealthCheck
                | ActionKind::TcpHealthCheck
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_kind_has_a_unique_stable_key() {
        let mut keys: Vec<&str> = ActionKind::ALL.iter().map(|kind| kind.as_str()).collect();
        keys.sort_unstable();
        let count = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), count, "动作标识必须唯一");
        assert_eq!(count, 29, "动作数量变化时同步更新前端标签表与测试");
    }

    #[test]
    fn kind_round_trips_through_the_serialised_action() {
        for kind in ActionKind::ALL {
            let action = super::super::tests::sample(*kind);
            assert_eq!(action.kind(), *kind);
            let json = serde_json::to_string(&action).expect("serialize");
            let back: DeploymentAction = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, action, "{kind:?} 必须能往返");
        }
    }

    #[test]
    fn audit_events_are_namespaced() {
        assert_eq!(
            ActionKind::ReloadNginx.audit_event(),
            "deployment.action.reload_nginx"
        );
    }
}
