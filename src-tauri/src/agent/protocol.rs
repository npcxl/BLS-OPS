//! Agent 的协议层：纯数据结构 + 纯函数。
//!
//! 这里不碰网络、不碰 Tauri、不碰文件系统，因此每条规则都能用固定样本单测：
//! * 模型输出 → [`RawToolCall`]（工具块解析）；
//! * 回灌给模型前**按行脱敏**（`password|token|secret|key=`）并只保留尾部；
//! * 单条命令的输出上限与总输出上限（8 MiB 标 truncated）；
//! * 轮数 / 时间上限常量。

use serde::Serialize;

use super::changes::FileChangeSummary;

/// 回灌给模型的单条结果上限（保留**尾部**：报错与结论通常在最后）。
pub const MODEL_OUTPUT_LIMIT: usize = 32 * 1024;

/// 单条命令 stdout / stderr **各自**落盘与展示的上限（与 `ssh::exec` 一致）。
pub const STEP_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

/// 单条命令的时间上限（10 分钟）。
pub const MAX_COMMAND_SECONDS: u64 = 10 * 60;

/// 单个任务的总时间上限（30 分钟）。
pub const MAX_TOTAL_SECONDS: u64 = 30 * 60;

/// 单个任务的轮数上限。
pub const MAX_ROUNDS: u32 = 40;

/// 等待用户确认写/危险操作的上限。
pub const APPROVAL_SECONDS: u64 = 5 * 60;

/// 风险等级。`read` 自动执行；`write` / `danger` 必须先经用户确认。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolRisk {
    Read,
    Write,
    Danger,
}

impl ToolRisk {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolRisk::Read => "read",
            ToolRisk::Write => "write",
            ToolRisk::Danger => "danger",
        }
    }

    /// 需要用户点确认的风险。
    pub fn needs_approval(self) -> bool {
        !matches!(self, ToolRisk::Read)
    }

    /// 取两者中更危险的一档。
    pub fn max(self, other: ToolRisk) -> ToolRisk {
        let rank = |risk: ToolRisk| match risk {
            ToolRisk::Read => 0,
            ToolRisk::Write => 1,
            ToolRisk::Danger => 2,
        };
        if rank(other) > rank(self) {
            other
        } else {
            self
        }
    }
}

/// 任务结论的验证等级。
///
/// **不再用"模型回了句话"当成功**：部署 / 排障的结论必须能指回服务器上
/// 真实发生过的步骤。前端据此显示「已验证 / 部分完成 / 需要补充信息」。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutcome {
    /// `verified` / `partial` / `needs_info`。
    pub level: String,
    /// 一句话说明为什么是这个等级。
    pub reason: String,
    /// 支撑结论的证据（命令 / 路径 + 步骤序号），最多几条。
    pub evidence: Vec<String>,
}

impl AgentOutcome {
    pub fn verified(reason: impl Into<String>, evidence: Vec<String>) -> Self {
        Self {
            level: "verified".to_string(),
            reason: reason.into(),
            evidence,
        }
    }

    pub fn partial(reason: impl Into<String>, evidence: Vec<String>) -> Self {
        Self {
            level: "partial".to_string(),
            reason: reason.into(),
            evidence,
        }
    }

    pub fn needs_info(reason: impl Into<String>, evidence: Vec<String>) -> Self {
        Self {
            level: "needs_info".to_string(),
            reason: reason.into(),
            evidence,
        }
    }
}

/// 一条已解析、已定级的工具调用。
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: serde_json::Value,
    pub risk: ToolRisk,
}

/// 执行结果（会进事件、快照与回灌文本）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub id: String,
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    /// 命令结束后**服务器上真实的**工作目录（尾部 `pwd` 的回读值）。
    pub cwd: String,
    pub truncated: bool,
    /// `write_file` 覆盖已有文件时落下的备份绝对路径。
    pub backup_path: Option<String>,
}

/// 一条工具步骤的快照（前端据此渲染任务卡）。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentStep {
    pub index: u32,
    pub call_id: String,
    pub tool: String,
    /// 读/写/列目录涉及的文件路径（前端用来生成标题）。
    pub path: Option<String>,
    pub risk: String,
    /// `running` / `success` / `failed` / `waiting` / `skipped`。
    pub state: String,
    /// 用户可读的命令（模型给的那一条，没有 `cd` 包装与内部标记）。
    pub command: String,
    /// 实际执行脚本：只在确认卡的"调试"里展示，首屏不出现。
    pub script: Option<String>,
    /// 一句话操作摘要（例如「更新 Nginx 配置」）。
    pub summary: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub cwd: String,
    pub truncated: bool,
    pub backup_path: Option<String>,
    pub rollback: Option<String>,
    /// 危险操作的影响说明（确认框里展示）。
    pub impact: Option<String>,
    /// 这条步骤对应的**文件变更记录**（只有 `write_file` 会带）。
    ///
    /// 只是一个标识：正文 Diff 按需从变更注册表取，不塞进步骤事件。
    pub change_id: Option<String>,
    pub elapsed_ms: u64,
}

/// 推给前端的事件。
///
/// 一次工具执行对应三个事件（名字与协议文档一致）：
/// `tool_started`（含风险与影响）→ `tool_output`（增量 stdout/stderr）→
/// `tool_finished`（完整结果 + 退出码 + cwd + 备份路径）。
///
/// 事件名固定为 `agent-event`；`taskId` 让前端把增量落到**同一张任务卡**上
/// （切服务器 / 收起面板后仍然对得上）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub task_id: String,
    /// `tool_started` / `tool_output` / `tool_finished` / `approval_required` /
    /// `finished` / `failed` / `cancelled`。
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impact: Option<String>,
    /// 文件变更记录的标识（审批卡与执行结果据此打开 Diff）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
    /// 变更摘要（`file_change` 事件带；正文不在这里）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<FileChangeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 当前任务已计算的上下文与累计用量。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<super::state::ContextUsage>,
    /// 终态时的验证结论（只有 `finished` 且执行过步骤时带）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<AgentOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    /// 等待确认的截止时刻（毫秒时间戳）。只有 `approval_required` 带：
    /// 界面据此显示倒计时，重进后也不会从 5 分钟重新起算。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline: Option<i64>,
}

impl AgentEvent {
    pub fn new(task_id: &str, kind: &str) -> Self {
        Self {
            task_id: task_id.to_string(),
            kind: kind.to_string(),
            step_index: None,
            call_id: None,
            tool: None,
            path: None,
            risk: None,
            state: None,
            command: None,
            script: None,
            summary: None,
            stdout: None,
            stderr: None,
            exit_code: None,
            cwd: None,
            truncated: None,
            backup_path: None,
            rollback: None,
            impact: None,
            change_id: None,
            change: None,
            content: None,
            model: None,
            context: None,
            outcome: None,
            message: None,
            elapsed_ms: None,
            deadline: None,
        }
    }

    /// 模型正文增量：边生成边推给界面，落在同一条回复气泡上。
    pub fn text_delta(task_id: &str, delta: &str) -> Self {
        Self {
            content: Some(delta.to_string()),
            ..Self::new(task_id, "text_delta")
        }
    }

    pub fn from_step(task_id: &str, kind: &str, step: &AgentStep) -> Self {
        Self {
            step_index: Some(step.index),
            call_id: Some(step.call_id.clone()),
            tool: Some(step.tool.clone()),
            path: step.path.clone(),
            risk: Some(step.risk.clone()),
            state: Some(step.state.clone()),
            command: Some(step.command.clone()),
            script: step.script.clone(),
            summary: step.summary.clone(),
            // 终态事件带上**完整**输出：增量分块只是"边收边长"的观感，真正的
            // 权威值在这里（输出很短时也不会有分块事件）。
            stdout: if step.stdout.is_empty() {
                None
            } else {
                Some(step.stdout.clone())
            },
            stderr: if step.stderr.is_empty() {
                None
            } else {
                Some(step.stderr.clone())
            },
            exit_code: step.exit_code,
            cwd: Some(step.cwd.clone()),
            truncated: Some(step.truncated),
            backup_path: step.backup_path.clone(),
            rollback: step.rollback.clone(),
            impact: step.impact.clone(),
            change_id: step.change_id.clone(),
            elapsed_ms: Some(step.elapsed_ms),
            ..Self::new(task_id, kind)
        }
    }
}

/// 正在等用户确认的那一条操作。
///
/// 它跟着快照走，所以**刷新 / 收起再进来 / 关掉 WebView 重开**之后，界面仍能
/// 把确认条原样画出来，并把 `call_id` 交回 `agent_approve`。没有它，重进时只
/// 会看到一步卡在 `waiting`，却没有任何按钮能推进 —— 只能等 5 分钟超时。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub call_id: String,
    pub step_index: u32,
    pub tool: String,
    pub path: Option<String>,
    pub risk: String,
    /// 用户可读的命令（确认卡"命令"一栏）。
    pub command: String,
    /// 实际执行脚本（含 `cd` 包装与内部标记，只在详情里展开）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    /// 一句话操作摘要（确认卡首屏第一行）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub impact: Option<String>,
    /// 写文件时的备份路径与回滚命令：确认前就能看到改坏了怎么退。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback: Option<String>,
    /// 待确认预览的变更记录标识：确认卡据此打开「查看变更」。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
    pub cwd: String,
    /// 等待确认的截止时刻（毫秒时间戳，= 挂起时刻 + APPROVAL_SECONDS）。
    /// 界面倒计时以它为准：重进恢复的确认卡可能只剩几秒，不能重新起算。
    pub deadline: i64,
}

/// 模型输出里的一条原始工具块。参数还没解析：JSON 不合法时要回一句
/// "参数不是合法 JSON"给模型，而不是丢掉整条调用。
#[derive(Debug, Clone, PartialEq)]
pub struct RawToolCall {
    pub name: String,
    pub body: String,
}

/// 从模型输出里解出**全部**工具块（一条回复可以要求执行多条命令）。
pub fn parse_tool_calls(text: &str) -> Vec<RawToolCall> {
    let mut calls = Vec::new();
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find("<tool") {
        let start = cursor + offset;
        let Some(header_end_offset) = text[start..].find('>') else {
            break;
        };
        let header_end = start + header_end_offset;
        let header = &text[start..header_end];
        let Some(name) = attribute(header, "name") else {
            cursor = header_end + 1;
            continue;
        };
        let Some(body_end_offset) = text[header_end..].find("</tool>") else {
            // 没有收尾标签：把剩余内容当成本次调用的参数，交给 JSON 解析报错。
            let body = text[header_end + 1..].trim().to_string();
            if !name.is_empty() {
                calls.push(RawToolCall { name, body });
            }
            break;
        };
        let body = text[header_end + 1..header_end + body_end_offset]
            .trim()
            .to_string();
        if !name.is_empty() {
            calls.push(RawToolCall { name, body });
        }
        cursor = header_end + body_end_offset + "</tool>".len();
    }
    if !calls.is_empty() {
        return calls;
    }
    // 兼容模型自己的工具调用标记（见 `parse_invoke_calls`）。
    parse_invoke_calls(text)
}

/// 第二种（兼容）格式：`invoke name="工具名"` + 紧随其后的 JSON 对象。
///
/// 典型形态（部分 deepseek 系模型）：
/// `<|DSL|calls><|DSL|invoke name="run_shell">{"command":"pwd"}`。
/// 这里不去猜某个厂商的特殊 token，只认 `invoke name="..."` 这个锚点：它几乎
/// 不会出现在正常回答里，却稳定出现在这类调用标记中。
fn parse_invoke_calls(text: &str) -> Vec<RawToolCall> {
    let mut calls = Vec::new();
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find("invoke name=\"") {
        let name_start = cursor + offset + "invoke name=\"".len();
        let Some(end) = text[name_start..].find('"') else {
            break;
        };
        let name = text[name_start..name_start + end].trim().to_string();
        let after = name_start + end + 1;
        match json_object_at(text, after) {
            Some((body, next)) => {
                if !name.is_empty() {
                    calls.push(RawToolCall { name, body });
                }
                cursor = next;
            }
            None => cursor = after,
        }
    }
    calls
}

/// 从 `from` 起找第一个**配平的** JSON 对象（字符串里的花括号不算）。
fn json_object_at(text: &str, from: usize) -> Option<(String, usize)> {
    let bytes = text.as_bytes();
    let mut index = from;
    while index < bytes.len() && bytes[index] != b'{' {
        index += 1;
    }
    if index >= bytes.len() {
        return None;
    }
    let start = index;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    while index < bytes.len() {
        let ch = bytes[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == b'\\' {
                escaped = true;
            } else if ch == b'"' {
                in_string = false;
            }
        } else if ch == b'"' {
            in_string = true;
        } else if ch == b'{' {
            depth += 1;
        } else if ch == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some((text[start..=index].to_string(), index + 1));
            }
        }
        index += 1;
    }
    None
}

/// 正文里是否**看起来想调用工具**，但一条都没解析出来。
///
/// 用来避免"模型写了一堆调用标记、界面却判断为完成 0 步"这种假成功。
pub fn looks_like_tool_call(text: &str) -> bool {
    text.contains("invoke name=") || text.contains("<|")
}

/// 取 `<tool name="x">` 里的 `name`。
fn attribute(header: &str, key: &str) -> Option<String> {
    let pattern = format!("{key}=\"");
    let start = header.find(&pattern)? + pattern.len();
    let end = header[start..].find('"')? + start;
    Some(header[start..end].trim().to_string())
}

/// 去掉回复里的工具块，只留给人看的正文。
pub fn strip_tool_calls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find("<tool") {
        let start = cursor + offset;
        out.push_str(&text[cursor..start]);
        let Some(close_offset) = text[start..].find("</tool>") else {
            // 未闭合：后面全当工具参数，不再展示。
            return strip_compat(out.trim_end());
        };
        cursor = start + close_offset + "</tool>".len();
    }
    out.push_str(&text[cursor..]);
    strip_compat(out.trim())
}

/// 去掉兼容格式的残留：`<|...|>` 特殊 token 与 `invoke name="..."` + JSON。
fn strip_compat(text: &str) -> String {
    strip_invoke_calls(&strip_special_tokens(text))
        .trim()
        .to_string()
}

fn strip_special_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find("<|") {
        let start = cursor + offset;
        out.push_str(&text[cursor..start]);
        match text[start..].find("|>") {
            Some(close) => cursor = start + close + 2,
            // 未闭合：后面都是调用标记，不展示。
            None => return out,
        }
    }
    out.push_str(&text[cursor..]);
    out
}

fn strip_invoke_calls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find("invoke name=\"") {
        let start = cursor + offset;
        out.push_str(&text[cursor..start]);
        let name_start = start + "invoke name=\"".len();
        let Some(end) = text[name_start..].find('"') else {
            return out;
        };
        let after = name_start + end + 1;
        match json_object_at(text, after) {
            Some((_, next)) => cursor = next,
            None => cursor = after,
        }
    }
    out.push_str(&text[cursor..]);
    out
}

/// 单行脱敏：`KEY=VALUE` / `"key": "value"` / `--password value` / `Bearer x`。
///
/// 只替换命中的**值**，其余空白与列对齐原样保留（`df -h` 之类的表格不能被
/// 重整成一行）。键名按"赋值号左边最后一个标识符"识别，避免 `keyboard` 这种
/// 不含赋值的词被误伤。
fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut mask_next = false;

    for (start, end) in token_spans(line) {
        if mask_next {
            spans.push((start, end));
            mask_next = false;
            continue;
        }
        let bare = lower[start..end].trim_matches(|ch: char| matches!(ch, '"' | '\'' | ',' | ';'));
        if matches!(bare, "bearer" | "--password" | "--token" | "-p") {
            mask_next = true;
            continue;
        }
        let Some(position) = lower[start..end].find(['=', ':']) else {
            continue;
        };
        let key = lower[start..start + position]
            .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-');
        if !is_secret_key(key) {
            continue;
        }
        let value_start = start + position + 1;
        if value_start < end {
            spans.push((value_start, end));
        } else {
            // `"api_key": "value"`：值在下一个 token。
            mask_next = true;
        }
    }

    if spans.is_empty() {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len());
    let mut cursor = 0usize;
    for (start, end) in spans {
        if start < cursor {
            continue;
        }
        out.push_str(&line[cursor..start]);
        out.push_str("***");
        cursor = end;
    }
    out.push_str(&line[cursor..]);
    out
}

/// 按空白切出 token 的字节区间。
fn token_spans(line: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    for (index, ch) in line.char_indices() {
        if ch.is_whitespace() {
            if let Some(from) = start.take() {
                spans.push((from, index));
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(from) = start {
        spans.push((from, line.len()));
    }
    spans
}

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    matches!(
        key.as_str(),
        "password"
            | "passwd"
            | "pwd"
            | "token"
            | "secret"
            | "key"
            | "apikey"
            | "api_key"
            | "access_key"
            | "private_key"
    ) || [
        "_password",
        "-password",
        "_passwd",
        "_token",
        "-token",
        "_secret",
        "-secret",
        "_key",
        "-key",
        "apikey",
    ]
    .iter()
    .any(|suffix| key.ends_with(suffix))
}

/// 整段脱敏（按行处理；空行保持空行）。
pub fn redact(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            if line.trim().is_empty() {
                line.to_string()
            } else {
                redact_line(line)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 保留尾部截断：`(保留的文本, 是否截断)`。
pub fn tail_truncate(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_string(), false);
    }
    let mut cut = text.len() - limit;
    // 不能切在 UTF-8 字符中间。
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    let skipped = cut;
    (
        format!("…（前 {skipped} 字节已省略）\n{}", &text[cut..]),
        true,
    )
}

/// 思考强度对应的**行为约束**。
///
/// 只约束"做事方式"（探测深度、验证力度、失败后的处理），**不碰权限**：
/// 风险分级、审批门槛、sudo 开关、轮数/时长上限都不在这里决定。所以低档
/// 也照样"改前先读原文"，写操作仍按当前权限模式处理。
///
/// 传入的是 [`super::super::deployment::ai::resolve_effort`] 解析后的档位
/// （`max` 已按模型能力收敛到最高档）；`None` / 未知值走默认段。
/// 界面语言：决定追加给模型的协议 / 强度 / 范围用中文还是英文。
///
/// 只决定**提示词本身的写法**，不改风险分级与权限：同一档的行为约束，
/// 两种语言逐条对应。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
}

impl Lang {
    /// `en` / `en-US` / `EN` 走英文，其余（`zh-CN`、`None`）走中文。
    pub fn from_locale(locale: Option<&str>) -> Self {
        match locale.map(|value| value.trim().to_ascii_lowercase()) {
            Some(value) if value.starts_with("en") => Lang::En,
            _ => Lang::Zh,
        }
    }
}

pub fn thinking_guidance(effort: Option<&str>, lang: Lang) -> &'static str {
    match lang {
        Lang::Zh => thinking_guidance_zh(effort),
        Lang::En => thinking_guidance_en(effort),
    }
}

fn thinking_guidance_zh(effort: Option<&str>) -> &'static str {
    match effort.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "low" => {
            r#"
【思考强度：低】直接走最短路径：能一条命令解决就不再拆；不列多方案、不主动扩大范围。
失败一次就把原始报错交给用户，不自行连环重试或反复换命令。
改文件前仍然先用 read_file 读原文——这一条不因档位放宽。
"#
        }
        "medium" => {
            r#"
【思考强度：中】先做 1～2 条只读探测，再动手改；一步一验。
失败后先看 stderr 判断原因再换方案；同一处最多换 2 次，仍失败就把证据交给用户。
"#
        }
        "high" => {
            r#"
【思考强度：高】先列出候选方案并说明取舍，再执行；每次写操作前评估影响面（谁在读这个文件 / 这个服务）。
失败要定位根因（日志 / 退出码 / 权限 / 路径），不要靠换命令碰运气。
"#
        }
        "max" => {
            r#"
【思考强度：最高】在「高」的基础上再加两条：
1. 关键变更前后各做一次一致性验证（改前留快照、改后做校验）；
2. 结论里显式写出「已验证 / 未验证」的边界，不要用推断代替证据。
验证也要控制轮数：同一条校验命令不要反复跑，没有新信息就收尾。
"#
        }
        _ => {
            r#"
【思考强度：默认】按工具协议的默认节奏执行：先只读探测、再改；失败先看证据再换方案。
改文件前先用 read_file 读原文。
"#
        }
    }
}

fn thinking_guidance_en(effort: Option<&str>) -> &'static str {
    match effort.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "low" => {
            r#"
[Thinking level: low] Take the shortest path: if one command settles it, do not split it up; no alternatives, no scope creep.
On the first failure, hand the raw error to the user instead of chaining retries or swapping commands.
Still read the original file with read_file before editing — this rule is never relaxed by level.
"#
        }
        "medium" => {
            r#"
[Thinking level: medium] Run 1–2 read-only probes first, then act; verify after each step.
On failure, read stderr to decide the cause before changing approach; at most 2 variations in the same spot, then hand the evidence to the user.
"#
        }
        "high" => {
            r#"
[Thinking level: high] List the candidate approaches and their trade-offs before acting; assess the blast radius of every write (who reads this file / this service).
Diagnose failures to the root cause (logs / exit code / permissions / path) instead of swapping commands at random.
"#
        }
        "max" => {
            r#"
[Thinking level: max] Build on "high", plus two more rules:
1. Verify consistency before and after every critical change (snapshot before, checks after);
2. State explicitly in the conclusion what is verified and what is not — never pass inference off as evidence.
Keep verification bounded too: do not re-run the same check without new information.
"#
        }
        _ => {
            r#"
[Thinking level: default] Follow the tool protocol's default rhythm: read-only probes first, then act; on failure read the evidence before changing approach.
Read the original file with read_file before editing.
"#
        }
    }
}

/// 操作范围约束：先判断"只查询"还是"要改动"，再决定用什么工具。
///
/// 权限模式只决定"写操作要不要问"，不决定"该不该写"：用户只问状态时，
/// 即使开了完全权限也只做只读查询。命令用途不明确时宁可换工具，也不要
/// 拿一条看不懂的命令去试探。
pub fn intent_guidance(lang: Lang) -> &'static str {
    match lang {
        Lang::Zh => intent_guidance_zh(),
        Lang::En => intent_guidance_en(),
    }
}

fn intent_guidance_zh() -> &'static str {
    r#"
【操作范围】先判断用户这句话是"只查询"还是"要改动"，再选工具：
1. 只查询（看看 / 查一下 / 状态 / 日志 / 哪些…）：只用只读工具与只读命令（list_dir、read_file、ps、systemctl status、docker ps、df…），拿到结果就汇报；**即使已开启完全权限，也不要顺手改任何东西**。
2. 要改动：只做用户明确要求的那一步，不扩大范围、不顺手优化；改文件前先读原文。普通权限下写操作确认一次；完全权限下直接执行。只查询的任务里写操作会被执行器拦下。
3. 命令用途不明确（自定义脚本、看不出参数含义的二进制）：先换成已知只读、目标明确的工具；换不到就说明具体原因，不要猜着执行。
4. 查询失败或权限不足：按实际错误（stderr / 退出码 / 权限）汇报，不要换一条命令碰运气，也不要反复重试同一条。
"#
}

fn intent_guidance_en() -> &'static str {
    r#"
[Scope] Decide first whether this request is "query only" or "needs a change", then pick tools:
1. Query only (show / check / status / logs / which...): read-only tools and read-only commands only (list_dir, read_file, ps, systemctl status, docker ps, df...), then report. **Even with full permissions, do not change anything along the way.**
2. Needs a change: do exactly the step the user asked for — no widening the scope, no opportunistic cleanups; read the original file before editing. With normal permissions each write is confirmed once; with full permissions it runs directly. In a query-only task any write is blocked by the executor.
3. Unclear command purpose (custom scripts, binaries whose flags you cannot read): switch to a known read-only tool with a clear target; if none fits, explain the specific reason instead of guessing.
4. Query failed or permission denied: report the actual error (stderr / exit code / permissions); do not try another command in the hope it works, and do not repeat the same one.
"#
}

/// 回复语言的**最后一道约束**。
///
/// 放在整段系统提示词的最末尾：前面的平台说明、工具输出、错误原文都可能带
/// 中英混杂（命令、路径、代码本来也不该翻译），模型很容易跟着最显眼的语言走。
/// 这一条明确区分"可以保留原文的东西"和"必须用界面语言写的东西"。
pub fn reply_language_rule(lang: Lang) -> &'static str {
    match lang {
        Lang::Zh => {
            r#"
【回复语言：只用简体中文】
无论工具输出、报错原文、文档或代码注释是什么语言，所有解释、结论与下一步建议**必须全部用简体中文**。
命令、路径、代码、配置键名与原始报错可以保留原文；**不要中英混写**，也不要把整段回答换成英文。
"#
        }
        Lang::En => {
            r#"
[Reply language: English only]
Every explanation, conclusion and next step **must be written in English only**, regardless of the language of tool output, raw errors, documentation or code comments.
Commands, paths, code, config keys and raw error text may stay as-is; **do not mix Chinese into the reply**, and do not switch the whole answer to another language.
"#
        }
    }
}

/// 给模型的工具说明（由后端追加，**工具集只有这一份事实**）。
pub fn tool_prompt(lang: Lang) -> &'static str {
    match lang {
        Lang::Zh => tool_prompt_zh(),
        Lang::En => tool_prompt_en(),
    }
}

fn tool_prompt_zh() -> &'static str {
    r#"
【工具协议】你可以实际执行服务器命令。**优先直接调用随请求提供的工具**：run_shell / read_file / list_dir / write_file。

只有当前接口不支持工具调用时，才在正文里写文本块（一次可以写多个，按出现顺序逐条执行）：
<tool name="run_shell">{"command":"uname -a"}</tool>
<tool name="read_file">{"path":"/var/www/app/index.html","offset":1,"limit":200}</tool>
<tool name="list_dir">{"path":"/var/www"}</tool>
<tool name="write_file">{"path":"/var/www/app/index.html","content":"完整的新文件内容"}</tool>

**不要自创工具调用标记**（例如 `<|DSL|…`、`invoke name="…"`）。那不是本协议的写法，会被当成普通回答，等于什么都没执行。

规则：
1. 工具调用之间不要互相依赖；需要上一条的输出时，先只发这一条，看到结果再发下一条。
2. 命令在任务的**当前目录**下执行（每条结果都会告诉你执行后的目录）；要换目录用 `cd <目录> && ...`。
3. 先只读探测、再改；改之前先用 read_file 读原文。写操作按权限模式执行：普通权限等用户确认（被拒绝就说明原因并换方案，不要重复请求同一条命令）；完全权限下直接执行。
4. `write_file` 会自动备份原文件，你不需要自己 `cp`；用 `run_shell` 删除/覆盖时，必须自己先备份并说明位置。
5. sudo 默认禁用，只有用户打开「完全权限」后才允许；当前不允许又确实需要 root 时，把命令和原因写给用户，由用户决定。
6. 不要执行破坏性命令（`rm -rf /`、`mkfs`、改防火墙、格式化）。普通权限会拦下并等确认，完全权限会直接执行且后果不可逆 —— 没有用户明确要求就不要写这类命令。
7. 结论必须来自工具输出；没有输出就直说"没查到"，不要猜。
8. **命令失败先诊断，再换命令**：读 `stderr` 判断属于哪一类 —— 权限不足（需要 root / 目录只读）、路径或文件不存在、服务名或单元名不对、文件已存在、端口被占用、命令不存在。先用一句话说明你判断到的原因，再给出**不同的**命令（加覆盖参数、换路径、换成诊断命令），不要原样重试。
9. 同一条命令在一次运行里**只会执行一次**：重复提交会被执行器直接拦下并记为「已跳过」，你拿到的仍是一条错误。要重试就必须改参数，并在动手前说明改了什么、为什么这样能绕过刚才的错误。
10. 连续两次失败就停下来汇报：说明已经排除了什么、还缺哪条信息、建议用户做什么（例如确认路径、提供权限）。不要无限尝试。
11. 收尾时用一小段话给：结论 + 关键证据 + 下一步建议。
"#
}

fn tool_prompt_en() -> &'static str {
    r#"
[Tool protocol] You can actually run commands on the server. **Prefer calling the tools sent with the request directly**: run_shell / read_file / list_dir / write_file.

Only when the current API does not support tool calls, write text blocks in the reply body (several per message, executed in order):
<tool name="run_shell">{"command":"uname -a"}</tool>
<tool name="read_file">{"path":"/var/www/app/index.html","offset":1,"limit":200}</tool>
<tool name="list_dir">{"path":"/var/www"}</tool>
<tool name="write_file">{"path":"/var/www/app/index.html","content":"the complete new file content"}</tool>

**Do not invent tool-call markers** (e.g. `<|DSL|...`, `invoke name="..."`). They are not part of this protocol, will be treated as a plain answer, and nothing gets executed.

Rules:
1. Tool calls must not depend on each other; when you need the previous output, send only that one call first and wait for the result.
2. Commands run in the task's **current directory** (each result reports the directory afterwards); to change directory use `cd <dir> && ...`.
3. Probe read-only first, then change; read the original file with read_file before editing. Writes follow the permission mode: with normal permissions wait for user approval (if rejected, explain why and propose another approach — do not re-request the same command); with full permissions execute directly.
4. `write_file` backs up the original automatically — you do not need to `cp` it yourself; when deleting/overwriting with `run_shell`, back it up first and say where.
5. sudo is disabled by default and only allowed after the user turns on "full permissions"; if you truly need root and it is not allowed, give the user the command and the reason and let them decide.
6. Never run destructive commands (`rm -rf /`, `mkfs`, firewall changes, formatting). Normal permissions will stop and ask; full permissions will execute irreversibly — do not write such commands unless the user explicitly asks.
7. Conclusions must come from tool output; if there is no output, say "not found" — never guess.
8. **Diagnose before switching commands**: read `stderr` and classify it — missing permission (needs root / read-only directory), path or file does not exist, wrong service or unit name, file already exists, port already in use, command not found. State the cause in one sentence, then issue a **different** command (add override flags, change the path, use a diagnostic command) — never retry the same one unchanged.
9. The same command runs **only once** per run: a duplicate submission is blocked by the executor and recorded as "skipped", and you still get an error. To retry you must change the arguments and explain, before acting, what changed and why it should get past the previous error.
10. After two consecutive failures, stop and report: what has been ruled out, what information is still missing, what the user should do (e.g. confirm the path, grant permissions). Do not keep trying.
11. Wrap up with one short paragraph: conclusion + key evidence + next step.
"#
}
