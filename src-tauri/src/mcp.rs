//! MCP（Model Context Protocol）服务管理 + 最小客户端。
//!
//! 只实现客户端需要的三件事：
//! * stdio / Streamable HTTP 的 JSON-RPC 2.0 会话（initialize → 请求）；
//! * `tools/list` / `resources/list` / `prompts/list` 能力刷新与缓存；
//! * `tools/call` 执行，供超能 Agent 把启用的 MCP 工具当成普通工具调用。
//!
//! 设计取舍：
//! * **每次调用一个会话**（stdio 起一个子进程，HTTP 走 initialize + 请求），
//!   不维护常驻连接 —— 配置简单、进程不会泄漏；代价是首次调用有握手延迟。
//! * 能力缓存写进 SQLite（`mcp_servers` 一行一个服务的 JSON），刷新由用户触发，
//!   发任务时把启用工具的定义带进 `AgentInput`，执行时不再查库。
//! * env / headers 里的值写进系统钥匙串（`mcp:<id>:header|env:<name>`），
//!   SQLite 只存名字与是否已设置；连接/调用前再从钥匙串取出。

use std::collections::HashMap;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

use crate::agent::Lang;
use crate::db::AppDb;
use crate::keyring;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
/// 首次启动（`initialize`）单独给的预算。
///
/// 实测（Windows + nvm4w + Docker Desktop 的 k8s）：`npx -y
/// kubernetes-mcp-server@latest` 冷启动要下载 27 MB 的平台二进制包（约 6 秒，
/// 取决于网络），之后服务自己连集群目标还要 ~16 秒，合计 22–25 秒 —— 和 25 秒
/// 预算几乎重合。网络稍慢就必然超时，而超时会把连接打成 `error` 并**清空工具
/// 列表**，任务侧 `bindings_for` 只认 `connected` 的连接，于是这个 MCP 在任务里
/// 「消失」（JSON 导入的纯 JS 服务 1 秒内就握手完，所以看起来只有它不能用）。
///
/// 所以只放宽握手阶段；`tools/list` 与逐次调用仍是原预算。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
const TOOL_TIMEOUT: Duration = Duration::from_secs(120);
const OUTPUT_LIMIT: usize = 256 * 1024;
/// 客户端声明的 MCP 协议版本。Streamable HTTP 从 2025-03-26 开始支持。
const CLIENT_PROTOCOL_VERSION: &str = "2025-06-18";
const HTTP_MIN_PROTOCOL: &str = "2025-03-26";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpKeyValue {
    pub name: String,
    /// **永不落库**：保存时写进系统钥匙串，配置 JSON 里留空。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub value: String,
    /// 钥匙串里是否已有值（前端只用来显示"已保存"，不回显明文）。
    #[serde(default)]
    pub has_value: bool,
}

/// 连接实例绑到哪一层：具体服务器 / 工作区 / 全局。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpScope {
    /// `server` / `workspace` / `global`
    #[serde(default = "default_workspace_scope")]
    pub scope: String,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

impl Default for McpScope {
    fn default() -> Self {
        Self {
            scope: default_workspace_scope(),
            server_id: None,
            workspace_id: None,
        }
    }
}

fn default_workspace_scope() -> String {
    "workspace".to_string()
}

/// MCP 连接只有全局作用域：可用范围由任务权限决定，不由服务器绑定决定。
fn global_scope() -> McpScope {
    McpScope {
        scope: "global".to_string(),
        server_id: None,
        workspace_id: None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDef {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// 服务端给的 JSON Schema；调用时按它生成原生工具参数。
    #[serde(default)]
    pub input_schema: Value,
    /// `annotations.readOnlyHint`：只读工具可以直接执行（仍受只读任务边界约束）。
    #[serde(default)]
    pub read_only: bool,
    /// 用户在 MCP 页里的启用状态。
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// MCP 工具影响的**证据等级**。
///
/// `readOnlyHint` 只是第三方服务自己的声明，平台无法独立证明它真的不会写。
/// 因此这里把"声明只读"与"已验证只读"分开命名：子代理和确认流程都按这个
/// 等级决策，不能把声明当成绝对安全。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpEffect {
    /// 服务声明只读，名称 / 参数里也没有写入信号。仍然是**声明**，不是平台验证。
    DeclaredReadOnly,
    /// 服务没有声明只读（`readOnlyHint != true`）。
    Write,
    /// 声明只读，但名称 / 参数出现写入信号（自相矛盾），无法可靠判断影响。
    Unknown,
}

/// 工具名里出现这些动词时，即使声明只读也按"影响未知"处理。
const MUTATING_NAME_TOKENS: &[&str] = &[
    "create", "update", "delete", "remove", "write", "modify", "edit", "set", "put", "post",
    "patch", "insert", "upsert", "drop", "truncate", "purge", "destroy", "kill", "restart",
    "stop", "start", "execute", "exec", "run", "apply", "deploy", "upload", "install",
    "uninstall", "publish", "push", "commit", "merge", "move", "copy", "rename", "chmod",
    "chown", "mkdir", "touch", "grant", "revoke", "enable", "disable", "reset", "rollback",
    "send", "submit", "trigger", "invoke", "call",
];

/// 参数里出现这些字段时，工具通常会携带要写入的内容 / 命令。
const WRITE_PAYLOAD_KEYS: &[&str] = &[
    "content", "newcontent", "new_content", "text", "body", "payload", "patch", "command",
    "script", "stdin", "sql", "query",
];

fn mutating_name_signal(name: &str) -> bool {
    // 按 `_` / `-` / 大小写边界切词：`deleteFile` 与 `delete_file` 都要命中，
    // 但 `postgres_query` 不能被 `post` 前缀误伤。
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    for (index, ch) in name.chars().enumerate() {
        if !ch.is_ascii_alphanumeric() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }
        if ch.is_ascii_uppercase() && index > 0 && !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
        current.push(ch.to_ascii_lowercase());
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
        .iter()
        .any(|token| MUTATING_NAME_TOKENS.contains(&token.as_str()))
}

fn write_payload_signal(schema: &Value) -> bool {
    let keys = ["required", "properties"];
    keys.iter().any(|section| {
        let Some(object) = schema.get(*section).and_then(Value::as_object) else {
            return false;
        };
        object.keys().any(|key| {
            WRITE_PAYLOAD_KEYS.contains(&key.to_ascii_lowercase().as_str())
        })
    })
}

/// 根据声明与可观察信号判断影响等级。
///
/// 只读声明为真、且名称 / 参数没有写入信号 → 声明只读；
/// 声明为真但出现写入信号 → 影响未知（必须回到确认流程，不能静默执行）；
/// 声明为假 → 写入。
pub fn classify_effect(
    name: &str,
    description: &str,
    schema: &Value,
    read_only_hint: bool,
) -> McpEffect {
    if !read_only_hint {
        return McpEffect::Write;
    }
    let first_word = description
        .trim_start()
        .split(|ch: char| ch.is_whitespace() || ch == ':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let description_signal = MUTATING_NAME_TOKENS.contains(&first_word.as_str());
    if mutating_name_signal(name) || write_payload_signal(schema) || description_signal {
        return McpEffect::Unknown;
    }
    McpEffect::DeclaredReadOnly
}

impl McpToolDef {
    pub fn effect(&self) -> McpEffect {
        classify_effect(
            &self.name,
            self.description.as_deref().unwrap_or(""),
            &self.input_schema,
            self.read_only,
        )
    }
}

/// 调用被拒绝的结构化原因。与真实 MCP 调用错误分开：这里只表示权限 / 可用性。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpReject {
    /// 服务在设置里被停用。
    Disabled,
    /// 服务当前没有通过连接 / 工具发现验证。
    Disconnected,
    /// 配置读不出来（库损坏 / 记录被删除）：不能确认可用，但也不是权限拒绝。
    ConfigUnavailable,
    /// 工具在 MCP 页里被停用，或本次运行启用的清单已经不含它。
    ToolDisabled,
    /// 服务端工具列表里已经没有这个工具（授权被撤销 / 服务改名）。
    ToolMissing,
    /// 之前声明只读，现在声明可写。
    ReadOnlyRevoked,
    /// 声明与名称 / 参数冲突，无法可靠判断影响。
    EffectUnknown,
}

impl McpReject {
    /// 界面上的"未执行"原因代码：可用性问题不能说成权限拒绝。
    pub fn blocked_code(self) -> &'static str {
        match self {
            Self::ConfigUnavailable | Self::Disconnected => "mcp_unavailable",
            Self::Disabled | Self::ToolDisabled | Self::ToolMissing | Self::ReadOnlyRevoked | Self::EffectUnknown => "permission",
        }
    }

    pub fn reason_lang(self, lang: Lang, child_run: bool) -> String {
        let zh = match self {
            Self::Disabled => "MCP 服务已停用，这次调用没有执行。",
            Self::Disconnected => "MCP 服务未连接或未通过验证，这次调用没有执行。",
            Self::ConfigUnavailable => {
                "MCP 配置读取失败，无法确认该服务是否可用；这次调用没有执行（不是权限拒绝）。"
            }
            Self::ToolDisabled => "该 MCP 工具已在本轮禁用，这次调用没有执行。",
            Self::ToolMissing => "MCP 服务已不再提供该工具（授权可能已撤销），这次调用没有执行。",
            Self::ReadOnlyRevoked => {
                "该 MCP 工具的只读声明已改变，这次调用没有执行；请重新评估后再试。"
            }
            Self::EffectUnknown => "无法可靠判断该 MCP 工具会不会写入，这次调用没有执行。",
        };
        let en = match self {
            Self::Disabled => "The MCP service is disabled, so this call did not run.",
            Self::Disconnected => {
                "The MCP service is not connected or failed validation, so this call did not run."
            }
            Self::ConfigUnavailable => {
                "The MCP configuration could not be read, so availability cannot be confirmed; the call did not run (this is not a permission denial)."
            }
            Self::ToolDisabled => "This MCP tool is disabled for this run, so the call did not run.",
            Self::ToolMissing => {
                "The MCP service no longer exposes this tool (authorization may be revoked), so the call did not run."
            }
            Self::ReadOnlyRevoked => {
                "This MCP tool's read-only declaration changed, so the call did not run; re-evaluate before retrying."
            }
            Self::EffectUnknown => {
                "The platform cannot reliably tell whether this MCP tool writes, so the call did not run."
            }
        };
        let mut text = match lang {
            Lang::Zh => zh.to_string(),
            Lang::En => en.to_string(),
        };
        if child_run {
            text.push_str(match lang {
                Lang::Zh => " 子任务不能直接执行这一步：把它作为需要主 Agent 处理的请求返回。",
                Lang::En => " Child agents cannot run this; return it as a request for the parent agent.",
            });
        }
        text
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceDef {
    pub uri: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    /// 市场条目 id（自定义连接为空）。
    #[serde(default)]
    pub catalog_id: Option<String>,
    /// 绑定的服务器 / 工作区。
    #[serde(default)]
    pub binding: McpScope,
    /// 连接成功后是否默认勾选到对应会话。
    #[serde(default)]
    pub default_enabled: bool,
    /// `stdio` / `http`
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<McpKeyValue>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: Vec<McpKeyValue>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub tools: Vec<McpToolDef>,
    #[serde(default)]
    pub resources: Vec<McpResourceDef>,
    #[serde(default)]
    pub prompts: Vec<McpPromptDef>,
    /// `unknown` / `connected` / `error` / `tools_error`
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    /// resources / prompts 这类非阻断能力发现失败的原因（不影响连接状态）。
    #[serde(default)]
    pub warnings: Vec<String>,
    /// 初始化协商出的协议版本（诊断用）。
    #[serde(default)]
    pub protocol_version: Option<String>,
    #[serde(default)]
    pub updated_at: u64,
}

fn default_true() -> bool {
    true
}

fn secret_account(id: &str, kind: &str, name: &str) -> String {
    format!("mcp:{id}:{kind}:{name}")
}

/// 把用户新填的 env / header 值写进钥匙串；空值表示"保留原来的"。
pub fn store_secrets(config: &mut McpServerConfig) -> Result<()> {
    for (kind, items) in [("header", &mut config.headers), ("env", &mut config.env)] {
        for item in items.iter_mut() {
            let account = secret_account(&config.id, kind, &item.name);
            if item.value.trim().is_empty() {
                item.has_value = keyring::read_secret(&account).is_ok();
                continue;
            }
            keyring::save_secret(&account, &item.value)
                .with_context(|| format!("保存 MCP {} {} 失败", kind, item.name))?;
            item.value.clear();
            item.has_value = true;
        }
    }
    Ok(())
}

/// 连接前把钥匙串里的值填回内存配置（只在这一层出现明文）。
pub fn resolve_secrets(config: &mut McpServerConfig) {
    for (kind, items) in [("header", &mut config.headers), ("env", &mut config.env)] {
        for item in items.iter_mut() {
            if !item.value.is_empty() {
                item.has_value = true;
                continue;
            }
            let account = secret_account(&config.id, kind, &item.name);
            if let Ok(value) = keyring::read_secret(&account) {
                item.value = value;
                item.has_value = true;
            }
        }
    }
}

/// UI 只看到"有没有值"，不拿到明文。
pub fn mark_secret_presence(config: &mut McpServerConfig) {
    for (kind, items) in [("header", &mut config.headers), ("env", &mut config.env)] {
        for item in items.iter_mut() {
            if !item.value.is_empty() {
                item.has_value = true;
                continue;
            }
            item.has_value =
                keyring::read_secret(&secret_account(&config.id, kind, &item.name)).is_ok();
        }
    }
}

fn delete_secrets(config: &McpServerConfig) {
    for (kind, items) in [("header", &config.headers), ("env", &config.env)] {
        for item in items {
            let _ = keyring::delete_secret(&secret_account(&config.id, kind, &item.name));
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub catalog_id: Option<String>,
    #[serde(default)]
    pub binding: McpScope,
    #[serde(default)]
    pub default_enabled: bool,
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<McpKeyValue>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: Vec<McpKeyValue>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 编辑时回传的已有能力（不刷新就保留原来的工具启用状态）。
    #[serde(default)]
    pub tools: Vec<McpToolDef>,
    #[serde(default)]
    pub resources: Vec<McpResourceDef>,
    #[serde(default)]
    pub prompts: Vec<McpPromptDef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub status: String,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub protocol_version: Option<String>,
    pub tools: Vec<McpToolDef>,
    pub resources: Vec<McpResourceDef>,
    pub prompts: Vec<McpPromptDef>,
}

#[derive(Debug)]
struct CapabilitySnapshot {
    tools: Vec<McpToolDef>,
    resources: Vec<McpResourceDef>,
    prompts: Vec<McpPromptDef>,
    warnings: Vec<String>,
    protocol_version: Option<String>,
}

/// 能力发现失败发生在哪一步：握手（连接失败）还是 tools/list（工具发现失败）。
#[derive(Debug)]
struct CapabilityFailure {
    stage: &'static str,
    message: String,
}

impl CapabilityFailure {
    fn handshake(error: impl std::fmt::Display) -> Self {
        Self {
            stage: "handshake",
            message: error.to_string(),
        }
    }

    fn tools(error: impl std::fmt::Display) -> Self {
        Self {
            stage: "tools",
            message: error.to_string(),
        }
    }
}

/// 发任务时绑定到 Agent 的一个已启用工具。
#[derive(Debug, Clone)]
pub struct McpBinding {
    pub exposed_name: String,
    pub server_id: String,
    pub server_name: String,
    pub tool: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
    pub config: McpServerConfig,
}

impl McpBinding {
    /// 当前绑定携带的影响等级。调用前必须再用 [`revalidate_binding`] 复查。
    pub fn effect(&self) -> McpEffect {
        classify_effect(&self.tool, &self.description, &self.input_schema, self.read_only)
    }

    /// 用刚读到的配置刷新工具声明；声明变化时返回变化前后的等级。
    fn refresh_from(&mut self, config: McpServerConfig) -> Option<(McpEffect, McpEffect)> {
        let before = self.effect();
        if let Some(tool) = config.tools.iter().find(|tool| tool.name == self.tool).cloned() {
            self.read_only = tool.read_only;
            self.input_schema = tool.input_schema.clone();
            self.description = tool
                .description
                .clone()
                .or(tool.title.clone())
                .unwrap_or_else(|| tool.name.clone());
        }
        self.config = config;
        let after = self.effect();
        (before != after).then_some((before, after))
    }
}

/// 执行前复查 MCP 工具是否仍可调用。
///
/// - 服务停用 / 断开 / 工具停用 / 工具消失都立即拒绝；
/// - 子任务只允许**声明只读且无写入信号**的工具；
/// - 主 Agent 允许写工具，但调用方必须按 [`McpBinding::effect`] 重新判定风险，
///   不能沿用启动时的 `read_only`。
///
/// `db == None` 只出现在测试替身里：此时按绑定自身的声明判断子任务边界，
/// 绝不把"读不到配置"当成"仍然安全"。
pub fn revalidate_binding(
    db: Option<&AppDb>,
    binding: &mut McpBinding,
    child_run: bool,
) -> Result<(), McpReject> {
    if let Some(db) = db {
        let fresh =
            load_config(db, &binding.server_id).map_err(|_| McpReject::ConfigUnavailable)?;
        if !fresh.enabled {
            return Err(McpReject::Disabled);
        }
        if fresh.status != "connected" {
            return Err(McpReject::Disconnected);
        }
        let Some(tool) = fresh.tools.iter().find(|tool| tool.name == binding.tool) else {
            return Err(McpReject::ToolMissing);
        };
        if !tool.enabled {
            return Err(McpReject::ToolDisabled);
        }
        binding.refresh_from(fresh);
    }
    if child_run {
        match binding.effect() {
            McpEffect::DeclaredReadOnly => Ok(()),
            McpEffect::Write if binding.read_only => Err(McpReject::EffectUnknown),
            McpEffect::Write => Err(McpReject::ReadOnlyRevoked),
            McpEffect::Unknown => Err(McpReject::EffectUnknown),
        }
    } else {
        Ok(())
    }
}

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

pub fn list_servers(db: &AppDb) -> Result<Vec<McpServerConfig>> {
    let conn = db.open()?;
    let mut servers = load_servers(&conn)?;
    for server in &mut servers {
        mark_secret_presence(server);
    }
    Ok(servers)
}

fn load_servers(conn: &Connection) -> Result<Vec<McpServerConfig>> {
    let mut stmt =
        conn.prepare("SELECT payload_json FROM mcp_servers ORDER BY updated_at DESC, id ASC")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        let payload = row?;
        if let Ok(mut config) = serde_json::from_str::<McpServerConfig>(&payload) {
            // 旧版本按服务器 / 任务绑定的记录也统一当成全局；保存时会落成 global。
            config.binding = global_scope();
            out.push(config);
        }
    }
    Ok(out)
}

fn load_one(conn: &Connection, id: &str) -> Result<McpServerConfig> {
    let payload: String = conn
        .query_row(
            "SELECT payload_json FROM mcp_servers WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .context("找不到这个 MCP 服务")?;
    let mut config: McpServerConfig = serde_json::from_str(&payload).context("MCP 服务配置损坏")?;
    config.binding = global_scope();
    Ok(config)
}

fn save_server(conn: &Connection, config: &McpServerConfig) -> Result<()> {
    let payload = serde_json::to_string(config)?;
    conn.execute(
        "INSERT INTO mcp_servers (id, payload_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json,
                                       updated_at = excluded.updated_at",
        params![config.id, payload, config.updated_at as i64],
    )?;
    Ok(())
}

/// 把表单输入变成一份临时配置（不落库、不写钥匙串）：用于"先测再存"。
pub fn draft_config(input: McpServerInput) -> Result<McpServerConfig> {
    let transport = input.transport.trim().to_ascii_lowercase();
    if transport != "stdio" && transport != "http" {
        return Err(anyhow!("传输方式只支持 stdio 或 http"));
    }
    if transport == "stdio" && input.command.trim().is_empty() {
        return Err(anyhow!("stdio 服务需要填写启动命令"));
    }
    if transport == "http" && !input.url.trim().starts_with("http") {
        return Err(anyhow!("HTTP 服务需要填写 http(s) 地址"));
    }
    Ok(McpServerConfig {
        id: input.id.clone().unwrap_or_else(|| "draft".to_string()),
        name: input.name,
        catalog_id: input.catalog_id,
        binding: global_scope(),
        default_enabled: input.default_enabled,
        transport,
        command: input.command.trim().to_string(),
        args: input.args,
        env: input.env,
        url: input.url.trim().to_string(),
        headers: input.headers,
        enabled: input.enabled,
        tools: input.tools,
        resources: input.resources,
        prompts: input.prompts,
        status: "unknown".to_string(),
        error: None,
        warnings: Vec::new(),
        protocol_version: None,
        updated_at: 0,
    })
}

/// 未保存配置的连接测试：表单里先测一次，不落库。
pub async fn test_draft(config: &McpServerConfig) -> McpTestResult {
    let began = Instant::now();
    match list_capabilities(config).await {
        Ok(snapshot) => McpTestResult {
            ok: true,
            latency_ms: began.elapsed().as_millis() as u64,
            status: "connected".to_string(),
            error: None,
            warnings: snapshot.warnings,
            protocol_version: snapshot.protocol_version,
            tools: snapshot.tools,
            resources: snapshot.resources,
            prompts: snapshot.prompts,
        },
        Err(error) => McpTestResult {
            ok: false,
            latency_ms: began.elapsed().as_millis() as u64,
            status: if error.stage == "tools" {
                "tools_error".to_string()
            } else {
                "error".to_string()
            },
            error: Some(error.message),
            warnings: Vec::new(),
            protocol_version: None,
            tools: Vec::new(),
            resources: Vec::new(),
            prompts: Vec::new(),
        },
    }
}

pub fn save(db: &AppDb, input: McpServerInput) -> Result<McpServerConfig> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(anyhow!("服务名称不能为空"));
    }
    let transport = input.transport.trim().to_ascii_lowercase();
    if transport != "stdio" && transport != "http" {
        return Err(anyhow!("传输方式只支持 stdio 或 http"));
    }
    if transport == "stdio" && input.command.trim().is_empty() {
        return Err(anyhow!("stdio 服务需要填写启动命令"));
    }
    if transport == "http" && !input.url.trim().starts_with("http") {
        return Err(anyhow!("HTTP 服务需要填写 http(s) 地址"));
    }
    let now = crate::db::AppDb::now() as u64;
    let id = input
        .id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("mcp-{now}-{}", rand_suffix()));
    let conn = db.open()?;
    /*
     * 编辑时只有"连接身份"没变才保留验证结果：改 URL / 启动命令 / 参数 /
     * 鉴权 Header / env 都意味着旧工具列表不再可信；只改显示名称则保留。
     */
    let previous = load_servers(&conn)?.into_iter().find(|item| item.id == id);
    let changed = previous
        .as_ref()
        .is_some_and(|prev| connection_changed(prev, &input));
    let tools = if changed {
        Vec::new()
    } else {
        merge_tools(&input.tools, previous.as_ref())
    };
    let mut config = McpServerConfig {
        id,
        name: name.to_string(),
        catalog_id: input.catalog_id,
        binding: global_scope(),
        default_enabled: input.default_enabled,
        transport,
        command: input.command.trim().to_string(),
        args: input.args,
        env: input.env,
        url: input.url.trim().to_string(),
        headers: input.headers,
        enabled: input.enabled,
        tools,
        resources: if changed { Vec::new() } else { input.resources },
        prompts: if changed { Vec::new() } else { input.prompts },
        status: if changed {
            "unknown".to_string()
        } else {
            previous
                .as_ref()
                .map(|item| item.status.clone())
                .unwrap_or_else(|| "unknown".to_string())
        },
        error: if changed {
            None
        } else {
            previous.as_ref().and_then(|item| item.error.clone())
        },
        warnings: if changed {
            Vec::new()
        } else {
            previous
                .as_ref()
                .map(|item| item.warnings.clone())
                .unwrap_or_default()
        },
        protocol_version: if changed {
            None
        } else {
            previous
                .as_ref()
                .and_then(|item| item.protocol_version.clone())
        },
        updated_at: now,
    };
    // 新填的令牌写钥匙串；空值保留原值。返回值只带 hasValue。
    store_secrets(&mut config)?;
    save_server(&conn, &config)?;
    Ok(config)
}

fn connection_changed(previous: &McpServerConfig, input: &McpServerInput) -> bool {
    let transport = input.transport.trim().to_ascii_lowercase();
    if previous.transport != transport
        || previous.url != input.url.trim()
        || previous.command != input.command.trim()
        || previous.args != input.args
    {
        return true;
    }
    let names = |items: &[McpKeyValue]| {
        items
            .iter()
            .filter(|item| !item.name.trim().is_empty())
            .map(|item| item.name.trim().to_string())
            .collect::<Vec<_>>()
    };
    if names(&previous.headers) != names(&input.headers)
        || names(&previous.env) != names(&input.env)
    {
        return true;
    }
    // 新填了令牌 / env 值（哪怕看起来一样）就按凭据变化处理，宁可多测一次。
    if input
        .headers
        .iter()
        .any(|item| !item.value.trim().is_empty())
        || input.env.iter().any(|item| !item.value.trim().is_empty())
    {
        return true;
    }
    false
}

fn merge_tools(next: &[McpToolDef], previous: Option<&McpServerConfig>) -> Vec<McpToolDef> {
    let enabled_by_name: HashMap<String, bool> = previous
        .map(|item| {
            item.tools
                .iter()
                .map(|tool| (tool.name.clone(), tool.enabled))
                .collect()
        })
        .unwrap_or_default();
    next.iter()
        .map(|tool| {
            let mut tool = tool.clone();
            if let Some(enabled) = enabled_by_name.get(&tool.name) {
                tool.enabled = *enabled;
            }
            tool
        })
        .collect()
}

pub fn delete(db: &AppDb, id: &str) -> Result<()> {
    let conn = db.open()?;
    if let Ok(config) = load_one(&conn, id) {
        delete_secrets(&config);
    }
    conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;
    Ok(())
}

/// 保存单个工具的启用状态（不影响其他字段）。
pub fn set_tool_enabled(db: &AppDb, id: &str, tool: &str, enabled: bool) -> Result<()> {
    let conn = db.open()?;
    let mut config = load_one(&conn, id)?;
    if let Some(item) = config.tools.iter_mut().find(|item| item.name == tool) {
        item.enabled = enabled;
    }
    config.updated_at = crate::db::AppDb::now() as u64;
    save_server(&conn, &config)
}

fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or(0);
    format!("{nanos:06x}")
}

/* ------------------------------------------------------------------ */
/* 刷新能力 / 测试连接                                                  */
/* ------------------------------------------------------------------ */

pub async fn test(db: &AppDb, id: &str) -> Result<McpTestResult> {
    let conn = db.open()?;
    let original: String = conn.query_row(
        "SELECT payload_json FROM mcp_servers WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;
    let mut config: McpServerConfig = serde_json::from_str(&original)?;
    drop(conn);
    let began = Instant::now();
    let result = list_capabilities(&config).await;
    let latency_ms = began.elapsed().as_millis() as u64;
    match result {
        Ok(snapshot) => {
            let tools = merge_tools(&snapshot.tools, Some(&config));
            config.tools = tools.clone();
            config.resources = snapshot.resources.clone();
            config.prompts = snapshot.prompts.clone();
            config.status = "connected".to_string();
            config.error = None;
            config.warnings = snapshot.warnings.clone();
            config.protocol_version = snapshot.protocol_version.clone();
            config.updated_at = crate::db::AppDb::now() as u64;
            let conn = db.open()?;
            save_test_result(&conn, &config, &original)?;
            Ok(McpTestResult {
                ok: true,
                latency_ms,
                status: "connected".to_string(),
                error: None,
                warnings: snapshot.warnings,
                protocol_version: snapshot.protocol_version,
                tools,
                resources: snapshot.resources,
                prompts: snapshot.prompts,
            })
        }
        Err(error) => {
            // Keep cached tool preferences for recovery. bindings_for only exposes
            // tools while status is connected, so failed checks cannot use them.
            config.status = if error.stage == "tools" {
                "tools_error".to_string()
            } else {
                "error".to_string()
            };
            config.error = Some(error.message.clone());
            config.warnings.clear();
            config.updated_at = crate::db::AppDb::now() as u64;
            let conn = db.open()?;
            save_test_result(&conn, &config, &original)?;
            Ok(McpTestResult {
                ok: false,
                latency_ms,
                status: config.status.clone(),
                error: Some(error.message),
                warnings: Vec::new(),
                protocol_version: config.protocol_version.clone(),
                tools: config.tools.clone(),
                resources: config.resources.clone(),
                prompts: config.prompts.clone(),
            })
        }
    }
}

fn save_test_result(conn: &Connection, config: &McpServerConfig, original: &str) -> Result<()> {
    let changed = conn.execute(
        "UPDATE mcp_servers SET payload_json = ?1, updated_at = ?2 WHERE id = ?3 AND payload_json = ?4",
        params![serde_json::to_string(config)?, config.updated_at as i64, config.id, original],
    )?;
    if changed == 0 {
        anyhow::bail!("MCP 配置在检测期间发生变化，请重新检测");
    }
    Ok(())
}

/// 初始化结果里声明的能力决定要发哪些 list 请求。
///
/// 没声明 `resources` / `prompts` 就不请求；声明了但调用失败，记一条警告，
/// 不影响"已连接"结论。`tools` 是核心能力：声明了就必须成功，否则算工具发现失败。
fn capability_requests(init: &Value) -> Vec<(String, Value)> {
    let caps = init.get("capabilities");
    let declared = |name: &str| {
        caps.and_then(|value| value.get(name))
            .is_some_and(|value| !value.is_null())
    };
    let mut out = Vec::new();
    // 旧服务偶尔不返回 capabilities：只探测 tools，保持兼容。
    if caps.is_none() || declared("tools") {
        out.push(("tools/list".to_string(), json!({})));
    }
    if declared("resources") {
        out.push(("resources/list".to_string(), json!({})));
    }
    if declared("prompts") {
        out.push(("prompts/list".to_string(), json!({})));
    }
    out
}

async fn list_capabilities(
    config: &McpServerConfig,
) -> std::result::Result<CapabilitySnapshot, CapabilityFailure> {
    let output = session(config, capability_requests, REQUEST_TIMEOUT)
        .await
        .map_err(|error| {
            let mut message = error.to_string();
            /*
             * 超时几乎都发生在 npx 冷启动上（见 HANDSHAKE_TIMEOUT）。直接给一条
             * 可以照做的预热命令，比只说"超时"有用得多。
             */
            if config.transport == "stdio" && message.contains("超时") {
                message.push_str(&format!(
                    "。stdio 服务首次启动要由 npx 下载运行时包（通常 20–60 秒）；可先在终端执行 `{} {}` 预热，再点「测试 / 刷新」",
                    config.command,
                    config.args.join(" ")
                ));
            }
            CapabilityFailure::handshake(message)
        })?;
    let protocol_version = output
        .initialize
        .get("protocolVersion")
        .and_then(Value::as_str)
        .map(str::to_string);
    let response = |method: &str| {
        output
            .results
            .iter()
            .find(|(name, _)| name == method)
            .map(|(_, value)| value)
    };

    let tools = match response("tools/list") {
        Some(Ok(value)) => value
            .get("tools")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        !item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .is_empty()
                    })
                    .map(parse_tool)
                    .collect()
            })
            .unwrap_or_default(),
        Some(Err(error)) => {
            return Err(CapabilityFailure::tools(format!(
                "工具发现失败（tools/list）：{error}"
            )));
        }
        // 服务没声明 tools：这是一个有效的"无工具"连接。
        None => Vec::new(),
    };
    let mut warnings = Vec::new();
    let mut resources = Vec::new();
    if let Some(result) = response("resources/list") {
        match result {
            Ok(value) => {
                resources = value
                    .get("resources")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().map(parse_resource).collect())
                    .unwrap_or_default();
            }
            Err(error) => warnings.push(format!("资源列表读取失败（resources/list）：{error}")),
        }
    }
    let mut prompts = Vec::new();
    if let Some(result) = response("prompts/list") {
        match result {
            Ok(value) => {
                prompts = value
                    .get("prompts")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().map(parse_prompt).collect())
                    .unwrap_or_default();
            }
            Err(error) => warnings.push(format!("提示模板读取失败（prompts/list）：{error}")),
        }
    }
    Ok(CapabilitySnapshot {
        tools,
        resources,
        prompts,
        warnings,
        protocol_version,
    })
}

fn parse_tool(value: &Value) -> McpToolDef {
    McpToolDef {
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        title: value
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        input_schema: value
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({"type":"object","properties":{}})),
        read_only: value
            .get("annotations")
            .and_then(|annotations| annotations.get("readOnlyHint"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        enabled: true,
    }
}

fn parse_resource(value: &Value) -> McpResourceDef {
    McpResourceDef {
        uri: value
            .get("uri")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        mime_type: value
            .get("mimeType")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn parse_prompt(value: &Value) -> McpPromptDef {
    McpPromptDef {
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/* ------------------------------------------------------------------ */
/* Agent 绑定与执行                                                    */
/* ------------------------------------------------------------------ */

fn sanitize(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "tool".to_string()
    } else {
        out
    }
}

/// 把当前启用的 MCP 工具解析成 Agent 可用的绑定。
///
/// `enabled` 是前端带上来的"本会话启用工具名"（暴露名）；没列出的就不注入。
pub fn bindings_for(
    db: &AppDb,
    enabled: &[String],
    server_id: Option<&str>,
    workspace_id: Option<&str>,
) -> Result<Vec<McpBinding>> {
    if enabled.is_empty() {
        return Ok(Vec::new());
    }
    let wanted: std::collections::HashSet<&str> = enabled.iter().map(String::as_str).collect();
    let conn = db.open()?;
    let servers = load_servers(&conn)?;
    let mut out = Vec::new();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 作用域：全部已启用且验证通过的实例都可参与任何任务（权限另行校验）。
    let _ = (server_id, workspace_id);
    for server in servers
        .into_iter()
        // 未验证 / 连接失败 / 工具发现失败的实例不注入工具。
        .filter(|item| item.enabled && item.status == "connected")
    {
        for tool in server.tools.iter().filter(|item| item.enabled) {
            let mut exposed = format!("mcp__{}__{}", sanitize(&server.id), sanitize(&tool.name));
            let mut index = 2;
            while !used.insert(exposed.clone()) {
                exposed = format!(
                    "mcp__{}__{}_{}",
                    sanitize(&server.id),
                    sanitize(&tool.name),
                    index
                );
                index += 1;
            }
            if !wanted.contains(exposed.as_str()) {
                continue;
            }
            out.push(McpBinding {
                exposed_name: exposed,
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                tool: tool.name.clone(),
                description: tool
                    .description
                    .clone()
                    .or_else(|| tool.title.clone())
                    .unwrap_or_else(|| tool.name.clone()),
                input_schema: tool.input_schema.clone(),
                read_only: tool.read_only,
                config: server.clone(),
            });
        }
    }
    Ok(out)
}

/// 兼容旧调用：MCP 现在只有全局作用域，任何服务器 / 任务都可用。
/// 实际可调用范围由会话权限、连接启用状态和工具级权限决定。
pub fn binding_allows(
    _scope: &McpScope,
    _server_id: Option<&str>,
    _workspace_id: Option<&str>,
) -> bool {
    true
}

/// 执行前重新读一遍配置（含钥匙串里的令牌），并确认服务仍在启用。
pub fn load_config(db: &AppDb, id: &str) -> Result<McpServerConfig> {
    let conn = db.open()?;
    let mut config = load_one(&conn, id)?;
    resolve_secrets(&mut config);
    Ok(config)
}

/// 调用前再确认一次：服务启用 + 工具仍启用（停用/撤销授权立即生效）。
pub fn tool_enabled(db: &AppDb, server_id: &str, tool: &str) -> Result<bool> {
    let config = load_config(db, server_id)?;
    Ok(config.enabled
        && config.status == "connected"
        && config
            .tools
            .iter()
            .any(|item| item.name == tool && item.enabled))
}

/// 追加 MCP 工具的原生 schema；计划模式下要求模型带上 `step`。
pub fn append_tool_schemas(
    schemas: Value,
    bindings: &[McpBinding],
    plan_required: bool,
    lang: Lang,
) -> Value {
    let Value::Array(mut items) = schemas else {
        return schemas;
    };
    for binding in bindings {
        let mut parameters = if binding.input_schema.is_object() {
            binding.input_schema.clone()
        } else {
            json!({"type":"object","properties":{}})
        };
        if parameters.get("type").is_none() {
            parameters["type"] = json!("object");
        }
        if plan_required {
            if let Some(properties) = parameters
                .get_mut("properties")
                .and_then(Value::as_object_mut)
            {
                properties.insert(
                    "step".to_string(),
                    json!({
                        "type": "string",
                        "description": match lang {
                            Lang::Zh => "这次调用属于执行计划的哪一步（步骤 id）",
                            Lang::En => "Which plan step this call belongs to (step id)",
                        }
                    }),
                );
            }
        }
        items.push(json!({
            "type": "function",
            "function": {
                "name": binding.exposed_name,
                "description": format!(
                    "[MCP: {}] {}{}",
                    binding.server_name,
                    binding.description,
                    match (binding.effect(), lang) {
                        (McpEffect::DeclaredReadOnly, Lang::Zh) => "（服务声明只读，平台未独立验证）",
                        (McpEffect::DeclaredReadOnly, Lang::En) => {
                            " (declared read-only by the service; not independently verified)"
                        }
                        (McpEffect::Unknown, Lang::Zh) => "（只读声明存疑，影响未知）",
                        (McpEffect::Unknown, Lang::En) => {
                            " (read-only claim is inconsistent; effect unknown)"
                        }
                        (McpEffect::Write, Lang::Zh) => "（可能写入）",
                        (McpEffect::Write, Lang::En) => " (may write)",
                    }
                ),
                "parameters": parameters,
            }
        }));
    }
    Value::Array(items)
}

/// 执行一个 MCP 工具，返回可展示的文本（stdout）。
pub async fn call_tool(binding: &McpBinding, arguments: &Value) -> Result<String> {
    let call = json!({ "name": binding.tool, "arguments": arguments });
    let output = session(
        &binding.config,
        |_| vec![("tools/call".to_string(), call.clone())],
        TOOL_TIMEOUT,
    )
    .await?;
    let response = output
        .results
        .into_iter()
        .find(|(method, _)| method == "tools/call")
        .ok_or_else(|| anyhow!("MCP 服务没有返回结果"))?
        .1
        .map_err(|error| anyhow!(error))?;
    let is_error = response
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let text = response
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    if item.get("type").and_then(Value::as_str) == Some("text") {
                        item.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
        .or_else(|| {
            response
                .get("structuredContent")
                .map(|value| serde_json::to_string_pretty(value).unwrap_or_default())
        })
        .unwrap_or_else(|| serde_json::to_string_pretty(&response).unwrap_or_default());
    let text = clip(text);
    if is_error {
        return Err(anyhow!(text));
    }
    Ok(text)
}

fn clip(text: String) -> String {
    if text.len() <= OUTPUT_LIMIT {
        return text;
    }
    let mut end = OUTPUT_LIMIT;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n…（输出超过 {} KB，已截断）",
        &text[..end],
        OUTPUT_LIMIT / 1024
    )
}

/* ------------------------------------------------------------------ */
/* JSON-RPC 会话                                                       */
/* ------------------------------------------------------------------ */

struct SessionOutput {
    initialize: Value,
    results: Vec<(String, Result<Value, String>)>,
}

fn protocol_rank(version: &str) -> Option<u8> {
    match version.trim() {
        "2024-11-05" => Some(1),
        "2025-03-26" => Some(2),
        "2025-06-18" => Some(3),
        _ => None,
    }
}

/// 协商版本必须是我们认识的；HTTP 还必须支持 Streamable HTTP。
fn validate_protocol(transport: &str, init: &Value) -> Result<String> {
    let version = init
        .get("protocolVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("服务没有返回 protocolVersion，无法确认协议版本"))?;
    let rank =
        protocol_rank(version).ok_or_else(|| anyhow!("服务协商到不支持的协议版本 {version}"))?;
    if transport == "http" && rank < 2 {
        return Err(anyhow!(
            "服务协商到 {version}：这是旧版 HTTP+SSE 传输，当前客户端只支持 Streamable HTTP（{HTTP_MIN_PROTOCOL} 及以上）；请改用 stdio 或升级服务。"
        ));
    }
    Ok(version.to_string())
}

async fn session<F>(
    config: &McpServerConfig,
    plan: F,
    request_timeout: Duration,
) -> Result<SessionOutput>
where
    F: Fn(&Value) -> Vec<(String, Value)>,
{
    // 进入传输层前统一从钥匙串补全令牌；调用方传进来的配置里没有明文。
    let mut owned = config.clone();
    resolve_secrets(&mut owned);
    let config = &owned;
    match config.transport.as_str() {
        "http" => http_session(config, &plan, request_timeout).await,
        _ => stdio_session(config, &plan, request_timeout).await,
    }
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": CLIENT_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "BLS-OPS", "version": env!("CARGO_PKG_VERSION") }
    })
}

async fn stdio_session<F>(
    config: &McpServerConfig,
    plan: &F,
    request_timeout: Duration,
) -> Result<SessionOutput>
where
    F: Fn(&Value) -> Vec<(String, Value)> + ?Sized,
{
    /*
     * 启动必须用与「运行环境检测」同一套解析：市场显示 uvx 就绪时，这里也用
     * 同一个绝对路径启动，而不是再交给应用启动时继承的旧 PATH。
     *
     * Windows 上 `npx` / `uvx` 往往是 `.cmd` shim，CreateProcess 不会按 PATHEXT
     * 展开；`launch_command` 只对 `.cmd` / `.bat` 走 `cmd.exe`，`.exe` 直接启动，
     * 参数始终分开传递，路径里的空格和特殊字符不会拼进 shell 字符串。
     */
    let program = crate::mcp_runtime::resolve_program(&config.command).ok_or_else(|| {
        anyhow!(
            "找不到可执行文件：{}\n失败阶段：启动 MCP 进程\n提示：文件可能已被移动或卸载。安装后在 MCP 页点「重新检测」——应用每次都会重新读取用户级与系统级 PATH，不需要重启。\nHint: executable not found: {}. Install it, then use \"Re-check\" in the MCP page; no restart is needed.",
            config.command,
            config.command
        )
    })?;
    let args = program.arguments(&config.args);
    let mut command = crate::mcp_runtime::launch_command(&program, &args);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        /*
         * 必须读 stderr：npx / uvx / Node 启动失败的原因只写在这里。
         * 之前设为 null，界面只能看到"进程提前退出"，用户没法排查。
         * 读取任务做上限截断，避免服务狂刷日志把内存打满。
         */
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // 子进程可能再拉起 node / python / docker：把补全后的 PATH 一并交给它。
    command.env("PATH", crate::mcp_runtime::child_path());
    for item in &config.env {
        if !item.name.trim().is_empty() {
            command.env(&item.name, &item.value);
        }
    }
    let mut child = command.spawn().map_err(|error| {
        let reason = match error.kind() {
            std::io::ErrorKind::NotFound => "可执行文件不存在或已被移动",
            std::io::ErrorKind::PermissionDenied => "没有执行权限",
            _ => "系统拒绝启动",
        };
        anyhow!(
            "启动 MCP 服务失败：{} {}\n失败阶段：启动 MCP 进程\n原因：{}（{}）\n提示：在 MCP 页点「重新检测」确认运行环境路径。",
            crate::mcp_runtime::mask_path(&program.path.to_string_lossy()),
            args.join(" "),
            reason,
            error
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("MCP 进程没有 stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("MCP 进程没有 stdout"))?;
    let mut input = stdin;
    let mut lines = BufReader::new(stdout).lines();
    // 非 JSON 的 stdout 行（有些启动脚本把日志写到 stdout）也留给错误提示。
    let mut stdout_log = String::new();
    let stderr_pipe = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut captured = String::new();
        if let Some(stderr) = stderr_pipe {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if captured.len() >= 8 * 1024 {
                    continue;
                }
                captured.push_str(&line);
                captured.push('\n');
            }
        }
        captured
    });

    // 失败时告诉用户卡在哪一步：启动进程 / 初始化握手 / 读取能力。
    let mut stage = "初始化握手";
    let result = async {
        let mut next_id = 1u64;
        write_rpc(&mut input, next_id, "initialize", initialize_params()).await?;
        /*
         * 握手单独给预算：`npx -y` 第一次要下载运行时包，服务自己还要连集群 /
         * 远端目标，冷启动就贴着 25 秒。后续 `tools/list` 仍按原预算。
         */
        let init = read_response(
            &mut lines,
            next_id,
            request_timeout.max(HANDSHAKE_TIMEOUT),
            &mut stdout_log,
            "initialize",
        )
        .await?
        .map_err(|error| anyhow!(error))?;
        validate_protocol("stdio", &init)?;
        stage = "读取服务能力";
        // initialized 通知（没有 id，不需要等响应）。
        let notification = json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        input
            .write_all(format!("{notification}\n").as_bytes())
            .await
            .context("向 MCP 进程写通知失败")?;
        input.flush().await.ok();

        let mut out = Vec::new();
        for (method, params) in plan(&init) {
            next_id += 1;
            write_rpc(&mut input, next_id, &method, params).await?;
            let response = read_response(
                &mut lines,
                next_id,
                request_timeout,
                &mut stdout_log,
                &method,
            )
            .await?;
            out.push((method, response));
        }
        Ok::<_, anyhow::Error>(SessionOutput {
            initialize: init,
            results: out,
        })
    }
    .await;

    // 进程若已自己退出，先把退出码取出来；提前退出正是最常见的失败。
    let exit_status = child.try_wait().ok().flatten();
    // `cmd /C npx` 会再起 node：只杀 cmd 会留下孤儿子进程，Windows 上按树杀。
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    let _ = child.kill().await;
    let stderr_text = timeout(Duration::from_secs(2), stderr_task)
        .await
        .ok()
        .and_then(|joined| joined.ok())
        .unwrap_or_default();
    let mut logs = stdout_log;
    if !stderr_text.trim().is_empty() {
        if !logs.trim().is_empty() {
            logs.push('\n');
        }
        logs.push_str(&stderr_text);
    }

    result.map_err(|error| {
        let mut message = format!("{}\n失败阶段：{stage}", error);
        if let Some(status) = exit_status {
            message.push_str(&format!(
                "\n进程退出码：{}",
                status.code().map(|code| code.to_string()).unwrap_or_else(|| "未知".to_string())
            ));
        }
        let tail = logs.trim();
        if !tail.is_empty() {
            // 诊断信息可能被服务自己打印的日志带出令牌，展示前先做掩码。
            let tail: String = redact_logs(&tail.chars().take(4000).collect::<String>());
            message.push_str("\n启动日志：\n");
            message.push_str(&tail);
        }
        if let Some(hint) = failure_hint(&config.command, tail) {
            message.push('\n');
            message.push_str(&hint);
        }
        anyhow!(message)
    })
}

/// 把命令归类成用户能理解的名字（绝对路径也能正确归类）。
fn runtime_label(command: &str) -> &'static str {
    let name = Path::new(command.trim())
        .file_name()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let name = name
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd")
        .trim_end_matches(".bat");
    if name.starts_with("uv") {
        "uv / uvx"
    } else if matches!(name, "node" | "npx" | "npm" | "pnpm" | "yarn" | "bun") {
        "Node.js / npx"
    } else if name.starts_with("docker") {
        "Docker"
    } else {
        "本地运行环境"
    }
}

/// 启动日志里的凭据掩码：保留键名，值一律变成 `***`。
///
/// 只处理"看起来像凭据"的行，避免把普通堆栈改得看不懂。
fn redact_logs(logs: &str) -> String {
    const KEYS: [&str; 10] = [
        "authorization",
        "bearer ",
        "api_key",
        "apikey",
        "api-key",
        "access_token",
        "token",
        "password",
        "secret",
        "credential",
    ];
    logs.lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if !KEYS.iter().any(|key| lower.contains(key)) {
                return line.to_string();
            }
            // `KEY=value` → `KEY=***`
            if let Some(index) = line.find('=') {
                return format!("{}=***", &line[..index]);
            }
            // `Authorization: Bearer xxx` → `Authorization: ***`
            if let Some(index) = line.find(':') {
                return format!("{}: ***", &line[..index]);
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 根据失败日志给出下一步。
///
/// 关键点：**只有**"命令本身不可执行"才算运行环境缺失。npm 的 404、网络
/// 不可达、Docker 服务没起、MCP 自己握手失败都要分开说，不能统一报"没装"。
fn failure_hint(command: &str, logs: &str) -> Option<String> {
    let lower = logs.to_ascii_lowercase();
    let runtime = runtime_label(command);
    if crate::mcp_runtime::logs_daemon_unreachable(logs) {
        return Some(
            "提示：Docker 已安装，但服务尚未启动。请先启动 Docker Desktop / dockerd，再点「重试」。\n\
             Hint: Docker is installed but the service is not running. Start Docker, then retry."
                .to_string(),
        );
    }
    if lower.contains("pull access denied")
        || lower.contains("manifest unknown")
        || lower.contains("no such image")
        || lower.contains("failed to pull")
        || lower.contains("error pulling image")
    {
        return Some(
            "提示：Docker 镜像拉取失败，请检查镜像名、网络或镜像仓库凭据。\n\
             Hint: Pulling the Docker image failed. Check the image name, network, or registry credentials."
                .to_string(),
        );
    }
    /*
     * 只认"进程根本起不来"的特征。`ENOENT` 单独出现时更可能是 npm 在抱怨
     * 某个文件不存在（包本身有问题），不能当成运行环境缺失。
     */
    if lower.contains("not recognized")
        || lower.contains("command not found")
        || (lower.contains("enoent") && lower.contains("spawn"))
        || logs.contains("不是内部或外部命令")
        || lower.contains("找不到可执行文件")
    {
        return Some(format!(
            "提示：找不到 {runtime} 可执行文件（已在应用 PATH、用户级 PATH、系统级 PATH 和常见安装位置中查找）。安装后在 MCP 页点「重新检测」，不需要重启应用。\n\
             Hint: {runtime} executable not found. Install it, then use \"Re-check\" in the MCP page; no restart is needed."
        ));
    }
    if lower.contains("e404")
        || lower.contains("404 not found")
        || lower.contains("etarget")
        || lower.contains("no matching version")
    {
        return Some(
            "提示：MCP 包不存在或版本不可用，请核对包名和版本；这是包的问题，不是运行环境缺失。\n\
             Hint: The MCP package or version does not exist. This is a package problem, not a missing runtime."
                .to_string(),
        );
    }
    if lower.contains("enotfound")
        || lower.contains("eai_again")
        || lower.contains("etimedout")
        || lower.contains("econnrefused")
        || lower.contains("getaddrinfo")
        || lower.contains("network request failed")
        || lower.contains("下不到")
    {
        return Some(
            "提示：MCP 包下载失败，请检查网络或代理后重试。\n\
             Hint: Downloading the MCP package failed. Check the network or proxy, then retry."
                .to_string(),
        );
    }
    if lower.contains("permission denied") || lower.contains("eacces") || logs.contains("拒绝访问") {
        return Some(
            "提示：当前用户没有执行权限或访问 Docker 的权限，请检查文件权限／用户组。\n\
             Hint: Permission denied. Check the file permissions or Docker group membership."
                .to_string(),
        );
    }
    None
}

async fn http_session<F>(
    config: &McpServerConfig,
    plan: &F,
    request_timeout: Duration,
) -> Result<SessionOutput>
where
    F: Fn(&Value) -> Vec<(String, Value)> + ?Sized,
{
    let client = reqwest::Client::builder()
        .timeout(request_timeout)
        .build()
        .context("创建 MCP HTTP 客户端失败")?;
    let mut headers = reqwest::header::HeaderMap::new();
    for item in &config.headers {
        // 只有名字、没有值的项是"已删除的令牌"或未填写的模板字段，不发送。
        if item.name.trim().is_empty() || item.value.is_empty() {
            continue;
        }
        headers.insert(
            reqwest::header::HeaderName::from_bytes(item.name.trim().as_bytes())
                .with_context(|| format!("非法 Header 名称：{}", item.name))?,
            reqwest::header::HeaderValue::from_str(&item.value)
                .with_context(|| format!("非法 Header 值：{}", item.name))?,
        );
    }
    let post = |id: Option<u64>,
                method: &str,
                params: Value,
                session: Option<&str>,
                protocol: Option<&str>| {
        let mut body = json!({"jsonrpc":"2.0","method":method,"params":params});
        if let Some(id) = id {
            body["id"] = json!(id);
        }
        let mut request = client
            .post(&config.url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .json(&body);
        if !headers.is_empty() {
            request = request.headers(headers.clone());
        }
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        if let Some(protocol) = protocol {
            // Streamable HTTP 要求后续请求带上协商版本。
            request = request.header("mcp-protocol-version", protocol);
        }
        request.send()
    };

    let response = post(Some(1), "initialize", initialize_params(), None, None)
        .await
        .context("连接 MCP HTTP 服务失败")?;
    let session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let init = parse_http_response(response)
        .await?
        .map_err(|error| anyhow!(error))?;
    let protocol = validate_protocol("http", &init)?;
    // initialized 通知：多数服务会返回 202，失败不影响后续请求。
    let _ = post(
        None,
        "notifications/initialized",
        json!({}),
        session_id.as_deref(),
        Some(&protocol),
    )
    .await;

    let mut out = Vec::new();
    let mut next_id = 1u64;
    for (method, params) in plan(&init) {
        next_id += 1;
        let result = match post(
            Some(next_id),
            &method,
            params,
            session_id.as_deref(),
            Some(&protocol),
        )
        .await
        {
            Ok(response) => parse_http_response(response).await?,
            Err(error) => Err(format!("请求 MCP 服务失败：{error}")),
        };
        out.push((method, result));
    }
    // Streamable HTTP：会话用完主动结束，别把服务端会话一直挂着。
    if let Some(session) = session_id.as_deref() {
        let _ = client
            .delete(&config.url)
            .header("mcp-session-id", session)
            .header("mcp-protocol-version", &protocol)
            .send()
            .await;
    }
    Ok(SessionOutput {
        initialize: init,
        results: out,
    })
}

async fn write_rpc(
    input: &mut tokio::process::ChildStdin,
    id: u64,
    method: &str,
    params: Value,
) -> Result<()> {
    let body = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    input
        .write_all(format!("{body}\n").as_bytes())
        .await
        .with_context(|| format!("向 MCP 进程写 {method} 失败"))?;
    input.flush().await.ok();
    Ok(())
}

async fn read_response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
    request_timeout: Duration,
    logs: &mut String,
    method: &str,
) -> Result<Result<Value, String>> {
    // 超时文案带上阶段与预算：用户一眼能看出卡在启动还是工具发现。
    let timed_out = || {
        anyhow!(
            "等待 {method} 响应超时（已等 {} 秒）",
            request_timeout.as_secs()
        )
    };
    let deadline = Instant::now() + request_timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(timed_out());
        }
        let line = match timeout(remaining, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => return Err(anyhow!("MCP 进程提前退出")),
            Ok(Err(error)) => return Err(anyhow!("读取 MCP 输出失败：{error}")),
            Err(_) => return Err(timed_out()),
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            // 进程可能往 stdout 打日志；记下来并跳过。
            if logs.len() < 8 * 1024 {
                logs.push_str(trimmed);
                logs.push('\n');
            }
            continue;
        };
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("MCP 返回错误");
            // -32601（方法不存在）不是连接失败，交给调用方决定是否忽略。
            return Ok(Err(format!(
                "{}（code {}）",
                message,
                error.get("code").and_then(Value::as_i64).unwrap_or(0)
            )));
        }
        return Ok(Ok(value.get("result").cloned().unwrap_or(Value::Null)));
    }
}

/// 网络抖动 / 5xx 自动重试一次；4xx 直接返回可读错误。
pub async fn registry_search(query: &str, cursor: Option<&str>, limit: u32) -> Result<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .context("初始化 MCP Registry 客户端失败")?;
    /*
     * 运行环境探测与网络请求并行：探测最多几百毫秒（Docker 服务没起时可能更久），
     * 不应把搜索结果压在这后面。探测失败也不影响搜索本身。
     */
    let runtime_task = tokio::spawn(crate::mcp_runtime::probe_all());
    let mut last_error: Option<String> = None;
    for attempt in 0..2 {
        let mut url = reqwest::Url::parse("https://registry.modelcontextprotocol.io/v0.1/servers")
            .context("MCP Registry 地址不合法")?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("limit", &limit.clamp(1, 50).to_string());
            pairs.append_pair("version", "latest");
            if !query.trim().is_empty() {
                pairs.append_pair("search", query.trim());
            }
            if let Some(cursor) = cursor.filter(|value| !value.trim().is_empty()) {
                pairs.append_pair("cursor", cursor);
            }
        }
        match client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(
                reqwest::header::USER_AGENT,
                "BLS-OPS MCP Registry client/0.1",
            )
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let body: Value = response
                    .json()
                    .await
                    .context("解析 MCP Registry 响应失败")?;
                let mut normalized = normalize_registry(&body);
                // 与「重新检测」返回的是同一份报告：状态 + 诊断详情 + 检测时间。
                let report = match runtime_task.await {
                    Ok(report) => report,
                    // 探测线程异常退出：搜索仍然可用，状态显示为"未确认"。
                    Err(_) => crate::mcp_runtime::RuntimeReport {
                        checked_at: 0,
                        statuses: json!({}),
                        runtimes: Vec::new(),
                    },
                };
                normalized["runtimes"] = report.statuses.clone();
                normalized["runtimeDetails"] = serde_json::to_value(&report.runtimes)?;
                normalized["runtimeCheckedAt"] = json!(report.checked_at);
                return Ok(normalized);
            }
            Ok(response) if response.status().is_server_error() => {
                last_error = Some(format!(
                    "MCP Registry 暂时不可用（HTTP {}）",
                    response.status()
                ));
            }
            Ok(response) => {
                return Err(anyhow!(
                    "MCP Registry 请求失败（HTTP {}）",
                    response.status()
                ));
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        if attempt == 0 {
            tokio::time::sleep(Duration::from_millis(450)).await;
        }
    }
    Err(anyhow!(
        last_error.unwrap_or_else(|| "MCP Registry 请求失败".to_string())
    ))
}

fn normalize_registry(body: &Value) -> Value {
    let items = body
        .get("servers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let servers: Vec<Value> = items
        .into_iter()
        .filter(|item| item.pointer("/_meta/io.modelcontextprotocol.registry~1official/status").and_then(Value::as_str).map_or(true, |status| status == "active"))
        .map(|item| {
            let server = item.get("server").cloned().unwrap_or_else(|| item.clone());
            let name = server["name"].as_str().unwrap_or("").to_string();
            let publisher = name.split('/').next().unwrap_or("").to_string();
            let remotes: Vec<Value> = server["remotes"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .map(|remote| {
                            json!({
                                "type": remote["type"].as_str().unwrap_or("streamable-http"),
                                "url": remote["url"].as_str().unwrap_or(""),
                                "requiresConfiguration": remote["headers"].as_array().map_or(false, |items| !items.is_empty()) || remote["url"].as_str().map_or(false, |url| url.contains('{') || url.contains('}')),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let packages: Vec<Value> = server["packages"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .map(|package| {
                            json!({
                                "registryType": package["registryType"].as_str().unwrap_or(""),
                                "identifier": package["identifier"].as_str().unwrap_or(""),
                                "version": package["version"].as_str().unwrap_or(""),
                                "transport": package["transport"]["type"].as_str().unwrap_or("stdio"),
                                "requiresConfiguration": (["environmentVariables", "packageArguments", "runtimeArguments"].iter().any(|key| package[*key].as_array().map_or(false, |items| !items.is_empty()))),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "id": format!("registry:{}", if name.is_empty() { server["title"].as_str().unwrap_or("") } else { &name }),
                "name": server["title"].as_str().filter(|value| !value.is_empty()).unwrap_or(&name),
                "registryName": name,
                "iconUrl": server["icons"].as_array().and_then(|icons| icons.iter().filter_map(|icon| icon["src"].as_str()).find(|src| {
                    src.len() <= 2048 && reqwest::Url::parse(src).map(|url| url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none()).unwrap_or(false)
                })),
                "publisher": publisher,
                "description": server["description"].as_str().unwrap_or(""),
                "version": server["version"].as_str().unwrap_or(""),
                "repositoryUrl": server["repository"]["url"].as_str().unwrap_or(""),
                "websiteUrl": server["websiteUrl"].as_str().unwrap_or(""),
                "remotes": remotes,
                "packages": packages,
            })
        })
        .collect();
    let next = body
        .pointer("/metadata/nextCursor")
        .or_else(|| body.get("nextCursor"))
        .and_then(Value::as_str)
        .map(str::to_string);
    json!({ "servers": servers, "nextCursor": next })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_only_exposes_https_icons() {
        let result = normalize_registry(&json!({"servers": [
            {"server": {"name": "example/one", "icons": [{"src": "http://example.com/icon.png"}, {"src": "https://example.com/icon.png"}]}},
            {"server": {"name": "example/two", "icons": [{"src": "javascript:alert(1)"}]}}
        ]}));
        assert_eq!(
            result["servers"][0]["iconUrl"],
            "https://example.com/icon.png"
        );
        assert!(result["servers"][1]["iconUrl"].is_null());
    }

    fn binding() -> McpBinding {
        McpBinding {
            exposed_name: "mcp__s1__read_file".to_string(),
            server_id: "s1".to_string(),
            server_name: "demo".to_string(),
            tool: "read_file".to_string(),
            description: "读取一个文件".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
            read_only: true,
            config: McpServerConfig::default(),
        }
    }

    #[test]
    fn tool_schema_requires_step_only_in_plan_mode() {
        let plan = append_tool_schemas(json!([]), &[binding()], true, Lang::Zh);
        assert_eq!(plan[0]["function"]["name"], "mcp__s1__read_file");
        assert_eq!(
            plan[0]["function"]["parameters"]["properties"]["step"]["type"],
            "string"
        );
        let plain = append_tool_schemas(json!([]), &[binding()], false, Lang::Zh);
        assert!(plain[0]["function"]["parameters"]["properties"]
            .get("step")
            .is_none());
    }

    #[test]
    fn exposed_names_are_model_safe() {
        assert_eq!(sanitize("srv-1"), "srv-1");
        assert_eq!(sanitize("tools/read file"), "tools_read_file");
    }

    #[test]
    fn read_only_hint_is_only_a_claim_and_conflicts_are_unknown() {
        assert_eq!(
            classify_effect("read_file", "Read a file", &json!({}), true),
            McpEffect::DeclaredReadOnly
        );
        // 自相矛盾：声明只读，但名称是删除 / 执行。
        assert_eq!(
            classify_effect("delete_file", "", &json!({}), true),
            McpEffect::Unknown
        );
        assert_eq!(
            classify_effect("execute_sql", "", &json!({}), true),
            McpEffect::Unknown
        );
        assert_eq!(
            classify_effect("deleteFile", "", &json!({}), true),
            McpEffect::Unknown
        );
        // `post` / `run` 只是前缀的一部分，不能把常见只读工具误判成写入。
        assert_eq!(
            classify_effect("postgres_query", "", &json!({}), true),
            McpEffect::DeclaredReadOnly
        );
        // 参数会携带命令 / 正文：无法保证不写。
        assert_eq!(
            classify_effect(
                "inspect",
                "",
                &json!({"properties": {"command": {"type": "string"}}}),
                true
            ),
            McpEffect::Unknown
        );
        // 描述第一句是写动词同样按未知处理。
        assert_eq!(
            classify_effect("notes", "Update a note", &json!({}), true),
            McpEffect::Unknown
        );
        // 没有声明只读 = 写入。
        assert_eq!(
            classify_effect("inspect", "" , &json!({}), false),
            McpEffect::Write
        );
    }

    fn test_db() -> AppDb {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "bls-mcp-revalidate-{}-{}.db",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&path);
        let db = AppDb::new(path);
        db.init().unwrap();
        db
    }

    fn persisted_config() -> McpServerConfig {
        McpServerConfig {
            id: "s1".to_string(),
            name: "demo".to_string(),
            transport: "http".to_string(),
            url: "https://example.invalid/mcp".to_string(),
            enabled: true,
            status: "connected".to_string(),
            tools: vec![McpToolDef {
                name: "inspect".to_string(),
                description: Some("Inspect a value".to_string()),
                enabled: true,
                read_only: true,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn revalidation_follows_disabled_revoked_and_changed_declarations() {
        let db = test_db();
        let mut config = persisted_config();
        save_server(&db.open().unwrap(), &config).unwrap();
        let mut current = McpBinding {
            exposed_name: "mcp__s1__inspect".to_string(),
            server_id: "s1".to_string(),
            server_name: "demo".to_string(),
            tool: "inspect".to_string(),
            description: "Inspect a value".to_string(),
            input_schema: json!({}),
            read_only: true,
            config: config.clone(),
        };
        assert!(revalidate_binding(Some(&db), &mut current, true).is_ok());

        // 工具级停用：子任务立即不能再调用。
        config.tools[0].enabled = false;
        save_server(&db.open().unwrap(), &config).unwrap();
        assert_eq!(
            revalidate_binding(Some(&db), &mut current, true),
            Err(McpReject::ToolDisabled)
        );

        // 只读声明被撤销：不能再沿用启动时的 read_only。
        config.tools[0].enabled = true;
        config.tools[0].read_only = false;
        save_server(&db.open().unwrap(), &config).unwrap();
        assert_eq!(
            revalidate_binding(Some(&db), &mut current, true),
            Err(McpReject::ReadOnlyRevoked)
        );
        assert!(!current.read_only, "fresh declaration must replace the stale binding");

        // 服务停用 / 连接失效 / 工具消失。
        config.enabled = false;
        save_server(&db.open().unwrap(), &config).unwrap();
        assert_eq!(
            revalidate_binding(Some(&db), &mut current, true),
            Err(McpReject::Disabled)
        );
        config.enabled = true;
        config.status = "error".to_string();
        save_server(&db.open().unwrap(), &config).unwrap();
        assert_eq!(
            revalidate_binding(Some(&db), &mut current, true),
            Err(McpReject::Disconnected)
        );
        config.status = "connected".to_string();
        config.tools.clear();
        save_server(&db.open().unwrap(), &config).unwrap();
        assert_eq!(
            revalidate_binding(Some(&db), &mut current, true),
            Err(McpReject::ToolMissing)
        );

        let _ = std::fs::remove_file(db.path());
    }

    #[test]
    fn negotiates_streamable_http_protocol() {
        let modern = json!({"protocolVersion": "2025-06-18"});
        assert_eq!(validate_protocol("http", &modern).unwrap(), "2025-06-18");

        let fallback = json!({"protocolVersion": "2025-03-26"});
        assert!(validate_protocol("http", &fallback).is_ok());

        let legacy = json!({"protocolVersion": "2024-11-05"});
        assert!(validate_protocol("stdio", &legacy).is_ok());
        assert!(validate_protocol("http", &legacy).is_err());

        let unknown = json!({"protocolVersion": "2099-01-01"});
        assert!(validate_protocol("http", &unknown).is_err());
        assert!(validate_protocol("stdio", &json!({})).is_err());
    }

    #[test]
    fn only_connection_identity_invalidates_verification() {
        let mut previous = McpServerConfig {
            id: "s1".to_string(),
            name: "old".to_string(),
            transport: "http".to_string(),
            url: "https://example.com/mcp".to_string(),
            status: "connected".to_string(),
            ..McpServerConfig::default()
        };
        previous.headers.push(McpKeyValue {
            name: "Authorization".to_string(),
            value: String::new(),
            has_value: true,
        });
        let mut input = McpServerInput {
            name: "new name".to_string(),
            transport: "http".to_string(),
            url: "https://example.com/mcp".to_string(),
            ..McpServerInput::default()
        };
        input.headers.push(McpKeyValue {
            name: "Authorization".to_string(),
            value: String::new(),
            has_value: true,
        });
        assert!(!connection_changed(&previous, &input));

        input.url = "https://other.example.com/mcp".to_string();
        assert!(connection_changed(&previous, &input));

        input.url = previous.url.clone();
        input.headers[0].value = "Bearer new".to_string();
        assert!(connection_changed(&previous, &input));
    }

    #[test]
    fn new_connections_are_forced_to_global_scope() {
        let input = McpServerInput {
            name: "demo".to_string(),
            transport: "http".to_string(),
            url: "https://example.com/mcp".to_string(),
            binding: McpScope {
                scope: "server".to_string(),
                server_id: Some("s1".to_string()),
                workspace_id: None,
            },
            ..McpServerInput::default()
        };
        let config = draft_config(input).unwrap();
        assert_eq!(config.binding.scope, "global");
        assert!(config.binding.server_id.is_none());
        assert!(config.binding.workspace_id.is_none());
    }

    #[test]
    fn every_legacy_binding_is_global() {
        let legacy_server = McpScope {
            scope: "server".to_string(),
            server_id: Some("s1".to_string()),
            workspace_id: None,
        };
        assert!(binding_allows(&legacy_server, Some("s2"), None));
        let legacy_workspace = McpScope {
            scope: "workspace".to_string(),
            server_id: None,
            workspace_id: Some("w1".to_string()),
        };
        assert!(binding_allows(&legacy_workspace, None, Some("w2")));
        let empty = McpScope {
            scope: "server".to_string(),
            server_id: None,
            workspace_id: None,
        };
        assert!(binding_allows(&empty, None, None));
        let global = global_scope();
        assert_eq!(global.scope, "global");
        assert!(global.server_id.is_none());
        assert!(global.workspace_id.is_none());
    }

    #[test]
    fn runtime_labels_resolve_from_absolute_paths() {
        assert_eq!(runtime_label("uvx"), "uv / uvx");
        assert_eq!(runtime_label(r"C:\Users\me\.local\bin\uvx.exe"), "uv / uvx");
        assert_eq!(runtime_label("/opt/homebrew/bin/uv"), "uv / uvx");
        assert_eq!(runtime_label(r"C:\Program Files\nodejs\npx.cmd"), "Node.js / npx");
        assert_eq!(runtime_label("npx"), "Node.js / npx");
        assert_eq!(runtime_label("docker.exe"), "Docker");
        // 以前用 `contains("uv")` 判断，会把自定义命令误归类。
        assert_eq!(runtime_label("my-uver-mcp"), "本地运行环境");
    }

    #[test]
    fn package_download_failure_is_not_reported_as_missing_runtime() {
        let hint = failure_hint("npx", "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/demo").unwrap();
        assert!(hint.contains("包"));
        assert!(!hint.contains("找不到 Node.js / npx 可执行文件"));

        let network = failure_hint("npx", "npm ERR! code ENOTFOUND\nnpm ERR! network request failed").unwrap();
        assert!(network.contains("下载失败"));

        let docker = failure_hint("docker", "error during connect: docker daemon is not running").unwrap();
        assert!(docker.contains("Docker"));
        assert!(docker.contains("服务尚未启动"));

        let missing = failure_hint("uvx", "'uvx' 不是内部或外部命令，也不是可运行的程序").unwrap();
        assert!(missing.contains("找不到 uv / uvx"));
        assert!(missing.contains("重新检测"));
        // 不再要求用户重启应用。
        assert!(!missing.contains("重启 BLS-OPS"));

        assert!(failure_hint("npx", "MCP 进程握手超时").is_none());

        // npm 报某个文件不存在（ENOENT）不是"没装 Node"。
        assert!(failure_hint(
            "npx",
            "npm ERR! Error: ENOENT: no such file or directory, open 'C:\\tmp\\package.json'"
        )
        .is_none());
        // 真正的 spawn 失败才算。
        assert!(failure_hint("npx", "Error: spawn npx ENOENT")
            .unwrap()
            .contains("找不到 Node.js / npx"));
    }

    #[test]
    fn diagnostics_redact_credentials() {
        let redacted = redact_logs(
            "Starting demo\nAuthorization: Bearer sk-123456\nAPI_KEY=abc123\nlistening on 3000",
        );
        assert!(!redacted.contains("sk-123456"));
        assert!(!redacted.contains("abc123"));
        assert!(redacted.contains("listening on 3000"));
        assert!(redacted.contains("Starting demo"));
    }

    #[test]
    fn requests_follow_declared_capabilities() {
        let tools_only = capability_requests(&json!({
            "capabilities": { "tools": {} }
        }));
        assert_eq!(
            tools_only
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec!["tools/list"]
        );

        let all = capability_requests(&json!({
            "capabilities": { "tools": {}, "resources": {}, "prompts": {} }
        }));
        assert_eq!(
            all.iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec!["tools/list", "resources/list", "prompts/list"]
        );

        // 没有 capabilities 的旧服务：只探测 tools，保持兼容。
        let legacy = capability_requests(&json!({}));
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].0, "tools/list");
    }
}

async fn parse_http_response(response: reqwest::Response) -> Result<Result<Value, String>> {
    let status = response.status();
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    let text = response.text().await.context("读取 MCP 响应失败")?;
    if !status.is_success() && text.trim().is_empty() {
        return Ok(Err(format!("MCP HTTP {}", status.as_u16())));
    }
    let value = if is_sse {
        text.lines()
            .filter_map(|line| line.trim().strip_prefix("data:"))
            .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
            .find(|value| value.get("id").is_some())
            .or_else(|| serde_json::from_str::<Value>(text.trim()).ok())
    } else {
        serde_json::from_str::<Value>(text.trim()).ok()
    };
    let Some(value) = value else {
        return Ok(Err(format!(
            "MCP 返回了无法解析的响应（HTTP {}）",
            status.as_u16()
        )));
    };
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP 返回错误");
        return Ok(Err(format!("{message}（HTTP {}）", status.as_u16())));
    }
    Ok(Ok(value.get("result").cloned().unwrap_or(Value::Null)))
}
