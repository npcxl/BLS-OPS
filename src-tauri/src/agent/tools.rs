//! 工具名 + 参数 → **唯一一份**命令文本。
//!
//! 这是 `safe.rs` 之外的第二个命令构造边界，理由与它不同：
//! `Capability` 是"固定动作 → 固定命令"，而 Agent 执行的是模型提出的任意
//! shell。因此这里不做白名单，而是做**风险定级 + 包装**：
//!
//! * `run_shell`   —— 原样执行，但先用 [`classify_shell`] 定级；
//! * `read_file`   —— `awk` 带行号读取，敏感文件升级为需确认；
//! * `list_dir`    —— `ls -la`；
//! * `write_file`  —— 先 `cp -a` 备份（失败即中止），再用 base64 写入，
//!                    避免内容里的引号 / 换行破坏命令。
//!
//! 所有路径都经 [`absolute_path`]（拒绝相对路径、控制字符与 `..` 段），
//! 拼进命令前一律经 [`shell_quote`]。

use std::time::Duration;

use serde_json::{json, Value};

use super::protocol::{ToolCall, ToolRisk, MAX_COMMAND_SECONDS};
use crate::safe::shell_quote;

/// 命令尾部回读 cwd 的标记（前端会把它从输出里去掉）。
pub const PWD_MARKER: &str = "__BLS_PWD__";
/// `cd` 失败（目录已被删 / 无权限）。
pub const PWD_FAIL_MARKER: &str = "__BLS_CWD_FAIL__";
/// 写入前落下的备份路径。
pub const BACKUP_MARKER: &str = "__BLS_BACKUP__";
/// 备份失败：此时**不能**写入。
pub const BACKUP_FAIL_MARKER: &str = "__BLS_BACKUP_FAIL__";
/// 写入完成。
pub const WROTE_MARKER: &str = "__BLS_WROTE__";

/// 单文件写入的内容上限（base64 后约 175 KiB，远低于 sshd 的命令长度限制）。
const MAX_WRITE_BYTES: usize = 128 * 1024;

/// 备份文件后缀（与前端 `remote-write.ts` / `permissions.ts` 一致）。
pub const BACKUP_MARK: &str = ".bls-bak.";

/// 一条命令里最多采集几个写目标。
///
/// 一次 `cat > Dockerfile <<EOF … cat > compose.yaml <<EOF …` 常写 3~8 个文件；
/// 每个目标要两次 SSH 回读（前后各一次），封顶避免一条命令拖出几十次往返。
const MAX_SHELL_TARGETS: usize = 8;

/// 写前备份计划。路径可测（`stamp` 由调用方传入）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupPlan {
    pub path: String,
    pub command: String,
    pub rollback: String,
}

/// 备份策略（权限页里的两个开关 + 保留期限）。
///
/// 由 `runner` 在每次工具调用前从 `AgentInput` 传入；`plan_tool` 默认沿用
/// 旧行为（修改前备份、删除前备份、保留 30 天），测试与旧调用点无需改签名。
#[derive(Debug, Clone, Copy)]
pub struct BackupPolicy {
    pub before_write: bool,
    pub before_delete: bool,
    pub retention_days: u32,
}

impl Default for BackupPolicy {
    fn default() -> Self {
        Self {
            before_write: true,
            before_delete: true,
            retention_days: 30,
        }
    }
}

/// 这条命令里有没有"删除文件 / 目录"的动作。
///
/// 只用于选择策略与判断"必须备份成功才能继续"：`rm` / `rmdir` / `shred`
/// 与 `find … -delete` 都算删除。解析不了（引号不闭合）时按删除处理。
pub fn shell_has_delete(command: &str) -> bool {
    let segments = split_command_segments(command);
    segments.iter().any(|segment| {
        let first = segment
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(|c| c == '\'' || c == '"');
        matches!(first, "rm" | "rmdir" | "shred" | "truncate" | "mv")
            || segment.contains(" -delete")
            || segment.contains(" -exec rm")
    })
}

/// 生成备份计划（与前端 `planWriteBackup` 同一命名规则）。
pub fn plan_write_backup(target: &str, stamp: u64) -> BackupPlan {
    let path = format!("{target}{BACKUP_MARK}{stamp}");
    BackupPlan {
        command: format!("cp -a {} {}", shell_quote(target), shell_quote(&path)),
        rollback: format!("cp -a {} {}", shell_quote(&path), shell_quote(target)),
        path,
    }
}

/// 清理同目录下过期的本应用备份；`retention_days = 0` 表示永久保留。
///
/// 只删 `*.bls-bak.*` 且只清一层目录：用户自己的 `.bak` / `.old` 永远不碰。
fn backup_cleanup_command(target: &str, retention_days: u32) -> Option<String> {
    if retention_days == 0 {
        return None;
    }
    let (dir, base) = target
        .rsplit_once('/')
        .map(|(dir, base)| (if dir.is_empty() { "/" } else { dir }, base))
        .unwrap_or((".", target));
    Some(format!(
        "find {} -maxdepth 1 -type f -name {} -mtime +{} -delete 2>/dev/null || true",
        shell_quote(dir),
        shell_quote(&format!("{base}{BACKUP_MARK}*")),
        retention_days
    ))
}

/// 删除 / 覆盖前的备份脚本：先逐个 `cp -a`，任何一个失败都 `exit 97`。
///
/// 标记行由现有的 `strip_markers` 解析：界面据此显示「已备份」并给出路径。
fn shell_backup_script(targets: &[String], stamp: u64, retention_days: u32) -> String {
    let mut script = String::from("__bls_bfail=0\n");
    for target in targets {
        let backup = format!("{target}{BACKUP_MARK}{stamp}");
        script.push_str(&format!(
            "if [ -e {target} ]; then\n\
             \x20 if cp -a {target} {backup}; then printf '\\n{marker}%s\\n' {backup}; \
             else printf '\\n{fail}\\n'; __bls_bfail=1; fi\n\
             fi\n",
            target = shell_quote(target),
            backup = shell_quote(&backup),
            marker = BACKUP_MARKER,
            fail = BACKUP_FAIL_MARKER,
        ));
    }
    script.push_str(
        "if [ \"$__bls_bfail\" -ne 0 ]; then \
         echo '备份失败，已取消执行（没有改动原文件）' >&2; exit 97; fi\n",
    );
    if retention_days > 0 {
        let mut seen = std::collections::HashSet::new();
        for target in targets {
            if let Some(cleanup) = backup_cleanup_command(target, retention_days) {
                if seen.insert(cleanup.clone()) {
                    script.push_str(&cleanup);
                    script.push('\n');
                }
            }
        }
    }
    script
}

/// 给模型的原生工具定义（OpenAI `tools` 格式）。
///
/// 有了它就不再依赖"模型肯不肯按我们的 `<tool>` 文本格式说话"：不支持/不遵守
/// 文本协议的模型会走 `tool_calls` 返回结构化调用。文本协议保留为兜底。
/// 本轮勾选了哪些内置能力；`None` = 旧客户端，全部放行。
///
/// 能力与工具是粗粒度映射：远程文件控制读写/解压；其余运维技能共用
/// `run_shell`（细分到"查日志还是看 Docker"由模型与权限决定，不能靠工具名区分）。
pub fn builtin_tool_allowed(name: &str, builtins: Option<&[String]>) -> bool {
    let Some(list) = builtins else {
        return true;
    };
    let has = |id: &str| list.iter().any(|item| item == id);
    match name {
        "run_shell" | "shell" => ["inspect", "logs", "docker", "nginx", "systemd", "dns", "database"]
            .iter()
            .any(|id| has(id)),
        "read_file" | "list_dir" | "write_file" | "unarchive" => has("files"),
        _ => true,
    }
}

/// 按本轮勾选过滤内置工具 schema（MCP 工具不动，它们有独立的启用状态）。
pub fn filter_tool_schemas(mut schemas: Value, builtins: Option<&[String]>) -> Value {
    if let Value::Array(items) = &mut schemas {
        items.retain(|item| {
            item.pointer("/function/name")
                .and_then(Value::as_str)
                .map(|name| builtin_tool_allowed(name, builtins))
                .unwrap_or(true)
        });
    }
    schemas
}

pub fn tool_schemas(plan_required: bool) -> Value {
    let path = |description: &str| {
        json!({
            "type": "string",
            "description": description
        })
    };
    let mut tools = json!([
        {
            "type": "function",
            "function": {
                "name": "run_shell",
                "description": "在一台 Linux 服务器上执行一条 shell 命令。只读命令（ls/cat/grep/ps/df/docker ps/systemctl status 等）直接执行；修改类命令（rm/mv/cp/tee/systemctl restart/docker compose up 等）与危险命令（sudo/mkfs/iptables/写 /etc 等）在普通权限下逐条确认、完全权限下直接执行；只查询的任务里写操作会被执行器拦下。命令结束后会自动回读当前目录。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "要执行的完整命令（可以用 ; && || 串起来）" },
                        "cwd": path("可选：在哪个绝对路径下执行，默认沿用任务当前目录")
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取服务器上的一个文本文件，返回带行号的内容。敏感文件（/etc/shadow、私钥、.env 等）在普通权限下需要用户确认。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": path("文件的绝对路径"),
                        "offset": { "type": "integer", "description": "起始行号（从 1 开始，默认 1）" },
                        "limit": { "type": "integer", "description": "最多读取多少行（默认 300，上限 2000）" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "列出一个目录的内容（ls -la，含隐藏文件与权限）。",
                "parameters": {
                    "type": "object",
                    "properties": { "path": path("目录的绝对路径") },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "写入或覆盖一个文本文件。**必须先备份**：自动在同目录留一份带 .bls-bak. 标记的副本，返回备份路径供回滚。每次写入都要用户确认。内容上限 128 KB。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": path("目标文件的绝对路径"),
                        "content": { "type": "string", "description": "完整的文件内容（覆盖写，不是追加）" }
                    },
                    "required": ["path", "content"]
                }
            }
        }
    ]);

    /*
     * `ask_user` 是控制工具：让用户在单选 / 多选里做决定，不执行命令、不占步骤。
     * 放在 `step` 注入之后，避免被要求带计划步骤。
     */
    if let Some(list) = tools.as_array_mut() {
        let at = if plan_required { 1 } else { 0 };
        list.insert(
            at,
            json!({
                "type": "function",
                "function": {
                    "name": "ask_user",
                    "description": "向用户提出一个需要决定的问题，并暂停当前任务等待回答。当缺少关键选择、前提需要用户确认、或不同方案需要用户拍板时使用；不要用普通正文假装提问。任务会一直等到用户提交选择后继续。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "question": { "type": "string", "description": "要问用户的问题，一句话说清楚需要决定什么" },
                            "kind": {
                                "type": "string",
                                "enum": ["single", "multi"],
                                "description": "single=单选；multi=多选"
                            },
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "稳定选项 id，回答时回传" },
                                        "label": { "type": "string", "description": "用户看到的选项名称" }
                                    },
                                    "required": ["id", "label"]
                                },
                                "description": "预设选项；仅允许自定义时可留空"
                            },
                            "allowCustom": {
                                "type": "boolean",
                                "description": "是否允许用户填写预设选项之外的内容"
                            }
                        },
                        "required": ["question", "kind", "options", "allowCustom"]
                    }
                }
            }),
        );
    }

    if plan_required {
        /*
         * 强制计划：每个工具都必须声明它属于哪一步；`submit_plan` 放在最前面，
         * 模型第一眼就能看到"先提交计划"。
         */
        if let Some(list) = tools.as_array_mut() {
            for tool in list.iter_mut() {
                // 控制工具不属于计划步骤，不注入 step。
                if tool.pointer("/function/name").and_then(Value::as_str) == Some("ask_user") {
                    continue;
                }
                let params = &mut tool["function"]["parameters"];
                params["properties"]["step"] = json!({
                    "type": "string",
                    "description": "这一步属于计划的哪一步（必填，值为 submit_plan 里的步骤 id）"
                });
                if let Some(required) = params["required"].as_array_mut() {
                    required.push(json!("step"));
                }
            }
            list.insert(
                0,
                json!({
                    "type": "function",
                    "function": {
                        "name": "submit_plan",
                        "description": "提交或更新本轮执行计划。必须在第一次调用其他工具之前调用；探查后可以再次提交以充实计划，已完成的步骤会保留。计划步骤只登记计划，不授予执行权限，也不会额外弹确认。",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "understanding": { "type": "string", "description": "一句话复述任务理解" },
                                "summary": { "type": "string", "description": "行动摘要（计划卡副标题）" },
                                "prerequisites": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "需要用户确认的前提（只展示，不额外弹确认）"
                                },
                                "steps": {
                                    "type": "array",
                                    "minItems": 1,
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "id": { "type": "string", "description": "稳定 id，例如 s1" },
                                            "title": { "type": "string", "description": "用户能看懂的一步标题" },
                                            "action": { "type": "string", "description": "预期动作：要看什么 / 要改什么" },
                                            "verify": { "type": "string", "description": "验证条件：怎样算这一步完成" },
                                            "kind": {
                                                "type": "string",
                                                "enum": ["probe", "action", "answer"],
                                                "description": "probe=只读探查；action=会改服务器；answer=纯聊天的一步回答"
                                            }
                                        },
                                        "required": ["id", "title", "action", "verify"]
                                    }
                                }
                            },
                            "required": ["steps"]
                        }
                    }
                }),
            );
        }
    }
    tools
}

/// 一条已规划好的工具执行。
#[derive(Debug, Clone)]
pub struct PlannedTool {
    pub call: ToolCall,
    /// 实际发给 SSH 的完整脚本（含 `cd` 包装、退出码回传与内部标记）。
    ///
    /// **只用于执行与调试**：确认卡首屏显示的是 `display` + `summary`。
    pub command: String,
    /// 用户可读的命令（模型给的那一条，没有 `cd` 包装和内部标记）。
    pub display: String,
    /// 一句话操作摘要（确认卡首屏第一行，例如「更新 Nginx 配置」）。
    pub summary: Option<String>,
    pub timeout: Duration,
    /// 涉及的文件（前端生成标题、确认框展示）。
    pub path: Option<String>,
    /// 危险操作的影响说明。
    pub impact: Option<String>,
    /// 有备份时的回滚命令。
    pub rollback: Option<String>,
    /// `write_file` 覆盖已有文件时预期的备份路径。
    pub backup_path: Option<String>,
    /// `write_file` 这次明确提交的完整新内容（变更记录的 `proposedAfter`）。
    ///
    /// 只用于生成预览与 Diff；命令体另行 base64 编码，两者来自同一份参数。
    pub write_content: Option<String>,
    /// MCP 工具绑定：有值时执行走 MCP 客户端，而不是 SSH 命令。
    pub mcp: Option<crate::mcp::McpBinding>,
}

fn string_arg(args: &Value, key: &str) -> Result<String, String> {
    match args.get(key) {
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err(format!("{key} 必须是字符串")),
        None => Err(format!("缺少参数 {key}")),
    }
}

/// 绝对路径 + 无控制字符 + 无 `..` 段。允许空格（拼命令前会转义）。
pub fn absolute_path(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    if !value.starts_with('/') {
        return Err(format!("{field} 必须是绝对路径"));
    }
    if value.contains('\0') || value.chars().any(char::is_control) {
        return Err(format!("{field} 不能包含控制字符"));
    }
    if value
        .split('/')
        .any(|segment| segment == ".." || segment == ".")
    {
        return Err(format!("{field} 不能包含 . 或 .. 路径段"));
    }
    if value.len() > 4096 {
        return Err(format!("{field} 过长"));
    }
    Ok(value.to_string())
}

/// 读取可能含凭据的文件：读也要先让用户确认。
pub fn is_sensitive_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with("/etc/shadow")
        || lower.starts_with("/etc/gshadow")
        || lower.starts_with("/etc/ssl/private")
        || lower.starts_with("/root/.ssh")
        || lower.contains("/.ssh/id_")
        || lower.ends_with("id_rsa")
        || lower.ends_with("id_ed25519")
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.contains("/.env")
        || lower.ends_with("/.env")
}

/// 系统目录：写这里的风险更高（会改变机器行为，而不只是业务文件）。
pub fn is_system_path(path: &str) -> bool {
    ["/etc/", "/boot/", "/usr/", "/lib/", "/bin/", "/sbin/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
        || path == "/etc"
}

/// 命令里出现 sudo（默认禁用，需用户显式允许）。
///
/// 只认**命令位置**上的 sudo：`grep sudo /var/log/auth.log` 是在查日志，
/// 不是在提权。
pub fn has_sudo(command: &str) -> bool {
    command
        .split(['\n', ';', '|', '&'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .any(|segment| {
            segment
                .split_whitespace()
                .find(|token| !token.contains('='))
                // 段首残留引号：`'sudo apt …` 也是提权，不能因为多了个引号就放过。
                .map(|token| token.trim_start_matches(['\'', '"', '\\']))
                == Some("sudo")
        })
}

/// 按**未加引号**的 `;`、换行、管道与 `&` 拆成独立命令段。
///
/// 三件事必须分清，否则只读命令会被误判成写入：
/// * 引号里的分隔符是普通字符：`grep "a|b" file` 是一条命令，不是两条；
/// * `2>&1` / `>&2` 里的 `&` 是**文件描述符复制**，不是"后台执行"；
/// * `&>file` 是 bash 的写文件重定向，也不是分隔符（后面的 `>` 会按重定向判）。
///
/// 返回 `None` 表示**解析不确定**（引号没闭合、结尾是裸反斜杠）。调用方必须
/// 按"需要确认"处理 —— 看不懂的命令绝不能被当成只读自动执行。
fn split_segments(command: &str) -> Option<Vec<String>> {
    let mut segments: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut quote: Option<char> = None;

    while let Some(ch) = chars.next() {
        if let Some(active) = quote {
            current.push(ch);
            // 双引号里 `\"` 是转义；单引号里没有转义，反斜杠是普通字符。
            if active == '"' && ch == '\\' {
                current.push(chars.next()?);
            } else if ch == active {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                current.push(ch);
            }
            '\\' => {
                current.push(ch);
                current.push(chars.next()?);
            }
            ';' | '\n' | '|' => push_segment(&mut segments, &mut current),
            '&' => {
                // `2>&1`：`&` 紧跟在 `>` 后面；`&>file`：`&` 后面紧跟 `>`。
                let fd_redirect = current.trim_end().ends_with('>') || chars.peek() == Some(&'>');
                if fd_redirect {
                    current.push('&');
                } else {
                    push_segment(&mut segments, &mut current);
                }
            }
            _ => current.push(ch),
        }
    }

    if quote.is_some() {
        return None;
    }
    push_segment(&mut segments, &mut current);
    Some(segments)
}

fn push_segment(out: &mut Vec<String>, current: &mut String) {
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        out.push(trimmed.to_string());
    }
    current.clear();
}

/// 去掉 `FOO=bar` 这类前置环境变量赋值，并剥掉词首引号 / 反斜杠。
///
/// 最后这一步是必须的：`sh -c '…sed 's/a/b/' …'` 这种**单引号内再出现单引号**的
/// 命令，切段后段首会残留一个 `'`，`first_word` 就成了 `'grep` —— 只读白名单
/// 全部失配，整条命令被当成"不认识的写操作"，再叠上 /etc 规则就成了
/// 「危险 · 修改系统配置」。命令是模型拼的，这种引号残留很常见。
fn first_word(segment: &str) -> &str {
    segment
        .split_whitespace()
        .find(|token| !token.contains('='))
        .map(|token| token.trim_start_matches(['\'', '"', '\\']))
        .unwrap_or("")
}

/// 取第一个词，返回 `(词, 剩下的原文)`。原文要保持原样（引号、空格都要留着，
/// 后面要按引号取 `sh -c '…'` 的正文）。
fn take_word(text: &str) -> (&str, &str) {
    let trimmed = text.trim_start();
    match trimmed.find(char::is_whitespace) {
        Some(at) => (&trimmed[..at], &trimmed[at..]),
        None => (trimmed, ""),
    }
}

/// 去掉包在整段外面的一层引号（`'…'` / `"…"`）。
fn unquote(text: &str) -> String {
    let trimmed = text.trim();
    for quote in ['\'', '"'] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn is_shell_word(word: &str) -> bool {
    matches!(
        word,
        "sh" | "bash" | "ash" | "dash" | "zsh" | "/bin/sh" | "/bin/bash" | "/bin/ash" | "/bin/dash"
    )
}

/* ------------------------------------------------------------------------- *
 * 归档操作：结构化身份
 *
 * 审批去重不能靠"去掉参数再小写"的文本：Linux 路径区分大小写，`unzip` 的
 * `-o` / `-n` 是不同覆盖策略，`cd a && unzip x` 与绝对路径是同一件事。
 * 这里只解析**能确定含义**的简单命令；变量、通配符、复合命令一律返回 None，
 * 由调用方退回"不猜等价"的保守路径。
 * ------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveOverwrite {
    /// 没写 `-o` / `-n`：unzip 遇到同名文件会询问，非交互环境可能失败。
    Interactive,
    /// `unzip -o` / tar 默认：覆盖同名文件。
    Always,
    /// `unzip -n` / tar -k：不覆盖。
    Never,
}

impl ArchiveOverwrite {
    fn as_str(self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::Always => "always",
            Self::Never => "never",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Interactive => "未指定（遇到同名文件会询问）",
            Self::Always => "覆盖同名文件",
            Self::Never => "不覆盖已有文件",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveOperation {
    /// 规范化后的归档绝对路径（词法规范化，不访问服务器）。
    pub archive: String,
    /// 解压目标；查看归档时为 None。
    pub target: Option<String>,
    pub overwrite: ArchiveOverwrite,
    /// `unzip -l/-t/-p`、`tar -t`：只读。
    pub listing: bool,
}

impl ArchiveOperation {
    pub fn summary(&self) -> String {
        match (&self.target, self.listing) {
            (_, true) => format!("查看归档 {} 的内容", self.archive),
            (Some(target), false) => format!("将 {} 解压到 {}", self.archive, target),
            (None, false) => format!("将 {} 解压到当前目录", self.archive),
        }
    }

    pub fn impact(&self) -> String {
        if self.listing {
            return "只读取归档目录，不会写入服务器".to_string();
        }
        let overwrite = match self.overwrite {
            ArchiveOverwrite::Always => "会覆盖目标目录中的同名文件",
            ArchiveOverwrite::Never => "不会覆盖已有文件",
            ArchiveOverwrite::Interactive => {
                "未指定 -o / -n：遇到同名文件时 unzip 会等待输入，非交互环境可能失败"
            }
        };
        match &self.target {
            Some(target) => format!("{overwrite}；写入范围：{target}"),
            None => overwrite.to_string(),
        }
    }

    /// 审批身份：路径保持大小写，覆盖策略单独参与比较。
    pub fn signature(&self) -> String {
        if self.listing {
            return format!("archive-list\u{1}{}", self.archive);
        }
        format!(
            "archive-extract\u{1}{}\u{1}{}\u{1}{}",
            self.archive,
            self.target.as_deref().unwrap_or(""),
            self.overwrite.as_str()
        )
    }
}

/// 只接受可确定含义的 shell 词：变量、命令替换、通配符一律拒绝。
fn shell_words(text: &str) -> Option<Vec<String>> {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in text.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if let Some(active) = quote {
            if active == '"' && ch == '\\' {
                escaped = true;
            } else if ch == active {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            '\\' => escaped = true,
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            '$' | '`' | '*' | '?' | '[' | ']' | '~' | '<' | '>' | ';' | '|' | '&' => {
                return None;
            }
            _ => current.push(ch),
        }
    }
    if quote.is_some() || escaped {
        return None;
    }
    if !current.is_empty() {
        words.push(current);
    }
    Some(words)
}

fn normalize_abs(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    Some(format!("/{}", parts.join("/")))
}

fn resolve_archive_path(value: &str, cwd: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let joined = if value.starts_with('/') {
        value.to_string()
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), value)
    };
    normalize_abs(&joined)
}

fn base_command(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

/// 解析 `unzip` / `tar` 的简单归档操作；无法确定时返回 None。
///
/// 支持 `cd /dir && unzip ...`（只允许一个裸 `cd` 前缀）。不支持管道、变量、
/// 通配符、多个归档或额外 shell 复合命令。
pub fn parse_archive_operation(command: &str, cwd: &str) -> Option<ArchiveOperation> {
    let segments = split_segments(command)?;
    if segments.is_empty() || segments.len() > 2 {
        return None;
    }
    let (base_cwd, body) = match segments.as_slice() {
        [only] => (cwd.to_string(), only.as_str()),
        [cd, body] => {
            let words = shell_words(cd)?;
            if words.first().map(String::as_str) != Some("cd") {
                return None;
            }
            let path = match words.as_slice() {
                [_, path] => path,
                [_, flag, path] if flag == "--" => path,
                _ => return None,
            };
            (resolve_archive_path(path, cwd)?, body.as_str())
        }
        _ => return None,
    };
    let words = shell_words(body)?;
    let tool = base_command(words.first()?.as_str());
    let mut archive: Option<String> = None;
    let mut target: Option<String> = None;
    let mut overwrite = ArchiveOverwrite::Interactive;
    let mut listing = false;

    let mut index = 1usize;
    while index < words.len() {
        let word = &words[index];
        if word == "--" {
            index += 1;
            continue;
        }
        if word.starts_with('-') && word.len() > 1 {
            if tool == "unzip" {
                let flags = word.trim_start_matches('-');
                if flags == "d" {
                    index += 1;
                    target = Some(words.get(index)?.clone());
                    index += 1;
                    continue;
                }
                for flag in flags.chars() {
                    match flag {
                        'l' | 't' | 'p' => listing = true,
                        'o' => overwrite = ArchiveOverwrite::Always,
                        'n' => overwrite = ArchiveOverwrite::Never,
                        // 静默 / 保留目录 / 编码等不改变"删改什么"。
                        'q' | 'j' | 'a' | 'C' | 'L' | 'X' | 'K' | 'U' => {}
                        _ => return None,
                    }
                }
                index += 1;
                continue;
            }
            if tool == "tar" {
                let flags = word.trim_start_matches('-');
                if flags == "C" || word == "--directory" {
                    index += 1;
                    target = Some(words.get(index)?.clone());
                    index += 1;
                    continue;
                }
                if word == "--list" {
                    listing = true;
                    index += 1;
                    continue;
                }
                if word == "--extract" || word == "--get" {
                    index += 1;
                    continue;
                }
                if word == "--keep-old-files" {
                    overwrite = ArchiveOverwrite::Never;
                    index += 1;
                    continue;
                }
                if word == "--overwrite" {
                    overwrite = ArchiveOverwrite::Always;
                    index += 1;
                    continue;
                }
                let mut saw_file = false;
                for flag in flags.chars() {
                    match flag {
                        't' => listing = true,
                        'x' => {}
                        'f' => saw_file = true,
                        'z' | 'j' | 'J' | 'v' | 'p' | 'P' | 'o' => {}
                        'k' => overwrite = ArchiveOverwrite::Never,
                        _ => return None,
                    }
                }
                index += 1;
                if saw_file {
                    archive = Some(words.get(index)?.clone());
                    index += 1;
                }
                continue;
            }
            return None;
        }
        if archive.is_none() {
            archive = Some(word.clone());
            index += 1;
            continue;
        }
        // 归档后面还有额外的成员 / 排除模式：不做等价推断。
        return None;
    }

    let archive = resolve_archive_path(archive.as_deref()?, &base_cwd)?;
    if listing {
        return Some(ArchiveOperation {
            archive,
            target: None,
            overwrite,
            listing: true,
        });
    }
    let target = match target {
        Some(value) => resolve_archive_path(&value, &base_cwd)?,
        None => base_cwd,
    };
    // tar 默认覆盖；unzip 只有显式 -o 才是确定覆盖。
    if tool == "tar" && overwrite == ArchiveOverwrite::Interactive {
        overwrite = ArchiveOverwrite::Always;
    }
    Some(ArchiveOperation {
        archive,
        target: Some(target),
        overwrite,
        listing: false,
    })
}

/// 只读的归档查看命令（`unzip -l/-t`、`tar -t`）。
pub fn archive_list_only(command: &str) -> bool {
    parse_archive_operation(command, "/")
        .map(|op| op.listing)
        .unwrap_or(false)
}

/// `docker exec <容器> <命令…>` 里**真正在做事**的那条命令。
///
/// `docker exec` 本身只是"进容器跑一条命令"，改不改服务器取决于里面那条：
/// `docker exec web sh -c 'grep -n foo /etc/nginx/nginx.conf'` 是纯读，
/// `docker exec web sed -i …` 才是写。返回 `None` = 没给命令（交互式 shell）
/// 或这条不是 `docker exec`，交给后面的规则按"要确认"处理。
fn docker_exec_inner(segment: &str) -> Option<String> {
    let (first, rest) = take_word(segment);
    if !first.eq_ignore_ascii_case("docker") {
        return None;
    }
    let (second, mut rest) = take_word(rest);
    if !second.eq_ignore_ascii_case("exec") {
        return None;
    }

    // 选项都在容器名之前；带值的选项（`-u root` / `--env A=1`）要多跳一个词。
    loop {
        let (word, left) = take_word(rest);
        if word.is_empty() {
            return None;
        }
        if !word.starts_with('-') {
            break;
        }
        rest = left;
        if matches!(
            word,
            "-u" | "--user" | "-e" | "--env" | "-w" | "--workdir" | "--detach-keys"
        ) {
            let (_value, left) = take_word(rest);
            rest = left;
        }
    }

    // 容器名之后就是要跑的命令。
    let (container, left) = take_word(rest);
    if container.is_empty() {
        return None;
    }
    let inner = left.trim();
    if inner.is_empty() {
        return None;
    }

    // `sh -c '<正文>'`：取引号里的正文（切段时引号是保留的）。
    let (shell, after_shell) = take_word(inner);
    if is_shell_word(shell) {
        let (flag, payload) = take_word(after_shell);
        if matches!(flag, "-c" | "-lc" | "-ic") {
            let payload = payload.trim();
            return if payload.is_empty() {
                None
            } else {
                Some(unquote(payload))
            };
        }
        // 交互式 shell：等于"没给命令"，不猜。
        return None;
    }
    Some(inner.to_string())
}

/// 去掉只起语法作用的开头，返回**真正要执行**的那一段。
///
/// `for h in a b c; do …; done` 里的 `for` / `do` / `done` 都不是可执行文件：
/// 按"未知命令"处理会把一条纯读的循环说成"影响未知"（用户看到的
/// 「执行 for · 影响未知」就是这么来的）。返回 `None` = 整段只是语法。
fn strip_syntax(segment: &str) -> Option<&str> {
    let mut rest = segment.trim();
    loop {
        // `!` / `(` / `{` 是前缀，不是命令名。
        let bare = rest.trim_start_matches(['!', '(', '{']).trim_start();
        if bare.len() != rest.len() {
            rest = bare;
            if rest.is_empty() {
                return None;
            }
        }
        let (word, left) = take_word(rest);
        if word.is_empty() {
            return None;
        }
        let tail = left.trim();
        match word {
            // 结句关键字：后面没东西 = 纯语法（`done` / `fi` / `esac`）。
            "done" | "fi" | "esac" | "}" | ")" | ";;" => {
                if tail.is_empty() {
                    return None;
                }
                rest = tail;
            }
            // 引导关键字：跳过它，看后面真正跑的那条。
            "do" | "then" | "else" | "elif" | "time" => {
                if tail.is_empty() {
                    return None;
                }
                rest = tail;
            }
            // 循环头本身不执行命令（`for x in a b c` / `for ((…))`）。
            "for" | "select" => return None,
            // `while <条件>` / `until <条件>` / `if <条件>`：条件就是命令。
            "while" | "until" | "if" => {
                if tail.is_empty() {
                    return None;
                }
                rest = tail;
            }
            _ => {
                // `< /tmp/in`：输入重定向不写任何东西，跳过它的操作数。
                if word.starts_with('<') && !word.starts_with("<(") {
                    if tail.is_empty() {
                        return None;
                    }
                    let (_, after) = take_word(tail);
                    if after.trim().is_empty() {
                        return None;
                    }
                    rest = after.trim();
                    continue;
                }
                return Some(rest);
            }
        }
    }
}

fn is_read_command(first: &str, second: &str) -> bool {
    const READ: &[&str] = &[
        "ls",
        "ll",
        // 只切换工作目录，不改变服务器状态；`cd x && docker ps` 不该被当成写。
        "cd",
        "pushd",
        "popd",
        "cat",
        "head",
        "tail",
        // 带行号打印 / 只读计算：`nl -ba $F | sed -n '1,30p'` 是最常见的"看配置"手法。
        "nl",
        "od",
        "xxd",
        "md5sum",
        "sha1sum",
        "sha256sum",
        "base64",
        "basename",
        "dirname",
        "readlink",
        "realpath",
        "diff",
        "cmp",
        "tree",
        "jq",
        "grep",
        "egrep",
        "fgrep",
        "zgrep",
        "wc",
        "file",
        "stat",
        "du",
        "df",
        "free",
        "uptime",
        "uname",
        "hostname",
        "id",
        "whoami",
        "pwd",
        "date",
        "ps",
        "pgrep",
        "ss",
        "netstat",
        "ip",
        "dig",
        "nslookup",
        "host",
        "ping",
        "curl",
        "echo",
        "printf",
        "test",
        "env",
        "printenv",
        "which",
        "type",
        "command",
        "journalctl",
        "nginx",
        "awk",
        "sed",
        "sort",
        "uniq",
        "cut",
        "tr",
        "xargs",
        "lsblk",
        "lsof",
        "iostat",
        "vmstat",
        "mpstat",
        "dmesg",
        "getent",
        "timedatectl",
        "hostnamectl",
        "find",
        "git",
        "docker",
        "systemctl",
        "service",
        "apt",
        "apt-get",
        "yum",
        "dnf",
        "rpm",
        "dpkg",
        "pip",
        "npm",
        "crontab",
        "sqlite3",
        "redis-cli",
        "mysql",
        "psql",
        // shell 内建：只判断/读取，不改变服务器上的任何东西。
        "[",
        "[[",
        "test",
        "true",
        "false",
        ":",
        "read",
        "wait",
    ];
    if !READ.contains(&first) {
        return false;
    }
    // 同一条命令里可能出现"只读子命令 + 写子命令"，写的那部分先由写规则拦下；
    // 这里额外排除几个首词是只读工具、但当前子命令会改状态的组合。
    !matches!(
        (first, second),
        ("docker", "run")
            | ("docker", "rm")
            | ("docker", "rmi")
            | ("docker", "stop")
            | ("docker", "restart")
            | ("docker", "kill")
            | ("docker", "prune")
            | ("docker", "exec")
            | ("systemctl", "daemon-reload")
    )
}

/// 单个命令段的风险。
fn classify_segment(segment: &str) -> ToolRisk {
    match strip_syntax(segment) {
        // 整段只是 shell 语法（`done` / `fi` / `for x in …`）。循环头里仍可能
        // 藏 `$(…)`：`for x in $(rm -rf /tmp/x)` 照样按写算。
        None => {
            return if has_execution_escape(&segment.to_ascii_lowercase()) {
                ToolRisk::Write
            } else {
                ToolRisk::Read
            }
        }
        // 脱掉了 `do` / `then` / `if` / `!` 这类前缀：按剩下那条命令判。
        Some(body) if body != segment.trim() => return classify_segment(body),
        Some(_) => {}
    }

    // 空白先归一化成单空格：`systemctl  restart nginx` 与 `docker compose -f x up`
    // 都要能和下面的模式对上，否则一个多余的空白就能把写操作判成只读。
    let lower: String = segment
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let words: Vec<&str> = segment.split_whitespace().collect();
    let first = first_word(segment);
    let second = words.get(1).copied().unwrap_or("");

    // ---- 只读的归档查看：`unzip -l`、`tar -tf` 不写服务器 ----
    if archive_list_only(segment) {
        return ToolRisk::Read;
    }

    /*
     * `sudo` 本身不是风险：`sudo grep` 只读、`sudo cp` 与普通 cp 一样是写。
     * 真正定级看**被 sudo 包住的那条命令**；是否允许 sudo 另由 `allow_sudo` 控制。
     */
    if first == "sudo" {
        let Some(words) = shell_words(segment) else {
            // 解析不了 sudo 包住的命令：保守按危险处理，绝不自动放行。
            return ToolRisk::Danger;
        };
        let mut index = 1usize;
        while index < words.len() && words[index].starts_with('-') {
            // `sudo -u root` / `-g group` / `-p prompt` 会吃掉下一个词。
            let takes_value = matches!(
                words[index].as_str(),
                "-u" | "-g" | "-p" | "-C" | "-h" | "-r" | "-t" | "-U"
            );
            index += 1;
            if takes_value {
                index += 1;
            }
        }
        if index >= words.len() {
            // 整段被引号包住、拆不出真实命令：保守按危险处理。
            return ToolRisk::Danger;
        }
        let Some(inner) = words.get(index..) else {
            return ToolRisk::Danger;
        };
        let inner = inner.join(" ");
        if inner.trim().is_empty() {
            return ToolRisk::Write;
        }
        return classify_segment(&inner);
    }
    // 只看命令名（第一个词），不看参数：`grep passwd /etc/passwd` 是只读的，
    // 参数里出现 "passwd" 不该升级成危险操作。
    let dangerous_first = matches!(
        first,
        "fdisk"
            | "parted"
            | "shutdown"
            | "reboot"
            | "poweroff"
            | "halt"
            | "init"
            | "iptables"
            | "ip6tables"
            | "nft"
            | "ufw"
            | "firewall-cmd"
            | "passwd"
            | "visudo"
            | "useradd"
            | "usermod"
            | "userdel"
            | "groupadd"
            | "groupdel"
            | "chpasswd"
            | "mkswap"
    ) || first.starts_with("mkfs");
    if dangerous_first {
        return ToolRisk::Danger;
    }
    /*
     * `docker exec` 按**里面那条命令**定级。
     *
     * 以前它被写死成"写"，再加上 /etc 的放大规则，`docker exec web sh -c
     * 'grep … /etc/nginx/nginx.conf'` 这种纯读的命令也会被标成"危险 · 修改
     * 系统配置"，用户每次都得点一次「允许本次」。
     */
    if let Some(inner) = docker_exec_inner(segment) {
        return classify_shell(&inner);
    }
    if first == "dd"
        && (lower.contains("of=/dev/")
            || lower.contains("if=/dev/zero")
            || lower.contains("if=/dev/urandom"))
    {
        return ToolRisk::Danger;
    }
    if lower.contains("rm -rf /") || lower.contains("rm -fr /") {
        // `rm -rf /tmp/x` 仍然危险，但 `/tmp` 属于业务范围；只把"根"与
        // 通配放大当作灾难级。
        let at = lower
            .find("rm -rf /")
            .or_else(|| lower.find("rm -fr /"))
            .unwrap_or(0);
        let rest = &lower[at + "rm -rf /".len()..];
        if rest.is_empty() || rest.starts_with(' ') || rest.starts_with('*') {
            return ToolRisk::Danger;
        }
    }
    if lower.contains("> /dev/sd") || lower.contains("of=/dev/sd") || lower.contains("> /dev/nvme")
    {
        return ToolRisk::Danger;
    }
    if lower.contains("chmod 777 /")
        || lower.contains("chown -r /")
        || lower.contains("chmod -r 777 /")
    {
        return ToolRisk::Danger;
    }
    if lower.contains("kill -9 1") || lower.contains("killall5") || lower.contains(":(){") {
        return ToolRisk::Danger;
    }

    // 读敏感文件也要确认：`cat /etc/shadow` 与 `read_file /etc/shadow` 是同一件事。
    if [
        "/etc/shadow",
        "/etc/gshadow",
        "/etc/ssl/private",
        "/.ssh/id_",
        "id_rsa",
        "id_ed25519",
        ".pem",
        "/.env",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return ToolRisk::Write;
    }

    // ---- 写：任何会改服务器状态的动词 / 重定向 ----
    //
    // 短动词（rm / cp / mkdir…）只认**命令位置**，不做整串包含：文件名或参数
    // 里出现 "rm " 不该被当成删除（例如 `systemctl status nginx.service` 里
    // 的 ".service " 曾经把只读查询误判成写）。
    const WRITE_FIRST: &[&str] = &[
        "rm", "mv", "cp", "tee", "touch", "mkdir", "rmdir", "chmod", "chown", "chgrp", "ln",
        "install", "truncate", "dd", "rsync", "scp", "unzip", "tar", "patch", "setfacl", "chattr",
        "service", "crontab", "sqlite3",
    ];
    /*
     * `/etc/` 不再一律升级成危险：那会让 `sudo sed -i` 改一个明确的应用配置
     * 每次都要额外确认。只有 SSH / 防火墙 / sudoers 这类可能失联的路径升级；
     * 其余按写入处理，完全权限下直接执行并保留备份。
     */
    let critical_config = [
        "/etc/ssh/",
        "/etc/sudoers",
        "/etc/passwd",
        "/etc/group",
        "/etc/shadow",
        "/etc/iptables",
        "/etc/nftables",
        "/etc/firewalld",
        "/etc/ufw",
        "/etc/network/",
        "/etc/systemd/network/",
        "/etc/resolv.conf",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let write_risk = if critical_config {
        ToolRisk::Danger
    } else {
        ToolRisk::Write
    };
    if WRITE_FIRST.contains(&first) {
        // 少数确实只读的子命令。
        let read_only = matches!(
            (first, second),
            ("service", "--status-all")
                | ("crontab", "-l")
                | ("tar", "-tf")
                | ("tar", "-tzf")
                | ("tar", "tf")
                | ("unzip", "-l")
                | ("sqlite3", "-readonly")
        );
        if !read_only {
            return write_risk;
        }
    }
    const WRITE_PATTERNS: &[&str] = &[
        "sed -i",
        "sed --in-place",
        "perl -i",
        "docker run",
        "docker rm",
        "docker rmi",
        "docker stop",
        "docker restart",
        "docker kill",
        "docker prune",
        "docker exec",
        "docker cp ",
        "docker compose up",
        "docker compose down",
        "docker compose restart",
        "docker compose rm",
        "docker compose pull",
        "docker compose build",
        "docker compose push",
        "docker build",
        "systemctl start",
        "systemctl stop",
        "systemctl restart",
        "systemctl reload",
        "systemctl enable",
        "systemctl disable",
        "systemctl mask",
        "systemctl unmask",
        "systemctl edit",
        "nginx -s reload",
        "nginx -s stop",
        "nginx -s quit",
        "apt install",
        "apt-get install",
        "apt remove",
        "apt-get remove",
        "apt upgrade",
        "yum install",
        "yum remove",
        "dnf install",
        "dnf remove",
        "rpm -i",
        "rpm -e",
        "dpkg -i",
        "dpkg -r",
        "pip install",
        "npm install",
        "npm i -g",
        "git pull",
        "git clone",
        "git checkout",
        "git reset",
        "git clean",
        "git commit",
        "git push",
        "crontab -e",
        "crontab -r",
        "-delete",
        "-exec rm",
        "-exec mv",
        "truncate -s",
    ];
    /*
     * `docker compose` 的子命令在参数里：`docker compose -f docker-compose.yml up -d`
     * 是运维最常用的写法，但固定串 `"docker compose up"` 会被中间的 `-f …` 绕过，
     * 整条命令落进只读白名单。按"跳过选项 + 看子命令"判。
     */
    if let Some(sub) = compose_subcommand(segment) {
        const COMPOSE_READ: &[&str] = &[
            "ps", "logs", "config", "top", "images", "ls", "list", "version", "help", "port",
            "events", "watch",
        ];
        const COMPOSE_WRITE: &[&str] = &[
            "up", "down", "restart", "rm", "pull", "build", "push", "start", "stop", "create",
            "scale", "exec", "run", "pause", "unpause", "kill", "cp", "wait", "attach",
        ];
        if COMPOSE_WRITE.contains(&sub.as_str()) {
            return write_risk;
        }
        if !COMPOSE_READ.contains(&sub.as_str()) {
            // 认不出的子命令按写处理：宁可多问一次。
            return ToolRisk::Write;
        }
    }
    let padded = format!("{lower} ");
    for token in WRITE_PATTERNS {
        if padded.contains(token) {
            return write_risk;
        }
    }
    if has_write_redirect(segment) {
        return write_risk;
    }

    /*
     * 解释器逃逸：首词是 `awk` 也能执行任意命令（`awk 'BEGIN{system("rm -rf /")}'`），
     * `$(...)` / 反引号 / `eval` / `| sh` 同理。只读名单绝不能把它们放过去。
     */
    if has_execution_escape(&lower) {
        return ToolRisk::Write;
    }

    /*
     * 只读工具名的**写用法**：`curl`、`redis-cli`、`mysql` 这些命令只看名字
     * 分不出来 —— 真正决定风险的是参数（`-X POST` / `FLUSHALL` / `delete from`）。
     */
    if first == "curl" && curl_writes(segment) {
        return ToolRisk::Write;
    }
    if first == "wget" {
        // 下载本身就是往磁盘写文件，没有"只读的 wget"。
        return ToolRisk::Write;
    }
    if first == "redis-cli" && !redis_is_read(segment) {
        return ToolRisk::Write;
    }
    if matches!(first, "mysql" | "psql") && sql_writes(&lower) {
        return ToolRisk::Write;
    }

    if is_read_command(first, second) {
        ToolRisk::Read
    } else {
        // 不认识的命令默认要确认：宁可多问一次，也不要静默改服务器。
        ToolRisk::Write
    }
}

/// `docker compose [-f file] [-p name] <子命令>` 里的子命令。
///
/// 选项可以夹在 `compose` 与子命令之间，且多数选项带一个值（`-f docker-compose.yml`），
/// 因此先跳过选项再取第一个裸词。不是 compose 命令时返回 `None`。
fn compose_subcommand(segment: &str) -> Option<String> {
    let words: Vec<&str> = segment.split_whitespace().collect();
    let mut index = 0usize;
    if words.first()?.eq_ignore_ascii_case("docker") {
        index = 1;
    }
    let head = words.get(index)?;
    if !head.eq_ignore_ascii_case("compose") && !head.eq_ignore_ascii_case("docker-compose") {
        return None;
    }
    index += 1;

    const WITH_VALUE: &[&str] = &[
        "-f",
        "--file",
        "-p",
        "--project-name",
        "-c",
        "--context",
        "--env-file",
        "--profile",
        "--project-directory",
        "--ansi",
        "--progress",
        "--parallel",
    ];
    while let Some(word) = words.get(index) {
        if WITH_VALUE.contains(&word.to_ascii_lowercase().as_str()) {
            index += 2;
            continue;
        }
        if word.starts_with('-') {
            index += 1;
            continue;
        }
        return Some(word.to_ascii_lowercase());
    }
    None
}

/// `curl` 的**写**用法：改方法、带请求体、上传文件、把响应写进文件。
fn curl_writes(segment: &str) -> bool {
    let mut tokens = segment.split_whitespace();
    tokens.next();
    while let Some(token) = tokens.next() {
        let lower = token.to_ascii_lowercase();
        // 方法：-X POST / --request=PUT
        let method = if lower == "-x" || lower == "--request" {
            tokens.next().map(|value| value.to_ascii_uppercase())
        } else if let Some(rest) = lower.strip_prefix("-x") {
            Some(rest.to_ascii_uppercase())
        } else {
            lower
                .strip_prefix("--request=")
                .map(|value| value.to_ascii_uppercase())
        };
        if let Some(method) = method {
            let method = method.trim_matches('"').trim_matches('\'').to_string();
            if !matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
                return true;
            }
            continue;
        }
        // 响应写文件：`-o out` / `--output out` / `-oout`；写 `/dev/null` 不算。
        if lower == "-o" || lower == "--output" || (lower.starts_with("-o") && token.len() > 2) {
            let target = if token.len() > 2 {
                token[2..].to_string()
            } else {
                tokens.next().unwrap_or("").to_string()
            };
            let target = target.trim_matches('"').trim_matches('\'');
            if matches!(target, "-" | "/dev/null" | "/dev/stdout" | "/dev/stderr") {
                continue;
            }
            return true;
        }
        /*
         * 响应头：`-D -` / `-D /dev/null` 只是打到 stdout，是**读**操作。
         * 排查站点时 `curl -s -o /dev/null -D -` 很常见，不能当成写文件。
         */
        if token == "-D" || lower == "--dump-header" {
            let target = tokens
                .next()
                .unwrap_or("")
                .trim_matches('"')
                .trim_matches('\'');
            if matches!(target, "-" | "/dev/null") {
                continue;
            }
            return true;
        }
        if let Some(target) = lower.strip_prefix("--dump-header=") {
            if matches!(target, "-" | "/dev/null") {
                continue;
            }
            return true;
        }
        // 请求体 / 表单 / 上传 / cookie 罐 / 头文件。
        if matches!(token, "-d" | "-F" | "-T" | "-c" | "-O")
            || matches!(
                lower.as_str(),
                "--data"
                    | "--data-raw"
                    | "--data-binary"
                    | "--data-urlencode"
                    | "--form"
                    | "--upload-file"
                    | "--cookie-jar"
                    | "--dump-header"
                    | "--json"
            )
            || lower.starts_with("--data=")
            || lower.starts_with("--form=")
            || (token.len() > 2
                && (token.starts_with("-d") || token.starts_with("-F") || token.starts_with("-T")))
        {
            return true;
        }
    }
    false
}

/// `redis-cli` 只认**只读子命令**白名单：`FLUSHALL`、`SET`、`DEL` 一律要确认。
fn redis_is_read(segment: &str) -> bool {
    const READ: &[&str] = &[
        "get",
        "mget",
        "keys",
        "type",
        "ttl",
        "pttl",
        "exists",
        "info",
        "dbsize",
        "scan",
        "sscan",
        "hget",
        "hgetall",
        "hmget",
        "hlen",
        "hkeys",
        "hvals",
        "lrange",
        "llen",
        "lindex",
        "smembers",
        "scard",
        "sismember",
        "zrange",
        "zcard",
        "zscore",
        "ping",
        "echo",
        "time",
        "lastsave",
        "dump",
    ];
    /// 这些命令要再看一级子命令才判断得出是不是只读。
    const NESTED: &[(&str, &[&str])] = &[
        ("config", &["get", "help"]),
        ("client", &["list", "info", "getname", "id"]),
        ("memory", &["usage", "stats", "doctor"]),
        ("slowlog", &["get", "len"]),
        ("command", &["info", "count", "docs"]),
        ("object", &["encoding", "refcount", "idletime", "freq"]),
    ];

    let mut tokens = segment.split_whitespace();
    tokens.next(); // `redis-cli`
    let mut words: Vec<String> = Vec::new();
    while let Some(token) = tokens.next() {
        let lower = token.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "-a" | "-u"
                | "-h"
                | "-p"
                | "-s"
                | "-n"
                | "--user"
                | "--pass"
                | "--tls"
                | "--cacert"
                | "--cert"
                | "--key"
        ) {
            // 这些带值：跳过它的值。
            tokens.next();
            continue;
        }
        if lower.starts_with('-') {
            continue;
        }
        words.push(lower);
        if words.len() >= 2 {
            break;
        }
    }
    let Some(command) = words.first().map(String::as_str) else {
        // 直接 `redis-cli` 是交互式会话：谁也不知道下一步敲什么。
        return false;
    };
    if READ.contains(&command) {
        return true;
    }
    if let Some((_, subs)) = NESTED.iter().find(|(name, _)| *name == command) {
        return words
            .get(1)
            .map(|sub| subs.contains(&sub.as_str()))
            .unwrap_or(false);
    }
    false
}

/// SQL 里出现写语句就按写处理（`mysql -e 'delete from t'` 不是查询）。
fn sql_writes(lower: &str) -> bool {
    const WRITE: &[&str] = &[
        "insert ",
        "update ",
        "delete ",
        "drop ",
        "alter ",
        "create ",
        "truncate ",
        "replace into",
        "grant ",
        "revoke ",
        "flush ",
        "rename ",
        "load data",
        "lock tables",
    ];
    WRITE.iter().any(|needle| lower.contains(needle))
}

/// 命令里是否出现"在只读命令内部执行任意命令"的写法。
///
/// 会命中 `awk 'BEGIN{system(...)}'`、`ls $(rm -rf /tmp/x)`、`` cat `id` ``、
/// `find . -exec ... \;`。误判的代价只是多确认一次，漏判的代价是静默改服务器。
fn has_execution_escape(lower: &str) -> bool {
    const NEEDLES: &[&str] = &[
        "$(",
        "`",
        "system(",
        "system (",
        "eval ",
        "| sh",
        "|sh",
        "| bash",
        "|bash",
        "sh -c",
        "bash -c",
        "/bin/sh",
        "/bin/bash",
        "-exec",
        "-execdir",
        "-ok ",
    ];
    NEEDLES.iter().any(|needle| lower.contains(needle))
}

/// 是否把输出写进了**真实文件**。
///
/// 不算写：
/// * 引号里的 `>`（`echo "a > b"` 只是打印文本）；
/// * `2>&1` / `>&2` 这类**文件描述符复制**；
/// * `/dev/null`、`/dev/stdout`、`/dev/stderr`、`/dev/tty`。
///
/// 算写：`>`、`>>`、`>|` 后面跟真实路径，以及 bash 的 `&>file` / `>&file`。
fn has_write_redirect(segment: &str) -> bool {
    let mut quote: Option<char> = None;
    let mut chars = segment.char_indices().peekable();

    while let Some((index, ch)) = chars.next() {
        if let Some(active) = quote {
            if active == '"' && ch == '\\' {
                chars.next();
            } else if ch == active {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            '\\' => {
                chars.next();
            }
            '>' => {
                // 吞掉 `>>` / `>|`，剩下的就是目标。
                while let Some((_, next)) = chars.peek().copied() {
                    if next == '>' || next == '|' {
                        chars.next();
                    } else {
                        break;
                    }
                }
                let rest = segment[index + ch.len_utf8()..].trim_start();

                // `2>&1` / `>&2`：`&` 后面只有数字（可带 `-`）才是 fd 复制。
                if let Some(after) = rest.strip_prefix('&') {
                    let mut digits = 0usize;
                    let mut only_fd = true;
                    for next in after.chars() {
                        if next.is_ascii_digit() {
                            digits += 1;
                        } else if next == '-' || next == '&' {
                            // `2>&-` 关闭 fd；`&>&` 这类畸形写法则按写文件处理。
                            if next == '&' {
                                only_fd = false;
                                break;
                            }
                        } else {
                            only_fd = false;
                            break;
                        }
                    }
                    if digits > 0 && only_fd {
                        continue;
                    }
                    return true;
                }

                let target: String = rest
                    .chars()
                    .take_while(|next| !next.is_whitespace() && !matches!(next, ';' | '|' | '&'))
                    .collect();
                if target.is_empty() {
                    // `cmd >` 这种收尾多半是残缺命令：不猜，按需要确认处理。
                    return true;
                }
                if matches!(
                    target.as_str(),
                    "/dev/null" | "/dev/stdout" | "/dev/stderr" | "/dev/tty"
                ) {
                    continue;
                }
                return true;
            }
            _ => {}
        }
    }
    false
}

/// 整条命令的风险：所有命令段里最危险的那一档。
///
/// 拆分不确定（引号没闭合等）时直接按写入处理：宁可多问一次，也不能把一条
/// 看不懂的命令当成只读自动执行。
pub fn classify_shell(command: &str) -> ToolRisk {
    let Some(parts) = split_segments(command) else {
        return ToolRisk::Write;
    };
    parts.iter().fold(ToolRisk::Read, |risk, segment| {
        risk.max(classify_segment(segment))
    })
}

/// 从一条 shell 命令里提取**可确定的绝对写目标**。
///
/// 只认能落到具体路径的几种形态：重定向（`>` / `>>`）、`tee`、`sed -i` /
/// `perl -i`、`cp` / `mv` / `install` / `truncate`。变量、通配符、相对路径与
/// `/dev` `/proc` `/sys` 一律跳过 —— 解析不准宁可不记录，也不能编一个假目标。
///
/// 返回顺序即命令里出现的顺序，最多 3 个：每次目标都要多两次 SSH 回读，
/// 不能让一条 `for f in /etc/nginx/conf.d/*.conf` 把整条链路拖慢。
/// 按 `;` / `|` / `&` / 换行切段，**引号里的不切**。
///
/// `sed -i 's/listen 80;/listen 8080;/' /etc/x.conf` 里的 `;` 属于表达式，
/// 按字符直接切会把目标和命令都切碎，什么都解析不出来。
fn split_command_segments(command: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    while let Some(item) = chars.next() {
        match quote {
            Some(q) => {
                current.push(item);
                if item == '\\' {
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                } else if item == q {
                    quote = None;
                }
            }
            None => {
                if item == '\'' || item == '"' {
                    quote = Some(item);
                    current.push(item);
                } else if matches!(item, ';' | '|' | '&' | '\n') {
                    out.push(std::mem::take(&mut current));
                } else {
                    current.push(item);
                }
            }
        }
    }
    out.push(current);
    out
}

pub fn shell_write_targets(command: &str, base_cwd: &str) -> Vec<String> {
    /// 相对路径按**当前段之前的 `cd`** 解析成绝对路径；解析不出就跳过。
    fn absolute(raw: &str, cwd: Option<&str>) -> Option<String> {
        let raw = raw.trim().trim_matches('"').trim_matches('\'');
        if raw.is_empty() || raw.contains(['$', '*', '?', '{', '}', '`', '~']) {
            return None;
        }
        let joined = if raw.starts_with('/') {
            raw.to_string()
        } else {
            format!("{}/{}", cwd?, raw)
        };
        let mut parts: Vec<&str> = Vec::new();
        for part in joined.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => parts.push(other),
            }
        }
        if parts.is_empty() {
            return None;
        }
        Some(format!("/{}", parts.join("/")))
    }

    /// 这个参数是不是备份目标（`.bak` / `.bls-bak` / `~` 结尾）。
    fn is_backup(raw: &str) -> bool {
        let raw = raw.trim_matches('"').trim_matches('\'');
        let base = raw.rsplit('/').next().unwrap_or(raw);
        base.contains(".bak") || base.contains(".bls-bak") || base.ends_with('~')
    }

    /// 展开 `$F` / `${F}`：模型常写 `F=/etc/nginx/x.conf; … > "$F"`。
    fn expand(raw: &str, vars: &std::collections::HashMap<String, String>) -> String {
        if !raw.contains('$') {
            return raw.to_string();
        }
        let mut out = String::new();
        let mut chars = raw.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch != '$' {
                out.push(ch);
                continue;
            }
            let braced = chars.peek() == Some(&'{');
            if braced {
                chars.next();
            }
            let mut name = String::new();
            while let Some(next) = chars.peek().copied() {
                if next.is_ascii_alphanumeric() || next == '_' {
                    name.push(next);
                    chars.next();
                } else {
                    break;
                }
            }
            if braced && chars.peek() == Some(&'}') {
                chars.next();
            }
            match vars.get(&name) {
                Some(value) => out.push_str(value),
                None => {
                    out.push('$');
                    if braced {
                        out.push('{');
                    }
                    out.push_str(&name);
                    if braced {
                        out.push('}');
                    }
                }
            }
        }
        out
    }

    /// 收集 `NAME=/abs/path`：只认**绝对路径**的赋值，别的（命令替换、变量套变量）不猜。
    fn collect_vars(segments: &[String]) -> std::collections::HashMap<String, String> {
        let mut vars: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for segment in segments {
            for token in segment.split_whitespace() {
                let Some((name, value)) = token.split_once('=') else {
                    continue;
                };
                if name.is_empty()
                    || !name
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                    || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    continue;
                }
                let value = expand(value, &vars);
                let value = value.trim_matches('"').trim_matches('\'');
                if value.starts_with('/') && !value.contains(['$', '*', '?', '{', '}', '`', '~']) {
                    vars.insert(name.to_string(), value.to_string());
                }
            }
        }
        vars
    }

    fn push_target(
        out: &mut Vec<String>,
        raw: &str,
        cwd: Option<&str>,
        base: &str,
        vars: &std::collections::HashMap<String, String>,
    ) {
        let raw = expand(raw, vars);
        let Some(path) = absolute(&raw, cwd.or(Some(base))) else {
            return;
        };
        if path.starts_with("/dev/") || path.starts_with("/proc/") || path.starts_with("/sys/") {
            return;
        }
        // `cp -a x x.bak-*` / `x.bls-bak-1` / `sed -i ... x~` 是备份副本，不是用户要看的改动。
        let base = path.rsplit('/').next().unwrap_or(&path);
        if base.contains(".bak") || base.contains(".bls-bak") || base.ends_with('~') {
            return;
        }
        if out.iter().any(|item| item == &path) || out.len() >= MAX_SHELL_TARGETS {
            return;
        }
        out.push(path);
    }

    let mut out: Vec<String> = Vec::new();
    let base = base_cwd.trim_end_matches('/');
    let segments = split_command_segments(command);
    // `F=/etc/nginx/x.conf; sed -i … "$F"`：先收变量，后面按值解析目标。
    let vars = collect_vars(&segments);
    /*
     * 裸相对路径按任务 cwd 解析：命令本身就在这个目录里执行（`wrap_with_cwd`
     * 先 `cd`），不解析会让备份和变更面板漏掉最常见的 `sed -i … config`。
     * 显式 `cd` 过的目录优先用于该段之后的相对路径。
     */
    let mut cwd: Option<String> = None;

    for segment in segments {
        let words: Vec<&str> = segment.split_whitespace().collect();
        if words.is_empty() {
            continue;
        }
        let first = words[0].trim_matches(|c| c == '\'' || c == '"');
        /*
         * `cd /opt/app && sed -i ... index.html`：后面的相对路径都属于
         * `/opt/app`。不跟踪这个 `cd`，真实写目标会被当成相对路径丢掉，
         * 面板就只能显示"未采集差异"。
         */
        if first == "cd" {
            if let Some(dir) = words.get(1) {
                let dir = dir.trim_matches(|c| c == '\'' || c == '"');
                cwd = if dir.starts_with('/') {
                    absolute(dir, None)
                } else if base.starts_with('/') {
                    // `cd app` 相对任务 cwd 解析；`cd /opt/app` 走上一分支。
                    absolute(dir, Some(base))
                } else {
                    None
                };
            }
            continue;
        }
        // 重定向：`> /path`、`>>/path`、`2> /path`；`2>&1` 的 `&1` 不是路径。
        for (index, word) in words.iter().enumerate() {
            let trimmed = word.trim_start_matches(|c: char| c.is_ascii_digit());
            if let Some(rest) = trimmed
                .strip_prefix(">>")
                .or_else(|| trimmed.strip_prefix('>'))
            {
                if !rest.is_empty() {
                    push_target(&mut out, rest, cwd.as_deref(), base, &vars);
                } else if let Some(next) = words.get(index + 1) {
                    push_target(&mut out, next, cwd.as_deref(), base, &vars);
                }
            }
        }
        match first {
            "tee" => {
                for word in words.iter().skip(1) {
                    if !word.starts_with('-') {
                        push_target(&mut out, word, cwd.as_deref(), base, &vars);
                    }
                }
            }
            "sed" | "perl" if words.iter().any(|word| word.starts_with("-i")) => {
                if let Some(last) = words.last() {
                    push_target(&mut out, last, cwd.as_deref(), base, &vars);
                }
            }
            /*
             * `cp -a site.conf site.conf.bak-1 && ./patch.sh`：备份目标不是改动，
             * 真正的目标是 **cp 的源文件**。只看最后一个参数会把唯一线索丢掉，
             * 面板又变成"未采集"。
             */
            "cp" if words.len() >= 3 => {
                let args: Vec<&str> = words
                    .iter()
                    .skip(1)
                    .filter(|word| !word.starts_with('-'))
                    .copied()
                    .collect();
                if args.len() >= 2 {
                    let dest = args[args.len() - 1];
                    if is_backup(dest) {
                        for src in &args[..args.len() - 1] {
                            push_target(&mut out, src, cwd.as_deref(), base, &vars);
                        }
                    } else {
                        push_target(&mut out, dest, cwd.as_deref(), base, &vars);
                    }
                } else if let Some(last) = words.last() {
                    push_target(&mut out, last, cwd.as_deref(), base, &vars);
                }
            }
            /*
             * `mv a b` 同时改两端：源文件在移动后就不在原处了，必须也备份源，
             * 否则"删除前备份"对移动失效。
             */
            "mv" => {
                for word in words.iter().skip(1) {
                    if *word == "--" || word.starts_with('-') {
                        continue;
                    }
                    push_target(&mut out, word, cwd.as_deref(), base, &vars);
                }
            }
            "cp" | "install" | "truncate" | "rsync" | "scp" => {
                if let Some(last) = words.last() {
                    push_target(&mut out, last, cwd.as_deref(), base, &vars);
                }
            }
            /*
             * `mkdir -p a b c`：**空目录也要在变更里出现**（"新增目录"）。
             * 只看非选项参数；`-m 755` 里的值不当目标。
             */
            "mkdir" => {
                for word in words.iter().skip(1) {
                    if !word.starts_with('-') {
                        push_target(&mut out, word, cwd.as_deref(), base, &vars);
                    }
                }
            }
            /*
             * 删除也要能被看见：变更面板要显示"删了哪个文件"，备份策略也要
             * 知道删除目标才能先 cp 再 rm。
             */
            "rm" | "rmdir" | "shred" => {
                for word in words.iter().skip(1) {
                    if *word == "--" || word.starts_with('-') {
                        continue;
                    }
                    push_target(&mut out, word, cwd.as_deref(), base, &vars);
                }
            }
            _ => {}
        }
    }
    out
}

/// 这条命令**有没有可能改文件**（决定要不要进「文件变更」）。
///
/// 与风险定级分开：`echo "$(stat …)"` 因为有命令替换而要确认，但它什么都没写，
/// 不该在变更面板里留一条"未采集"。反过来，`rm` / `sed -i` / `cp` 这类哪怕
/// 目标解析不出来，也要留一条占位。
pub fn shell_may_write(command: &str) -> bool {
    let Some(parts) = split_segments(command) else {
        // 引号都没闭合：看不懂，按会写处理。
        return true;
    };
    const WRITE_VERBS: &[&str] = &[
        "cp", "mv", "rm", "tee", "install", "truncate", "dd", "rsync", "scp", "ln", "touch",
        "mkdir", "rmdir", "chmod", "chown", "unzip", "tar",
    ];
    const WRITE_NEEDLES: &[&str] = &["sed -i", "sed --in-place", "perl -i", "docker cp"];
    parts.iter().any(|segment| {
        if has_write_redirect(segment) {
            return true;
        }
        if WRITE_VERBS.contains(&first_word(segment)) {
            return true;
        }
        WRITE_NEEDLES.iter().any(|needle| segment.contains(needle))
    })
}

/// 一句话操作摘要（确认卡第一行）。
///
/// 只从**实际要执行的操作**推出来：写哪个文件、重载哪个服务、删什么。推不出
/// 具体对象时退回命令本身的动词，不编「更新系统」这种看不出目标的空话。
pub fn describe_operation(command: &str, risk: ToolRisk, path: Option<&str>) -> Option<String> {
    if risk == ToolRisk::Read {
        return None;
    }
    let lower = command.to_ascii_lowercase();

    // 写文件：按文件用途说人话（Nginx / 日志轮转 / Compose / 定时任务）。
    if let Some(path) = path {
        let file = path.rsplit('/').next().unwrap_or(path);
        let file_lower = file.to_ascii_lowercase();
        if lower.contains("nginx") || path.contains("/nginx/") || file_lower.contains("nginx") {
            return Some(format!("更新 Nginx 配置 {file}"));
        }
        if file_lower.contains("logrotate") {
            return Some(format!("更新日志轮转配置 {file}"));
        }
        if file_lower.contains("compose") {
            return Some(format!("更新 Compose 配置 {file}"));
        }
        if file_lower.contains("cron") {
            return Some(format!("更新定时任务 {file}"));
        }
        return Some(format!("更新文件 {file}"));
    }

    // 命令：先认出"动了谁"，再给动词。
    if lower.contains("nginx -s reload")
        || (lower.contains("systemctl") && lower.contains("nginx") && lower.contains("reload"))
    {
        return Some("重载 Nginx".to_string());
    }
    if lower.contains("docker compose") || lower.contains("docker-compose") {
        let verb = if lower.contains(" down") {
            "停止 Compose 项目"
        } else if lower.contains("restart") {
            "重启 Compose 项目"
        } else {
            "更新 Compose 项目"
        };
        return Some(verb.to_string());
    }
    if let Some((verb, service)) = service_change(&lower) {
        return Some(format!("{verb} {service}"));
    }
    if lower.contains("rm ") || lower.contains("rm -") {
        return Some("删除文件".to_string());
    }
    if lower.contains("chmod") || lower.contains("chown") {
        return Some("修改文件权限".to_string());
    }
    if lower.contains("tar ") || lower.contains("unzip") {
        return Some("解压归档".to_string());
    }
    if lower.contains("mkdir") {
        return Some("创建目录".to_string());
    }
    if lower.contains("cp ") || lower.contains("mv ") {
        return Some("复制或移动文件".to_string());
    }

    let first = first_word(command);
    if first.is_empty() {
        return None;
    }
    Some(format!("执行 {first}"))
}

/// `systemctl restart nginx` → `("重启", "nginx")`。
fn service_change(lower: &str) -> Option<(&'static str, String)> {
    if !lower.contains("systemctl") && !lower.contains("service ") {
        return None;
    }
    for (needle, verb) in [
        ("restart", "重启服务"),
        ("reload", "重载服务"),
        ("start", "启动服务"),
        ("stop", "停止服务"),
        ("enable", "设置开机启动"),
        ("disable", "取消开机启动"),
    ] {
        let mut words = lower.split_whitespace();
        while let Some(word) = words.next() {
            if word == needle {
                if let Some(service) = words.next() {
                    return Some((verb, service.trim_end_matches(".service").to_string()));
                }
            }
        }
    }
    None
}

/// 命令是否**真的会写** `/etc` 下的文件。
///
/// 只看"出现了 `/etc/`"会把 `grep -r foo /etc/nginx` 说成"修改系统配置" ——
/// 影响说明必须对得上实际后果，否则用户只能一条条点开自己看。
fn writes_etc(command: &str) -> bool {
    let Some(segments) = split_segments(command) else {
        // 拆不开（引号没闭合）：命令本身已经要确认，但**不能因为出现 `/etc/`
        // 就说"修改系统配置"** —— `docker exec nginx sh -c 'grep … /etc/nginx'`
        // 这类只读查询会因此背上一句与事实相反的说明。只认明确的写特征。
        let lower = command.to_ascii_lowercase();
        return [
            "sed -i",
            "sed --in-place",
            "perl -i",
            "tee /etc/",
            "tee -a /etc/",
            " > /etc/",
            " >> /etc/",
            ">/etc/",
            ">>/etc/",
        ]
        .iter()
        .any(|needle| lower.contains(needle));
    };
    segments.iter().any(|segment| {
        let lower = segment.to_ascii_lowercase();
        if !lower.contains("/etc/") {
            return false;
        }
        // 纯读的那一段（grep / cat / head…）不算。
        if classify_segment(segment) == ToolRisk::Read {
            return false;
        }
        let first = first_word(segment);
        // 这些动词后面出现的路径就是"被写的那个"。
        const ANY_PATH: &[&str] = &[
            "rm", "tee", "touch", "mkdir", "rmdir", "chmod", "chown", "chgrp", "truncate",
            "setfacl", "chattr", "patch",
        ];
        if ANY_PATH.contains(&first) {
            return true;
        }
        // `cp 源 目标` / `mv 源 目标`：只有最后那个参数会被写。
        const LAST_PATH: &[&str] = &["cp", "mv", "ln", "install", "rsync", "dd"];
        if LAST_PATH.contains(&first) {
            return segment
                .split_whitespace()
                .last()
                .map(|last| last.contains("/etc/"))
                .unwrap_or(false);
        }
        // `sed -i` / `perl -i`：就地改文件。
        if lower.contains("sed -i") || lower.contains("sed --in-place") {
            return true;
        }
        // 重定向目标落在 /etc（同段里出现 `> /etc/…` 或 `>>/etc/…`）。
        [
            " > /etc/",
            " >> /etc/",
            ">/etc/",
            ">>/etc/",
            "> \"/etc/",
            ">'/etc/",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
    })
}

/// 危险操作的影响说明（确认框里展示，必须具体）。
///
/// **不复制命令**：命令在详情的"命令"一栏，影响这一行只说后果。认不出后果时
/// 直接说未知 —— 把命令截一段贴上来会被当成"已经解释过了"。
pub fn describe_impact(command: &str, risk: ToolRisk) -> Option<String> {
    if risk == ToolRisk::Read {
        return None;
    }
    let lower = command.to_ascii_lowercase();
    let reasons: Vec<&str> = [
        (lower.contains("sudo"), "以 root 权限执行"),
        (
            lower.contains("rm -rf /") || lower.contains("rm -fr /"),
            "删除根目录下的内容，系统可能无法启动",
        ),
        (
            lower.contains("mkfs") || lower.contains("mkswap"),
            "格式化文件系统，数据不可恢复",
        ),
        (
            lower.contains("iptables")
                || lower.contains("ip6tables")
                || lower.contains("nft")
                || lower.contains("ufw"),
            "修改防火墙规则，可能切断当前连接",
        ),
        (writes_etc(command), "修改系统配置（/etc 下的文件）"),
        (
            lower.contains("reboot") || lower.contains("shutdown") || lower.contains("poweroff"),
            "重启或关闭服务器",
        ),
        (
            lower.contains("> /dev/sd") || lower.contains("dd "),
            "直接写块设备，数据不可恢复",
        ),
        (
            lower.contains("docker compose down"),
            "停止并删除 compose 项目的容器",
        ),
        (lower.contains("systemctl stop"), "停止系统服务"),
        (
            lower.contains("passwd") || lower.contains("userdel"),
            "修改系统账号",
        ),
    ]
    .iter()
    .filter(|(hit, _)| *hit)
    .map(|(_, text)| *text)
    .collect();

    if !reasons.is_empty() {
        return Some(reasons.join("；"));
    }
    if lower.contains("nginx -s reload") || lower.contains("reload nginx") {
        return Some("重载 Nginx 配置：不中断现有连接，新请求会短暂排队".to_string());
    }
    if lower.contains("rm ") || lower.contains("rm -") {
        return Some("删除服务器上的文件，删掉后不会进回收站".to_string());
    }
    if lower.contains("chmod") || lower.contains("chown") {
        return Some("修改文件权限或属主，可能影响服务读取".to_string());
    }
    if lower.contains("cp ") || lower.contains("mv ") {
        return Some("覆盖或移动服务器上的文件".to_string());
    }
    if lower.contains("mkdir") {
        return Some("在服务器上创建目录".to_string());
    }
    if lower.contains("tar ") || lower.contains("unzip") {
        return Some("解压归档，同名文件会被覆盖".to_string());
    }
    if lower.contains("systemctl") || lower.contains("service ") {
        return Some("改变系统服务的运行状态，可能短暂中断访问".to_string());
    }
    if lower.contains("docker") {
        return Some("改变容器或 Compose 项目的运行状态".to_string());
    }
    Some("影响未知：无法判断这条命令会改什么，请展开详情核对后再确认".to_string())
}

/// 把命令包进"切到 cwd → 执行 → 回读 pwd → 保留退出码"的外壳。
///
/// 不切目录就不知道模型现在在哪：`cd /var/www && ls` 之后下一条命令仍然要在
/// `/var/www` 里跑，所以每条都显式 `cd` 到上次回读到的目录。
pub fn wrap_with_cwd(cwd: &str, command: &str) -> String {
    format!(
        "if ! cd {cwd}; then printf '\\n{MISSING}\\n'; exit 98; fi\n{command}\n__bls_rc=$?\nprintf '\\n{PWD}%s\\n' \"$PWD\"\nexit $__bls_rc",
        cwd = shell_quote(cwd),
        MISSING = PWD_FAIL_MARKER,
        PWD = PWD_MARKER,
        command = command
    )
}

/// 被标记行处理过的输出。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarkedOutput {
    pub stdout: String,
    /// 命令结束后的真实目录（没回读到就是 `None`）。
    pub cwd: Option<String>,
    pub backup: Option<String>,
    pub pwd_failed: bool,
    pub backup_failed: bool,
    pub wrote: bool,
}

/// 去掉命令尾部的标记行，并把它们解析出来。
pub fn strip_markers(stdout: &str) -> MarkedOutput {
    let mut out = MarkedOutput::default();
    let mut lines: Vec<&str> = Vec::new();
    for line in stdout.split('\n') {
        let trimmed = line.trim_end_matches('\r');
        if let Some(path) = trimmed.strip_prefix(PWD_MARKER) {
            let path = path.trim();
            if !path.is_empty() {
                out.cwd = Some(path.to_string());
            }
            continue;
        }
        if trimmed.trim() == PWD_FAIL_MARKER {
            out.pwd_failed = true;
            continue;
        }
        if let Some(path) = trimmed.strip_prefix(BACKUP_MARKER) {
            out.backup = Some(path.trim().to_string());
            continue;
        }
        if trimmed.trim() == BACKUP_FAIL_MARKER {
            out.backup_failed = true;
            continue;
        }
        if trimmed.starts_with(WROTE_MARKER) {
            out.wrote = true;
            continue;
        }
        lines.push(line);
    }
    // 标记前会多出一个空行：去掉尾部的空白行，结果里不留"每步以空行结尾"。
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    out.stdout = lines.join("\n");
    out
}

/// `write_file` 的命令体：按策略先备份（失败即中止），再 base64 写入。
fn write_command(
    target: &str,
    content: &str,
    stamp: u64,
    backup_before_write: bool,
    retention_days: u32,
) -> (String, Option<BackupPlan>) {
    use base64::Engine as _;
    let backup = backup_before_write.then(|| plan_write_backup(target, stamp));
    let encoded = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let backup_block = match &backup {
        Some(plan) => {
            let cleanup = backup_cleanup_command(target, retention_days)
                .map(|line| format!("{line}\n"))
                .unwrap_or_default();
            format!(
                "__bls_backup={backup_path}\n\
                 if [ -e \"$__bls_target\" ]; then\n\
                 \x20 if ! {copy}; then printf '\\n{backup_fail}\\n'; exit 97; fi\n\
                 \x20 printf '\\n{backup_marker}%s\\n' \"$__bls_backup\"\n\
                 fi\n\
                 {cleanup}",
                backup_path = shell_quote(&plan.path),
                copy = plan.command,
                backup_fail = BACKUP_FAIL_MARKER,
                backup_marker = BACKUP_MARKER,
                cleanup = cleanup,
            )
        }
        None => String::new(),
    };
    let command = format!(
        "__bls_target={target}\n\
         {backup_block}\
         mkdir -p \"$(dirname \"$__bls_target\")\" || exit 95\n\
         if ! printf %s '{encoded}' | base64 -d > \"$__bls_target\"; then printf '\\n__BLS_WRITE_FAIL__\\n'; exit 96; fi\n\
         printf '\\n{wrote}%s\\n' \"$__bls_target\"",
        target = shell_quote(target),
        backup_block = backup_block,
        encoded = encoded,
        wrote = WROTE_MARKER,
    );
    (command, backup)
}

fn is_critical_config_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    [
        "/etc/ssh/",
        "/etc/sudoers",
        "/etc/passwd",
        "/etc/group",
        "/etc/shadow",
        "/etc/iptables",
        "/etc/nftables",
        "/etc/firewalld",
        "/etc/ufw",
        "/etc/network/",
        "/etc/systemd/network/",
        "/etc/resolv.conf",
        "/boot/",
        "/dev/",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// 影响特别严重、即使「完全权限」也必须二次确认的操作。
///
/// 日常运维（上传 / mkdir / unzip / 明确目录的配置修改 / 构建 / 部署）不在这里；
/// 这里只列不可恢复或可能直接失联的动作。返回给用户的是一句具体原因。
pub fn severe_operation_reason(planned: &PlannedTool) -> Option<String> {
    let display = planned.display.trim();
    let lower = display.to_lowercase();
    let words = shell_words(display).unwrap_or_default();
    let first = words.first().map(|word| base_command(word)).unwrap_or("");

    if planned.path.as_deref().is_some_and(is_critical_config_path) {
        return Some("会修改 SSH / 防火墙 / 系统启动相关配置，可能导致失联".to_string());
    }
    // 用 /tmp 当占位 cwd：只有显式 `-d /` 或 `cd /` 才会被判成系统目录，
    // 相对路径的普通解压不能因为这里拿不到真实 cwd 就误升级。
    if let Some(archive) = parse_archive_operation(&planned.display, "/tmp") {
        if archive
            .target
            .as_deref()
            .is_some_and(|target| matches!(target, "/" | "/etc" | "/usr" | "/boot" | "/dev"))
        {
            return Some("会把归档直接解压到系统关键目录，可能覆盖系统文件".to_string());
        }
    }

    if matches!(first, "shutdown" | "reboot" | "poweroff" | "halt")
        || words
            .iter()
            .any(|word| word == "shutdown" || word == "reboot")
    {
        return Some("会关机或重启服务器，正在运行的服务会中断".to_string());
    }
    if lower.contains("mkfs")
        || lower.contains("wipefs")
        || lower.contains("blkdiscard")
        || lower.contains("fdisk ")
        || lower.contains("parted ")
        || lower.contains("dd if=")
        || lower.contains("of=/dev/")
        || lower.contains("> /dev/sd")
        || lower.contains("> /dev/nvme")
    {
        return Some("会直接写入磁盘 / 分区，数据可能不可恢复".to_string());
    }
    if lower.contains("shred ") || (lower.contains("find ") && lower.contains(" -delete")) {
        return Some("会不可恢复地删除大量文件".to_string());
    }
    if lower.contains("chmod 777 /")
        || lower.contains("chmod -r 777 /")
        || lower.contains("chown -r /")
        || lower.contains("kill -9 1")
        || lower.contains("killall5")
        || lower.contains(":(){")
        || lower.contains("visudo")
        || lower.contains("passwd ")
        || lower.contains("userdel ")
    {
        return Some("会改变系统权限 / 账号或终止关键进程，可能导致失联".to_string());
    }
    if lower.starts_with("rm ") || lower.contains(" rm ") || lower.starts_with("rm\t") {
        let broad = words.iter().skip(1).find(|word| {
            matches!(
                word.as_str(),
                "/" | "/etc"
                    | "/var"
                    | "/usr"
                    | "/home"
                    | "/opt"
                    | "/srv"
                    | "/bin"
                    | "/lib"
                    | "/*"
                    | "/etc/*"
                    | "/var/*"
                    | "/usr/*"
                    | "/home/*"
            )
        });
        if broad.is_some() {
            return Some("删除范围覆盖系统或整个业务根目录，数据可能不可恢复".to_string());
        }
    }
    if lower.contains("iptables")
        || lower.contains("nft ")
        || lower.contains("ufw ")
        || lower.contains("firewall-cmd")
    {
        return Some("会修改防火墙规则，可能断开当前 SSH 连接".to_string());
    }
    if lower.contains("systemctl ") || lower.contains("service ") {
        let critical = [
            "ssh",
            "sshd",
            "network",
            "networking",
            "firewalld",
            "ufw",
            "docker",
            "containerd",
            "systemd-networkd",
            "systemd-resolved",
            "dbus",
        ];
        if critical.iter().any(|unit| {
            lower.contains(&format!("systemctl stop {unit}"))
                || lower.contains(&format!("systemctl restart {unit}"))
                || lower.contains(&format!("systemctl disable {unit}"))
                || lower.contains(&format!("systemctl mask {unit}"))
                || lower.contains(&format!("service {unit} stop"))
                || lower.contains(&format!("service {unit} restart"))
        }) {
            return Some("会停止 / 重启网络或 SSH 等核心共享服务，可能中断所有连接".to_string());
        }
    }
    if lower.contains("/etc/ssh/")
        || lower.contains("/etc/sudoers")
        || lower.contains("/etc/network/")
        || lower.contains("/etc/resolv.conf")
    {
        return Some("会修改 SSH / 网络相关配置，可能导致失联".to_string());
    }
    None
}

/// 这次操作在当前权限模式下是否还需要用户确认。
///
/// 普通模式：所有写 / 危险操作都确认；
/// 完全权限：日常写入直接执行，只有 [`severe_operation_reason`] 命中的严重操作
/// 才二次确认。只读操作永远不确认。
pub fn requires_confirmation(planned: &PlannedTool, full_permissions: bool) -> bool {
    planned.call.risk.needs_approval()
        && (!full_permissions || severe_operation_reason(planned).is_some())
}

/// 工具名 + 参数 → 可执行计划（风险、超时、影响、备份都定好）。
///
/// 默认备份策略沿用旧行为；运行中的任务用 [`plan_tool_with_backup`] 传入
/// 权限页里的真实开关。
pub fn plan_tool(name: &str, args: &Value, cwd: &str, stamp: u64) -> Result<PlannedTool, String> {
    plan_tool_with_backup(name, args, cwd, stamp, &BackupPolicy::default())
}

pub fn plan_tool_with_backup(
    name: &str,
    args: &Value,
    cwd: &str,
    stamp: u64,
    backup: &BackupPolicy,
) -> Result<PlannedTool, String> {
    let tool = name.trim();
    let (call_name, risk, command, display, summary, timeout, path, impact, rollback, backup_path) =
        match tool {
            "run_shell" | "shell" => {
                // 模型偶尔给 CRLF：`\r` 会变成命令的一部分（bash 把它当普通字符），
                // 统一成 `\n` 再执行。
                let raw = string_arg(args, "command")?
                    .replace("\r\n", "\n")
                    .replace('\r', "\n");
                let raw = raw.trim().to_string();
                if raw.is_empty() {
                    return Err("command 不能为空".to_string());
                }
                if raw.len() > 32 * 1024 {
                    return Err("单条命令过长（上限 32 KB）".to_string());
                }
                if raw.contains('\0') {
                    return Err("command 不能包含空字符".to_string());
                }
                let cwd = match args.get("cwd").and_then(Value::as_str) {
                    Some(value) => absolute_path(value, "cwd")?,
                    None => cwd.to_string(),
                };
                let risk = classify_shell(&raw);
                let archive = parse_archive_operation(&raw, &cwd);
                let mut impact = archive
                    .as_ref()
                    .map(ArchiveOperation::impact)
                    .or_else(|| describe_impact(&raw, risk));
                let summary = archive
                    .as_ref()
                    .map(ArchiveOperation::summary)
                    .or_else(|| describe_operation(&raw, risk, None));
                /*
                 * shell 的写 / 删也按策略备份：用已校验的写目标（含 rm / sed -i /
                 * 重定向），`cp -a` 失败就 exit 97，原命令不会执行。
                 * 删除目标解析不出来时宁可不跑 —— 删掉之后就没有原文件可备份了。
                 */
                let mut script = raw.clone();
                let mut backup_path = None;
                if risk != ToolRisk::Read && shell_may_write(&raw) {
                    let deletes = shell_has_delete(&raw);
                    let need = if deletes {
                        backup.before_delete
                    } else {
                        backup.before_write
                    };
                    if need {
                        let targets = shell_write_targets(&raw, &cwd);
                        if targets.is_empty() {
                            if deletes {
                                return Err(
                                    "删除前需要备份，但无法确定要删除的路径：请改成明确的绝对路径，或在权限页关闭「删除前备份」。"
                                        .to_string(),
                                );
                            }
                            impact = Some(match impact {
                                Some(text) if !text.is_empty() => {
                                    format!("{text}；未能确定目标文件，本次未创建备份")
                                }
                                _ => "未能确定目标文件，本次未创建备份".to_string(),
                            });
                        } else {
                            let prefix = shell_backup_script(
                                &targets,
                                stamp,
                                backup.retention_days,
                            );
                            script = format!("{prefix}{raw}");
                            backup_path = Some(format!(
                                "{}{}{}",
                                targets[0], BACKUP_MARK, stamp
                            ));
                        }
                    }
                }
                let wrapped = wrap_with_cwd(&cwd, &script);
                (
                    "run_shell",
                    risk,
                    wrapped,
                    raw,
                    summary,
                    MAX_COMMAND_SECONDS,
                    None,
                    impact,
                    None,
                    backup_path,
                )
            }
            "read_file" | "read" => {
                let path = absolute_path(&string_arg(args, "path")?, "path")?;
                let offset = args
                    .get("offset")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .max(1);
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(300)
                    .clamp(1, 2000);
                let end = offset.saturating_add(limit - 1);
                let risk = if is_sensitive_path(&path) {
                    ToolRisk::Write
                } else {
                    ToolRisk::Read
                };
                let impact = (risk != ToolRisk::Read)
                    .then(|| "这个文件通常包含凭据或私钥，内容会发给模型".to_string());
                let summary = describe_operation("", risk, Some(&path));
                let command = format!(
                    "awk 'NR>={offset} && NR<={end} {{printf \"%6d\\t%s\\n\", NR, $0}}' {path}",
                    path = shell_quote(&path)
                );
                (
                    "read_file",
                    risk,
                    command.clone(),
                    command,
                    summary,
                    30,
                    Some(path),
                    impact,
                    None,
                    None,
                )
            }
            "list_dir" | "ls" => {
                let path = absolute_path(&string_arg(args, "path")?, "path")?;
                let command = format!("ls -la {}", shell_quote(&path));
                (
                    "list_dir",
                    ToolRisk::Read,
                    command.clone(),
                    command,
                    None,
                    30,
                    Some(path),
                    None,
                    None,
                    None,
                )
            }
            "write_file" | "write" => {
                let path = absolute_path(&string_arg(args, "path")?, "path")?;
                let content = string_arg(args, "content")?;
                if content.len() > MAX_WRITE_BYTES {
                    return Err(format!(
                        "content 过大（上限 {} KB）；大文件请用 run_shell 分块写入",
                        MAX_WRITE_BYTES / 1024
                    ));
                }
                let risk = if is_system_path(&path) {
                    ToolRisk::Danger
                } else {
                    ToolRisk::Write
                };
                let (command, backup) = write_command(
                    &path,
                    &content,
                    stamp,
                    backup.before_write,
                    backup.retention_days,
                );
                let backup_note = match &backup {
                    Some(_) => "如有原文件，将先备份再覆盖",
                    None => "此操作未备份：未启用备份（权限页已关闭修改前备份）",
                };
                let impact = if risk == ToolRisk::Danger {
                    Some(format!("会覆盖系统目录下的文件 {path}（{backup_note}）"))
                } else {
                    Some(format!("会覆盖 {path}（{backup_note}）"))
                };
                let rollback = backup.as_ref().map(|plan| plan.rollback.clone());
                let backup_path = backup.as_ref().map(|plan| plan.path.clone());
                let summary = describe_operation("", risk, Some(&path));
                (
                    "write_file",
                    risk,
                    command,
                    format!("写入 {path}"),
                    summary,
                    60,
                    Some(path),
                    impact,
                    rollback,
                    backup_path,
                )
            }
            other => return Err(format!("未知工具：{other}")),
        };

    Ok(PlannedTool {
        call: ToolCall {
            id: String::new(),
            name: call_name.to_string(),
            args: args.clone(),
            risk,
        },
        command,
        display,
        summary,
        timeout: Duration::from_secs(timeout),
        path,
        impact,
        rollback,
        backup_path,
        // 与 `write_command` 用的是**同一份参数**：预览里的新内容不是模型口述，
        // 而是这次调用真正提交的正文。
        write_content: (call_name == "write_file").then(|| {
            args.get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        }),
        mcp: None,
    })
}

#[cfg(test)]
mod archive_identity_tests {
    use super::*;
    use serde_json::json;

    fn planned(command: &str) -> PlannedTool {
        plan_tool("run_shell", &json!({ "command": command }), "/srv/app", 1)
            .expect("plan shell command")
    }

    fn signature(command: &str) -> String {
        parse_archive_operation(command, "/srv/app")
            .expect("parse archive")
            .signature()
    }

    #[test]
    fn equivalent_path_and_cd_forms_share_one_identity() {
        let absolute = signature("unzip -o /srv/app/dist.zip -d /srv/app/staging");
        let relative = signature("unzip -o dist.zip -d staging");
        let via_cd = signature("cd /srv/app && unzip -o ./dist.zip -d ./staging");
        assert_eq!(absolute, relative);
        assert_eq!(absolute, via_cd);

        let tar = signature("tar -xzf dist.zip -C staging");
        assert!(tar.contains("/srv/app/dist.zip"));
        assert!(tar.contains("/srv/app/staging"));
    }

    #[test]
    fn overwrite_policy_and_target_change_create_a_new_identity() {
        let overwrite = signature("unzip -o dist.zip -d staging");
        let no_overwrite = signature("unzip -n dist.zip -d staging");
        let interactive = signature("unzip dist.zip -d staging");
        let other_target = signature("unzip -o dist.zip -d /srv/app/online");
        assert_ne!(overwrite, no_overwrite);
        assert_ne!(overwrite, interactive);
        assert_ne!(overwrite, other_target);
    }

    #[test]
    fn listing_is_read_only_and_not_confused_with_extraction() {
        assert!(archive_list_only("unzip -l dist.zip"));
        assert!(archive_list_only("tar -tf dist.zip"));
        assert!(archive_list_only("tar -tzf dist.zip"));
        assert!(!archive_list_only("unzip -o dist.zip -d staging"));
        assert_eq!(classify_shell("unzip -l dist.zip"), ToolRisk::Read);
        assert_eq!(classify_shell("tar -tf dist.zip"), ToolRisk::Read);
        assert_eq!(
            classify_shell("unzip -o dist.zip -d staging"),
            ToolRisk::Write
        );
        assert!(!signature("unzip -l dist.zip").contains("extract"));
    }

    #[test]
    fn uncertain_commands_are_not_treated_as_equivalent() {
        assert!(parse_archive_operation("unzip $ARCHIVE -d staging", "/srv/app").is_none());
        assert!(parse_archive_operation("unzip dist.zip | tee log", "/srv/app").is_none());
        assert!(parse_archive_operation("unzip dist.zip && rm -rf build", "/srv/app").is_none());
    }

    #[test]
    fn full_permissions_skip_routine_writes_but_not_severe_ones() {
        let unzip = planned("unzip -oq dist.zip -d /srv/app/staging");
        assert!(requires_confirmation(&unzip, false));
        assert!(!requires_confirmation(&unzip, true));

        let severe = planned("rm -rf /etc");
        assert!(requires_confirmation(&severe, false));
        assert!(requires_confirmation(&severe, true));
        assert!(severe_operation_reason(&severe).is_some());

        let ssh = planned("systemctl restart ssh");
        assert!(requires_confirmation(&ssh, true));
        assert!(severe_operation_reason(&ssh).is_some());
    }

    #[test]
    fn write_file_to_ssh_config_stays_severe_under_full_permissions() {
        let planned = plan_tool(
            "write_file",
            &json!({"path":"/etc/ssh/sshd_config","content":"PermitRootLogin no\n"}),
            "/srv/app",
            1,
        )
        .expect("plan write");
        assert!(requires_confirmation(&planned, true));
        assert!(severe_operation_reason(&planned).is_some());
    }
}

#[cfg(test)]
mod builtin_filter_tests {
    use super::*;
    use serde_json::Value;

    fn names(value: &Value) -> Vec<String> {
        value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.pointer("/function/name").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn builtin_selection_filters_tool_schemas() {
        let only_files =
            filter_tool_schemas(tool_schemas(false), Some(&["files".to_string()]));
        let listed = names(&only_files);
        assert!(listed.contains(&"read_file".to_string()));
        assert!(listed.contains(&"write_file".to_string()));
        assert!(!listed.contains(&"run_shell".to_string()));

        /*
         * 一个内置能力都没勾：**运维工具**全部移除，但 `ask_user` / `submit_plan`
         * 这类交互控制工具必须留着 —— 它们不执行服务器命令，也不属于任何
         * 内置能力（用户取消勾选不是"禁用提问"）。
         */
        let none = filter_tool_schemas(tool_schemas(false), Some(&[]));
        let remaining = names(&none);
        assert!(!remaining.contains(&"run_shell".to_string()));
        assert!(!remaining.contains(&"read_file".to_string()));
        assert_eq!(remaining, vec!["ask_user".to_string()]);

        // 强制计划时 `submit_plan` 也在，而且同样不受内置能力勾选影响。
        let planned = names(&filter_tool_schemas(tool_schemas(true), Some(&[])));
        assert_eq!(planned.len(), 2);
        assert!(planned.contains(&"submit_plan".to_string()));
        assert!(planned.contains(&"ask_user".to_string()));

        let old_client = filter_tool_schemas(tool_schemas(false), None);
        assert!(names(&old_client).contains(&"run_shell".to_string()));
    }
}

#[cfg(test)]
mod backup_policy_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn delete_backup_follows_the_policy() {
        let on = plan_tool_with_backup(
            "run_shell",
            &json!({ "command": "rm -f /tmp/bls-a.txt" }),
            "/root",
            7,
            &BackupPolicy::default(),
        )
        .expect("plan delete");
        assert!(
            on.command
                .contains("cp -a '/tmp/bls-a.txt' '/tmp/bls-a.txt.bls-bak.7'"),
            "{}",
            on.command
        );
        assert_eq!(on.backup_path.as_deref(), Some("/tmp/bls-a.txt.bls-bak.7"));

        let off = plan_tool_with_backup(
            "run_shell",
            &json!({ "command": "rm -f /tmp/bls-a.txt" }),
            "/root",
            7,
            &BackupPolicy {
                before_delete: false,
                ..BackupPolicy::default()
            },
        )
        .expect("plan delete without backup");
        assert!(!off.command.contains("cp -a"), "{}", off.command);
        assert!(off.backup_path.is_none());
    }

    #[test]
    fn unresolvable_delete_is_rejected_when_backup_is_on() {
        let error = plan_tool_with_backup(
            "run_shell",
            &json!({ "command": "rm -rf \"$DIR\"" }),
            "/root",
            1,
            &BackupPolicy::default(),
        )
        .expect_err("无法确定删除目标时必须拒绝");
        assert!(error.contains("无法确定"), "{error}");
    }

    #[test]
    fn write_file_can_skip_backup_by_policy() {
        let off = plan_tool_with_backup(
            "write_file",
            &json!({ "path": "/tmp/bls-write.txt", "content": "x" }),
            "/root",
            1,
            &BackupPolicy {
                before_write: false,
                ..BackupPolicy::default()
            },
        )
        .expect("plan write");
        assert!(!off.command.contains("cp -a"), "{}", off.command);
        assert!(off.backup_path.is_none());
        assert!(off.rollback.is_none());
        assert!(off
            .impact
            .as_deref()
            .is_some_and(|text| text.contains("未启用备份")));
    }
}
