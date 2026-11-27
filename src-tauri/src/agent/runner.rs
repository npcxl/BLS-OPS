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
    QuestionAnswer, QuestionOption, StepCategory, ToolCall, ToolRisk, APPROVAL_SECONDS, MAX_ROUNDS,
    MAX_TOTAL_SECONDS, MODEL_OUTPUT_LIMIT, STEP_OUTPUT_LIMIT,
};
use super::state::{AgentHandle, AgentSnapshot, ContextBreakdown, ContextUsage, TokenUsage};
use super::tools::{
    archive_error_hint_lang, archive_read_is_empty, builtin_tool_allowed, filter_tool_schemas,
    has_sudo, parse_archive_operation, plan_tool_for_locale, requires_confirmation,
    severe_operation_reason_lang, strip_markers, tool_schemas_lang, ArchiveOperation, BackupPolicy,
    PlannedTool,
};
use crate::deployment::ai::model::AiCancel;
use crate::deployment::ai::{AiProviderError, OpenAiCompatibleAdvisor, ToolReply};
use crate::ssh::utf8_stream::Utf8StreamDecoder;
use crate::ssh::{ExecChunk, ExecOutput};
use crate::state::AppState;
use tokio::sync::oneshot;

/// 一条命令**边跑边回显**的总上限（超过后只由结束事件给完整输出）。
const LIVE_OUTPUT_LIMIT: usize = 256 * 1024;
/// 等用户回答问题的上限（比审批长：用户可能离开一会儿）。
const QUESTION_SECONDS: u64 = 10 * 60;
/// 单个只读子任务的墙钟上限。超时后结果可能不确定，只能报"未验证"。
#[cfg(not(test))]
const CHILD_TIMEOUT: Duration = Duration::from_secs(180);
#[cfg(test)]
const CHILD_TIMEOUT: Duration = Duration::from_secs(1);
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

/// 一次运行里**允许子任务选择**的服务器。
///
/// 只由命令层从"数据库里标记 connected 且当前 SSH 真的活着"的会话生成；
/// 模型不能凭名字创建一个不存在的目标。子任务必须落在其中一条上。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentServerRef {
    pub server_id: String,
    pub server_name: String,
    pub session_id: String,
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
    /// 本轮启用的 MCP 工具（配置在启动时解析好，执行时仍逐次复查）。
    pub mcp_tools: Vec<crate::mcp::McpBinding>,
    /// 可委派的服务器清单（只包含当前真正连着的已授权会话）。
    pub servers: Vec<AgentServerRef>,
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
    /// Internal child runs are read-only and cannot delegate recursively.
    pub(crate) child_run: bool,
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

    /// MCP transport is injectable in tests; production uses the ordinary
    /// connection and the same permission revalidation as the main agent.
    fn call_mcp<'a>(&'a self, binding: &'a crate::mcp::McpBinding, args: &'a Value) -> IoFuture<'a, Result<String, String>> {
        Box::pin(async move { crate::mcp::call_tool(binding, args).await.map_err(|error| error.to_string()) })
    }

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

/// Child events stay inside their own run: only the parent publishes the
/// aggregated task state. The parent cancellation token is shared by every child.
struct ChildIo<'a> { inner: &'a dyn AgentIo }
impl AgentIo for ChildIo<'_> {
    fn emit(&self, _: AgentEvent) {}
    fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync> { Arc::new(|_| {}) }
    fn connected<'a>(&'a self, id: &'a str) -> IoFuture<'a, bool> { self.inner.connected(id) }
    fn verify_server(&self, id: &str, server: &str) -> Result<(), String> { self.inner.verify_server(id, server) }
    fn exec<'a>(&'a self, id: &'a str, command: &'a str, budget: Duration, sink: UnboundedSender<ExecChunk>) -> IoFuture<'a, Result<ExecOutput, String>> { self.inner.exec(id, command, budget, sink) }
    fn chat<'a>(&'a self, messages: Vec<Value>, tools: Value, cancel: &'a AiCancel, delta: Arc<dyn Fn(&str) + Send + Sync>) -> IoFuture<'a, Result<ToolReply, AiProviderError>> { self.inner.chat(messages, tools, cancel, delta) }
    fn call_mcp<'a>(&'a self, binding: &'a crate::mcp::McpBinding, args: &'a Value) -> IoFuture<'a, Result<String, String>> { self.inner.call_mcp(binding, args) }
}

#[derive(Clone, Debug)]
struct ChildSpec {
    id: String,
    title: String,
    goal: String,
    depends_on: Vec<String>,
    /// 目标服务器 id 或**精确**名称；`None` = 当前服务器。
    server: Option<String>,
    /// 用户明确要求重新检查：即使上次运行有完成结果，也不复用。
    recheck: bool,
}

fn parse_child_specs(args: &Value) -> Result<Vec<ChildSpec>, &'static str> {
    let items = args.get("tasks").and_then(Value::as_array).filter(|v| (2..=6).contains(&v.len())).ok_or("Provide 2–6 child tasks")?;
    let mut specs = Vec::new();
    for (index, task) in items.iter().enumerate() {
        let id = task.get("id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("child-{}", index + 1));
        let title = task.get("title").and_then(Value::as_str).unwrap_or("").trim();
        let goal = task.get("goal").and_then(Value::as_str).unwrap_or("").trim();
        if id.len() > 80 || title.is_empty() || title.len() > 200 || goal.is_empty() || goal.len() > 2000 { return Err("Invalid child task title, goal or id"); }
        let depends_on = match task.get("depends_on") {
            None => Vec::new(),
            Some(Value::Array(values)) => values.iter().map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).ok_or("Invalid child dependency")).collect::<Result<Vec<_>, _>>()?,
            _ => return Err("Invalid child dependencies"),
        };
        let server = match task.get("server") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => {
                let value = value.trim();
                if value.len() > 200 {
                    return Err("Invalid child server");
                }
                (!value.is_empty()).then(|| value.to_string())
            }
            _ => return Err("Invalid child server"),
        };
        let recheck = match task.get("recheck") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(value)) => *value,
            _ => return Err("Invalid child recheck flag"),
        };
        specs.push(ChildSpec { id, title: title.to_string(), goal: goal.to_string(), depends_on, server, recheck });
    }
    let ids: HashSet<&str> = specs.iter().map(|s| s.id.as_str()).collect();
    if ids.len() != specs.len() || specs.iter().any(|task| task.depends_on.iter().any(|dep| dep == &task.id || !ids.contains(dep.as_str()))) { return Err("Duplicate task id or invalid dependency"); }
    let mut done = HashSet::new();
    loop {
        let before = done.len();
        for task in &specs {
            if task.depends_on.iter().all(|id| done.contains(id)) { done.insert(task.id.clone()); }
        }
        if done.len() == specs.len() { return Ok(specs); }
        if before == done.len() { return Err("Cyclic child-task dependencies"); }
    }
}

/// 严格解析子任务目标服务器。
///
/// * 省略 = 当前服务器（保持单服务器对话的默认行为）；
/// * 只接受**授权清单里**的 serverId 或唯一精确名称；
/// * 同名服务器 / 未知名称一律报错，交给模型改用 id 或先问用户，绝不猜。
fn resolve_child_server(
    requested: Option<&str>,
    parent_id: Option<&str>,
    parent_name: &str,
    parent_session: &str,
    servers: &[AgentServerRef],
) -> Result<AgentServerRef, String> {
    let parent = AgentServerRef {
        server_id: parent_id.unwrap_or("").trim().to_string(),
        server_name: parent_name.chars().take(200).collect(),
        session_id: parent_session.to_string(),
    };
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(parent);
    };
    // 当前服务器的 id / 名称优先：用户让"这台"机器做子任务时不该被同名实例挡住。
    if parent_id.is_some_and(|id| id == requested) {
        return Ok(parent);
    }
    let matches_id: Vec<&AgentServerRef> = servers
        .iter()
        .filter(|server| !server.server_id.is_empty() && server.server_id == requested)
        .collect();
    if let Some(server) = unique_server(matches_id, requested)? {
        return Ok(server);
    }
    let matches_name: Vec<&AgentServerRef> = servers
        .iter()
        .filter(|server| server.server_name == requested)
        .collect();
    if let Some(server) = unique_server(matches_name, requested)? {
        return Ok(server);
    }
    let known = servers
        .iter()
        .map(|server| format!("{} (id: {})", server.server_name, server.server_id))
        .collect::<Vec<_>>()
        .join("; ");
    Err(format!(
        "Unknown server \"{requested}\". Use an authorized connected server id/name: {}. \
         If the user did not name a specific target or the names are ambiguous, ask the user with ask_user before delegating.",
        if known.is_empty() { "none".to_string() } else { known }
    ))
}

fn unique_server(
    matches: Vec<&AgentServerRef>,
    requested: &str,
) -> Result<Option<AgentServerRef>, String> {
    let mut ids: Vec<&str> = matches.iter().map(|server| server.server_id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    match ids.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0].clone())),
        _ => Err(format!(
            "Server \"{requested}\" is ambiguous across ids: {}. Pass the exact server id.",
            ids.join(", ")
        )),
    }
}

fn is_child_step(step: &AgentStep) -> bool {
    step.tool == "child_agent" || step.group_id.as_deref().is_some_and(|id| id.starts_with("children-"))
}

/// 中断恢复时**不猜**子任务的结局：
/// * 未开始 → 未执行；
/// * 运行中 / 等待中 → 结果未知（不能当成成功，也不能当成服务器失败）；
/// * 已完成 → 保留结果，但标记为"来自上次运行，需重新核实"。
///
/// 非子任务步骤维持原有语义（命令是否已发出由各自的 `blocked` / `stderr` 说明）。
pub fn normalize_carried_steps(steps: &mut [AgentStep]) {
    for step in steps {
        if !is_child_step(step) {
            continue;
        }
        match step.state.as_str() {
            "pending" => {
                step.state = "skipped".to_string();
                step.blocked = Some("interrupted_pending".to_string());
                step.stderr = "任务中断，子任务未开始".to_string();
            }
            "running" | "waiting" => {
                step.state = "failed".to_string();
                step.blocked = Some("interrupted_unknown".to_string());
                step.category = None;
                step.stderr = "任务中断，子任务结果未知；恢复后先核实服务器状态".to_string();
            }
            "success" => {
                step.stale = true;
            }
            _ => {}
        }
    }
}

fn child_cache_key(server_id: &str, id: &str, goal: &str) -> String {
    format!("{server_id}\u{1}{id}\u{1}{goal}")
}

/// 上次运行里**已经成功**的子任务结果。只用于避免无意义重跑；
/// 复用时会显式标成"需重新核实"，不会当成当前事实。
fn carried_child_results(steps: &[AgentStep]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for step in steps {
        let Some(id) = step.child_id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        let Some(goal) = step.child_goal.as_deref().filter(|goal| !goal.is_empty()) else {
            continue;
        };
        if step.state != "success" {
            continue;
        }
        let Some(server_id) = step.server_id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        if step.tool == "child_agent" && !step.stdout.trim().is_empty() {
            out.insert(child_cache_key(server_id, id, goal), step.stdout.clone());
        }
    }
    out
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
    /// 界面语言：绑定校验等用户可见错误按它生成。
    lang: Lang,
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
        verify_session_server(self.state, session_id, server, self.lang)
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
                return Err(ui(
                    self.lang,
                    "文件太大，单条命令的输出被截断（不生成逐行 Diff）",
                    "The file is too large and the command output was truncated (no line-by-line diff generated)",
                ));
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
    lang: Lang,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if !self.handle.snapshot().terminal() {
            self.handle.update(|snapshot| {
                snapshot.status = "failed".to_string();
                snapshot.error = Some(ui(
                    self.lang,
                    "任务异常终止：执行循环退出但没有留下结果，请核对服务器状态后重试。",
                    "The task ended unexpectedly: the loop exited without a result. Check the server state and retry.",
                ));
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
/// 用户可见错误按界面语言二选一（启动校验、兜底终止等）。
fn ui(lang: Lang, zh: &str, en: &str) -> String {
    match lang {
        Lang::Zh => zh.to_string(),
        Lang::En => en.to_string(),
    }
}

pub async fn spawn_agent(
    app: AppHandle,
    state: AppState,
    mut input: AgentInput,
) -> Result<AgentSnapshot, String> {
    let lang = Lang::from_locale(input.locale.as_deref());
    if input.task_id.trim().is_empty() {
        return Err(ui(lang, "taskId 不能为空", "taskId must not be empty"));
    }
    if input.session_id.trim().is_empty() {
        return Err(ui(
            lang,
            "没有可用的 SSH 会话",
            "No SSH session is available",
        ));
    }
    if !state.ssh.is_connected(&input.session_id).await {
        return Err(ui(
            lang,
            "SSH 会话已断开，先重新连接再让 AI 操作服务器",
            "The SSH session is disconnected; reconnect before letting the AI operate the server",
        ));
    }
    // 防切服务器误发：库里的会话绑定必须与前端声明的服务器一致。
    verify_session_server(&state, &input.session_id, &input.server, lang)?;
    // 恢复进来的子任务先归一化：未开始 / 结果未知不能被当成成功或仍在运行。
    normalize_carried_steps(&mut input.carry_steps);
    let config = {
        let conn = state.db.open().map_err(|error| error.to_string())?;
        crate::db::provider_for(&conn, input.provider_id.as_deref())
            .map_err(|error| error.to_string())?
            .ok_or_else(|| match input.provider_id.as_deref() {
                // 指定的模型被停用/删除了：明确说出来，不静默换回默认。
                Some(_) => ui(
                    lang,
                    "选择的模型已停用或被删除，请重新选择",
                    "The selected model is disabled or deleted; choose another one",
                ),
                None => ui(
                    lang,
                    "还没有配置 AI 模型",
                    "No AI model has been configured yet",
                ),
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
    let api_key = crate::keyring::read_secret(&config.keyring_account()).map_err(|_| {
        ui(
            lang,
            "这个提供方还没有保存可用的 API Key",
            "No usable API key has been saved for this provider",
        )
    })?;
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
            return Err(ui(
                lang,
                "这条任务还在执行，等它结束或先停止",
                "This task is still running; wait for it to finish or stop it first",
            ));
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
        return Err(ui(
            lang,
            "这条任务还在执行，等它结束或先停止",
            "This task is still running; wait for it to finish or stop it first",
        ));
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
            lang,
        };
        let io = LiveIo {
            app: &app_for_run,
            state: &state,
            advisor: &advisor,
            reasoning_effort,
            lang,
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
fn verify_session_server(
    state: &AppState,
    session_id: &str,
    server: &str,
    lang: Lang,
) -> Result<(), String> {
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
                Err(ui(
                    lang,
                    &format!("会话属于「{name}」，不是「{server}」；已拒绝执行，避免把命令发错机器"),
                    &format!(
                        "The session belongs to \"{name}\", not \"{server}\"; the command was rejected to avoid hitting the wrong machine"
                    ),
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
    // 估算上 1 token 约对应 2~4 字节（中文 ~3 字节 / ASCII ~4 字节），按 2x 折算字节上限
    // 既避免中文消息被腰斩到预算的 1/3，又保证裁剪后不会明显越过 token 预算。
    let limit = budget_tokens.saturating_mul(2).max(1024);
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

/// L1：旧工具结果（含文本协议 `<tool_result>` 与历史 `操作记录`）只留首尾各 10 行。
///
/// 头行带 `exit` / `cwd`，尾部依次是 stderr 与结论，两段都原样保留；
/// 中间只写 `…（省略 N 行）…`。最近 [`KEEP_RECENT_UNITS`] 个单元不动。
fn slim_old_tool_results(messages: &mut [Value]) -> usize {
    let units = conversation_units(messages);
    let keep_from = units.len().saturating_sub(KEEP_RECENT_UNITS);
    let mut slimmed = 0;
    for unit in units.iter().take(keep_from) {
        for message in &mut messages[unit.clone()] {
            let role = role_of(message);
            let Some(content) = message.get("content").and_then(Value::as_str) else {
                continue;
            };
            let is_slimmable = role == "tool"
                || (role == "user" && content.trim_start().starts_with("<tool_result"))
                || (role == "assistant" && content.contains("操作记录（"));
            if !is_slimmable {
                continue;
            }
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
    // 摘要段上限：避免折很多短轮次时把 system 自己撑爆，最多占预算的 1/4（下限 2K tokens）。
    let max_summary_tokens = (budget_tokens / 4).max(2048);
    let mut summary_tokens = 0usize;
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
        let Some((_index, unit)) = candidate else {
            break;
        };
        let unit_no = folded + 1;
        let unit_tokens: usize = messages[unit.clone()].iter().map(estimate_tokens).sum();
        let line = summary_line(&messages[unit.clone()], unit_no, unit_no);
        let line_tokens = estimate_text_tokens(&line) + 1;
        // 只有摘要确实比原单元更省且未超出摘要预算时才写入 system，防止越折越胖。
        if line_tokens < unit_tokens && summary_tokens + line_tokens <= max_summary_tokens {
            append_summary(messages, &line);
            summary_tokens += line_tokens;
        }
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

/// 明确的"只读"限定词：只约束它所在的这一句。
const QUERY_SCOPE_WORDS: &[&str] = &[
    "只查",
    "只看",
    "只列",
    "只要看",
    "只读",
    "不要改",
    "别改",
    "不要动",
    "别动",
    "不要修改",
    "别修改",
    "无需修改",
    "不用改",
];

/// 明确要求改动的动词（中文 + 常见英文）。
const MODIFY_WORDS: &[&str] = &[
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
    "清掉",
    "停掉",
    "关掉",
    "杀掉",
    "改掉",
    "换成",
    "覆盖",
    "替换",
    "迁移",
    "扩容",
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

/// 查询动词 / 查询对象。
const QUERY_WORDS: &[&str] = &[
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

/// 分句连接词：出现在改动动词前面时，说明它是一条**新的动作**。
const ACTION_CONNECTORS: &[&str] = &[
    "然后",
    "接着",
    "之后",
    "最后",
    "顺便",
    "同时",
    "并且",
    "并",
    "再",
    "另外",
    "then ",
    "and then",
    "after that",
];

/// 否定词：紧跟在它后面的动词不是指令。
const NEGATIONS: &[&str] = &[
    "不要",
    "别",
    "不用",
    "无需",
    "不需要",
    "禁止",
    "勿",
    "不必",
    "don't",
    "dont",
    "no ",
];

/// 本次任务是否"只查询"（执行器的硬边界：查询范围里写 / 改 / 删会被直接拦下）。
///
/// 判据是**最后一条真人 user 消息**（跳过 `【执行结果】` 这类平台回执）。
pub(crate) fn is_query_only(messages: &[AgentTurn]) -> bool {
    let Some(text) = last_human_text(messages) else {
        return false;
    };
    query_only_request(text)
}

/// 按**分句**判断这次请求是不是"只查询"。
///
/// 单个关键词的硬判断会把两类真实请求判错：
/// * `只查 A，然后修改 B`：一个"只查"就把整条消息锁成只读，B 永远改不了；
/// * `查一下最近的重启记录`：一个"重启"就把一次纯查询当成改动。
///
/// 所以逐句看：范围词只约束自己那一句；改动动词只有落在"动作位置"（句首、
/// 连接词之后，或前面根本没有查询词）才算指令；被否定的动词不算。任何一句
/// 真的要改，整体就不是只查询 —— 写操作照常走权限与审批，由用户决定。
///
/// 反之，纯查询请求里一句写指令都没有才返回 `true`，执行器据此硬拦写操作，
/// 不让模型"顺手"改；完全没有线索时按修改处理（范围不放大）。
fn query_only_request(text: &str) -> bool {
    let lower = text.to_lowercase();
    let mut saw_query = false;
    let mut saw_write = false;
    for clause in lower.split(['，', '。', '；', ';', '、', '！', '!', '？', '?', '\n', ','])
    {
        let clause = clause.trim();
        if clause.is_empty() {
            continue;
        }
        // 这一句自己说了"只查 / 只看 / 只读"：里面的动词当宾语，不当指令。
        let scoped = QUERY_SCOPE_WORDS.iter().any(|word| clause.contains(word));
        if QUERY_WORDS.iter().any(|word| clause.contains(word)) {
            saw_query = true;
        }
        if !scoped && write_intent(clause) {
            saw_write = true;
        }
    }
    if saw_write {
        return false;
    }
    if saw_query {
        return true;
    }
    // 没有查询动词，但明确说了"不要动 / 只读"：仍然按只读范围处理。
    [
        "不要动",
        "别动",
        "不要改",
        "别改",
        "只读",
        "不要修改",
        "别修改",
    ]
    .iter()
    .any(|word| lower.contains(word))
}

/// 这一句里有没有"要改东西"的指令。
fn write_intent(clause: &str) -> bool {
    MODIFY_WORDS.iter().any(|verb| {
        clause.match_indices(verb).any(|(at, _)| {
            if negated_at(clause, at) {
                return false;
            }
            // 句首、连接词之后，或前面根本没有查询词：都是在说动作。
            at == 0 || introduced_at(clause, at) || !query_before(clause, at)
        })
    })
}

fn query_before(clause: &str, at: usize) -> bool {
    let head = &clause[..at];
    QUERY_WORDS.iter().any(|word| head.contains(word))
}

fn introduced_at(clause: &str, at: usize) -> bool {
    let head = clause[..at].trim_end();
    ACTION_CONNECTORS.iter().any(|word| {
        // 连接词后面可能还跟着宾语（`然后把旧日志清掉`），中文按"出现过"判断；
        // 英文（`then `）仍要求紧贴动词，避免 `command ` 里的 `and ` 误伤。
        if word.is_ascii() {
            head.ends_with(word)
        } else {
            head.contains(word)
        }
    })
}

fn negated_at(clause: &str, at: usize) -> bool {
    let head = clause[..at].trim_end();
    // `不要再重启` / `别再重启`：中间的"再"不影响否定。
    let head = head.strip_suffix('再').unwrap_or(head);
    NEGATIONS.iter().any(|word| head.ends_with(word))
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
// Limit child agents across conversations sharing the same server identity.
static CHILD_SLOTS: OnceLock<AsyncMutex<HashMap<String, Arc<tokio::sync::Semaphore>>>> = OnceLock::new();
pub(crate) async fn child_slot(session: &str) -> Option<tokio::sync::OwnedSemaphorePermit> {
    let map = CHILD_SLOTS.get_or_init(|| AsyncMutex::new(HashMap::new()));
    let semaphore = {
        let mut guard = map.lock().await;
        guard.entry(session.to_string()).or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(3))).clone()
    };
    semaphore.acquire_owned().await.ok()
}

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
    if !input.child_run {
        let server_list = if input.servers.is_empty() {
            match lang {
                Lang::Zh => "当前服务器（没有其他已授权且连通的会话）".to_string(),
                Lang::En => "the current server (no other authorized live session)".to_string(),
            }
        } else {
            input
                .servers
                .iter()
                .map(|server| {
                    if server.server_id.trim().is_empty() {
                        format!("{} (current session)", server.server_name)
                    } else {
                        format!("{} (id: {})", server.server_name, server.server_id)
                    }
                })
                .collect::<Vec<_>>()
                .join("; ")
        };
        system.push_str(&match lang {
            Lang::Zh => format!(
                "复杂任务可按需调用 parallel_readonly_agents 执行 2 至 6 个只读调查；相互独立的任务并行，有依赖的任务通过 id 和 depends_on 串行；简单任务不必拆分。\
                 子任务默认在当前服务器；要检查其他机器时，server 必须是下列**已授权且当前连通**的精确 id 或唯一名称，不能凭名字猜测或编造：{server_list}。\
                 用户没有明确目标、或出现同名服务器时，先用 ask_user 问清，不要自行选择一个。不同服务器可以在总并发预算内并行，同一服务器仍受并发上限限制。\
                 子任务只能使用本轮启用的只读 MCP 工具，不能写入或询问用户；需要写入或使用不可用的 MCP 工具时，让它返回 WRITE_REQUEST，由你按原有确认流程执行。\
                 请依据各子任务的真实证据汇总，不要假装未验证的步骤已完成。文本工具协议示例：<tool name=\"parallel_readonly_agents\">{{\"tasks\":[{{\"title\":\"检查磁盘\",\"goal\":\"检查磁盘使用量\"}},{{\"title\":\"检查服务\",\"goal\":\"检查运行中的服务\",\"server\":\"<id>\"}}]}}</tool>。计划模式还须提供 step；用户明确要求重新检查时对相应子任务设 recheck=true。\n"
            ),
            Lang::En => format!(
                "For complex tasks only, parallel_readonly_agents can run 2–6 read-only investigations, with task IDs and depends_on for dependent work. \
                 Children default to the current server; to inspect another machine, `server` must be an exact id or unique name from this **authorized and currently connected** list — never guess or invent one: {server_list}. \
                 If the user did not name explicit targets, or names are ambiguous, use ask_user first; do not pick one yourself. Different servers may run in parallel within the total budget; the same server still obeys its concurrency limit. \
                 Children may use enabled read-only MCP tools, but cannot write or ask questions. If a write or an unavailable MCP tool is needed, have the child return a WRITE_REQUEST and run it through the normal approval flow yourself. \
                 Summarize actual evidence and do not claim unverified work is complete. In the text tool protocol use <tool name=\"parallel_readonly_agents\">{{\"tasks\":[{{\"title\":\"Disk\",\"goal\":\"Check disk usage\"}},{{\"title\":\"Services\",\"goal\":\"Check running services\",\"server\":\"<id>\"}}]}}</tool>. In plan mode include step; set recheck=true when the user explicitly asks to check again.\n"
            ),
        });
    }
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
    // Child results may come from another host or describe a different check.
    let verification = last_write.and_then(|last| {
        succeeded.iter().rev().find(|step| {
            step.index > last
                && step.risk == "read"
                && !step.stale
                && !matches!(step.tool.as_str(), "child_agent" | "parallel_readonly_agents")
        })
    });

    let mut evidence: Vec<String> = writes
        .iter()
        .rev()
        .take(3)
        .map(|step| step_label(step))
        .collect();
    if let Some(check) = verification {
        evidence.push(step_label(check));
    }

    if last_write.is_some() && verification.is_none() {
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
    /*
     * 子任务的结果必须进入父任务结论：
     * * 任一批并行委派失败 → 不能被后续无关的成功批次覆盖；
     * * 复用了中断前的结果 → 只能算部分完成，必须重新核实当前状态。
     */
    if let Some(dispatch) = steps.iter().rev().find(|step| {
        step.tool == "parallel_readonly_agents"
            && (step.state == "failed" || step.stale)
    }) {
        let mut child_evidence: Vec<String> = steps
            .iter()
            .filter(|step| {
                step.tool == "child_agent"
                    && (step.state == "failed" || step.stale)
            })
            .rev()
            .take(3)
            .map(|step| {
                format!(
                    "#{} {}",
                    step.index + 1,
                    step.summary.as_deref().unwrap_or("child_agent")
                )
            })
            .collect();
        child_evidence.extend(evidence.iter().cloned());
        if dispatch.state == "failed" {
            return Some(AgentOutcome::partial(
                if en {
                    "Some child investigations failed or remain unverified; the task is not fully successful."
                } else {
                    "有子任务失败或未取得可验证结果，任务不能算全部成功。"
                },
                child_evidence,
            ));
        }
        if dispatch.stale {
            return Some(AgentOutcome::partial(
                if en {
                    "Some child results came from before the interruption; re-verify current server state before treating them as facts."
                } else {
                    "部分子任务结果来自中断前，必须先重新核实服务器当前状态，不能直接当成事实。"
                },
                child_evidence,
            ));
        }
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
            let en = matches!(Lang::from_locale(input.locale.as_deref()), Lang::En);
            registry.update(&id, |record| {
                record.proposed = sanitized;
                record.backup_path = planned.backup_path.clone();
                record.note = Some(if en {
                    format!("Could not read the file before the change: {reason}")
                } else {
                    format!("未能读取修改前的文件：{reason}")
                });
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
            return PreviewCheck::Failed(match Lang::from_locale(input.locale.as_deref()) {
                Lang::Zh => format!(
                    "确认前无法重新核对文件版本：{reason}。这一步没有执行，请重新发起修改"
                ),
                Lang::En => format!(
                    "Could not re-check the file version before confirmation: {reason}. This step did not run; start the change again"
                ),
            })
        }
    };
    if before.exists == current.exists && before.sha == current.sha {
        return PreviewCheck::Verified;
    }

    // 旧确认只能用于它当时看到的那一版：作废并生成新预览。
    registry.update(change_id, |item| {
        item.status = "stale".to_string();
        item.note = Some(ui(
            Lang::from_locale(input.locale.as_deref()),
            "文件在确认前被外部修改，这份预览已作废",
            "The file changed externally before confirmation; this preview is void",
        ));
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
    let en = matches!(Lang::from_locale(input.locale.as_deref()), Lang::En);
    registry.update(&id, |record| {
        record.uncollected = true;
        record.note = Some(if en {
            format!(
                "A plain shell command has no reliable target/read-back snapshot, so no file diff was collected: {command}"
            )
        } else {
            format!(
                "普通 shell 命令无法可靠取得明确目标与前后快照，该操作未采集文件差异：{command}"
            )
        });
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
    let en = matches!(Lang::from_locale(input.locale.as_deref()), Lang::En);
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
                Some(match (failure, en) {
                    (Some(line), false) => format!("命令执行失败：{line}"),
                    (None, false) => "命令执行失败".to_string(),
                    (Some(line), true) => format!("Command failed: {line}"),
                    (None, true) => "Command failed".to_string(),
                })
            } else if readback.is_err() {
                Some(
                    if en {
                        "Could not read the target back after writing, so the actual change cannot be proven"
                    } else {
                        "写入后无法回读目标文件，不能证明实际改动"
                    }
                    .to_string(),
                )
            } else if unchanged {
                Some(
                    if en {
                        "The read-back matched the pre-run state: this command produced no change"
                    } else {
                        "命令执行后回读与执行前一致：这次没有产生改动"
                    }
                    .to_string(),
                )
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
    /// 已经因为"看不懂"被打回给模型的命令（同一条只打回一次，第二次交用户）。
    let mut asked_unknown: HashSet<String> = HashSet::new();
    /// 打回次数上限：模型每次都换个新写法时，不能无限打回（超出就直接问用户）。
    let mut unknown_bounces: usize = 0;
    /**
     * 结果**不确定**的写操作（签名 → 发生时的轮次）。
     *
     * SSH 中断 / 超时会让"命令到底执行了没有"没有答案。这种写操作不能直接
     * 自动重放：要求模型先做一次只读核对（`read_ok_round` 之后才允许重试），
     * 避免同一次部署做两遍。
     */
    let mut uncertain_ops: HashMap<String, u32> = HashMap::new();
    /// 最近一次**只读**操作成功的轮次：用于判断"不确定的写"之前是否已核对过。
    let mut read_ok_round: u32 = 0;
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
    let mut delegated_children: usize = 0;
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
            return Err(StopReason::Failed(match lang {
                Lang::Zh => format!(
                    "总时长超过 {} 分钟，已停止{}",
                    MAX_TOTAL_SECONDS / 60,
                    last_step_hint(handle, lang)
                ),
                Lang::En => format!(
                    "Total time exceeded {} minutes; stopped{}",
                    MAX_TOTAL_SECONDS / 60,
                    last_step_hint(handle, lang)
                ),
            }));
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
        let mut schemas = crate::mcp::append_tool_schemas(
            filter_tool_schemas(
                tool_schemas_lang(input.plan_required, lang),
                input.enabled_builtins.as_deref(),
            ),
            &input.mcp_tools,
            input.plan_required,
            lang,
        );
        if let Some(items) = schemas.as_array_mut() {
            if input.child_run {
                items.retain(|item| item.pointer("/function/name").and_then(Value::as_str) != Some("ask_user"));
            } else {
                let mut parameters = json!({"type":"object","properties":{"tasks":{"type":"array","minItems":2,"maxItems":6,"items":{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"goal":{"type":"string"},"server":{"type":"string","description":"Exact authorized server id or unique name; omit for the current server. Never guess."},"depends_on":{"type":"array","items":{"type":"string"},"description":"IDs of prerequisite tasks; omit for independent investigations"},"recheck":{"type":"boolean","description":"Set true only when the user explicitly asks to check again instead of reusing a previous completed result."}},"required":["title","goal"]}}},"required":["tasks"]});
                if input.plan_required {
                    parameters["properties"]["step"] = json!({"type":"string","description":"Existing plan step ID"});
                    parameters["required"].as_array_mut().unwrap().push(json!("step"));
                }
                items.push(json!({"type":"function","function":{"name":"parallel_readonly_agents","description":"For complex requests only, run 2–6 read-only investigations. Independent tasks run in parallel; use depends_on with task IDs for dependencies. Use server only with an exact id/name from the authorized list; omit for the current server, and ask the user when targets are unclear or ambiguous. Each child returns evidence; writes and questions are unavailable. Do not use for simple queries.","parameters":parameters}}));
            }
        }
        let reply = match io
            .chat(conversation.clone(), schemas, handle.cancel(), on_delta)
            .await
        {
            Ok(reply) => reply,
            Err(AiProviderError::Cancelled) if handle.is_cancelled() => {
                return Err(StopReason::Cancelled(ui(lang, "已停止", "Stopped")));
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
                return Err(StopReason::Failed(ui(
                    lang,
                    "模型这次的回复没有被识别为可执行操作，任务已停止；可以换个说法再发一次",
                    "The model's reply could not be read as an executable action, so the task stopped. Try rephrasing the request",
                )));
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
            if handle.is_cancelled() {
                return Err(StopReason::Cancelled(ui(lang, "已停止", "Stopped")));
            }
            /*
             * 本轮没勾选的能力不下发：前端下栏的 MCP 菜单决定模型能看到哪些
             * 内置工具；这里再拦一次，防止模型凭历史记忆硬调。
             */
            if !builtin_tool_allowed(raw.name.trim(), input.enabled_builtins.as_deref()) {
                tool_messages.push(tool_error_message(
                    &raw.id,
                    raw.native,
                    &raw.name,
                    &ui(
                        lang,
                        "该能力没有在本轮启用：这次调用没有执行。请让用户在下栏 MCP 菜单里勾选对应能力，或改用已启用的工具。",
                        "This capability is not enabled for this run, so the call was not executed. Ask the user to tick it in the MCP menu below, or use an enabled tool.",
                    ),
                ));
                continue;
            }
            /*
             * `submit_plan` 是**计划登记**，不是服务器操作：
             * 不占步骤号、不执行命令、不弹确认；提交成功后模型才能继续调用工具。
             */
            if input.plan_required && raw.name.trim() == "submit_plan" {
                let merged = serde_json::from_str::<PlanDraft>(raw.body.trim())
                    .map_err(|error| match lang {
                        Lang::Zh => format!("submit_plan 参数不合法：{error}"),
                        Lang::En => format!("Invalid submit_plan arguments: {error}"),
                    })
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
                        tool_messages
                            .push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                    }
                }
                continue;
            }
            /*
             * `ask_user` 是交互控制工具：不占步骤、不执行命令、不弹权限确认；
             * 任务在这里暂停，等用户提交选择后再把答案作为工具结果回给模型。
             */
            if raw.name.trim() == "ask_user" {
                if input.child_run {
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, "Child agents cannot ask the user directly; return the missing information to the parent."));
                    continue;
                }
                let question = match prepare_question(&input, raw, round) {
                    Ok(question) => question,
                    Err(reason) => {
                        tool_messages
                            .push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
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

                match wait_question(
                    handle,
                    &question.question_id,
                    question.deadline,
                    &mut receiver,
                )
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
                        return Err(StopReason::Cancelled(ui(
                            lang,
                            "等待用户回答时任务被停止",
                            "The task was stopped while waiting for the user's answer",
                        )));
                    }
                    QuestionDecision::Timeout => {
                        handle.forget_answer(&question.question_id);
                        handle.update(|snapshot| snapshot.pending_question = None);
                        return Err(StopReason::Failed(match lang {
                            Lang::Zh => format!(
                                "等待用户回答超过 {} 分钟，任务已停止",
                                QUESTION_SECONDS / 60
                            ),
                            Lang::En => format!(
                                "Waited more than {} minutes for the user's answer; the task stopped",
                                QUESTION_SECONDS / 60
                            ),
                        }));
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
                let reason = ui(
                    lang,
                    "用户补充了新要求：这条命令没有执行。\
                     等新要求生效后重新判断要做什么，不要按原计划继续。",
                    "The user added a new requirement, so this command was not executed. Re-evaluate what to do once it takes effect; do not continue with the old plan.",
                );
                skip_step(io, handle, &input.task_id, index, &reason, "withdrawn");
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }

            // 参数不合法：回一句原因，让模型改写法，不中断任务。
            let args = match serde_json::from_str::<Value>(raw.body.trim()) {
                Ok(value) if value.is_object() => value,
                Ok(_) => {
                    let reason = ui(
                        lang,
                        "参数必须是一个 JSON 对象",
                        "Arguments must be a JSON object",
                    );
                    // 模型自己的参数错误：内部纠正，不是服务器执行失败。
                    bounce_step(io, handle, &input.task_id, index, &reason);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                    continue;
                }
                Err(error) => {
                    let reason = match lang {
                        Lang::Zh => format!("参数不是合法 JSON：{error}"),
                        Lang::En => format!("Arguments are not valid JSON: {error}"),
                    };
                    bounce_step(io, handle, &input.task_id, index, &reason);
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
                    .map(|plan| {
                        plan.steps
                            .iter()
                            .filter(|step| !step.superseded)
                            .map(|step| step.id.clone())
                            .collect()
                    })
                    .unwrap_or_default();
                if requested.is_empty()
                    || plan
                        .as_ref()
                        .and_then(|plan| plan.step(&requested))
                        .is_none()
                {
                    let reason = plan_step_message(lang, &known);
                    bounce_step(io, handle, &input.task_id, index, &reason);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                    continue;
                }
                Some(requested)
            } else {
                None
            };
            if raw.name.trim() == "parallel_readonly_agents" {
                if input.child_run {
                    let reason = "Child agents cannot create child agents.";
                    bounce_step(io, handle, &input.task_id, index, reason);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, reason));
                    continue;
                }
                let specs = match parse_child_specs(&args) {
                    Ok(specs) => specs,
                    Err(reason) => {
                        bounce_step(io, handle, &input.task_id, index, reason);
                        tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, reason));
                        continue;
                    }
                };
                /*
                 * 先把每台目标服务器解析出来，再创建步骤 / 并发执行。
                 * 只接受本轮授权清单里的 id 或唯一名称；未知 / 同名直接退回
                 * 让模型改用 id 或先问用户，绝不按名字猜一台机器。
                 */
                let mut resolved = Vec::with_capacity(specs.len());
                let mut resolve_error = None;
                for spec in specs {
                    match resolve_child_server(
                        spec.server.as_deref(),
                        input.server_id.as_deref(),
                        &input.server,
                        &input.session_id,
                        &input.servers,
                    ) {
                        Ok(server) => resolved.push((spec, server)),
                        Err(reason) => {
                            resolve_error = Some(reason);
                            break;
                        }
                    }
                }
                if let Some(reason) = resolve_error {
                    bounce_step(io, handle, &input.task_id, index, &reason);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                    continue;
                }
                if delegated_children + resolved.len() > 6 {
                    let reason = "The child-agent budget for this run is exhausted; continue with the available results.";
                    bounce_step(io, handle, &input.task_id, index, reason);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, reason));
                    continue;
                }
                delegated_children += resolved.len();
                let group_id = format!("children-{index}");
                handle.patch_step(index, |step| {
                    step.summary = Some(ui(lang, "并行检查", "Parallel investigation"));
                    step.group_id = Some(group_id.clone());
                    step.plan_step_id = plan_step_id.clone();
                    step.category = Some(StepCategory::Executed);
                });
                if let Some(step) = handle.step(index) { io.emit(AgentEvent::from_step(&input.task_id, "tool_started", &step)); }
                /*
                 * 子任务能看到本轮启用的 MCP 工具，但**声明可写 / 影响未知**的
                 * 名字会写进子任务说明，并在每次调用前被 `child_run` 复查拦下；
                 * 需要时由子任务回报主 Agent，不能因为"被禁止"就静默少做一步。
                 */
                let blocked_mcp: Vec<String> = input
                    .mcp_tools
                    .iter()
                    .filter(|binding| binding.effect() != crate::mcp::McpEffect::DeclaredReadOnly)
                    .map(|binding| format!("{} · {}", binding.server_name, binding.tool))
                    .collect();
                let carried = carried_child_results(&input.carry_steps);
                let prerequisites: HashSet<String> = resolved.iter()
                    .flat_map(|(spec, _)| spec.depends_on.iter().cloned())
                    .collect();
                let child_io = ChildIo { inner: io };
                let mut remaining: Vec<(usize, ChildSpec, AgentServerRef, u32, String)> = Vec::new();
                let mut completed: HashMap<String, (bool, String)> = HashMap::new();
                for (n, (spec, server)) in resolved.into_iter().enumerate() {
                    let child_index = next_index;
                    next_index += 1;
                    let child_call = format!("{}:child:{}", call_id, n);
                    let child_cwd = if server.session_id == input.session_id {
                        input.cwd.clone()
                    } else {
                        // 另一台机器上的路径与当前目录无关：从根目录重新确认。
                        "/".to_string()
                    };
                    start_step(handle, child_index, &child_call, "child_agent");
                    handle.patch_step(child_index, |step| {
                        step.state = "pending".into();
                        step.summary = Some(spec.title.clone());
                        step.group_id = Some(group_id.clone());
                        step.server = Some(server.server_name.clone());
                        step.server_id = Some(server.server_id.clone()).filter(|id| !id.is_empty());
                        step.session_id = Some(server.session_id.clone());
                        step.child_id = Some(spec.id.clone());
                        step.child_goal = Some(spec.goal.clone());
                        step.child_depends_on = spec.depends_on.clone();
                    });
                    if let Some(step) = handle.step(child_index) { io.emit(AgentEvent::from_step(&input.task_id, "tool_started", &step)); }
                    // 上次运行已经成功过、目标 / id / goal 都一致：不重复花模型与命令预算，
                    // 但结果明确标成"需重新核实"，不能当成当前事实。
                    // Cached evidence is historical. A task participating in the
                    // current dependency graph must run against current evidence.
                    if !spec.recheck && spec.depends_on.is_empty() && !prerequisites.contains(&spec.id) {
                        let key = child_cache_key(&server.server_id, &spec.id, &spec.goal);
                        if let Some(prior) = carried.get(&key) {
                            let text = format!(
                                "{}: cached from the previous run; revalidate current server state before relying on it\n{}",
                                spec.title, prior
                            );
                            handle.patch_step(child_index, |step| {
                                step.state = "success".into();
                                step.category = Some(StepCategory::Executed);
                                step.stale = true;
                                step.stdout = text.clone();
                            });
                            if let Some(step) = handle.step(child_index) { io.emit(AgentEvent::from_step(&input.task_id, "tool_finished", &step)); }
                            completed.insert(spec.id.clone(), (true, text));
                            continue;
                        }
                    }
                    remaining.push((n, spec, server, child_index, child_cwd));
                }
                let mut stalled = 0usize;
                while !remaining.is_empty() {
                    let before = remaining.len();
                    let mut wave = Vec::new();
                    let mut waiting = Vec::new();
                    for (n, spec, server, child_index, child_cwd) in remaining {
                        if spec.depends_on.iter().any(|id| completed.get(id).is_some_and(|(ok, _)| !ok)) {
                            let text = format!("{}: prerequisite failed; not executed", spec.title);
                            handle.patch_step(child_index, |step| {
                                step.state = "skipped".into();
                                step.category = Some(StepCategory::Denied);
                                step.blocked = Some("dependency".into());
                                step.stderr = text.clone();
                            });
                            if let Some(step) = handle.step(child_index) { io.emit(AgentEvent::from_step(&input.task_id, "tool_finished", &step)); }
                            completed.insert(spec.id.clone(), (false, text));
                        } else if spec.depends_on.iter().all(|id| completed.contains_key(id)) {
                            let evidence = spec.depends_on.iter().filter_map(|id| completed.get(id).map(|(_, text)| text.as_str())).collect::<Vec<_>>().join("\n");
                            wave.push((n, spec, server, child_index, child_cwd, evidence));
                        } else { waiting.push((n, spec, server, child_index, child_cwd)); }
                    }
                    remaining = waiting;
                    if wave.is_empty() {
                        /*
                         * 依赖图在解析时已经校验过无环、无缺失；走到这里说明
                         * 中间状态异常（例如依赖被并发终态覆盖）。不无限空转：
                         * 把剩下的标成未执行并说明原因。
                         */
                        if remaining.len() == before {
                            stalled += 1;
                            if stalled >= 2 {
                                for (_, spec, _, child_index, _) in remaining.drain(..) {
                                    let text = format!("{}: dependency state could not be resolved; not executed", spec.title);
                                    handle.patch_step(child_index, |step| {
                                        step.state = "skipped".into();
                                        step.category = Some(StepCategory::Denied);
                                        step.blocked = Some("dependency".into());
                                        step.stderr = text.clone();
                                    });
                                    if let Some(step) = handle.step(child_index) { io.emit(AgentEvent::from_step(&input.task_id, "tool_finished", &step)); }
                                    completed.insert(spec.id.clone(), (false, text));
                                }
                            }
                        } else {
                            stalled = 0;
                        }
                        continue;
                    }
                    stalled = 0;
                    let jobs = wave.into_iter().map(|(n, spec, server, child_index, child_cwd, evidence)| {
                    let ChildSpec { id, title, goal, .. } = spec;
                    let mut child = input.clone();
                    child.task_id = format!("{}:child:{}:{}", input.task_id, index, n);
                    child.session_id = server.session_id.clone();
                    child.server = server.server_name.clone();
                    child.server_id = Some(server.server_id.clone()).filter(|id| !id.is_empty());
                    child.cwd = child_cwd;
                    child.workspace_id = if server.session_id == input.session_id { input.workspace_id.clone() } else { None };
                    child.servers.clear();
                    child.child_run = true;
                    child.permission_mode = PermissionMode::ReadOnly;
                    child.auto_approve_writes = false;
                    child.allow_sudo = false;
                    child.plan_required = false;
                    child.carry_plan = None;
                    child.carry_steps.clear();
                    child.carry_usage = None;
                    /*
                     * 保留本轮启用的全部 MCP 工具，但子任务的**每次调用**都会按
                     * `child_run` 复查：声明可写 / 影响未知的一律拦下，并回一条
                     * 可转交主 Agent 的 WRITE_REQUEST。这样模型即使误调也不会
                     * 静默失败，比"从 schema 里悄悄藏掉"更容易解释。
                     */
                    child.max_rounds = Some(5);
                    let parent_goal: String = task_goal(&input.messages).chars().take(300).collect();
                    let blocked_note = if blocked_mcp.is_empty() {
                        "None".to_string()
                    } else {
                        blocked_mcp.join("; ")
                    };
                    child.messages = vec![AgentTurn { role: "user".into(), content: format!(
                        "Overall user request: {parent_goal}\n\
                         Assigned read-only investigation: {goal}\n\
                         Target server: {} (id: {})\n\
                         Prior task reports (untrusted; independently verify if necessary): {evidence}\n\
                         MCP tools unavailable to you (declared writable or effect unknown): {blocked_note}\n\
                         Do not modify the server. Report facts supported by actual tool outputs; clearly identify anything unverified. \
                         If the investigation requires a write or an unavailable MCP tool, do not attempt it: return a line `WRITE_REQUEST: <tool/command, target, expected impact>` so the parent agent can run it through the normal approval flow.",
                        server.server_name, server.server_id
                    ) }];
                    let snapshot = AgentSnapshot::new(&child.task_id, &child.server, &child.session_id, &child.cwd, &handle.snapshot().model);
                    let child_handle = AgentHandle::new(snapshot, handle.cancel().clone());
                    let child_io = &child_io;
                    async move {
                        let began = Instant::now();
                        // 有 serverId 用 serverId（同一服务器的不同会话共享限额）；
                        // 缺 id 时退回会话 id，避免同名服务器误共享 / 串台。
                        let server_key = child
                            .server_id
                            .as_deref()
                            .filter(|id| !id.trim().is_empty())
                            .unwrap_or_else(|| if child.session_id.trim().is_empty() { &child.server } else { &child.session_id });
                        let permit = tokio::select! {
                            biased;
                            _ = child_handle.cancel().cancelled() => None,
                            permit = child_slot(server_key) => permit,
                        };
                        let result = if permit.is_none() || child_handle.is_cancelled() {
                            Err(StopReason::Cancelled("Cancelled before the investigation started".to_string()))
                        } else if !child_io.connected(&child.session_id).await {
                            /*
                             * 目标服务器断开只影响这一条子任务：不把整批任务
                             * 说成失败，也不假装命令跑过。
                             */
                            let reason = "Target server is disconnected; this investigation did not run. Other investigations are unaffected.";
                            handle.patch_step(child_index, |step| {
                                step.state = "failed".into();
                                step.category = Some(StepCategory::Denied);
                                step.blocked = Some("server_disconnected".into());
                                step.stderr = reason.to_string();
                            });
                            if let Some(step) = handle.step(child_index) { io.emit(AgentEvent::from_step(&input.task_id, "tool_finished", &step)); }
                            drop(permit);
                            return (id, false, format!("{title}: {reason}"));
                        } else {
                            handle.patch_step(child_index, |step| step.state = "running".into());
                            if let Some(step) = handle.step(child_index) { io.emit(AgentEvent::from_step(&input.task_id, "tool_started", &step)); }
                            match tokio::time::timeout(CHILD_TIMEOUT, Box::pin(run_loop(&child_handle, &child, child_io, resolved_effort))).await {
                                Ok(result) => result,
                                Err(_) => Err(StopReason::Failed("Investigation timed out; server command state may be unknown".to_string())),
                            }
                        };
                        drop(permit);
                        let snapshot = child_handle.snapshot();
                        let evidence = snapshot.steps.iter().filter(|s| s.category == Some(StepCategory::Executed) && s.state == "success").count();
                        let executed_failures = snapshot.steps.iter().any(|s| s.category == Some(StepCategory::Executed) && s.state == "failed");
                        let details = snapshot.steps.iter().filter(|s| s.category == Some(StepCategory::Executed)).map(|s| format!("{} [{}]: {}", redact(&s.command), s.state, redact(if s.state == "success" { &s.stdout } else { &s.stderr }).chars().take(500).collect::<String>())).collect::<Vec<_>>().join("\n");
                        /*
                         * 被只读边界拦下的写操作 / MCP 调用要显式回传主 Agent，
                         * 否则子任务会因为"没权限"静默少做一步。
                         */
                        let mut write_requests: Vec<String> = snapshot.steps.iter()
                            .filter(|s| matches!(s.blocked.as_deref(), Some("read_only" | "permission")) && s.risk != "read")
                            .map(|s| format!("- {}: {}", s.tool, redact(&s.command)))
                            .collect();
                        write_requests.dedup();
                        let request_block = if write_requests.is_empty() {
                            String::new()
                        } else {
                            format!(
                                "\n\nWRITE_REQUEST (not executed; parent must handle through the normal approval flow):\n{}",
                                write_requests.join("\n")
                            )
                        };
                        let (mut ok, mut text) = match result {
                            Ok(content) if evidence > 0 && !executed_failures => (true, format!("{}\n\nEvidence:\n{}{}", redact(&content), details, request_block)),
                            Ok(content) if evidence > 0 => (false, format!("Partial result: {}\n\nEvidence:\n{}{}", redact(&content), details, request_block)),
                            Ok(_) => (false, format!("No successful tool evidence; unverified{request_block}")),
                            Err(StopReason::Cancelled(_)) => (false, format!("Cancelled; verify server state if needed{request_block}")),
                            Err(StopReason::Failed(reason)) => (false, format!("Failed: {}{}", redact(&reason), request_block)),
                        };
                        /*
                         * 被只读边界拦下的写操作说明这次调查**没有完成**：
                         * 不能因为前面的只读命令成功就把子任务标成全部成功，
                         * 否则父任务会把"还差一步写"当成已完成。
                         */
                        if !request_block.is_empty() {
                            ok = false;
                            text = format!(
                                "Incomplete: the read-only boundary blocked a required step; the parent must handle it through the normal approval flow.\n{text}"
                            );
                        }
                        let text: String = text.chars().take(MODEL_OUTPUT_LIMIT).collect();
                        handle.patch_step(child_index, |step| {
                            step.state = if ok { "success" } else if handle.is_cancelled() { "skipped" } else { "failed" }.into();
                            step.category = Some(StepCategory::Executed);
                            step.child_usage = snapshot.context.as_ref().map(|context| context.cumulative.clone());
                            step.elapsed_ms = began.elapsed().as_millis().min(u64::MAX as u128) as u64;
                            if ok { step.stdout = text.clone(); } else { step.stderr = text.clone(); }
                        });
                        if let Some(step) = handle.step(child_index) { io.emit(AgentEvent::from_step(&input.task_id, "tool_finished", &step)); }
                        (id, ok, format!("{title} [{} / {}]: {text}", server.server_name, server.server_id))
                    }
                });
                    for (id, ok, text) in futures_util::future::join_all(jobs).await {
                        completed.insert(id, (ok, text));
                    }
                }
                let mut outcomes: Vec<_> = completed.into_values().collect();
                outcomes.sort_by(|a, b| a.1.cmp(&b.1));
                let all_ok = outcomes.iter().all(|(ok, _)| *ok);
                let any_stale = handle.snapshot().steps.iter().any(|step| step.group_id.as_deref() == Some(group_id.as_str()) && step.stale);
                let results = outcomes.into_iter().map(|(_, text)| text).collect::<Vec<_>>().join("\n\n");
                handle.patch_step(index, |step| {
                    step.state = if handle.is_cancelled() { "skipped" } else if all_ok { "success" } else { "failed" }.into();
                    step.stale = any_stale;
                    if all_ok { step.stdout = results.clone(); } else { step.stderr = results.clone(); }
                });
                if let Some(step) = handle.step(index) { io.emit(AgentEvent::from_step(&input.task_id, "tool_finished", &step)); }
                let plan_state = plan_step_id.as_deref().and_then(|id| {
                    let plan = handle.snapshot().plan?;
                    let step = plan.step(id)?;
                    if step.kind == "action" || handle.is_cancelled() {
                        return None;
                    }
                    if any_stale && all_ok {
                        return Some("pending");
                    }
                    plan.next_step_state(id, all_ok, true)
                });
                if let Some(state) = plan_state { sync_plan_step(io, handle, &input.task_id, index, state, Some(if all_ok && !any_stale { "Read-only investigations completed" } else { "Some investigations failed or remain unverified" })); }
                tool_messages.push(if all_ok { tool_ok_message(&raw.id, raw.native, &raw.name, &results) } else { tool_error_message(&raw.id, raw.native, &raw.name, &results) });
                if handle.is_cancelled() { return Err(StopReason::Cancelled(ui(lang, "已停止", "Stopped"))); }
                continue;
            }
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
                fail_step_denied(io, handle, index, &reason, "sudo");
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }

            /*
             * MCP 工具走自己的执行分支：工具定义在启动时已绑定，`step` 参数
             * 只用于计划校验，不能透给服务端。
             *
             * **风险按调用前的实时声明重算**，不沿用启动时的 `read_only`：
             * 服务停用 / 工具停用 / 授权撤销 / 只读声明被改掉后，这一步必须
             * 重新走确认或直接拦下，不能靠旧绑定"已经是只读"放行。
             */
            let mut mcp_binding = input
                .mcp_tools
                .iter()
                .find(|item| item.exposed_name == raw.name)
                .cloned();
            if let Some(binding) = mcp_binding.as_mut() {
                if let Err(reject) = crate::mcp::revalidate_binding(
                    input.db.as_deref(),
                    binding,
                    input.child_run,
                ) {
                    let reason = reject.reason_lang(lang, input.child_run);
                    let blocked = reject.blocked_code();
                    // 先把这次调用的目标写进步骤：子任务回传写需求 / 展开审计时要看得到。
                    handle.patch_step(index, |step| {
                        step.risk = "write".into();
                        step.command = format!("mcp://{}/{}", binding.server_id, binding.tool);
                        step.summary = Some(binding.description.chars().take(120).collect());
                        step.server = Some(binding.server_name.clone());
                    });
                    fail_step_denied(io, handle, index, &reason, blocked);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                    continue;
                }
            }
            let mut planned = if let Some(binding) = mcp_binding {
                let mut call_args = args.clone();
                if let Some(object) = call_args.as_object_mut() {
                    object.remove("step");
                }
                let args_json = serde_json::to_string(&call_args).unwrap_or_default();
                let args_text: String = args_json.chars().take(300).collect();
                let effect = binding.effect();
                let risk = match effect {
                    crate::mcp::McpEffect::DeclaredReadOnly => ToolRisk::Read,
                    // 写入 / 影响未知都按写处理：只读模式直接拦，其他模式走确认。
                    crate::mcp::McpEffect::Write | crate::mcp::McpEffect::Unknown => {
                        ToolRisk::Write
                    }
                };
                let basis = match effect {
                    crate::mcp::McpEffect::DeclaredReadOnly => Some(match lang {
                        Lang::Zh => "只读依据：MCP 服务声明（平台未独立验证）",
                        Lang::En => {
                            "Read-only basis: declared by the MCP service (not independently verified)"
                        }
                    }),
                    crate::mcp::McpEffect::Write => Some(match lang {
                        Lang::Zh => "MCP 服务声明该工具可能写入",
                        Lang::En => "The MCP service declares that this tool may write",
                    }),
                    crate::mcp::McpEffect::Unknown => Some(match lang {
                        Lang::Zh => "MCP 只读声明与工具名称 / 参数冲突，影响未知",
                        Lang::En => {
                            "The MCP read-only claim conflicts with the tool name/parameters; effect unknown"
                        }
                    }),
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
                    summary: Some(binding.description.chars().take(120).collect::<String>()),
                    timeout: Duration::from_secs(120),
                    path: None,
                    impact: Some(match (lang, basis) {
                        (Lang::Zh, Some(basis)) => format!(
                            "调用 MCP 服务「{}」的工具；参数：{args_text}。{basis}",
                            binding.server_name
                        ),
                        (Lang::En, Some(basis)) => format!(
                            "Calls an MCP tool on server \"{}\"; arguments: {args_text}. {basis}",
                            binding.server_name
                        ),
                        (Lang::Zh, None) => format!(
                            "调用 MCP 服务「{}」的工具；参数：{args_text}",
                            binding.server_name
                        ),
                        (Lang::En, None) => format!(
                            "Calls an MCP tool on server \"{}\"; arguments: {args_text}",
                            binding.server_name
                        ),
                    }),
                    rollback: None,
                    backup_path: None,
                    // MCP 的影响来自第三方声明，不是平台解析出的命令。
                    unknown: None,
                    declared: None,
                    write_content: None,
                    mcp: Some(binding),
                }
            } else {
                match plan_tool_for_locale(
                    &raw.name,
                    &args,
                    &handle.snapshot().cwd,
                    crate::db::AppDb::now() as u64,
                    &backup_policy,
                    lang,
                ) {
                    Ok(mut planned) => {
                        planned.call.id = call_id.clone();
                        planned
                    }
                    Err(reason) => {
                        // 工具参数不合法：模型自己修正，不属于服务器失败。
                        bounce_step(io, handle, &input.task_id, index, &reason);
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
                        let previous_target = previous.target.as_deref().unwrap_or(match lang {
                            Lang::Zh => "当前目录",
                            Lang::En => "the current directory",
                        });
                        let current_target = current.target.as_deref().unwrap_or(match lang {
                            Lang::Zh => "当前目录",
                            Lang::En => "the current directory",
                        });
                        changes.push(match lang {
                            Lang::Zh => {
                                format!("目标目录从 {previous_target} 改为 {current_target}")
                            }
                            Lang::En => {
                                format!("target changed from {previous_target} to {current_target}")
                            }
                        });
                    }
                    if previous.overwrite != current.overwrite {
                        changes.push(match lang {
                            Lang::Zh => format!(
                                "覆盖策略从 {} 改为 {}",
                                previous.overwrite.label_lang(lang),
                                current.overwrite.label_lang(lang)
                            ),
                            Lang::En => format!(
                                "overwrite policy changed from {} to {}",
                                previous.overwrite.label_lang(lang),
                                current.overwrite.label_lang(lang)
                            ),
                        });
                    }
                    if previous.listing != current.listing {
                        changes.push(match (lang, current.listing) {
                            (Lang::Zh, true) => "从解压改为只查看归档内容".to_string(),
                            (Lang::Zh, false) => "从查看归档改为真正解压".to_string(),
                            (Lang::En, true) => {
                                "changed from extracting to listing only".to_string()
                            }
                            (Lang::En, false) => {
                                "changed from listing to actually extracting".to_string()
                            }
                        });
                    }
                    let separator = match lang {
                        Lang::Zh => "；",
                        Lang::En => "; ",
                    };
                    let before = planned.impact.take().unwrap_or_default();
                    planned.impact = Some(if before.is_empty() {
                        changes.join(separator)
                    } else {
                        match lang {
                            Lang::Zh => {
                                format!("{before}；与上次相比：{}", changes.join(separator))
                            }
                            Lang::En => format!(
                                "{before}; compared with the previous attempt: {}",
                                changes.join(separator)
                            ),
                        }
                    });
                }
            }
            if archive_now.is_some() {
                last_archive = archive_now;
            }

            let severe = severe_operation_reason_lang(&planned, lang);
            /*
             * 只读模式不是"每次都确认"，而是**直接拒绝**写 / 危险操作：
             * 不产生审批，也不下发命令；模型拿到原因后应改用只读方案。
             */
            let decision =
                permission_decision(input.permission_mode, &planned, input.auto_approve_writes);
            let read_only_blocked = decision == PermissionDecision::Block;
            let needs_approval = decision == PermissionDecision::Confirm && decided != Some(true);
            if let Some(reason) = &severe {
                planned.impact = Some(match planned.impact.take() {
                    Some(impact) if !impact.is_empty() => match lang {
                        Lang::Zh => format!("{impact}；需要二次确认：{reason}"),
                        Lang::En => format!("{impact}; extra confirmation required: {reason}"),
                    },
                    _ => match lang {
                        Lang::Zh => format!("需要二次确认：{reason}"),
                        Lang::En => format!("Extra confirmation required: {reason}"),
                    },
                });
            }
            /*
             * AI 自述"这一步只读"，但平台解析出写操作：**先把冲突回给模型**。
             *
             * 权限判定不变（写操作照旧要确认），只是不让用户在确认卡上看到
             * "AI 说是查询、平台说是删除"的矛盾，也让模型自己修正判断。
             */
            if let Some(declaration) = planned.declared.as_ref() {
                if declaration.claims_read()
                    && risk != ToolRisk::Read
                    && needs_approval
                    && !out_of_scope
                    && !read_only_blocked
                    && unknown_bounces < 3
                    && asked_unknown.insert(format!("intent:{op_signature}"))
                {
                    unknown_bounces += 1;
                    let summary = planned.summary.clone().unwrap_or_default();
                    let zh = format!(
                        "你声明这一步是只读（intent=read），但命令里有写操作：{summary}。\
                         请改用纯只读命令（例如 docker ps / sha256sum / stat），\
                         或把 intent 改成 change 再提交。"
                    );
                    let en = format!(
                        "You declared this step as read-only (intent=read), but the command contains a write: {summary}. \
                         Use a purely read-only command (e.g. docker ps / sha256sum / stat), or submit with intent=change."
                    );
                    let reason = ui(lang, &zh, &en);
                    handle.patch_step(index, |step| {
                        step.risk = risk.as_str().to_string();
                        step.command = display_command.clone();
                        step.summary = planned.summary.clone();
                        step.impact = planned.impact.clone();
                    });
                    // 内部纠错：命令没有执行，用户不需要看到红色失败卡。
                    bounce_step(io, handle, &input.task_id, index, &reason);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                    continue;
                }
            }

            /*
             * 看不懂的命令：**先让模型自己改**。
             *
             * 平台解析不了这条命令时直接弹确认，等于把"猜"的锅甩给用户。先把
             * 具体片段和原因回给模型，让它拆成多条可核对的命令 / 换成明确的
             * 工具；同一条签名第二次出现说明它确实改不了，才按正常审批交给
             * 用户决定（不反复问同一个问题）。
             */
            if planned.unknown.is_some()
                && needs_approval
                && !out_of_scope
                && !read_only_blocked
                && unknown_bounces < 3
                && asked_unknown.insert(op_signature.clone())
            {
                unknown_bounces += 1;
                let fragment = planned.unknown.clone().unwrap_or_default();
                let zh = format!(
                    "无法判断这条命令会做什么：`{fragment}`。\
                     请拆成多条可核对的命令，或改用明确的绝对路径 / 专用工具后重试；\
                     确实必须原样执行时，说明原因，平台会让用户确认。"
                );
                let en = format!(
                    "Cannot determine what this command does: `{fragment}`. \
                     Split it into verifiable commands, or use explicit absolute paths / a dedicated tool and retry; \
                     if it must run as-is, explain why and the platform will ask the user."
                );
                let reason = ui(lang, &zh, &en);
                handle.patch_step(index, |step| {
                    step.risk = risk.as_str().to_string();
                    step.command = display_command.clone();
                    step.summary = planned.summary.clone();
                    step.impact = planned.impact.clone();
                });
                // 看不懂的命令同样是内部纠正：先让模型改写，不当作服务器失败。
                bounce_step(io, handle, &input.task_id, index, &reason);
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
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
            // 运行态只是展示状态；保留开始前的状态，判断只读操作是否真的在验证写入。
            let prior_plan_state = handle.snapshot().plan.as_ref().and_then(|plan| {
                plan_step_id
                    .as_deref()
                    .and_then(|id| plan.step(id))
                    .map(|step| step.state.clone())
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
                        // AI 自己说明了这一步的目的就用它；没写才由平台补一句。
                        event.note = Some(
                            match planned
                                .declared
                                .as_ref()
                                .and_then(|item| item.purpose.as_deref())
                            {
                                Some(purpose) => purpose.to_string(),
                                None => preamble_text(
                                    lang,
                                    planned.summary.as_deref(),
                                    &planned.call.name,
                                    planned.path.as_deref(),
                                    &planned.display,
                                ),
                            },
                        );
                    }
                    noted_groups.insert(group_id.clone());
                }
                io.emit(event);
            }

            if read_only_blocked {
                let reason = if input.child_run {
                    match lang {
                        Lang::Zh => "子任务只读：这条命令会写 / 删除，已拒绝执行。请把目标、命令与预期影响作为 WRITE_REQUEST 返回主 Agent，由主 Agent 走确认流程。",
                        Lang::En => "Child agents are read-only: this command may write or delete, so it was not executed. Return the target, command and expected impact as a WRITE_REQUEST for the parent agent to run through its approval flow.",
                    }
                } else {
                    match lang {
                        Lang::Zh => "只读模式：这条命令会写 / 删除，已拒绝执行。切到「按需确认」后才能执行。",
                        Lang::En => "Read-only mode: this command may write or delete, so it was not executed. Switch to Ask to run it.",
                    }
                }
                .to_string();
                fail_step_denied(io, handle, index, &reason, "read_only");
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }

            /*
             * **查询范围是执行器边界**：用户只要查询时，写 / 改 / 删直接拦下，
             * 不弹确认（两种权限都一样）。模型拿到原因后应改用只读命令。
             */
            if out_of_scope {
                let reason = ui(
                    lang,
                    "这次任务只要求查询：写 / 改 / 删被拦下。\
                     改用只读命令（ps、docker ps、systemctl status、df…）；\
                     确实需要改动时，先请用户明确说明。",
                    "This task is query-only, so writes/changes/deletes were blocked. Use read-only commands (ps, docker ps, systemctl status, df...); if a change is really needed, ask the user to confirm it explicitly.",
                );
                skip_step(io, handle, &input.task_id, index, &reason, "query_only");
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }
            /*
             * 拒绝过的操作换写法也不再问：直接告给模型，别再试探。
             */
            if decided == Some(false) {
                let reason = ui(
                    lang,
                    "用户已经拒绝过这个操作：换一种写法也不会执行。\
                     先按已有信息汇报，或请用户明确改变要求。",
                    "The user already rejected this operation; a different spelling will not run either. Report what you know, or ask the user to change the requirement explicitly.",
                );
                skip_step(io, handle, &input.task_id, index, &reason, "user_denied");
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
                        let cached = match lang {
                            Lang::Zh => format!(
                                "{result}\n（同一操作已成功执行，直接复用上次结果；请做只读验证，不要重复解压或写入。）"
                            ),
                            Lang::En => format!(
                                "{result}\n(The same operation already succeeded; reuse that result and do a read-only verification instead of extracting or writing again.)"
                            ),
                        };
                        let summary = ui(
                            lang,
                            "复用上次成功结果（未重复执行）",
                            "Reused the previous successful result (not executed again)",
                        );
                        handle.patch_step(index, |step| {
                            step.state = "success".to_string();
                            // 复用成功结果 = 这次写入确实发生过（只是没有重跑）。
                            step.category = Some(StepCategory::Executed);
                            step.summary = Some(summary.clone());
                            step.exit_code = Some(0);
                        });
                        let evidence = ui(
                            lang,
                            "复用上次成功结果",
                            "Reused the previous successful result",
                        );
                        // 复用写入结果并不等于验证通过：保留此前的完成/待验证
                        // 状态；新的写入步骤仍按其验证要求进入待验证。
                        let reused_plan_state = match prior_plan_state.as_deref() {
                            Some("done") => "done",
                            Some("verifying") => "verifying",
                            _ => handle
                                .snapshot()
                                .plan
                                .as_ref()
                                .and_then(|plan| {
                                    plan_step_id.as_deref().and_then(|id| plan.step(id))
                                })
                                .map(|step| {
                                    if step.kind == "action" && !step.verify.trim().is_empty() {
                                        "verifying"
                                    } else {
                                        "done"
                                    }
                                })
                                .unwrap_or("done"),
                        };
                        sync_plan_step(
                            io,
                            handle,
                            &input.task_id,
                            index,
                            reused_plan_state,
                            Some(&evidence),
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
                        let reason = ui(
                            lang,
                            "同一操作已执行两次且都失败；不要再用等价命令重试。\
                             请先读上一条真实错误，向用户说明失败原因。",
                            "This operation failed twice; do not retry with an equivalent command. Read the real error and explain the failure to the user.",
                        );
                        skip_step_internal(io, handle, &input.task_id, index, &reason, "duplicate");
                        tool_messages
                            .push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                        continue;
                    }
                }
            }

            /*
             * **结果不确定的写操作不自动重放。**
             *
             * SSH 中断 / 超时会让"命令到底执行了没有"没有答案；此时直接重试
             * 可能把同一次部署做两遍。要求先跑一次只读核对（`read_ok_round`
             * 必须晚于那次不确定的失败），模型拿到真实状态后再决定是否重试。
             */
            if risk != ToolRisk::Read {
                if let Some(failed_round) = uncertain_ops.get(&op_signature).copied() {
                    if read_ok_round <= failed_round {
                        let reason = ui(
                            lang,
                            "上一次写入的连接中断，无法确认服务器上是否已经执行。\
                             直接重试可能重复写入；请先做只读核对（查看目标文件 / 目录 / 服务状态），\
                             确认实际结果后再决定是否重试。",
                            "The previous write lost its connection, so it is unknown whether it ran. \
                             Retrying now could apply it twice; first verify the target file, directory or service (read-only), then decide whether to retry.",
                        );
                        skip_step_internal(io, handle, &input.task_id, index, &reason, "uncertain");
                        tool_messages
                            .push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                        continue;
                    }
                    // 已经核对过真实状态：这次按证据重试，不再算"不确定"。
                    uncertain_ops.remove(&op_signature);
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
                            params: serde_json::to_string(&planned.call.args).unwrap_or_default(),
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
                        skip_step(io, handle, &input.task_id, index, &reason, "withdrawn");
                        if let Some(id) = &change_id {
                            io.changes().update(id, |record| {
                                record.status = "withdrawn".to_string();
                                // 保留预览：撤回也要能看到当时准备改什么（但绝不执行）。
                                record.note = Some(ui(
                                    lang,
                                    "按新的要求撤回，这一步没有执行",
                                    "Withdrawn per the new requirement; this step did not run",
                                ));
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
                        event.message = Some(ui(
                            lang,
                            "已收到新的要求，撤回了这条待确认操作。",
                            "New requirement received; the pending operation was withdrawn.",
                        ));
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
                            let reason = ui(
                                lang,
                                "用户拒绝执行这条命令",
                                "The user rejected this command",
                            );
                            fail_step_denied(io, handle, index, &reason, "user_denied");
                            // 计划里这一步是「未执行」，不是命令失败。
                            let rejected = ui(lang, "用户拒绝执行", "Rejected by the user");
                            sync_plan_step(
                                io,
                                handle,
                                &input.task_id,
                                index,
                                "skipped",
                                Some(&rejected),
                            );
                            if let Some(id) = &change_id {
                                io.changes().update(id, |record| {
                                    record.status = "rejected".to_string();
                                    record.note = Some(ui(
                                        lang,
                                        "用户拒绝执行：服务器上的文件没有改动",
                                        "Rejected by the user; the server file was not changed",
                                    ));
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
                            // 用户主动停止：不是执行失败，也不是服务器故障。
                            handle.patch_step(index, |step| {
                                step.category = Some(StepCategory::Denied);
                                step.blocked = Some("cancelled".to_string());
                            });
                            mark_step_aborted(
                                io,
                                handle,
                                index,
                                &ui(
                                    lang,
                                    "已取消（用户停止），命令没有执行",
                                    "Cancelled by the user; the command did not run",
                                ),
                            );
                            return Err(StopReason::Cancelled(match lang {
                                Lang::Zh => format!(
                                    "已停止：等待确认时收到停止信号（停在「{}」）",
                                    describe_step(&raw.name, &args)
                                ),
                                Lang::En => format!(
                                    "Stopped: a stop signal arrived while waiting for approval (stopped at \"{}\")",
                                    describe_step(&raw.name, &args)
                                ),
                            }));
                        }
                        Decision::Timeout => {
                            // 确认过期：命令没有执行，不是服务器失败。
                            handle.patch_step(index, |step| {
                                step.category = Some(StepCategory::Denied);
                                step.blocked = Some("expired".to_string());
                            });
                            mark_step_aborted(
                                io,
                                handle,
                                index,
                                &ui(
                                    lang,
                                    "确认已过期，命令没有执行",
                                    "The approval expired; the command did not run",
                                ),
                            );
                            return Err(StopReason::Failed(match lang {
                                Lang::Zh => format!(
                                    "确认已过期（等待超过 {} 分钟），已停止（停在「{}」）",
                                    APPROVAL_SECONDS / 60,
                                    describe_step(&raw.name, &args)
                                ),
                                Lang::En => format!(
                                    "The approval expired after {} minutes; stopped (at \"{}\")",
                                    APPROVAL_SECONDS / 60,
                                    describe_step(&raw.name, &args)
                                ),
                            }));
                        }
                    }

                    /*
                     * 允许之后**再核对一次文件版本**：确认卡上的 Diff 是发起确认
                     * 时读到的，中间可能被别的会话 / 用户改过。
                     */
                    if let Some(id) = change_id.clone() {
                        if attempt >= 2 {
                            let reason = ui(
                                lang,
                                "文件在确认期间被反复修改，已停止这次写入",
                                "The file kept changing during approval, so the write was stopped",
                            );
                            fail_step_denied(io, handle, index, &reason, "preview_stale");
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
                let waiting_summary = ui(
                    lang,
                    "等待该服务上的操作完成",
                    "Waiting for the operation on this service to finish",
                );
                handle.patch_step(index, |step| {
                    step.summary = Some(waiting_summary);
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
                        let reason = ui(
                            lang,
                            "等待该服务上的操作完成时被取消，这一步没有执行。",
                            "Cancelled while waiting for the operation on this service; this step did not run.",
                        );
                        skip_step(io, handle, &input.task_id, index, &reason, "cancelled");
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
                /*
                 * 连接中断 ≠ 命令失败：断开时这条命令可能已经发出去了。
                 * 不伪装成"执行失败"，也不假装确定，直接说明结果未知。
                 */
                let reason = ui(
                    lang,
                    "连接已中断：无法确认这一步是否已经在服务器上执行。重新连接后先核对目标文件 / 服务状态，再决定是否重试。",
                    "The connection was lost: it is unknown whether this step already ran on the server. Reconnect, verify the target file or service, then decide whether to retry.",
                );
                fail_step(io, handle, index, &reason);
                return Err(StopReason::Failed(reason));
            }
            // 每条命令执行前再核对一次服务器绑定（切服后绝不误发）。
            if let Err(reason) = io.verify_server(&input.session_id, &input.server) {
                fail_step(io, handle, index, &reason);
                return Err(StopReason::Failed(reason));
            }

            if input.child_run && handle.is_cancelled() {
                let reason = ui(lang, "任务已停止，这一步未执行。", "Stopped before this operation was sent.");
                skip_step(io, handle, &input.task_id, index, &reason, "cancelled");
                return Err(StopReason::Cancelled(reason));
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
                 * 执行前复查（TOCTOU）：服务被停用 / 工具被取消启用 / 授权撤销 /
                 * 只读声明变化后，本轮剩余调用立即禁止。
                 *
                 * 这里必须给模型回一条 tool 结果：原生 tool_calls 少一条
                 * `role: tool` 会让下一轮请求直接 400，也会让子任务「静默失败」。
                 */
                let declared_read = binding.effect() == crate::mcp::McpEffect::DeclaredReadOnly;
                let mut rejected: Option<(String, &'static str)> = None;
                match crate::mcp::revalidate_binding(
                    input.db.as_deref(),
                    &mut binding,
                    input.child_run,
                ) {
                    Ok(()) => {
                        // 批准的是"只读"，执行时却变成了写入 / 未知：不能放行。
                        if declared_read && binding.effect() != crate::mcp::McpEffect::DeclaredReadOnly {
                            rejected = Some((
                                ui(
                                    lang,
                                    "该 MCP 工具在确认后改变了只读声明：这次调用没有执行，请重新评估。",
                                    "This MCP tool changed its read-only declaration after approval, so the call did not run; re-evaluate before retrying.",
                                ),
                                "permission",
                            ));
                        }
                    }
                    Err(reject) => rejected = Some((reject.reason_lang(lang, input.child_run), reject.blocked_code())),
                }
                if let Some((reason, blocked)) = rejected {
                    fail_step_denied(io, handle, index, &reason, blocked);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                    continue;
                }
                // MCP 没有 SSH 流式输出：一次调用结束后把结果交给现有步骤。
                match io.call_mcp(&binding, &planned.call.args).await {
                    Ok(text) => Ok(ExecOutput {
                        stdout: text,
                        stderr: String::new(),
                        exit_code: Some(0),
                        truncated: false,
                    }),
                    Err(error) => Ok(ExecOutput {
                        stdout: String::new(),
                        stderr: match lang {
                            Lang::Zh => format!("MCP 调用失败：{error}"),
                            Lang::En => format!("MCP call failed: {error}"),
                        },
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
                        stderr.push_str(match lang {
                            Lang::Zh => "\n目标目录不存在或不可进入，命令未执行（先用 list_dir 确认路径）",
                            Lang::En => "\nThe working directory does not exist or cannot be entered; the command did not run (confirm the path with list_dir first).",
                        });
                    }
                    if marked.backup_failed {
                        stderr.push_str(match lang {
                            Lang::Zh => "\n备份失败，已取消写入（没有改动原文件）",
                            Lang::En => "\nBackup failed; the write was cancelled (the original file was not changed).",
                        });
                    }
                    /*
                     * 归档失败不能只看退出码里的一个特征串：
                     * * 管道会吞掉 `unzip` 的退出码 —— 由 `wrap_with_cwd` 的
                     *   `pipefail` 把失败传回来（缺包 / 坏包 / 非零退出）；
                     * * `Usage: unzip` 是参数错误的一种表现，仍然保留这层兜底；
                     * * `unzip -p` 以 0 退出却没有任何输出，同样不是"读到了"。
                     */
                    let archive_usage = planned.display.contains("unzip")
                        && (marked.stdout.contains("Usage: unzip")
                            || stderr.contains("Usage: unzip"));
                    if archive_usage {
                        stderr.push_str(match lang {
                            Lang::Zh => "\n未能打开归档，请检查归档路径和参数。",
                            Lang::En => {
                                "\nThe archive could not be opened; check its path and flags."
                            }
                        });
                    }
                    let archive_empty = archive_read_is_empty(&planned.display, &marked.stdout);
                    if archive_empty {
                        stderr.push_str(match lang {
                            Lang::Zh => "\n没有从归档里读到内容（可能条目不存在或归档损坏）。",
                            Lang::En => "\nNothing was read from the archive (the entry may not exist, or the archive is corrupt).",
                        });
                    }
                    // 退出码被管道吞掉时，stderr 仍然是缺包 / 坏包的证据。
                    let archive_hint = archive_error_hint_lang(&planned.display, &stderr, lang);
                    if let Some(reason) = archive_hint {
                        stderr.push('\n');
                        stderr.push_str(reason);
                        stderr.push_str(match lang {
                            Lang::Zh => "，这一步没有完成。",
                            Lang::En => "; this step did not complete.",
                        });
                    }
                    let ok = output.exit_code == Some(0)
                        && !marked.pwd_failed
                        && !marked.backup_failed
                        && !archive_usage
                        && !archive_empty
                        && archive_hint.is_none();
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
                // 工具真的跑过：成功 / 失败由 state 与退出码说明，类别不再是内部纠错。
                step.category = Some(StepCategory::Executed);
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
            /*
             * 结果是否"确定"：
             * * 只读成功 → 记下轮次，供"不确定的写"判断是否已经核对过；
             * * 写操作没有退出码（连接中断 / 超时）→ 记成不确定，禁止自动重放；
             * * 明确的退出码 → 无论成功失败，结果都已知，不再是"不确定"。
             */
            if risk == ToolRisk::Read {
                if ok {
                    read_ok_round = round;
                }
            } else if exit_code.is_none() {
                uncertain_ops.insert(op_signature.clone(), round);
            } else {
                uncertain_ops.remove(&op_signature);
            }
            // 计划步骤的状态只认这条真实结果：成功 / 失败，证据取真实输出首行。
            let plan_evidence = if ok {
                first_line(&stdout, 120)
            } else {
                first_line(&stderr, 120)
            };
            /*
             * 计划步骤按**真实执行 + 验证证据**推进（见 `AgentPlan::next_step_state`）：
             * 探测成功不能完成写入步骤；写入成功停在 `verifying`，等这一步要求
             * 的只读核对真的跑过一次才算完成。
             */
            let next_state = {
                let snapshot = handle.snapshot();
                plan_step_id.as_deref().and_then(|id| {
                    snapshot
                        .plan
                        .map(|mut current| {
                            if let (Some(previous), Some(step)) = (
                                prior_plan_state.as_deref(),
                                current
                                    .steps
                                    .iter_mut()
                                    .find(|step| step.id == id && !step.superseded),
                            ) {
                                step.state = previous.to_string();
                            }
                            current.next_step_state(id, ok, risk == ToolRisk::Read)
                        })
                        .flatten()
                })
            };
            if let Some(state) = next_state {
                sync_plan_step(
                    io,
                    handle,
                    &input.task_id,
                    index,
                    state,
                    Some(&plan_evidence),
                );
            }

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
                event.stderr = Some(match lang {
                    Lang::Zh => "\n…（输出过长，已截断）\n".to_string(),
                    Lang::En => "\n… (output too long; truncated)\n".to_string(),
                });
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

    Err(StopReason::Failed(match lang {
        Lang::Zh => format!(
            "这次任务已经尝试了 {} 轮，仍未得出结论，先停在这里{}",
            rounds,
            last_step_hint(handle, lang)
        ),
        Lang::En => format!(
            "This task ran {} rounds without reaching a conclusion; stopping here{}",
            rounds,
            last_step_hint(handle, lang)
        ),
    }))
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
    let lang = Lang::from_locale(input.locale.as_deref());
    let draft: AskUserDraft =
        serde_json::from_str(raw.body.trim()).map_err(|error| match lang {
            Lang::Zh => format!("ask_user 参数不合法：{error}"),
            Lang::En => format!("Invalid ask_user arguments: {error}"),
        })?;
    let question = draft.question.trim();
    if question.is_empty() {
        return Err(ui(
            lang,
            "ask_user 需要提供问题内容",
            "ask_user requires the question text",
        ));
    }
    if question.chars().count() > 2000 {
        return Err(ui(
            lang,
            "ask_user 的问题过长（上限 2000 字）",
            "The ask_user question is too long (limit 2000 characters)",
        ));
    }
    let kind = draft.kind.trim().to_ascii_lowercase();
    if kind != "single" && kind != "multi" {
        return Err(ui(
            lang,
            "ask_user 的 kind 只能是 single 或 multi",
            "ask_user kind must be single or multi",
        ));
    }
    if draft.options.len() > 20 {
        return Err(ui(
            lang,
            "ask_user 最多提供 20 个选项",
            "ask_user accepts at most 20 options",
        ));
    }
    let mut options = Vec::with_capacity(draft.options.len());
    let mut seen = std::collections::HashSet::new();
    for option in draft.options {
        let id = option.id.trim();
        let label = option.label.trim();
        if id.is_empty() || label.is_empty() {
            return Err(ui(
                lang,
                "ask_user 的每个选项都需要 id 和名称",
                "Every ask_user option needs both an id and a label",
            ));
        }
        if id.chars().count() > 120 || label.chars().count() > 200 {
            return Err(ui(
                lang,
                "ask_user 的选项 id 或名称过长",
                "An ask_user option id or label is too long",
            ));
        }
        if !seen.insert(id.to_string()) {
            return Err(match lang {
                Lang::Zh => format!("ask_user 的选项 id 重复：{id}"),
                Lang::En => format!("Duplicate ask_user option id: {id}"),
            });
        }
        options.push(QuestionOption {
            id: id.to_string(),
            label: label.to_string(),
        });
    }
    if options.is_empty() && !draft.allow_custom {
        return Err(ui(
            lang,
            "ask_user 至少需要一个预设选项，或允许自定义回答",
            "ask_user needs at least one preset option, or must allow a custom answer",
        ));
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
        .filter(|step| !step.superseded && step.kind == "answer" && step.state != "done")
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

/// 平台把命令退回给模型（声明冲突 / 无法判断 / 参数不合法）：**没有执行**。
///
/// 这不是服务器失败：步骤落成 `skipped` + `internal`，界面收纳成一条内部调整，
/// 不刷红色失败卡；完整原因仍写进 `stderr`（诊断记录）并原样回给模型。
fn bounce_step(io: &dyn AgentIo, handle: &AgentHandle, task_id: &str, index: u32, reason: &str) {
    handle.patch_step(index, |step| {
        step.state = "skipped".to_string();
        step.category = Some(StepCategory::Internal);
        step.stderr = reason.to_string();
    });
    if let Some(step) = handle.step(index) {
        io.emit(AgentEvent::from_step(task_id, "tool_finished", &step));
    }
    sync_plan_step(io, handle, task_id, index, "skipped", Some(reason));
}

/// 一步"没有执行"（范围不允许 / 用户拒绝）：标成跳过并广播给界面。
///
/// `blocked` 是**结构化原因代码**（`read_only` / `query_only` / `user_denied`…），
/// 界面按当前语言写一句可行动的话；`reason` 是给模型和诊断看的完整说明。
fn skip_step(
    io: &dyn AgentIo,
    handle: &AgentHandle,
    task_id: &str,
    index: u32,
    reason: &str,
    blocked: &str,
) {
    skip_step_with(io, handle, task_id, index, reason, StepCategory::Denied, blocked);
}

/// 平台自身的去重 / 重试边界拦下的步骤：属于内部决策，不是权限拒绝。
fn skip_step_internal(
    io: &dyn AgentIo,
    handle: &AgentHandle,
    task_id: &str,
    index: u32,
    reason: &str,
    blocked: &str,
) {
    skip_step_with(io, handle, task_id, index, reason, StepCategory::Internal, blocked);
}

fn skip_step_with(
    io: &dyn AgentIo,
    handle: &AgentHandle,
    task_id: &str,
    index: u32,
    reason: &str,
    category: StepCategory,
    blocked: &str,
) {
    handle.patch_step(index, |step| {
        step.state = "skipped".to_string();
        step.category = Some(category);
        /*
         * **不把原因写进 `summary`**：`summary` 是界面上的操作名，原来这里写的是
         * 给模型看的指令（"改用只读命令…"），用户会把它当成这一步的标题读一遍。
         * 完整原因留在 `stderr`（展开可见）与计划步骤 evidence 里，审计不丢。
         */
        if !blocked.trim().is_empty() {
            step.blocked = Some(blocked.to_string());
        }
        step.stderr = reason.to_string();
    });
    if let Some(step) = handle.step(index) {
        io.emit(AgentEvent::from_step(task_id, "tool_finished", &step));
    }
    sync_plan_step(io, handle, task_id, index, "skipped", Some(reason));
}

/// 权限 / 审批 / 安全边界拦下的失败：可见，但类别不是"执行失败"。
fn fail_step_denied(
    io: &dyn AgentIo,
    handle: &AgentHandle,
    index: u32,
    reason: &str,
    blocked: &str,
) {
    handle.patch_step(index, |step| {
        step.category = Some(StepCategory::Denied);
        if !blocked.trim().is_empty() {
            step.blocked = Some(blocked.to_string());
        }
    });
    fail_step(io, handle, index, reason);
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

fn last_step_hint(handle: &AgentHandle, lang: Lang) -> String {
    handle
        .snapshot()
        .steps
        .iter()
        .rev()
        .find(|step| !step.command.is_empty())
        .map(|step| {
            let command = step.command.chars().take(80).collect::<String>();
            match lang {
                Lang::Zh => format!("（停在「{command}」）"),
                Lang::En => format!(" (stopped at \"{command}\")"),
            }
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod child_graph_tests {
    use super::parse_child_specs;
    use serde_json::json;

    fn binding(tool: &str, read_only: bool) -> crate::mcp::McpBinding {
        crate::mcp::McpBinding {
            exposed_name: format!("mcp__s__{tool}"),
            server_id: "server".into(),
            server_name: "server".into(),
            tool: tool.into(),
            description: String::new(),
            input_schema: json!({}),
            read_only,
            config: crate::mcp::McpServerConfig::default(),
        }
    }

    #[test]
    fn child_mcp_requires_declared_read_only_without_write_signals() {
        // 声明只读、名称无写入信号：子任务可用（仍会在调用前复查声明）。
        let mut inspect = binding("inspect", true);
        assert!(crate::mcp::revalidate_binding(None, &mut inspect, true).is_ok());

        // 声明只读但名称是删除：影响未知，子任务不能执行。
        let mut delete = binding("delete_file", true);
        assert_eq!(
            crate::mcp::revalidate_binding(None, &mut delete, true),
            Err(crate::mcp::McpReject::EffectUnknown)
        );

        // 没有只读声明：子任务直接拒绝，主 Agent 仍可按写入流程走。
        let mut write = binding("write_file", false);
        assert_eq!(
            crate::mcp::revalidate_binding(None, &mut write, true),
            Err(crate::mcp::McpReject::ReadOnlyRevoked)
        );
        assert!(crate::mcp::revalidate_binding(None, &mut write, false).is_ok());

        // 只读声明被撤销后，即便名称看起来无害也不能再当只读用。
        let mut revoked = binding("inspect", false);
        assert!(crate::mcp::revalidate_binding(None, &mut revoked, true).is_err());
    }

    #[test]
    fn child_server_must_be_in_the_authorized_list() {
        let servers = vec![
            super::AgentServerRef { server_id: "srv-a".into(), server_name: "prod".into(), session_id: "ssh-a".into() },
            super::AgentServerRef { server_id: "srv-b".into(), server_name: "test".into(), session_id: "ssh-b".into() },
        ];
        let resolved = super::resolve_child_server(Some("srv-b"), Some("srv-a"), "prod", "ssh-a", &servers).unwrap();
        assert_eq!(resolved.session_id, "ssh-b");
        assert_eq!(resolved.server_name, "test");
        // 省略 = 当前服务器。
        let parent = super::resolve_child_server(None, Some("srv-a"), "prod", "ssh-a", &servers).unwrap();
        assert_eq!(parent.session_id, "ssh-a");
        // 未知 / 伪造的会话 id 不能被当成目标。
        assert!(super::resolve_child_server(Some("ssh-evil"), Some("srv-a"), "prod", "ssh-a", &servers).is_err());
        assert!(super::resolve_child_server(Some("unknown"), Some("srv-a"), "prod", "ssh-a", &servers).is_err());
    }

    #[test]
    fn ambiguous_server_names_are_rejected_instead_of_guessed() {
        let servers = vec![
            super::AgentServerRef { server_id: "srv-a".into(), server_name: "prod".into(), session_id: "ssh-a".into() },
            super::AgentServerRef { server_id: "srv-b".into(), server_name: "prod".into(), session_id: "ssh-b".into() },
        ];
        let error = super::resolve_child_server(Some("prod"), Some("srv-c"), "other", "ssh-c", &servers).unwrap_err();
        assert!(error.contains("ambiguous"), "{error}");
        // 用精确 id 仍然可以选中。
        assert_eq!(
            super::resolve_child_server(Some("srv-b"), Some("srv-c"), "other", "ssh-c", &servers).unwrap().session_id,
            "ssh-b"
        );
    }

    #[test]
    fn carried_child_steps_are_not_reported_as_completed_or_running() {
        let mut steps = vec![
            crate::agent::AgentStep { index: 0, tool: "child_agent".into(), group_id: Some("children-0".into()), state: "running".into(), ..Default::default() },
            crate::agent::AgentStep { index: 1, tool: "child_agent".into(), group_id: Some("children-0".into()), state: "pending".into(), ..Default::default() },
            crate::agent::AgentStep { index: 2, tool: "child_agent".into(), group_id: Some("children-0".into()), state: "success".into(), child_id: Some("disk".into()), child_goal: Some("check disk".into()), ..Default::default() },
        ];
        super::normalize_carried_steps(&mut steps);
        assert_eq!(steps[0].state, "failed");
        assert_eq!(steps[0].blocked.as_deref(), Some("interrupted_unknown"));
        assert_eq!(steps[1].state, "skipped");
        assert_eq!(steps[1].blocked.as_deref(), Some("interrupted_pending"));
        assert_eq!(steps[2].state, "success");
        assert!(steps[2].stale, "completed results must be marked for re-verification");
    }

    #[test]
    fn carried_child_results_only_reuse_matching_id_goal_and_server() {
        let steps = vec![crate::agent::AgentStep {
            index: 0,
            tool: "child_agent".into(),
            group_id: Some("children-0".into()),
            state: "success".into(),
            child_id: Some("disk".into()),
            child_goal: Some("check disk".into()),
            server_id: Some("srv-a".into()),
            stdout: "df output".into(),
            ..Default::default()
        }];
        let carried = super::carried_child_results(&steps);
        assert!(carried.contains_key(&super::child_cache_key("srv-a", "disk", "check disk")));
        assert!(!carried.contains_key(&super::child_cache_key("srv-b", "disk", "check disk")));
        assert!(!carried.contains_key(&super::child_cache_key("srv-a", "disk", "check memory")));
    }

    #[test]
    fn validates_child_dependencies_and_rejects_cycles() {
        let tasks = json!({"tasks":[{"id":"disk","title":"Disk","goal":"check"},{"id":"logs","title":"Logs","goal":"read","depends_on":["disk"],"server":"srv-b","recheck":true}]});
        let parsed = parse_child_specs(&tasks).unwrap();
        assert_eq!(parsed[1].depends_on, vec!["disk"]);
        assert_eq!(parsed[1].server.as_deref(), Some("srv-b"));
        assert!(parsed[1].recheck);
        let cyclic = json!({"tasks":[{"id":"a","title":"A","goal":"x","depends_on":["b"]},{"id":"b","title":"B","goal":"y","depends_on":["a"]}]});
        assert!(parse_child_specs(&cyclic).is_err());
        let missing = json!({"tasks":[{"id":"a","title":"A","goal":"x","depends_on":["missing"]},{"id":"b","title":"B","goal":"y"}]});
        assert!(parse_child_specs(&missing).is_err());
        let duplicate = json!({"tasks":[{"id":"a","title":"A","goal":"x"},{"id":"a","title":"B","goal":"y"}]});
        assert!(parse_child_specs(&duplicate).is_err());
        let self_dependency = json!({"tasks":[{"id":"a","title":"A","goal":"x","depends_on":["a"]},{"id":"b","title":"B","goal":"y"}]});
        assert!(parse_child_specs(&self_dependency).is_err());
    }
}
