//! 极核的**只读工具调用循环**。
//!
//! 模型不再只说人话：它可以提出 `<tool name="…">{参数}</tool>`，由这里**校验
//! 参数、映射成固定命令、在当前 SSH 会话上执行**，再把结果回给模型继续判断。
//!
//! ## 为什么不让模型直接写 shell
//!
//! "模型的自由文本不能直接执行"是硬约束。这里的做法是**白名单 + 参数校验**：
//! * 工具名必须命中 `build_command` 的分支，否则直接报错；
//! * 路径必须绝对路径，禁止 `..`、`;`、`|`、反引号、`$(`；
//! * 过滤词只允许字母数字与 `- _ . /`；
//! * 单引号转义后才拼进命令。
//!
//! 写操作（部署、重启、改配置）**不在这里**：它们走现有的计划 + 确认流程。

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::deployment::ai::OpenAiCompatibleAdvisor;
use crate::ops_error::{OpsError, OpsResult};
use crate::state::AppState;

/// 一次工具执行记录，界面展开时看这些。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRun {
    /// 工具名（`ports` / `logs` / `nginx` …）。
    pub tool: String,
    /// 模型给的参数原文，便于排查"它到底查了什么"。
    pub args: serde_json::Value,
    /// 实际执行的命令（已校验、已转义）。
    pub command: String,
    pub exit_code: Option<u32>,
    /// 输出（超过 4000 字符会截断）。
    pub output: String,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReply {
    pub content: String,
    pub model: String,
    pub tools: Vec<ToolRun>,
    /// 是否因为轮数上限而停止（false 表示模型自己收尾了）。
    pub hit_round_limit: bool,
}

/// 一轮对话消息。
#[derive(Debug, serde::Deserialize)]
pub struct AgentTurn {
    pub role: String,
    pub content: String,
}

/// 单条命令的输出上限：太多会把上下文撑爆，模型也读不完。
const OUTPUT_LIMIT: usize = 4000;

/// 把 `'` 转义后包起来。
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 参数必须是**绝对路径**且不含 shell 元字符。
fn absolute_path(args: &serde_json::Value, key: &str) -> Result<String, String> {
    let value = args
        .get(key)
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim();
    if !value.starts_with('/') {
        return Err(format!("{key} 必须是绝对路径"));
    }
    if value.contains("..")
        || value.contains(';')
        || value.contains('|')
        || value.contains('`')
        || value.contains("$(")
        || value.contains('\n')
    {
        return Err(format!("{key} 含不允许的字符"));
    }
    Ok(value.to_string())
}

/// 过滤词：只允许字母数字与 `- _ . / @`。
fn simple_token(args: &serde_json::Value, key: &str) -> Result<String, String> {
    let value = args
        .get(key)
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if value
        .chars()
        .any(|c| !c.is_alphanumeric() && c != '-' && c != '_' && c != '.' && c != '/' && c != '@')
    {
        return Err(format!("{key} 含不允许的字符"));
    }
    Ok(value)
}

/// 工具名 → (命令, 超时毫秒)。**只读**命令，白名单之外一律拒绝。
fn build_command(tool: &str, args: &serde_json::Value) -> Result<(String, u64), String> {
    Ok(match tool {
        "ports" => (
            "ss -ltnp 2>/dev/null | head -n 80".to_string(),
            15_000,
        ),
        "processes" => {
            let filter = simple_token(args, "filter")?;
            (
                format!("ps aux --sort=-%cpu | grep -F {} | head -n 40", quote(&filter)),
                15_000,
            )
        }
        "containers" => (
            "docker ps -a --format '{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Ports}}' | head -n 60"
                .to_string(),
            20_000,
        ),
        "files" => (format!("ls -la {}", quote(&absolute_path(args, "path")?)), 15_000),
        "config" => (
            format!("sed -n '1,220p' {}", quote(&absolute_path(args, "path")?)),
            15_000,
        ),
        "nginx" => ("nginx -T 2>&1 | head -n 500".to_string(), 25_000),
        "logs" => {
            let unit = simple_token(args, "unit")?;
            if unit.is_empty() {
                return Err("logs 需要 unit（systemd 单元名）".to_string());
            }
            // `since` 只允许日志过滤里常见的字符，不能塞 shell 片段。
            let since = args
                .get("since")
                .and_then(|item| item.as_str())
                .unwrap_or("1 day ago")
                .trim()
                .to_string();
            if since
                .chars()
                .any(|c| !c.is_alphanumeric() && c != ' ' && c != ':' && c != '-' && c != '/' && c != '.')
            {
                return Err("since 含不允许的字符".to_string());
            }
            (
                format!(
                    "journalctl -u {} --since {} -n 120 --no-pager 2>&1",
                    quote(&unit),
                    quote(&since)
                ),
                25_000,
            )
        }
        "dns" => {
            let name = simple_token(args, "name")?;
            if name.is_empty() || !name.contains('.') {
                return Err("dns 需要 name（域名）".to_string());
            }
            (format!("dig +short {} 2>/dev/null | head -n 20", quote(&name)), 12_000)
        }
        "http" => {
            let url = args.get("url").and_then(|item| item.as_str()).unwrap_or("").trim().to_string();
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("http 需要 http(s) URL".to_string());
            }
            if url.chars().any(|c| c.is_whitespace() || c == ';' || c == '|' || c == '`' || c == '\'') {
                return Err("url 含不允许的字符".to_string());
            }
            (
                format!(
                    "curl -sS -m 10 -o /dev/null -w '%{{http_code}} %{{time_total}}s\\n' {}",
                    quote(&url)
                ),
                15_000,
            )
        }
        /*
         * 删除前留下的备份（`.bls-bak-<时间戳>`，见前端 `permissions.ts`）。
         *
         * `backups` 只读；`purge_backups` 会真的删文件 —— 但它**只匹配带标记的
         * 备份**，碰不到用户自己的文件。这条路是用户显式要求"让 AI 把备份全删了"
         * 才存在的，所以标记就是安全边界。
         */
        "backups" => (
            format!(
                "find {} -type f -name '*.bls-bak-*' 2>/dev/null | head -n 200",
                quote(&absolute_path(args, "path")?)
            ),
            20_000,
        ),
        "purge_backups" => (
            format!(
                "find {} -type f -name '*.bls-bak-*' -delete 2>/dev/null; echo done",
                quote(&absolute_path(args, "path")?)
            ),
            30_000,
        ),
        other => return Err(format!("未知工具：{other}")),
    })
}

/// 从模型输出里解出第一条工具调用。
fn parse_tool_call(text: &str) -> Option<(String, serde_json::Value)> {
    let tag = text.find("<tool")?;
    let name_at = text[tag..].find("name=\"")? + tag + 6;
    let name_end = text[name_at..].find('"')? + name_at;
    let body_at = text[name_end..].find('>')? + name_end + 1;
    let body_end = text[body_at..].find("</tool>")? + body_at;
    let name = text[name_at..name_end].trim().to_string();
    if name.is_empty() {
        return None;
    }
    let raw = text[body_at..body_end].trim();
    let args = if raw.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(raw).ok()?
    };
    Some((name, args))
}

/// 给模型的工具说明（拼在 system prompt 后面）。
pub const TOOL_PROMPT: &str = r#"
你可以调用**只读**工具去实际查看服务器。需要时输出一行：

<tool name="工具名">{"参数":"值"}</tool>

可用工具：
- ports                         监听端口（ss -ltnp）
- processes  {"filter":"nginx"} 进程（按关键字过滤）
- containers                    容器列表（含状态与端口）
- files      {"path":"/var/www"}目录元信息
- config     {"path":"/etc/nginx/nginx.conf"}  读取配置前 220 行
- nginx                         nginx 完整配置（nginx -T，include 已展开）
- logs       {"unit":"nginx","since":"yesterday"}  systemd 日志
- dns        {"name":"ops.example.com"}  A 记录
- http       {"url":"https://ops.example.com/"}  HTTP 状态码与耗时
- backups        {"path":"/绝对目录"}  列出该目录下的备份（只读）
- purge_backups  {"path":"/绝对目录"}  删除该目录下的备份（只删带 .bls-bak- 标记的文件）

规则：
1. 一次只发**一个**工具调用；收到结果后自己决定下一步或收尾。
2. 只能查，不能改；不要请求部署、重启、写文件。
3. 路径必须绝对路径。拿不到想要的线索就换一条路径（端口 → 代理 → 上游 → 日志）。
4. 结论必须来自工具输出；没有工具结果时不要声称"已检查"。
5. 最终答复简短：结论 + 关键证据 + 下一步建议。
"#;

/// 带工具循环的对话。
///
/// 最多 `max_rounds` 轮（默认 4，上限 8）；每轮一次模型调用 + 最多一次工具
/// 执行。取消令牌与流式对话共用，点「停止」会立刻打断。
#[tauri::command]
pub async fn ai_chat_agent(
    state: State<'_, AppState>,
    task_id: String,
    session_id: String,
    messages: Vec<AgentTurn>,
    max_rounds: Option<u32>,
) -> OpsResult<AgentReply> {
    let config = {
        let conn = state
            .db
            .open()
            .map_err(|error| OpsError::from_stage("io", error))?;
        crate::db::default_provider(&conn)
            .map_err(|error| OpsError::from_stage("io", error))?
            .ok_or_else(|| "还没有配置 AI 模型".to_string())?
    };
    let model = config.model.clone();
    let api_key = crate::keyring::read_secret(&config.keyring_account())
        .map_err(|_| "这个提供方还没有保存可用的 API Key".to_string())?;
    let advisor =
        OpenAiCompatibleAdvisor::new(config, api_key).map_err(|error| error.user_message())?;

    let mut conversation: Vec<serde_json::Value> = messages
        .into_iter()
        .map(|turn| serde_json::json!({ "role": turn.role, "content": turn.content }))
        .collect();
    let cancel = state.ai_reviews.register(&task_id);
    let rounds = max_rounds.unwrap_or(4).clamp(1, 8);
    let mut tools: Vec<ToolRun> = Vec::new();
    let mut hit_round_limit = true;

    let outcome: Result<String, String> = async {
        for _ in 0..rounds {
            let reply = advisor
                .chat(conversation.clone(), &cancel)
                .await
                .map_err(|error| error.user_message())?;

            let Some((tool, args)) = parse_tool_call(&reply) else {
                // 没有工具调用 = 模型收尾了。
                hit_round_limit = false;
                return Ok(reply);
            };

            let (command, timeout) = match build_command(&tool, &args) {
                Ok(built) => built,
                Err(reason) => {
                    // 参数不合法：把原因回给模型，让它换一种问法，不中断任务。
                    conversation.push(serde_json::json!({ "role": "assistant", "content": reply }));
                    conversation.push(serde_json::json!({
                        "role": "user",
                        "content": format!("<tool_error>{reason}</tool_error>")
                    }));
                    continue;
                }
            };

            let started = Instant::now();
            let output = state
                .ssh
                .exec(&session_id, &command, Duration::from_millis(timeout))
                .await
                .map_err(|error| error.to_string())?;
            let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let truncated = output.stdout.chars().count() > OUTPUT_LIMIT;
            let body: String = if truncated {
                output.stdout.chars().take(OUTPUT_LIMIT).collect()
            } else {
                output.stdout.clone()
            };

            tools.push(ToolRun {
                tool: tool.clone(),
                args: args.clone(),
                command: command.clone(),
                exit_code: output.exit_code,
                output: body.clone(),
                truncated,
                elapsed_ms,
            });

            // `exit_code` 是 `Option<u32>`：命令被信号杀掉时没有退出码。
            let exit_label = output
                .exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_string());
            conversation.push(serde_json::json!({ "role": "assistant", "content": reply }));
            conversation.push(serde_json::json!({
                "role": "user",
                "content": format!(
                    "<tool_result tool=\"{tool}\" exit=\"{exit_label}\" elapsed_ms=\"{elapsed_ms}\"{}>\n{body}\n</tool_result>",
                    if truncated { " truncated=\"true\"" } else { "" }
                )
            }));
        }
        // 轮数用尽：让模型基于已有证据做一次收尾（不再给工具）。
        let closing = advisor
            .chat(
                {
                    let mut with_hint = conversation.clone();
                    with_hint.push(serde_json::json!({
                        "role": "user",
                        "content": "已达到本轮工具调用上限。请只根据上面已有的工具结果给出简短结论与下一步建议，不要再请求工具。"
                    }));
                    with_hint
                },
                &cancel,
            )
            .await
            .map_err(|error| error.user_message())?;
        Ok(closing)
    }
    .await;

    state.ai_reviews.forget(&task_id);
    let content = outcome.map_err(|reason| reason)?;
    Ok(AgentReply {
        content,
        model,
        tools,
        hit_round_limit,
    })
}
