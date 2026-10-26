//! P5.6 —— **统一部署会话 + 用户 Memory**。
//!
//! * [`model`]：`DeploymentSession` / 12 状态机 / 会话事件 / 草案输入指纹；
//! * [`memory`]：`DeploymentMemory` / 受控 key / 类型化 value 校验 / 置信度规则。
//!
//! 这一层是**编排**：它把已有的制品导入、方案引擎、PlanCompiler、preflight、
//! RunExecutor 串成一条主线，不重新实现其中任何一环，也不给 AI 任何执行入口。

pub mod confirm;
pub mod memory;
pub mod model;
pub mod outcome;

pub use memory::{
    DeploymentMemory, MemoryCandidate, MemoryKey, MemoryKind, MemoryScope, MemorySourceType,
    MemoryStatus, CONFIDENCE_ACTIVE_THRESHOLD, CONFIDENCE_EXPLICIT, CONFIDENCE_SINGLE_CHOICE,
    NGINX_LAYOUT_VALUES, PACKAGE_MANAGER_VALUES, RUNTIME_VALUES,
};
pub use model::{
    draft_is_valid, DeploymentSession, DeploymentSessionEvent, DraftInputs, QuestionKind,
    SessionEventKind, SessionQuestion, SessionStatus,
};

#[cfg(test)]
mod tests;
