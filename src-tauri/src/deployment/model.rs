//! P5.0 部署中心的领域类型。
//!
//! 全部类型经 `serde` 直接跨 IPC（字段一律 **snake_case**，与 `src/api/types/
//! deployment.ts` 一一对应）。两个刻意的设计：
//!
//! * 枚举一律带值（`snake_case` 字符串），前端存的是字符串联合类型，
//!   不传数字、不做隐式转换；
//! * 时间戳是毫秒整数（`db::AppDb::now()`），可空字段表示"未知"，
//!   **绝不用假值填充**（0 / 空串 都不能冒充"不知道"）。

use serde::{Deserialize, Serialize};

// -- 应用 -------------------------------------------------------------------

/// 应用类型。用户在 UI 里显式选择（v2 §23：系统识别只能作为推荐，不能替用户决定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationKind {
    /// 纯前端（构建产物是静态文件）。
    Frontend,
    /// 纯后端（长驻进程）。
    Backend,
    /// 前端 + 后端（同一应用下多个服务）。
    FullStack,
    /// 静态站点（无构建，直接上传目录）。
    StaticSite,
    /// 常驻 Worker（消费队列，不监听端口）。
    Worker,
    /// 定时任务（cron / systemd timer）。
    ScheduledTask,
}

/// 制品/源码的来源类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// Git 仓库（`source_ref` = 仓库地址）。
    Git,
    /// 本地文件（由用户上传，`source_ref` 只是本地路径提示，不作为远程路径）。
    LocalUpload,
    /// 服务器上已存在的目录（`source_ref` = 绝对路径）。
    ExistingRemoteDir,
}

/// 一个可部署的应用 —— 部署中心的顶层实体。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentApplication {
    pub id: String,
    /// 归属服务器。P5.0 一应用一台服务器；多服务器映射留给后续阶段。
    pub server_id: String,
    pub name: String,
    pub description: String,
    pub application_kind: ApplicationKind,
    pub source_kind: SourceKind,
    /// Git 仓库地址 / 服务器绝对路径 / 本地上传目录提示。**不是命令**。
    pub source_ref: String,
    pub default_branch: String,
    /// 关联的 P3.8 已确认项目（同服务器上的目录），可选。
    pub confirmed_project_path: Option<String>,
    /// `active` | `archived`
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// -- 环境 -------------------------------------------------------------------

/// 环境类型。生产环境在后续阶段默认要求健康检查、快照与审批（v2 §111.24/25）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentKind {
    Development,
    Testing,
    Staging,
    Production,
}

impl EnvironmentKind {
    /// 生产类环境（staging 视同生产：它是"真数据的演练场"）。
    pub fn is_production_like(self) -> bool {
        matches!(self, EnvironmentKind::Staging | EnvironmentKind::Production)
    }
}

/// 一个环境（开发 / 测试 / 预发布 / 生产）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentEnvironment {
    pub id: String,
    pub application_id: String,
    pub server_id: String,
    pub name: String,
    pub kind: EnvironmentKind,
    /// 环境根目录（绝对路径）。所有服务的 `deploy_path` 必须落在它下面。
    pub deploy_root: String,
    /// 关联的容量画像（问卷答案），可选。
    pub capacity_profile_id: Option<String>,
    pub notes: String,
    /// `active` | `archived`
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// -- 服务 -------------------------------------------------------------------

/// 服务角色（一个应用里这个服务是干什么的）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceRole {
    Web,
    Api,
    Worker,
    Scheduler,
    Gateway,
    Database,
    Cache,
    Static,
    Other,
}

/// 服务的部署形态 —— 决定后续阶段会编译出哪一类部署动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceKind {
    /// 静态文件 + Nginx site。
    StaticNginx,
    /// systemd 单元。
    SystemdUnit,
    /// 单个 Docker 镜像 + 容器。
    DockerImage,
    /// Docker Compose 项目里的一个服务。
    DockerCompose,
    /// JAR（java -jar，靠 systemd/进程守护）。
    JavaJar,
    /// Node 进程。
    NodeProcess,
    /// Python venv 进程。
    PythonVenv,
    /// 原生二进制。
    NativeBinary,
    /// 外部托管（数据库 / Redis / 云服务）—— 本工具只做依赖声明与健康检查。
    ExternalManaged,
}

/// 端口协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortProtocol {
    Tcp,
    Udp,
}

/// 端口映射（容器端口 → 宿主机端口）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PortMapping {
    pub host_port: u16,
    pub container_port: u16,
    pub protocol: PortProtocol,
}

/// 服务怎么跑起来 —— **结构化枚举，不是命令字符串**。
///
/// 每个变体只描述"跑什么"，参数都是受校验的标识符或路径；真正生成命令行
/// （经 `safe::Capability` + `shell_quote`）是后续阶段的编译步骤。P5.0 只存不跑。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServiceRuntime {
    /// Nginx 静态站点。
    StaticNginx {
        /// site 名（`sites-available` 里的文件名，不含扩展名）。
        site_name: String,
        /// 站点根目录（绝对路径）。
        root: String,
    },
    /// systemd 单元。
    SystemdUnit { unit: String },
    /// 单容器。
    DockerImage {
        image: String,
        tag: String,
        container_name: String,
        ports: Vec<PortMapping>,
    },
    /// Compose 项目中的一个服务。
    DockerCompose {
        compose_path: String,
        project_name: String,
        service: String,
    },
    /// 直接跑一个可执行文件（JAR / Node / Python / 原生二进制都走这里）。
    NativeProcess {
        /// 绝对路径或文件名（如 `java`、`node`）。
        entry: String,
        /// 参数列表。**逐项校验**，不拼接、不解释，且任何一项都不允许含 shell 元字符。
        args: Vec<String>,
    },
    /// 外部托管（数据库 / Redis / 云服务）：本工具只做依赖声明与健康检查，
    /// 不部署它。`endpoint` 是 `host:port`，不参与任何命令拼接。
    External { endpoint: String },
}

/// 一个应用在某环境里的一个可部署服务。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ServiceUnit {
    pub id: String,
    pub application_id: String,
    pub environment_id: String,
    pub name: String,
    pub role: ServiceRole,
    pub service_kind: ServiceKind,
    /// 运行方式（结构化）。
    pub runtime: ServiceRuntime,
    /// 服务自己的工作目录（绝对路径，可空 = 用环境根目录）。
    pub deploy_path: Option<String>,
    /// 关联 P3.8 已确认项目（`confirmed_projects.id`），可空。
    pub confirmed_project_id: Option<String>,
    /// 关联已确认项目的规范路径（冗余保存，便于展示与按路径反查）。
    pub confirmed_project_path: Option<String>,
    /// 默认使用的制品（`artifact_records.id`），可空。
    pub artifact_id: Option<String>,
    /// `configured` | `incomplete` | `disabled`
    pub status: String,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 服务之间的关系类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceRelationKind {
    /// from 依赖 to。
    DependsOn,
    /// from 为 to 提供服务（对外连通关系）。
    ProvidesTo,
    /// 共享网络。
    SharesNetwork,
    /// 共享卷 / 目录。
    SharesVolume,
    /// from 必须先于 to 启动。
    OrderBefore,
}

/// 依赖不可用时的策略（v2 §47）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailurePolicy {
    /// 阻断部署。
    Block,
    /// 告警但继续。
    Warn,
    /// 忽略。
    Ignore,
}

/// 两个服务之间的关系（依赖 / 网络 / 卷 / 启动顺序）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ServiceRelation {
    pub id: String,
    pub application_id: String,
    pub from_service_id: String,
    pub to_service_id: String,
    pub relation_kind: ServiceRelationKind,
    /// 硬依赖（后续阶段：不满足即按 `failure_policy` 处理）。
    pub required: bool,
    pub failure_policy: FailurePolicy,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// -- 容量 -------------------------------------------------------------------

/// 容量数据的来源性质 —— 决定 UI 必须怎么展示它。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EstimationBasis {
    /// 用户明确给出的数字。
    UserProvided,
    /// 系统根据假设估算出来的。
    Estimated,
    /// 未知。
    Unknown,
}

/// 容量问卷（v2 §81 的 Preflight 需要它，而不是拍脑袋）。
///
/// 每个字段都可空 —— 空 = 未知，绝不用 0 冒充。用户不知道 QPS 时允许估算，
/// 但 `estimation_basis` 必须是 `estimated` 且 `assumptions` 不能为空
/// （校验见 [`crate::deployment::validate::validate_capacity`]）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CapacityProfile {
    pub id: String,
    pub environment_id: String,
    pub expected_dau: Option<i64>,
    pub concurrent_users: Option<i64>,
    pub peak_qps: Option<f64>,
    pub avg_qps: Option<f64>,
    pub websocket_connections: Option<i64>,
    /// 响应时间目标（毫秒）。填了就替代"平均响应 0.5 秒"这条估算假设。
    pub response_target_ms: Option<i64>,
    pub monthly_bandwidth_gb: Option<f64>,
    pub monthly_upload_gb: Option<f64>,
    pub monthly_data_growth_gb: Option<f64>,
    /// 目标可用性，取值 `99` / `99.9` / `99.95` / `99.99`。
    pub availability_target: Option<String>,
    pub rpo_minutes: Option<i64>,
    pub rto_minutes: Option<i64>,
    pub monthly_budget: Option<f64>,
    pub budget_currency: Option<String>,
    pub estimation_basis: EstimationBasis,
    /// 估算假设（估算时必填，逐条展示给用户）。
    pub assumptions: Vec<String>,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// -- 域名与证书 -------------------------------------------------------------

/// DNS 校验状态（P5.0 只存状态，不做查询）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DnsStatus {
    Unknown,
    Unchecked,
    Resolved,
    Mismatched,
}

/// 证书模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SslMode {
    None,
    Manual,
    Acme,
}

/// 证书状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SslStatus {
    NotApplicable,
    Pending,
    Issued,
    Expiring,
    Expired,
    Failed,
}

/// 域名绑定（域名 → 环境里的某个服务）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DomainBinding {
    pub id: String,
    pub environment_id: String,
    /// 绑到哪个服务；可空 = 只登记域名，尚未绑定（UI 明确显示"未绑定"）。
    pub service_unit_id: Option<String>,
    /// 域名，小写、不带协议与端口（校验见 `validate_domain`）。
    pub domain: String,
    pub listen_port: u16,
    /// URL 前缀，默认 `/`。
    pub path_prefix: String,
    /// DNS 服务商的凭据引用（[`SecretRef`] id）。
    pub dns_credential_ref: Option<String>,
    pub dns_status: DnsStatus,
    pub dns_checked_at: Option<i64>,
    pub ssl_mode: SslMode,
    pub ssl_status: SslStatus,
    pub ssl_expires_at: Option<i64>,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// -- 配置与密钥 -------------------------------------------------------------

/// 配置项数据类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigDataType {
    String,
    Number,
    Boolean,
    Url,
    Port,
    Path,
    Json,
}

/// 配置在什么时候生效（v2 §22 / §111.15）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigScope {
    BuildTime,
    Runtime,
    Reload,
    Restart,
}

/// 配置值的来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigSourceKind {
    Literal,
    SecretRef,
    DependencyRef,
    EnvironmentRef,
    Generated,
    File,
    AiProposed,
}

/// 配置项定义。**secret = true 时不允许带明文默认值**（见 `validate_config`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ConfigDefinition {
    pub id: String,
    pub application_id: String,
    /// 只对某个服务生效；空 = 应用级。
    pub service_unit_id: Option<String>,
    /// 环境变量名（`DATABASE_URL` 这种）。
    pub key: String,
    pub data_type: ConfigDataType,
    pub required: bool,
    pub secret: bool,
    pub scope: ConfigScope,
    pub source_kind: ConfigSourceKind,
    /// `literal` 的明文值 / `secret_ref` 的 SecretRef id / `dependency_ref` 的
    /// `${dependency.x.y}` 表达式 / `environment_ref` 的 `${env.KEY}`。
    pub source_ref: Option<String>,
    /// 仅非密钥项允许的默认值。
    pub default_value: Option<String>,
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 密钥的存放方式。**只有引用，没有明文。**
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretStoreKind {
    /// 系统 Keyring（`keyring::save_secret` / `read_secret`）。
    Keyring,
    /// 部署时写入的运行时临时文件（部署结束即删除）。
    RuntimeTempFile,
}

/// 密钥引用。
///
/// 设计上**没有** value 字段：明文只可能在 OS Keyring 或部署期的运行时临时文件里，
/// 由 Rust 侧读取，永不跨 IPC（与 `credentials.secret_ref` 同一套原则）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SecretRef {
    pub id: String,
    pub application_id: Option<String>,
    pub name: String,
    pub store_kind: SecretStoreKind,
    /// Keyring 服务名（默认 `ops-workbench`）。
    pub keyring_service: Option<String>,
    /// Keyring 账户名 = `keyring::save_secret` 的 `secret_id`。
    pub keyring_account: Option<String>,
    /// 运行时临时文件路径模板，如 `/run/bls-ops/{env}/{key}.env`。
    /// 只允许 `/run` 与 `/dev/shm` 下的绝对路径。
    pub runtime_path: Option<String>,
    pub description: String,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

// -- 制品 -------------------------------------------------------------------

/// 制品类型（v2 §27）。
///
/// `Tar` / `Dockerfile` 是 P5.1 补的：未压缩 tar 与构建配方（Dockerfile）
/// 在识别阶段是两类不同的输入，不能混进 `TarGz` / `DockerImage`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Folder,
    Zip,
    Tar,
    TarGz,
    Dist,
    Jar,
    Binary,
    DockerImage,
    ComposeFile,
    Dockerfile,
    GitRef,
}

/// 制品来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactSourceKind {
    /// 本机构建产物（上传前）。
    LocalPath,
    /// 服务器上已存在的目录。
    ServerExistingDir,
    /// 镜像仓库。
    DockerRegistry,
    /// Git 引用（commit / tag）。
    GitRef,
}

/// 制品状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactStatus {
    Draft,
    Ready,
    Uploaded,
    Active,
    Archived,
    Failed,
    Missing,
}

/// 制品元数据。
///
/// P5.0 只登记；P5.1 起由导入流程写入 —— `sha256` 是内容指纹，
/// 与 `deployment::artifact::ArtifactImportTask::fingerprint` 是同一个值。
/// 文件一变哈希就对不上，旧的分析结果自动失效
/// （见 `ArtifactFingerprint::differs_from`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactRecord {
    pub id: String,
    pub application_id: String,
    pub service_unit_id: Option<String>,
    pub kind: ArtifactKind,
    pub source_kind: ArtifactSourceKind,
    /// 本地路径 / 远程目录 / 镜像名 / `git:<url>@<sha>`。
    pub source_ref: String,
    pub file_name: Option<String>,
    pub size_bytes: Option<i64>,
    /// 内容指纹（上传前后都要校验）；64 位小写十六进制。
    pub sha256: Option<String>,
    /// Docker 镜像 digest（`sha256:…`）。
    pub docker_digest: Option<String>,
    /// 用户可读的版本标签。
    pub version_label: Option<String>,
    pub built_at: Option<i64>,
    pub checksum_verified: bool,
    pub status: ArtifactStatus,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// -- 计划（图） -------------------------------------------------------------

/// 计划状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Draft,
    Ready,
    Approved,
    Rejected,
    Archived,
}

/// 计划是怎么来的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalSource {
    /// 用户手工编排。
    Manual,
    /// 内置模板（P5.0 只有枚举，没有模板库）。
    Template,
    /// AI 建议（P5.0 不接 AI：写入此值只表示"用户抄了 AI 的建议"）。
    AiProposed,
}

/// 风险级别（v2 §107）。与命令中心的 `RiskLevel` 分开：那里的 `destructive`
/// 是"命令能删东西"，这里的 `critical` 是"部署动作可能丢数据"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

/// 计划节点可以做的事 —— **封闭枚举**。
///
/// 这张清单就是"部署动作字典"：P5.1 的编译器会把每个变体翻译成一个或多个
/// `safe::Capability`；P5.0 只负责把它们编排进图里并校验风险。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanActionKind {
    // 取源与构建
    FetchSource,
    BuildArtifact,
    PackageArtifact,
    // 制品搬运
    UploadArtifact,
    ExtractArtifact,
    PullImage,
    BuildImage,
    PushImage,
    // 配置
    ResolveConfig,
    RenderEnvFile,
    // 依赖
    CheckDependencies,
    DatabaseMigration,
    // 服务编排
    ProvisionService,
    StartService,
    StopService,
    RestartService,
    ComposeUp,
    ComposeDown,
    // 网关与证书
    ApplyNginxSite,
    TestNginxConfig,
    ReloadNginx,
    BindDomain,
    RequestCertificate,
    RenewCertificate,
    // 健康检查
    HttpHealthCheck,
    TcpHealthCheck,
    ContainerHealthCheck,
    // 发布与回滚
    ActivateRelease,
    RestoreRelease,
    RestoreNginxBackup,
}

impl PlanActionKind {
    /// 该动作的默认风险级别。生产环境还会在此基础上叠加审批要求。
    pub fn default_risk(self) -> RiskLevel {
        use PlanActionKind::*;
        match self {
            // 只读：检查与探测。
            CheckDependencies | TestNginxConfig | HttpHealthCheck | TcpHealthCheck
            | ContainerHealthCheck => RiskLevel::Low,
            // 只影响本项目目录 / 本应用明文配置。
            FetchSource | BuildArtifact | PackageArtifact | UploadArtifact | ExtractArtifact
            | ResolveConfig | RenderEnvFile | PullImage | BuildImage => RiskLevel::Low,
            // 会改变服务运行状态或网关行为。
            ProvisionService | StartService | StopService | RestartService | ComposeUp
            | ComposeDown | ApplyNginxSite | ReloadNginx | ActivateRelease | RestoreRelease
            | RestoreNginxBackup | BindDomain => RiskLevel::Medium,
            // 影响外部系统或证书签发。
            PushImage | RequestCertificate | RenewCertificate => RiskLevel::High,
            // 动数据库。
            DatabaseMigration => RiskLevel::High,
        }
    }

    /// 数据库迁移永远是独立节点，且默认必须审批（v2 §48/§50）。
    pub fn requires_approval(self) -> bool {
        matches!(
            self,
            PlanActionKind::DatabaseMigration
                | PlanActionKind::PushImage
                | PlanActionKind::RestoreRelease
                | PlanActionKind::RestoreNginxBackup
        )
    }

    /// 该动作是否可逆（决定后续阶段能否自动回滚）。
    pub fn is_reversible(self) -> bool {
        use PlanActionKind::*;
        matches!(
            self,
            ApplyNginxSite
                | ReloadNginx
                | ActivateRelease
                | RestoreRelease
                | RestoreNginxBackup
                | StartService
                | StopService
                | RestartService
                | ComposeUp
                | ComposeDown
                | BindDomain
                | RenderEnvFile
                | ResolveConfig
        )
    }
}

/// 计划节点。
///
/// `params_json` 是给 P5.1 编译器用的**结构化**参数（JSON 对象），保存前必须过
/// `validate_params_json` —— 禁 `command`/`cmd`/`shell`/`script`/`exec` 键，
/// 且递归拒绝任何含 shell 元字符的字符串值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PlanNode {
    pub id: String,
    pub plan_id: String,
    /// 图内唯一标识（`[a-z0-9_]{1,64}`），边按它连。
    pub node_key: String,
    pub title: String,
    pub action: PlanActionKind,
    /// 该节点作用于哪个服务（可空：全局节点，如迁移、网关）。
    pub service_unit_id: Option<String>,
    pub risk_level: RiskLevel,
    pub approval_required: bool,
    /// 用户可跳过（v2 §111.3）。
    pub skippable: bool,
    /// 结构化参数（JSON 对象）。P5.0 不解释它，只做安全校验。
    pub params_json: String,
    /// 展示顺序。
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 边条件（v2 §54）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeCondition {
    Always,
    OnSuccess,
    OnFailure,
    Manual,
}

/// 计划里的一条有向边。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PlanEdge {
    pub id: String,
    pub plan_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub condition: EdgeCondition,
    pub created_at: i64,
}

/// 部署计划（图，v2 §28/§29）。**不是固定步骤列表。**
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentPlan {
    pub id: String,
    pub application_id: String,
    pub environment_id: String,
    pub name: String,
    /// 计划版本。任何一次图结构变更都递增（v2 §111.26/27）。
    pub version: i64,
    pub status: PlanStatus,
    pub proposal_source: ProposalSource,
    pub risk_level: RiskLevel,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 计划 + 图（一次读全，供 UI 画图与编译期校验）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentPlanGraph {
    pub plan: DeploymentPlan,
    pub nodes: Vec<PlanNode>,
    pub edges: Vec<PlanEdge>,
}

// -- 运行与版本 -------------------------------------------------------------

/// 运行状态机（P5.0 只有模型：**没有任何执行入口**，P5.1 才写状态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Pending,
    Running,
    Paused,
    Succeeded,
    Failed,
    Cancelled,
    RolledBack,
}

/// 一次运行是谁触发的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunTrigger {
    Manual,
    Retry,
    Rollback,
    Schedule,
}

/// 一次部署运行的记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentRun {
    pub id: String,
    pub plan_id: String,
    pub application_id: String,
    pub environment_id: String,
    pub server_id: String,
    pub server_name: String,
    pub status: RunStatus,
    pub trigger_source: RunTrigger,
    /// 使用的计划版本 —— 计划之后被改过也解释得清（v2 §111.27）。
    pub plan_version: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub log: String,
    pub error_message: Option<String>,
    /// 部署快照（v2 §85）：P5.0 只预留字段，绝不写假数据。
    pub snapshot_json: Option<String>,
    pub release_id: Option<String>,
    pub created_at: i64,
}

/// 运行里的一个节点执行记录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunNodeStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RunNode {
    pub id: String,
    pub run_id: String,
    /// 对应计划节点；计划被改过导致找不到时为空，但 `node_key` 仍保留。
    pub node_id: Option<String>,
    pub node_key: String,
    pub title: String,
    /// 类型化动作标识（`ActionKind::as_str`）。P5.0 只读阶段为空串，
    /// P5.3 起由引擎写入 —— 历史运行也能复核"当时执行的是哪个动作"。
    pub action: String,
    /// 动作的风险级别（审批与展示用）。
    pub risk_level: RiskLevel,
    pub status: RunNodeStatus,
    /// 第几次尝试（重试可追踪）。
    pub attempt: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub exit_code: Option<i64>,
    pub output: String,
    pub error_message: Option<String>,
    pub created_at: i64,
}

/// 版本状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseStatus {
    /// 当前生效版本。
    Active,
    /// 被更新的版本取代。
    Superseded,
    /// 已经回滚掉。
    RolledBack,
    Failed,
}

/// 一次发布（制品 + 配置 + 网关快照的组合，v2 §61/§85/§87）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ReleaseRecord {
    pub id: String,
    pub application_id: String,
    pub environment_id: String,
    pub service_unit_id: Option<String>,
    pub run_id: Option<String>,
    pub version_label: String,
    pub artifact_id: Option<String>,
    /// 是否当前生效版本。
    pub is_active: bool,
    pub activated_at: Option<i64>,
    /// 被它替换掉的版本 —— 回滚目标（可空 = 首次发布）。
    pub replaced_release_id: Option<String>,
    /// Nginx 配置备份路径（`nginx::backup_config` 产物）。
    pub nginx_backup_path: Option<String>,
    pub image_digest: Option<String>,
    pub config_snapshot_json: Option<String>,
    pub status: ReleaseStatus,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 一次运行 + 它的节点明细（详情视图一次读全）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentRunDetail {
    pub run: DeploymentRun,
    pub nodes: Vec<RunNode>,
}

// -- 删除结果 ---------------------------------------------------------------

/// 级联删除的计数 —— UI 要如实告诉用户删掉了什么。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentCascadeResult {
    pub environments: i64,
    pub services: i64,
    pub relations: i64,
    pub plans: i64,
    pub runs: i64,
    pub releases: i64,
    pub artifacts: i64,
    pub configs: i64,
    pub secrets: i64,
    pub domains: i64,
}
