//! 超能模式的**服务器操作 Agent**。
//!
//! 与 `commands::ai_agent`（只读白名单循环）的区别：这里的模型可以真的改服务器
//! —— 但每一类动作都有确定的**风险等级**，写与危险操作必须经用户逐条确认，
//! 写文件前自动备份，sudo 默认禁用。
//!
//! 分层：
//! * [`protocol`] —— 数据结构、风险枚举、脱敏/截断、工具块解析（纯函数，可单测）
//! * [`tools`]    —— 工具名 + 参数 → 唯一一份命令文本（含 cwd 包装与备份）
//! * [`changes`]  —— 文件变更记录：回读的真实内容 → 指纹 → 行级 Diff（纯函数，可单测）
//! * [`runner`]   —— 多轮循环、事件、审批挂起、取消与上限（**跑在 Rust 侧**，
//!                  WebView 收起或刷新都不会中断正在长的命令）
//! * [`state`]    —— 运行中的任务注册表（也是前端重进时恢复卡片的快照来源）
//!
//! 为什么命令文本只在这里拼：`safe.rs` 的 `Capability` 是"固定动作 → 固定命令"，
//! 而 Agent 执行的是**模型提出的任意命令**。这个模块就是那个例外的唯一边界：
//! 所有校验、风险判定、备份与 cwd 包装都在这一个目录里，不允许散落到别处。

mod changes;
mod protocol;
mod runner;
mod state;
mod tools;

pub use changes::{
    parse_snapshot, snapshot_command, ChangeDraft, ChangeRegistry, FileChangeDetail,
    FileChangeSummary, FileDiff, FileSnapshot, NetChangeSet, SnapshotView, StoredChange,
    MAX_SNAPSHOT_BYTES,
};
pub use protocol::{
    merge_plan, parse_tool_calls, plan_guidance, plan_status_block, preamble_guidance, preamble_text,
    redact, strip_tool_calls, tail_truncate, tool_prompt, AgentEvent, AgentOutcome, AgentPlan,
    AgentStep, AskUserDraft, Lang, PendingQuestion, PlanDraft, PlanStep, PlanStepDraft,
    QuestionAnswer, QuestionOption, ToolCall, ToolResult, ToolRisk, MAX_COMMAND_SECONDS,
    MAX_PLAN_STEPS, MAX_ROUNDS, MAX_TOTAL_SECONDS, MODEL_OUTPUT_LIMIT, STEP_OUTPUT_LIMIT,
};
pub use runner::{spawn_agent, AgentInput, AgentTurn, PermissionMode, AGENT_EVENT};
pub use state::{AgentRegistry, AgentSnapshot, ContextUsage, TokenUsage};

#[cfg(test)]
mod tests;
