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
use tauri::{AppHandle, State};

use crate::agent::{
    spawn_agent, AgentInput, AgentSnapshot, AgentStep, AgentTurn, FileChangeDetail,
    FileChangeSummary, TokenUsage,
};
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
        allow_sudo: request.allow_sudo,
        auto_approve_writes: request.auto_approve_writes,
        max_rounds: request.max_rounds,
        provider_id: request.provider_id,
        carry_steps: Vec::new(),
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
    #[serde(default)]
    pub context_budget: Option<u32>,
    #[serde(default)]
    pub allow_sudo: bool,
    #[serde(default)]
    pub auto_approve_writes: bool,
    #[serde(default)]
    pub max_rounds: Option<u32>,
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
            AgentStep {
                index: index as u32,
                call_id: format!("resume-{index}"),
                tool: if item["remotePath"].as_str().is_some() {
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
                stderr: if interrupted {
                    "上次运行在这里中断：命令可能已在服务器上执行，恢复后先核对".to_string()
                } else {
                    item["stderr"].as_str().unwrap_or("").to_string()
                },
                exit_code: item["exitCode"].as_i64().map(|code| code as i32),
                backup_path: item["backupPath"].as_str().map(str::to_string),
                rollback: item["rollback"].as_str().map(str::to_string),
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
fn resume_brief(record: &ExtremeTaskRecord, steps: &[AgentStep], cwd: &str) -> String {
    let total = steps.len();
    let done = steps
        .iter()
        .filter(|step| matches!(step.state.as_str(), "success" | "skipped"))
        .count();
    let point = steps
        .iter()
        .find(|step| matches!(step.state.as_str(), "failed" | "running" | "waiting"))
        .map(|step| format!("#{} {}", step.index + 1, resume_step_line(step)))
        .unwrap_or_else(|| "最后一步之后".to_string());
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
    if task_id.is_empty() {
        return Err(OpsError::new("config", "taskId 不能为空"));
    }
    // 先确认**当前**会话还活着：历史里的 session_id 可能早就断了。
    if !state.ssh.is_connected(&request.session_id).await {
        return Err(OpsError::new(
            "ssh",
            "SSH 会话已断开：先重新连接这台服务器，再恢复任务",
        ));
    }
    let record = load_task_record(&state, task_id)
        .map_err(|error| OpsError::new("io", error))?
        .ok_or_else(|| OpsError::new("config", "找不到这条任务的历史记录"))?;
    if record.status == "success" {
        return Err(OpsError::new("ai", "这条任务已经完成，不需要恢复"));
    }
    if let Some(handle) = state.agents.get(task_id) {
        if !handle.snapshot().terminal() {
            return Err(OpsError::new("ai", "这条任务还在执行"));
        }
    }
    let steps = checkpoint_steps(&record.plan_json);
    if steps.is_empty() {
        return Err(OpsError::new(
            "ai",
            "这条记录没有可恢复的 Agent 步骤（部署计划请从部署面板继续）",
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
        goal = "继续完成上次未完成的任务".to_string();
    }
    let server = record.server.clone();
    let brief = resume_brief(&record, &steps, &cwd);
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
        reasoning_effort: request.reasoning_effort,
        context_budget: request.context_budget,
        capability: None,
        carry_usage: None,
        allow_sudo: request.allow_sudo,
        auto_approve_writes: request.auto_approve_writes,
        max_rounds: request.max_rounds,
        carry_steps: steps,
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
pub fn agent_abandon(state: State<'_, AppState>, task_id: String) -> OpsResult<Option<AgentSnapshot>> {
    let reason = "用户强制结束了这次运行：不再等待后端确认。服务器上已经发出的命令可能仍在执行，请先核对。";
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
    Ok(state
        .changes
        .list(workspace_id.as_deref(), task_id.as_deref()))
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
    use super::checkpoint_steps;

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
    fn checkpoint_ignores_broken_json() {
        assert!(checkpoint_steps("{not json").is_empty());
        assert!(checkpoint_steps("[]").is_empty());
    }
}
