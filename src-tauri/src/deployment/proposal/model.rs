//! P5.2 部署方案的领域类型。
//!
//! # 三种"真话"分开装
//!
//! * [`EvidenceClass`] —— 这条结论是**事实 / 推断 / 建议 / 未知**里的哪一种；
//! * [`EvidenceSource`] —— **谁说的**（服务器实时事实 / 制品 / 用户 / 平台策略 /
//!   知识库 / AI / 规则推导）；
//! * [`UnknownSeverity`] —— 这个"不知道"到底挡不挡事。
//!
//! UI 必须把这三样都显示出来。把推断写进事实、把建议写成结论，
//! 是这类"智能方案"最常见的失信方式。

use serde::{Deserialize, Serialize};

use crate::deployment::model::{
    ArtifactKind, FailurePolicy, PlanEdge, PlanNode, PortMapping, RiskLevel, ServiceKind,
    ServiceRelationKind, ServiceRole, ServiceRuntime, SslMode,
};
use crate::project_readiness::CheckState;

// -- 证据 -------------------------------------------------------------------

/// 结论的等级。**任何一条"关键结论"都必须落在其中一档**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceClass {
    /// 观测到的事实（服务器探测 / 制品识别 / 用户明确填写）。
    Fact,
    /// 由事实推导出来的（规则引擎算的，可能错，且说得出怎么算的）。
    Inference,
    /// 我们的建议（含偏好，用户可以不采纳）。
    Recommendation,
    /// 不知道（必须配一条 [`Unknown`]）。
    Unknown,
}

impl EvidenceClass {
    /// 事实优先：排序时事实在最前，未知在最后。
    pub fn rank(self) -> u8 {
        match self {
            EvidenceClass::Fact => 0,
            EvidenceClass::Inference => 1,
            EvidenceClass::Recommendation => 2,
            EvidenceClass::Unknown => 3,
        }
    }
}

/// 证据来源。**"谁说的"决定它能不能被覆盖**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvidenceSource {
    /// 服务器实时事实（能力探测、采集到的现状）。**优先级最高**。
    ServerFact {
        /// 取自能力图谱的哪个字段（如 `deployment.docker`）。
        field: String,
    },
    /// 制品识别事实（导入阶段产出的结论）。
    ArtifactFact { path: String },
    /// 用户填写的问卷。
    UserInput { field: String },
    /// 平台 / 安全策略（不可被知识库或 AI 覆盖）。
    Platform { policy: String },
    /// 知识库条目。
    Knowledge { entry_id: String, version: String },
    /// AI 增强（只可能是 `Inference` / `Recommendation`）。
    Ai {
        model: String,
        prompt_version: String,
    },
    /// 规则引擎推导。
    Derived { rule: String },
}

/// 一条证据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Evidence {
    pub class: EvidenceClass,
    pub source: EvidenceSource,
    /// 给人看的说明（英文，前端自行翻译已知取值）。
    pub detail: String,
    /// 可回溯的引用（知识库条目 id / 制品内路径 / 能力字段）。
    pub reference: Option<String>,
}

impl Evidence {
    pub fn fact(source: EvidenceSource, detail: impl Into<String>) -> Self {
        Self {
            class: EvidenceClass::Fact,
            source,
            detail: detail.into(),
            reference: None,
        }
    }

    pub fn derived(rule: &str, detail: impl Into<String>) -> Self {
        Self {
            class: EvidenceClass::Inference,
            source: EvidenceSource::Derived {
                rule: rule.to_string(),
            },
            detail: detail.into(),
            reference: None,
        }
    }

    pub fn knowledge(entry_id: &str, version: &str, detail: impl Into<String>) -> Self {
        Self {
            class: EvidenceClass::Inference,
            source: EvidenceSource::Knowledge {
                entry_id: entry_id.to_string(),
                version: version.to_string(),
            },
            detail: detail.into(),
            reference: Some(entry_id.to_string()),
        }
    }

    pub fn with_reference(mut self, reference: impl Into<String>) -> Self {
        self.reference = Some(reference.into());
        self
    }
}

/// 一条结论在方案里的分量。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementImpact {
    Info,
    /// 影响某个决定（用户要能看到）。
    Decision,
    /// 不解决就不能往下走。
    Blocking,
}

/// 一条带证据的结论。方案里所有"关键结论"都用它表达。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Statement {
    pub id: String,
    pub text: String,
    pub class: EvidenceClass,
    /// 0–100。**事实永远是 100**，推断按证据数量给，建议给 60 上下。
    pub confidence: u8,
    pub impact: StatementImpact,
    pub evidence: Vec<Evidence>,
}

impl Statement {
    pub fn fact(id: &str, text: impl Into<String>, evidence: Vec<Evidence>) -> Self {
        Self {
            id: id.to_string(),
            text: text.into(),
            class: EvidenceClass::Fact,
            confidence: 100,
            impact: StatementImpact::Info,
            evidence,
        }
    }

    pub fn inference(id: &str, text: impl Into<String>, evidence: Vec<Evidence>) -> Self {
        Self {
            id: id.to_string(),
            text: text.into(),
            class: EvidenceClass::Inference,
            confidence: 75,
            impact: StatementImpact::Decision,
            evidence,
        }
    }

    pub fn recommendation(id: &str, text: impl Into<String>, evidence: Vec<Evidence>) -> Self {
        Self {
            id: id.to_string(),
            text: text.into(),
            class: EvidenceClass::Recommendation,
            confidence: 60,
            impact: StatementImpact::Info,
            evidence,
        }
    }

    pub fn unknown(id: &str, text: impl Into<String>, evidence: Vec<Evidence>) -> Self {
        Self {
            id: id.to_string(),
            text: text.into(),
            class: EvidenceClass::Unknown,
            confidence: 0,
            impact: StatementImpact::Decision,
            evidence,
        }
    }

    pub fn with_impact(mut self, impact: StatementImpact) -> Self {
        self.impact = impact;
        self
    }

    pub fn with_confidence(mut self, confidence: u8) -> Self {
        self.confidence = confidence.min(100);
        self
    }
}

// -- 假设与未知 -------------------------------------------------------------

/// 一条假设。`if_wrong` 是"假设不成立会怎样" —— 必须写，否则假设就是甩锅。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Assumption {
    pub id: String,
    pub statement: String,
    pub class: EvidenceClass,
    pub evidence: Vec<Evidence>,
    /// 假设不成立时方案会怎样（例如"内存会不够，需要加 swap 或升配"）。
    pub if_wrong: String,
}

/// "不知道"的严重程度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownSeverity {
    /// 只是信息缺口，不妨碍生成计划。
    Info,
    /// 计划可以生成，但**不允许批准**（例如硬件是否够用没核对）。
    BlocksApproval,
    /// 连计划都不该生成（例如生产环境没填容量问卷）。
    BlocksPlan,
}

/// 一个必须问用户的问题。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Unknown {
    pub id: String,
    pub question: String,
    pub why_it_matters: String,
    pub severity: UnknownSeverity,
    /// 建议的默认值（用户答不上来时的起点）。**必须标成建议**。
    pub suggested_default: Option<String>,
    pub evidence: Vec<Evidence>,
}

impl Unknown {
    pub fn blocking(id: &str, question: impl Into<String>, why: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            question: question.into(),
            why_it_matters: why.into(),
            severity: UnknownSeverity::BlocksPlan,
            suggested_default: None,
            evidence: Vec::new(),
        }
    }

    pub fn approval(id: &str, question: impl Into<String>, why: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            question: question.into(),
            why_it_matters: why.into(),
            severity: UnknownSeverity::BlocksApproval,
            suggested_default: None,
            evidence: Vec::new(),
        }
    }

    pub fn info(id: &str, question: impl Into<String>, why: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            question: question.into(),
            why_it_matters: why.into(),
            severity: UnknownSeverity::Info,
            suggested_default: None,
            evidence: Vec::new(),
        }
    }

    pub fn suggest(mut self, value: impl Into<String>) -> Self {
        self.suggested_default = Some(value.into());
        self
    }
}

// -- 拓扑 -------------------------------------------------------------------

/// 部署形态（拓扑）。**封闭枚举**：新增形态必须同时补规则、知识库与测试。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TopologyKind {
    /// Nginx 静态托管（纯前端 / 静态站点）。
    StaticNginx,
    /// systemd 托管的长驻进程（JAR / Node / Python / 二进制）。
    SystemdProcesses,
    /// 服务器上 compose up 拉起整组服务。
    DockerCompose,
    /// 单个容器（每个服务一个容器）。
    DockerImages,
    /// 混合：静态交给 Nginx、进程交给 systemd、容器交给 Docker（网关在前）。
    HybridGateway,
}

impl TopologyKind {
    /// 形态复杂度（1–5）：决定"能简单就简单"的偏好。
    pub fn complexity(self) -> u8 {
        match self {
            TopologyKind::StaticNginx => 1,
            TopologyKind::SystemdProcesses => 2,
            TopologyKind::DockerCompose => 3,
            TopologyKind::DockerImages => 4,
            TopologyKind::HybridGateway => 5,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            TopologyKind::StaticNginx => "Static site behind Nginx",
            TopologyKind::SystemdProcesses => "Long-running processes under systemd",
            TopologyKind::DockerCompose => "Docker Compose stack",
            TopologyKind::DockerImages => "One container per service",
            TopologyKind::HybridGateway => "Hybrid: Nginx + systemd + containers",
        }
    }
}

/// 一种拓扑的评估结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TopologyOption {
    pub id: String,
    pub kind: TopologyKind,
    pub name: String,
    pub description: String,
    pub pros: Vec<String>,
    pub cons: Vec<String>,
    pub complexity: u8,
    /// 月成本估算（只填得出来的话）。
    pub monthly_cost_hint: Option<f64>,
    /// 是否满足全部硬约束（能力齐全 / 策略允许 / 容量够）。
    pub feasible: bool,
    /// 不可行的原因（可行时为空）。
    pub blockers: Vec<String>,
    /// 覆盖到哪些服务（服务名，按名字排序）。
    pub service_names: Vec<String>,
    pub evidence: Vec<Evidence>,
}

/// 推荐 + 备选。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TopologyPlan {
    pub recommended: TopologyOption,
    /// 备选（按可行性、复杂度排序）。**必须至少给一条**（除非只有一种形态可用）。
    pub alternatives: Vec<TopologyOption>,
    /// 选择推荐项的理由（逐条带证据）。
    pub rationale: Vec<Statement>,
}

// -- 服务与依赖 -------------------------------------------------------------

/// 资源估算。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ResourceEstimate {
    pub cpu_cores: f64,
    pub memory_mb: i64,
    pub disk_mb: i64,
    /// 这个数字是算出来的还是抄用户的。
    pub basis: EvidenceClass,
    pub evidence: Vec<Evidence>,
}

/// 健康检查计划（**只描述"检查什么"，不描述怎么跑命令**）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct HealthCheckPlan {
    /// `http` | `tcp` | `container`
    pub kind: String,
    pub target: String,
    pub interval_seconds: u32,
    pub timeout_seconds: u32,
    pub failure_threshold: u32,
    pub evidence: Vec<Evidence>,
}

/// 方案里的一个服务（由 P5.0 的 [`crate::deployment::model::ServiceUnit`] 派生）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposedService {
    pub service_unit_id: String,
    pub name: String,
    pub role: ServiceRole,
    pub service_kind: ServiceKind,
    /// 运行方式（结构化；确认时原样写回 `service_units.runtime`）。
    pub runtime: ServiceRuntime,
    pub artifact_id: Option<String>,
    pub artifact_kind: Option<ArtifactKind>,
    pub deploy_path: Option<String>,
    pub ports: Vec<PortMapping>,
    pub health_check: Option<HealthCheckPlan>,
    /// 环境变量**名**（值永远不在模型里）。
    pub env_keys: Vec<String>,
    pub resource_estimate: ResourceEstimate,
    pub evidence: Vec<Evidence>,
}

/// 依赖（服务之间或服务对外部组件）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposedDependency {
    pub id: String,
    /// 依赖方（服务名）。
    pub from_service: String,
    /// 被依赖方（服务名 / 外部组件名）。
    pub to_service: String,
    pub relation_kind: ServiceRelationKind,
    pub required: bool,
    pub failure_policy: FailurePolicy,
    pub evidence: Vec<Evidence>,
}

/// 域名绑定计划。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposedDomain {
    pub domain: String,
    pub service_name: Option<String>,
    pub listen_port: u16,
    pub path_prefix: String,
    pub ssl_mode: SslMode,
    /// 是否需要证书签发节点（acme 且未签发）。
    pub certificate_required: bool,
    pub evidence: Vec<Evidence>,
}

/// 把 [`DomainBinding`] 转成方案里的域名项（保留原始 id 便于回溯）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DomainReference {
    pub binding_id: String,
    pub domain: String,
}

// -- 容量 -------------------------------------------------------------------

/// 容量建议。**每个数字都要能说出怎么来的。**
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CapacityRecommendation {
    /// 峰值 QPS（用户填的，或按假设估算的）。
    pub peak_qps: Option<f64>,
    /// 峰值 QPS 是怎么来的。
    pub peak_qps_basis: EvidenceClass,
    pub concurrent_users: Option<i64>,
    pub vcpu: f64,
    pub memory_mb: i64,
    pub disk_gb: f64,
    pub bandwidth_mbps: Option<f64>,
    /// 预留余量（百分比）。
    pub headroom_percent: u8,
    /// 月成本估算。
    pub monthly_cost_hint: Option<f64>,
    /// 服务器是否装得下（`None` = 没采集到硬件，未核对）。
    pub fits_on_server: Option<bool>,
    pub assumptions: Vec<Assumption>,
    pub unknowns: Vec<Unknown>,
    pub evidence: Vec<Evidence>,
}

// -- 工作流 -----------------------------------------------------------------

/// 工作流（直接复用 P5.0 的图类型，确认时落成 `DeploymentPlanGraph`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposedWorkflow {
    /// **未就绪时必然为空数组**（有单测钉住）。
    pub nodes: Vec<PlanNode>,
    pub edges: Vec<PlanEdge>,
    pub notes: Vec<Statement>,
}

impl ProposedWorkflow {
    pub fn empty() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            notes: Vec::new(),
        }
    }
}

// -- 风险与审批 -------------------------------------------------------------

/// 一条风险。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposedRisk {
    pub id: String,
    pub title: String,
    pub severity: RiskLevel,
    /// 0–100（越高越可能发生）。
    pub likelihood: u8,
    /// 触发条件 / 影响。
    pub impact: String,
    pub mitigation: String,
    /// 不缓解就不允许批准。
    pub blocks_approval: bool,
    pub evidence: Vec<Evidence>,
}

/// 一项必须的人工审批。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposedApproval {
    pub id: String,
    /// 关联的工作流节点 key（空 = 整个方案级审批）。
    pub node_key: Option<String>,
    pub reason: String,
    /// 谁批（角色名，如 `operator` / `owner`）。
    pub required_role: String,
    /// **永远是 `true`**：生产部署一律不允许自动批准。
    pub required: bool,
    pub evidence: Vec<Evidence>,
}

// -- 回滚 -------------------------------------------------------------------

/// 回滚策略。**数据类回滚必须单独说清楚**（迁移通常不可逆）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RollbackStrategy {
    /// 是否可自动回滚。
    pub automatic: bool,
    /// 回滚步骤（带证据的结论）。
    pub steps: Vec<Statement>,
    /// 会恢复到什么（上一版本 / 备份的 Nginx 配置 / 上一个镜像 digest）。
    pub restores: Vec<String>,
    /// 数据侧能不能回滚 —— 说不清就写"不能"，别给人错觉。
    pub data_rollback: Option<String>,
    /// 自动回滚的触发条件。
    pub trigger: Option<String>,
}

// -- 知识库引用与冲突 -------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct KnowledgeReference {
    pub entry_id: String,
    pub title: String,
    pub version: String,
    pub source: String,
    /// 这条知识为什么被用上（匹配到什么）。
    pub applies: String,
    /// 发给模型的片段（已按预算截断）。**必填可空**：方案里只登记"引用了什么"，
    /// 片段本身在这里也留着，便于事后核对"当时给模型看的到底是什么"。
    #[serde(default)]
    pub excerpt: String,
    /// 片段哈希 —— 提示词哈希要覆盖它（片段变了哈希就得变）。
    #[serde(default)]
    pub excerpt_hash: String,
    /// 最后验证时间（过期知识必须被标注，不能当新知识用）。
    #[serde(default)]
    pub last_verified_at: Option<i64>,
    /// 来源：系统内置规则，还是用户维护的知识。
    #[serde(default)]
    pub origin: KnowledgeOrigin,
}

/// 知识的来源层级。
///
/// **用户知识永远不能覆盖系统安全规则**（审批、Secret 保护、路径围栏、
/// 命令限制），因此这个区分必须进模型、进提示词、进审计。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeOrigin {
    #[default]
    System,
    User,
}

/// 冲突怎么裁定的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictResolution {
    /// 摆出来给用户看，不替他决定。
    Unresolved,
    /// 服务器实时事实优先。
    ServerFactWins,
    /// 安全策略优先。
    PolicyWins,
    /// 两条知识其实不冲突（适用范围不同），这里说明为什么。
    NotActuallyConflicting,
}

/// 知识库冲突。**绝不静默选一条。**
///
/// `topologies` / `capability` 让"用事实或策略裁定"这件事**可判定**：
/// 冲突若挂在某个需要能力 X 的形态上，而服务器事实说 X 没装，
/// 就能给出确定性的 `ServerFactWins`，不用含糊其辞。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct KnowledgeConflict {
    pub topic: String,
    pub entries: Vec<String>,
    pub statements: Vec<String>,
    /// 冲突涉及的部署形态（空 = 与形态无关）。
    pub topologies: Vec<TopologyKind>,
    /// 裁定需要看哪个服务器能力（如 `deployment.docker`）。
    pub capability: Option<String>,
    pub resolution: ConflictResolution,
    /// 裁定依据（事实 / 策略）；未裁定时为空。
    pub resolved_by: Vec<Evidence>,
    pub explanation: String,
}

// -- AI ---------------------------------------------------------------------

/// AI 增强的审计记录。**没配置 AI 时这里是 `None`，界面照实说。**
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiReview {
    pub model: String,
    pub prompt_version: String,
    /// 输入提示词的哈希（不存提示词全文：里面可能含用户数据）。
    pub prompt_hash: String,
    /// 被采纳的建议条数。
    pub accepted: usize,
    /// 被拒的建议（含原因）——**不许静默丢弃**。
    pub rejected: Vec<AiRejection>,
    pub notes: Vec<Statement>,
    /// P5.5：这次复核的最终状态（供界面显示"成功/失败/部分被拒"）。
    #[serde(default)]
    pub status: AiReviewStatus,
    /// 实际发起的请求次数（含有限重试）。
    #[serde(default)]
    pub attempts: u32,
    /// 模型调用耗时（毫秒）。失败时是"失败前花了多久"。
    #[serde(default)]
    pub duration_ms: Option<i64>,
    /// 本次发送给模型的知识条目（**方案指纹要能追溯到版本**）。
    #[serde(default)]
    pub knowledge_refs: Vec<KnowledgeReference>,
}

/// AI 复核的状态（与后台任务状态一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiReviewStatus {
    /// 还没跑过复核。
    #[default]
    Idle,
    Queued,
    Running,
    Succeeded,
    /// 请求失败（网络 / 认证 / 超时）——确定性方案不受影响。
    Failed,
    /// 答复全部被安全校验拒绝（模型说了不该说的话）。
    Rejected,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiRejection {
    pub text: String,
    pub reason: String,
    /// 拒绝的分类（界面按类型折叠展示，也便于统计）。
    #[serde(default)]
    pub kind: AiRejectionKind,
}

/// 拒绝原因分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiRejectionKind {
    /// 含 Markdown 代码块。
    Markdown,
    /// 含命令 / 命令替换。
    Command,
    /// 含 shell 元字符组成的片段。
    ShellSymbol,
    /// 内容过长。
    TooLong,
    /// 空内容。
    Empty,
    /// 不是有效 JSON。
    InvalidJson,
    /// 出现了约定的结构里没有的字段。
    UnknownField,
    /// 引用了不存在的知识条目。
    FakeCitation,
    /// 试图修改确定性结论（拓扑 / 容量 / 工作流 / 审批 / 风险）。
    ModificationAttempt,
    /// 请求失败（网络 / 认证 / 超时）。
    ProviderError,
    #[default]
    Other,
}

// -- 校验 -------------------------------------------------------------------

/// 校验发现的类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViolationKind {
    /// 结构不符合 JSON Schema。
    Schema,
    /// 服务器能力不支持（如没装 Docker 却要 compose up）。
    Capability,
    /// 路径越界 / 非法。
    Path,
    /// 密钥泄漏风险。
    Secret,
    /// 权限不足（需要 root 但策略不允许等）。
    Permission,
    /// 风险过高 / 策略要求未满足。
    Risk,
    /// 出现了可执行 shell 片段（**最严重**）。
    Shell,
}

impl ViolationKind {
    /// 不满足时是否连"生成计划"都不该做。
    pub fn blocks_plan(self) -> bool {
        matches!(self, ViolationKind::Shell | ViolationKind::Schema)
    }

    /// 不满足时是否至少不允许批准。
    pub fn blocks_approval(self) -> bool {
        true
    }

    pub fn label(self) -> &'static str {
        match self {
            ViolationKind::Schema => "Schema",
            ViolationKind::Capability => "Capability",
            ViolationKind::Path => "Path",
            ViolationKind::Secret => "Secret",
            ViolationKind::Permission => "Permission",
            ViolationKind::Risk => "Risk",
            ViolationKind::Shell => "Shell",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposalViolation {
    pub id: String,
    pub kind: ViolationKind,
    pub severity: RiskLevel,
    /// 谁报的（`schema` / `capability` / `path` / `secret` / `permission` / `risk` / `ai`）。
    pub source: String,
    pub location: String,
    pub detail: String,
    pub blocks_plan: bool,
    pub blocks_approval: bool,
}

/// 一项校验结论（三态，与项目识别同一套词汇）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposalCheck {
    pub id: String,
    pub label: String,
    pub state: CheckState,
    pub detail: String,
}

/// 校验汇总。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposalValidation {
    pub checks: Vec<ProposalCheck>,
    pub violations: Vec<ProposalViolation>,
}

impl ProposalValidation {
    pub fn empty() -> Self {
        Self {
            checks: Vec::new(),
            violations: Vec::new(),
        }
    }

    pub fn blocks_plan(&self) -> bool {
        self.violations
            .iter()
            .any(|violation| violation.blocks_plan)
    }

    pub fn blocks_approval(&self) -> bool {
        self.violations
            .iter()
            .any(|violation| violation.blocks_approval)
    }

    /// 合并另一份校验结论（去重按 id）。
    pub fn merge(&mut self, other: ProposalValidation) {
        self.checks.extend(other.checks);
        for violation in other.violations {
            if !self
                .violations
                .iter()
                .any(|existing| existing.id == violation.id)
            {
                self.violations.push(violation);
            }
        }
    }
}

// -- 可复现与审计 -----------------------------------------------------------

/// 方案指纹 —— 审计的全部依据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposalFingerprint {
    pub engine_version: String,
    pub schema_version: String,
    /// AI 模型名；未启用时为空。
    pub model: Option<String>,
    pub prompt_version: String,
    /// 本次 AI 复核的提示词哈希（含知识条目 id/版本/片段哈希与输出 Schema 版本）。
    /// 没跑过复核就是 `None` —— 与 `model` 成对出现。
    #[serde(default)]
    pub ai_prompt_hash: Option<String>,
    pub knowledge_version: String,
    /// 输入快照的哈希（同样的输入一定得到同样的值）。
    pub input_hash: String,
    /// 输出哈希（**不含时间戳**，因此两次生成可以逐字节比对）。
    pub output_hash: String,
    pub generated_at: i64,
}

// -- 安全策略 ---------------------------------------------------------------

/// 安全策略。**默认值就是"最保守的那一档"**，用户只能收紧不能放松
/// （`production_requires_approval` / `forbid_secrets_in_artifact` 这类硬约束
/// 在 [`crate::deployment::proposal::checks`] 里不允许被关掉）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SecurityPolicy {
    pub require_health_check: bool,
    pub require_https: bool,
    pub require_backup_for_production: bool,
    /// 制品里出现密钥一律阻断（默认开，**不允许关**）。
    pub forbid_secrets_in_artifact: bool,
    pub allow_root_service: bool,
    /// 生产部署必须人工审批（默认开，**不允许关**）。
    pub production_requires_approval: bool,
    pub require_rollback_plan: bool,
    /// 容量至少留多少余量。
    pub min_headroom_percent: u8,
    /// 允许发布的端口（空 = 不限制）。
    pub allowed_ports: Vec<u16>,
    /// 允许容器以 privileged 运行（默认关）。
    pub allow_privileged_containers: bool,
    pub notes: String,
}

impl Default for SecurityPolicy {
    fn default() -> Self {
        Self {
            require_health_check: true,
            require_https: true,
            require_backup_for_production: true,
            forbid_secrets_in_artifact: true,
            allow_root_service: false,
            production_requires_approval: true,
            require_rollback_plan: true,
            min_headroom_percent: 30,
            allowed_ports: Vec::new(),
            allow_privileged_containers: false,
            notes: String::new(),
        }
    }
}

impl SecurityPolicy {
    /// 把不可放松的硬约束钉回去，并报出被"改松"的字段。
    ///
    /// 这是"AI 不可自动批准生产部署"的第一道机械保障：前端把
    /// `production_requires_approval` 改成 false 也没用。
    pub fn hardened(mut self) -> (Self, Vec<String>) {
        let mut downgraded = Vec::new();
        if !self.production_requires_approval {
            self.production_requires_approval = true;
            downgraded.push("production_requires_approval".to_string());
        }
        if !self.forbid_secrets_in_artifact {
            self.forbid_secrets_in_artifact = true;
            downgraded.push("forbid_secrets_in_artifact".to_string());
        }
        if self.min_headroom_percent < 10 {
            self.min_headroom_percent = 10;
            downgraded.push("min_headroom_percent".to_string());
        }
        if self.allowed_ports.iter().any(|port| *port == 0) {
            self.allowed_ports.retain(|port| *port != 0);
            downgraded.push("allowed_ports".to_string());
        }
        (self, downgraded)
    }
}

// -- 方案本体 ---------------------------------------------------------------

/// 方案状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Draft,
    /// 用户已确认 → 落成 `DeploymentPlanGraph`（**仍未批准**）。
    Confirmed,
    Rejected,
    Superseded,
}

/// 方案摘要。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposalSummary {
    /// 一句话说清"打算怎么做"。
    pub headline: String,
    pub statements: Vec<Statement>,
}

/// 输入快照（**只存哈希与规模，不存密钥类内容**）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct InputSnapshot {
    pub application_id: String,
    pub application_kind: String,
    pub environment_id: Option<String>,
    pub environment_kind: Option<String>,
    pub server_id: String,
    pub service_count: i64,
    pub domain_count: i64,
    pub has_capability_profile: bool,
    pub has_capacity_profile: bool,
    /// 参考用的域名清单（用于回溯"当时规划了哪些域名"）。
    pub domains: Vec<DomainReference>,
    /// 已采集到的服务器资源（空 = 没采集）。
    pub observed_resources: Option<ServerResourceFacts>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ServerResourceFacts {
    pub cpu_cores: f64,
    pub memory_mb: i64,
    pub disk_free_gb: f64,
}

/// 一份完整的部署方案。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentProposal {
    pub id: String,
    pub schema_version: String,
    pub application_id: String,
    pub environment_id: Option<String>,
    pub server_id: String,
    pub status: ProposalStatus,

    pub summary: ProposalSummary,
    pub assumptions: Vec<Assumption>,
    pub unknowns: Vec<Unknown>,
    pub recommended_topology: TopologyOption,
    pub alternative_topologies: Vec<TopologyOption>,
    pub services: Vec<ProposedService>,
    pub dependencies: Vec<ProposedDependency>,
    pub capacity_recommendation: CapacityRecommendation,
    pub domains: Vec<ProposedDomain>,
    pub workflow: ProposedWorkflow,
    pub risks: Vec<ProposedRisk>,
    pub approvals: Vec<ProposedApproval>,
    pub rollback_strategy: RollbackStrategy,
    pub knowledge_references: Vec<KnowledgeReference>,
    pub knowledge_conflicts: Vec<KnowledgeConflict>,

    pub validation: ProposalValidation,
    pub ai_review: Option<AiReview>,
    pub inputs: InputSnapshot,
    pub fingerprint: ProposalFingerprint,
    pub created_at: i64,
}

impl DeploymentProposal {
    /// 方案是否可以往下走（生成可执行计划）。
    pub fn is_ready(&self) -> bool {
        !self.workflow.nodes.is_empty() && !self.validation.blocks_plan()
    }

    /// 是否可以批准。
    pub fn is_approvable(&self) -> bool {
        self.is_ready()
            && !self.validation.blocks_approval()
            && !self
                .unknowns
                .iter()
                .any(|unknown| unknown.severity != UnknownSeverity::Info)
            && !self.risks.iter().any(|risk| risk.blocks_approval)
    }

    /// 必须由人回答的问题（挡事的那种）。
    pub fn blocking_questions(&self) -> Vec<&Unknown> {
        self.unknowns
            .iter()
            .filter(|unknown| unknown.severity != UnknownSeverity::Info)
            .collect()
    }
}

/// 生成结果。`ready == false` 时 `proposal.workflow.nodes` 必然为空。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposalOutcome {
    /// 能不能出可执行计划。
    pub ready: bool,
    /// 能不能批准（生产部署恒需人工审批）。
    pub approvable: bool,
    /// 必须问用户的问题。
    pub open_questions: Vec<Unknown>,
    /// 挡住计划的校验项。
    pub blockers: Vec<ProposalViolation>,
    /// 方案本身（永远是完整的，只是未就绪时没有工作流）。
    pub proposal: DeploymentProposal,
}
