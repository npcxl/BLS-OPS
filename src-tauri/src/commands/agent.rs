//! 超能模式 Agent 的 IPC。
//!
//! 只有四个命令，全部围绕一个 taskId：
//! * `agent_start`    —— 启动多轮循环，**立刻返回初始快照**（循环在后台跑）；
//! * `agent_snapshot` —— 前端重进 / 轮询时恢复卡片与当前进度；
//! * `agent_approve`  —— 对挂起中的写 / 危险操作表态（不点就永远不执行）；
//! * `agent_cancel`   —— 置停止标记（当前命令跑完才停，语义同 `ai_chat_cancel`）。
//!
//! 这里不做业务判断：校验、命令构造、风险与上限都在 `crate::agent` 里，
//! 命令层只做参数形状转换。

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::agent::{spawn_agent, AgentInput, AgentSnapshot, AgentTurn, TokenUsage};
use crate::ops_error::{OpsError, OpsResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct AgentTurnInput {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartRequest {
    pub task_id: String,
    pub session_id: String,
    /// 展示名，进快照与历史（不参与命令构造）。
    pub server: String,
    pub cwd: String,
    pub messages: Vec<AgentTurnInput>,
    /// 只有用户在界面上打开「完全权限」才为 true。
    #[serde(default)]
    pub allow_sudo: bool,
    /// 同上：完全权限下修改范围内的写 / 改 / 删都不再逐条确认。
    #[serde(default)]
    pub auto_approve_writes: bool,
    /// 续跑同一个 taskId 时带上已知的累计用量（后端从它继续加）。
    #[serde(default)]
    pub carry_usage: Option<TokenUsage>,
    #[serde(default)]
    pub max_rounds: Option<u32>,
    /// 这条会话选中的模型（provider id）；`None` = 默认提供方。
    #[serde(default)]
    pub provider_id: Option<String>,
    /// 思考强度：`low` / `medium` / `high` / `max`；`None` / `auto` = 供应商默认。
    /// 界面传的是**已按模型能力选好**的档位（MAX 会先映射成模型最高档）。
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// 上下文输入预算（tokens）；`None` = 按模型窗口自动。
    #[serde(default)]
    pub context_budget: Option<u32>,
}

#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: AgentStartRequest,
) -> OpsResult<AgentSnapshot> {
    let input = AgentInput {
        task_id: request.task_id,
        session_id: request.session_id,
        server: request.server,
        cwd: request.cwd,
        messages: request
            .messages
            .into_iter()
            .map(|turn| AgentTurn {
                role: turn.role,
                content: turn.content,
            })
            .collect(),
        reasoning_effort: request.reasoning_effort,
        context_budget: request.context_budget,
        carry_usage: request.carry_usage,
        allow_sudo: request.allow_sudo,
        auto_approve_writes: request.auto_approve_writes,
        max_rounds: request.max_rounds,
        provider_id: request.provider_id,
    };
    spawn_agent(app, state.inner().clone(), input)
        .await
        .map_err(|error| OpsError::new("ai", error))
}

#[tauri::command]
pub fn agent_snapshot(
    state: State<'_, AppState>,
    task_id: String,
) -> OpsResult<Option<AgentSnapshot>> {
    Ok(state.agents.snapshot(&task_id))
}

/// 用户对一条挂起命令的表态。`false` = 拒绝（或已经超时/结束了）。
#[tauri::command]
pub fn agent_approve(
    state: State<'_, AppState>,
    task_id: String,
    call_id: String,
    allow: bool,
) -> OpsResult<bool> {
    match state.agents.get(&task_id) {
        Some(handle) => Ok(handle.resolve_approval(&call_id, allow)),
        None => Ok(false),
    }
}

/// 停止（协作式）：当前命令跑完再停，历史落 `cancelled`。
#[tauri::command]
pub fn agent_cancel(state: State<'_, AppState>, task_id: String) -> OpsResult<bool> {
    if let Some(handle) = state.agents.get(&task_id) {
        handle.cancel().cancel();
        return Ok(true);
    }
    Ok(state.ai_reviews.cancel(&task_id))
}
