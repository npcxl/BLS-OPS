//! 多轮编排：模型 → 工具调用 → 逐条执行 → 结果回灌 → 继续。
//!
//! 循环**跑在 Rust 侧**（`tauri::async_runtime::spawn`），因此收起超能面板、
//! 切回普通终端、甚至刷新 WebView 都不会打断正在跑的部署命令；前端只订阅
//! `agent-event` 渲染，并在需要确认时回一个 `agent_approve`。
//!
//! 上限：单任务 [`MAX_ROUNDS`] 轮、单命令 [`MAX_COMMAND_SECONDS`] 秒、
//! 总计 [`MAX_TOTAL_SECONDS`] 秒；超限以 `failed` 结束并说明停在哪条命令。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter as _};
use tokio::sync::mpsc::UnboundedSender;

use super::changes::{
    parse_snapshot, sanitize, snapshot_command, ChangeDraft, ChangeRegistry, FileChangeSummary,
    FileSnapshot,
};
use super::protocol::{
    intent_guidance, looks_like_tool_call, merge_plan, parse_tool_calls, plan_guidance,
    plan_status_block, preamble_guidance, preamble_text, redact, reply_language_rule,
    strip_tool_calls, tail_truncate, thinking_guidance, tool_prompt, AgentEvent, AgentOutcome,
    AgentPlan, AgentStep, AskUserDraft, Lang, PendingApproval, PendingQuestion, PlanDraft,
    QuestionAnswer, QuestionOption, ToolCall, ToolRisk, APPROVAL_SECONDS, MAX_ROUNDS,
    MAX_TOTAL_SECONDS, MODEL_OUTPUT_LIMIT, STEP_OUTPUT_LIMIT,
};
use super::state::{AgentHandle, AgentSnapshot, ContextBreakdown, ContextUsage, TokenUsage};
use tokio::sync::oneshot;
use super::tools::{
    builtin_tool_allowed, filter_tool_schemas, has_sudo, parse_archive_operation,
    plan_tool_with_backup, requires_confirmation, severe_operation_reason, strip_markers,
    tool_schemas, ArchiveOperation, BackupPolicy, PlannedTool,
};
use crate::deployment::ai::model::AiCancel;
use crate::deployment::ai::{AiProviderError, OpenAiCompatibleAdvisor, ToolReply};
use crate::ssh::utf8_stream::Utf8StreamDecoder;
use crate::ssh::{ExecChunk, ExecOutput};
use crate::state::AppState;

/// 一条命令**边跑边回显**的总上限（超过后只由结束事件给完整输出）。
const LIVE_OUTPUT_LIMIT: usize = 256 * 1024;
/// 等用户回答问题的上限（比审批长：用户可能离开一会儿）。
const QUESTION_SECONDS: u64 = 10 * 60;
/// 文本协议没有 call id：用它给问题生成稳定且唯一的 id。
static QUESTION_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 事件名（前端 `src/lib/events.ts` 里是同一个字符串）。
pub const AGENT_EVENT: &str = "agent-event";

/// 一轮对话消息（前端只传角色与文本）。
#[derive(Debug, Clone)]
pub struct AgentTurn {
    pub role: String,
    pub content: String,
}

/// 三档操作权限。与旧的 `allow_sudo` / `auto_approve_writes` 布尔字段并存：
/// 新客户端传 `permission_mode`，旧客户端按布尔推断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    /// 只读：只执行 Read 工具；写 / 危险操作直接拒绝，不产生审批。
    ReadOnly,
    /// 按需确认：写 / 危险操作逐条审批。
    Ask,
    /// 完全访问：写 / 改 / 删直接执行；严重操作仍审批。
    Full,
}

/// 执行器对一条操作的统一裁决：允许 / 需要确认 / 拦截。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow,
    Confirm,
    Block,
}

/// 三档权限 + 风险 + 严重操作的唯一判定入口。
pub fn permission_decision(
    mode: PermissionMode,
    planned: &PlannedTool,
    auto_approve_writes: bool,
) -> PermissionDecision {
    let needs = planned.call.risk.needs_approval();
    if mode.is_read_only() && needs {
        return PermissionDecision::Block;
    }
    let full = mode == PermissionMode::Full || auto_approve_writes;
    if requires_confirmation(planned, full) {
        PermissionDecision::Confirm
    } else {
        PermissionDecision::Allow
    }
}

impl PermissionMode {
    pub fn from_wire(value: Option<&str>, auto_approve_writes: bool) -> Self {
        match value.map(str::trim) {
            Some("readonly") | Some("read_only") | Some("read-only") => Self::ReadOnly,
            Some("full") => Self::Full,
            Some("ask") => Self::Ask,
            _ if auto_approve_writes => Self::Full,
            _ => Self::Ask,
        }
    }

    pub fn is_read_only(self) -> bool {
        matches!(self, Self::ReadOnly)
    }

    pub fn is_full(self) -> bool {
        matches!(self, Self::Full)
    }
}

/// 启动参数。
#[derive(Debug, Clone)]
pub struct AgentInput {
    pub task_id: String,
    pub session_id: String,
    pub server: String,
    /// 服务器配置 id / 对话 id：变更记录按它们归属，切换对话不会串。
    pub server_id: Option<String>,
    pub workspace_id: Option<String>,
    pub cwd: String,
    pub messages: Vec<AgentTurn>,
    /// 用户为这条会话选的模型；`None` = 用默认提供方。
    pub provider_id: Option<String>,
    /**
     * 界面语言（`zh-CN` / `en`）；`None` = 按中文处理。
     *
     * 只决定系统提示词用哪种语言写，不改任何权限：切英文后模型不会
     * 再拿中文的"操作范围 / 工具协议"当默认约定。
     */
    pub locale: Option<String>,
    /// 回复语言覆盖（`zh` / `en`）；`None` = 跟随界面语言。
    pub reply_language: Option<String>,
    /// 思考强度（已由界面按模型能力选好）；`None` / `auto` = 供应商默认。
    pub reasoning_effort: Option<String>,
    /// 上下文输入预算（tokens）；`None` = 按模型窗口自动。
    pub context_budget: Option<u32>,
    /**
     * 用户在提供方设置里为这个模型声明的能力。
     *
     * `spawn_agent` 从库里的配置填进来（命令层不传）—— 于是"选档 / 算预算"
     * 与"界面菜单"用的是同一份依据，不会出现菜单能选、请求里被悄悄改掉。
     */
    pub capability: Option<crate::deployment::ai::CapabilityOverride>,
    /// 续跑（同一任务换一次 run_loop）时从上一段带过来的累计用量。
    pub carry_usage: Option<TokenUsage>,
    /// 允许 sudo（只读模式下恒为 false）。
    pub allow_sudo: bool,
    /// 「完全权限」下修改范围内的写入 / 修改 / 删除**都不再确认**。
    pub auto_approve_writes: bool,
    /// 三档权限（新客户端显式传；旧客户端由上面的布尔推断）。
    pub permission_mode: PermissionMode,
    /// 修改 / 覆盖前备份。
    pub backup_before_write: bool,
    /// 删除前备份。
    pub backup_before_delete: bool,
    /// 备份保留天数；0 = 永久。
    pub backup_retention_days: u32,
    /// 本轮启用的 MCP 工具（配置在启动时解析好，执行时不再查库）。
    pub mcp_tools: Vec<crate::mcp::McpBinding>,
    /// 本轮勾选的内置技能；`None` = 旧客户端，全部放行。
    pub enabled_builtins: Option<Vec<String>>,
    /// 执行时复查 MCP 服务/工具是否仍启用（测试里可以为 None）。
    pub db: Option<std::sync::Arc<crate::db::AppDb>>,
    /**
     * 本轮是否强制先提交计划（用户选择 MAX）。
     *
     * 与 `reasoning_effort` **分开**：供应商最高档可能叫 high，但用户选的是
     * MAX 仍然要走计划门控。
     */
    pub plan_required: bool,
    /// 恢复 / 续跑时带到本轮的计划（用于系统提示词与快照恢复）。
    pub carry_plan: Option<AgentPlan>,
    pub max_rounds: Option<u32>,
    /**
     * 恢复中断任务时带进来的历史步骤。
     *
     * 只用于两步：让快照/界面继续显示"已经做过什么"，以及让新的步骤序号从
     * 它们之后开始 —— 否则重进/恢复会把旧步骤按 index 覆盖掉。
     */
    pub carry_steps: Vec<AgentStep>,
}

#[derive(Debug)]
pub(crate) enum StopReason {
    /// 用户点了停止：当前命令已经跑完，不再继续。
    Cancelled(String),
    /// 失败 / 超限 / 会话断开。
    Failed(String),
}

fn emit(app: &AppHandle, event: AgentEvent) {
    let _ = app.emit(AGENT_EVENT, event);
}

/// 装箱的异步结果。
///
/// 用显式 `Box<dyn Future>` 而不是 `async fn`：`run_loop` 要放进
/// `tauri::async_runtime::spawn`，future 必须是 `Send`，而 trait 里的 `async fn`
/// 没法声明这个约束。
pub(crate) type IoFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// 循环需要的外部能力。
///
/// 生产实现 [`LiveIo`] 接 Tauri 事件 / SSH / 模型；测试实现接内存假数据，于是
/// "拒绝后绝不执行 / 取消停在当前命令 / 轮数上限"这些**循环行为**能被真正断言，
/// 而不是只靠编译通过。
pub(crate) trait AgentIo: Send + Sync {
    fn emit(&self, event: AgentEvent);
    /// `'static` 的事件出口（给 spawn 出去的输出转发任务用）。
    fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync>;
    fn connected<'a>(&'a self, session_id: &'a str) -> IoFuture<'a, bool>;
    fn verify_server(&self, session_id: &str, server: &str) -> Result<(), String>;
    fn exec<'a>(
        &'a self,
        session_id: &'a str,
        command: &'a str,
        timeout: Duration,
        sink: UnboundedSender<ExecChunk>,
    ) -> IoFuture<'a, Result<ExecOutput, String>>;
    fn chat<'a>(
        &'a self,
        messages: Vec<Value>,
        tools: Value,
        cancel: &'a AiCancel,
        // 正文增量出口：边生成边交给界面（同一条回复气泡）。
        on_delta: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> IoFuture<'a, Result<ToolReply, AiProviderError>>;

    /// 文件变更记录的存储。生产实现用 `AppState` 里的注册表；测试默认拿到的
    /// 是一份空表（记录不会跨调用保留，但流程照走）。
    fn changes(&self) -> ChangeRegistry {
        ChangeRegistry::default()
    }

    /// 回读服务器上的文件：**变更 Diff 的唯一事实来源**。
    ///
    /// `Ok(None)` = 当前 IO 不支持快照（测试替身 / 降级），此时不生成变更记录，
    /// 行为与接入前一致；`Err` = 读了但读不到（权限 / 非普通文件），
    /// 记录里显示"未采集差异"，不生成假 Diff。
    fn read_snapshot<'a>(
        &'a self,
        _session_id: &'a str,
        _path: &'a str,
    ) -> IoFuture<'a, Result<Option<FileSnapshot>, String>> {
        Box::pin(async move { Ok(None) })
    }
}

/// 待执行的一次调用（原生 `tool_calls` 与文本 `<tool>` 统一成这个形态）。
struct PendingCall {
    /// 原生调用 id（回灌 `role: tool` 用）；文本协议先留空，按序号生成。
    id: String,
    name: String,
    body: String,
    native: bool,
}

/// 生产实现：Tauri 事件 + SSH + 模型提供方。
struct LiveIo<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
    advisor: &'a OpenAiCompatibleAdvisor,
    /// **启动时**解析好的思考强度：同一次运行里的工具续请求沿用它，
    /// 中途改设置只影响下一条消息。
    reasoning_effort: Option<String>,
}

impl AgentIo for LiveIo<'_> {
    fn emit(&self, event: AgentEvent) {
        emit(self.app, event);
    }

    fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync> {
        let app = self.app.clone();
        Arc::new(move |event| emit(&app, event))
    }

    fn connected<'a>(&'a self, session_id: &'a str) -> IoFuture<'a, bool> {
        Box::pin(async move { self.state.ssh.is_connected(session_id).await })
    }

    fn verify_server(&self, session_id: &str, server: &str) -> Result<(), String> {
        verify_session_server(self.state, session_id, server)
    }

    fn exec<'a>(
        &'a self,
        session_id: &'a str,
        command: &'a str,
        timeout: Duration,
        sink: UnboundedSender<ExecChunk>,
    ) -> IoFuture<'a, Result<ExecOutput, String>> {
        Box::pin(async move {
            self.state
                .ssh
                .exec_stream(session_id, command, timeout, sink)
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn chat<'a>(
        &'a self,
        messages: Vec<Value>,
        tools: Value,
        cancel: &'a AiCancel,
        on_delta: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> IoFuture<'a, Result<ToolReply, AiProviderError>> {
        Box::pin(async move {
            // 工具调用是一段 JSON（`write_file` 的正文常有几 KB）：放宽输出上限。
            self.advisor
                .chat_with_tools_stream(
                    messages,
                    tools,
                    cancel,
                    Some(4000),
                    self.reasoning_effort.as_deref(),
                    |delta| on_delta(delta),
                )
                .await
        })
    }

    fn changes(&self) -> ChangeRegistry {
        self.state.changes.clone()
    }

    fn read_snapshot<'a>(
        &'a self,
        session_id: &'a str,
        path: &'a str,
    ) -> IoFuture<'a, Result<Option<FileSnapshot>, String>> {
        Box::pin(async move {
            let output = self
                .state
                .ssh
                .exec(session_id, &snapshot_command(path), Duration::from_secs(30))
                .await
                .map_err(|error| error.to_string())?;
            // 输出被截断 = base64 不完整：此时**绝不能**当成文件正文去比较。
            if output.truncated {
                return Err("文件太大，单条命令的输出被截断（不生成逐行 Diff）".to_string());
            }
            parse_snapshot(&output.stdout, path).map(Some)
        })
    }
}

/**
 * 循环异常退出时的兜底收尾。
 *
 * 正常路径（`run_loop` 返回）会在下面显式写终态、发事件并把 `armed` 置
 * false。只有**没走到收尾**（panic / future 被丢弃）才会在 Drop 里补一条
 * failed 终态 —— 否则句柄永远停在 `running`，前端重进会接到一个停不掉的
 * 僵尸任务，`agent_resume` 与历史删除也都会被它挡住。
 */
struct RunGuard {
    app: AppHandle,
    state: AppState,
    handle: Arc<AgentHandle>,
    task_id: String,
    armed: bool,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if !self.handle.snapshot().terminal() {
            self.handle.update(|snapshot| {
                snapshot.status = "failed".to_string();
                snapshot.error = Some(
                    "任务异常终止：执行循环退出但没有留下结果，请核对服务器状态后重试。"
                        .to_string(),
                );
                snapshot.pending_approval = None;
            });
            let snapshot = self.handle.snapshot();
            let mut event = AgentEvent::new(&self.task_id, "failed");
            event.message = snapshot.error.clone();
            event.cwd = Some(snapshot.cwd.clone());
            emit(&self.app, event);
        }
        self.state.ai_reviews.forget(&self.task_id);
        self.state.agents.finish(&self.task_id);
    }
}

/// 启动一个 Agent 任务（立刻返回初始快照；真正的循环在后台跑）。
pub async fn spawn_agent(
    app: AppHandle,
    state: AppState,
    mut input: AgentInput,
) -> Result<AgentSnapshot, String> {
    if input.task_id.trim().is_empty() {
        return Err("taskId 不能为空".to_string());
    }
    if input.session_id.trim().is_empty() {
        return Err("没有可用的 SSH 会话".to_string());
    }
    if !state.ssh.is_connected(&input.session_id).await {
        return Err("SSH 会话已断开，先重新连接再让 AI 操作服务器".to_string());
    }
    // 防切服务器误发：库里的会话绑定必须与前端声明的服务器一致。
    verify_session_server(&state, &input.session_id, &input.server)?;
    let config = {
        let conn = state.db.open().map_err(|error| error.to_string())?;
        crate::db::provider_for(&conn, input.provider_id.as_deref())
            .map_err(|error| error.to_string())?
            .ok_or_else(|| match input.provider_id.as_deref() {
                // 指定的模型被停用/删除了：明确说出来，不静默换回默认。
                Some(_) => "选择的模型已停用或被删除，请重新选择".to_string(),
                None => "还没有配置 AI 模型".to_string(),
            })?
    };
    let model = config.model.clone();
    // 能力以**这条配置**为准：内置表 + 用户声明的窗口 / 档位。
    // 命令层不传这份值，避免前端与库里的配置各说一套。
    input.capability = config.capability_override();
    // 档位在**启动时**定下来：同一次运行里的工具续请求不会再变。
    let reasoning_effort = crate::deployment::ai::resolve_effort_with(
        &model,
        input.capability.as_ref(),
        input.reasoning_effort.as_deref(),
    );
    // 行为段用的是**解析后**的档位；请求参数仍由 `LiveIo` 带着同一份值。
    let guidance_effort = reasoning_effort.clone();
    let api_key = crate::keyring::read_secret(&config.keyring_account())
        .map_err(|_| "这个提供方还没有保存可用的 API Key".to_string())?;
    let advisor =
        OpenAiCompatibleAdvisor::new(config, api_key).map_err(|error| error.user_message())?;

    /*
     * **先查重，再登记取消令牌**。
     *
     * `AiReviewRegistry::register` 会覆盖同名条目的令牌：如果同一个 taskId 还在
     * 跑，这里再登记一次就会把**正在运行**那一份的取消令牌换掉 —— 前端点停止
     * 只取消新令牌，旧循环永远停不下来。
     */
    if let Some(existing) = state.agents.get(&input.task_id) {
        if !existing.snapshot().terminal() {
            return Err("这条任务还在执行，等它结束或先停止".to_string());
        }
    }

    // 与 `ai_chat_cancel` 共用注册表：前端点停止仍然只需一个命令。
    let cancel = state.ai_reviews.register(&input.task_id);
    let mut snapshot = AgentSnapshot::new(
        &input.task_id,
        &input.server,
        &input.session_id,
        &input.cwd,
        &model,
    );
    // 恢复执行：把上次的步骤带进快照，界面/历史不会从 0 步重新开始。
    snapshot.steps = input.carry_steps.clone();
    snapshot.plan = input.carry_plan.clone();
    snapshot.plan_required = input.plan_required;
    snapshot.effort = reasoning_effort.clone();
    let Some(handle) = state.agents.register(snapshot.clone(), cancel) else {
        state.ai_reviews.forget(&input.task_id);
        return Err("这条任务还在执行，等它结束或先停止".to_string());
    };

    let task_id = input.task_id.clone();
    let registry = state.agents.clone();
    let app_for_run = app.clone();
    tauri::async_runtime::spawn(async move {
        // 先武装兜底：`run_loop` panic 时这一层还在，句柄不会停在 running。
        let mut guard = RunGuard {
            app: app_for_run.clone(),
            state: state.clone(),
            handle: handle.clone(),
            task_id: task_id.clone(),
            armed: true,
        };
        let io = LiveIo {
            app: &app_for_run,
            state: &state,
            advisor: &advisor,
            reasoning_effort,
        };
        let outcome = run_loop(&guard.handle, &input, &io, guidance_effort.as_deref()).await;
        let (kind, message) = match outcome {
            Ok(content) => {
                handle.update(|snapshot| {
                    snapshot.status = "success".to_string();
                    snapshot.content = content.clone();
                    snapshot.error = None;
                });
                ("finished", None)
            }
            Err(StopReason::Cancelled(message)) => {
                handle.update(|snapshot| {
                    snapshot.status = "cancelled".to_string();
                    snapshot.error = Some(message.clone());
                });
                ("cancelled", Some(message))
            }
            Err(StopReason::Failed(message)) => {
                handle.update(|snapshot| {
                    snapshot.status = "failed".to_string();
                    snapshot.error = Some(message.clone());
                });
                ("failed", Some(message))
            }
        };
        /*
         * 终态收尾：计划里还在执行 / 等确认的步骤不能永远停在"进行中"。
         * 成功时把最后一步收成完成；失败 → 失败；停止 → 跳过。
         */
        handle.update(|snapshot| {
            if let Some(plan) = snapshot.plan.as_mut() {
                let terminal_state = match snapshot.status.as_str() {
                    "success" => "done",
                    "failed" => "failed",
                    _ => "skipped",
                };
                for step in plan.steps.iter_mut() {
                    if step.state == "running" || step.state == "waiting" {
                        step.state = terminal_state.to_string();
                    }
                }
                plan.updated_at = crate::db::AppDb::now();
            }
        });
        let snapshot = handle.snapshot();
        let mut event = AgentEvent::new(&task_id, kind);
        event.message = message;
        event.content = (kind == "finished").then_some(snapshot.content.clone());
        event.model = (kind == "finished").then_some(snapshot.model.clone());
        event.cwd = Some(snapshot.cwd);
        event.outcome = snapshot.outcome.clone();
        event.context = snapshot.context;
        event.plan = snapshot.plan.clone();
        emit(&app_for_run, event);
        // 正常收尾已经写过终态：不要让 Drop 再补一条 failed 事件。
        guard.armed = false;
        state.ai_reviews.forget(&task_id);
        registry.finish(&task_id);
    });

    Ok(snapshot)
}

/// 会话 → 服务器绑定校验。
///
/// `ssh_sessions` 里记着这条会话连的是哪台（名字 / 主机）。前端声明的
/// `server` 与它不一致时**直接拒绝**：切服务器后旧面板还在发命令，是最容易
/// 把 `rm` 打到生产机上的路径。
fn verify_session_server(state: &AppState, session_id: &str, server: &str) -> Result<(), String> {
    let server = server.trim();
    if server.is_empty() {
        return Ok(());
    }
    let Ok(conn) = state.db.open() else {
        // 库打不开不在这里拦：`is_connected` 仍是硬门。
        return Ok(());
    };
    let row = conn.query_row(
        "SELECT server_name, server_host FROM ssh_sessions WHERE id = ?1",
        [session_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    match row {
        Ok((name, host)) => {
            let name = name.trim();
            if name.is_empty() || name == server || host.trim() == server {
                Ok(())
            } else {
                Err(format!(
                    "会话属于「{name}」，不是「{server}」；已拒绝执行，避免把命令发错机器"
                ))
            }
        }
        // 没有会话记录（极简环境 / 测试）：不额外拦，交给连接状态判断。
        Err(_) => Ok(()),
    }
}

/// 估算一段文字的 token 数。
///
/// 保守估算：ASCII 4 字符算 1 token，非 ASCII 1 字符算 1 token（中文与
/// JSON 转义都偏保守）。**宁可少带一点历史，也不要请求飞出窗口。**
fn estimate_text_tokens(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            other += 1;
        }
    }
    ascii / 4 + other
}

/// 估算一条消息的 token 数（正文、`tool_calls` 参数一起算）。
pub(crate) fn estimate_tokens(value: &Value) -> usize {
    match value {
        Value::String(text) => estimate_text_tokens(text),
        Value::Array(items) => items.iter().map(estimate_tokens).sum(),
        Value::Object(fields) => fields
            .iter()
            .map(|(key, item)| estimate_text_tokens(key) + estimate_tokens(item))
            .sum(),
        Value::Number(_) | Value::Bool(_) => 1,
        Value::Null => 0,
    }
}

fn has_tool_calls(message: &Value) -> bool {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|list| !list.is_empty())
}

/// 消息的**不可拆分单元**。
///
/// `assistant(tool_calls)` 与它后面连续的 `role: tool` 必须同进同出：只留一半
/// 会让接口判成「找不到 tool_call_id」，直接 400。其余每条消息各成一组。
fn conversation_units(messages: &[Value]) -> Vec<std::ops::Range<usize>> {
    let mut units = Vec::new();
    let mut index = 0usize;
    while index < messages.len() {
        if has_tool_calls(&messages[index]) {
            let mut end = index + 1;
            while end < messages.len()
                && messages[end].get("role").and_then(Value::as_str) == Some("tool")
            {
                end += 1;
            }
            units.push(index..end);
            index = end;
        } else {
            units.push(index..index + 1);
            index += 1;
        }
    }
    units
}

/// 单条消息超过预算时保留尾部（报错与结论通常在最后），并标出省略。
fn clamp_unit(messages: &mut [Value], range: std::ops::Range<usize>, budget_tokens: usize) {
    // 至少留 1 KB：再少就等于这条消息没发。
    let limit = budget_tokens.max(1024);
    for message in &mut messages[range] {
        let Some(content) = message.get("content").and_then(Value::as_str) else {
            continue;
        };
        if content.len() <= limit {
            continue;
        }
        let (clipped, cut) = tail_truncate(content, limit);
        message["content"] = Value::String(if cut {
            format!("…（内容过长，以下为尾部）\n{clipped}")
        } else {
            clipped
        });
    }
}

/// 一次裁剪的结果：从多少 token 压到多少、用了哪几级手段。
///
/// 前端凭它显示"已用 / 预算"，排查"模型怎么忘了前面"时也能看到折了多少。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    pub before_tokens: usize,
    pub after_tokens: usize,
    /// L1 瘦身掉的旧工具结果条数。
    pub slimmed: usize,
    /// L2 折叠进 system 摘要的早期单元数。
    pub folded: usize,
    /// L3 丢弃的单元数。
    pub dropped_units: usize,
}

/// 最近几个单元不参与 L1 瘦身与 L3 丢弃（L2 仍可折叠，否则预算极小时永远降不下来）。
const KEEP_RECENT_UNITS: usize = 4;
/// L1：旧工具结果保留的首尾行数。
const SLIM_HEAD_LINES: usize = 10;
const SLIM_TAIL_LINES: usize = 10;
/// 早期摘要的固定前缀：既拼进 system，也用来判断"已经折过了"。
const SUMMARY_PREFIX: &str = "【早期摘要】";

fn conversation_tokens(messages: &[Value]) -> usize {
    messages.iter().map(estimate_tokens).sum()
}

fn role_of(message: &Value) -> &str {
    message.get("role").and_then(Value::as_str).unwrap_or("")
}

/// 第一行（摘要只需要"大概在做什么"），按字符截断，避免切在 UTF-8 中间。
fn first_line(text: &str, max: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    line.chars().take(max).collect()
}

/// 最后一行（结论通常在最后）。
fn last_line(text: &str, max: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .unwrap_or("");
    line.chars().take(max).collect()
}

/// L1：旧工具结果只留首尾各 10 行。
///
/// 头行带 `exit` / `cwd`，尾部依次是 stderr 与结论，两段都原样保留；
/// 中间只写 `…（省略 N 行）…`。最近 [`KEEP_RECENT_UNITS`] 个单元不动。
fn slim_old_tool_results(messages: &mut [Value]) -> usize {
    let units = conversation_units(messages);
    let keep_from = units.len().saturating_sub(KEEP_RECENT_UNITS);
    let mut slimmed = 0;
    for unit in units.iter().take(keep_from) {
        for message in &mut messages[unit.clone()] {
            if role_of(message) != "tool" {
                continue;
            }
            let Some(content) = message.get("content").and_then(Value::as_str) else {
                continue;
            };
            if let Some(next) = slim_tool_content(content) {
                message["content"] = Value::String(next);
                slimmed += 1;
            }
        }
    }
    slimmed
}

fn slim_tool_content(content: &str) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= SLIM_HEAD_LINES + SLIM_TAIL_LINES + 1 {
        return None;
    }
    let omitted = lines.len() - SLIM_HEAD_LINES - SLIM_TAIL_LINES;
    let mut kept: Vec<String> = Vec::with_capacity(SLIM_HEAD_LINES + SLIM_TAIL_LINES + 1);
    kept.extend(
        lines[..SLIM_HEAD_LINES]
            .iter()
            .map(|line| (*line).to_string()),
    );
    kept.push(format!("…（省略 {omitted} 行）…"));
    kept.extend(
        lines[lines.len() - SLIM_TAIL_LINES..]
            .iter()
            .map(|line| (*line).to_string()),
    );
    Some(kept.join("\n"))
}

/// 从工具结果头行读 `exit="N"`（摘要里要给退出码）。
fn exit_code_of(content: &str) -> Option<String> {
    let start = content.find("exit=\"")? + "exit=\"".len();
    let rest = &content[start..];
    let end = rest.find('"')?;
    let code = rest[..end].trim();
    if code.is_empty() {
        None
    } else {
        Some(code.to_string())
    }
}

/// 把一个单元压成一行摘要：`轮次范围 · 工具与命令首行 · 退出码 · 结论行`。
///
/// 用**抽取式**而不是再发一次模型请求：离线可测、零延迟、零费用，也不会
/// 让摘要本身变成新的幻觉来源。
fn summary_line(messages: &[Value], start_no: usize, end_no: usize) -> String {
    let mut tools: Vec<String> = Vec::new();
    let mut exits: Vec<String> = Vec::new();
    let mut conclusion = String::new();
    for message in messages {
        let content = message.get("content").and_then(Value::as_str).unwrap_or("");
        match role_of(message) {
            "assistant" => {
                if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        let name = call["function"]["name"].as_str().unwrap_or("tool");
                        let args = call["function"]["arguments"].as_str().unwrap_or("");
                        let head = first_line(args, 80);
                        tools.push(if head.is_empty() {
                            name.to_string()
                        } else {
                            format!("{name} {head}")
                        });
                    }
                }
                if !content.trim().is_empty() {
                    conclusion = last_line(content, 120);
                }
            }
            "tool" => {
                if let Some(code) = exit_code_of(content) {
                    exits.push(code);
                }
                if conclusion.is_empty() {
                    conclusion = last_line(content, 120);
                }
            }
            "user" => {
                if conclusion.is_empty() {
                    conclusion = first_line(content, 120);
                }
            }
            _ => {}
        }
    }

    let mut line = format!("第{start_no}-{end_no}段");
    if !tools.is_empty() {
        line.push_str(" · ");
        line.push_str(&tools.join("；"));
    }
    if !exits.is_empty() {
        line.push_str(&format!(" · exit {}", exits.join("/")));
    }
    if !conclusion.is_empty() {
        line.push_str(" · ");
        line.push_str(&conclusion);
    }
    line
}

/// 把摘要行并进**第 0 条 system**（不新增消息）。
///
/// 新增一条 `role: system` 也能表达摘要，但会在 system 与 user 之间插一条
/// 不同角色的消息，且旧的角色序列回归会全部对不上。并进去既不破坏交替，
/// 也让"system 永远保留"这条规则自然覆盖摘要。
fn append_summary(conversation: &mut [Value], line: &str) {
    if role_of(&conversation[0]) != "system" {
        return;
    }
    let mut content = conversation[0]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if !content.contains(SUMMARY_PREFIX) {
        content.push_str("\n\n");
        content.push_str(SUMMARY_PREFIX);
    }
    content.push('\n');
    content.push_str(line);
    conversation[0]["content"] = Value::String(content);
}

/// L2：从最旧的完整单元开始折进摘要，直到预算装得下或没有可折的。
///
/// 只保护两处：**最新单元**（这一轮要发的东西）与**最后一条 user**（用户
/// 当前的问题）。被折的单元整组进摘要，不会留下孤立的 `role: tool`。
fn fold_old_units(messages: &mut Vec<Value>, budget_tokens: usize) -> usize {
    let mut folded = 0;
    loop {
        if conversation_tokens(messages) <= budget_tokens {
            break;
        }
        let Some(last_user) = messages
            .iter()
            .rposition(|message| role_of(message) == "user")
        else {
            break;
        };
        let units = conversation_units(messages);
        let candidate = units
            .iter()
            .enumerate()
            .find(|(index, unit)| {
                *index > 0
                    && unit.end < messages.len()
                    && !(unit.start..unit.end).contains(&last_user)
            })
            .map(|(index, unit)| (index, unit.clone()));
        let Some((index, unit)) = candidate else {
            break;
        };
        let line = summary_line(&messages[unit.clone()], index + 1, index + 1);
        append_summary(messages, &line);
        messages.drain(unit);
        folded += 1;
    }
    folded
}

/// L3：最后手段，从最旧的单元丢。
///
/// 永久保留：system（第 0 条，摘要也在里面）、最近 [`KEEP_RECENT_UNITS`]
/// 个单元、最后一条 `role: user`。
fn drop_old_units(messages: &mut Vec<Value>, budget_tokens: usize) -> usize {
    let mut dropped = 0;
    loop {
        if conversation_tokens(messages) <= budget_tokens {
            break;
        }
        let Some(last_user) = messages
            .iter()
            .rposition(|message| role_of(message) == "user")
        else {
            break;
        };
        let units = conversation_units(messages);
        let keep_from = units.len().saturating_sub(KEEP_RECENT_UNITS);
        let victim = units
            .iter()
            .take(keep_from)
            .find(|unit| unit.start > 0 && !(unit.start..unit.end).contains(&last_user))
            .cloned();
        let Some(unit) = victim else {
            break;
        };
        messages.drain(unit);
        dropped += 1;
    }
    dropped
}

/// 连"最近几单元"都放不下时，只截断最新单元的正文（配对仍然完整）。
fn clamp_last_unit(messages: &mut [Value], budget_tokens: usize) {
    let units = conversation_units(messages);
    let Some(last) = units.last().cloned() else {
        return;
    };
    let last_cost: usize = messages[last.clone()].iter().map(estimate_tokens).sum();
    let others = conversation_tokens(messages).saturating_sub(last_cost);
    let remaining = budget_tokens.saturating_sub(others);
    clamp_unit(messages, last, remaining);
}

/// 按 token 预算做**四级降级**：L0 原样 → L1 瘦身 → L2 折叠 → L3 丢弃。
///
/// 顺序固定：L1 最省 token 且不丢语义，L2 只损失细节，L3 才是丢历史。
/// 全程本地纯函数，不为压缩再发一次模型请求（延迟 / 费用 / 不可离线测试）。
pub(crate) fn prune_conversation(
    conversation: &mut Vec<Value>,
    budget_tokens: usize,
) -> PruneReport {
    let before_tokens = conversation_tokens(conversation);
    let mut report = PruneReport {
        before_tokens,
        after_tokens: before_tokens,
        ..Default::default()
    };
    if conversation.len() <= 1 || before_tokens <= budget_tokens {
        return report;
    }

    report.slimmed = slim_old_tool_results(conversation);
    if conversation_tokens(conversation) <= budget_tokens {
        report.after_tokens = conversation_tokens(conversation);
        return report;
    }

    report.folded = fold_old_units(conversation, budget_tokens);
    if conversation_tokens(conversation) <= budget_tokens {
        report.after_tokens = conversation_tokens(conversation);
        return report;
    }

    report.dropped_units = drop_old_units(conversation, budget_tokens);
    clamp_last_unit(conversation, budget_tokens);
    report.after_tokens = conversation_tokens(conversation);
    report
}

/// 本次任务是否"只查询"。
///
/// 判据是**最后一条真人 user 消息**（跳过 `【执行结果】` 这类平台回执）：
/// 明确说"只看 / 别改"→ 查询；出现改动动词（重启 / 删除 / 更新…）→ 修改；
/// 否则看到"查 / 看 / 状态 / 日志…"→ 查询；都没有则按修改处理（保守：范围
/// 不放大，但也不会把一次改动误判成查询）。
///
/// 这是执行器的硬边界：查询范围里写 / 改 / 删会被直接拦下，不靠模型自觉。
pub(crate) fn is_query_only(messages: &[AgentTurn]) -> bool {
    let Some(text) = last_human_text(messages) else {
        return false;
    };
    let lower = text.to_lowercase();
    // 明确限定范围：句子里就算有"更新"这类词也按查询。
    if ["只查", "只看", "只读", "不要改", "别改", "不要动", "别动"]
        .iter()
        .any(|word| lower.contains(word))
    {
        return true;
    }
    const MODIFY: &[&str] = &[
        "重启",
        "启动",
        "停止",
        "关闭",
        "删除",
        "删掉",
        "移除",
        "修改",
        "改成",
        "改一下",
        "改下",
        "调整",
        "修复",
        "修一下",
        "修好",
        "处理",
        "写入",
        "写到",
        "创建",
        "新建",
        "部署",
        "更新",
        "升级",
        "回滚",
        "清空",
        "清理",
        "上传",
        "安装",
        "卸载",
        "授权",
        "restart",
        "start",
        "stop",
        "reload",
        "install",
        "uninstall",
        "remove",
        "delete",
        "write",
        "create",
        "deploy",
        "update",
        "upgrade",
        "rollback",
        "chmod",
        "chown",
        "kill",
        "flush",
        "rm ",
    ];
    if MODIFY.iter().any(|word| lower.contains(word)) {
        return false;
    }
    const QUERY: &[&str] = &[
        "查",
        "看",
        "列出",
        "列一下",
        "哪些",
        "状态",
        "日志",
        "有没有",
        "是否",
        "检查",
        "分析",
        "诊断",
        "排查",
        "统计",
        "怎么样",
        "情况",
        "正常",
        "多少",
        "show",
        "list",
        "status",
        "log",
        "check",
        "inspect",
        "docker ps",
        "systemctl status",
        "ps ",
        "top",
        "df ",
        "du ",
        "grep",
        "cat ",
        "find",
    ];
    QUERY.iter().any(|word| lower.contains(word))
}

/// 最后一条**真人**用户消息（跳过 `【执行结果】` 这类平台回执）。
fn last_human_text(messages: &[AgentTurn]) -> Option<&str> {
    messages
        .iter()
        .rev()
        .find(|turn| turn.role == "user" && !turn.content.trim_start().starts_with('【'))
        .map(|turn| turn.content.as_str())
}

/// 任务目标：最后一条真人用户消息的首行（用量面板显示，截 120 字）。
fn task_goal(messages: &[AgentTurn]) -> String {
    let Some(text) = last_human_text(messages) else {
        return String::new();
    };
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    line.chars().take(120).collect()
}

/// 本次请求的构成：系统 / 历史 / 工具各占多少 token。
fn context_breakdown(messages: &[Value]) -> ContextBreakdown {
    let mut out = ContextBreakdown::default();
    for message in messages {
        let cost = estimate_tokens(message);
        match role_of(message) {
            "system" => out.system += cost,
            "tool" => out.tools += cost,
            "assistant" if has_tool_calls(message) => out.tools += cost,
            _ => out.history += cost,
        }
    }
    out
}

/**
 * 资源级串行：同一台服务器、同一个服务 / 目录 / 文件上的**写操作**排队。
 *
 * 只读查询不参与；不同资源（不同服务、不同路径）仍可并行。锁是进程内的，
 * 覆盖同一条 SSH 连接上的多条对话 —— 这正是"同一服务上两个任务不能同时改"
 * 需要拦住的场景。
 */
static RESOURCE_LOCKS: OnceLock<AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();

async fn acquire_resource(key: String) -> OwnedMutexGuard<()> {
    let map = RESOURCE_LOCKS.get_or_init(|| AsyncMutex::new(HashMap::new()));
    let lock = {
        let mut guard = map.lock().await;
        guard
            .entry(key)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    lock.lock_owned().await
}

/// 这次写操作落在哪个资源上：文件路径 > systemd 服务 > docker > 服务器 shell。
///
/// 粗粒度是有意的：拿不准具体资源时宁可多串行一条同服务器的写命令，也不让
/// 两个任务同时改同一处配置。
fn resource_key(input: &AgentInput, planned: &PlannedTool) -> String {
    let server = if input.server.is_empty() {
        input.session_id.as_str()
    } else {
        input.server.as_str()
    };
    let resource = planned.path.as_deref().map_or_else(
        || {
            let text = planned.display.to_lowercase();
            if let Some(rest) = text.strip_prefix("systemctl ") {
                let mut parts = rest.split_whitespace();
                let _ = parts.next();
                if let Some(unit) = parts.next() {
                    return format!("service:{unit}");
                }
            }
            if text.starts_with("docker ") {
                return "docker".to_string();
            }
            "shell".to_string()
        },
        // 同一目录下的写操作算同一资源（部署目录、配置目录）。
        |path| match path.rfind('/') {
            Some(0) => "/".to_string(),
            Some(index) => path[..index].to_string(),
            None => path.to_string(),
        },
    );
    format!("{server}\u{1}{resource}")
}

/// 同一次运行的"操作"标识：同一操作只问一次，换个写法也不再问。
///
/// 不直接拿原始命令：`rm /opt/a`、`rm -f /opt/a`、`sudo rm /opt/a` 是同一件事。
/// 先把 `cd … &&` 前缀、`sudo` 与 `-x` 这类参数去掉，再拼命令名与目标。
/// 审批身份。
///
/// * 能可靠解析的归档操作：归档路径、目标目录、覆盖策略（大小写敏感）；
/// * 其他操作：**精确的用户可读命令**，不再去掉参数 / 小写化。Linux 路径与
///   覆盖策略不能靠模糊文本混为一谈。
fn operation_signature(planned: &PlannedTool, cwd: &str) -> String {
    // MCP 工具的"同一次操作"必须带上参数：同一个工具查 A 和删 B 不是一件事。
    if let Some(binding) = &planned.mcp {
        return format!(
            "mcp\u{1}{}\u{1}{}\u{1}{}",
            binding.server_id,
            binding.tool,
            serde_json::to_string(&planned.call.args).unwrap_or_default()
        );
    }
    if let Some(archive) = parse_archive_operation(&planned.display, cwd) {
        return archive.signature();
    }
    format!("{}\u{1}{}", planned.call.name, planned.display.trim())
}

/// 把前端传来的消息整理成 OpenAI 兼容的会话：合并 system，再追加工具说明、
/// 思考强度与任务范围。
///
/// `effort` 传的是 [`crate::deployment::ai::resolve_effort`] **已解析**的档位
/// （`max` 已按模型收敛）；这里不再解读 `input.reasoning_effort` 原值，避免
/// "界面选 MAX、模型只支持 high，行为段却按 max"这种错位。
fn conversation(input: &AgentInput, effort: Option<&str>, query_only: bool) -> Vec<Value> {
    let lang = Lang::from_locale(input.locale.as_deref());
    // 回复语言是独立偏好：界面可以是英文，但用户要求用中文回答。
    let reply_lang = match input.reply_language.as_deref() {
        Some(value) if value.eq_ignore_ascii_case("en") => Lang::En,
        Some(value) if value.eq_ignore_ascii_case("zh") => Lang::Zh,
        _ => lang,
    };
    let mut system = String::new();
    let mut turns: Vec<Value> = Vec::new();
    for turn in &input.messages {
        if turn.role == "system" {
            system.push_str(&turn.content);
            system.push('\n');
        } else if turn.role == "user" || turn.role == "assistant" {
            turns.push(json!({ "role": turn.role, "content": turn.content }));
        }
    }
    /*
     * 语言跟着界面走：英文界面下这三行也必须是英文，否则模型会把
     * "当前任务目录"当成本地约定，整段回答继续用中文。
     */
    let head = match lang {
        Lang::Zh => format!(
            "\n当前任务目录：{}\n服务器：{}\n当前时间：{}\n",
            input.cwd,
            input.server,
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        ),
        Lang::En => format!(
            "\nTask directory: {}\nServer: {}\nCurrent time: {}\n",
            input.cwd,
            input.server,
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        ),
    };
    system.push_str(&head);
    system.push_str(tool_prompt(lang));
    system.push('\n');
    system.push_str(thinking_guidance(effort, lang));
    system.push('\n');
    // 执行前说明：MAX 与普通模式都适用（先说什么、验证什么）。
    system.push_str(preamble_guidance(lang));
    system.push('\n');
    if input.plan_required {
        system.push_str(plan_guidance(lang));
        system.push('\n');
    }
    if let Some(plan) = input.carry_plan.as_ref() {
        system.push_str(&plan_status_block(plan, lang));
    }
    system.push_str(intent_guidance(lang));
    if query_only {
        system.push_str(match lang {
            Lang::Zh => {
                "\n【本次任务范围：只查询】只允许只读工具与只读命令；写 / 改 / 删会被执行器直接拦下，不要尝试。\n"
            }
            Lang::En => {
                "\n[Task scope: query only] Only read-only tools and read-only commands are allowed; any write / edit / delete is blocked by the executor. Do not attempt it.\n"
            }
        });
    }
    // 放最后：模型对末尾指令最敏感，前面的中英混杂材料不能把回复语言带偏。
    system.push('\n');
    system.push_str(reply_language_rule(reply_lang));
    let mut out = vec![json!({ "role": "system", "content": system })];
    out.extend(turns);
    out
}

/// 一条步骤的可读标签（证据列表用）。
fn step_label(step: &AgentStep) -> String {
    let what = if !step.command.trim().is_empty() {
        first_line(&step.command, 60)
    } else if let Some(path) = step.path.as_deref() {
        path.to_string()
    } else {
        step.tool.clone()
    };
    format!("#{} {what}", step.index + 1)
}

/// 由**真实步骤**判断任务结论，而不是由"模型回了话"判断。
///
/// 规则：
/// * 有成功的写入 / 修改，但之后没有任何成功的只读步骤 → `partial`
///   （部署 / 排障里"改完没验证"最危险，不能算已验证）；
/// * 没有任何成功步骤（或只读任务一步都没跑）→ `needs_info`；
/// * 最后一次失败之后没有成功步骤 → `partial`（结论只覆盖了前面成功的部分）；
/// * 其余 → `verified`，证据取写入与验证步骤的命令首行。
pub(crate) fn evaluate_outcome(
    steps: &[AgentStep],
    query_only: bool,
    lang: Lang,
) -> Option<AgentOutcome> {
    let en = matches!(lang, Lang::En);
    if steps.is_empty() {
        // 一步都没跑：纯问答不需要"验证"标签；只读任务则明确说没有证据。
        return query_only.then(|| {
            AgentOutcome::needs_info(
                if en {
                    "No read-only checks were run: this conclusion has no server evidence."
                } else {
                    "没有执行任何只读检查：这句话没有服务器证据，不能当作结论。"
                },
                Vec::new(),
            )
        });
    }
    let succeeded: Vec<&AgentStep> = steps
        .iter()
        .filter(|step| step.state == "success")
        .collect();
    let writes: Vec<&AgentStep> = succeeded
        .iter()
        .copied()
        .filter(|step| step.risk != "read")
        .collect();
    let last_write = writes.iter().map(|step| step.index).max();
    let verified_after_writes = last_write.is_none_or(|last| {
        succeeded
            .iter()
            .any(|step| step.index > last && step.risk == "read")
    });

    let mut evidence: Vec<String> = writes
        .iter()
        .rev()
        .take(3)
        .map(|step| step_label(step))
        .collect();
    if let Some(check) = last_write.and_then(|last| {
        succeeded
            .iter()
            .filter(|step| step.index > last && step.risk == "read")
            .next_back()
    }) {
        evidence.push(step_label(check));
    }

    if !writes.is_empty() && !verified_after_writes {
        return Some(AgentOutcome::partial(
            if en {
                "Changes were applied, but no read-only verification followed."
            } else {
                "改动已经执行，但之后没有只读验证步骤。"
            },
            evidence,
        ));
    }
    if succeeded.is_empty() {
        return Some(AgentOutcome::needs_info(
            if en {
                "Every step failed; the conclusion has no server evidence."
            } else {
                "所有步骤都没有成功，结论缺少服务器证据。"
            },
            steps
                .iter()
                .rev()
                .take(3)
                .map(|step| step_label(step))
                .collect(),
        ));
    }
    let last_failure = steps
        .iter()
        .filter(|step| step.state == "failed")
        .map(|step| step.index)
        .max();
    let recovered = last_failure.is_none_or(|last| {
        steps
            .iter()
            .any(|step| step.index > last && step.state == "success")
    });
    if !recovered {
        return Some(AgentOutcome::partial(
            if en {
                "Nothing succeeded after the last failure, so the conclusion covers only the completed part."
            } else {
                "最后一次失败之后没有成功步骤，结论只覆盖了已完成的部分。"
            },
            evidence,
        ));
    }

    Some(AgentOutcome::verified(
        match (writes.is_empty(), en) {
            (true, false) => "结论来自只读命令的真实输出。",
            (true, true) => "Verified against the real output of read-only commands.",
            (false, false) => "改动后做了只读验证。",
            (false, true) => "Verified with read-only checks after the change.",
        },
        evidence,
    ))
}

// ---------------------------------------------------------------------------
// 文件变更：预览 → 版本核对 → 写入 → 回读
//
// 事实来源只有两个：**服务器上读到的内容**与**这次工具调用提交的内容**。
// 模型回复里的文件名 / 行数 / Markdown Diff 一律不采信。
// ---------------------------------------------------------------------------

fn emit_change(io: &dyn AgentIo, task_id: &str, summary: FileChangeSummary) {
    let mut event = AgentEvent::new(task_id, "file_change");
    event.change_id = Some(summary.id.clone());
    event.change = Some(summary);
    io.emit(event);
}

fn change_draft(
    input: &AgentInput,
    planned: &PlannedTool,
    step_index: u32,
    call_id: &str,
    id: &str,
    path: &str,
) -> ChangeDraft {
    ChangeDraft {
        id: id.to_string(),
        task_id: input.task_id.clone(),
        call_id: call_id.to_string(),
        step_index,
        workspace_id: input.workspace_id.clone(),
        server_id: input.server_id.clone(),
        server: input.server.clone(),
        tool: planned.call.name.clone(),
        path: path.to_string(),
    }
}

/// 落一条"拟修改"：`before` 是刚读到的服务器原文，`proposed` 是这次提交的新内容。
fn store_preview(
    registry: &ChangeRegistry,
    draft: ChangeDraft,
    before: FileSnapshot,
    proposed: &str,
    planned: &PlannedTool,
) -> String {
    let id = draft.id.clone();
    // 提交内容同样过一遍脱敏：Diff 里不能出现明文密码 / 私钥。
    let (sanitized, touched) = sanitize(proposed);
    let touched = touched || before.redacted;
    // 规范路径（符号链接已解析）：文件头显示的就是服务器上真正被读的那个文件。
    let canonical = before.path.clone();
    registry.create(draft, "proposed", "proposed");
    registry.update(&id, |record| {
        if !canonical.is_empty() {
            record.path = canonical.clone();
        }
        record.before = Some(before);
        record.proposed = sanitized;
        record.redacted = touched;
        record.backup_path = planned.backup_path.clone();
        // 列表要显示 +N / -N：内容定下来时算一次，别在每次列表查询里重算。
        record.recount();
    });
    id
}

/// 写文件前的预览。返回 `None` = 当前 IO 不支持快照，不生成变更记录。
async fn create_preview(
    io: &dyn AgentIo,
    input: &AgentInput,
    planned: &PlannedTool,
    step_index: u32,
    call_id: &str,
) -> Option<String> {
    let path = planned.path.as_deref()?;
    let content = planned.write_content.as_deref()?;
    let registry = io.changes();
    let id = uuid::Uuid::new_v4().to_string();
    match io.read_snapshot(&input.session_id, path).await {
        Ok(None) => return None,
        Ok(Some(snapshot)) => {
            store_preview(
                &registry,
                change_draft(input, planned, step_index, call_id, &id, path),
                snapshot,
                content,
                planned,
            );
        }
        Err(reason) => {
            // 读不到原文：**不生成 Diff**，但把原因如实记下来。
            let (sanitized, _) = sanitize(content);
            registry.create(
                change_draft(input, planned, step_index, call_id, &id, path),
                "unavailable",
                "none",
            );
            registry.update(&id, |record| {
                record.proposed = sanitized;
                record.backup_path = planned.backup_path.clone();
                record.note = Some(format!("未能读取修改前的文件：{reason}"));
            });
        }
    }
    let summary = registry.get(&id)?;
    emit_change(io, &input.task_id, summary);
    Some(id)
}

enum PreviewCheck {
    /// 版本没变，可以按用户确认的那一份执行。
    Verified,
    /// 文件在确认前被外部改过：旧预览作废，已按当前内容生成新预览。
    Regenerated { change_id: String, call_id: String },
    /// 连版本都核对不了：不放行。
    Failed(String),
}

/// 用户确认后、真正写入前再核对一次文件版本。
async fn verify_preview(
    io: &dyn AgentIo,
    input: &AgentInput,
    planned: &PlannedTool,
    change_id: &str,
    attempt: u32,
) -> PreviewCheck {
    let registry = io.changes();
    let Some(record) = registry.record(change_id) else {
        return PreviewCheck::Verified;
    };
    let Some(path) = planned.path.as_deref() else {
        return PreviewCheck::Verified;
    };
    // 预览本来就没读到原文：没有可核对的基准，不在这里拦。
    let Some(before) = record.before.clone() else {
        return PreviewCheck::Verified;
    };
    let current = match io.read_snapshot(&input.session_id, path).await {
        Ok(None) => return PreviewCheck::Verified,
        Ok(Some(snapshot)) => snapshot,
        Err(reason) => {
            return PreviewCheck::Failed(format!(
                "确认前无法重新核对文件版本：{reason}。这一步没有执行，请重新发起修改"
            ))
        }
    };
    if before.exists == current.exists && before.sha == current.sha {
        return PreviewCheck::Verified;
    }

    // 旧确认只能用于它当时看到的那一版：作废并生成新预览。
    registry.update(change_id, |item| {
        item.status = "stale".to_string();
        item.note = Some("文件在确认前被外部修改，这份预览已作废".to_string());
    });
    if let Some(summary) = registry.get(change_id) {
        emit_change(io, &input.task_id, summary);
    }

    let new_id = uuid::Uuid::new_v4().to_string();
    let new_call = format!("{}-r{}", record.call_id, attempt + 1);
    store_preview(
        &registry,
        change_draft(input, planned, record.step_index, &new_call, &new_id, path),
        current,
        &record.proposed,
        planned,
    );
    if let Some(summary) = registry.get(&new_id) {
        emit_change(io, &input.task_id, summary);
    }
    PreviewCheck::Regenerated {
        change_id: new_id,
        call_id: new_call,
    }
}

/// 写入之后：**重新回读**服务器文件，用 before 与 actualAfter 生成实际 Diff。
async fn finish_change(
    io: &dyn AgentIo,
    input: &AgentInput,
    change_id: &str,
    planned: &PlannedTool,
    write_ok: bool,
    failure: Option<&str>,
    backup: Option<&str>,
) {
    let registry = io.changes();
    let Some(record) = registry.record(change_id) else {
        return;
    };
    let backup_path = backup
        .map(str::to_string)
        .or_else(|| planned.backup_path.clone());
    // `cp` 的标记只在备份真的成功后才打印：有标记 = 备份确实存在。
    let backup_verified = backup.is_some();
    // 变更面板的说明文字也跟界面语言走（英文界面下不该冒出中文 note）。
    let en = matches!(Lang::from_locale(input.locale.as_deref()), Lang::En);

    if !write_ok {
        registry.update(change_id, |record| {
            record.status = "write_failed".to_string();
            record.note = Some(match failure {
                Some(reason) if !reason.trim().is_empty() => {
                    if en {
                        format!(
                            "Write failed: {}; the server file was not changed.",
                            reason.trim()
                        )
                    } else {
                        format!(
                            "写入失败：{}；服务器上的文件没有被这次写入改动",
                            reason.trim()
                        )
                    }
                }
                _ => {
                    if en {
                        "Write failed: the server file was not changed.".to_string()
                    } else {
                        "写入失败：服务器上的文件没有被这次写入改动".to_string()
                    }
                }
            });
            record.backup_path = backup_path.clone();
            record.backup_verified = backup_verified;
        });
        if let Some(summary) = registry.get(change_id) {
            emit_change(io, &input.task_id, summary);
        }
        return;
    }

    // 原文没读到（预览就已经是 unavailable）：写入可能成功了，但没有基准就
    // 不能生成"全新增"的假 Diff，保持"未采集"并写明原因。
    if record.before.is_none() {
        registry.update(change_id, |item| {
            item.stage = "none".to_string();
            item.status = "unavailable".to_string();
            item.note = Some(
                if en {
                    "Could not read the file before the write, so the actual change cannot be proven (the write may have applied — verify with Remote files)."
                } else {
                    "未能读取修改前的内容，无法证明实际改动了什么（写入可能已生效，请用远程文件核对）"
                }
                    .to_string(),
            );
            item.backup_path = backup_path.clone();
            item.backup_verified = backup_verified;
        });
        if let Some(summary) = registry.get(change_id) {
            emit_change(io, &input.task_id, summary);
        }
        return;
    }

    let Some(path) = planned.path.as_deref() else {
        return;
    };
    match io.read_snapshot(&input.session_id, path).await {
        Ok(Some(snapshot)) if snapshot.exists => {
            let before = record.before.clone();
            let unchanged = before.is_some_and(|item| item.exists && item.sha == snapshot.sha);
            registry.update(change_id, |record| {
                record.stage = "actual".to_string();
                record.status = if unchanged { "unchanged" } else { "written" }.to_string();
                record.actual = Some(snapshot);
                record.backup_path = backup_path.clone();
                record.backup_verified = backup_verified;
                record.note = unchanged.then(|| {
                    if en {
                        "Write finished, but the read-back matched the file as it already was."
                    } else {
                        "回读内容与写入前一致：这次没有产生改动"
                    }
                    .to_string()
                });
                record.recount();
            });
        }
        Ok(Some(_)) => {
            registry.update(change_id, |record| {
                record.stage = "none".to_string();
                record.status = "readback_failed".to_string();
                record.note = Some(
                    if en {
                        "Target file missing after the write: the server content cannot be proven."
                    } else {
                        "写入后目标文件不存在：无法证明服务器上的实际内容"
                    }
                    .to_string(),
                );
                record.backup_path = backup_path.clone();
                record.backup_verified = backup_verified;
            });
        }
        Ok(None) => {
            registry.update(change_id, |record| {
                record.stage = "none".to_string();
                record.status = "unavailable".to_string();
                record.note = Some(if en {
                    "Read-back is not supported in this environment; actual content cannot be proven."
                } else {
                    "当前环境不支持回读，无法证明实际内容"
                }
                    .to_string());
                record.backup_path = backup_path.clone();
                record.backup_verified = backup_verified;
            });
        }
        Err(reason) => {
            registry.update(change_id, |record| {
                record.stage = "none".to_string();
                record.status = "readback_failed".to_string();
                record.note = Some(if en {
                    format!("Write was sent, but read-back failed: {reason}")
                } else {
                    format!("写入已发送，但回读失败：{reason}")
                });
                record.backup_path = backup_path.clone();
                record.backup_verified = backup_verified;
            });
        }
    }
    if let Some(summary) = registry.get(change_id) {
        emit_change(io, &input.task_id, summary);
    }
}

/// 普通 shell 的写操作：没有明确目标与前后快照 → 如实标注"未采集文件差异"。
fn record_uncollected(
    io: &dyn AgentIo,
    input: &AgentInput,
    planned: &PlannedTool,
    step_index: u32,
    call_id: &str,
) {
    let registry = io.changes();
    let id = uuid::Uuid::new_v4().to_string();
    let draft = change_draft(
        input,
        planned,
        step_index,
        call_id,
        &id,
        planned.path.as_deref().unwrap_or(""),
    );
    registry.create(draft, "uncollected", "none");
    let command: String = planned.display.chars().take(200).collect();
    registry.update(&id, |record| {
        record.uncollected = true;
        record.note = Some(format!(
            "普通 shell 命令无法可靠取得明确目标与前后快照，该操作未采集文件差异：{command}"
        ));
    });
    if let Some(summary) = registry.get(&id) {
        emit_change(io, &input.task_id, summary);
    }
}

/// `run_shell` 写操作的**可确定目标**：执行前各读一份快照。
///
/// 解析不出目标时返回空表，调用方退回"未采集差异"的占位记录。
async fn shell_baseline(
    io: &dyn AgentIo,
    input: &AgentInput,
    planned: &PlannedTool,
    base_cwd: &str,
) -> Vec<(String, FileSnapshot)> {
    if planned.call.name != "run_shell" {
        return Vec::new();
    }
    let mut out = Vec::new();
    for path in super::tools::shell_write_targets(&planned.display, base_cwd) {
        if let Ok(Some(snapshot)) = io.read_snapshot(&input.session_id, &path).await {
            out.push((path, snapshot));
        }
    }
    out
}

/// 执行后回读 shell 目标，落成真实 Diff（`before` 来自执行前）。
async fn record_shell_changes(
    io: &dyn AgentIo,
    input: &AgentInput,
    planned: &PlannedTool,
    step_index: u32,
    call_id: &str,
    baseline: Vec<(String, FileSnapshot)>,
    ok: bool,
    failure: Option<&str>,
) {
    if baseline.is_empty() {
        return;
    }
    let registry = io.changes();
    for (path, before) in baseline {
        let readback = io.read_snapshot(&input.session_id, &path).await;
        let after = readback.as_ref().ok().and_then(|item| item.clone());
        let unchanged = after
            .as_ref()
            .is_some_and(|snapshot| snapshot.exists && before.exists && snapshot.sha == before.sha);
        let status = if !ok {
            "write_failed"
        } else if readback.is_err() {
            "readback_failed"
        } else if unchanged {
            "unchanged"
        } else {
            "written"
        };
        let id = uuid::Uuid::new_v4().to_string();
        registry.create(
            change_draft(input, planned, step_index, call_id, &id, &path),
            status,
            "actual",
        );
        registry.update(&id, |record| {
            record.before = Some(before.clone());
            match after.clone() {
                Some(snapshot) => record.actual = Some(snapshot),
                None => record.stage = "none".to_string(),
            }
            record.note = if !ok {
                Some(match failure {
                    Some(line) => format!("命令执行失败：{line}"),
                    None => "命令执行失败".to_string(),
                })
            } else if readback.is_err() {
                Some("写入后无法回读目标文件，不能证明实际改动".to_string())
            } else if unchanged {
                Some("命令执行后回读与执行前一致：这次没有产生改动".to_string())
            } else {
                None
            };
            record.recount();
        });
        if let Some(summary) = registry.get(&id) {
            emit_change(io, &input.task_id, summary);
        }
    }
}

pub(crate) async fn run_loop(
    handle: &AgentHandle,
    input: &AgentInput,
    io: &dyn AgentIo,
    resolved_effort: Option<&str>,
) -> Result<String, StopReason> {
    let started = Instant::now();
    let rounds = input.max_rounds.unwrap_or(MAX_ROUNDS).clamp(1, MAX_ROUNDS);
    // 备份策略在运行开始时定下来：中途改权限页不影响已发起的任务。
    let backup_policy = BackupPolicy {
        before_write: input.backup_before_write,
        before_delete: input.backup_before_delete,
        retention_days: input.backup_retention_days,
    };
    // 范围在**这次运行开始时**定下来：同一次运行里不随模型换说法漂移。
    let query_only = is_query_only(&input.messages);
    let mut conversation = conversation(input, resolved_effort, query_only);
    // 已表态的操作：true = 允许过，false = 拒绝过；两种都不再第二次弹确认。
    let mut decided_ops: HashMap<String, bool> = HashMap::new();
    // 用量归到**这个 taskId**：续跑时从上一段带过来，不重新从 0 开始。
    let goal = task_goal(&input.messages);
    let mut cumulative = input.carry_usage.clone().unwrap_or_default();
    let mut tool_calls: usize = 0;
    let lang = Lang::from_locale(input.locale.as_deref());
    // 计划跟着任务快照走：提交 / 恢复后马上用它校验工具归属。
    let mut plan = handle.snapshot().plan.clone();
    // 普通模式下的"操作组"：模型没写说明、连续几轮直接调命令时共用一句说明。
    let mut group_open: Option<String> = None;
    // 已经有过说明（模型自己写的或执行器补的）的操作组。
    let mut noted_groups: HashSet<String> = HashSet::new();
    /*
     * 本次运行里**已执行的操作**与结果。
     *
     * 同一操作（解压按归档 + 目标 + 覆盖策略识别，其他按精确命令）成功过，
     * 后续等价提交直接复用原结果，逼模型做只读验证而不是重复解压；
     * 失败最多重试一次，第二次失败就把真实退出码和错误摘要回给它。
     */
    let mut completed_ops: HashMap<String, (bool, String)> = HashMap::new();
    let mut op_attempts: HashMap<String, u32> = HashMap::new();
    /** 上一次归档操作：目标 / 覆盖策略变了要写在新的确认卡上。 */
    let mut last_archive: Option<ArchiveOperation> = None;
    // 续跑：新步骤从历史步骤之后编号，不能把旧步骤按 index 覆盖。
    let mut next_index: u32 = input
        .carry_steps
        .iter()
        .map(|step| step.index + 1)
        .max()
        .unwrap_or(0);
    let mut total_bytes: usize = 0;
    /// 改写后是否已经催过一次"先验证再收尾"（只催一次，避免来回拉扯）。
    let mut verification_nudged = false;
    // 预算来自**这次启动的模型**：切模型只影响下一条消息。
    let context_budget = crate::deployment::ai::context_budget_tokens_with(
        &handle.snapshot().model,
        input.capability.as_ref(),
        input.context_budget,
    );

    for round in 0..rounds {
        if handle.is_cancelled() {
            return Err(StopReason::Cancelled(
                "已停止（收到停止标记，当前命令已结束）".to_string(),
            ));
        }
        if started.elapsed() > Duration::from_secs(MAX_TOTAL_SECONDS) {
            return Err(StopReason::Failed(format!(
                "总时长超过 {} 分钟，已停止{}",
                MAX_TOTAL_SECONDS / 60,
                last_step_hint(handle)
            )));
        }

        /*
         * **运行中补的要求在这里生效**：下一步开始前追加成一条 user 消息。
         *
         * 不打断正在跑的命令（半截命令比多跑一条更危险），但这一轮之后的计划
         * 必须按新要求走。事件让其它窗口 / 重进后的界面也知道这条已生效。
         */
        for text in handle.take_steers() {
            conversation.push(json!({
                "role": "user",
                "content": format!("【任务更新】{text}"),
            }));
            let mut event = AgentEvent::new(&input.task_id, "steer_applied");
            event.content = Some(text);
            io.emit(event);
        }

        // 每轮发出前记一次裁剪结果：界面显示"已用 / 预算"，也方便回看丢了什么。
        let report = prune_conversation(&mut conversation, context_budget);
        let context = ContextUsage {
            budget: context_budget,
            used: report.after_tokens,
            report: report.clone(),
            cumulative: cumulative.clone(),
            breakdown: context_breakdown(&conversation),
            goal: goal.clone(),
            tool_calls,
        };
        handle.update(|snapshot| {
            snapshot.context = Some(context.clone());
        });
        let mut usage_event = AgentEvent::new(&input.task_id, "context_usage");
        usage_event.context = Some(context);
        io.emit(usage_event);
        /*
         * 正文**边生成边推**：同一条回复气泡逐段长出来，而不是等整段结束再
         * 一次性涌出。工具调用仍然在结束时汇总（流式协议里参数是分片的）。
         */
        let sink = io.sink();
        let delta_task = input.task_id.clone();
        let on_delta: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |delta: &str| {
            sink(AgentEvent::text_delta(&delta_task, delta));
        });
        let schemas = crate::mcp::append_tool_schemas(
            filter_tool_schemas(tool_schemas(input.plan_required), input.enabled_builtins.as_deref()),
            &input.mcp_tools,
            input.plan_required,
        );
        let reply = match io
            .chat(conversation.clone(), schemas, handle.cancel(), on_delta)
            .await
        {
            Ok(reply) => reply,
            Err(AiProviderError::Cancelled) if handle.is_cancelled() => {
                return Err(StopReason::Cancelled("已停止".to_string()));
            }
            Err(error) => return Err(StopReason::Failed(error.user_message())),
        };

        /*
         * 累计用量按**每次请求**相加：输入记这一轮真正发出去的估算，
         * 输出记正文 + 工具参数（两者都算模型产出）。同一段历史在下一轮
         * 会再次计入 —— 那正是"累计"和"当前上下文"分开显示的原因。
         */
        cumulative.requests += 1;
        cumulative.input_tokens += report.after_tokens;
        cumulative.output_tokens += estimate_tokens(&reply.message);
        handle.update(|snapshot| {
            if let Some(context) = snapshot.context.as_mut() {
                context.cumulative = cumulative.clone();
            }
        });

        /*
         * 两个来源统一成 `PendingCall`：
         * * 接口的 `tool_calls`（标准 function calling，模型不回文本也能调用）；
         * * 正文里的 `<tool>` / `invoke name="..."`（接口不支持工具时兜底）。
         */
        let native = !reply.tool_calls.is_empty();
        let mut calls: Vec<PendingCall> = if native {
            // assistant 消息必须**原样**回灌，否则后面的 `role: tool` 对不上。
            conversation.push(reply.message.clone());
            reply
                .tool_calls
                .iter()
                .enumerate()
                .map(|(index, call)| PendingCall {
                    id: if call.id.is_empty() {
                        format!("call-{round}-{index}")
                    } else {
                        call.id.clone()
                    },
                    name: call.name.clone(),
                    body: call.arguments.clone(),
                    native: true,
                })
                .collect()
        } else {
            parse_tool_calls(&reply.content)
                .into_iter()
                .map(|raw| PendingCall {
                    id: String::new(),
                    name: raw.name,
                    body: raw.body,
                    native: false,
                })
                .collect()
        };

        if calls.is_empty() {
            if looks_like_tool_call(&reply.content) {
                // 模型写了调用标记但解析不出来：不能当成"完成 0 步"。
                return Err(StopReason::Failed(
                    "模型返回了无法识别的工具调用格式，已停止；请把这句话换个说法再试".to_string(),
                ));
            }
            /*
             * 收尾这一轮正好收到补充要求：不能把任务标成功、把这句话吞掉。
             * 把这轮回答留在历史里，下一轮带着新要求继续。
             */
            if handle.has_steers() {
                conversation.push(json!({
                    "role": "assistant",
                    "content": reply.content,
                }));
                continue;
            }
            /*
             * **没有工具调用 ≠ 任务达成**：按真实步骤判定结论。
             *
             * 改了东西却没有任何只读验证时，先催一次（把回答留在历史里），
             * 让模型去做配置语法 / 服务状态 / 文件内容核对；催过一次仍不验证，
             * 就明确标成「部分完成」，不再假装已验证。
             */
            let outcome = evaluate_outcome(
                &handle.snapshot().steps,
                query_only,
                Lang::from_locale(input.locale.as_deref()),
            );
            let needs_verification = outcome.as_ref().is_some_and(|result| {
                result.level == "partial"
                    && (result.reason.contains("没有只读验证")
                        || result.reason.contains("no read-only verification"))
            });
            if needs_verification && !verification_nudged {
                verification_nudged = true;
                conversation.push(json!({
                    "role": "assistant",
                    "content": reply.content,
                }));
                conversation.push(json!({
                    "role": "user",
                    "content": "【验证要求】改动已经执行，但还没有在服务器上核对结果。\
                        请先用只读命令验证（配置语法 / 服务状态 / 端口 / 文件内容），\
                        再给结论；确实无法验证时明确说明未验证的原因。"
                }));
                continue;
            }
            handle.update(|snapshot| snapshot.outcome = outcome);
            // 纯聊天 / 单步回答计划：整轮成功才算这一步完成。
            finish_answer_plan(io, handle, &input.task_id);
            return Ok(strip_tool_calls(&reply.content));
        }

        tool_calls += calls.len();
        handle.update(|snapshot| {
            if let Some(context) = snapshot.context.as_mut() {
                context.tool_calls = tool_calls;
            }
        });

        let visible_text = visible_reply_text(&reply.content, native);
        // 模型自己写了执行前说明：这是一组的开头，后续工具沿用这句说明。
        if !visible_text.is_empty() {
            group_open = None;
        }
        let mut tool_messages: Vec<Value> = Vec::new();
        for raw in &mut calls {
            /*
             * 本轮没勾选的能力不下发：前端下栏的 MCP 菜单决定模型能看到哪些
             * 内置工具；这里再拦一次，防止模型凭历史记忆硬调。
             */
            if !builtin_tool_allowed(raw.name.trim(), input.enabled_builtins.as_deref()) {
                tool_messages.push(tool_error_message(
                    &raw.id,
                    raw.native,
                    &raw.name,
                    "该能力没有在本轮启用：这次调用没有执行。请让用户在下栏 MCP 菜单里勾选对应能力，或改用已启用的工具。",
                ));
                continue;
            }
            /*
             * `submit_plan` 是**计划登记**，不是服务器操作：
             * 不占步骤号、不执行命令、不弹确认；提交成功后模型才能继续调用工具。
             */
            if input.plan_required && raw.name.trim() == "submit_plan" {
                let merged = serde_json::from_str::<PlanDraft>(raw.body.trim())
                    .map_err(|error| format!("submit_plan 参数不合法：{error}"))
                    .and_then(|draft| merge_plan(plan.as_ref(), draft, crate::db::AppDb::now()));
                match merged {
                    Ok(next) => {
                        plan = Some(next.clone());
                        handle.update(|snapshot| snapshot.plan = Some(next.clone()));
                        let mut event = AgentEvent::new(&input.task_id, "plan_updated");
                        event.plan = Some(next.clone());
                        io.emit(event);
                        tool_messages.push(tool_ok_message(
                            &raw.id,
                            raw.native,
                            &raw.name,
                            &plan_ack_text(&next, lang),
                        ));
                    }
                    Err(reason) => {
                        tool_messages.push(tool_error_message(
                            &raw.id, raw.native, &raw.name, &reason,
                        ));
                    }
                }
                continue;
            }
            /*
             * `ask_user` 是交互控制工具：不占步骤、不执行命令、不弹权限确认；
             * 任务在这里暂停，等用户提交选择后再把答案作为工具结果回给模型。
             */
            if raw.name.trim() == "ask_user" {
                let question = match prepare_question(&input, raw, round) {
                    Ok(question) => question,
                    Err(reason) => {
                        tool_messages.push(tool_error_message(
                            &raw.id, raw.native, &raw.name, &reason,
                        ));
                        continue;
                    }
                };
                let mut receiver = handle.wait_answer(&question.question_id);
                handle.update(|snapshot| {
                    snapshot.pending_question = Some(question.clone());
                    snapshot.status = "waiting".to_string();
                    snapshot.updated_at = crate::db::AppDb::now();
                });
                let mut event = AgentEvent::new(&input.task_id, "question_required");
                event.question = Some(question.clone());
                io.emit(event);

                match wait_question(handle, &question.question_id, question.deadline, &mut receiver)
                    .await
                {
                    QuestionDecision::Answered(answer) => {
                        handle.update(|snapshot| {
                            snapshot.pending_question = None;
                            if snapshot.status == "waiting" {
                                snapshot.status = "running".to_string();
                            }
                            snapshot.updated_at = crate::db::AppDb::now();
                        });
                        let mut event = AgentEvent::new(&input.task_id, "question_answered");
                        event.question = Some(question.clone());
                        event.answer = Some(answer.clone());
                        io.emit(event);
                        tool_messages.push(tool_ok_message(
                            &raw.id,
                            raw.native,
                            &raw.name,
                            &question_answer_text(&question, &answer),
                        ));
                        continue;
                    }
                    QuestionDecision::Cancelled => {
                        handle.forget_answer(&question.question_id);
                        handle.update(|snapshot| snapshot.pending_question = None);
                        return Err(StopReason::Cancelled(
                            "等待用户回答时任务被停止".to_string(),
                        ));
                    }
                    QuestionDecision::Timeout => {
                        handle.forget_answer(&question.question_id);
                        handle.update(|snapshot| snapshot.pending_question = None);
                        return Err(StopReason::Failed(format!(
                            "等待用户回答超过 {} 分钟，任务已停止",
                            QUESTION_SECONDS / 60
                        )));
                    }
                }
            }
            /*
             * MAX 强制计划：没有有效计划之前，任何工具都不下发。
             * 模型会拿到「请先提交计划」并改发 submit_plan，服务器不会被动到。
             */
            if input.plan_required && plan.is_none() {
                tool_messages.push(tool_error_message(
                    &raw.id,
                    raw.native,
                    &raw.name,
                    plan_required_message(lang),
                ));
                continue;
            }
            let index = next_index;
            next_index += 1;
            if raw.id.is_empty() {
                raw.id = format!("call-{round}-{index}");
            }
            let mut call_id = raw.id.clone();
            start_step(handle, index, &call_id, &raw.name);

            /*
             * 用户刚补了要求：这条旧计划里的命令不再执行。
             *
             * 模型这一批调用是在收到新要求之前决定的；继续跑等于按旧计划动服务器。
             * 跳过并把原因回给它，下一轮开头新要求会追加进对话。
             */
            if handle.has_steers() {
                let reason = "用户补充了新要求：这条命令没有执行。\
                    等新要求生效后重新判断要做什么，不要按原计划继续。"
                    .to_string();
                skip_step(io, handle, &input.task_id, index, &reason);
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }

            // 参数不合法：回一句原因，让模型改写法，不中断任务。
            let args = match serde_json::from_str::<Value>(raw.body.trim()) {
                Ok(value) if value.is_object() => value,
                Ok(_) => {
                    let reason = "参数必须是一个 JSON 对象".to_string();
                    fail_step(io, handle, index, &reason);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                    continue;
                }
                Err(error) => {
                    let reason = format!("参数不是合法 JSON：{error}");
                    fail_step(io, handle, index, &reason);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                    continue;
                }
            };

            /*
             * 计划模式下，每次工具调用都必须说清它属于哪一步。
             * id 必须是**当前计划**里存在的步骤；否则命令不下发。
             */
            let plan_step_id = if input.plan_required {
                let requested = args
                    .get("step")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string();
                let known: Vec<String> = plan
                    .as_ref()
                    .map(|plan| plan.steps.iter().map(|step| step.id.clone()).collect())
                    .unwrap_or_default();
                if requested.is_empty() || plan.as_ref().and_then(|plan| plan.step(&requested)).is_none() {
                    let reason = plan_step_message(lang, &known);
                    fail_step(io, handle, index, &reason);
                    tool_messages.push(tool_error_message(
                        &raw.id, raw.native, &raw.name, &reason,
                    ));
                    continue;
                }
                Some(requested)
            } else {
                None
            };
            /*
             * 操作组：计划模式按计划步骤分组（同一步的多条命令共用一句说明）；
             * 普通模式按"连续工具轮次"分组，模型写了正文就另起一组。
             */
            let group_id = match plan_step_id.as_deref() {
                Some(id) => format!("p-{id}"),
                None => group_open
                    .get_or_insert_with(|| format!("g-{}-{round}", input.task_id))
                    .clone(),
            };

            // sudo 默认禁用：连命令都不构造，直接告诉模型与用户。
            let sudo = args
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(has_sudo);
            if sudo && !input.allow_sudo {
                let reason =
                    "sudo 不可用：当前是只读模式，或未开启「允许提权」。请给出不需要 root 的方案。"
                        .to_string();
                fail_step(io, handle, index, &reason);
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }

            /*
             * MCP 工具走自己的执行分支：工具定义在启动时已绑定，`step` 参数
             * 只用于计划校验，不能透给服务端。
             */
            let mcp_binding = input
                .mcp_tools
                .iter()
                .find(|item| item.exposed_name == raw.name)
                .cloned();
            let mut planned = if let Some(binding) = mcp_binding {
                let mut call_args = args.clone();
                if let Some(object) = call_args.as_object_mut() {
                    object.remove("step");
                }
                let args_json = serde_json::to_string(&call_args).unwrap_or_default();
                let args_text: String = args_json.chars().take(300).collect();
                let risk = if binding.read_only {
                    ToolRisk::Read
                } else {
                    ToolRisk::Write
                };
                PlannedTool {
                    call: ToolCall {
                        id: call_id.clone(),
                        name: binding.exposed_name.clone(),
                        args: call_args,
                        risk,
                    },
                    command: format!("mcp://{}/{}", binding.server_id, binding.tool),
                    display: format!("MCP · {} · {}", binding.server_name, binding.tool),
                    summary: Some(
                        binding
                            .description
                            .chars()
                            .take(120)
                            .collect::<String>(),
                    ),
                    timeout: Duration::from_secs(120),
                    path: None,
                    impact: Some(format!(
                        "调用 MCP 服务「{}」的工具；参数：{args_text}",
                        binding.server_name
                    )),
                    rollback: None,
                    backup_path: None,
                    write_content: None,
                    mcp: Some(binding),
                }
            } else {
                match plan_tool_with_backup(
                    &raw.name,
                    &args,
                    &handle.snapshot().cwd,
                    crate::db::AppDb::now() as u64,
                    &backup_policy,
                ) {
                    Ok(mut planned) => {
                        planned.call.id = call_id.clone();
                        planned
                    }
                    Err(reason) => {
                        fail_step(io, handle, index, &reason);
                        tool_messages
                            .push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                        continue;
                    }
                }
            };

            // 写 / 危险：先挂起，用户点了才发命令。
            let risk = planned.call.risk;
            /*
             * 事件里给的是**用户可读**的那条命令（`planned.display`）；真正的
             * 执行脚本（`cd` 包装、退出码回传、内部标记）单独放在 `script` 里，
             * 只在确认卡的"调试"区展开。
             *
             * `write_file` 的脚本是整段 base64：塞进事件会让一条步骤消息变成
             * 上百 KB，所以它没有 `script`，内容只走执行通道。
             */
            let display_command = planned.display.clone();
            let script = if planned.call.name == "run_shell" {
                Some(planned.command.clone())
            } else {
                None
            };
            /*
             * 操作标识与"已经表过态"：同一操作只问一次，换写法也不再问。
             * 拒绝过的直接拦下；允许过的直接放行。
             */
            let op_signature = operation_signature(&planned, &handle.snapshot().cwd);
            let decided = decided_ops.get(&op_signature).copied();
            let out_of_scope = query_only && risk != ToolRisk::Read;
            /*
             * 「完全权限」不再等于"跳过所有写入确认"：
             * 日常部署（上传 / mkdir / 解压 / 明确目标配置修改）直接执行；
             * 大范围删除、磁盘写入、SSH / 防火墙改动、关机重启等。
             */
            /*
             * 归档操作换了目标 / 覆盖策略：确认卡要说清和上一版差在哪，
             * 不能只重复一句「解压归档」。
             */
            let archive_now = parse_archive_operation(&planned.display, &handle.snapshot().cwd);
            if let (Some(previous), Some(current)) = (&last_archive, &archive_now) {
                if previous.archive == current.archive
                    && (previous.target != current.target
                        || previous.overwrite != current.overwrite
                        || previous.listing != current.listing)
                {
                    let mut changes: Vec<String> = Vec::new();
                    if previous.target != current.target {
                        changes.push(format!(
                            "目标目录从 {} 改为 {}",
                            previous.target.as_deref().unwrap_or("当前目录"),
                            current.target.as_deref().unwrap_or("当前目录")
                        ));
                    }
                    if previous.overwrite != current.overwrite {
                        changes.push(format!(
                            "覆盖策略从 {} 改为 {}",
                            previous.overwrite.label(),
                            current.overwrite.label()
                        ));
                    }
                    if previous.listing != current.listing {
                        changes.push(if current.listing {
                            "从解压改为只查看归档内容".to_string()
                        } else {
                            "从查看归档改为真正解压".to_string()
                        });
                    }
                    let before = planned.impact.take().unwrap_or_default();
                    planned.impact = Some(if before.is_empty() {
                        changes.join("；")
                    } else {
                        format!("{before}；与上次相比：{}", changes.join("；"))
                    });
                }
            }
            if archive_now.is_some() {
                last_archive = archive_now;
            }

            let severe = severe_operation_reason(&planned);
            /*
             * 只读模式不是"每次都确认"，而是**直接拒绝**写 / 危险操作：
             * 不产生审批，也不下发命令；模型拿到原因后应改用只读方案。
             */
            let decision = permission_decision(
                input.permission_mode,
                &planned,
                input.auto_approve_writes,
            );
            let read_only_blocked = decision == PermissionDecision::Block;
            let needs_approval =
                decision == PermissionDecision::Confirm && decided != Some(true);
            if let Some(reason) = &severe {
                planned.impact = Some(match planned.impact.take() {
                    Some(impact) if !impact.is_empty() => {
                        format!("{impact}；需要二次确认：{reason}")
                    }
                    _ => format!("需要二次确认：{reason}"),
                });
            }
            handle.patch_step(index, |step| {
                step.state = if read_only_blocked {
                    "failed".to_string()
                } else if out_of_scope {
                    // 马上会被范围拦下：别让界面闪一下"等待确认"。
                    "running".to_string()
                } else if needs_approval {
                    "waiting".to_string()
                } else {
                    "running".to_string()
                };
                step.risk = risk.as_str().to_string();
                step.command = display_command.clone();
                step.script = script.clone();
                step.summary = planned.summary.clone();
                step.path = planned.path.clone();
                step.impact = planned.impact.clone();
                step.backup_path = planned.backup_path.clone();
                step.rollback = planned.rollback.clone();
                step.plan_step_id = plan_step_id.clone();
                step.group_id = Some(group_id.clone());
            });
            // 计划状态跟着真实事件走：等确认 / 执行中（在任何输出之前）。
            if !read_only_blocked {
                sync_plan_step(
                    io,
                    handle,
                    &input.task_id,
                    index,
                    if needs_approval { "waiting" } else { "running" },
                    None,
                );
            }
            if let Some(step) = handle.step(index) {
                let mut event = AgentEvent::from_step(&input.task_id, "tool_started", &step);
                /*
                 * 执行前说明：模型这一轮**没有写正文**时由执行器补一句，
                 * 内容来自已校验的 summary / 路径 / 命令首行；同一个操作组
                 * 只补一次。说明与工具事件同组 id，前端按组去重。
                 */
                if !noted_groups.contains(&group_id) {
                    if visible_text.is_empty() {
                        event.note = Some(preamble_text(
                            lang,
                            planned.summary.as_deref(),
                            &planned.call.name,
                            planned.path.as_deref(),
                            &planned.display,
                        ));
                    }
                    noted_groups.insert(group_id.clone());
                }
                io.emit(event);
            }

            if read_only_blocked {
                let reason = match lang {
                    Lang::Zh => "只读模式：这条命令会写 / 删除，已拒绝执行。切到「按需确认」后才能执行。",
                    Lang::En => "Read-only mode: this command may write or delete, so it was not executed. Switch to Ask to run it.",
                }
                .to_string();
                fail_step(io, handle, index, &reason);
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }

            /*
             * **查询范围是执行器边界**：用户只要查询时，写 / 改 / 删直接拦下，
             * 不弹确认（两种权限都一样）。模型拿到原因后应改用只读命令。
             */
            if out_of_scope {
                let reason = "这次任务只要求查询：写 / 改 / 删被拦下。\
                    改用只读命令（ps、docker ps、systemctl status、df…）；\
                    确实需要改动时，先请用户明确说明。"
                    .to_string();
                skip_step(io, handle, &input.task_id, index, &reason);
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }
            /*
             * 拒绝过的操作换写法也不再问：直接告给模型，别再试探。
             */
            if decided == Some(false) {
                let reason = "用户已经拒绝过这个操作：换一种写法也不会执行。\
                    先按已有信息汇报，或请用户明确改变要求。"
                    .to_string();
                skip_step(io, handle, &input.task_id, index, &reason);
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }

            /*
             * **同一操作不在一次运行里盲目重跑。**
             *
             * 成功过 → 把真实输出原样回给模型，并要求做只读验证，避免重新解压；
             * 失败过 → 只允许再试一次，第二次仍失败就把真实退出码 / 错误摘要交回去。
             * 解压按归档 + 目标 + 覆盖策略识别，换 `cd`/绝对路径写法也算同一个操作。
             */
            if risk != ToolRisk::Read {
                if let Some((ok, result)) = completed_ops.get(&op_signature).cloned() {
                    if ok {
                        let cached = format!(
                            "{result}\n（同一操作已成功执行，直接复用上次结果；请做只读验证，不要重复解压或写入。）"
                        );
                        handle.patch_step(index, |step| {
                            step.state = "success".to_string();
                            step.summary = Some("复用上次成功结果（未重复执行）".to_string());
                            step.exit_code = Some(0);
                        });
                        sync_plan_step(
                            io,
                            handle,
                            &input.task_id,
                            index,
                            "done",
                            Some("复用上次成功结果"),
                        );
                        if let Some(step) = handle.step(index) {
                            io.emit(AgentEvent::from_step(
                                &input.task_id,
                                "tool_finished",
                                &step,
                            ));
                        }
                        tool_messages.push(if raw.native {
                            json!({ "role": "tool", "tool_call_id": raw.id, "content": cached })
                        } else {
                            json!({ "role": "user", "content": cached })
                        });
                        continue;
                    }
                    if op_attempts.get(&op_signature).copied().unwrap_or(0) >= 2 {
                        let reason = "同一操作已执行两次且都失败；不要再用等价命令重试。\
                            请先读上一条真实错误，向用户说明失败原因。"
                            .to_string();
                        skip_step(io, handle, &input.task_id, index, &reason);
                        tool_messages
                            .push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                        continue;
                    }
                }
            }

            /*
             * 写文件的"拟修改"：**先回读服务器上的原文**，再把这次调用提交的
             * 内容当作 proposedAfter。预览建在这里（即将挂起确认之前），
             * 被范围 / 拒绝 / 重复拦下的调用不会留下空的变更记录。
             */
            let mut change_id: Option<String> = if planned.call.name == "write_file" {
                create_preview(io, input, &planned, index, &call_id).await
            } else {
                None
            };
            if let Some(id) = &change_id {
                handle.patch_step(index, |step| step.change_id = Some(id.clone()));
            }

            if needs_approval {
                /*
                 * 一轮确认 = 登记挂起 → 等用户表态 → 核对文件版本。
                 *
                 * 版本对不上时**不放行**：作废旧预览、按当前内容生成新预览，
                 * 再用新的 callId 重新等确认（旧确认不能用于新版本）。
                 * 最多重来两次，避免文件被持续改动时无限循环。
                 */
                let mut attempt: u32 = 0;
                let mut skip_this = false;
                loop {
                    /*
                     * 快照里也留一份"正在等确认"：刷新 / 重进 / 关掉 WebView 再打开
                     * 时，界面能凭它把确认条画回来并继续 `agent_approve`。只发事件是
                     * 不够的 —— 事件是过去的，重进时收不到。
                     */
                    let step_cwd = handle.snapshot().cwd;
                    // 截止时刻在挂起前定死：事件、快照、等待超时用的是同一个值，
                    // 界面倒计时与后端实际放弃的时刻才不会各说各话。
                    let deadline = crate::db::AppDb::now() + (APPROVAL_SECONDS as i64) * 1000;
                    let pending_change = change_id.clone();
                    handle.update(|snapshot| {
                        // 快照里的状态也要是"在等确认"，否则重进会显示成"执行中"。
                        snapshot.status = "waiting".to_string();
                        snapshot.pending_approval = Some(PendingApproval {
                            call_id: call_id.clone(),
                            step_index: index,
                            workspace_id: input.workspace_id.clone(),
                            server_id: input.server_id.clone(),
                            run_id: input.task_id.clone(),
                            step_id: call_id.clone(),
                            target: Some(format!(
                                "{}\u{1}{}",
                                planned.call.name,
                                planned.display.trim()
                            )),
                            params: serde_json::to_string(&planned.call.args)
                                .unwrap_or_default(),
                            tool: planned.call.name.clone(),
                            path: planned.path.clone(),
                            risk: risk.as_str().to_string(),
                            command: display_command.clone(),
                            script: script.clone(),
                            summary: planned.summary.clone(),
                            impact: planned.impact.clone(),
                            backup_path: planned.backup_path.clone(),
                            rollback: planned.rollback.clone(),
                            change_id: pending_change,
                            cwd: step_cwd,
                            deadline,
                        });
                    });
                    let mut event = AgentEvent::new(&input.task_id, "approval_required");
                    if let Some(step) = handle.step(index) {
                        event = AgentEvent::from_step(&input.task_id, "approval_required", &step);
                    }
                    event.deadline = Some(deadline);
                    io.emit(event);

                    /*
                     * 指令可能在"登记等待"之前就到了：那时 `push_steer` 看不到
                     * pending，不会撤回。这里补一次，避免白等到超时。
                     */
                    if handle.has_steers() {
                        handle.withdraw_pending_approval();
                    }

                    let decision = wait_approval(handle, &call_id, deadline).await;
                    // 用户已表态（或取消 / 超时）：快照里不该再挂着它。
                    handle.update(|snapshot| {
                        snapshot.pending_approval = None;
                        if snapshot.status == "waiting" {
                            snapshot.status = "running".to_string();
                        }
                    });
                    /*
                     * 补充要求撤回的确认：不能当成"用户拒绝过这个操作"。
                     * 差别在于：拒绝要永久记住（换写法也不再问），撤回只是按新要求
                     * 重新评估，下一步还可能做同样的事。
                     *
                     * 放在 match 之前：即使用户刚好先点了「允许」，只要撤回标记已
                     * 落上，这一步也不会执行 —— 新要求优先。
                     */
                    if handle.take_withdrawn(&call_id) {
                        let reason = "用户补充了新要求，这一步已撤回；\
                            按新要求重新评估后再决定要不要做。"
                            .to_string();
                        skip_step(io, handle, &input.task_id, index, &reason);
                        if let Some(id) = &change_id {
                            io.changes().update(id, |record| {
                                record.status = "withdrawn".to_string();
                                // 保留预览：撤回也要能看到当时准备改什么（但绝不执行）。
                                record.note = Some("按新的要求撤回，这一步没有执行".to_string());
                            });
                            if let Some(summary) = io.changes().get(id) {
                                emit_change(io, &input.task_id, summary);
                            }
                        }
                        tool_messages
                            .push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                        let mut event = AgentEvent::new(&input.task_id, "approval_withdrawn");
                        event.call_id = Some(call_id.clone());
                        event.step_index = Some(index);
                        event.message = Some("已收到新的要求，撤回了这条待确认操作。".to_string());
                        io.emit(event);
                        skip_this = true;
                        break;
                    }
                    match decision {
                        Decision::Allow => {
                            decided_ops.insert(op_signature.clone(), true);
                        }
                        Decision::Deny => {
                            // 记住"这个操作被拒绝过"：换写法也不再弹第二次。
                            decided_ops.insert(op_signature.clone(), false);
                            let reason = "用户拒绝执行这条命令".to_string();
                            fail_step(io, handle, index, &reason);
                            // 计划里这一步是「未执行」，不是命令失败。
                            sync_plan_step(
                                io,
                                handle,
                                &input.task_id,
                                index,
                                "skipped",
                                Some("用户拒绝执行"),
                            );
                            if let Some(id) = &change_id {
                                io.changes().update(id, |record| {
                                    record.status = "rejected".to_string();
                                    record.note =
                                        Some("用户拒绝执行：服务器上的文件没有改动".to_string());
                                });
                                if let Some(summary) = io.changes().get(id) {
                                    emit_change(io, &input.task_id, summary);
                                }
                            }
                            tool_messages
                                .push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                            skip_this = true;
                            break;
                        }
                        Decision::Cancelled => {
                            mark_step_aborted(
                                io,
                                handle,
                                index,
                                "已取消（用户停止），命令没有执行",
                            );
                            return Err(StopReason::Cancelled(format!(
                                "已停止：等待确认时收到停止信号（停在「{}」）",
                                describe_step(&raw.name, &args)
                            )));
                        }
                        Decision::Timeout => {
                            mark_step_aborted(
                                io,
                                handle,
                                index,
                                "确认已过期，命令没有执行",
                            );
                            return Err(StopReason::Failed(format!(
                                "确认已过期（等待超过 {} 分钟），已停止（停在「{}」）",
                                APPROVAL_SECONDS / 60,
                                describe_step(&raw.name, &args)
                            )));
                        }
                    }

                    /*
                     * 允许之后**再核对一次文件版本**：确认卡上的 Diff 是发起确认
                     * 时读到的，中间可能被别的会话 / 用户改过。
                     */
                    if let Some(id) = change_id.clone() {
                        if attempt >= 2 {
                            let reason = "文件在确认期间被反复修改，已停止这次写入".to_string();
                            fail_step(io, handle, index, &reason);
                            tool_messages
                                .push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                            skip_this = true;
                            break;
                        }
                        match verify_preview(io, input, &planned, &id, attempt).await {
                            PreviewCheck::Verified => {}
                            PreviewCheck::Regenerated {
                                change_id: new_id,
                                call_id: new_call,
                            } => {
                                change_id = Some(new_id.clone());
                                call_id = new_call;
                                attempt += 1;
                                handle.patch_step(index, |step| {
                                    step.change_id = Some(new_id);
                                    step.state = "waiting".to_string();
                                });
                                continue;
                            }
                            PreviewCheck::Failed(reason) => {
                                fail_step(io, handle, index, &reason);
                                tool_messages.push(tool_error_message(
                                    &raw.id, raw.native, &raw.name, &reason,
                                ));
                                skip_this = true;
                                break;
                            }
                        }
                    }
                    break;
                }
                if skip_this {
                    continue;
                }
                handle.patch_step(index, |step| step.state = "running".to_string());
                sync_plan_step(io, handle, &input.task_id, index, "running", None);
                if let Some(step) = handle.step(index) {
                    io.emit(AgentEvent::from_step(&input.task_id, "tool_started", &step));
                }
            }

            // 到这一步才真的会执行：记一次尝试；成功 / 失败结果在下面回填。
            if risk != ToolRisk::Read {
                *op_attempts.entry(op_signature.clone()).or_insert(0) += 1;
            }

            /*
             * 普通 shell 的写操作：拿不到明确目标与前后快照。
             *
             * 这里**不猜**改了哪个文件（`sed -i` / `tee` / 脚本里的重定向都可能
             * 改一堆文件），只登记一条"未采集差异"，让面板如实显示。
             */
            /*
             * 命令里能解析出**确定的写目标**时，直接生成真实 Diff：
             * 执行前读一份、执行后回读一份，面板就能看到 `sed -i` / `>` 到底
             * 改了哪几行；解析不出来才退回"未采集"占位。
             */
            let mut shell_before: Vec<(String, FileSnapshot)> = Vec::new();
            if planned.call.name == "run_shell" && risk != ToolRisk::Read {
                let base_cwd = handle.snapshot().cwd;
                shell_before = shell_baseline(io, input, &planned, &base_cwd).await;
                /*
                 * 只有**可能改文件**的命令才留"未采集"占位：`nl … | sed -n`、
                 * `curl -D -` 这类只是要看配置/响应头，风险等级虽被保守地判成
                 * write（有 `$()` 或未知命令），但并没有写任何文件 —— 全记下来
                 * 会让变更面板变成一屏"未采集差异"。
                 */
                if shell_before.is_empty() && super::tools::shell_may_write(&planned.display) {
                    record_uncollected(io, input, &planned, index, &call_id);
                }
            }

            /*
             * 同一服务器、同一资源的写操作在**执行层**串行。
             *
             * 第二条任务不弹确认、也不失败：它显示"等待该服务上的操作完成"，
             * 拿到锁后继续。等待期间收到停止请求会立刻放弃这一步。
             */
            let _resource_guard = if risk == ToolRisk::Read {
                None
            } else {
                let key = resource_key(input, &planned);
                handle.patch_step(index, |step| {
                    step.summary = Some("等待该服务上的操作完成".to_string());
                });
                if let Some(step) = handle.step(index) {
                    io.emit(AgentEvent::from_step(&input.task_id, "tool_started", &step));
                }
                tokio::select! {
                    guard = acquire_resource(key) => {
                        handle.patch_step(index, |step| {
                            step.summary = planned.summary.clone();
                        });
                        Some(guard)
                    }
                    _ = handle.cancel().cancelled() => {
                        let reason = "等待该服务上的操作完成时被取消，这一步没有执行。".to_string();
                        skip_step(io, handle, &input.task_id, index, &reason);
                        tool_messages.push(tool_error_message(
                            &raw.id,
                            raw.native,
                            &raw.name,
                            &reason,
                        ));
                        continue;
                    }
                }
            };

            if !io.connected(&input.session_id).await {
                let reason = "SSH 会话已断开，任务停止".to_string();
                fail_step(io, handle, index, &reason);
                return Err(StopReason::Failed(reason));
            }
            // 每条命令执行前再核对一次服务器绑定（切服后绝不误发）。
            if let Err(reason) = io.verify_server(&input.session_id, &input.server) {
                fail_step(io, handle, index, &reason);
                return Err(StopReason::Failed(reason));
            }

            let remaining = Duration::from_secs(MAX_TOTAL_SECONDS)
                .saturating_sub(started.elapsed())
                .max(Duration::from_secs(1));
            let timeout = planned.timeout.min(remaining);
            let began = Instant::now();

            /*
             * 边跑边回显：SSH 每读到一段就 emit 一次（`docker compose up` 跑三分钟
             * 时界面不会一直白着）。转发上限 256 KB —— 再多的部分由结束事件的
             * 完整输出兜底，不拿事件通道去搬几兆。
             */
            let output = if let Some(mut binding) = planned.mcp.clone() {
                /*
                 * 执行前复查：服务被停用 / 工具被取消启用 / 授权撤销后，
                 * 本轮剩余调用立即禁止。库里读不到（测试）时按启动时绑定继续。
                 */
                if let Some(db) = input.db.as_ref() {
                    match crate::mcp::load_config(db.as_ref(), &binding.server_id) {
                        Ok(fresh) => {
                            if !fresh.enabled
                                || fresh.status != "connected"
                                || !crate::mcp::binding_allows(
                                    &fresh.binding,
                                    input.server_id.as_deref(),
                                    input.workspace_id.as_deref(),
                                )
                                || !fresh
                                    .tools
                                    .iter()
                                    .any(|tool| tool.name == binding.tool && tool.enabled)
                            {
                                fail_step(
                                    io,
                                    handle,
                                    index,
                                    "MCP 实例已停用、未通过验证、绑定变更或授权已撤销，这次调用没有执行。",
                                );
                                continue;
                            }
                            binding.config = fresh;
                        }
                        Err(error) => {
                            fail_step(
                                io,
                                handle,
                                index,
                                &format!("MCP 配置已不可用：{error}"),
                            );
                            continue;
                        }
                    }
                }
                // MCP 没有 SSH 流式输出：一次调用结束后把结果交给现有步骤。
                match crate::mcp::call_tool(&binding, &planned.call.args).await {
                    Ok(text) => Ok(ExecOutput {
                        stdout: text,
                        stderr: String::new(),
                        exit_code: Some(0),
                        truncated: false,
                    }),
                    Err(error) => Ok(ExecOutput {
                        stdout: String::new(),
                        stderr: format!("MCP 调用失败：{error}"),
                        exit_code: Some(1),
                        truncated: false,
                    }),
                }
            } else {
                let (sink, mut chunks) = tokio::sync::mpsc::unbounded_channel::<ExecChunk>();
                let forward = {
                    let emitter = io.sink();
                    let task_id = input.task_id.clone();
                    let step_cwd = handle.snapshot().cwd;
                    tokio::spawn(async move {
                        let mut decoder = Utf8StreamDecoder::new();
                        let mut sent = 0usize;
                        while let Some(chunk) = chunks.recv().await {
                            let (to_stderr, bytes) = match chunk {
                                ExecChunk::Stdout(bytes) => (false, bytes),
                                ExecChunk::Stderr(bytes) => (true, bytes),
                            };
                            let text = decoder.feed(&bytes);
                            if text.is_empty() || sent >= LIVE_OUTPUT_LIMIT {
                                continue;
                            }
                            let mut take = text.len().min(LIVE_OUTPUT_LIMIT - sent);
                            while take < text.len() && !text.is_char_boundary(take) {
                                take -= 1;
                            }
                            if take == 0 {
                                continue;
                            }
                            sent += take;
                            let mut event = AgentEvent::new(&task_id, "tool_output");
                            event.step_index = Some(index);
                            event.cwd = Some(step_cwd.clone());
                            // 字节切片按字符边界切过，`take` 处一定是合法边界。
                            let piece = text[..take].to_string();
                            if to_stderr {
                                event.stderr = Some(piece);
                            } else {
                                event.stdout = Some(piece);
                            }
                            emitter(event);
                        }
                    })
                };
                let output = io
                    .exec(&input.session_id, &planned.command, timeout, sink)
                    .await;
                // `exec_stream` 拿走 sink，返回时它已被 drop → 转发任务自然结束。
                let _ = forward.await;
                output
            };
            let elapsed_ms = began.elapsed().as_millis() as u64;

            let (ok, stdout, stderr, exit_code, cwd, truncated, backup) = match output {
                Ok(output) => {
                    let marked = strip_markers(&output.stdout);
                    let cwd = marked.cwd.clone().unwrap_or_else(|| handle.snapshot().cwd);
                    if marked.cwd.is_some() {
                        handle.set_cwd(&cwd);
                    }
                    let mut stderr = output.stderr.clone();
                    if marked.pwd_failed {
                        stderr.push_str(
                            "\n目标目录不存在或不可进入，命令未执行（先用 list_dir 确认路径）",
                        );
                    }
                    if marked.backup_failed {
                        stderr.push_str("\n备份失败，已取消写入（没有改动原文件）");
                    }
                    let ok =
                        output.exit_code == Some(0) && !marked.pwd_failed && !marked.backup_failed;
                    total_bytes += marked.stdout.len() + stderr.len();
                    (
                        ok,
                        marked.stdout,
                        stderr,
                        output.exit_code.map(|code| code as i32),
                        cwd,
                        output.truncated || total_bytes > STEP_OUTPUT_LIMIT,
                        marked.backup,
                    )
                }
                Err(error) => (
                    false,
                    String::new(),
                    error.to_string(),
                    None,
                    handle.snapshot().cwd,
                    false,
                    None,
                ),
            };

            handle.patch_step(index, |step| {
                step.state = if ok { "success" } else { "failed" }.to_string();
                step.stdout = stdout.clone();
                step.stderr = stderr.clone();
                step.exit_code = exit_code;
                step.cwd = cwd.clone();
                step.truncated = truncated;
                if backup.is_some() {
                    step.backup_path = backup.clone();
                }
                step.elapsed_ms = elapsed_ms;
            });
            // 计划步骤的状态只认这条真实结果：成功 / 失败，证据取真实输出首行。
            let plan_evidence = if ok {
                first_line(&stdout, 120)
            } else {
                first_line(&stderr, 120)
            };
            sync_plan_step(
                io,
                handle,
                &input.task_id,
                index,
                if ok { "done" } else { "failed" },
                Some(&plan_evidence),
            );

            /*
             * 写入之后回读一次：**实际 Diff 只来自服务器上的回读结果**。
             *
             * 写入失败 / 回读失败 / 内容完全没变，三种情况分别落不同的状态，
             * 不能用"备份存在"或"命令退出码 0"代替证据。
             */
            if let Some(id) = change_id.clone() {
                let failure = (!ok)
                    .then(|| first_line(&stderr, 200))
                    .filter(|line| !line.is_empty());
                finish_change(
                    io,
                    input,
                    &id,
                    &planned,
                    ok,
                    failure.as_deref(),
                    backup.as_deref(),
                )
                .await;
            }

            // shell 写目标：回读执行后的内容，与执行前的快照生成真实 Diff。
            if !shell_before.is_empty() {
                let failure = (!ok)
                    .then(|| first_line(&stderr, 200))
                    .filter(|line| !line.is_empty());
                record_shell_changes(
                    io,
                    input,
                    &planned,
                    index,
                    &call_id,
                    shell_before,
                    ok,
                    failure.as_deref(),
                )
                .await;
            }

            // 实时片段已在命令运行期间由转发任务发出（见上面的 `forward`）。
            if truncated {
                let mut event = AgentEvent::new(&input.task_id, "tool_output");
                event.step_index = Some(index);
                event.cwd = Some(cwd.clone());
                event.stderr = Some("\n…（输出过长，已截断）\n".to_string());
                io.emit(event);
            }
            if let Some(step) = handle.step(index) {
                io.emit(AgentEvent::from_step(
                    &input.task_id,
                    "tool_finished",
                    &step,
                ));
            }

            let clean = if ok {
                [stdout.trim_end(), stderr.trim_end()]
                    .iter()
                    .filter(|part| !part.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                format!(
                    "{}\n(exit {})",
                    stderr.trim_end(),
                    exit_code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "signal".to_string())
                )
            };
            let (body, cut) = tail_truncate(&redact(&clean), MODEL_OUTPUT_LIMIT);
            let mut result = format!(
                "<tool_result tool=\"{}\" ok=\"{}\" exit=\"{}\" cwd=\"{}\"{}{}>\n{}\n</tool_result>",
                planned.call.name,
                ok,
                exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "signal".to_string()),
                cwd,
                if truncated { " truncated=\"true\"" } else { "" },
                if cut { " cut=\"tail\"" } else { "" },
                if body.trim().is_empty() {
                    "(无输出)".to_string()
                } else {
                    body
                }
            );
            if let Some(path) = &planned.path {
                result.push_str(&format!("\n（涉及文件：{path}）"));
            }
            if let Some(backup) = &backup {
                result.push_str(&format!("\n（原文件已备份到：{backup}）"));
            }
            if risk != ToolRisk::Read {
                completed_ops.insert(op_signature.clone(), (ok, result.clone()));
            }
            tool_messages.push(if raw.native {
                // 标准 function calling：结果必须以 `role: tool` + 原 call id 回灌。
                json!({ "role": "tool", "tool_call_id": raw.id, "content": result })
            } else {
                json!({ "role": "user", "content": result })
            });
        }

        // 原生调用轮的 assistant 消息（含 `tool_calls`）在解析时就已原样入列。
        if !native {
            conversation.push(json!({ "role": "assistant", "content": reply.content }));
        }
        conversation.extend(tool_messages);
    }

    Err(StopReason::Failed(format!(
        "已达 {} 轮工具调用上限，已停止{}",
        rounds,
        last_step_hint(handle)
    )))
}

enum Decision {
    Allow,
    Deny,
    Cancelled,
    Timeout,
}

enum QuestionDecision {
    Answered(QuestionAnswer),
    Cancelled,
    Timeout,
}

async fn wait_question(
    handle: &AgentHandle,
    question_id: &str,
    deadline: i64,
    receiver: &mut oneshot::Receiver<QuestionAnswer>,
) -> QuestionDecision {
    let remaining = (deadline - crate::db::AppDb::now()).max(0) as u64;
    tokio::select! {
        _ = handle.cancel().cancelled() => {
            handle.forget_answer(question_id);
            QuestionDecision::Cancelled
        }
        result = tokio::time::timeout(Duration::from_millis(remaining), &mut *receiver) => {
            match result {
                Ok(Ok(answer)) => QuestionDecision::Answered(answer),
                // 通道 drop（任务结束 / 进程退出）按超时处理。
                Ok(Err(_)) | Err(_) => QuestionDecision::Timeout,
            }
        }
    }
}

fn prepare_question(
    input: &AgentInput,
    // 调用方拿到的是**待执行的调用**（`PendingCall`：原生 tool_calls 与文本
    // `<tool>` 统一后的形态），参数原文在 `body` 里，不是解析后的 `ToolCall.args`。
    raw: &PendingCall,
    round: u32,
) -> Result<PendingQuestion, String> {
    let draft: AskUserDraft =
        serde_json::from_str(raw.body.trim()).map_err(|error| format!("ask_user 参数不合法：{error}"))?;
    let question = draft.question.trim();
    if question.is_empty() {
        return Err("ask_user 需要提供问题内容".to_string());
    }
    if question.chars().count() > 2000 {
        return Err("ask_user 的问题过长（上限 2000 字）".to_string());
    }
    let kind = draft.kind.trim().to_ascii_lowercase();
    if kind != "single" && kind != "multi" {
        return Err("ask_user 的 kind 只能是 single 或 multi".to_string());
    }
    if draft.options.len() > 20 {
        return Err("ask_user 最多提供 20 个选项".to_string());
    }
    let mut options = Vec::with_capacity(draft.options.len());
    let mut seen = std::collections::HashSet::new();
    for option in draft.options {
        let id = option.id.trim();
        let label = option.label.trim();
        if id.is_empty() || label.is_empty() {
            return Err("ask_user 的每个选项都需要 id 和名称".to_string());
        }
        if id.chars().count() > 120 || label.chars().count() > 200 {
            return Err("ask_user 的选项 id 或名称过长".to_string());
        }
        if !seen.insert(id.to_string()) {
            return Err(format!("ask_user 的选项 id 重复：{id}"));
        }
        options.push(QuestionOption {
            id: id.to_string(),
            label: label.to_string(),
        });
    }
    if options.is_empty() && !draft.allow_custom {
        return Err("ask_user 至少需要一个预设选项，或允许自定义回答".to_string());
    }
    let question_id = if raw.id.trim().is_empty() {
        let seq = QUESTION_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("q-{}-{round}-{seq}", input.task_id)
    } else {
        format!("q-{}-{round}-{}", input.task_id, raw.id)
    };
    let deadline = crate::db::AppDb::now() + (QUESTION_SECONDS as i64) * 1000;
    Ok(PendingQuestion {
        question_id,
        task_id: input.task_id.clone(),
        workspace_id: input.workspace_id.clone(),
        server_id: input.server_id.clone(),
        question: question.to_string(),
        kind,
        options,
        allow_custom: draft.allow_custom,
        deadline,
    })
}

fn question_answer_text(question: &PendingQuestion, answer: &QuestionAnswer) -> String {
    let selected = if answer.selected.is_empty() {
        "无".to_string()
    } else {
        answer
            .selected
            .iter()
            .map(|id| {
                let label = question
                    .options
                    .iter()
                    .find(|option| &option.id == id)
                    .map(|option| option.label.as_str())
                    .unwrap_or(id.as_str());
                format!("{label}（id: {id}）")
            })
            .collect::<Vec<_>>()
            .join("、")
    };
    let custom = answer
        .custom
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("无");
    format!(
        "用户已回答问题「{}」。\n已选选项：{selected}\n自定义内容：{custom}\n请根据这个实际选择继续当前任务。",
        question.question
    )
}

async fn wait_approval(handle: &AgentHandle, call_id: &str, deadline: i64) -> Decision {
    let receiver = handle.wait_approval(call_id);
    // 按截止时刻算剩余：从"挂起"到"开始等待"之间还有事件广播等开销，
    // 固定 5 分钟会让实际超时比界面倒计时晚一截。
    let remaining = (deadline - crate::db::AppDb::now()).max(0) as u64;
    tokio::select! {
        _ = handle.cancel().cancelled() => {
            handle.forget_approval(call_id);
            Decision::Cancelled
        }
        result = tokio::time::timeout(Duration::from_millis(remaining), receiver) => {
            match result {
                Ok(Ok(true)) => Decision::Allow,
                Ok(Ok(false)) => Decision::Deny,
                // 通道被 drop（运行结束 / 进程退出）：按超时处理，绝不放行。
                Ok(Err(_)) | Err(_) => Decision::Timeout,
            }
        }
    }
}

fn start_step(handle: &AgentHandle, index: u32, call_id: &str, tool: &str) {
    handle.push_step(AgentStep {
        index,
        call_id: call_id.to_string(),
        tool: tool.to_string(),
        risk: "read".to_string(),
        state: "running".to_string(),
        cwd: handle.snapshot().cwd,
        ..Default::default()
    });
}

/// 计划状态只从**真实工具事件**推进：这里更新快照并广播完整计划。
fn update_plan_step(
    io: &dyn AgentIo,
    handle: &AgentHandle,
    task_id: &str,
    plan_step_id: &str,
    state: &str,
    evidence: Option<&str>,
) {
    let mut updated: Option<AgentPlan> = None;
    handle.update(|snapshot| {
        let Some(plan) = snapshot.plan.as_mut() else {
            return;
        };
        let Some(step) = plan.steps.iter_mut().find(|step| step.id == plan_step_id) else {
            return;
        };
        let mut changed = false;
        if step.state != state {
            step.state = state.to_string();
            changed = true;
        }
        if let Some(evidence) = evidence.map(str::trim).filter(|text| !text.is_empty()) {
            if step.evidence.as_deref() != Some(evidence) {
                step.evidence = Some(evidence.chars().take(160).collect());
                changed = true;
            }
        }
        if changed {
            plan.updated_at = crate::db::AppDb::now();
            updated = Some(plan.clone());
        }
    });
    if let Some(plan) = updated {
        let mut event = AgentEvent::new(task_id, "plan_updated");
        event.plan = Some(plan);
        io.emit(event);
    }
}

/// 按某条工具步骤绑定的计划 id 推进状态（没有计划 / 没绑定 → 静默跳过）。
fn sync_plan_step(
    io: &dyn AgentIo,
    handle: &AgentHandle,
    task_id: &str,
    index: u32,
    state: &str,
    evidence: Option<&str>,
) {
    let Some(step) = handle.step(index) else {
        return;
    };
    let Some(plan_step_id) = step.plan_step_id else {
        return;
    };
    update_plan_step(io, handle, task_id, &plan_step_id, state, evidence);
}

/// 纯聊天 / 单步回答计划：整轮成功时把唯一一步标成完成。
///
/// 多步计划不套用这条规则 —— 没有工具事件的步骤不能假装做完了。
fn finish_answer_plan(io: &dyn AgentIo, handle: &AgentHandle, task_id: &str) {
    let snapshot = handle.snapshot();
    let Some(plan) = snapshot.plan.as_ref() else {
        return;
    };
    // 只完成**纯回答**步骤：动作 / 探查步骤没有真实工具事件就不算做完。
    let answers: Vec<String> = plan
        .steps
        .iter()
        .filter(|step| step.kind == "answer" && step.state != "done")
        .map(|step| step.id.clone())
        .collect();
    for id in answers {
        update_plan_step(io, handle, task_id, &id, "done", None);
    }
}

fn fail_step(io: &dyn AgentIo, handle: &AgentHandle, index: u32, reason: &str) {
    mark_step_aborted(io, handle, index, reason);
    sync_plan_step(
        io,
        handle,
        &handle.snapshot().task_id,
        index,
        "failed",
        Some(reason),
    );
}

/// 一步"没有执行"（范围不允许 / 已拒绝 / 重复）：标成跳过并广播给界面。
fn skip_step(io: &dyn AgentIo, handle: &AgentHandle, task_id: &str, index: u32, reason: &str) {
    handle.patch_step(index, |step| {
        step.state = "skipped".to_string();
        step.summary = Some(reason.to_string());
    });
    if let Some(step) = handle.step(index) {
        io.emit(AgentEvent::from_step(task_id, "tool_finished", &step));
    }
    sync_plan_step(io, handle, task_id, index, "skipped", Some(reason));
}

/// 把一步标成失败并广播（命令没有真的执行时也走它：用户拒绝 / 超时 / 取消）。
fn mark_step_aborted(io: &dyn AgentIo, handle: &AgentHandle, index: u32, reason: &str) {
    handle.patch_step(index, |step| {
        step.state = "failed".to_string();
        step.stderr = reason.to_string();
    });
    if let Some(step) = handle.step(index) {
        io.emit(AgentEvent::from_step(
            &handle.snapshot().task_id,
            "tool_finished",
            &step,
        ));
    }
}

fn tool_error(tool: &str, reason: &str) -> Value {
    json!({
        "role": "user",
        "content": format!("<tool_result tool=\"{tool}\" ok=\"false\">\n{reason}\n</tool_result>")
    })
}

/// 工具没执行时的回灌：原生调用必须回 `role: tool` 并带上原 call id。
fn tool_error_message(id: &str, native: bool, tool: &str, reason: &str) -> Value {
    if native {
        json!({ "role": "tool", "tool_call_id": id, "content": reason })
    } else {
        tool_error(tool, reason)
    }
}

/// 工具成功回执（原生调用继续用 `role: tool`，文本协议用 `<tool_result>`）。
fn tool_ok_message(id: &str, native: bool, tool: &str, content: &str) -> Value {
    if native {
        json!({ "role": "tool", "tool_call_id": id, "content": content })
    } else {
        json!({
            "role": "user",
            "content": format!("<tool_result tool=\"{tool}\" ok=\"true\">\n{content}\n</tool_result>")
        })
    }
}

/// 模型这一轮**真正说给用户**的话（去掉工具块与内部平台标记）。
fn visible_reply_text(content: &str, native: bool) -> String {
    let text = if native {
        content.to_string()
    } else {
        strip_tool_calls(content)
    };
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("]]") {
            Some(end) => rest = &rest[start + 2 + end + 2..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn plan_required_message(lang: Lang) -> &'static str {
    match lang {
        Lang::Zh => "请先提交计划：这次调用没有执行。请先调用 submit_plan 提交计划（每步含 id / title / action / verify），再按步骤调用工具；需要先了解服务器时，可以把只读探查写成第一步。",
        Lang::En => "Submit a plan first: this call was not executed. Call submit_plan (each step needs id / title / action / verify), then call tools per step. If you need to understand the server first, make the read-only probe step 1.",
    }
}

fn plan_step_message(lang: Lang, known: &[String]) -> String {
    let known = if known.is_empty() {
        "（空）".to_string()
    } else {
        known.join(", ")
    };
    match lang {
        Lang::Zh => format!(
            "这次调用没有执行：缺少有效的 step（当前计划步骤：{known}）。请把调用归到其中一步；需要新步骤时先用 submit_plan 更新计划。"
        ),
        Lang::En => format!(
            "This call was not executed: it has no valid step (current plan steps: {known}). Bind the call to one of them, or update the plan with submit_plan first."
        ),
    }
}

fn plan_ack_text(plan: &AgentPlan, lang: Lang) -> String {
    let ids = plan
        .steps
        .iter()
        .map(|step| step.id.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    match lang {
        Lang::Zh => format!(
            "计划已登记（rev {}，{} 步）：{ids}。现在按步骤执行：每个工具调用都必须带 \"step\": \"<步骤 id>\"。",
            plan.revision,
            plan.steps.len()
        ),
        Lang::En => format!(
            "Plan recorded (rev {}, {} steps): {ids}. Execute per step from now on: every tool call must include \"step\": \"<step id>\".",
            plan.revision,
            plan.steps.len()
        ),
    }
}

fn describe_step(tool: &str, args: &Value) -> String {
    args.get("command")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .map(|value| value.chars().take(80).collect::<String>())
        .unwrap_or_else(|| tool.to_string())
}

fn last_step_hint(handle: &AgentHandle) -> String {
    handle
        .snapshot()
        .steps
        .iter()
        .rev()
        .find(|step| !step.command.is_empty())
        .map(|step| {
            format!(
                "（停在「{}」）",
                step.command.chars().take(80).collect::<String>()
            )
        })
        .unwrap_or_default()
}
