//! 超能模式 Agent 的 IPC。
//!
//! 五个命令，全部围绕一个 taskId：
//! * `agent_start`    —— 启动多轮循环，**立刻返回初始快照**（循环在后台跑）；
//! * `agent_snapshot` —— 前端重进 / 轮询时恢复卡片与当前进度；
//! * `agent_approve`  —— 对挂起中的写 / 危险操作表态（不点就永远不执行）；
//! * `agent_steer`    —— 运行中补一句要求：下一步开始前交给模型；正在等确认的
//!   那一步先撤回，按新要求重新评估；
//! * `agent_cancel`   —— 置停止标记（当前命令跑完才停，语义同 `ai_chat_cancel`）。
//!
//! 这里不做业务判断：校验、命令构造、风险与上限都在 `crate::agent` 里，
//! 命令层只做参数形状转换。

use serde::Deserialize;
use tauri::{AppHandle, Emitter as _, State};

use crate::agent::{
    normalize_carried_steps, plan_status_block, spawn_agent, AgentInput, AgentPlan, AgentServerRef,
    AgentSnapshot, AgentStep, AgentTurn, FileChangeDetail, FileChangeSummary, FileSnapshot, Lang,
    NetChangeSet, PermissionMode, StepCategory, StoredChange, TokenUsage,
};

fn default_true() -> bool {
    true
}

fn default_backup_retention() -> u32 {
    30
}
use crate::commands::extreme::{load_task_record, ExtremeTaskRecord};
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
    /// 服务器配置 id / 对话 id：文件变更记录按它们归属，切换对话不会串。
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub cwd: String,
    pub messages: Vec<AgentTurnInput>,
    /// 只有用户在界面上打开「完全权限」才为 true。
    #[serde(default)]
    pub allow_sudo: bool,
    /// 同上：完全权限下修改范围内的写 / 改 / 删都不再逐条确认。
    #[serde(default)]
    pub auto_approve_writes: bool,
    /// 三档权限；旧客户端不传时按 `auto_approve_writes` 推断。
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// 备份策略（缺省沿用旧行为：修改与删除前都备份，保留 30 天）。
    #[serde(default = "default_true")]
    pub backup_before_write: bool,
    #[serde(default = "default_true")]
    pub backup_before_delete: bool,
    #[serde(default = "default_backup_retention")]
    pub backup_retention_days: u32,
    /// 本轮启用的 MCP 工具（暴露名，来自 MCP 页的启用状态）。
    #[serde(default)]
    pub enabled_mcp_tools: Vec<String>,
    /// 本轮勾选的内置技能；`None` = 旧客户端，全部放行。
    #[serde(default)]
    pub enabled_builtins: Option<Vec<String>>,
    /// 续跑同一个 taskId 时带上已知的累计用量（后端从它继续加）。
    #[serde(default)]
    pub carry_usage: Option<TokenUsage>,
    #[serde(default)]
    pub max_rounds: Option<u32>,
    /// 这条会话选中的模型（provider id）；`None` = 默认提供方。
    #[serde(default)]
    pub provider_id: Option<String>,
    /// 思考强度：`low` / `medium` / `high` / `max`；`None` / `auto` = 供应商默认。
    /// 界面传用户**实际选的**档位（选 MAX 就传 max），由后端按模型能力解析。
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// 本轮是否强制先提交计划（用户选 MAX = true，与供应商实际最高档无关）。
    #[serde(default)]
    pub plan_required: bool,
    /// 续跑同一个 taskId 时带上上一版计划。
    #[serde(default)]
    pub plan: Option<AgentPlan>,
    /// 上下文输入预算（tokens）；`None` = 按模型窗口自动。
    #[serde(default)]
    pub context_budget: Option<u32>,
    /// 界面语言（`zh-CN` / `en`）：决定系统提示词用哪种语言写；不传按中文。
    #[serde(default)]
    pub locale: Option<String>,
    /// 回复语言覆盖（`zh` / `en`）；不传 = 跟随界面语言。
    #[serde(default)]
    pub reply_language: Option<String>,
}

/// 本轮允许子代理选择的服务器。
///
/// 只认三件事同时成立的会话：数据库里标记 connected、SSH 管理器确认传输仍活着、
/// serverId 非空。模型拿不到这份清单以外的东西，因此不能按名字"猜"一台机器。
async fn authorized_servers(
    state: &AppState,
    parent_session: &str,
    parent_server_id: Option<&str>,
    parent_server: &str,
) -> Vec<AgentServerRef> {
    let rows = state
        .db
        .open()
        .ok()
        .and_then(|conn| crate::db::list_recent_sessions(&conn, 50).ok())
        .unwrap_or_default();
    let mut out: Vec<AgentServerRef> = Vec::new();
    for row in rows {
        if row.status != "connected" || row.server_id.trim().is_empty() {
            continue;
        }
        if !state.ssh.is_connected(&row.id).await {
            continue;
        }
        // 同一台服务器可能有重连后的多条历史会话：只保留最新的一条活跃会话。
        if out.iter().any(|server| server.server_id == row.server_id) {
            continue;
        }
        out.push(AgentServerRef {
            server_id: row.server_id,
            server_name: row.server_name,
            session_id: row.id,
        });
    }
    let parent = AgentServerRef {
        server_id: parent_server_id.unwrap_or("").to_string(),
        server_name: parent_server.to_string(),
        session_id: parent_session.to_string(),
    };
    match out
        .iter()
        .position(|server| server.session_id == parent_session)
    {
        Some(index) => out[index] = parent,
        None => out.insert(0, parent),
    }
    out
}

#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: AgentStartRequest,
) -> OpsResult<AgentSnapshot> {
    let permission_mode = PermissionMode::from_wire(
        request.permission_mode.as_deref(),
        request.auto_approve_writes,
    );
    let allow_sudo = request.allow_sudo && !permission_mode.is_read_only();
    // 只把**本会话启用**的 MCP 工具解析成绑定；配置损坏 / 库读失败时退化为无 MCP。
    let mcp_tools = crate::mcp::bindings_for(
        &state.db,
        &request.enabled_mcp_tools,
        request.server_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .unwrap_or_default();
    let servers = authorized_servers(
        &state,
        &request.session_id,
        request.server_id.as_deref(),
        &request.server,
    )
    .await;
    let input = AgentInput {
        task_id: request.task_id,
        session_id: request.session_id,
        server: request.server,
        server_id: request.server_id,
        workspace_id: request.workspace_id,
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
        // 能力由 `spawn_agent` 从库里的提供方配置填（命令层不做第二份解析）。
        capability: None,
        carry_usage: request.carry_usage,
        allow_sudo,
        auto_approve_writes: permission_mode.is_full(),
        permission_mode,
        backup_before_write: request.backup_before_write,
        backup_before_delete: request.backup_before_delete,
        backup_retention_days: request.backup_retention_days,
        mcp_tools,
        servers,
        enabled_builtins: request.enabled_builtins,
        db: Some(state.db.clone()),
        plan_required: request.plan_required,
        carry_plan: request.plan,
        max_rounds: request.max_rounds,
        provider_id: request.provider_id,
        locale: request.locale,
        reply_language: request.reply_language,
        carry_steps: Vec::new(),
        child_run: false,
    };
    spawn_agent(app, state.inner().clone(), input)
        .await
        .map_err(|error| OpsError::new("ai", error))
}

/// 恢复一条被中断的任务：用**当前**的 SSH 会话与模型设置，接着它的检查点跑。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResumeRequest {
    pub task_id: String,
    /// 重连后的会话；历史里那个 session_id 只用于关联，不能直接拿来跑。
    pub session_id: String,
    /// 归属：继续执行时新产生的文件变更仍挂回原来那条对话 / 服务器。
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// 恢复同样沿用 MAX 的强制计划门控（前端按当时的任务记录带过来）。
    #[serde(default)]
    pub plan_required: bool,
    /// 上次保存的计划（前端从任务 / 消息里带回来），用于继续执行。
    #[serde(default)]
    pub plan: Option<AgentPlan>,
    #[serde(default)]
    pub context_budget: Option<u32>,
    #[serde(default)]
    pub allow_sudo: bool,
    #[serde(default)]
    pub auto_approve_writes: bool,
    /// 三档权限；旧客户端不传时按 `auto_approve_writes` 推断。
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default = "default_true")]
    pub backup_before_write: bool,
    #[serde(default = "default_true")]
    pub backup_before_delete: bool,
    #[serde(default = "default_backup_retention")]
    pub backup_retention_days: u32,
    #[serde(default)]
    pub enabled_mcp_tools: Vec<String>,
    #[serde(default)]
    pub enabled_builtins: Option<Vec<String>>,
    #[serde(default)]
    pub max_rounds: Option<u32>,
    /// 界面语言（`zh-CN` / `en`）：决定系统提示词用哪种语言写；不传按中文。
    #[serde(default)]
    pub locale: Option<String>,
    /// 回复语言覆盖（`zh` / `en`）；不传 = 跟随界面语言。
    #[serde(default)]
    pub reply_language: Option<String>,
}

/// 把历史 `plan_json`（DeployStep[]）还原成 Agent 步骤。
///
/// 不做字段猜测：只认 `kind == "tool"` 的 Agent 步骤；部署计划走原来的部署
/// 恢复流程，不在这里硬跑。
fn checkpoint_steps(plan_json: &str) -> Vec<AgentStep> {
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str(plan_json) else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| item["kind"].as_str() == Some("tool"))
        .enumerate()
        .map(|(index, item)| {
            let state = item["state"].as_str().unwrap_or("pending");
            // 进程退出时还停在 running / waiting：命令可能已经发出去了，恢复时先核对。
            let interrupted = matches!(state, "running" | "waiting");
            let is_child = item["sourceTool"].as_str() == Some("child_agent")
                || item["groupId"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("children-"));
            AgentStep {
                index: index as u32,
                call_id: format!("resume-{index}"),
                tool: if let Some(tool) = item["sourceTool"].as_str().filter(|s| !s.is_empty()) {
                    tool.to_string()
                } else if item["remotePath"].as_str().is_some() {
                    "write_file".to_string()
                } else {
                    "run_shell".to_string()
                },
                path: item["remotePath"].as_str().map(str::to_string),
                risk: item["risk"].as_str().unwrap_or("read").to_string(),
                state: if interrupted {
                    "failed".to_string()
                } else {
                    state.to_string()
                },
                command: item["command"].as_str().unwrap_or("").to_string(),
                summary: item["title"].as_str().map(str::to_string),
                stdout: item["stdout"].as_str().unwrap_or("").to_string(),
                stderr: if interrupted && is_child {
                    "任务中断，子任务结果未知；恢复后先核实服务器状态".to_string()
                } else if interrupted {
                    "上次运行在这里中断：命令可能已在服务器上执行，恢复后先核对".to_string()
                } else {
                    item["stderr"].as_str().unwrap_or("").to_string()
                },
                exit_code: item["exitCode"].as_i64().map(|code| code as i32),
                group_id: item["groupId"].as_str().map(str::to_string),
                child_usage: serde_json::from_value(item["childUsage"].clone()).ok(),
                server: item["server"].as_str().map(str::to_string),
                server_id: item["serverId"].as_str().map(str::to_string),
                session_id: item["sessionId"].as_str().map(str::to_string),
                child_id: item["childId"].as_str().map(str::to_string),
                child_goal: item["childGoal"].as_str().map(str::to_string),
                child_depends_on: item["childDependsOn"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|value| value.as_str())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                stale: item["stale"].as_bool().unwrap_or(false),
                backup_path: item["backupPath"].as_str().map(str::to_string),
                rollback: item["rollback"].as_str().map(str::to_string),
                /*
                 * 类别 / 未执行原因跟着历史一路带回来：恢复后的步骤与实时看到
                 * 的必须是同一口径，否则一次内部纠错会在恢复后变成"执行失败"。
                 * 中断改写成 failed 的那条**不继承类别**（保守当作结果未知）。
                 */
                category: if interrupted {
                    None
                } else {
                    item["category"].as_str().and_then(StepCategory::from_code)
                },
                blocked: if interrupted {
                    // 子任务中断：结果未知；普通命令沿用原有"先核对"语义。
                    is_child.then(|| "interrupted_unknown".to_string())
                } else {
                    item["blocked"].as_str().map(str::to_string)
                },
                ..Default::default()
            }
        })
        .collect()
}

fn resume_step_line(step: &AgentStep) -> String {
    let text = if !step.command.trim().is_empty() {
        step.command.lines().next().unwrap_or("").to_string()
    } else if let Some(path) = step.path.as_deref() {
        path.to_string()
    } else {
        step.tool.clone()
    };
    text.chars().take(100).collect()
}

/// 给模型的检查点说明：做了什么、断在哪、恢复时必须先核对。
fn resume_brief(record: &ExtremeTaskRecord, steps: &[AgentStep], cwd: &str, lang: Lang) -> String {
    let total = steps.len();
    let done = steps
        .iter()
        .filter(|step| matches!(step.state.as_str(), "success" | "skipped"))
        .count();
    let point = steps
        .iter()
        .find(|step| matches!(step.state.as_str(), "failed" | "running" | "waiting"))
        .map(|step| format!("#{} {}", step.index + 1, resume_step_line(step)))
        .unwrap_or_else(|| match lang {
            Lang::Zh => "最后一步之后".to_string(),
            Lang::En => "after the last step".to_string(),
        });
    let history: Vec<String> = steps
        .iter()
        .rev()
        .take(8)
        .map(|step| {
            format!(
                "#{} [{}] {}",
                step.index + 1,
                step.state,
                resume_step_line(step)
            )
        })
        .collect();
    if lang == Lang::En {
        return format!(
            "[Resume] The previous run stopped in the middle of this task.\n\
             Goal: {}\nServer: {}\nPrevious directory: {}\n{}/{} steps done.\n\
             Recent steps (newest first):\n{}\nInterruption point: {}\n\n\
             Resume rules:\n\
             1. First use **read-only commands only** to check whether the completed steps are still in effect (file content / service state / port); never redo a step that already took effect;\n\
             2. Continue from the first unfinished or failed step;\n\
             3. If the check shows a step did not actually take effect, run it again and say so in the conclusion;\n\
             4. One operation may have been waiting for confirmation when it stopped: it **did not run**; re-propose it if needed and wait for approval;\n\
             5. After completing or changing anything, run a read-only verification; if it cannot be verified, say so explicitly.",
            record.goal,
            record.server,
            cwd,
            done,
            total,
            history.join("\n"),
            point
        );
    }
    format!(
        "【恢复执行】上一次运行在这个任务的中途结束。\n\
         目标：{}\n服务器：{}\n上次的目录：{}\n已完成 {}/{} 步。\n\
         最近步骤（从新到旧）：\n{}\n中断点：{}\n\n\
         恢复规则：\n\
         1. 先**只用只读命令**核对已完成步骤是否仍然生效（文件内容 / 服务状态 / 端口），不要重做已经生效的步骤；\n\
         2. 从第一条未完成或失败的步骤继续；\n\
         3. 如果核对发现某一步其实没有生效，再执行它，并在结论里说明；\n\
         4. 中断时可能有一条操作正在等你确认：它**没有执行**，需要就重新提出并等确认；\n\
         5. 完成或修改后必须做一次只读验证；无法验证就明确说未验证。",
        record.goal,
        record.server,
        cwd,
        done,
        total,
        history.join("\n"),
        point
    )
}

/// 从检查点恢复执行（任务历史里「继续执行」）。
#[tauri::command]
pub async fn agent_resume(
    app: AppHandle,
    state: State<'_, AppState>,
    request: AgentResumeRequest,
) -> OpsResult<AgentSnapshot> {
    let task_id = request.task_id.trim();
    let lang = Lang::from_locale(request.locale.as_deref());
    let ui = |zh: &str, en: &str| match lang {
        Lang::Zh => zh.to_string(),
        Lang::En => en.to_string(),
    };
    if task_id.is_empty() {
        return Err(OpsError::new(
            "config",
            ui("taskId 不能为空", "taskId must not be empty"),
        ));
    }
    // 先确认**当前**会话还活着：历史里的 session_id 可能早就断了。
    if !state.ssh.is_connected(&request.session_id).await {
        return Err(OpsError::new(
            "ssh",
            ui(
                "SSH 会话已断开：先重新连接这台服务器，再恢复任务",
                "The SSH session is disconnected: reconnect to this server before resuming the task",
            ),
        ));
    }
    let record = load_task_record(&state, task_id)
        .map_err(|error| OpsError::new("io", error))?
        .ok_or_else(|| {
            OpsError::new(
                "config",
                ui(
                    "找不到这条任务的历史记录",
                    "No history record was found for this task",
                ),
            )
        })?;
    if record.status == "success" {
        return Err(OpsError::new(
            "ai",
            ui(
                "这条任务已经完成，不需要恢复",
                "This task already succeeded and does not need to be resumed",
            ),
        ));
    }
    if let Some(handle) = state.agents.get(task_id) {
        if !handle.snapshot().terminal() {
            return Err(OpsError::new(
                "ai",
                ui("这条任务还在执行", "This task is still running"),
            ));
        }
    }
    let mut steps = checkpoint_steps(&record.plan_json);
    // 中断时未开始 / 结果未知的子任务不能沿用旧状态：先归一化再写进检查点说明。
    normalize_carried_steps(&mut steps);
    if steps.is_empty() {
        return Err(OpsError::new(
            "ai",
            ui(
                "这条记录没有可恢复的 Agent 步骤（部署计划请从部署面板继续）",
                "This record has no resumable Agent steps (resume deployment plans from the deployment panel)",
            ),
        ));
    }
    let cwd = if record.cwd.trim().is_empty() {
        "/".to_string()
    } else {
        record.cwd.clone()
    };
    let mut goal = if record.goal.trim().is_empty() {
        record.summary.clone()
    } else {
        record.goal.clone()
    };
    if goal.trim().is_empty() {
        goal = ui(
            "继续完成上次未完成的任务",
            "Continue the unfinished task from the last run",
        );
    }
    let server = record.server.clone();
    let mut brief = resume_brief(&record, &steps, &cwd, lang);
    if steps.iter().any(|step| step.stale) {
        brief.push_str(match lang {
            Lang::Zh => "\n【上次子任务结果】有的子任务在上次运行里已完成，但服务器状态可能已经变化：只能作为线索，涉及当前状态的结论必须重新用只读命令核实，不能直接当成事实。\n",
            Lang::En => "\n[Previous child results] Some investigations completed before the interruption, but server state may have changed. Treat them only as leads; re-verify any current-state conclusion with read-only commands instead of treating them as facts.\n",
        });
    }
    if let Some(plan) = request.plan.as_ref() {
        brief.push_str(&plan_status_block(plan, lang));
    }
    let permission_mode = PermissionMode::from_wire(
        request.permission_mode.as_deref(),
        request.auto_approve_writes,
    );
    let allow_sudo = request.allow_sudo && !permission_mode.is_read_only();
    let mcp_tools = crate::mcp::bindings_for(
        &state.db,
        &request.enabled_mcp_tools,
        request.server_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .unwrap_or_default();
    // 恢复只使用**当前**真正连着的会话；历史里那台机器没重连就不能拿来跑。
    let servers = authorized_servers(
        &state,
        &request.session_id,
        request.server_id.as_deref(),
        &server,
    )
    .await;
    let input = AgentInput {
        task_id: task_id.to_string(),
        session_id: request.session_id,
        server,
        server_id: request.server_id,
        workspace_id: request.workspace_id,
        cwd: cwd.clone(),
        messages: vec![
            AgentTurn {
                role: "system".to_string(),
                content: brief,
            },
            AgentTurn {
                role: "user".to_string(),
                content: goal,
            },
        ],
        provider_id: request.provider_id,
        locale: request.locale,
        reply_language: request.reply_language,
        reasoning_effort: request.reasoning_effort,
        context_budget: request.context_budget,
        capability: None,
        carry_usage: None,
        allow_sudo,
        auto_approve_writes: permission_mode.is_full(),
        permission_mode,
        backup_before_write: request.backup_before_write,
        backup_before_delete: request.backup_before_delete,
        backup_retention_days: request.backup_retention_days,
        mcp_tools,
        servers,
        enabled_builtins: request.enabled_builtins,
        db: Some(state.db.clone()),
        plan_required: request.plan_required,
        carry_plan: request.plan,
        max_rounds: request.max_rounds,
        carry_steps: steps,
        child_run: false,
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

/// 回答 AI 挂起的选择题。只接受第一次提交；已回答 / 已超时返回错误。
#[tauri::command]
pub fn agent_answer_question(
    state: State<'_, AppState>,
    task_id: String,
    question_id: String,
    selected: Vec<String>,
    custom: Option<String>,
) -> OpsResult<bool> {
    let Some(handle) = state.agents.get(&task_id) else {
        return Err(OpsError::new("agent", "任务已经结束，无法回答"));
    };
    let Some(question) = handle
        .pending_question()
        .filter(|question| question.question_id == question_id)
    else {
        return Err(OpsError::new("agent", "这个问题已经回答或已过期"));
    };
    let answer = question
        .validate_answer(&selected, custom.as_deref())
        .map_err(|reason| OpsError::new("input", reason))?;
    if !handle.resolve_answer(&question_id, answer) {
        return Err(OpsError::new("agent", "这个问题已经回答或已过期"));
    }
    Ok(true)
}

/// 运行中补一句要求（「更新当前任务」）。
///
/// 返回 `false` = 这条任务已经结束，前端应改为新发一条消息。限制长度不是
/// 走形式：这条文本会原样进模型上下文，太长的粘贴（几 MB 日志）会把窗口撑爆。
#[tauri::command]
pub fn agent_steer(state: State<'_, AppState>, task_id: String, text: String) -> OpsResult<bool> {
    let text = text.trim();
    if text.is_empty() {
        return Err(OpsError::new("config", "补充要求不能为空"));
    }
    if text.chars().count() > 4000 {
        return Err(OpsError::new("config", "补充要求最多 4000 字"));
    }
    let Some(handle) = state.agents.get(&task_id) else {
        return Ok(false);
    };
    if handle.snapshot().terminal() {
        return Ok(false);
    }
    handle.push_steer(text);
    Ok(true)
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

/// 强制结束：后端没能确认停止时由用户明确选择。
///
/// 只停止**跟踪**并把快照收敛成 `cancelled`；已经发到服务器上的命令无法撤回，
/// 所以原因会写进 `error`，界面必须原样说明。返回 `None` = 后端已经没有这条
/// 运行（应用重启 / 记录被清理），前端应按本地"已停止"收尾。
#[tauri::command]
pub fn agent_abandon(
    state: State<'_, AppState>,
    task_id: String,
) -> OpsResult<Option<AgentSnapshot>> {
    let reason =
        "用户强制结束了这次运行：不再等待后端确认。服务器上已经发出的命令可能仍在执行，请先核对。";
    let snapshot = state.agents.abandon(&task_id, reason);
    state.ai_reviews.forget(&task_id);
    Ok(snapshot)
}

/// 文件变更列表：**只返回标识与摘要**，Diff 正文按需用 `agent_file_change_detail` 取。
///
/// 两条筛选可以同时给：对话 + 任务 = 某次运行；只给对话 = 这条对话的全部记录
/// （含之前几次运行，界面用来做"运行"下拉）。记录只存在内存里，应用重启后为空。
#[tauri::command]
pub fn agent_file_changes(
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    task_id: Option<String>,
) -> OpsResult<Vec<FileChangeSummary>> {
    let mut list = state
        .changes
        .list(workspace_id.as_deref(), task_id.as_deref());
    /*
     * 应用重启后内存注册表是空的：给定了任务就回落到任务历史里那份脱敏记录。
     * 只按单个任务回落，不做全表扫描 —— 右栏"本次运行"就够用。
     */
    if list.is_empty() {
        if let Some(task) = task_id.as_deref() {
            if let Ok(Some(json)) = crate::commands::extreme::load_task_changes(state.inner(), task)
            {
                if let Ok(stored) = serde_json::from_str::<Vec<StoredChange>>(&json) {
                    state.changes.remember(stored);
                    list = state
                        .changes
                        .list(workspace_id.as_deref(), task_id.as_deref());
                }
            }
        }
    }
    Ok(list)
}

/// 本轮**净变化**：同一路径只留一条（首次操作前 → 最后一次验证后）。
///
/// 与 `agent_file_changes` 分开是有意的：净变化为空可能表示"本轮真的没变"，
/// 也可能表示"内存里没有本轮记录"。`available` 把这两种情况分开，界面
/// 据此决定显示「本轮无文件净变化」还是回落到逐条历史 —— 空数组不会再
/// 让原来的逐步记录重新冒出来。
#[tauri::command]
pub fn agent_file_changes_net(
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    task_id: String,
) -> OpsResult<NetChangeSet> {
    Ok(state.changes.net_changes(workspace_id.as_deref(), &task_id))
}

/// 把这轮运行的变更（摘要 + 脱敏 Diff）写进任务历史。
///
/// 由前端在任务进入终态时调用：跑的过程中不落库，避免每一步都写一次。
#[tauri::command]
pub fn agent_task_changes_save(state: State<'_, AppState>, task_id: String) -> OpsResult<usize> {
    let stored: Vec<StoredChange> = state
        .changes
        .records_for_task(&task_id)
        .iter()
        .map(StoredChange::from_record)
        .collect();
    if stored.is_empty() {
        return Ok(0);
    }
    let json = serde_json::to_string(&stored)
        .map_err(|error| OpsError::new("config", format!("变更记录序列化失败：{error}")))?;
    crate::commands::extreme::save_task_changes(state.inner(), &task_id, &json)
        .map_err(|error| OpsError::new("db", format!("变更记录落库失败：{error}")))?;
    Ok(stored.len())
}

/// 计划执行器 / 手工写入登记一条变更。
///
/// Agent 自己的 `write_file` 有前后回读；计划里的上传步骤由前端知道目标与
/// 正文，直接交回来即可生成同样的 Diff。`before` 读不到时传 `null`，
/// 记录会标成"未采集差异"，而不是编一份"全新增"的假 Diff。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRecordRequest {
    pub task_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub server: String,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub tool: String,
    pub path: String,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub after: Option<String>,
    /// `written` / `unchanged` / `write_failed` / `unavailable`
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub step_index: Option<u32>,
}

#[tauri::command]
pub fn agent_file_change_record(
    app: AppHandle,
    state: State<'_, AppState>,
    request: FileChangeRecordRequest,
) -> OpsResult<FileChangeSummary> {
    let id = uuid::Uuid::new_v4().to_string();
    let status = request.status.as_deref().unwrap_or("written").to_string();
    state.changes.create(
        crate::agent::ChangeDraft {
            id: id.clone(),
            task_id: request.task_id.clone(),
            call_id: request.tool.clone(),
            step_index: request.step_index.unwrap_or(0),
            workspace_id: request.workspace_id.clone(),
            server_id: request.server_id.clone(),
            server: request.server.clone(),
            tool: request.tool.clone(),
            path: request.path.clone(),
        },
        &status,
        "actual",
    );
    state.changes.update(&id, |record| {
        record.before = request.before.as_deref().map(|text| {
            // 空串 = 目标原本不存在（新文件）：按 absent 记，卡片才会标「新增」。
            if text.is_empty() {
                FileSnapshot::absent(&request.path)
            } else {
                FileSnapshot::from_text(&request.path, text)
            }
        });
        record.actual = request
            .after
            .as_deref()
            .map(|text| FileSnapshot::from_text(&request.path, text));
        // 没有前后正文就不做逐行比较：宁可说"未采集"，也不凭空生成全新增。
        if record.before.is_none() || record.actual.is_none() {
            record.stage = "none".to_string();
        }
        record.note = request.note.clone();
        record.recount();
    });
    let summary = state
        .changes
        .get(&id)
        .ok_or_else(|| OpsError::new("config", "变更记录创建失败：记录不在注册表里"))?;
    // 广播同一条记录：面板、任务历史都靠它刷新，不必各自再拉一次。
    let mut event = crate::agent::AgentEvent::new(&summary.task_id, "file_change");
    event.change_id = Some(summary.id.clone());
    event.change = Some(summary.clone());
    let _ = app.emit(crate::agent::AGENT_EVENT, event);
    Ok(summary)
}

/// 取一条变更的实际 Diff 与前后快照（已脱敏）。
///
/// 历史记录用的是**当时的快照**：服务器上的文件之后再改，这里也不会变。
#[tauri::command]
pub fn agent_file_change_detail(
    state: State<'_, AppState>,
    change_id: String,
) -> OpsResult<FileChangeDetail> {
    state.changes.detail(&change_id).ok_or_else(|| {
        OpsError::new(
            "config",
            "找不到这条变更记录：可能已超出保留范围（应用重启后记录会清空）",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{checkpoint_steps, normalize_carried_steps, StepCategory};

    #[test]
    fn checkpoint_keeps_tool_steps_and_marks_interrupted_ones() {
        let plan = serde_json::json!([
            {
                "kind": "tool",
                "title": "重启 nginx",
                "command": "systemctl restart nginx",
                "risk": "write",
                "state": "success",
                "stdout": "ok",
                "exitCode": 0
            },
            {
                "kind": "tool",
                "title": "改写配置",
                "remotePath": "/etc/nginx/conf.d/ops.conf",
                "risk": "write",
                "state": "running"
            },
            {
                "kind": "upload",
                "title": "上传文件",
                "state": "success"
            }
        ]);
        let steps = checkpoint_steps(&plan.to_string());
        assert_eq!(steps.len(), 2, "部署步骤不混进 Agent 恢复");
        assert_eq!(steps[0].state, "success");
        assert_eq!(steps[0].command, "systemctl restart nginx");
        assert_eq!(steps[1].tool, "write_file");
        // 中断时还在 running：标成失败并写清"可能已生效，先核对"。
        assert_eq!(steps[1].state, "failed");
        assert!(steps[1].stderr.contains("核对"));
    }

    #[test]
    fn checkpoint_preserves_child_identity_and_estimated_usage() {
        let plan = serde_json::json!([{
            "kind": "tool", "title": "检查服务", "sourceTool": "child_agent", "groupId": "children-0",
            "state": "success", "childUsage": { "requests": 2, "inputTokens": 120, "outputTokens": 30 },
            "server": "生产", "serverId": "srv-a", "childId": "svc", "childGoal": "检查服务",
            "childDependsOn": ["disk"], "stale": true
        }]);
        let steps = checkpoint_steps(&plan.to_string());
        assert_eq!(steps[0].tool, "child_agent");
        assert_eq!(steps[0].group_id.as_deref(), Some("children-0"));
        assert_eq!(steps[0].child_usage.as_ref().unwrap().input_tokens, 120);
        // 恢复必须带回子任务身份与服务器：否则会与另一台机器串台。
        assert_eq!(steps[0].server.as_deref(), Some("生产"));
        assert_eq!(steps[0].server_id.as_deref(), Some("srv-a"));
        assert_eq!(steps[0].child_id.as_deref(), Some("svc"));
        assert_eq!(steps[0].child_goal.as_deref(), Some("检查服务"));
        assert_eq!(steps[0].child_depends_on, vec!["disk"]);
        assert!(steps[0].stale);
    }

    #[test]
    fn an_interrupted_child_is_never_restored_as_running_or_success() {
        let plan = serde_json::json!([
            { "kind": "tool", "title": "运行中", "sourceTool": "child_agent", "groupId": "children-0", "state": "running" },
            { "kind": "tool", "title": "排队", "sourceTool": "child_agent", "groupId": "children-0", "state": "pending" },
            { "kind": "tool", "title": "完成", "sourceTool": "child_agent", "groupId": "children-0", "state": "success", "childId": "done", "childGoal": "g" }
        ]);
        let mut steps = checkpoint_steps(&plan.to_string());
        normalize_carried_steps(&mut steps);
        assert_eq!(steps[0].state, "failed");
        assert_eq!(steps[0].blocked.as_deref(), Some("interrupted_unknown"));
        assert_eq!(steps[1].state, "skipped");
        assert_eq!(steps[1].blocked.as_deref(), Some("interrupted_pending"));
        assert_eq!(steps[2].state, "success");
        assert!(steps[2].stale);
    }

    #[test]
    fn checkpoint_ignores_broken_json() {
        assert!(checkpoint_steps("{not json").is_empty());
        assert!(checkpoint_steps("[]").is_empty());
    }

    /// 历史里的类别与"没执行"原因必须带回来：恢复后不能把一次内部纠错
    /// 显示成执行失败，也不能把用户拒绝说成服务器出错。
    #[test]
    fn checkpoint_keeps_step_category_and_blocked_reason() {
        let plan = serde_json::json!([
            {
                "kind": "tool",
                "title": "查看容器",
                "command": "docker ps",
                "risk": "read",
                "state": "skipped",
                "category": "internal",
                "blocked": "duplicate"
            },
            {
                "kind": "tool",
                "title": "重启 nginx",
                "command": "systemctl restart nginx",
                "risk": "write",
                "state": "skipped",
                "category": "denied",
                "blocked": "user_denied"
            },
            {
                "kind": "tool",
                "title": "改写配置",
                "remotePath": "/etc/nginx/ops.conf",
                "risk": "write",
                "state": "running",
                "category": "executed"
            }
        ]);
        let steps = checkpoint_steps(&plan.to_string());
        assert_eq!(steps[0].category, Some(StepCategory::Internal));
        assert_eq!(steps[0].blocked.as_deref(), Some("duplicate"));
        assert_eq!(steps[1].category, Some(StepCategory::Denied));
        assert_eq!(steps[1].blocked.as_deref(), Some("user_denied"));
        /*
         * 中断改写成 failed 的那一步**不继承类别**：上一次可能已经写下去了，
         * 结果未知时按真实执行保守展示，不能标成"内部调整"藏起来。
         */
        assert_eq!(steps[2].state, "failed");
        assert_eq!(steps[2].category, None);
        assert_eq!(steps[2].blocked, None);
    }
}
