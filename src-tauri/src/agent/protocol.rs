//! Agent 的协议层：纯数据结构 + 纯函数。
//!
//! 这里不碰网络、不碰 Tauri、不碰文件系统，因此每条规则都能用固定样本单测：
//! * 模型输出 → [`RawToolCall`]（工具块解析）；
//! * 回灌给模型前**按行脱敏**（`password|token|secret|key=`）并只保留尾部；
//! * 单条命令的输出上限与总输出上限（8 MiB 标 truncated）；
//! * 轮数 / 时间上限常量。

use serde::{Deserialize, Serialize};

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

/* ---------------- 执行计划（MAX 强制计划） ---------------- */

fn pending_state() -> String {
    "pending".to_string()
}

/// 计划中的一步。
///
/// 标题 / 预期动作 / 验证条件由模型提出；`state` / `evidence` **只能**由真实
/// 工具事件推进，模型自己说"完成了"不会改这里（与步骤状态同一原则）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: String,
    pub title: String,
    /// 预期动作：要看什么 / 要改什么。
    pub action: String,
    /// 验证条件：怎样算这一步完成。
    pub verify: String,
    /// `probe` / `action` / `answer`：纯聊天用 `answer`，整轮成功时自动完成。
    #[serde(default)]
    pub kind: String,
    /// `pending` / `running` / `waiting` / `done` / `failed` / `skipped`。
    #[serde(default = "pending_state")]
    pub state: String,
    /// 执行器给出的一行证据（真实输出首行），不是模型描述。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

/// 本轮任务的结构化计划。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlan {
    /// 一句话复述任务理解。
    #[serde(default)]
    pub understanding: String,
    /// 行动摘要（计划卡副标题）。
    #[serde(default)]
    pub summary: String,
    /// 需要用户确认的前提（只展示，不额外弹确认）。
    #[serde(default)]
    pub prerequisites: Vec<String>,
    #[serde(default)]
    pub steps: Vec<PlanStep>,
    /// 第几版计划：修订一次 +1（前端据此保持卡片位置、不重放动画）。
    #[serde(default)]
    pub revision: u32,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

impl AgentPlan {
    pub fn step(&self, id: &str) -> Option<&PlanStep> {
        self.steps.iter().find(|step| step.id == id)
    }

    /// 带状态的一行摘要：拼进系统提示词，让模型看到真实进度。
    pub fn brief(&self) -> String {
        let steps = self
            .steps
            .iter()
            .map(|step| format!("- {} [{}] {}", step.id, step.state, step.title))
            .collect::<Vec<_>>()
            .join("\n");
        let summary = if self.summary.trim().is_empty() {
            self.understanding.trim().to_string()
        } else {
            self.summary.trim().to_string()
        };
        format!("rev {} · {}\n{}", self.revision, summary, steps)
    }
}

/// 模型通过 `submit_plan` 提交的草稿。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDraft {
    #[serde(default)]
    pub understanding: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub prerequisites: Vec<String>,
    pub steps: Vec<PlanStepDraft>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepDraft {
    pub id: String,
    pub title: String,
    pub action: String,
    pub verify: String,
    #[serde(default)]
    pub kind: String,
}

/// 计划步骤上限：够覆盖排查 + 部署，又不至于把卡片变成一堵墙。
pub const MAX_PLAN_STEPS: usize = 12;

fn clip_chars(value: &str, limit: usize) -> String {
    let value = value.trim();
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut out = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index >= limit {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

/// 稳定且可引用的步骤 id：不允许空白与控制字符，避免和工具参数对不上。
fn valid_plan_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty()
        && id.chars().count() <= 40
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
}

/// 草稿 → 计划（合并上一版）。
///
/// * 同 id 的步骤保留已完成 / 失败 / 进行中的状态与证据（**已有完成记录保留**）；
/// * 上一版里已经完成、这一版没再提的步骤追加在末尾，不会被修订"抹掉"；
/// * 其余字段按这一版覆盖，`revision` +1。
pub fn merge_plan(
    current: Option<&AgentPlan>,
    draft: PlanDraft,
    now: i64,
) -> Result<AgentPlan, String> {
    if draft.steps.is_empty() {
        return Err("计划至少需要一步".to_string());
    }
    if draft.steps.len() > MAX_PLAN_STEPS {
        return Err(format!("计划最多 {MAX_PLAN_STEPS} 步"));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut steps: Vec<PlanStep> = Vec::new();
    for item in &draft.steps {
        let id = item.id.trim().to_string();
        if !valid_plan_id(&id) {
            return Err(format!(
                "步骤 id「{id}」不合法：只能是字母 / 数字 / - _ . :，且不超过 40 个字符"
            ));
        }
        if seen.iter().any(|known| known == &id) {
            return Err(format!("步骤 id「{id}」重复了"));
        }
        seen.push(id.clone());
        let title = clip_chars(&item.title, 120);
        let action = clip_chars(&item.action, 300);
        let verify = clip_chars(&item.verify, 300);
        if title.is_empty() || action.is_empty() || verify.is_empty() {
            return Err(format!("步骤「{id}」必须同时有 title / action / verify"));
        }
        let previous = current.and_then(|plan| plan.step(&id));
        let kind = match item.kind.trim().to_ascii_lowercase().as_str() {
            "probe" | "action" | "answer" => item.kind.trim().to_ascii_lowercase(),
            _ => previous.map(|step| step.kind.clone()).unwrap_or_default(),
        };
        steps.push(PlanStep {
            id,
            title,
            action,
            verify,
            kind,
            state: previous
                .map(|step| step.state.clone())
                .filter(|state| !state.trim().is_empty())
                .unwrap_or_else(pending_state),
            evidence: previous.and_then(|step| step.evidence.clone()),
        });
    }
    // 修订时不再重提、但已经跑完的步骤：保留记录，不假装它没发生过。
    if let Some(plan) = current {
        for step in &plan.steps {
            if seen.iter().any(|id| id == &step.id) {
                continue;
            }
            if matches!(step.state.as_str(), "done" | "failed") {
                steps.push(step.clone());
            }
        }
    }
    let prerequisites = draft
        .prerequisites
        .iter()
        .map(|item| clip_chars(item, 200))
        .filter(|item| !item.is_empty())
        .take(8)
        .collect::<Vec<_>>();
    Ok(AgentPlan {
        understanding: clip_chars(&draft.understanding, 500),
        summary: clip_chars(&draft.summary, 500),
        prerequisites,
        steps,
        revision: current.map(|plan| plan.revision).unwrap_or(0) + 1,
        created_at: current.map(|plan| plan.created_at).filter(|at| *at > 0).unwrap_or(now),
        updated_at: now,
    })
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
    /// 这一步属于计划的哪一步（MAX 强制计划；普通模式为空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_step_id: Option<String>,
    /// 操作组 id：同一个目的连续执行的命令共用，前端据此只显示一次说明。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
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
    /// 完整计划（`plan_updated` 带）：前端据此更新计划卡与步骤状态。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<AgentPlan>,
    /// 这条命令属于计划里的哪一步（与 `AgentStep.plan_step_id` 同值）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_step_id: Option<String>,
    /// 操作组 id：说明与工具事件共享它，前端按它去重。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// 执行前说明（只有操作组的第一条 `tool_started` 带）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// `question_required` / `question_answered`：AI 向用户提出的结构化问题。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<PendingQuestion>,
    /// `question_answered`：用户提交的选项 ID 与自定义文字。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<QuestionAnswer>,
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
            plan: None,
            plan_step_id: None,
            group_id: None,
            note: None,
            question: None,
            answer: None,
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
            plan_step_id: step.plan_step_id.clone(),
            group_id: step.group_id.clone(),
            ..Self::new(task_id, kind)
        }
    }
}

/// 正在等用户确认的那一条操作。
///
/// 它跟着快照走，所以**刷新 / 收起再进来 / 关掉 WebView 重开**之后，界面仍能
/// 把确认条原样画出来，并把 `call_id` 交回 `agent_approve`。没有它，重进时只
/// 会看到一步卡在 `waiting`，却没有任何按钮能推进 —— 只能等 5 分钟超时。
/// AI 向用户提问时给出的一个选项。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
}

/// 模型发出的 `ask_user` 参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserDraft {
    pub question: String,
    pub kind: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default, alias = "allow_custom")]
    pub allow_custom: bool,
}

/// 用户提交的回答：选项 ID + 可选自定义文字。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    #[serde(default)]
    pub selected: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<String>,
}

/// 正在等用户回答的问题。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    pub question_id: String,
    pub task_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub server_id: Option<String>,
    pub question: String,
    /// `single` / `multi`
    pub kind: String,
    pub options: Vec<QuestionOption>,
    pub allow_custom: bool,
    /// 等待截止时刻（毫秒时间戳）；界面可据此显示剩余时间。
    pub deadline: i64,
}

impl PendingQuestion {
    /// 校验并规范化一次回答。空自定义、重复选项、单单选多选等都在这里拦。
    pub fn validate_answer(
        &self,
        selected: &[String],
        custom: Option<&str>,
    ) -> Result<QuestionAnswer, String> {
        let custom = custom
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if custom.is_some() && !self.allow_custom {
            return Err("这个问题不允许自定义回答".to_string());
        }
        let mut ids: Vec<String> = Vec::new();
        for id in selected {
            let id = id.trim();
            if id.is_empty() {
                continue;
            }
            if !self.options.iter().any(|option| option.id == id) {
                return Err(format!("选项 {id} 不属于这个问题"));
            }
            if !ids.iter().any(|known| known == id) {
                ids.push(id.to_string());
            }
        }
        match self.kind.as_str() {
            "single" => {
                if let Some(custom) = &custom {
                    if !ids.is_empty() {
                        return Err("单选只能选择一个预设选项，或填写自定义内容".to_string());
                    }
                    return Ok(QuestionAnswer {
                        selected: Vec::new(),
                        custom: Some(custom.clone()),
                    });
                }
                if ids.len() != 1 {
                    return Err("请选择一个选项，或填写自定义内容".to_string());
                }
            }
            "multi" => {
                if ids.is_empty() && custom.is_none() {
                    return Err("请至少选择一个选项，或填写自定义内容".to_string());
                }
            }
            _ => return Err("问题的选择类型不合法".to_string()),
        }
        Ok(QuestionAnswer {
            selected: ids,
            custom,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub call_id: String,
    pub step_index: u32,
    /// 归属：审批只能对这个对话 / 服务器 / 本次运行 / 这一条操作生效。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    pub run_id: String,
    pub step_id: String,
    /// 规范化后的操作目标（工具名 + 目标）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// 本次调用的规范化参数（JSON 文本）；参数变化时旧审批不能复用。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub params: String,
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
<tool name="ask_user">{"question":"要查询生产还是测试环境？","kind":"single","options":[{"id":"prod","label":"生产"},{"id":"test","label":"测试"}],"allowCustom":false}</tool>

**不要自创工具调用标记**（例如 `<|DSL|…`、`invoke name="…"`）。那不是本协议的写法，会被当成普通回答，等于什么都没执行。

规则：
1. 工具调用之间不要互相依赖；需要上一条的输出时，先只发这一条，看到结果再发下一条。
2. 命令在任务的**当前目录**下执行（每条结果都会告诉你执行后的目录）；要换目录用 `cd <目录> && ...`。
3. 先只读探测、再改；改之前先用 read_file 读原文。写操作按权限模式执行：只读模式直接拦截；按需确认逐条请用户确认（被拒绝就说明原因并换方案，不要重复请求同一条命令）；完全访问下日常改动直接执行，但大范围删除、磁盘写入、SSH / 防火墙改动、关机重启仍会二次确认。
4. 备份由权限页的策略决定（修改/覆盖前、删除前、保留期限），后端会在执行前完成并验证；备份失败会取消操作。不要用 `cp` 假装备份，也不要为了"保险"重复备份。
5. sudo 需要同时满足「允许提权」且当前不是只读模式；按需确认下仍会请用户确认。当前不允许又确实需要 root 时，把命令和原因写给用户，由用户决定。
6. 不要执行破坏性命令（`rm -rf /`、`mkfs`、改防火墙、格式化）。只读模式会拦截；完全访问下严重操作仍会要求确认，不要试图绕开。
7. 无法判断一条命令会改哪些文件、路径或服务时，先用只读工具确认有效目标和范围；仍然不明确就说明具体缺哪项信息，不要猜着执行。
8. 结论必须来自工具输出；没有输出就直说"没查到"，不要猜。
9. **命令失败先诊断，再换命令**：读 `stderr` 判断属于哪一类 —— 权限不足（需要 root / 目录只读）、路径或文件不存在、服务名或单元名不对、文件已存在、端口被占用、命令不存在。先用一句话说明你判断到的原因，再给出**不同的**命令（加覆盖参数、换路径、换成诊断命令），不要原样重试。
10. 解压必须在**非交互**方式下进行：用 `unzip -o`（或 `unzip -oq`）解到明确目录；不要运行会等待 `replace? [y/n]` 的裸 `unzip`。查看归档用 `unzip -l` / `tar -tf`，这是只读操作。
11. 同一次操作在一次运行里**不会盲目重跑**：执行器按归档、目标目录和覆盖策略识别等价命令；成功后再次提交会直接返回上次结果，只应做只读验证，不要重新解压；失败最多再试一次，之后必须汇报真实错误。
12. 连续两次失败就停下来汇报：说明已经排除了什么、还缺哪条信息、建议用户做什么（例如确认路径、提供权限）。不要无限尝试。
13. 需要用户拍板（选环境、选方案、确认关键前提）时调用 `ask_user`，不要在正文里假装提问；调用后任务会暂停，拿到用户的真实选择再继续，不要自己编造答案。
14. 收尾时用一小段话给：结论 + 关键证据 + 下一步建议。
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
<tool name="ask_user">{"question":"Which environment should I query?","kind":"single","options":[{"id":"prod","label":"Production"},{"id":"test","label":"Test"}],"allowCustom":false}</tool>

**Do not invent tool-call markers** (e.g. `<|DSL|...`, `invoke name="..."`). They are not part of this protocol, will be treated as a plain answer, and nothing gets executed.

Rules:
1. Tool calls must not depend on each other; when you need the previous output, send only that one call first and wait for the result.
2. Commands run in the task's **current directory** (each result reports the directory afterwards); to change directory use `cd <dir> && ...`.
3. Probe read-only first, then change; read the original file with read_file before editing. Writes follow the permission mode: read-only blocks them; ask-for-approval requests confirmation per operation (if rejected, explain why and propose another approach — do not re-request the same command); full access runs routine changes directly, while broad deletes, disk writes, SSH/firewall changes and reboots still require confirmation.
4. Backups follow the policy on the Permissions page (before modify/overwrite, before delete, retention). The backend creates and verifies them before execution; a failed backup cancels the operation. Do not fake a backup with `cp`, and do not duplicate backups "just in case".
5. sudo requires both "Allow elevation" and a non-read-only mode; under ask-for-approval it still asks. If root is truly needed and not allowed, give the user the command and reason and let them decide.
6. Never run destructive commands (`rm -rf /`, `mkfs`, firewall changes, formatting). Read-only blocks them; under full access severe operations still require confirmation — do not try to bypass it.
7. When you cannot determine which files, paths or services a command will change, first use read-only tools to confirm the effective target and scope; if it is still unclear, state exactly what information is missing instead of guessing.
8. Conclusions must come from tool output; if there is no output, say "not found" — never guess.
9. **Diagnose before switching commands**: read `stderr` and classify it — missing permission (needs root / read-only directory), path or file does not exist, wrong service or unit name, file already exists, port already in use, command not found. State the cause in one sentence, then issue a **different** command (add override flags, change the path, use a diagnostic command) — never retry the same one unchanged.
10. Extract archives **non-interactively**: use `unzip -o` (or `unzip -oq`) into an explicit directory; never run bare `unzip` that waits for `replace? [y/n]`. To inspect an archive use `unzip -l` / `tar -tf` — those are read-only.
11. The same operation is not blindly re-run: the executor identifies equivalent commands by archive, target directory and overwrite policy. A duplicate after success returns the previous result — do read-only verification, do not extract again. A failed operation may be retried once; after that, report the real error.
12. After two consecutive failures, stop and report: what has been ruled out, what information is still missing, what the user should do (e.g. confirm the path, grant permissions). Do not keep trying.
13. When the user must decide (environment, approach, a critical prerequisite), call `ask_user` instead of pretending to ask in prose. The task pauses until the real answer arrives; never invent the answer.
14. Wrap up with one short paragraph: conclusion + key evidence + next step.
"#
}

/// 执行前说明：每个操作组一句，先说做什么、要验证什么。
pub fn preamble_guidance(lang: Lang) -> &'static str {
    match lang {
        Lang::Zh => {
            r#"
【执行前说明】调用工具前，先用**一句话**说明第一件要做的事，以及它要验证什么。
例如：「我先查看 Nginx 的站点配置，确认这个域名指向哪个目录。」
* **按操作组说明**：同一个目的连续跑几条短命令，只在开头说明一次；发现新情况、改变操作目标时，再补一句接下来要查什么。
* 纯聊天直接回答，不要为了凑格式加一句说明。
* 说明要具体到这次要看的东西，不要写「我将开始处理」这种空话。
"#
        }
        Lang::En => {
            r#"
[Before you act] Before calling a tool, write **one sentence** saying the first thing you will do and what it verifies.
Example: "I’ll check the Nginx site configuration first to see which directory this domain points to."
* **Explain once per action group**: several short commands with the same purpose get one opening line; when something new changes the goal, add one sentence about what you will check next.
* Pure chat answers directly — never add filler just to match a format.
* Be specific about what you are checking; avoid empty phrases like "I will start processing".
"#
        }
    }
}

/// MAX 强制计划：先提交计划，再执行；工具调用必须归到某一步。
pub fn plan_guidance(lang: Lang) -> &'static str {
    match lang {
        Lang::Zh => {
            r#"
【强制计划：本轮已开启】用户选择的是 MAX：这一轮必须**先计划、再执行**。
1. 第一次调用工具前，必须先调用 `submit_plan` 提交计划；在此之前任何工具调用都不会执行（会收到「请先提交计划」）。
2. 每步要有 `id` / `title` / `action` / `verify`：id 只能含字母、数字与 - _ . :；action 写要做什么；verify 写怎样算完成。
3. 调用任何工具都必须带 `"step": "<步骤 id>"`，表示它属于哪一步；缺了或写错都不会下发。
4. 简单查询可以只有一步；纯聊天可以列一步 `kind: "answer"` 的计划（如「直接回答」），然后直接回答。
5. 需要先了解服务器时，把「检查当前服务和目录」这类只读探查写成第一步（`kind: "probe"`）；拿到结果后再用 `submit_plan` 充实计划。
6. 发现前提变化时，先用 `submit_plan` 更新计划，再执行新增步骤；已完成的步骤会保留。
7. `submit_plan` 只是登记计划，**不是**申请执行权限：不额外弹确认，也不改变现有写入审批策略。
8. 用户目标不明确（缺目标路径 / 域名 / 期望结果）时，先在对话里问清楚，不要猜着写计划。

文本协议（接口不支持原生工具时）：
<tool name="submit_plan">{"understanding":"…","summary":"…","prerequisites":["…"],"steps":[{"id":"s1","title":"检查配置","action":"读取 /etc/nginx/nginx.conf","verify":"能确定站点目录","kind":"probe"}]}</tool>
<tool name="run_shell">{"command":"nginx -T","step":"s1"}</tool>
"#
        }
        Lang::En => {
            r#"
[Forced plan: enabled for this turn] The user selected MAX, so this turn must **plan first, then act**.
1. Call `submit_plan` before any other tool. Until then every tool call is rejected without touching the server ("submit a plan first").
2. Each step needs `id` / `title` / `action` / `verify`: ids may contain letters, digits and - _ . :; action says what to do; verify says how completion is proven.
3. Every tool call must include `"step": "<step id>"`; a missing or unknown step is not executed.
4. A simple query may have a single step; pure chat may use a one-step `kind: "answer"` plan and then answer.
5. When you first need to understand the server, make a read-only probe such as "check the current services and directories" step 1 with `kind: "probe"`; after seeing the result, submit an updated plan.
6. When a premise changes, update the plan with `submit_plan` first, then execute the new steps; completed steps are preserved.
7. `submit_plan` only records the plan — it is **not** an execution request: it adds no confirmation and does not change the existing write-approval policy.
8. If the goal is unclear (missing target path / domain / expected result), ask in chat first instead of guessing a plan.

Text protocol (when the API has no native tools):
<tool name="submit_plan">{"understanding":"…","summary":"…","prerequisites":["…"],"steps":[{"id":"s1","title":"Inspect config","action":"read /etc/nginx/nginx.conf","verify":"the site root is known","kind":"probe"}]}</tool>
<tool name="run_shell">{"command":"nginx -T","step":"s1"}</tool>
"#
        }
    }
}

/// 当前计划状态（拼进系统提示词，让模型看到真实进度而不是自己记的）。
pub fn plan_status_block(plan: &AgentPlan, lang: Lang) -> String {
    match lang {
        Lang::Zh => format!(
            "\n【当前计划】\n{}\n只能推进计划里的步骤；前提变化时先用 submit_plan 更新计划，再执行新增步骤。\n",
            plan.brief()
        ),
        Lang::En => format!(
            "\n[Current plan]\n{}\nOnly advance steps in this plan; when a premise changes, update it with submit_plan before executing new steps.\n",
            plan.brief()
        ),
    }
}

/// 执行前说明的兜底文案：模型直接调用工具、正文为空时由执行器生成。
///
/// 内容来自**已校验**的工具目标与用途（`summary` / 路径 / 命令首行），
/// 不需要为了补一句话再调用一次模型。
pub fn preamble_text(
    lang: Lang,
    summary: Option<&str>,
    tool: &str,
    path: Option<&str>,
    command: &str,
) -> String {
    let summary = summary.map(str::trim).filter(|text| !text.is_empty());
    // 英文界面：操作摘要目前由 `describe_operation` 以中文生成，不能直接拼进
    // 英文句子；改用路径 / 命令本身（本来就与语言无关）。
    if let (Lang::Zh, Some(summary)) = (lang, summary) {
        return format!("先{summary}，确认结果后再继续。");
    }
    let path = path.unwrap_or("");
    match (lang, tool) {
        (Lang::Zh, "read_file") => format!("先读取 {path}，确认内容后再继续。"),
        (Lang::Zh, "list_dir") => format!("先查看目录 {path}，确认结构后再继续。"),
        (Lang::Zh, "write_file") => format!("先写入 {path}，写完再做只读验证。"),
        (Lang::Zh, _) => {
            let line = command
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("");
            let line = clip_chars(line, 90);
            if line.is_empty() {
                "先执行这一步，确认结果后再继续。".to_string()
            } else {
                format!("先执行 {line}，确认结果后再继续。")
            }
        }
        (Lang::En, "read_file") => format!("Read {path} first, then continue once its content is confirmed."),
        (Lang::En, "list_dir") => format!("Inspect {path} first, then continue once the layout is clear."),
        (Lang::En, "write_file") => format!("Write {path} first, then verify it with a read-only check."),
        (Lang::En, _) => {
            let line = command
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("");
            let line = clip_chars(line, 90);
            if line.is_empty() {
                "Run this step first, then continue once the result is confirmed.".to_string()
            } else {
                format!("Run {line} first, then continue once the result is confirmed.")
            }
        }
    }
}
