//! 多轮编排：模型 → 工具调用 → 逐条执行 → 结果回灌 → 继续。
//!
//! 循环**跑在 Rust 侧**（`tauri::async_runtime::spawn`），因此收起超能面板、
//! 切回普通终端、甚至刷新 WebView 都不会打断正在跑的部署命令；前端只订阅
//! `agent-event` 渲染，并在需要确认时回一个 `agent_approve`。
//!
//! 上限：单任务 [`MAX_ROUNDS`] 轮、单命令 [`MAX_COMMAND_SECONDS`] 秒、
//! 总计 [`MAX_TOTAL_SECONDS`] 秒；超限以 `failed` 结束并说明停在哪条命令。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter as _};
use tokio::sync::mpsc::UnboundedSender;

use super::protocol::{
    intent_guidance, looks_like_tool_call, parse_tool_calls, redact, strip_tool_calls,
    tail_truncate, thinking_guidance, tool_prompt, AgentEvent, AgentStep, PendingApproval,
    ToolRisk, APPROVAL_SECONDS, MAX_ROUNDS, MAX_TOTAL_SECONDS, MODEL_OUTPUT_LIMIT,
    STEP_OUTPUT_LIMIT,
};
use super::state::{AgentHandle, AgentSnapshot, ContextBreakdown, ContextUsage, TokenUsage};
use super::tools::{has_sudo, plan_tool, strip_markers, tool_schemas, PlannedTool};
use crate::deployment::ai::model::AiCancel;
use crate::deployment::ai::{AiProviderError, OpenAiCompatibleAdvisor, ToolReply};
use crate::ssh::utf8_stream::Utf8StreamDecoder;
use crate::ssh::ExecChunk;
use crate::ssh::ExecOutput;
use crate::state::AppState;

/// 一条命令**边跑边回显**的总上限（超过后只由结束事件给完整输出）。
const LIVE_OUTPUT_LIMIT: usize = 256 * 1024;

/// 事件名（前端 `src/lib/events.ts` 里是同一个字符串）。
pub const AGENT_EVENT: &str = "agent-event";

/// 一轮对话消息（前端只传角色与文本）。
#[derive(Debug, Clone)]
pub struct AgentTurn {
    pub role: String,
    pub content: String,
}

/// 启动参数。
#[derive(Debug, Clone)]
pub struct AgentInput {
    pub task_id: String,
    pub session_id: String,
    pub server: String,
    pub cwd: String,
    pub messages: Vec<AgentTurn>,
    /// 用户为这条会话选的模型；`None` = 用默认提供方。
    pub provider_id: Option<String>,
    /// 思考强度（已由界面按模型能力选好）；`None` / `auto` = 供应商默认。
    pub reasoning_effort: Option<String>,
    /// 上下文输入预算（tokens）；`None` = 按模型窗口自动。
    pub context_budget: Option<u32>,
    /// 续跑（同一任务换一次 run_loop）时从上一段带过来的累计用量。
    pub carry_usage: Option<TokenUsage>,
    /// 允许 sudo（用户在界面上显式打开「完全权限」才为 true）。
    pub allow_sudo: bool,
    /// 「完全权限」下修改范围内的写入 / 修改 / 删除**都不再确认**。
    pub auto_approve_writes: bool,
    pub max_rounds: Option<u32>,
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
}

/// 启动一个 Agent 任务（立刻返回初始快照；真正的循环在后台跑）。
pub async fn spawn_agent(
    app: AppHandle,
    state: AppState,
    input: AgentInput,
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
    // 档位在**启动时**定下来：同一次运行里的工具续请求不会再变。
    let reasoning_effort =
        crate::deployment::ai::resolve_effort(&model, input.reasoning_effort.as_deref());
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
    let snapshot = AgentSnapshot::new(
        &input.task_id,
        &input.server,
        &input.session_id,
        &input.cwd,
        &model,
    );
    let Some(handle) = state.agents.register(snapshot.clone(), cancel) else {
        state.ai_reviews.forget(&input.task_id);
        return Err("这条任务还在执行，等它结束或先停止".to_string());
    };

    let task_id = input.task_id.clone();
    let registry = state.agents.clone();
    let app_for_run = app.clone();
    tauri::async_runtime::spawn(async move {
        let io = LiveIo {
            app: &app_for_run,
            state: &state,
            advisor: &advisor,
            reasoning_effort,
        };
        let outcome = run_loop(&handle, &input, &io, guidance_effort.as_deref()).await;
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
        let snapshot = handle.snapshot();
        let mut event = AgentEvent::new(&task_id, kind);
        event.message = message;
        event.content = (kind == "finished").then_some(snapshot.content);
        event.model = (kind == "finished").then_some(snapshot.model);
        event.cwd = Some(snapshot.cwd);
        event.context = snapshot.context;
        emit(&app_for_run, event);
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

/// 同一次运行的"操作"标识：同一操作只问一次，换个写法也不再问。
///
/// 不直接拿原始命令：`rm /opt/a`、`rm -f /opt/a`、`sudo rm /opt/a` 是同一件事。
/// 先把 `cd … &&` 前缀、`sudo` 与 `-x` 这类参数去掉，再拼命令名与目标。
fn operation_signature(planned: &PlannedTool) -> String {
    let basis = planned.path.clone().unwrap_or_else(|| {
        let normalized = normalize_operation_text(&planned.display);
        if normalized.is_empty() {
            planned.display.trim().to_lowercase()
        } else {
            normalized
        }
    });
    format!("{}\u{1}{}", planned.call.name, basis)
}

fn normalize_operation_text(text: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for segment in text
        .split("&&")
        .flat_map(|part| part.split("||"))
        .flat_map(|part| part.split(';'))
    {
        let tokens: Vec<&str> = segment.split_whitespace().collect();
        let Some(first) = tokens.first() else {
            continue;
        };
        // 切目录只是改变工作目录，不构成"另一个操作"。
        if matches!(*first, "cd" | "pushd" | "popd") {
            continue;
        }
        let kept: Vec<&str> = tokens
            .iter()
            .copied()
            .filter(|token| *token != "sudo" && !token.starts_with('-'))
            .collect();
        if !kept.is_empty() {
            parts.push(kept.join(" "));
        }
    }
    parts.join(" && ").to_lowercase()
}

/// 把前端传来的消息整理成 OpenAI 兼容的会话：合并 system，再追加工具说明、
/// 思考强度与任务范围。
///
/// `effort` 传的是 [`crate::deployment::ai::resolve_effort`] **已解析**的档位
/// （`max` 已按模型收敛）；这里不再解读 `input.reasoning_effort` 原值，避免
/// "界面选 MAX、模型只支持 high，行为段却按 max"这种错位。
fn conversation(input: &AgentInput, effort: Option<&str>, query_only: bool) -> Vec<Value> {
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
    system.push_str(&format!(
        "\n当前任务目录：{}\n服务器：{}\n当前时间：{}\n",
        input.cwd,
        input.server,
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    ));
    system.push_str(tool_prompt());
    system.push('\n');
    system.push_str(thinking_guidance(effort));
    system.push('\n');
    system.push_str(intent_guidance());
    if query_only {
        system.push_str(
            "\n【本次任务范围：只查询】只允许只读工具与只读命令；写 / 改 / 删会被执行器直接拦下，不要尝试。\n",
        );
    }
    let mut out = vec![json!({ "role": "system", "content": system })];
    out.extend(turns);
    out
}

pub(crate) async fn run_loop(
    handle: &AgentHandle,
    input: &AgentInput,
    io: &dyn AgentIo,
    resolved_effort: Option<&str>,
) -> Result<String, StopReason> {
    let started = Instant::now();
    let rounds = input.max_rounds.unwrap_or(MAX_ROUNDS).clamp(1, MAX_ROUNDS);
    // 范围在**这次运行开始时**定下来：同一次运行里不随模型换说法漂移。
    let query_only = is_query_only(&input.messages);
    let mut conversation = conversation(input, resolved_effort, query_only);
    // 已表态的操作：true = 允许过，false = 拒绝过；两种都不再第二次弹确认。
    let mut decided_ops: HashMap<String, bool> = HashMap::new();
    // 用量归到**这个 taskId**：续跑时从上一段带过来，不重新从 0 开始。
    let goal = task_goal(&input.messages);
    let mut cumulative = input.carry_usage.clone().unwrap_or_default();
    let mut tool_calls: usize = 0;
    /*
     * 本次运行里**已经提交过**的命令签名（tool + 用户可读命令）。
     *
     * 模型遇到报错时很容易把同一条命令原样再发一次；执行器不陪它重试 ——
     * 第二次直接拦下，把"已经执行过"回给它，逼它读错误、换一种做法。
     */
    let mut executed_signatures: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut next_index: u32 = 0;
    let mut total_bytes: usize = 0;
    // 预算来自**这次启动的模型**：切模型只影响下一条消息。
    let context_budget = crate::deployment::ai::context_budget_tokens(
        &handle.snapshot().model,
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
        let reply = match io
            .chat(
                conversation.clone(),
                tool_schemas(),
                handle.cancel(),
                on_delta,
            )
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
            return Ok(strip_tool_calls(&reply.content));
        }

        tool_calls += calls.len();
        handle.update(|snapshot| {
            if let Some(context) = snapshot.context.as_mut() {
                context.tool_calls = tool_calls;
            }
        });

        let mut tool_messages: Vec<Value> = Vec::new();
        for raw in &mut calls {
            let index = next_index;
            next_index += 1;
            if raw.id.is_empty() {
                raw.id = format!("call-{round}-{index}");
            }
            let call_id = raw.id.clone();
            start_step(handle, index, &call_id, &raw.name);

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

            // sudo 默认禁用：连命令都不构造，直接告诉模型与用户。
            let sudo = args
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(has_sudo);
            if sudo && !input.allow_sudo {
                let reason = "sudo 默认禁用。请给出不需要 root 的方案，或让用户打开「完全权限」。"
                    .to_string();
                fail_step(io, handle, index, &reason);
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }

            let planned = match plan_tool(
                &raw.name,
                &args,
                &handle.snapshot().cwd,
                crate::db::AppDb::now() as u64,
            ) {
                Ok(mut planned) => {
                    planned.call.id = call_id.clone();
                    planned
                }
                Err(reason) => {
                    fail_step(io, handle, index, &reason);
                    tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                    continue;
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
            let op_signature = operation_signature(&planned);
            let decided = decided_ops.get(&op_signature).copied();
            let out_of_scope = query_only && risk != ToolRisk::Read;
            /*
             * 「完全权限」= 用户已经接下写入 / 修改 / 删除的后果：本次**修改范围**
             * 里的操作全部不再逐条确认（含 sudo / 改 /etc / 删除）。范围之外的
             * 写操作已被下面的查询边界挡住，不会走到这里。
             *
             * 已经允许过的同一操作也不再问；sudo 另有独立开关。
             */
            let skip_approval = input.auto_approve_writes || decided == Some(true);
            handle.patch_step(index, |step| {
                step.state = if out_of_scope {
                    // 马上会被范围拦下：别让界面闪一下"等待确认"。
                    "running".to_string()
                } else if risk.needs_approval() && !skip_approval {
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
            });
            if let Some(step) = handle.step(index) {
                io.emit(AgentEvent::from_step(&input.task_id, "tool_started", &step));
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
             * **同一命令不在一次运行里执行第二遍。**
             *
             * 这是执行器的硬约束，不靠模型自觉：重复提交不会有不同结果，
             * 正确做法是读上一条 stderr 判断原因（权限 / 路径 / 服务名 /
             * 文件已存在），换一种做法。
             */
            let signature = format!("{}\u{1}{}", planned.call.name, display_command);
            if executed_signatures.contains(&signature) {
                let reason = "这条命令本次已经执行过，重复跑不会有不同结果。\
                    先看上一条工具输出：成功就据此继续，失败就判断原因\
                    （权限 / 路径 / 服务名 / 文件已存在）后换一种做法。"
                    .to_string();
                skip_step(io, handle, &input.task_id, index, &reason);
                tool_messages.push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                continue;
            }

            if risk.needs_approval() && !skip_approval {
                /*
                 * 快照里也留一份"正在等确认"：刷新 / 重进 / 关掉 WebView 再打开
                 * 时，界面能凭它把确认条画回来并继续 `agent_approve`。只发事件是
                 * 不够的 —— 事件是过去的，重进时收不到。
                 */
                let step_cwd = handle.snapshot().cwd;
                // 截止时刻在挂起前定死：事件、快照、等待超时用的是同一个值，
                // 界面倒计时与后端实际放弃的时刻才不会各说各话。
                let deadline = crate::db::AppDb::now() + (APPROVAL_SECONDS as i64) * 1000;
                handle.update(|snapshot| {
                    // 快照里的状态也要是"在等确认"，否则重进会显示成"执行中"。
                    snapshot.status = "waiting".to_string();
                    snapshot.pending_approval = Some(PendingApproval {
                        call_id: call_id.clone(),
                        step_index: index,
                        tool: planned.call.name.clone(),
                        path: planned.path.clone(),
                        risk: risk.as_str().to_string(),
                        command: display_command.clone(),
                        script: script.clone(),
                        summary: planned.summary.clone(),
                        impact: planned.impact.clone(),
                        backup_path: planned.backup_path.clone(),
                        rollback: planned.rollback.clone(),
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

                let decision = wait_approval(handle, &call_id, deadline).await;
                // 用户已表态（或取消 / 超时）：快照里不该再挂着它。
                handle.update(|snapshot| {
                    snapshot.pending_approval = None;
                    if snapshot.status == "waiting" {
                        snapshot.status = "running".to_string();
                    }
                });
                match decision {
                    Decision::Allow => {
                        decided_ops.insert(op_signature.clone(), true);
                    }
                    Decision::Deny => {
                        // 记住"这个操作被拒绝过"：换写法也不再弹第二次。
                        decided_ops.insert(op_signature.clone(), false);
                        let reason = "用户拒绝执行这条命令".to_string();
                        fail_step(io, handle, index, &reason);
                        tool_messages
                            .push(tool_error_message(&raw.id, raw.native, &raw.name, &reason));
                        continue;
                    }
                    Decision::Cancelled => {
                        mark_step_aborted(io, handle, index, "已取消（用户停止），命令没有执行");
                        return Err(StopReason::Cancelled(format!(
                            "已停止：等待确认时收到停止信号（停在「{}」）",
                            describe_step(&raw.name, &args)
                        )));
                    }
                    Decision::Timeout => {
                        mark_step_aborted(io, handle, index, "等待确认超时，命令没有执行");
                        return Err(StopReason::Failed(format!(
                            "等待确认超过 {} 分钟，已停止（停在「{}」）",
                            APPROVAL_SECONDS / 60,
                            describe_step(&raw.name, &args)
                        )));
                    }
                }
                handle.patch_step(index, |step| step.state = "running".to_string());
                if let Some(step) = handle.step(index) {
                    io.emit(AgentEvent::from_step(&input.task_id, "tool_started", &step));
                }
            }

            // 到这一步才真的会执行：记下"这条命令跑过"，重复提交直接跳过。
            executed_signatures.insert(signature);

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

fn fail_step(io: &dyn AgentIo, handle: &AgentHandle, index: u32, reason: &str) {
    mark_step_aborted(io, handle, index, reason);
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
