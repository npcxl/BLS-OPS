//! P5.6 **统一部署会话** —— 一条从"导入项目"到"部署完成/回滚"的主线。
//!
//! 它把 P5.0～P5.5 已有能力串起来（制品导入 → 方案引擎 → PlanCompiler →
//! preflight → RunExecutor），**不重新实现**其中任何一环。
//!
//! # 状态机
//!
//! ```text
//! created → importing → analyzing → draft_ready → confirming → preflight → deploying
//!                          ↕                                            ↓
//!                     needs_input                        succeeded / failed / rolled_back
//! ```
//!
//! 任意一个输入（项目来源、服务器、用户描述、Memory / Knowledge 引用）变化都会让
//! `input_fingerprint` 变化 → 旧草案**失效**，必须重新分析（不允许拿旧草案去确认）。
//!
//! # 审计
//!
//! 每次状态变更都写一条 [`DeploymentSessionEvent`]；事件里**只允许脱敏摘要**，
//! 任何 Secret 明文都不得进入（见 [`looks_like_secret`]）。

use serde::{Deserialize, Serialize};

use crate::deployment::artifact::fingerprint;

/// 会话状态（12 个）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Created,
    Importing,
    Analyzing,
    /// 有阻塞问题等待用户回答。
    NeedsInput,
    /// 草案已就绪，等待用户确认。
    DraftReady,
    /// 用户点了确认，正在做原子校验 / 编译。
    Confirming,
    Preflight,
    Deploying,
    Succeeded,
    Failed,
    RolledBack,
    Cancelled,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Created => "created",
            SessionStatus::Importing => "importing",
            SessionStatus::Analyzing => "analyzing",
            SessionStatus::NeedsInput => "needs_input",
            SessionStatus::DraftReady => "draft_ready",
            SessionStatus::Confirming => "confirming",
            SessionStatus::Preflight => "preflight",
            SessionStatus::Deploying => "deploying",
            SessionStatus::Succeeded => "succeeded",
            SessionStatus::Failed => "failed",
            SessionStatus::RolledBack => "rolled_back",
            SessionStatus::Cancelled => "cancelled",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SessionStatus::Created => "已创建",
            SessionStatus::Importing => "导入中",
            SessionStatus::Analyzing => "分析中",
            SessionStatus::NeedsInput => "等待补充",
            SessionStatus::DraftReady => "草案就绪",
            SessionStatus::Confirming => "确认中",
            SessionStatus::Preflight => "预检中",
            SessionStatus::Deploying => "部署中",
            SessionStatus::Succeeded => "成功",
            SessionStatus::Failed => "失败",
            SessionStatus::RolledBack => "已回滚",
            SessionStatus::Cancelled => "已取消",
        }
    }

    pub const ALL: &'static [SessionStatus] = &[
        SessionStatus::Created,
        SessionStatus::Importing,
        SessionStatus::Analyzing,
        SessionStatus::NeedsInput,
        SessionStatus::DraftReady,
        SessionStatus::Confirming,
        SessionStatus::Preflight,
        SessionStatus::Deploying,
        SessionStatus::Succeeded,
        SessionStatus::Failed,
        SessionStatus::RolledBack,
        SessionStatus::Cancelled,
    ];

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            SessionStatus::Succeeded
                | SessionStatus::Failed
                | SessionStatus::RolledBack
                | SessionStatus::Cancelled
        )
    }

    /// 是否还在推进中（界面据此决定"能不能取消"）。
    pub fn is_active(self) -> bool {
        !self.is_terminal()
    }

    /// 状态机迁移规则（唯一来源，别在命令层另写一套）。
    pub fn can_transition_to(self, next: SessionStatus) -> bool {
        use SessionStatus::*;
        if self == next {
            return false;
        }
        match (self, next) {
            (Created, Importing | Cancelled) => true,
            (Importing, Analyzing | Failed | Cancelled) => true,
            // 输入变化会让草案失效 → 回到 analyzing。
            (Analyzing, NeedsInput | DraftReady | Failed | Cancelled) => true,
            (NeedsInput, Analyzing | Cancelled) => true,
            (DraftReady, Confirming | Analyzing | Cancelled) => true,
            // 用户取消确认 → 回到草案；原子校验发现输入变了 → 重新分析。
            (Confirming, Preflight | DraftReady | Analyzing | Cancelled) => true,
            // 预检有阻塞项 → 回到 needs_input（绝不启动）。
            (Preflight, Deploying | NeedsInput | Failed | Cancelled) => true,
            (Deploying, Succeeded | Failed | RolledBack | Cancelled) => true,
            (Failed, Analyzing | Cancelled) => true,
            (RolledBack, Analyzing | Cancelled) => true,
            _ => false,
        }
    }
}

/// 阻塞问题的种类（**受控**：不是自由文本，便于去重与前端渲染）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    /// 生产还是测试。
    EnvironmentKind,
    Domain,
    Capacity,
    Port,
    SecretReference,
    DatabaseHosting,
    DnsOwnership,
    Other,
}

impl QuestionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            QuestionKind::EnvironmentKind => "environment_kind",
            QuestionKind::Domain => "domain",
            QuestionKind::Capacity => "capacity",
            QuestionKind::Port => "port",
            QuestionKind::SecretReference => "secret_reference",
            QuestionKind::DatabaseHosting => "database_hosting",
            QuestionKind::DnsOwnership => "dns_ownership",
            QuestionKind::Other => "other",
        }
    }
}

/// 一条**阻塞**问题（非阻塞信息不允许走这里，用明确假设表达）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionQuestion {
    pub id: String,
    pub kind: QuestionKind,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
}

/// 会话事件（审计用；**不含 Secret**）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEventKind {
    Created,
    StatusChanged,
    QuestionAsked,
    AnswerRecorded,
    DraftGenerated,
    /// 输入指纹变化 → 旧草案作废。
    DraftInvalidated,
    Confirmed,
    PreflightBlocked,
    RunStarted,
    OutcomeRecorded,
    MemoryUpdated,
    Cancelled,
    Failed,
}

impl SessionEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionEventKind::Created => "created",
            SessionEventKind::StatusChanged => "status_changed",
            SessionEventKind::QuestionAsked => "question_asked",
            SessionEventKind::AnswerRecorded => "answer_recorded",
            SessionEventKind::DraftGenerated => "draft_generated",
            SessionEventKind::DraftInvalidated => "draft_invalidated",
            SessionEventKind::Confirmed => "confirmed",
            SessionEventKind::PreflightBlocked => "preflight_blocked",
            SessionEventKind::RunStarted => "run_started",
            SessionEventKind::OutcomeRecorded => "outcome_recorded",
            SessionEventKind::MemoryUpdated => "memory_updated",
            SessionEventKind::Cancelled => "cancelled",
            SessionEventKind::Failed => "failed",
        }
    }

    pub const ALL: &'static [SessionEventKind] = &[
        SessionEventKind::Created,
        SessionEventKind::StatusChanged,
        SessionEventKind::QuestionAsked,
        SessionEventKind::AnswerRecorded,
        SessionEventKind::DraftGenerated,
        SessionEventKind::DraftInvalidated,
        SessionEventKind::Confirmed,
        SessionEventKind::PreflightBlocked,
        SessionEventKind::RunStarted,
        SessionEventKind::OutcomeRecorded,
        SessionEventKind::MemoryUpdated,
        SessionEventKind::Cancelled,
        SessionEventKind::Failed,
    ];
}

/// 一条会话事件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentSessionEvent {
    pub id: String,
    pub session_id: String,
    pub kind: SessionEventKind,
    #[serde(default)]
    pub from_status: Option<SessionStatus>,
    #[serde(default)]
    pub to_status: Option<SessionStatus>,
    /// **脱敏后**的说明。
    pub detail: String,
    pub created_at: i64,
}

impl DeploymentSessionEvent {
    pub fn new(
        id: impl Into<String>,
        session_id: impl Into<String>,
        kind: SessionEventKind,
        detail: impl Into<String>,
        now: i64,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            kind,
            from_status: None,
            to_status: None,
            detail: detail.into(),
            created_at: now,
        }
    }

    pub fn with_status(mut self, from: SessionStatus, to: SessionStatus) -> Self {
        self.from_status = Some(from);
        self.to_status = Some(to);
        self
    }
}

/// 统一部署会话。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentSession {
    pub id: String,
    /// 统一来源快照（Git / 本地目录 / 压缩包都归到这里）。
    #[serde(default)]
    pub source_snapshot_id: Option<String>,
    #[serde(default)]
    pub application_id: Option<String>,
    #[serde(default)]
    pub environment_id: Option<String>,
    #[serde(default)]
    pub server_id: Option<String>,
    /// 用户用自然语言描述的部署需求。
    #[serde(default)]
    pub user_description: String,
    pub status: SessionStatus,
    /// 当前阻塞问题（没有阻塞就是 `None`）。
    #[serde(default)]
    pub current_question: Option<SessionQuestion>,
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub plan_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    /// 草案输入的指纹；变化 = 旧草案失效。
    #[serde(default)]
    pub input_fingerprint: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl DeploymentSession {
    pub fn new(id: impl Into<String>, now: i64) -> Self {
        Self {
            id: id.into(),
            source_snapshot_id: None,
            application_id: None,
            environment_id: None,
            server_id: None,
            user_description: String::new(),
            status: SessionStatus::Created,
            current_question: None,
            proposal_id: None,
            plan_id: None,
            run_id: None,
            input_fingerprint: String::new(),
            created_at: now,
            updated_at: now,
        }
    }
}

/// 影响草案的全部输入 —— 任意一项变化都会让旧草案失效。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct DraftInputs {
    /// 来源快照的指纹（commit SHA / 内容哈希）。
    #[serde(default)]
    pub source_fingerprint: String,
    #[serde(default)]
    pub server_id: String,
    /// 服务器能力快照的哈希。
    #[serde(default)]
    pub capability_hash: String,
    #[serde(default)]
    pub user_description: String,
    /// 被检索到的 Memory 引用（`<id>@<updated_at>`），调用方需**排序后**传入。
    #[serde(default)]
    pub memory_refs: Vec<String>,
    /// 被检索到的 Knowledge 引用（`<id>@<version>`），同样排序。
    #[serde(default)]
    pub knowledge_refs: Vec<String>,
    #[serde(default)]
    pub capacity_fingerprint: String,
    #[serde(default)]
    pub policy_fingerprint: String,
}

impl DraftInputs {
    /// 计算指纹。**同一组输入一定得到同一个值**（可复现、可比对）。
    pub fn fingerprint(&self) -> String {
        let mut memory = self.memory_refs.clone();
        memory.sort();
        let mut knowledge = self.knowledge_refs.clone();
        knowledge.sort();
        let canonical = serde_json::json!({
            "source": self.source_fingerprint,
            "server_id": self.server_id,
            "capability": self.capability_hash,
            "description": self.user_description.trim(),
            "memory": memory,
            "knowledge": knowledge,
            "capacity": self.capacity_fingerprint,
            "policy": self.policy_fingerprint,
        });
        fingerprint::hash_bytes(canonical.to_string().as_bytes())
    }
}

/// 草案是否仍然有效（输入指纹一致）。
pub fn draft_is_valid(session: &DeploymentSession, inputs: &DraftInputs) -> bool {
    !session.input_fingerprint.is_empty() && session.input_fingerprint == inputs.fingerprint()
}

/// 粗判文本里是否像有 Secret（用于事件 / 审计写入前的守卫）。
///
/// 这是**兜底**：真正的保证是调用方根本不把密钥传进来。
pub fn looks_like_secret(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("sk-") || lower.contains("bearer ") || lower.contains("private key") {
        return true;
    }
    if lower.contains("password=") || lower.contains("token=") || lower.contains("secret=") {
        return true;
    }
    // 32 位以上的连续十六进制串（指纹除外：调用方不该把指纹塞进事件 detail）。
    text.split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|token| token.len() >= 32 && token.chars().all(|ch| ch.is_ascii_hexdigit()))
}
