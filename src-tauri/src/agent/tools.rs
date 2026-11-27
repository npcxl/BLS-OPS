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

use super::protocol::{Lang, ToolCall, ToolRisk, MAX_COMMAND_SECONDS};
use crate::safe::shell_quote;

/// 用户可见文案按界面语言二选一。
///
/// 只用于**界面会直接显示**的摘要 / 影响 / 错误；模型提示词有自己的
/// `Lang` 分支，不经过这里。
fn tr(lang: Lang, zh: impl Into<String>, en: impl Into<String>) -> String {
    match lang {
        Lang::Zh => zh.into(),
        Lang::En => en.into(),
    }
}

/// 多段影响说明的分隔符：英文用分号空格，中文用全角分号。
fn clause_sep(lang: Lang) -> &'static str {
    match lang {
        Lang::Zh => "；",
        Lang::En => "; ",
    }
}

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
        "run_shell" | "shell" => [
            "inspect", "logs", "docker", "nginx", "systemd", "dns", "database",
        ]
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
    tool_schemas_lang(plan_required, Lang::Zh)
}

/// 工具清单：描述按**界面语言**生成。
///
/// 这些 description 是模型看到的第一手说明；英文界面下仍给中文，模型很容易
/// 顺着中文描述写计划标题与解释，界面就会出现中英混杂。
pub fn tool_schemas_lang(plan_required: bool, lang: Lang) -> Value {
    let path = |description: String| {
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
                "description": tr(
                    lang,
                    "在一台 Linux 服务器上执行一条 shell 命令。只读命令（ls/cat/grep/ps/df/sha256sum/docker ps/docker inspect/systemctl status 等）直接执行，管道、if/for 循环、变量赋值、$(…) 与 <(…) 都会按其中真正执行的命令逐层判定；修改类命令（rm/mv/cp/tee/systemctl restart/docker compose up 等）与危险命令（sudo/mkfs/iptables/写 /etc 等）在普通权限下逐条确认、完全权限下直接执行；只查询的任务里写操作会被执行器拦下。解析不出来的命令会按「无法判断」请用户确认。命令结束后会自动回读当前目录。",
                    "Run one shell command on a Linux server. Read-only commands (ls/cat/grep/ps/df/sha256sum/docker ps/docker inspect/systemctl status...) run directly; pipelines, if/for blocks, variable assignments and $(…)/(<…) are classified by the command they actually run. Modifying commands (rm/mv/cp/tee/systemctl restart/docker compose up...) and dangerous commands (sudo/mkfs/iptables/writes under /etc...) are confirmed one by one under normal permissions and run directly under full permissions; in a query-only task the executor blocks writes. Commands that cannot be parsed are shown as \"cannot determine\" and need confirmation. The current directory is read back after each command.",
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": tr(lang, "要执行的完整命令（可以用 ; && || 串起来）", "The full command to run (you may chain with ; && ||)") },
                        "cwd": path(tr(lang, "可选：在哪个绝对路径下执行，默认沿用任务当前目录", "Optional: an absolute directory to run in; defaults to the task's current directory")),
                        /*
                         * 模型自述（可选）：平台据此**校验**声明与实测是否一致，
                         * 也把「这一步要做什么」显示给用户。风险判定始终以后端
                         * 解析为准，声明只影响话术与冲突反馈。
                         */
                        "purpose": {
                            "type": "string",
                            "description": tr(
                                lang,
                                "一句话说明这一步要达成什么（例如「列出两个备份的文件清单并比较哈希」）。会显示在操作过程与确认卡上。",
                                "One line on what this step is for (e.g. \"list both backups and compare their hashes\"). Shown in the run log and the approval card.",
                            )
                        },
                        "intent": {
                            "type": "string",
                            "enum": ["read", "change"],
                            "description": tr(
                                lang,
                                "你认为这条命令会做什么：read = 只读查询，change = 会写入 / 重启 / 删除。与你实际给的命令不一致时，平台会把冲突回给你，不静默执行。",
                                "What you think this command does: read = query only, change = writes / restarts / deletes. If it conflicts with the actual command, the platform sends the conflict back instead of running it silently.",
                            )
                        },
                        "expect": {
                            "type": "string",
                            "description": tr(
                                lang,
                                "可选：预期影响或会改到的对象（例如「只覆盖 /srv/app/index.html」）。",
                                "Optional: expected effect or what exactly changes (e.g. \"only overwrites /srv/app/index.html\").",
                            )
                        },
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": tr(
                    lang,
                    "读取服务器上的一个文本文件，返回带行号的内容。敏感文件（/etc/shadow、私钥、.env 等）在普通权限下需要用户确认。",
                    "Read a text file on the server and return it with line numbers. Sensitive files (/etc/shadow, private keys, .env...) need user approval under normal permissions.",
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": path(tr(lang, "文件的绝对路径", "Absolute path of the file")),
                        "offset": { "type": "integer", "description": tr(lang, "起始行号（从 1 开始，默认 1）", "First line number (1-based, default 1)") },
                        "limit": { "type": "integer", "description": tr(lang, "最多读取多少行（默认 300，上限 2000）", "Maximum number of lines (default 300, max 2000)") }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": tr(lang, "列出一个目录的内容（ls -la，含隐藏文件与权限）。", "List a directory with ls -la, including hidden files and permissions."),
                "parameters": {
                    "type": "object",
                    "properties": { "path": path(tr(lang, "目录的绝对路径", "Absolute path of the directory")) },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": tr(
                    lang,
                    "写入或覆盖一个文本文件。**必须先备份**：自动在同目录留一份带 .bls-bak. 标记的副本，返回备份路径供回滚。每次写入都要用户确认。内容上限 128 KB。",
                    "Write or overwrite a text file. **A backup is mandatory**: a copy with the .bls-bak. marker is left in the same directory and its path is returned for rollback. Every write needs user approval. Content limit: 128 KB.",
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": path(tr(lang, "目标文件的绝对路径", "Absolute path of the target file")),
                        "content": { "type": "string", "description": tr(lang, "完整的文件内容（覆盖写，不是追加）", "The complete file content (overwrite, not append)") }
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
                    "description": tr(
                        lang,
                        "向用户提出一个需要决定的问题，并暂停当前任务等待回答。当缺少关键选择、前提需要用户确认、或不同方案需要用户拍板时使用；不要用普通正文假装提问。任务会一直等到用户提交选择后继续。",
                        "Ask the user a decision question and pause the task until it is answered. Use it when a critical choice is missing, a premise needs confirmation, or the user must pick between plans; never ask inside normal prose. The task resumes after the user submits an answer.",
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "question": { "type": "string", "description": tr(lang, "要问用户的问题，一句话说清楚需要决定什么", "The question for the user; state the decision in one sentence") },
                            "kind": {
                                "type": "string",
                                "enum": ["single", "multi"],
                                "description": tr(lang, "single=单选；multi=多选", "single = one choice; multi = multiple choices")
                            },
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": tr(lang, "稳定选项 id，回答时回传", "Stable option id, returned with the answer") },
                                        "label": { "type": "string", "description": tr(lang, "用户看到的选项名称", "Option label shown to the user") }
                                    },
                                    "required": ["id", "label"]
                                },
                                "description": tr(lang, "预设选项；仅允许自定义时可留空", "Preset options; may be empty when only a custom answer is allowed")
                            },
                            "allowCustom": {
                                "type": "boolean",
                                "description": tr(lang, "是否允许用户填写预设选项之外的内容", "Whether the user may enter an answer outside the presets")
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
                let name = tool.pointer("/function/name").and_then(Value::as_str);
                if name == Some("ask_user") {
                    continue;
                }
                let supports_verification = matches!(name, Some("run_shell" | "read_file"));
                let params = &mut tool["function"]["parameters"];
                params["properties"]["step"] = json!({
                    "type": "string",
                    "description": tr(
                        lang,
                        "这一步属于计划的哪一步（必填，值为 submit_plan 里的步骤 id）",
                        "Which plan step this call belongs to (required; a step id from submit_plan)"
                    )
                });
                if let Some(required) = params["required"].as_array_mut() {
                    required.push(json!("step"));
                }
                if supports_verification {
                    params["properties"]["verifies"] = json!({
                        "type": "string",
                        "description": tr(lang,
                            "仅限只读验收：若本调用属于独立验收步骤，填写本次实际核对的动作步骤 id。",
                            "Read-only verification only: ID of the action step this separate check actually verifies.")
                    });
                }
            }
            list.insert(
                0,
                json!({
                    "type": "function",
                    "function": {
                        "name": "submit_plan",
                        "description": tr(
                            lang,
                            "提交或更新本轮执行计划。必须在第一次调用其他工具之前调用；探查后可以再次提交以充实计划，已完成的步骤会保留。计划步骤只登记计划，不授予执行权限，也不会额外弹确认。",
                            "Submit or update this turn's execution plan. It must be called before any other tool; after probing you may submit again to refine it, and completed steps are preserved. Registering a plan grants no execution permission and adds no confirmation.",
                        ),
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "understanding": { "type": "string", "description": tr(lang, "一句话复述任务理解", "One sentence restating the task") },
                                "summary": { "type": "string", "description": tr(lang, "行动摘要（计划卡副标题）", "Action summary (the plan card subtitle)") },
                                "prerequisites": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": tr(lang, "需要用户确认的前提（只展示，不额外弹确认）", "Premises needing user confirmation (display only; no extra dialog)")
                                },
                                "steps": {
                                    "type": "array",
                                    "minItems": 1,
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "id": { "type": "string", "description": tr(lang, "稳定 id，例如 s1", "Stable id, e.g. s1") },
                                            "title": { "type": "string", "description": tr(lang, "用户能看懂的一步标题", "A step title the user can understand") },
                                            "action": { "type": "string", "description": tr(lang, "预期动作：要看什么 / 要改什么", "Expected action: what to inspect or change") },
                                            "verify": { "type": "string", "description": tr(lang, "验证条件：怎样算这一步完成", "Verification: how completion is proven") },
                                            "kind": {
                                                "type": "string",
                                                "enum": ["probe", "action", "answer"],
                                                "description": tr(lang, "probe=只读探查；action=会改服务器；answer=纯聊天的一步回答", "probe = read-only inspection; action = changes the server; answer = a single chat answer")
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

/// 模型对这次调用的**自述**（可选，缺省时行为与以前完全一致）。
///
/// 平台只把它当"模型认为"：风险与权限始终由 [`classify_shell_detail`] 和
/// 用户选择的权限模式决定。两者冲突时先让模型自己改，而不是把矛盾甩给用户。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeclaredOp {
    /// 一句话操作目的（显示在操作过程与确认卡上）。
    pub purpose: Option<String>,
    /// 模型自认为的影响面 / 预期结果。
    pub expect: Option<String>,
    /// `read`（只读）或 `change`（会改服务器）；其他值视为未声明。
    pub intent: Option<String>,
}

impl DeclaredOp {
    /// 模型是否声明"这一步只读"。
    pub fn claims_read(&self) -> bool {
        self.intent.as_deref() == Some("read")
    }
}

/// 从工具参数里读模型的自述；三个字段都没写时返回 `None`。
fn declared_op(args: &Value) -> Option<DeclaredOp> {
    let text = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(200).collect::<String>())
    };
    let declared = DeclaredOp {
        purpose: text("purpose"),
        expect: text("expect"),
        intent: text("intent")
            .map(|value| value.to_ascii_lowercase())
            .filter(|value| value == "read" || value == "change"),
    };
    (declared.purpose.is_some() || declared.expect.is_some() || declared.intent.is_some())
        .then_some(declared)
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
    /// 无法可靠解析的命令片段（`run_shell` 才有）。
    ///
    /// `Some` = 这段命令我们看不懂：风险按写兜底要确认，但界面必须说
    /// 「无法判断」，不能描述成"已经确定要修改"。
    pub unknown: Option<String>,
    /// 模型对这次调用的自述（目的 / 预期 / 只读还是改动）；没写时为 `None`。
    pub declared: Option<DeclaredOp>,
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
        self.label_lang(Lang::Zh)
    }

    pub fn label_lang(self, lang: Lang) -> &'static str {
        match (self, lang) {
            (Self::Interactive, Lang::Zh) => "未指定（遇到同名文件会询问）",
            (Self::Always, Lang::Zh) => "覆盖同名文件",
            (Self::Never, Lang::Zh) => "不覆盖已有文件",
            (Self::Interactive, Lang::En) => "not specified (asks on name collisions)",
            (Self::Always, Lang::En) => "overwrites files with the same name",
            (Self::Never, Lang::En) => "keeps existing files",
        }
    }
}

/// 归档命令到底在做什么：看清单 / 校验 / 读内容 / 解压。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    /// `unzip -l` / `tar -t`：列清单。
    List,
    /// `unzip -t`：校验完整性。
    Verify,
    /// `unzip -p` / `tar -xO`：只把某个文件的内容打到 stdout。
    Read,
    /// 真正落盘。
    Extract,
}

impl ArchiveKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Verify => "verify",
            Self::Read => "read",
            Self::Extract => "extract",
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
    /// 进一步区分"看清单 / 校验 / 读内容 / 解压"。
    pub kind: ArchiveKind,
}

impl ArchiveOperation {
    pub fn summary(&self) -> String {
        self.summary_lang(Lang::Zh)
    }

    pub fn summary_lang(&self, lang: Lang) -> String {
        match self.kind {
            ArchiveKind::List => tr(
                lang,
                format!("查看归档清单 {}", self.archive),
                format!("List archive {}", self.archive),
            ),
            ArchiveKind::Verify => tr(
                lang,
                format!("校验归档 {}", self.archive),
                format!("Verify archive {}", self.archive),
            ),
            ArchiveKind::Read => tr(
                lang,
                format!("读取归档内容 {}", self.archive),
                format!("Read archive contents {}", self.archive),
            ),
            ArchiveKind::Extract => match &self.target {
                Some(target) => tr(
                    lang,
                    format!("将 {} 解压到 {}", self.archive, target),
                    format!("Extract {} to {}", self.archive, target),
                ),
                None => tr(
                    lang,
                    format!("将 {} 解压到当前目录", self.archive),
                    format!("Extract {} into the current directory", self.archive),
                ),
            },
        }
    }

    pub fn impact(&self) -> String {
        self.impact_lang(Lang::Zh)
    }

    pub fn impact_lang(&self, lang: Lang) -> String {
        if self.listing {
            return tr(
                lang,
                "只读取归档目录，不会写入服务器",
                "Reads the archive listing only; nothing is written to the server",
            );
        }
        let overwrite = match self.overwrite {
            ArchiveOverwrite::Always => tr(
                lang,
                "会覆盖目标目录中的同名文件",
                "Overwrites files with the same name in the target directory",
            ),
            ArchiveOverwrite::Never => tr(
                lang,
                "不会覆盖已有文件",
                "Existing files are not overwritten",
            ),
            ArchiveOverwrite::Interactive => tr(
                lang,
                "未指定 -o / -n：遇到同名文件时 unzip 会等待输入，非交互环境可能失败",
                "No -o / -n given: unzip waits for input on name collisions, which can fail without a terminal",
            ),
        };
        match &self.target {
            Some(target) => tr(
                lang,
                format!("{overwrite}；写入范围：{target}"),
                format!("{overwrite}; write scope: {target}"),
            ),
            None => overwrite,
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
    // `~` / 变量 / 命令替换：归档到底指哪个文件无法确定，不猜。
    if value.is_empty() || value.starts_with('~') {
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

/// `LC_ALL=C` / `FOO=bar` 这类局部环境变量：只影响这条命令，不改变它在做什么。
fn is_env_assignment(word: &str) -> bool {
    let Some((name, value)) = word.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && !value.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// 管道 / 条件连接里，能与归档只读命令安全组合的段。
///
/// 只认**确定只读**的过滤器与校验命令：能改写文件（`tee` / 重定向 / `sort -o`）
/// 或能执行其他命令（`awk` / `sed` 的 `e`、`xargs`）的一律不放进来。
fn is_safe_read_segment(words: &[String]) -> bool {
    let Some(first) = words.first() else {
        return true;
    };
    let tool = base_command(first);
    let safe = matches!(
        tool,
        "head"
            | "tail"
            | "grep"
            | "egrep"
            | "fgrep"
            | "wc"
            | "sort"
            | "uniq"
            | "cut"
            | "tr"
            | "cat"
            | "nl"
            | "column"
            | "sha1sum"
            | "sha256sum"
            | "md5sum"
            | "stat"
            | "file"
            | "jq"
            | "xxd"
            | "od"
            | "base64"
            | "iconv"
            | "printenv"
            | "echo"
            | "printf"
            | "true"
            | "false"
            | ":"
    );
    if !safe {
        return false;
    }
    // `sort -o out` 是写文件；`grep -o` 只是"只输出匹配部分"，不能一概拒绝。
    if tool == "sort"
        && words
            .iter()
            .any(|word| word == "-o" || word == "--output" || word.starts_with("--output="))
    {
        return false;
    }
    true
}

/// 解析 `unzip` / `tar` / `zipinfo` 的简单归档操作；无法确定时返回 None。
///
/// 支持 `cd /dir && unzip …`、局部环境变量前缀，以及"归档只读命令 + 只读过滤器"
/// 的常见管道 / 条件连接（`unzip -l x.zip | head`）。变量、通配符、写重定向、
/// 多个归档、认不出作用的额外段一律返回 None —— 由调用方按未知命令保守处理。
pub fn parse_archive_operation(command: &str, cwd: &str) -> Option<ArchiveOperation> {
    let segments = split_segments(command)?;
    if segments.is_empty() {
        return None;
    }
    let mut base_cwd = cwd.to_string();
    let mut archive_words: Option<Vec<String>> = None;
    for segment in &segments {
        let words = shell_words(segment)?;
        let mut start = 0usize;
        while start < words.len() && is_env_assignment(&words[start]) {
            start += 1;
        }
        // 整段只是变量赋值：给后面的命令准备环境，不改变服务器。
        if start >= words.len() {
            continue;
        }
        let tool = base_command(&words[start]);
        if tool == "cd" {
            // 只允许在归档命令之前切一次目录（`cd x && unzip …`）。
            if archive_words.is_some() {
                return None;
            }
            let path = match &words[start + 1..] {
                [path] => path,
                [flag, path] if flag == "--" => path,
                _ => return None,
            };
            base_cwd = resolve_archive_path(path, &base_cwd)?;
            continue;
        }
        if tool == "unzip" || tool == "tar" || tool == "zipinfo" {
            // 同一条命令里出现两个归档操作：不能当成"同一件事"去重。
            if archive_words.is_some() {
                return None;
            }
            archive_words = Some(words[start..].to_vec());
            continue;
        }
        if !is_safe_read_segment(&words[start..]) {
            return None;
        }
    }
    let words = archive_words?;
    /*
     * 引号里的 `$ARCHIVE` / 反引号不会被 `shell_words` 拦下：归档到底指哪个
     * 文件并不确定，不能当成"同一件事"去重，也不能假设它是只读清单。
     */
    if words
        .iter()
        .any(|word| word.contains('$') || word.contains('`'))
    {
        return None;
    }
    let tool = base_command(&words[0]);
    /*
     * **只解析归档工具**。
     *
     * 少了这道门，`docker ps` 会被当成"archive = /srv/app/ps"的归档操作：
     * 第二个词只要不是选项就会被当路径，于是只读查询的摘要会显示成
     * 「解压归档」、影响里还带上覆盖策略。归档判定必须有明确的工具名。
     */
    if tool != "unzip" && tool != "tar" && tool != "zipinfo" {
        return None;
    }
    let mut archive: Option<String> = None;
    let mut target: Option<String> = None;
    let mut overwrite = ArchiveOverwrite::Interactive;
    let mut listing = false;
    let mut kind = ArchiveKind::Extract;
    // `unzip -Z` 等价于 zipinfo：后面的选项按 zipinfo 解释，全部只读。
    let mut zipinfo_mode = tool == "zipinfo";

    let mut index = 1usize;
    while index < words.len() {
        let word = &words[index];
        if word == "--" {
            index += 1;
            continue;
        }
        if word.starts_with('-') && word.len() > 1 {
            if zipinfo_mode {
                if word == "-x" {
                    // `-x <模式>`：排除成员，仍是只读；模式本身不参与签名。
                    index += 2;
                    continue;
                }
                for flag in word.trim_start_matches('-').chars() {
                    match flag {
                        'Z' | '1' | '2' | 'h' | 'l' | 'v' | 'z' | 'T' | 't' | 'm' | 's' | 'M' => {}
                        _ => return None,
                    }
                }
                listing = true;
                if kind == ArchiveKind::Extract {
                    kind = ArchiveKind::List;
                }
                index += 1;
                continue;
            }
            if tool == "unzip" {
                let flags = word.trim_start_matches('-');
                if flags.contains('Z') {
                    // `unzip -Z…`：zipinfo 模式，剩余字符必须都是只读选项。
                    for flag in flags.chars() {
                        match flag {
                            'Z' | '1' | '2' | 'h' | 'l' | 'v' | 'z' | 'T' | 't' | 'm' | 's'
                            | 'M' => {}
                            _ => return None,
                        }
                    }
                    zipinfo_mode = true;
                    listing = true;
                    if kind == ArchiveKind::Extract {
                        kind = ArchiveKind::List;
                    }
                    index += 1;
                    continue;
                }
                if flags == "d" {
                    index += 1;
                    target = Some(words.get(index)?.clone());
                    index += 1;
                    continue;
                }
                for flag in flags.chars() {
                    match flag {
                        'l' => {
                            listing = true;
                            if kind == ArchiveKind::Extract {
                                kind = ArchiveKind::List;
                            }
                        }
                        't' => {
                            listing = true;
                            if kind == ArchiveKind::Extract {
                                kind = ArchiveKind::Verify;
                            }
                        }
                        'p' => {
                            listing = true;
                            kind = ArchiveKind::Read;
                        }
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
                    if kind == ArchiveKind::Extract {
                        kind = ArchiveKind::List;
                    }
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
                let mut extract = false;
                let mut to_stdout = false;
                for flag in flags.chars() {
                    match flag {
                        't' => {
                            listing = true;
                            if kind == ArchiveKind::Extract {
                                kind = ArchiveKind::List;
                            }
                        }
                        'x' => extract = true,
                        // `tar -xOf` / `-xO`：解出来打到 stdout，不落盘。
                        'O' => to_stdout = true,
                        'f' => saw_file = true,
                        'z' | 'j' | 'J' | 'v' | 'p' | 'P' | 'o' => {}
                        'k' => overwrite = ArchiveOverwrite::Never,
                        _ => return None,
                    }
                }
                if extract && to_stdout {
                    listing = true;
                    kind = ArchiveKind::Read;
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
        /*
         * 归档后面还有额外参数（成员名 / 排除模式）：
         * 只读的 `unzip -l/-t/-p`、`tar -t` 允许指定成员；写操作不做等价推断。
         */
        if listing {
            index += 1;
            continue;
        }
        return None;
    }

    let archive = resolve_archive_path(archive.as_deref()?, &base_cwd)?;
    if listing {
        return Some(ArchiveOperation {
            archive,
            target: None,
            overwrite,
            listing: true,
            kind,
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
        kind,
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

/// `sh -c '<正文>'` / `bash -lc '<正文>'` 里**真正执行**的那条命令。
///
/// 返回 `None`：不是 shell 包命令，或者 `-c` 后面没有正文（交互式 shell）。
fn shell_c_inner(segment: &str) -> Option<String> {
    let (first, rest) = take_word(segment);
    if !is_shell_word(first) {
        return None;
    }
    let (flag, payload) = take_word(rest);
    if !matches!(flag, "-c" | "-lc" | "-ic") {
        return None;
    }
    let payload = payload.trim();
    if payload.is_empty() {
        return None;
    }
    Some(unquote(payload))
}

/// 包装器：本身不做事，真正执行的是它**后面**那条命令。
///
/// `env FOO=1 rm -rf /x`、`xargs -0 rm -f`、`nice -n 10 systemctl restart x`
/// 如果只看第一个词，`env` / `xargs` 都在只读表里 —— 写操作就被放行了。
///
/// 返回 `None` = 认得出是包装器，但解析不出它后面那条命令（怪选项 / 只有包装器），
/// 调用方按「无法判断」处理，绝不能当成只读。
fn strip_wrappers(segment: &str) -> Option<&str> {
    let mut current = segment;
    // 包装器套包装器（`env xargs -0 rm`）是有限的，四层足够且防死循环。
    for _ in 0..4 {
        let (word, rest) = take_word(current);
        let rest = rest.trim_start();
        let inner = match base_command(word) {
            "env" => skip_env(rest),
            "xargs" => skip_xargs(rest),
            "command" => skip_command(rest),
            "nice" => skip_options(rest, &["-n", "--adjustment"]),
            "ionice" => skip_options(rest, &["-c", "-n", "-p"]),
            "stdbuf" => skip_options(rest, &["-i", "-o", "-e"]),
            "nohup" | "builtin" | "exec" => skip_options(rest, &[]),
            "timeout" => skip_timeout(rest),
            "time" => skip_options(rest, &[]),
            // 不是包装器：原样返回，后面按普通命令判。
            _ => return Some(current),
        }?;
        // 没有真的剥掉一层（解析不出更多）：不猜，交给上层按"无法判断"处理。
        if inner == current {
            return None;
        }
        current = inner;
    }
    Some(current)
}

fn non_empty(text: &str) -> Option<&str> {
    let trimmed = text.trim_start();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// 剥掉 `env` 的选项目与环境赋值（`-i` / `-u NAME` / `FOO=1`）。
fn skip_env(mut rest: &str) -> Option<&str> {
    rest = rest.trim_start();
    loop {
        let (word, left) = take_word(rest);
        // 只有 `env`：打印环境变量，什么都没改。
        if word.is_empty() {
            return Some("printenv");
        }
        if word == "--" {
            return non_empty(left);
        }
        if word.len() > 1 && word.starts_with('-') {
            rest = left.trim_start();
            // `-u NAME` / `--unset NAME` 会吃掉一个值；`--unset=NAME` 自带值。
            let takes_value = matches!(word, "-u" | "--unset");
            if takes_value {
                let (_, after) = take_word(rest);
                rest = after.trim_start();
            }
            if rest.is_empty() {
                return Some("printenv");
            }
            continue;
        }
        // `FOO=1` 是环境赋值，继续往后找命令。
        if word.contains('=') {
            rest = left.trim_start();
            if rest.is_empty() {
                return Some("printenv");
            }
            continue;
        }
        return Some(rest);
    }
}

/// 剥掉 `xargs` 的选项，返回它要执行的命令（没有命令时是 `echo`）。
fn skip_xargs(mut rest: &str) -> Option<&str> {
    const VALUE_OPTS: &[&str] = &["-n", "-L", "-P", "-s", "-d", "-E", "-a", "-I", "-J"];
    rest = rest.trim_start();
    loop {
        let (word, left) = take_word(rest);
        // `xargs` 不带命令 = `xargs echo`（只把参数打印出来）。
        if word.is_empty() || word == "--" {
            return Some("echo");
        }
        if !word.starts_with('-') {
            return Some(rest);
        }
        rest = left.trim_start();
        if VALUE_OPTS.contains(&word) {
            let (_, after) = take_word(rest);
            rest = after.trim_start();
        }
        if rest.is_empty() {
            return Some("echo");
        }
    }
}

/// `command [-pVv] <命令>`：`-v` / `-V` 是查路径，其余是执行。
fn skip_command(mut rest: &str) -> Option<&str> {
    rest = rest.trim_start();
    let (word, left) = take_word(rest);
    if matches!(word, "-v" | "-V") {
        return Some("which");
    }
    non_empty(left)
}

/// `timeout [-k dur] [-s sig] DURATION <命令>`。
fn skip_timeout(mut rest: &str) -> Option<&str> {
    rest = rest.trim_start();
    loop {
        let (word, left) = take_word(rest);
        if word.is_empty() {
            return None;
        }
        if word.starts_with('-') {
            rest = left.trim_start();
            if matches!(word, "-k" | "-s" | "--kill-after" | "--signal") {
                let (_, after) = take_word(rest);
                rest = after.trim_start();
            }
            continue;
        }
        // 第一个非选项是 DURATION，它后面才是真正要跑的命令。
        return non_empty(left);
    }
}

/// 跳过选项（`takes_value` 里的选项还会吃掉一个值），返回命令起点。
fn skip_options<'a>(mut rest: &'a str, takes_value: &[&str]) -> Option<&'a str> {
    rest = rest.trim_start();
    loop {
        let (word, left) = take_word(rest);
        if word.is_empty() {
            return None;
        }
        if word == "--" {
            return non_empty(left);
        }
        if !word.starts_with('-') {
            return Some(rest);
        }
        rest = left.trim_start();
        if takes_value.contains(&word) {
            let (_, after) = take_word(rest);
            rest = after.trim_start();
        }
        if rest.is_empty() {
            return None;
        }
    }
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
        // 只读的子命令在下面 exclude 列表与写模式里单独排除（get / describe / logs 等）。
        "kubectl",
        "helm",
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

/// 一个命令段的判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SegmentVerdict {
    risk: ToolRisk,
    /// `false` = 这条命令我们**不认识**：风险是按"写"兜底的，不是真的检测到写。
    ///
    /// 界面据此显示「无法判断这条命令会做什么」，而不是「将修改 …」。
    known: bool,
}

impl SegmentVerdict {
    fn read() -> Self {
        Self {
            risk: ToolRisk::Read,
            known: true,
        }
    }

    fn known(risk: ToolRisk) -> Self {
        Self { risk, known: true }
    }

    /// 看不懂的命令：按写兜底，但如实标记"不是检测到写"。
    fn unknown(risk: ToolRisk) -> Self {
        Self { risk, known: false }
    }
}

/// 单个命令段的风险。
fn classify_segment(segment: &str) -> SegmentVerdict {
    match strip_syntax(segment) {
        // 整段只是 shell 语法（`done` / `fi` / `for x in …`）。循环头里仍可能
        // 藏 `$(…)`：`for x in $(rm -rf /tmp/x)` 照样按写算。
        None => {
            let lower = segment.to_ascii_lowercase();
            return if has_unknown_escape(&lower) {
                SegmentVerdict::unknown(ToolRisk::Write)
            } else if has_execution_escape(&lower) {
                SegmentVerdict::known(ToolRisk::Write)
            } else {
                SegmentVerdict::read()
            };
        }
        // 脱掉了 `do` / `then` / `if` / `!` 这类前缀：按剩下那条命令判。
        Some(body) if body != segment.trim() => return classify_segment(body),
        Some(_) => {}
    }

    /*
     * 包装器（`env` / `xargs` / `nice` / `timeout` / `command` / `nohup`…）：
     * 真正执行的是它后面那条命令。先剥掉再判，否则 `env FOO=1 rm -rf /x`
     * 会因为首词 `env` 在只读表里被整条放行。
     */
    match strip_wrappers(segment) {
        Some(inner) if inner != segment.trim() => return classify_segment(inner),
        Some(_) => {}
        // 认得出是包装器却拆不出里面的命令：不猜，按"无法判断"要确认。
        None => return SegmentVerdict::unknown(ToolRisk::Write),
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

    /*
     * 纯变量赋值（`F=/etc/nginx/nginx.conf`）：只是给 shell 记忆一个值，不执行
     * 任何命令。`first_word` 会跳过带 `=` 的词，所以这种段的"命令名"是空的 ——
     * 以前它会落进"不认识的命令"，把 `F=…; sha256sum "$F"` 判成无法判断。
     */
    if first.is_empty() && !words.is_empty() && words.iter().all(|word| word.contains('=')) {
        return SegmentVerdict::read();
    }

    // ---- 只读的归档查看：`unzip -l`、`tar -tf` 不写服务器 ----
    if archive_list_only(segment) {
        return SegmentVerdict::read();
    }

    /*
     * `sudo` 本身不是风险：`sudo grep` 只读、`sudo cp` 与普通 cp 一样是写。
     * 真正定级看**被 sudo 包住的那条命令**；是否允许 sudo 另由 `allow_sudo` 控制。
     */
    if first == "sudo" {
        let Some(words) = shell_words(segment) else {
            // 解析不了 sudo 包住的命令：保守按危险处理，绝不自动放行。
            return SegmentVerdict::known(ToolRisk::Danger);
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
            return SegmentVerdict::known(ToolRisk::Danger);
        }
        let Some(inner) = words.get(index..) else {
            return SegmentVerdict::known(ToolRisk::Danger);
        };
        let inner = inner.join(" ");
        if inner.trim().is_empty() {
            return SegmentVerdict::known(ToolRisk::Write);
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
        return SegmentVerdict::known(ToolRisk::Danger);
    }
    /*
     * `docker exec` 按**里面那条命令**定级。
     *
     * 以前它被写死成"写"，再加上 /etc 的放大规则，`docker exec web sh -c
     * 'grep … /etc/nginx/nginx.conf'` 这种纯读的命令也会被标成"危险 · 修改
     * 系统配置"，用户每次都得点一次「允许本次」。
     */
    if let Some(inner) = docker_exec_inner(segment) {
        return classify_shell_verdict(&inner);
    }
    /*
     * `sh -c '<正文>'` / `bash -lc '<正文>'`：真正执行的是正文，**逐层**按正文
     * 定级。以前它被 `has_execution_escape` 一律当成写，`sh -c 'sha256sum /x'`
     * 也要用户点一次确认。
     */
    if let Some(inner) = shell_c_inner(segment) {
        return classify_shell_verdict(&inner);
    }
    if first == "dd"
        && (lower.contains("of=/dev/")
            || lower.contains("if=/dev/zero")
            || lower.contains("if=/dev/urandom"))
    {
        return SegmentVerdict::known(ToolRisk::Danger);
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
            return SegmentVerdict::known(ToolRisk::Danger);
        }
    }
    if lower.contains("> /dev/sd") || lower.contains("of=/dev/sd") || lower.contains("> /dev/nvme")
    {
        return SegmentVerdict::known(ToolRisk::Danger);
    }
    if lower.contains("chmod 777 /")
        || lower.contains("chown -r /")
        || lower.contains("chmod -r 777 /")
    {
        return SegmentVerdict::known(ToolRisk::Danger);
    }
    if lower.contains("kill -9 1") || lower.contains("killall5") || lower.contains(":(){") {
        return SegmentVerdict::known(ToolRisk::Danger);
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
        return SegmentVerdict::known(ToolRisk::Write);
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
            return SegmentVerdict::known(write_risk);
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
        // Kubernetes / Helm 的写操作：查询（get/describe/logs/top/version）保持只读。
        "kubectl apply",
        "kubectl delete",
        "kubectl exec",
        "kubectl create",
        "kubectl replace",
        "kubectl patch",
        "kubectl edit",
        "kubectl scale",
        "kubectl set ",
        "kubectl label",
        "kubectl annotate",
        "kubectl drain",
        "kubectl cordon",
        "kubectl uncordon",
        "kubectl rollout restart",
        "kubectl rollout undo",
        "kubectl rollout pause",
        "kubectl rollout resume",
        "kubectl cp ",
        "kubectl config set",
        "kubectl config unset",
        "kubectl config use",
        "helm install",
        "helm upgrade",
        "helm uninstall",
        "helm rollback",
        "helm delete",
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
            return SegmentVerdict::known(write_risk);
        }
        if !COMPOSE_READ.contains(&sub.as_str()) {
            // 认不出的子命令：按写兜底，但如实说"判断不了"，不假装知道它在改什么。
            return SegmentVerdict::unknown(ToolRisk::Write);
        }
    }
    let padded = format!("{lower} ");
    for token in WRITE_PATTERNS {
        if padded.contains(token) {
            return SegmentVerdict::known(write_risk);
        }
    }
    if has_write_redirect(segment) {
        return SegmentVerdict::known(write_risk);
    }

    /*
     * 解释器逃逸：首词是 `awk` 也能执行任意命令（`awk 'BEGIN{system("rm -rf /")}'`、
     * `eval`、`| sh`）。只读名单绝不能把它们放过去。
     *
     * 命令替换（`$(…)` / 反引号 / `<(…)`）单独处理：能证明只读的在归一化阶段
     * 就换掉了；剩下的是"里面有写"或"根本解析不了"，都算不了已经确定的写。
     */
    if has_unknown_escape(&lower) {
        return SegmentVerdict::unknown(ToolRisk::Write);
    }
    if has_execution_escape(&lower) {
        return SegmentVerdict::known(ToolRisk::Write);
    }

    /*
     * 只读工具名的**写用法**：`curl`、`redis-cli`、`mysql` 这些命令只看名字
     * 分不出来 —— 真正决定风险的是参数（`-X POST` / `FLUSHALL` / `delete from`）。
     */
    if first == "curl" && curl_writes(segment) {
        return SegmentVerdict::known(ToolRisk::Write);
    }
    if first == "wget" {
        // 下载本身就是往磁盘写文件，没有"只读的 wget"。
        return SegmentVerdict::known(ToolRisk::Write);
    }
    if first == "redis-cli" && !redis_is_read(segment) {
        return SegmentVerdict::known(ToolRisk::Write);
    }
    if matches!(first, "mysql" | "psql") && sql_writes(&lower) {
        return SegmentVerdict::known(ToolRisk::Write);
    }

    if is_read_command(first, second) {
        SegmentVerdict::read()
    } else {
        /*
         * 不认识的命令：**先按写兜底要确认**，但标记成"不认识" —— 界面说的是
         * 「无法判断这条命令会做什么」，不是「将修改服务器」。用户看到的具体
         * 片段由 [`classify_shell_detail`] 带回去。
         */
        SegmentVerdict::unknown(ToolRisk::Write)
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
/// 会命中 `awk 'BEGIN{system(...)}'`、`| sh`、`find . -exec ... \;` —— 这些
/// **明确是在执行一条新命令**，按"确定要执行"处理（要确认，但不是"看不懂"）。
///
/// 命令替换（`$(...)` / 反引号）不在这里：它既可能是纯只读（`$(sha256sum x)`），
/// 也可能藏写操作，由 [`has_unknown_escape`] 单独判成"无法判断"。
fn has_execution_escape(lower: &str) -> bool {
    const NEEDLES: &[&str] = &[
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

/// 有没有**没能证明只读**的命令替换 / 进程替换。
///
/// 归一化（[`normalize_read_substitutions`]）会把可证明只读的替换换成占位符；
/// 走到这里还没被换掉的，说明里面有写操作或者根本解析不出来 —— 两种情况都
/// 不能当成"只读"，但也不该说成"已经确定要修改"，交给上层显示「无法判断」。
fn has_unknown_escape(lower: &str) -> bool {
    lower.contains("$(") || lower.contains('`') || lower.contains("<(")
}

/// 两种逃逸都算：只用来决定"不能放行"，不区分确定 / 不确定。
fn has_any_escape(lower: &str) -> bool {
    has_unknown_escape(lower) || has_execution_escape(lower)
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

/// 一条 shell 命令的判定结果（风险 + 看不懂的片段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellRisk {
    pub risk: ToolRisk,
    /// 无法可靠解析的片段（原文，已截断成一句）。
    ///
    /// `Some` 表示"我们没看懂这段到底会不会改服务器"：仍然要确认，但界面必须
    /// 说「无法判断」，不能描述成"已经确定要修改"。
    pub unknown: Option<String>,
}

/// 整条命令的风险：所有命令段里最危险的那一档。
///
/// 拆分不确定（引号没闭合等）时按写入处理：宁可多问一次，也不能把一条看不懂
/// 的命令当成只读自动执行 —— 但结论会带 `unknown`，界面据此说「无法判断」。
pub fn classify_shell_detail(command: &str) -> ShellRisk {
    /*
     * 命令替换 / 进程替换先归一化：能证明只读的换掉，剩下的说明里面可能有写
     * 或者解析不出来 —— 整条命令按"写 + 无法判断"处理。
     */
    let Some(normalized) = normalize_read_substitutions(command, 0) else {
        return ShellRisk {
            risk: ToolRisk::Write,
            unknown: Some(clip_fragment(command)),
        };
    };
    let Some(parts) = split_segments(&normalized) else {
        return ShellRisk {
            risk: ToolRisk::Write,
            unknown: Some(clip_fragment(command)),
        };
    };
    let mut risk = ToolRisk::Read;
    let mut unknown: Option<String> = None;
    for segment in &parts {
        let verdict = classify_segment(segment);
        risk = risk.max(verdict.risk);
        if !verdict.known && unknown.is_none() {
            // 归一化之后命令替换已经是占位符，这里的原文就是用户真正写的那段。
            unknown = Some(clip_fragment(segment));
        }
    }
    ShellRisk { risk, unknown }
}

/// [`classify_shell_detail`] 的简化版：只要风险档位。
pub fn classify_shell(command: &str) -> ToolRisk {
    classify_shell_detail(command).risk
}

/// 嵌套一层（`sh -c` / `docker exec`）时的判定：只要"这是不是已知行为"。
fn classify_shell_verdict(command: &str) -> SegmentVerdict {
    let detail = classify_shell_detail(command);
    SegmentVerdict {
        risk: detail.risk,
        known: detail.unknown.is_none(),
    }
}

/// 文本片段裁剪：确认卡上只显示一句，不把整条脚本塞进去。
fn clip_fragment(text: &str) -> String {
    const LIMIT: usize = 160;
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= LIMIT {
        return collapsed;
    }
    let head: String = collapsed.chars().take(LIMIT).collect();
    format!("{head}…")
}

/// Expand only substitutions whose entire contents can be proven read-only.
/// Unknown syntax stays subject to approval.
fn normalize_read_substitutions(command: &str, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    let chars: Vec<char> = command.chars().collect();
    let mut output = String::new();
    let mut quote = None;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\\' && quote != Some('\'') {
            output.push(ch);
            i += 1;
            output.push(*chars.get(i)?);
            i += 1;
            continue;
        }
        if ch == '\'' && quote != Some('"') {
            quote = if quote == Some('\'') {
                None
            } else {
                Some('\'')
            };
            output.push(ch);
            i += 1;
            continue;
        }
        if ch == '"' && quote != Some('\'') {
            quote = if quote == Some('"') { None } else { Some('"') };
            output.push(ch);
            i += 1;
            continue;
        }
        /*
         * 命令替换与进程替换：`$(…)`、`<(…)`、反引号。
         *
         * 只有**整段都能证明只读**时才换成占位符；任何一处可能有写就返回 None，
         * 由上层标成「无法判断」。单引号里的不算替换。
         */
        let substitution: Option<(usize, usize, usize)> = if quote == Some('\'') {
            None
        } else if ch == '`' {
            let start = i + 1;
            let mut j = start;
            while j < chars.len() {
                if chars[j] == '\\' {
                    j += 2;
                    continue;
                }
                if chars[j] == '`' {
                    break;
                }
                j += 1;
            }
            if j >= chars.len() {
                return None;
            }
            Some((start, j, j))
        } else if (ch == '$' || (ch == '<' && quote.is_none())) && chars.get(i + 1) == Some(&'(') {
            let start = i + 2;
            let mut j = start;
            let mut level = 1;
            let mut inner_quote = None;
            while j < chars.len() {
                let c = chars[j];
                if c == '\\' && inner_quote != Some('\'') {
                    j += 2;
                    continue;
                }
                if c == '\'' && inner_quote != Some('"') {
                    inner_quote = if inner_quote == Some('\'') {
                        None
                    } else {
                        Some('\'')
                    };
                } else if c == '"' && inner_quote != Some('\'') {
                    inner_quote = if inner_quote == Some('"') {
                        None
                    } else {
                        Some('"')
                    };
                } else if inner_quote.is_none() && c == '(' {
                    level += 1;
                } else if inner_quote.is_none() && c == ')' {
                    level -= 1;
                    if level == 0 {
                        break;
                    }
                }
                j += 1;
            }
            if level != 0 {
                return None;
            }
            Some((start, j, j))
        } else {
            None
        };
        if let Some((start, end, last)) = substitution {
            let inner: String = chars[start..end].iter().collect();
            let clean = normalize_read_substitutions(&inner, depth + 1)?;
            // xargs can launch arbitrary programs; accept only simple checksum consumers.
            for segment in split_segments(&clean)? {
                let body = strip_syntax(&segment).unwrap_or("");
                if first_word(body) == "xargs" {
                    let words = shell_words(body)?;
                    if words.len() != 2
                        || !matches!(words[1].as_str(), "sha256sum" | "sha1sum" | "md5sum")
                    {
                        return None;
                    }
                }
            }
            if classify_shell(&clean) != ToolRisk::Read {
                return None;
            }
            output.push_str("__bls_read_value");
            i = last + 1;
            continue;
        }
        output.push(ch);
        i += 1;
    }
    if quote.is_some() {
        return None;
    }
    // Plain variable assignment after a checked substitution has no command to run.
    let parts = split_segments(&output)?;
    let normalized = parts
        .into_iter()
        .map(|part| {
            let value = part.trim();
            if let Some((name, "__bls_read_value")) = value.split_once('=') {
                if !name.is_empty()
                    && name.chars().enumerate().all(|(i, c)| {
                        c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                    })
                {
                    return ":".to_string();
                }
            }
            part
        })
        .collect::<Vec<_>>()
        .join("; ");
    Some(normalized)
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
    describe_operation_lang(command, risk, path, Lang::Zh)
}

pub fn describe_operation_lang(
    command: &str,
    risk: ToolRisk,
    path: Option<&str>,
    lang: Lang,
) -> Option<String> {
    if risk == ToolRisk::Read {
        return None;
    }
    let lower = command.to_ascii_lowercase();

    // 写文件：按文件用途说人话（Nginx / 日志轮转 / Compose / 定时任务）。
    if let Some(path) = path {
        let file = path.rsplit('/').next().unwrap_or(path);
        let file_lower = file.to_ascii_lowercase();
        if lower.contains("nginx") || path.contains("/nginx/") || file_lower.contains("nginx") {
            return Some(tr(
                lang,
                format!("更新 Nginx 配置 {file}"),
                format!("Update Nginx config {file}"),
            ));
        }
        if file_lower.contains("logrotate") {
            return Some(tr(
                lang,
                format!("更新日志轮转配置 {file}"),
                format!("Update logrotate config {file}"),
            ));
        }
        if file_lower.contains("compose") {
            return Some(tr(
                lang,
                format!("更新 Compose 配置 {file}"),
                format!("Update Compose config {file}"),
            ));
        }
        if file_lower.contains("cron") {
            return Some(tr(
                lang,
                format!("更新定时任务 {file}"),
                format!("Update cron job {file}"),
            ));
        }
        return Some(tr(
            lang,
            format!("更新文件 {file}"),
            format!("Update file {file}"),
        ));
    }

    // 命令：先认出"动了谁"，再给动词。
    if lower.contains("nginx -s reload")
        || (lower.contains("systemctl") && lower.contains("nginx") && lower.contains("reload"))
    {
        return Some(tr(lang, "重载 Nginx", "Reload Nginx"));
    }
    if lower.contains("docker compose") || lower.contains("docker-compose") {
        let (zh, en) = if lower.contains(" down") {
            ("停止 Compose 项目", "Stop Compose project")
        } else if lower.contains("restart") {
            ("重启 Compose 项目", "Restart Compose project")
        } else {
            ("更新 Compose 项目", "Update Compose project")
        };
        return Some(tr(lang, zh, en));
    }
    if let Some((verb, service)) = service_change(&lower, lang) {
        return Some(format!("{verb} {service}"));
    }
    if lower.contains("rm ") || lower.contains("rm -") {
        return Some(tr(lang, "删除文件", "Delete files"));
    }
    if lower.contains("chmod") || lower.contains("chown") {
        return Some(tr(lang, "修改文件权限", "Change file permissions"));
    }
    /*
     * 归档命令按**真实动作**命名，不能一律叫「解压归档」：
     * `unzip -l` 是看清单、`-t` 是校验、`-p` 是读内容；只有真正落盘的才叫解压。
     * 发布后的复合检查（curl 站点 + `unzip -p` 读线上文件）按主要目的显示
     * 「验证发布结果」。
     */
    /*
     * 归档命令按**真实动作**命名。
     *
     * 只有真正的命令段（段首词）是 unzip / tar / zipinfo 才进这一支：
     * 文件名、备注、grep 的匹配串里出现 "unzip" 不代表这条命令在动归档。
     */
    let archive_tool = split_command_segments(command).iter().any(|segment| {
        let mut words = segment.split_whitespace();
        let Some(first) = words.next().map(base_command) else {
            return false;
        };
        matches!(first, "unzip" | "tar" | "zipinfo")
    });
    if archive_tool {
        let network_check = lower.contains("curl ") || lower.contains("wget ");
        // 复合命令解析不了（多段 / 管道），先按"线上验证"这个主要目的命名。
        if network_check && lower.contains("unzip -p") {
            return Some(tr(lang, "验证发布结果", "Verify the published result"));
        }
        if let Some(op) = parse_archive_operation(command, "/") {
            // 有写重定向时不能叫"读取归档内容"：它确实往磁盘写了文件。
            if has_write_redirect(command) {
                return Some(tr(
                    lang,
                    "读取归档内容并写入文件",
                    "Read from archive and write a file",
                ));
            }
            return Some(op.summary_lang(lang));
        }
        if has_write_redirect(command) {
            return Some(tr(
                lang,
                "读取归档内容并写入文件",
                "Read from archive and write a file",
            ));
        }
        let segments = split_command_segments(command);
        let mut label: Option<(&'static str, &'static str)> = None;
        for segment in &segments {
            let segment = segment.trim_start();
            let segment = segment.strip_prefix("if ").unwrap_or(segment);
            let mut words = segment.split_whitespace();
            let Some(tool) = words.next().map(base_command) else {
                continue;
            };
            let options = words.take_while(|word| word.starts_with('-'));
            let flags = options.collect::<Vec<_>>().join("");
            match tool {
                "zipinfo" => {
                    label.get_or_insert(("查看归档清单", "List archive contents"));
                }
                "unzip" if flags.contains('l') || flags.contains('Z') => {
                    label.get_or_insert(("查看归档清单", "List archive contents"));
                }
                "unzip" if flags.contains('t') => {
                    label = Some(("校验归档", "Validate archive"));
                }
                "unzip" if flags.contains('p') => {
                    label = Some(("读取归档内容", "Read archive contents"));
                }
                "tar" if flags.contains('t') || flags.contains("--list") => {
                    label.get_or_insert(("查看归档清单", "List archive contents"));
                }
                "unzip" if !flags.contains('c') && !flags.contains('z') => {
                    return Some(tr(lang, "解压归档", "Extract archive"));
                }
                "tar" if flags.contains('x') => {
                    return Some(tr(lang, "解压归档", "Extract archive"));
                }
                _ => {}
            }
        }
        let (zh, en) = label.unwrap_or(("处理归档", "Inspect archive operation"));
        return Some(tr(lang, zh, en));
    }
    if lower.contains("mkdir") {
        return Some(tr(lang, "创建目录", "Create directory"));
    }
    if lower.contains("cp ") || lower.contains("mv ") {
        return Some(tr(lang, "复制或移动文件", "Copy or move files"));
    }

    let first = first_word(command);
    if first.is_empty() {
        return None;
    }
    Some(tr(lang, format!("执行 {first}"), format!("Run {first}")))
}

/// 归档命令的失败特征（缺包 / 坏包）。
///
/// 管道把退出码吞掉、或 shell 不支持 `pipefail` 时，只有 stderr 还留着真相：
/// `unzip` 打不开包时退出码未必可靠，但一定会说"找不到 / 不是 zip / 结构坏了"。
pub fn archive_error_hint(command: &str, stderr: &str) -> Option<&'static str> {
    archive_error_hint_lang(command, stderr, Lang::Zh)
}

pub fn archive_error_hint_lang(command: &str, stderr: &str, lang: Lang) -> Option<&'static str> {
    let lower = command.to_ascii_lowercase();
    if !lower.contains("unzip") && !lower.contains("tar ") && !lower.trim_start().starts_with("tar")
    {
        return None;
    }
    let error = stderr.to_ascii_lowercase();
    for (needle, zh, en) in [
        (
            "cannot find or open",
            "归档文件不存在或无法打开",
            "archive not found or cannot be opened",
        ),
        (
            "end-of-central-directory",
            "ZIP 结构损坏（找不到中央目录）",
            "corrupt ZIP structure (central directory not found)",
        ),
        (
            "not a zipfile",
            "不是有效的 ZIP 文件",
            "not a valid ZIP file",
        ),
        (
            "bad zipfile",
            "ZIP 文件损坏（bad zipfile）",
            "corrupt ZIP file (bad zipfile)",
        ),
        (
            "unexpected end of file",
            "归档内容被截断",
            "archive content is truncated",
        ),
        (
            "cannot open",
            "归档文件无法打开",
            "archive cannot be opened",
        ),
    ] {
        if error.contains(needle) {
            return Some(match lang {
                Lang::Zh => zh,
                Lang::En => en,
            });
        }
    }
    None
}

/// 只读读取归档内容却**什么都没读到**：不能算成功。
///
/// `unzip -p` 在某些路径下会以 0 退出（例如管道把上游失败吞掉、或镜像里是
/// 空文件）；一句"成功"会让计划步骤凭假证据完成。这里只在**没有管道**时
/// 判定（有管道时输出经过 grep / head 过滤，空输出是正常的）。
pub fn archive_read_is_empty(command: &str, stdout: &str) -> bool {
    if command.contains('|') || !stdout.trim().is_empty() {
        return false;
    }
    matches!(
        parse_archive_operation(command, "/").map(|op| op.kind),
        Some(ArchiveKind::Read)
    )
}

/// `systemctl restart nginx` → `("重启", "nginx")`。
fn service_change(lower: &str, lang: Lang) -> Option<(String, String)> {
    if !lower.contains("systemctl") && !lower.contains("service ") {
        return None;
    }
    for (needle, zh, en) in [
        ("restart", "重启服务", "Restart service"),
        ("reload", "重载服务", "Reload service"),
        ("start", "启动服务", "Start service"),
        ("stop", "停止服务", "Stop service"),
        ("enable", "设置开机启动", "Enable service at boot"),
        ("disable", "取消开机启动", "Disable service at boot"),
    ] {
        let mut words = lower.split_whitespace();
        while let Some(word) = words.next() {
            if word == needle {
                if let Some(service) = words.next() {
                    return Some((
                        tr(lang, zh, en),
                        service.trim_end_matches(".service").to_string(),
                    ));
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
        if classify_segment(segment).risk == ToolRisk::Read {
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
    describe_impact_lang(command, risk, Lang::Zh)
}

pub fn describe_impact_lang(command: &str, risk: ToolRisk, lang: Lang) -> Option<String> {
    if risk == ToolRisk::Read {
        return None;
    }
    let lower = command.to_ascii_lowercase();
    let reasons: Vec<String> = [
        (
            lower.contains("sudo"),
            "以 root 权限执行",
            "Runs with root privileges",
        ),
        (
            lower.contains("rm -rf /") || lower.contains("rm -fr /"),
            "删除根目录下的内容，系统可能无法启动",
            "Deletes content under the filesystem root; the system may no longer boot",
        ),
        (
            lower.contains("mkfs") || lower.contains("mkswap"),
            "格式化文件系统，数据不可恢复",
            "Formats a filesystem; data cannot be recovered",
        ),
        (
            lower.contains("iptables")
                || lower.contains("ip6tables")
                || lower.contains("nft")
                || lower.contains("ufw"),
            "修改防火墙规则，可能切断当前连接",
            "Changes firewall rules and may cut the current connection",
        ),
        (
            writes_etc(command),
            "修改系统配置（/etc 下的文件）",
            "Changes system configuration under /etc",
        ),
        (
            lower.contains("reboot") || lower.contains("shutdown") || lower.contains("poweroff"),
            "重启或关闭服务器",
            "Reboots or powers off the server",
        ),
        (
            lower.contains("> /dev/sd") || lower.contains("dd "),
            "直接写块设备，数据不可恢复",
            "Writes directly to a block device; data cannot be recovered",
        ),
        (
            lower.contains("docker compose down"),
            "停止并删除 compose 项目的容器",
            "Stops and removes the Compose project's containers",
        ),
        (
            lower.contains("systemctl stop"),
            "停止系统服务",
            "Stops a system service",
        ),
        (
            lower.contains("passwd") || lower.contains("userdel"),
            "修改系统账号",
            "Changes a system account",
        ),
    ]
    .into_iter()
    .filter(|(hit, _, _)| *hit)
    .map(|(_, zh, en)| tr(lang, zh, en))
    .collect();

    if !reasons.is_empty() {
        return Some(reasons.join(clause_sep(lang)));
    }
    if lower.contains("nginx -s reload") || lower.contains("reload nginx") {
        return Some(tr(
            lang,
            "重载 Nginx 配置：不中断现有连接，新请求会短暂排队",
            "Reloads the Nginx configuration without dropping connections; new requests may queue briefly",
        ));
    }
    if lower.contains("rm ") || lower.contains("rm -") {
        return Some(tr(
            lang,
            "删除服务器上的文件，删掉后不会进回收站",
            "Deletes files on the server; they do not go to a recycle bin",
        ));
    }
    if lower.contains("chmod") || lower.contains("chown") {
        return Some(tr(
            lang,
            "修改文件权限或属主，可能影响服务读取",
            "Changes file permissions or ownership, which may affect service access",
        ));
    }
    if lower.contains("cp ") || lower.contains("mv ") {
        return Some(tr(
            lang,
            "覆盖或移动服务器上的文件",
            "Overwrites or moves files on the server",
        ));
    }
    if lower.contains("mkdir") {
        return Some(tr(
            lang,
            "在服务器上创建目录",
            "Creates a directory on the server",
        ));
    }
    if lower.contains("tar ") || lower.contains("unzip") {
        return Some(tr(
            lang,
            "解压归档，同名文件会被覆盖",
            "Extracts an archive; files with the same name are overwritten",
        ));
    }
    if lower.contains("systemctl") || lower.contains("service ") {
        return Some(tr(
            lang,
            "改变系统服务的运行状态，可能短暂中断访问",
            "Changes a system service's state; access may be briefly interrupted",
        ));
    }
    if lower.contains("docker") {
        return Some(tr(
            lang,
            "改变容器或 Compose 项目的运行状态",
            "Changes the state of containers or the Compose project",
        ));
    }
    Some(tr(
        lang,
        "影响未知：无法判断这条命令会改什么，请展开详情核对后再确认",
        "Unknown impact: this command's effect cannot be determined; review the details before confirming",
    ))
}

/// 管道里出现归档命令时，必须让 shell 传播**其中一段**的失败。
///
/// `unzip -o dist.zip -d /var/www | tail -n 5` 的退出码是 `tail` 的：解压失败
/// （缺包 / 坏包 / 非零退出）也会被当成成功。bash / zsh 支持 `pipefail`，dash
/// 不支持 —— 所以用 `(set -o pipefail) 2>/dev/null` 先探测再启用，不能直接把
/// 失败写到 stderr 里吓用户。
fn archive_pipeline_needs_pipefail(command: &str) -> bool {
    if !command.contains('|') {
        return false;
    }
    let lower = command.to_ascii_lowercase();
    lower.contains("unzip") || lower.contains("tar ") || lower.trim_start().starts_with("tar ")
}

/// 把命令包进"切到 cwd → 执行 → 回读 pwd → 保留退出码"的外壳。
///
/// 不切目录就不知道模型现在在哪：`cd /var/www && ls` 之后下一条命令仍然要在
/// `/var/www` 里跑，所以每条都显式 `cd` 到上次回读到的目录。
pub fn wrap_with_cwd(cwd: &str, command: &str) -> String {
    let body = if archive_pipeline_needs_pipefail(command) {
        // 只对归档管道启用：其它管道（`grep -q` / `head`）的"没匹配到"是正常
        // 结果，全局打开 pipefail 会把探测步骤误判成失败。
        format!("if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi\n{command}")
    } else {
        command.to_string()
    };
    format!(
        "if ! cd {cwd}; then printf '\\n{MISSING}\\n'; exit 98; fi\n{command}\n__bls_rc=$?\nprintf '\\n{PWD}%s\\n' \"$PWD\"\nexit $__bls_rc",
        cwd = shell_quote(cwd),
        MISSING = PWD_FAIL_MARKER,
        PWD = PWD_MARKER,
        command = body
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
    severe_operation_reason_lang(planned, Lang::Zh)
}

pub fn severe_operation_reason_lang(planned: &PlannedTool, lang: Lang) -> Option<String> {
    /*
     * MCP 工具的影响来自第三方声明，平台没有独立验证手段：
     * * 声明可写 / 声明与参数冲突 → 即便「完全权限」也要用户确认；
     * * 声明只读且无写入信号 → 按只读执行（仍会在调用前复查声明是否变化）。
     *
     * 这里不能用 `planned.call.risk` 反推：风险正是由这个函数参与决定的。
     */
    if let Some(binding) = planned.mcp.as_ref() {
        match binding.effect() {
            // 声明只读且无写入信号：不再拿 `MCP · 服务 · 工具` 这行展示文本
            // 去套 shell 的 `/etc` / 服务名规则，避免把只读调用误报成严重操作。
            crate::mcp::McpEffect::DeclaredReadOnly => return None,
            crate::mcp::McpEffect::Write => {
                return Some(tr(
                    lang,
                    "第三方 MCP 工具声明可能写入；平台无法独立验证，执行前请核对",
                    "The third-party MCP tool declares a possible write; the platform cannot verify it independently, so review it before running",
                ));
            }
            crate::mcp::McpEffect::Unknown => {
                return Some(tr(
                    lang,
                    "该 MCP 工具的只读声明与名称 / 参数冲突，影响未知，执行前请核对",
                    "This MCP tool's read-only claim conflicts with its name/parameters; the effect is unknown, so review it before running",
                ));
            }
        }
    }
    /*
     * 看不懂的命令：**不猜**它动了什么。
     *
     * 这里给一句中性原因（"有无法解析的部分"），而不是按 `/etc` / 动词去猜
     * "会修改系统配置" —— 猜错就是把一次只读查询说成危险操作。
     */
    if planned.unknown.is_some() {
        return Some(tr(
            lang,
            "命令里有无法解析的部分，执行前请核对原文",
            "Part of the command could not be parsed; review it before approving",
        ));
    }
    let display = planned.display.trim();
    let lower = display.to_lowercase();
    let words = shell_words(display).unwrap_or_default();
    let first = words.first().map(|word| base_command(word)).unwrap_or("");

    if planned.path.as_deref().is_some_and(is_critical_config_path) {
        return Some(tr(
            lang,
            "会修改 SSH / 防火墙 / 系统启动相关配置，可能导致失联",
            "Changes SSH / firewall / boot configuration and may cut off access",
        ));
    }
    // 用 /tmp 当占位 cwd：只有显式 `-d /` 或 `cd /` 才会被判成系统目录，
    // 相对路径的普通解压不能因为这里拿不到真实 cwd 就误升级。
    if let Some(archive) = parse_archive_operation(&planned.display, "/tmp") {
        if archive
            .target
            .as_deref()
            .is_some_and(|target| matches!(target, "/" | "/etc" | "/usr" | "/boot" | "/dev"))
        {
            return Some(tr(
                lang,
                "会把归档直接解压到系统关键目录，可能覆盖系统文件",
                "Extracts the archive into a critical system directory, possibly overwriting system files",
            ));
        }
    }

    if matches!(first, "shutdown" | "reboot" | "poweroff" | "halt")
        || words
            .iter()
            .any(|word| word == "shutdown" || word == "reboot")
    {
        return Some(tr(
            lang,
            "会关机或重启服务器，正在运行的服务会中断",
            "Powers off or reboots the server; running services will be interrupted",
        ));
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
        return Some(tr(
            lang,
            "会直接写入磁盘 / 分区，数据可能不可恢复",
            "Writes directly to a disk or partition; data may be unrecoverable",
        ));
    }
    if lower.contains("shred ") || (lower.contains("find ") && lower.contains(" -delete")) {
        return Some(tr(
            lang,
            "会不可恢复地删除大量文件",
            "Deletes many files irreversibly",
        ));
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
        return Some(tr(
            lang,
            "会改变系统权限 / 账号或终止关键进程，可能导致失联",
            "Changes system permissions/accounts or kills critical processes, possibly cutting off access",
        ));
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
            return Some(tr(
                lang,
                "删除范围覆盖系统或整个业务根目录，数据可能不可恢复",
                "The delete covers a system or business root directory; data may be unrecoverable",
            ));
        }
    }
    if lower.contains("iptables")
        || lower.contains("nft ")
        || lower.contains("ufw ")
        || lower.contains("firewall-cmd")
    {
        return Some(tr(
            lang,
            "会修改防火墙规则，可能断开当前 SSH 连接",
            "Changes firewall rules and may drop the current SSH connection",
        ));
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
            return Some(tr(
                lang,
                "会停止 / 重启网络或 SSH 等核心共享服务，可能中断所有连接",
                "Stops or restarts a core shared service such as networking or SSH, possibly dropping every connection",
            ));
        }
    }
    if lower.contains("/etc/ssh/")
        || lower.contains("/etc/sudoers")
        || lower.contains("/etc/network/")
        || lower.contains("/etc/resolv.conf")
    {
        return Some(tr(
            lang,
            "会修改 SSH / 网络相关配置，可能导致失联",
            "Changes SSH or network configuration and may cut off access",
        ));
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
        && (!full_permissions
            // 看不懂的命令永远要确认：完全权限只放行**已确定**的日常写入。
            || planned.unknown.is_some()
            || severe_operation_reason(planned).is_some())
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
    plan_tool_for_locale(name, args, cwd, stamp, backup, Lang::Zh)
}

/// 界面语言版本的规划：摘要 / 影响 / 错误按 `lang` 生成。
///
/// 工具身份（命令、路径、风险、备份）与语言无关，不会被翻译影响。
pub fn plan_tool_for_locale(
    name: &str,
    args: &Value,
    cwd: &str,
    stamp: u64,
    backup: &BackupPolicy,
    lang: Lang,
) -> Result<PlannedTool, String> {
    let tool = name.trim();
    /// 无法可靠解析的片段（只有 `run_shell` 会有）。
    let mut unknown: Option<String> = None;
    /// 模型自述（目的 / 预期 / 只读还是改动）。
    let mut declared: Option<DeclaredOp> = None;
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
                    return Err(tr(lang, "command 不能为空", "command must not be empty"));
                }
                if raw.len() > 32 * 1024 {
                    return Err(tr(
                        lang,
                        "单条命令过长（上限 32 KB）",
                        "command is too long (limit 32 KB)",
                    ));
                }
                if raw.contains('\0') {
                    return Err(tr(
                        lang,
                        "command 不能包含空字符",
                        "command must not contain NUL characters",
                    ));
                }
                let cwd = match args.get("cwd").and_then(Value::as_str) {
                    Some(value) => absolute_path(value, "cwd")?,
                    None => cwd.to_string(),
                };
                let classification = classify_shell_detail(&raw);
                let risk = classification.risk;
                let archive = parse_archive_operation(&raw, &cwd);
                /*
                 * 看不懂的命令：**如实说看不懂**。
                 *
                 * 风险还是按写处理（要用户确认），但摘要不能写成"将修改 …"——
                 * 那是在替用户断言一件我们并不知道的事。归档命令解析成功时
                 * 以归档动作为准（它是确定的）。
                 */
                let parsed_unknown = classification.unknown.clone().filter(|_| archive.is_none());
                let mut impact = match &parsed_unknown {
                    Some(_) => Some(tr(
                        lang,
                        "影响无法判断：命令里有解析不了的部分，执行前请核对下面的原文",
                        "Impact cannot be determined: part of the command could not be parsed; review the command below before approving",
                    )),
                    None => archive
                        .as_ref()
                        .map(|op| op.impact_lang(lang))
                        .or_else(|| describe_impact_lang(&raw, risk, lang)),
                };
                let summary = match &parsed_unknown {
                    Some(fragment) => Some(tr(
                        lang,
                        format!(
                            "无法判断这条命令会做什么：`{fragment}`（按写入处理，需要确认；请拆成多条可核对的命令或改用明确的绝对路径）"
                        ),
                        format!(
                            "Cannot tell what this command does: `{fragment}` (treated as a write, so it needs approval; split it into verifiable commands or use explicit absolute paths)"
                        ),
                    )),
                    None => archive
                        .as_ref()
                        .map(|op| op.summary_lang(lang))
                        .or_else(|| describe_operation_lang(&raw, risk, None, lang)),
                };
                unknown = parsed_unknown;
                /*
                 * 模型自述：**只影响话术与冲突反馈**，不改变风险判定。
                 *
                 * 写了 purpose 就把它补进影响说明 —— 确认卡上既能看到平台的
                 * 判定（"删除文件"），也能看到 AI 说这一步要做什么。
                 */
                declared = declared_op(args);
                if let Some(purpose) = declared.as_ref().and_then(|item| item.purpose.as_deref()) {
                    if risk != ToolRisk::Read {
                        let expect = declared.as_ref().and_then(|item| item.expect.as_deref());
                        let line = match expect {
                            Some(expect) => tr(
                                lang,
                                format!("这一步要做：{purpose}（预期：{expect}）"),
                                format!("This step: {purpose} (expected: {expect})"),
                            ),
                            None => tr(
                                lang,
                                format!("这一步要做：{purpose}"),
                                format!("This step: {purpose}"),
                            ),
                        };
                        impact = Some(match impact {
                            Some(text) if !text.is_empty() => {
                                format!("{line}{}{text}", clause_sep(lang))
                            }
                            _ => line,
                        });
                    }
                }
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
                                return Err(tr(
                                    lang,
                                    "删除前需要备份，但无法确定要删除的路径：请改成明确的绝对路径，或在权限页关闭「删除前备份」。",
                                    "Backup-before-delete is on, but the deleted path cannot be determined: use explicit absolute paths, or turn off \"Back up before delete\" on the Permissions page.",
                                ));
                            }
                            let note = tr(
                                lang,
                                "未能确定目标文件，本次未创建备份",
                                "The target file could not be determined, so no backup was created",
                            );
                            impact = Some(match impact {
                                Some(text) if !text.is_empty() => {
                                    format!("{text}{}{note}", clause_sep(lang))
                                }
                                _ => note,
                            });
                        } else {
                            let prefix =
                                shell_backup_script(&targets, stamp, backup.retention_days);
                            script = format!("{prefix}{raw}");
                            backup_path = Some(format!("{}{}{}", targets[0], BACKUP_MARK, stamp));
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
                let impact = (risk != ToolRisk::Read).then(|| {
                    tr(
                        lang,
                        "这个文件通常包含凭据或私钥，内容会发给模型",
                        "This file usually contains credentials or a private key; its content is sent to the model",
                    )
                });
                let summary = describe_operation_lang("", risk, Some(&path), lang);
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
                    return Err(tr(
                        lang,
                        format!(
                            "content 过大（上限 {} KB）；大文件请用 run_shell 分块写入",
                            MAX_WRITE_BYTES / 1024
                        ),
                        format!(
                            "content is too large (limit {} KB); write large files in chunks with run_shell",
                            MAX_WRITE_BYTES / 1024
                        ),
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
                    Some(_) => tr(
                        lang,
                        "如有原文件，将先备份再覆盖",
                        "If the file exists, it is backed up before being overwritten",
                    ),
                    None => tr(
                        lang,
                        "此操作未备份：未启用备份（权限页已关闭修改前备份）",
                        "No backup for this write: backup-before-write is off on the Permissions page",
                    ),
                };
                let impact = if risk == ToolRisk::Danger {
                    Some(tr(
                        lang,
                        format!("会覆盖系统目录下的文件 {path}（{backup_note}）"),
                        format!("Overwrites {path} under a system directory ({backup_note})"),
                    ))
                } else {
                    Some(tr(
                        lang,
                        format!("会覆盖 {path}（{backup_note}）"),
                        format!("Overwrites {path} ({backup_note})"),
                    ))
                };
                let rollback = backup.as_ref().map(|plan| plan.rollback.clone());
                let backup_path = backup.as_ref().map(|plan| plan.path.clone());
                let summary = describe_operation_lang("", risk, Some(&path), lang);
                (
                    "write_file",
                    risk,
                    command,
                    tr(lang, format!("写入 {path}"), format!("Write {path}")),
                    summary,
                    60,
                    Some(path),
                    impact,
                    rollback,
                    backup_path,
                )
            }
            other => {
                return Err(tr(
                    lang,
                    format!("未知工具：{other}"),
                    format!("Unknown tool: {other}"),
                ))
            }
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
        unknown,
        declared,
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
        // 引号里的变量同样无法确定归档身份：保守按写处理，不算是只读清单。
        assert!(parse_archive_operation("unzip -p \"$ARCHIVE\" index.html", "/srv/app").is_none());
        assert_eq!(
            classify_shell("unzip -p \"$ARCHIVE\" index.html"),
            ToolRisk::Write
        );
        // `~` 展开由 shell 决定，不当成绝对路径。
        assert!(parse_archive_operation("unzip -l ~/dist.zip", "/root").is_none());
    }

    #[test]
    fn zipinfo_and_unzip_z_are_read_only_listing() {
        assert!(archive_list_only("zipinfo -1 /srv/app/dist.zip"));
        assert!(archive_list_only("zipinfo -h /srv/app/dist.zip"));
        assert!(archive_list_only("unzip -Z1 /srv/app/dist.zip"));
        assert_eq!(
            classify_shell("zipinfo -1 /srv/app/dist.zip"),
            ToolRisk::Read
        );
        assert_eq!(
            classify_shell("unzip -Z -1 /srv/app/dist.zip"),
            ToolRisk::Read
        );
        // 认不出的选项不当作只读：交给未知 / 确认，不盲目放行。
        assert!(parse_archive_operation("zipinfo -w /srv/app/dist.zip", "/srv/app").is_none());
    }

    #[test]
    fn read_only_pipelines_keep_the_archive_identity() {
        let piped = signature("cd /tmp && unzip -l dist.zip | head");
        let plain = signature("unzip -l /tmp/dist.zip");
        assert_eq!(piped, plain);

        // 归档只读命令与常见只读过滤器组合：整条仍是只读。
        for command in [
            "cd /tmp && unzip -l dist.zip | head",
            "unzip -p /tmp/dist.zip index.html | grep -n root",
            "tar -tzf /tmp/dist.zip | sort | uniq | wc -l",
            "LC_ALL=C sort /tmp/list.txt",
            "unzip -l /tmp/dist.zip | sha256sum",
        ] {
            assert_eq!(classify_shell(command), ToolRisk::Read, "{command}");
        }
    }

    #[test]
    fn archive_content_written_to_a_file_is_not_read_only() {
        // `unzip -p` 本身只读，但重定向让它真的落盘了 —— 必须按写处理。
        let command = "unzip -p /tmp/dist.zip index.html > /srv/index.html";
        assert!(!archive_list_only(command));
        assert_eq!(classify_shell(command), ToolRisk::Write);
        assert!(parse_archive_operation(command, "/tmp").is_none());

        // 只读清单 + 写操作 / 无法确定作用的段：不做等价推断。
        assert!(
            parse_archive_operation("unzip -l /tmp/dist.zip > /srv/list.txt", "/tmp").is_none()
        );
        assert!(parse_archive_operation("unzip -l /tmp/dist.zip | xargs rm", "/tmp").is_none());
    }

    #[test]
    fn env_prefix_does_not_hide_the_archive_command() {
        let op = parse_archive_operation("LC_ALL=C unzip -l /tmp/dist.zip", "/tmp")
            .expect("env prefix should not hide unzip");
        assert!(op.listing);
        assert_eq!(op.kind, ArchiveKind::List);
        assert_eq!(
            classify_shell("LC_ALL=C unzip -l /tmp/dist.zip"),
            ToolRisk::Read
        );
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
        let only_files = filter_tool_schemas(tool_schemas(false), Some(&["files".to_string()]));
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

#[cfg(test)]
mod shell_risk_tests {
    use super::*;
    use serde_json::json;

    fn risk(command: &str) -> ToolRisk {
        classify_shell(command)
    }

    fn unknown(command: &str) -> Option<String> {
        classify_shell_detail(command).unknown
    }

    /* ---------------- 确定只读：直接执行，不确认 ---------------- */

    #[test]
    fn checksum_and_docker_inspection_are_read_only() {
        for command in [
            "sha256sum /etc/nginx/nginx.conf",
            "docker ps",
            "docker ps -a",
            "docker inspect web",
            "docker inspect --format '{{json .Mounts}}' web",
            "sha256sum /srv/app/dist.zip",
        ] {
            assert_eq!(risk(command), ToolRisk::Read, "{command}");
            assert!(unknown(command).is_none(), "{command}");
        }
    }

    #[test]
    fn pipelines_loops_conditionals_and_assignments_stay_read_only() {
        for command in [
            "docker ps | grep web",
            "docker ps | awk '{print $1}' | head -n 5",
            "for f in /etc/nginx/conf.d/*.conf; do sha256sum \"$f\"; done",
            "if [ -f /srv/app/index.html ]; then docker inspect web; fi",
            "cd /srv/app && sha256sum index.html",
            "F=/etc/nginx/nginx.conf; sha256sum \"$F\"",
            "docker ps && echo ok || echo failed",
            "while read -r line; do echo \"$line\"; done < /tmp/list",
        ] {
            assert_eq!(risk(command), ToolRisk::Read, "{command}");
            assert!(unknown(command).is_none(), "{command}");
        }
    }

    #[test]
    fn read_only_substitutions_are_expanded_not_flagged() {
        for command in [
            "echo \"$(sha256sum /x)\"",
            "echo `docker ps`",
            "cat <(docker ps)",
            "diff <(docker ps) <(docker ps -a)",
            "sha256sum /x | xargs -r sha256sum",
        ] {
            assert_eq!(risk(command), ToolRisk::Read, "{command}");
        }
    }

    #[test]
    fn nested_shell_bodies_are_classified_layer_by_layer() {
        assert_eq!(risk("sh -c 'sha256sum /x'"), ToolRisk::Read);
        assert_eq!(risk("bash -lc 'docker ps'"), ToolRisk::Read);
        assert_eq!(risk("docker exec web sh -c 'sha256sum /x'"), ToolRisk::Read);
        assert_eq!(risk("sh -c 'rm -f /tmp/x'"), ToolRisk::Write);
        assert_eq!(
            risk("docker exec web sh -c 'rm -f /tmp/x'"),
            ToolRisk::Write
        );
    }

    /* ---------------- 混合命令：按真正执行的那一段 ---------------- */

    #[test]
    fn mixed_commands_only_escalate_for_the_writing_part() {
        let detail = classify_shell_detail("sha256sum /x && rm -f /tmp/y");
        assert_eq!(detail.risk, ToolRisk::Write);
        assert!(detail.unknown.is_none(), "写操作是确定的，不该说无法判断");

        // 同一个只读动词排在写操作后面也一样。
        let detail = classify_shell_detail("rm -f /tmp/y; sha256sum /x");
        assert_eq!(detail.risk, ToolRisk::Write);
        assert!(detail.unknown.is_none());
    }

    /* ---------------- 无法判断：带片段，不说成"确定要改" ---------------- */

    #[test]
    fn unknown_commands_are_reported_with_their_fragment() {
        let detail = classify_shell_detail("frobnicate --do-stuff /srv/app");
        assert_eq!(detail.risk, ToolRisk::Write, "按写兜底，仍要确认");
        let fragment = detail.unknown.expect("必须带片段");
        assert!(fragment.contains("frobnicate"), "{fragment}");
    }

    #[test]
    fn unparsable_commands_are_unknown_not_silently_read_only() {
        // 引号没闭合：既不能放行，也不该说成"确定修改"。
        let detail = classify_shell_detail("echo \"unterminated");
        assert_eq!(detail.risk, ToolRisk::Write);
        assert!(detail.unknown.is_some());
    }

    #[test]
    fn unknown_summary_says_cannot_tell_instead_of_will_modify() {
        let planned = plan_tool(
            "run_shell",
            &json!({ "command": "frobnicate --do-stuff" }),
            "/srv/app",
            1,
        )
        .expect("plan");
        let summary = planned.summary.expect("有摘要");
        assert!(summary.contains("无法判断"), "{summary}");
        assert!(summary.contains("frobnicate"), "{summary}");
        assert!(!summary.contains("将修改"), "{summary}");
        let impact = planned.impact.expect("有影响说明");
        assert!(impact.contains("影响无法判断"), "{impact}");
        assert_eq!(planned.unknown.as_deref(), Some("frobnicate --do-stuff"));

        // 确认仍然要弹（按写处理），只是措辞不确定。
        assert!(planned.call.risk.needs_approval());
    }

    #[test]
    fn known_writes_keep_their_definite_summary() {
        let planned = plan_tool(
            "run_shell",
            &json!({ "command": "rm -f /srv/app/old.log" }),
            "/srv/app",
            1,
        )
        .expect("plan");
        assert!(planned.unknown.is_none());
        let summary = planned.summary.expect("有摘要");
        assert!(!summary.contains("无法判断"), "{summary}");
    }

    /* ---------------- 包装器里藏写：不能因为外层只读就放行 ---------------- */

    /* ---------------- AI 自述：目的 / 预期 / 只读还是改动 ---------------- */

    #[test]
    fn declared_purpose_and_expectation_reach_the_approval_text() {
        let planned = plan_tool(
            "run_shell",
            &json!({
                "command": "rm -f /srv/app/dist.zip",
                "purpose": "清理上一版构建产物",
                "expect": "只删除 /srv/app/dist.zip",
                "intent": "change"
            }),
            "/srv/app",
            1,
        )
        .expect("plan");
        let declared = planned.declared.clone().expect("保留自述");
        assert_eq!(declared.intent.as_deref(), Some("change"));
        assert!(!declared.claims_read());
        let impact = planned.impact.clone().expect("有影响说明");
        assert!(impact.contains("清理上一版构建产物"), "{impact}");
        assert!(impact.contains("只删除 /srv/app/dist.zip"), "{impact}");
        // 平台自己的判定仍然在（说明与判定并列，不是被 AI 的话替换掉）。
        assert!(planned.summary.is_some());
    }

    #[test]
    fn a_read_declaration_does_not_turn_a_query_into_an_approval() {
        let planned = plan_tool(
            "run_shell",
            &json!({ "command": "docker ps", "intent": "read", "purpose": "看容器" }),
            "/srv/app",
            1,
        )
        .expect("plan");
        assert!(planned.declared.expect("保留自述").claims_read());
        assert_eq!(planned.call.risk, ToolRisk::Read);
        // 只读命令不生成"影响"段（那是给需要确认的操作用的）。
        assert!(planned.impact.is_none(), "impact={:?}", planned.impact);
    }

    #[test]
    fn kubernetes_queries_are_read_only_but_changes_are_not() {
        for command in [
            "kubectl get pods -A",
            "kubectl describe pod web-0 -n prod",
            "kubectl logs -n prod deploy/api --tail 100",
            "kubectl top pods -n prod",
            "kubectl version --client",
            "kubectl rollout status deploy/api -n prod",
            "helm list -A",
        ] {
            assert_eq!(risk(command), ToolRisk::Read, "{command}");
        }
        for command in [
            "kubectl delete pod web-0 -n prod",
            "kubectl apply -f /srv/app/deploy.yaml",
            "kubectl exec -it web-0 -- rm -f /tmp/x",
            "kubectl rollout restart deploy/api -n prod",
            "helm upgrade --install api /srv/app/chart",
        ] {
            assert_eq!(risk(command), ToolRisk::Write, "{command}");
        }
    }

    #[test]
    fn wrappers_do_not_hide_writes() {
        for command in [
            "env FOO=1 rm -f /srv/app/x",
            "env -i PATH=/usr/bin rm -f /srv/app/x",
            "xargs rm -f",
            "docker ps -q | xargs -r docker rm",
            "echo /srv/app/x | xargs -I{} rm -f {}",
            "nice -n 10 rm -f /srv/app/x",
            "timeout 30 rm -f /srv/app/x",
            "command rm -f /srv/app/x",
            "env sh -c 'rm -f /srv/app/x'",
            "xargs -0 sh -c 'rm -f /srv/app/x'",
        ] {
            assert_eq!(risk(command), ToolRisk::Write, "{command}");
        }
    }

    #[test]
    fn wrappers_keep_read_only_queries_fast() {
        for command in [
            "env",
            "env FOO=1 docker ps",
            "env -i PATH=/usr/bin docker ps",
            "xargs -0 sha256sum",
            "docker ps -q | xargs -r docker inspect",
            "nice -n 10 docker ps",
            "timeout 30 docker ps",
            "command -v nginx",
            "time sha256sum /x",
        ] {
            assert_eq!(risk(command), ToolRisk::Read, "{command}");
            assert!(unknown(command).is_none(), "{command}");
        }
    }

    #[test]
    fn unknown_commands_still_confirm_under_full_permissions() {
        let unclear = plan_tool(
            "run_shell",
            &json!({ "command": "frobnicate --do-stuff" }),
            "/srv/app",
            1,
        )
        .expect("plan");
        assert!(requires_confirmation(&unclear, false));
        assert!(
            requires_confirmation(&unclear, true),
            "看不懂的命令在完全权限下也必须确认"
        );

        // 已确定的日常写入在完全权限下直接执行（这条规则不能被上面的改动带偏）。
        let routine = plan_tool(
            "run_shell",
            &json!({ "command": "mkdir -p /srv/app/tmp" }),
            "/srv/app",
            1,
        )
        .expect("plan");
        assert!(requires_confirmation(&routine, false));
        assert!(!requires_confirmation(&routine, true));
    }
}
