//! P5.5 —— **AI Provider 层**：配置、URL 校验、OpenAI 兼容调用。
//!
//! # 这一层只做"把话带到、把话带回来"
//!
//! ```text
//! 确定性引擎（同步纯函数）        proposal/engine.rs
//!        ↓ 产出方案（不含 AI）
//! 提示词组装（纯函数）            proposal/ai.rs
//!        ↓ AiPrompt
//! Provider 层（本模块，异步）      reqwest → POST /chat/completions
//!        ↓ 严格解析模型答复
//! 合并与校验（纯函数）            proposal/ai.rs::merge_into
//! ```
//!
//! 关键分界：**确定性引擎永远不依赖网络**。AI 复核是独立命令
//! （`deployment_proposal_ai_review`），失败只是"这次没复核"，方案照常可用。
//!
//! # 与"通用 AI 助手"的区别
//!
//! 这里没有聊天、没有工具调用、没有自然语言控制服务器、没有代码执行。
//! 输入是方案摘要，输出是结构化批注（会被逐条校验），**仅此而已**。
//! 通用 AI 模块的开关（`AI_MODULE_ENABLED`）保持关闭 —— 部署复核不属于它。

pub mod model;
pub mod provider;
pub mod url;

pub use model::{
    AiCancel, AiProviderConfig, AiProviderError, AiProviderKind, AiProviderSaveRequest,
    AiProviderTestResult, AiProviderView, AiRequestBudget, AiReviewOutcome, AiReviewRegistry,
    AiReviewTask, AiTaskStatus, AI_PROVIDER_SCHEMA_VERSION, DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_TIMEOUT_SECONDS, KEYRING_ACCOUNT_PREFIX,
};
pub use provider::{parse_suggestion, AiAdvisor, OpenAiCompatibleAdvisor};
pub use url::{validate_base_url, BaseUrlPolicy};

#[cfg(test)]
mod tests;
