//! AI 提供方与复核任务的**数据模型**（跨 IPC 的字段全部 `snake_case`）。
//!
//! # 密钥的存放位置（这条边界写进类型里）
//!
//! [`AiProviderConfig`] **没有明文密钥字段**：只有 `api_key_ref`（钥匙串账户名）。
//! 前端拿到的是 [`AiProviderView`] —— 它对密钥的全部信息就是一个
//! `has_api_key: bool`。没有"读取 API Key"的 IPC，也不会有：
//! React 侧根本不存在能装下它的字段。
//!
//! # 一次请求的预算
//!
//! [`AiRequestBudget`] 把"能问什么、问多少、等多久"写成显式上限，
//! 由 [`super::provider`] 强制执行（超时、响应体上限、重试次数、退避上限）。

use serde::{Deserialize, Serialize};

use crate::deployment::proposal::ai::AiSuggestion;

/// 提供方配置的结构版本（进配置指纹，便于将来迁移）。
pub const AI_PROVIDER_SCHEMA_VERSION: &str = "ai-provider/1";

/// 钥匙串账户名前缀。`ai-provider:<provider_id>`。
pub const KEYRING_ACCOUNT_PREFIX: &str = "ai-provider:";

/// 第一版只支持 OpenAI 兼容协议（`POST /chat/completions`）。
///
/// 刻意**不为每个厂商绑定 SDK**：兼容协议是事实标准，多接一套协议就多一份
/// 需要审计的网络代码。要接别的协议 = 实现 [`super::provider::AiAdvisor`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderKind {
    #[default]
    OpenAiCompatible,
}

impl AiProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AiProviderKind::OpenAiCompatible => "openai_compatible",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            AiProviderKind::OpenAiCompatible => "OpenAI 兼容",
        }
    }

    /// 界面上可供选择的类型（只有一种 —— 如实列出）。
    pub const ALL: &'static [AiProviderKind] = &[AiProviderKind::OpenAiCompatible];
}

/// 提供方配置（**不含明文密钥**）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_kind: AiProviderKind,
    /// 形如 `https://api.example.com/v1`（已校验，见 [`super::url`]）。
    pub base_url: String,
    pub model: String,
    /// 钥匙串账户名（`ai-provider:<id>`）。为 `None` 表示还没保存过密钥。
    pub api_key_ref: Option<String>,
    pub enabled: bool,
    pub is_default: bool,
    /// 是否允许**非本地**的明文 http（默认关闭；自建网关才需要）。
    #[serde(default)]
    pub allow_insecure_http: bool,
    pub timeout_seconds: u32,
    pub max_output_tokens: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AiProviderConfig {
    /// 新建一份配置（默认值就是"保守且可用"）。
    pub fn new(id: impl Into<String>, name: impl Into<String>, now: i64) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            provider_kind: AiProviderKind::OpenAiCompatible,
            base_url: String::new(),
            model: String::new(),
            api_key_ref: None,
            enabled: true,
            is_default: false,
            allow_insecure_http: false,
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
            max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
            created_at: now,
            updated_at: now,
        }
    }

    /// 钥匙串账户名。**所有读写钥匙串的地方都必须用它**。
    pub fn keyring_account(&self) -> String {
        format!("{KEYRING_ACCOUNT_PREFIX}{}", self.id)
    }

    /// 发请求时的预算。
    pub fn budget(&self) -> AiRequestBudget {
        AiRequestBudget {
            timeout_seconds: self
                .timeout_seconds
                .clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
            max_output_tokens: self
                .max_output_tokens
                .clamp(MIN_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS),
            ..AiRequestBudget::default()
        }
    }
}

pub const DEFAULT_TIMEOUT_SECONDS: u32 = 30;
pub const MIN_TIMEOUT_SECONDS: u32 = 5;
pub const MAX_TIMEOUT_SECONDS: u32 = 180;
pub const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 1200;
pub const MIN_MAX_OUTPUT_TOKENS: u32 = 128;
pub const MAX_MAX_OUTPUT_TOKENS: u32 = 8_000;

/// 一次请求的硬预算（连接、总超时、响应体上限、重试与退避上限）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiRequestBudget {
    /// 连接超时（秒）。
    pub connect_seconds: u64,
    /// 总超时（秒）——从发出到读完响应体。
    pub timeout_seconds: u32,
    /// 响应体字节上限。超了直接放弃（**不**试图读完一个陌生服务器给的东西）。
    pub max_response_bytes: usize,
    /// 最多尝试几次（含第一次）。
    pub max_attempts: u32,
    /// 两次尝试之间的基准退避（秒），按次数翻倍但有上限。
    pub base_backoff_seconds: u64,
    /// 单次退避上限（秒）。
    pub max_backoff_seconds: u64,
    pub max_output_tokens: u32,
}

impl Default for AiRequestBudget {
    fn default() -> Self {
        Self {
            connect_seconds: 10,
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
            // 128 KiB：一份 JSON 建议撑死几十 KB，超过就说明对面不是我们要的东西。
            max_response_bytes: 128 * 1024,
            max_attempts: 3,
            base_backoff_seconds: 1,
            max_backoff_seconds: 8,
            max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
        }
    }
}

/// 前端可见的提供方视图。
///
/// **这是给 React 的唯一形态**：密钥的位置只有一个布尔值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiProviderView {
    pub id: String,
    pub name: String,
    pub provider_kind: AiProviderKind,
    pub base_url: String,
    pub model: String,
    /// 钥匙串里是否已有密钥（**只有这一位信息**）。
    pub has_api_key: bool,
    pub enabled: bool,
    pub is_default: bool,
    /// 是否允许**非本地**的明文 http（默认关闭；自建网关才需要）。
    #[serde(default)]
    pub allow_insecure_http: bool,
    pub timeout_seconds: u32,
    pub max_output_tokens: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AiProviderView {
    pub fn from_config(config: &AiProviderConfig, has_api_key: bool) -> Self {
        Self {
            id: config.id.clone(),
            name: config.name.clone(),
            provider_kind: config.provider_kind,
            base_url: config.base_url.clone(),
            model: config.model.clone(),
            has_api_key,
            enabled: config.enabled,
            is_default: config.is_default,
            allow_insecure_http: config.allow_insecure_http,
            timeout_seconds: config.timeout_seconds,
            max_output_tokens: config.max_output_tokens,
            created_at: config.created_at,
            updated_at: config.updated_at,
        }
    }
}

/// 保存时的入参（**明文密钥只在这里出现一次**，随后立刻进钥匙串）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AiProviderSaveRequest {
    /// 空 = 新建。
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub provider_kind: AiProviderKind,
    pub base_url: String,
    pub model: String,
    /// `None` / 空串 = **保留原密钥**（前端不回显，也不允许读取）。
    #[serde(default)]
    pub api_key: Option<String>,
    pub enabled: bool,
    pub is_default: bool,
    /// 允许**非本地**明文 http（默认 false；只有自建受信内网网关才该开）。
    #[serde(default)]
    pub allow_insecure_http: bool,
    pub timeout_seconds: u32,
    pub max_output_tokens: u32,
}

/// 连接测试结果（人类可读，**不含密钥与原始响应**）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiProviderTestResult {
    pub ok: bool,
    /// 往返耗时（毫秒）。
    pub latency_ms: i64,
    pub model: String,
    /// 成功时是简短确认，失败时是**脱敏后**的错误说明。
    pub message: String,
    /// 失败时的稳定错误码（界面按它决定提示语气）。
    pub error_code: Option<String>,
    /// 实际发出的请求次数（与 AI 复核共用同一套重试统计语义）。
    #[serde(default)]
    pub attempts: u32,
}

/// 提供方错误。**每个变体的消息都必须能直接给用户看**（不含密钥 / 请求头 / 原始响应）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiProviderError {
    /// 没有启用任何提供方。
    NotConfigured,
    /// 配置本身不合法（URL / 模型名 / 密钥缺失）。
    InvalidConfig(String),
    /// 认证失败（401 / 403）。
    Auth(String),
    /// 触发限流（429），带服务端建议的等待秒数。
    RateLimited { retry_after_seconds: Option<u64> },
    /// 超时。
    Timeout,
    /// 网络层失败（连接被拒 / DNS / TLS）。
    Network(String),
    /// 其它 HTTP 状态。
    Http { status: u16, detail: String },
    /// 响应体超过预算。
    ResponseTooLarge,
    /// 模型答复无法使用（无效 JSON / 未知字段 / 含命令 …）。
    RejectedContent {
        reason: String,
        kind: super::super::proposal::model::AiRejectionKind,
    },
    /// 运行被取消。
    Cancelled,
}

impl AiProviderError {
    pub fn code(&self) -> &'static str {
        match self {
            AiProviderError::NotConfigured => "not_configured",
            AiProviderError::InvalidConfig(_) => "invalid_config",
            AiProviderError::Auth(_) => "auth",
            AiProviderError::RateLimited { .. } => "rate_limited",
            AiProviderError::Timeout => "timeout",
            AiProviderError::Network(_) => "network",
            AiProviderError::Http { .. } => "http",
            AiProviderError::ResponseTooLarge => "response_too_large",
            AiProviderError::RejectedContent { .. } => "rejected_content",
            AiProviderError::Cancelled => "cancelled",
        }
    }

    /// 用户可见的一句话（**已脱敏**）。
    pub fn user_message(&self) -> String {
        match self {
            AiProviderError::NotConfigured => "还没有配置可用的 AI 提供方".to_string(),
            AiProviderError::InvalidConfig(detail) => format!("提供方配置不合法：{detail}"),
            AiProviderError::Auth(detail) => format!("认证失败（API Key 无效或无权限）：{detail}"),
            AiProviderError::RateLimited {
                retry_after_seconds,
            } => match retry_after_seconds {
                Some(seconds) => format!("模型服务限流，建议 {seconds} 秒后重试"),
                None => "模型服务限流，请稍后重试".to_string(),
            },
            AiProviderError::Timeout => "请求模型超时".to_string(),
            AiProviderError::Network(detail) => format!("无法连接到模型服务：{detail}"),
            AiProviderError::Http { status, detail } => {
                format!("模型服务返回 HTTP {status}：{detail}")
            }
            AiProviderError::ResponseTooLarge => "模型响应体过大，已放弃解析".to_string(),
            AiProviderError::RejectedContent { reason, .. } => reason.clone(),
            AiProviderError::Cancelled => "AI 复核已取消".to_string(),
        }
    }

    /// 失败是否值得重试（**认证失败与"不支持"绝不重试**）。
    ///
    /// 只认**明确的临时状态**：408 请求超时、500/502/503/504 服务端抖动。
    /// 501（未实现）这种是"这个网关根本不支持"，重试一万次也一样。
    pub fn is_retryable(&self) -> bool {
        match self {
            AiProviderError::Timeout | AiProviderError::Network(_) => true,
            AiProviderError::RateLimited { .. } => true,
            AiProviderError::Http { status, .. } => {
                matches!(*status, 408 | 500 | 502 | 503 | 504)
            }
            _ => false,
        }
    }

    pub fn rate_limited() -> Self {
        AiProviderError::RateLimited {
            retry_after_seconds: None,
        }
    }
}

/// 内存里的复核任务登记表（**真实可取消**）。
///
/// 与 P5.1 导入任务同一套做法：后台任务 + 事件 + 轮询兜底，
/// **不让一个慢模型长时间占用前端 invoke**。
///
/// 取消不是"任务末尾看一眼布尔值"：每个任务持有一个 [`AiCancel`]，
/// Provider 在**发请求前、重试等待中、解析之后**都会检查它，
/// 因此取消能真正打断 HTTP 请求与退避等待（见 `provider.rs`）。
#[derive(Clone, Default)]
pub struct AiReviewRegistry {
    cancels: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, AiCancel>>>,
}

impl AiReviewRegistry {
    pub fn register(&self, task_id: &str) -> AiCancel {
        let token = AiCancel::new();
        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.insert(task_id.to_string(), token.clone());
        }
        token
    }

    pub fn cancel(&self, task_id: &str) -> bool {
        self.cancels
            .lock()
            .ok()
            .and_then(|cancels| cancels.get(task_id).cloned())
            .map(|token| {
                token.cancel();
                true
            })
            .unwrap_or(false)
    }

    /// 任务结束（成功 / 失败 / 取消）后必须调用：否则登记表会一直涨。
    pub fn forget(&self, task_id: &str) {
        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.remove(task_id);
        }
    }

    /// 当前登记了多少个任务（测试用它证明"完成后会释放"）。
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.cancels.lock().map(|map| map.len()).unwrap_or(0)
    }
}

/// **真实可取消**的令牌。
///
/// 用 `tokio::sync::watch` 而不是裸 `AtomicBool`：`select!` 能同时等
/// "网络请求"与"取消信号"，所以取消可以立刻生效，而不是等到这一步跑完。
#[derive(Clone, Debug)]
pub struct AiCancel {
    sender: std::sync::Arc<tokio::sync::watch::Sender<bool>>,
    receiver: tokio::sync::watch::Receiver<bool>,
}

impl AiCancel {
    pub fn new() -> Self {
        let (sender, receiver) = tokio::sync::watch::channel(false);
        Self {
            sender: std::sync::Arc::new(sender),
            receiver,
        }
    }

    pub fn cancel(&self) {
        // 发送失败只可能是"所有人都退出了"，那时也不需要取消。
        let _ = self.sender.send(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.receiver.borrow()
    }

    /// 供 `tokio::select!` 使用：取消触发时这个 Future 立刻完成。
    pub async fn cancelled(&self) {
        let mut receiver = self.receiver.clone();
        // 已经取消就直接返回。
        if *receiver.borrow_and_update() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow_and_update() {
                return;
            }
        }
    }
}

impl Default for AiCancel {
    fn default() -> Self {
        Self::new()
    }
}

/// 一次复核的**完整结果**：不管成功失败都带真实尝试次数。
///
/// Provider 内部会重试，所以"尝试了几次"只有它知道；把它放在结果里，
/// 任务表与 `proposal.ai_review.attempts` 才能记到真实值（而不是恒为 1）。
#[derive(Debug)]
pub struct AiReviewOutcome {
    pub result: Result<AiSuggestion, AiProviderError>,
    /// 实际发出的 HTTP 请求次数（含重试）。
    pub attempts: u32,
}

/// AI 复核任务状态（与后台任务一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiTaskStatus {
    /// 还没跑过。
    #[default]
    Idle,
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

/// 一次 AI 复核任务（**只存状态与哈希，不存提示词原文与答复原文**）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiReviewTask {
    pub id: String,
    pub proposal_id: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub status: AiTaskStatus,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub attempts: u32,
    /// 失败原因（脱敏后）。
    pub error: Option<String>,
    /// 稳定错误码。
    pub error_code: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AiReviewTask {
    pub fn queued(id: impl Into<String>, proposal_id: impl Into<String>, now: i64) -> Self {
        Self {
            id: id.into(),
            proposal_id: proposal_id.into(),
            provider_id: None,
            model: None,
            status: AiTaskStatus::Queued,
            started_at: None,
            finished_at: None,
            duration_ms: None,
            attempts: 0,
            error: None,
            error_code: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// 是否还在跑（界面用它决定"能不能取消"）。
    pub fn is_active(&self) -> bool {
        matches!(self.status, AiTaskStatus::Queued | AiTaskStatus::Running)
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            AiTaskStatus::Succeeded | AiTaskStatus::Failed | AiTaskStatus::Cancelled
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_view_hides_the_key_behind_a_single_boolean() {
        let mut config = AiProviderConfig::new("p1", "本地模型", 1);
        config.api_key_ref = Some("ai-provider:p1".to_string());
        let view = AiProviderView::from_config(&config, true);
        assert!(view.has_api_key);
        // 序列化后的视图里**不可能**出现密钥或钥匙串账户名之外的东西。
        let json = serde_json::to_string(&view).expect("serialize");
        assert!(!json.contains("ai-provider:p1"), "{json}");
        assert!(!json.contains("api_key_ref"), "{json}");
        assert!(json.contains("\"has_api_key\":true"), "{json}");
    }

    #[test]
    fn budget_is_clamped_into_safe_bounds() {
        let mut config = AiProviderConfig::new("p1", "x", 1);
        config.timeout_seconds = 9_999;
        config.max_output_tokens = 999_999;
        let budget = config.budget();
        assert_eq!(budget.timeout_seconds, MAX_TIMEOUT_SECONDS);
        assert_eq!(budget.max_output_tokens, MAX_MAX_OUTPUT_TOKENS);

        config.timeout_seconds = 1;
        assert_eq!(config.budget().timeout_seconds, MIN_TIMEOUT_SECONDS);
    }

    #[test]
    fn auth_failures_are_never_retried_but_timeouts_are() {
        assert!(!AiProviderError::Auth("x".to_string()).is_retryable());
        assert!(!AiProviderError::InvalidConfig("x".to_string()).is_retryable());
        assert!(AiProviderError::Timeout.is_retryable());
        assert!(AiProviderError::RateLimited {
            retry_after_seconds: None
        }
        .is_retryable());
        assert!(AiProviderError::Http {
            status: 503,
            detail: String::new()
        }
        .is_retryable());
        assert!(!AiProviderError::Http {
            status: 501,
            detail: String::new()
        }
        .is_retryable());
    }

    #[test]
    fn keyring_account_is_namespaced() {
        let config = AiProviderConfig::new("abc", "x", 1);
        assert_eq!(config.keyring_account(), "ai-provider:abc");
    }

    #[test]
    fn save_requests_reject_unknown_fields() {
        let json = r#"{"name":"x","provider_kind":"openai_compatible","base_url":"https://a.example/v1","model":"m","enabled":true,"is_default":false,"timeout_seconds":30,"max_output_tokens":800,"evil":1}"#;
        assert!(serde_json::from_str::<AiProviderSaveRequest>(json).is_err());
    }

    #[test]
    fn the_registry_releases_a_finished_task() {
        let registry = AiReviewRegistry::default();
        let token = registry.register("t1");
        assert_eq!(registry.len(), 1, "登记后应当有一个可取消任务");

        // 取消会点亮对应令牌……
        assert!(registry.cancel("t1"));
        assert!(token.is_cancelled());

        // ……但只有 `forget` 才会把登记项真正移除
        //（成功 / 失败 / 取消三种终态后都必须调用它）。
        registry.forget("t1");
        assert_eq!(registry.len(), 0, "终态后必须释放，否则登记表只增不减");
        // 再取消一个不存在的任务：返回 false，且不 panic。
        assert!(!registry.cancel("t1"));
    }
}
