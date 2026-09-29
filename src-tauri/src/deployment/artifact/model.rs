//! P5.1 制品导入与多服务识别的领域类型。
//!
//! # 三条贯穿全模块的规则
//!
//! 1. **识别结果只能是"结构化建议"**：构建步骤、启动方式都是判别枚举
//!    （[`BuildStep`] / [`StartOption`]），字段是脚本名、目标名、单元名、路径这类
//!    受校验的短标识。**没有任何字段能装下一条自由命令**（与 P5.0 同一条铁律）。
//! 2. **敏感内容只留"存在性"**：命中私钥 / Token / .env / 云凭据时，报告里只有
//!    位置 + 类型 + **掩码证据**（[`RedactedEvidence`]），明文值连本模块都不保留。
//! 3. **未知就说未知**：[`InspectionCheckState`] 有 `Unknown` 一档，证据不足时
//!    必须落在那里，绝不猜成"通过"（沿用 `project_readiness` 的判定伦理）。

use serde::{Deserialize, Serialize};

use super::limits;
use crate::deployment::model::{
    ArtifactKind, ArtifactSourceKind, PortMapping, ServiceKind, ServiceRole, ServiceRuntime,
};
use crate::project_readiness::CheckState;

/// 检查项状态 —— 直接复用项目识别那套词汇（已确认 / 未确认 / 阻塞）。
pub type InspectionCheckState = CheckState;

// -- 导入来源 ---------------------------------------------------------------

/// 用户从哪里把制品交给我们。
///
/// 注意 [`ImportSource::RemoteDirectory`]：**只读**。服务器上已有的目录不需要
/// 上传，我们只做一次只读探测 + 识别。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportSource {
    /// 本地文件夹（会走完整的安全清点 + 指纹）。
    LocalFolder { path: String },
    /// 本地压缩包（ZIP / TAR / TAR.GZ）。
    LocalArchive { path: String },
    /// 本地单个文件（JAR / 二进制 / Dockerfile / Compose / 前端 dist 目录以外的产物）。
    LocalFile {
        path: String,
        artifact_kind: ArtifactKind,
    },
    /// 镜像引用（不搬运，只登记 digest/引用）。
    DockerImageRef { reference: String },
    /// 服务器上已有目录（只读探测）。
    RemoteDirectory { server_id: String, path: String },
}

impl ImportSource {
    /// 制品记录里的 `source_ref`。
    ///
    /// **同一次导入产出的所有制品共用同一个值** —— 确认导入就是这么写的，
    /// 所以它是"制品 ↔ 产生它的识别结果"之间唯一可靠的连接键
    /// （见 `deployment::proposal::facts::derive_service_facts`）。
    pub fn source_ref(&self) -> &str {
        match self {
            ImportSource::LocalFolder { path }
            | ImportSource::LocalArchive { path }
            | ImportSource::LocalFile { path, .. }
            | ImportSource::RemoteDirectory { path, .. } => path,
            ImportSource::DockerImageRef { reference } => reference,
        }
    }

    /// 展示用的短名（不参与任何命令生成）。
    pub fn display_name(&self) -> String {
        match self {
            ImportSource::LocalFolder { path } => leaf(path),
            ImportSource::LocalArchive { path } => leaf(path),
            ImportSource::LocalFile { path, .. } => leaf(path),
            ImportSource::DockerImageRef { reference } => reference.clone(),
            ImportSource::RemoteDirectory { path, .. } => leaf(path),
        }
    }

    /// 是否需要在本地读取内容（做哈希 / 安全扫描 / 识别）。
    pub fn is_local(&self) -> bool {
        matches!(
            self,
            ImportSource::LocalFolder { .. }
                | ImportSource::LocalArchive { .. }
                | ImportSource::LocalFile { .. }
        )
    }
}

fn leaf(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

// -- 任务 -------------------------------------------------------------------

/// 导入流程的阶段（与用户确认过的流程一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportStage {
    /// 排队中（还没开始读一个字节）。
    Queued,
    /// 计算 SHA-256。
    Hashing,
    /// 安全扫描（ZIP Slip / 符号链接 / 压缩炸弹 / 敏感内容）。
    SecurityScan,
    /// 技术栈与构建/启动信息识别。
    Inspecting,
    /// 识别结果就绪，等用户确认。
    AwaitingConfirmation,
    /// 上传中（`.part` → 校验 → 原子改名）。
    Uploading,
    /// 已保存为 ArtifactRecord。
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

/// 进度快照（事件里推给前端的就是它）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ImportProgress {
    pub stage: ImportStage,
    pub status: ImportStatus,
    /// 已处理字节 / 总字节（未知时 total = 0）。
    pub processed_bytes: u64,
    pub total_bytes: u64,
    /// 已处理条目 / 总条目。
    pub processed_entries: u64,
    pub total_entries: u64,
    /// 0-100；未知总量时按条目数估算，仍未知就给 0。
    pub percent: u8,
}

impl ImportProgress {
    pub fn queued() -> Self {
        Self {
            stage: ImportStage::Queued,
            status: ImportStatus::Pending,
            processed_bytes: 0,
            total_bytes: 0,
            processed_entries: 0,
            total_entries: 0,
            percent: 0,
        }
    }

    /// 重新计算百分比（两条进度轴取更靠前的那个，避免长时间停在 0%）。
    pub fn recompute(&mut self) {
        let by_bytes = if self.total_bytes > 0 {
            (self.processed_bytes.saturating_mul(100) / self.total_bytes) as u64
        } else {
            0
        };
        let by_entries = if self.total_entries > 0 {
            self.processed_entries.saturating_mul(100) / self.total_entries
        } else {
            0
        };
        self.percent = by_bytes.max(by_entries).min(100) as u8;
    }
}

/// 一次导入任务。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactImportTask {
    pub id: String,
    pub application_id: Option<String>,
    /// 目标服务；空 = 用户还没决定（多服务识别结果出来后由用户勾选）。
    pub service_unit_id: Option<String>,
    pub source: ImportSource,
    pub display_name: String,
    pub stage: ImportStage,
    pub status: ImportStatus,
    pub progress: ImportProgress,
    /// 内容指纹（哈希完成后才有）。
    pub fingerprint: Option<ArtifactFingerprint>,
    /// 安全扫描报告（先于识别产出）。
    pub security: Option<SecurityScanReport>,
    /// 识别结果。
    pub inspection: Option<ArtifactInspection>,
    pub error: Option<String>,
    /// 是否可取消（已进入上传阶段就不允许半途丢下 `.part`——见 `remote.rs`）。
    pub can_cancel: bool,
    pub attempt: u32,
    pub created_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
    /// 确认后落库的 ArtifactRecord id。
    pub artifact_id: Option<String>,
}

impl ArtifactImportTask {
    pub fn new(id: String, source: ImportSource, application_id: Option<String>, now: i64) -> Self {
        let display_name = source.display_name();
        Self {
            id,
            application_id,
            service_unit_id: None,
            source,
            display_name,
            stage: ImportStage::Queued,
            status: ImportStatus::Pending,
            progress: ImportProgress::queued(),
            fingerprint: None,
            security: None,
            inspection: None,
            error: None,
            can_cancel: true,
            attempt: 1,
            created_at: now,
            updated_at: now,
            finished_at: None,
            artifact_id: None,
        }
    }

    /// 结果是否可确认：安全扫描没有阻断项，且识别结果已就绪。
    pub fn is_confirmable(&self) -> bool {
        matches!(self.stage, ImportStage::AwaitingConfirmation)
            && self
                .security
                .as_ref()
                .is_none_or(|report| !report.blocks_import())
    }
}

// -- 指纹 -------------------------------------------------------------------

/// 指纹"哈希的是什么" —— 必须如实标注，不能让用户以为任何来源都做了全内容哈希。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FingerprintBasis {
    /// 单个文件的字节（zip / jar / 二进制 / Dockerfile）。
    FileBytes,
    /// 压缩包文件本身的字节。
    ArchiveBytes,
    /// 目录清单（路径 + 大小 + 每个文件的 SHA-256）。
    DirectoryManifest,
    /// 镜像引用字符串（未查 registry，digest 尚未确认）。
    ImageReference,
    /// 服务器目录的只读清单（路径 + 大小，不含内容）。
    RemoteListing,
}

/// 内容指纹 —— ArtifactRecord 与它绑定，文件一变分析立即失效。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactFingerprint {
    pub sha256: String,
    pub size_bytes: u64,
    pub entry_count: u64,
    /// 目录来源才有（归档没有 mtime 语义）。
    pub newest_mtime_ms: Option<i64>,
    pub computed_at: i64,
    /// 固定 "sha256"，留给以后的算法迁移。
    pub algorithm: String,
    /// 哈希口径（见 [`FingerprintBasis`]）。
    pub basis: FingerprintBasis,
}

impl ArtifactFingerprint {
    /// 与另一份指纹是否表示**不同内容**。
    ///
    /// 只比哈希与体积：mtime 变化但内容相同（重新打包、重新 checkout）**不算**
    /// 变化 —— 否则每次 `git checkout` 都会让分析白跑一遍。
    pub fn differs_from(&self, other: &ArtifactFingerprint) -> bool {
        self.sha256 != other.sha256 || self.size_bytes != other.size_bytes
    }
}

// -- 安全报告 ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    /// 提示（例如"包里带了 .env.example"）。
    Info,
    Low,
    Medium,
    High,
    /// 阻断：绝不能导入（ZIP Slip、符号链接逃逸、压缩炸弹…）。
    Critical,
}

/// 发现类型 —— 每一项都对应一条具体的检查（谁改这里都要同时改测试）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingKind {
    // 结构类（全部 Critical）
    ZipSlip,
    AbsolutePath,
    ParentTraversal,
    Symlink,
    Hardlink,
    DeviceEntry,
    EncryptedEntry,
    // 体积类
    EntryCountLimit,
    FileSizeLimit,
    TotalSizeLimit,
    CompressionRatioLimit,
    DepthLimit,
    PathLengthLimit,
    // 内容类
    PrivateKey,
    AccessToken,
    CredentialFile,
    CloudCredential,
    PackageRegistryToken,
    DockerRegistryAuth,
    // 信息类
    ExecutableBit,
    NestedArchive,
}

impl FindingKind {
    /// 默认严重级别。结构类与体积类就是"导入这件事本身不安全"，一律 Critical。
    pub fn default_severity(self) -> FindingSeverity {
        use FindingKind::*;
        match self {
            ZipSlip
            | AbsolutePath
            | ParentTraversal
            | Symlink
            | Hardlink
            | DeviceEntry
            | EncryptedEntry
            | EntryCountLimit
            | FileSizeLimit
            | TotalSizeLimit
            | CompressionRatioLimit
            | DepthLimit
            | PathLengthLimit => FindingSeverity::Critical,
            PrivateKey | CloudCredential | DockerRegistryAuth => FindingSeverity::High,
            AccessToken | PackageRegistryToken => FindingSeverity::High,
            CredentialFile => FindingSeverity::Medium,
            NestedArchive | ExecutableBit => FindingSeverity::Low,
        }
    }

    /// 是否阻断导入。
    pub fn blocks_import(self) -> bool {
        self.default_severity() == FindingSeverity::Critical
    }
}

/// 掩码后的证据 —— **明文永不出现**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RedactedEvidence {
    /// 例如 `AKIA****（20 字符）`。
    pub preview: String,
    pub length: usize,
    /// 命中的模式名（`aws_access_key_id` / `pem_private_key` …）。
    pub pattern: String,
}

impl RedactedEvidence {
    /// 生成掩码：保留前 4 个字符，其余打码，并给出原文长度。
    ///
    /// 只用前 4 位是为了让用户**能自己核对是哪份凭据**，又不至于泄出可用信息。
    pub fn mask(value: &str, pattern: &str) -> Self {
        let visible: String = value.chars().take(4).collect();
        let length = value.chars().count();
        let masked = if length > 4 {
            "*".repeat(8)
        } else {
            String::new()
        };
        Self {
            preview: format!("{visible}{masked}（{length} 字符）"),
            length,
            pattern: pattern.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SecurityFinding {
    pub kind: FindingKind,
    pub severity: FindingSeverity,
    /// 相对路径或条目名（路径本身不是秘密）。
    pub location: String,
    /// 人话解释 —— UI 直接展示。
    pub detail: String,
    /// 掩码证据（结构性发现没有证据）。
    pub evidence: Option<RedactedEvidence>,
    /// 该发现是否阻断导入。
    pub blocking: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SecurityScanReport {
    pub findings: Vec<SecurityFinding>,
    pub entries_checked: u64,
    pub files_scanned: u64,
    pub bytes_scanned: u64,
    /// 到达扫描预算提前结束 —— **如实标注**，不说"已扫完"。
    pub truncated: bool,
}

impl SecurityScanReport {
    pub fn empty() -> Self {
        Self {
            findings: Vec::new(),
            entries_checked: 0,
            files_scanned: 0,
            bytes_scanned: 0,
            truncated: false,
        }
    }

    pub fn blocks_import(&self) -> bool {
        self.findings.iter().any(|finding| finding.blocking)
    }

    pub fn count_of(&self, severity: FindingSeverity) -> usize {
        self.findings
            .iter()
            .filter(|finding| finding.severity == severity)
            .count()
    }

    /// 最高严重级别（UI 用它决定徽标颜色）。
    pub fn highest_severity(&self) -> Option<FindingSeverity> {
        self.findings.iter().map(|finding| finding.severity).max()
    }
}

// -- 识别结果 ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    Node,
    Java,
    Go,
    Python,
    Rust,
    Php,
    Dotnet,
    Ruby,
    Static,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Maven,
    Gradle,
    Cargo,
    Pip,
    Poetry,
    Composer,
    Bundler,
    Nuget,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct StackProfile {
    pub language: Language,
    pub package_manager: Option<PackageManager>,
    /// 框架名（从依赖里读出来的，如 `next` / `spring-boot`）。
    pub framework: Option<String>,
    /// 命中依据（文件名列表），UI 直接展示"凭什么这么判断"。
    pub markers: Vec<String>,
}

/// 构建步骤 —— **结构化**，字段都是受校验的短标识，没有命令字符串。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BuildStep {
    /// `npm run <script>`（script 名来自 package.json 的 scripts 键）。
    NpmScript {
        manager: PackageManager,
        script: String,
    },
    /// Maven 目标（来自 pom.xml 的 `<goal>` 或惯用目标）。
    Maven {
        goals: Vec<String>,
        wrapper: bool,
    },
    Gradle {
        tasks: Vec<String>,
        wrapper: bool,
    },
    Cargo {
        release: bool,
        target: Option<String>,
    },
    GoBuild {
        package: String,
        output: Option<String>,
    },
    PythonVenv {
        requirements: String,
    },
    Composer {
        script: Option<String>,
    },
    /// 有 Dockerfile：构建交给镜像，不在服务器上跑语言工具链。
    DockerBuild {
        dockerfile: String,
        context: String,
    },
    /// 无需构建（制品已经是可运行产物）。
    None,
}

/// 启动方式建议 —— 与 P5.0 的 `ServiceRuntime` 一一对应，确认时直接映射。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StartOption {
    StaticSite {
        root: String,
    },
    SystemdUnit {
        unit: String,
    },
    Jar {
        jar: String,
    },
    Node {
        entry: String,
        manager: PackageManager,
    },
    Python {
        entry: String,
        module: bool,
    },
    Binary {
        entry: String,
    },
    NginxSite {
        site_name: String,
        root: String,
    },
    DockerImage {
        image: String,
        tag: String,
        ports: Vec<PortMapping>,
    },
    DockerCompose {
        compose_path: String,
        project_hint: String,
        services: Vec<String>,
    },
    External {
        endpoint_hint: String,
    },
}

/// 端口猜测（带依据）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PortGuess {
    pub port: u16,
    pub protocol: String,
    /// 依据（`Dockerfile EXPOSE 3000` / `package.json scripts.start --port=3000`）。
    pub evidence: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthKind {
    Http,
    Tcp,
    Container,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct HealthGuess {
    pub kind: HealthKind,
    /// HTTP 路径（`/health`）或端口（`3000`）。
    pub target: String,
    pub evidence: String,
}

/// 环境变量**名字**。值永远不进模型 —— 这里连字段都没有。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EnvKeyGuess {
    pub key: String,
    pub required: bool,
    /// 名字像密钥（`*_SECRET` / `*_TOKEN` / `*_PASSWORD` / `*_API_KEY`）。
    pub secret_like: bool,
    pub evidence: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyKind {
    Database,
    Cache,
    Queue,
    Search,
    ObjectStorage,
    Mail,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DependencyGuess {
    pub name: String,
    pub kind: DependencyKind,
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct InspectionCheck {
    pub id: String,
    pub label: String,
    pub state: InspectionCheckState,
    pub detail: String,
}

/// 一个"可部署服务"的候选 —— 多服务项目的核心产物。
///
/// 用户勾选若干候选 → 每个候选独立创建一个 ServiceUnit + 一个 ArtifactRecord
/// （制品就落在 `source_path` 这个子目录里），这就是"一个应用多个服务、每个服务
/// 独立制品"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ServiceCandidate {
    /// 稳定 id：`<source_path>` 的规范化形式，便于重复导入时去重。
    pub id: String,
    pub name: String,
    pub role: ServiceRole,
    pub service_kind: ServiceKind,
    /// 直接可保存的运行时建议。
    pub runtime: ServiceRuntime,
    pub artifact_kind: ArtifactKind,
    /// 制品在包内的相对目录（空 = 包根）。
    pub source_path: String,
    pub ports: Vec<PortMapping>,
    pub env_keys: Vec<String>,
    pub dependencies: Vec<String>,
    pub health: Vec<HealthGuess>,
    /// 置信度 0-100（只用证据算，不做"感觉很准"）。
    pub confidence: u8,
    pub evidence: Vec<String>,
    pub selected_by_default: bool,
}

/// 识别结果（UI 的"识别结果"页就是渲染它）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactInspection {
    pub artifact_kind: ArtifactKind,
    pub source_kind: ArtifactSourceKind,
    pub stack: StackProfile,
    pub build: Vec<BuildStep>,
    pub start: Vec<StartOption>,
    pub ports: Vec<PortGuess>,
    pub health: Vec<HealthGuess>,
    pub env_keys: Vec<EnvKeyGuess>,
    pub dependencies: Vec<DependencyGuess>,
    /// 多服务候选（≥1；单服务项目也只有一个候选）。
    pub services: Vec<ServiceCandidate>,
    pub checks: Vec<InspectionCheck>,
    pub open_questions: Vec<String>,
    /// 实际看到了多少个文件（识别覆盖范围，如实展示）。
    pub files_seen: u64,
    /// 识别达到预算提前结束。
    pub truncated: bool,
    pub inspected_at: i64,
}

impl ArtifactInspection {
    /// 有阻塞项 → 不允许确认（与 `project_readiness` 同一伦理）。
    pub fn is_blocked(&self) -> bool {
        self.checks
            .iter()
            .any(|check| check.state == InspectionCheckState::Blocked)
    }
}

/// 上限常量导出给前端展示（"为什么拒绝"要说得清）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactLimits {
    pub max_entries: u64,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_compression_ratio: u64,
    pub max_depth: u64,
    pub max_service_candidates: u64,
}

impl ArtifactLimits {
    pub fn current() -> Self {
        Self {
            max_entries: limits::MAX_ENTRIES as u64,
            max_file_bytes: limits::MAX_FILE_BYTES,
            max_total_bytes: limits::MAX_TOTAL_UNCOMPRESSED_BYTES,
            max_compression_ratio: limits::MAX_COMPRESSION_RATIO,
            max_depth: limits::MAX_DEPTH as u64,
            max_service_candidates: limits::MAX_SERVICE_CANDIDATES as u64,
        }
    }
}

/// 确认导入时要保存的东西（用户在前端勾选后回传）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactImportConfirmation {
    pub task_id: String,
    pub application_id: String,
    /// 目标环境：服务目录必须落在它的 `deploy_root` 内，确认时用数据库里的
    /// `deploy_root` 把候选的相对路径补成绝对路径。
    pub environment_id: String,
    /// 勾选的服务候选 id；空 = 只保存制品、不建服务。
    pub selected_service_ids: Vec<String>,
    /// 用户可覆盖版本标签（默认取指纹前 12 位）。
    pub version_label: Option<String>,
}

/// 确认导入的结果：**一个应用下多个服务，每个服务一个独立制品**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactConfirmOutcome {
    pub artifacts: Vec<crate::deployment::model::ArtifactRecord>,
    pub services: Vec<crate::deployment::model::ServiceUnit>,
}
