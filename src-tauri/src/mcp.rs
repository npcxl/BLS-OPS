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
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use crate::db::AppDb;
use crate::keyring;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
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
    for (kind, items) in [
        ("header", &mut config.headers),
        ("env", &mut config.env),
    ] {
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
    for (kind, items) in [
        ("header", &mut config.headers),
        ("env", &mut config.env),
    ] {
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
    for (kind, items) in [
        ("header", &mut config.headers),
        ("env", &mut config.env),
    ] {
        for item in items.iter_mut() {
            if !item.value.is_empty() {
                item.has_value = true;
                continue;
            }
            item.has_value = keyring::read_secret(&secret_account(&config.id, kind, &item.name)).is_ok();
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
        if let Ok(config) = serde_json::from_str::<McpServerConfig>(&payload) {
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
    serde_json::from_str(&payload).context("MCP 服务配置损坏")
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
        binding: input.binding,
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
    let previous = load_servers(&conn)?
        .into_iter()
        .find(|item| item.id == id);
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
        binding: input.binding,
        default_enabled: input.default_enabled,
        transport,
        command: input.command.trim().to_string(),
        args: input.args,
        env: input.env,
        url: input.url.trim().to_string(),
        headers: input.headers,
        enabled: input.enabled,
        tools,
        resources: if changed {
            Vec::new()
        } else {
            input.resources
        },
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
            previous.as_ref().and_then(|item| item.protocol_version.clone())
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
        || input
            .env
            .iter()
            .any(|item| !item.value.trim().is_empty())
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
    let mut config = load_one(&conn, id)?;
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
            save_server(&conn, &config)?;
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
            /*
             * 重新验证失败后旧的工具列表不能再留在连接上：否则聊天里仍能勾选
             * 一个已经失效的实例。失败本身保留真实阶段，前端据此区分
             * "连接失败" 与 "工具发现失败"。
             */
            config.status = if error.stage == "tools" {
                "tools_error".to_string()
            } else {
                "error".to_string()
            };
            config.error = Some(error.message.clone());
            config.tools.clear();
            config.resources.clear();
            config.prompts.clear();
            config.warnings.clear();
            config.updated_at = crate::db::AppDb::now() as u64;
            let conn = db.open()?;
            save_server(&conn, &config)?;
            Ok(McpTestResult {
                ok: false,
                latency_ms,
                status: config.status.clone(),
                error: Some(error.message),
                warnings: Vec::new(),
                protocol_version: config.protocol_version.clone(),
                tools: Vec::new(),
                resources: Vec::new(),
                prompts: Vec::new(),
            })
        }
    }
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
        .map_err(CapabilityFailure::handshake)?;
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
        name: value.get("name").and_then(Value::as_str).map(str::to_string),
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
    let wanted: std::collections::HashSet<&str> =
        enabled.iter().map(String::as_str).collect();
    let conn = db.open()?;
    let servers = load_servers(&conn)?;
    let mut out = Vec::new();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for server in servers
        .into_iter()
        // 未验证 / 连接失败 / 工具发现失败的实例不注入工具。
        .filter(|item| item.enabled && item.status == "connected")
        .filter(|item| binding_allows(&item.binding, server_id, workspace_id))
    {
        for tool in server.tools.iter().filter(|item| item.enabled) {
            let mut exposed = format!(
                "mcp__{}__{}",
                sanitize(&server.id),
                sanitize(&tool.name)
            );
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

/// 连接实例是否允许在**这个任务**里使用。
///
/// 旧记录没有绑定 id 时按全局兼容；显式绑定后只对对应服务器 / 工作区生效。
pub fn binding_allows(
    scope: &McpScope,
    server_id: Option<&str>,
    workspace_id: Option<&str>,
) -> bool {
    match scope.scope.as_str() {
        "server" => scope
            .server_id
            .as_deref()
            .map(|bound| Some(bound) == server_id)
            .unwrap_or(true),
        "workspace" => scope
            .workspace_id
            .as_deref()
            .map(|bound| Some(bound) == workspace_id)
            .unwrap_or(true),
        _ => true,
    }
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
        && config.tools.iter().any(|item| item.name == tool && item.enabled))
}

/// 追加 MCP 工具的原生 schema；计划模式下要求模型带上 `step`。
pub fn append_tool_schemas(schemas: Value, bindings: &[McpBinding], plan_required: bool) -> Value {
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
                        "description": "这次调用属于执行计划的哪一步（步骤 id）"
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
                    if binding.read_only { "（只读）" } else { "" }
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
    format!("{}\n…（输出超过 {} KB，已截断）", &text[..end], OUTPUT_LIMIT / 1024)
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
    let rank = protocol_rank(version)
        .ok_or_else(|| anyhow!("服务协商到不支持的协议版本 {version}"))?;
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
     * Windows 上 `npx` / `uvx` 往往是 `.cmd` 或 shim，CreateProcess 不会像
     * 终端那样按 PATHEXT 展开；直接 `Command::new("npx")` 会报"找不到程序"。
     * 统一经 `cmd /C` 启动，行为与用户在终端里输入一致。
     */
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(&config.command).args(&config.args);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(&config.command);
        command.args(&config.args);
        command
    };
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
    for item in &config.env {
        if !item.name.trim().is_empty() {
            command.env(&item.name, &item.value);
        }
    }
    #[cfg(windows)]
    {
        // 不弹控制台窗口。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| {
        anyhow!(
            "启动 MCP 服务失败：{} {}（{error}）",
            config.command,
            config.args.join(" ")
        )
    })?;
    let stdin = child.stdin.take().ok_or_else(|| anyhow!("MCP 进程没有 stdin"))?;
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

    let result = async {
        let mut next_id = 1u64;
        write_rpc(&mut input, next_id, "initialize", initialize_params()).await?;
        let init = read_response(&mut lines, next_id, request_timeout, &mut stdout_log)
            .await?
            .map_err(|error| anyhow!(error))?;
        validate_protocol("stdio", &init)?;
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
            let response =
                read_response(&mut lines, next_id, request_timeout, &mut stdout_log).await?;
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
        let mut message = error.to_string();
        if let Some(status) = exit_status {
            message.push_str(&format!(
                "\n进程退出码：{}",
                status.code().map(|code| code.to_string()).unwrap_or_else(|| "未知".to_string())
            ));
        }
        let tail = logs.trim();
        if !tail.is_empty() {
            let tail: String = tail.chars().take(4000).collect();
            message.push_str("\n启动日志：\n");
            message.push_str(&tail);
        }
        let lower = tail.to_ascii_lowercase();
        /*
         * 只对"命令本身不可执行"给安装提示。npm 的 404 响应里也有
         * "Not Found"，那是包名不存在，不能误报成没装 Node。
         */
        if lower.contains("not recognized")
            || lower.contains("command not found")
            || lower.contains("enoent")
            || tail.contains("不是内部或外部命令")
        {
            let runtime = if config.command.to_ascii_lowercase().contains("uv") {
                "uv / uvx"
            } else {
                "Node.js / npx"
            };
            message.push_str(&format!(
                "\n提示：本机没有可执行的 {runtime}，请先在「我的连接」点「安装运行环境」安装后重启 BLS-OPS。\n\
                 Hint: {runtime} is not available on this machine. Install it from \"Install runtime\" under My Connections, then restart BLS-OPS."
            ));
        } else if lower.contains("e404") || lower.contains("404 not found") {
            message.push_str(
                "\n提示：这个 npm 包不存在，请核对包名和版本。\n\
                 Hint: This npm package does not exist. Check the package name and version.",
            );
        }
        anyhow!(message)
    })
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
) -> Result<Result<Value, String>> {
    let deadline = Instant::now() + request_timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(anyhow!("等待 MCP 响应超时"));
        }
        let line = match timeout(remaining, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => return Err(anyhow!("MCP 进程提前退出")),
            Ok(Err(error)) => return Err(anyhow!("读取 MCP 输出失败：{error}")),
            Err(_) => return Err(anyhow!("等待 MCP 响应超时")),
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
            return Ok(Err(format!("{}（code {}）", message, error.get("code").and_then(Value::as_i64).unwrap_or(0))));
        }
        return Ok(Ok(value.get("result").cloned().unwrap_or(Value::Null)));
    }
}

/// 官方 MCP Registry 搜索：只做请求与字段归一化，目录语义留给前端。
///
/// 网络抖动 / 5xx 自动重试一次；4xx 直接返回可读错误。
pub async fn registry_search(query: &str, cursor: Option<&str>, limit: u32) -> Result<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .context("初始化 MCP Registry 客户端失败")?;
    let mut last_error: Option<String> = None;
    for attempt in 0..2 {
        let mut url = reqwest::Url::parse("https://registry.modelcontextprotocol.io/v0/servers")
            .context("MCP Registry 地址不合法")?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("limit", &limit.clamp(1, 50).to_string());
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
                return Ok(normalize_registry(&body));
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
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "id": format!("registry:{}", if name.is_empty() { server["title"].as_str().unwrap_or("") } else { &name }),
                "name": server["title"].as_str().filter(|value| !value.is_empty()).unwrap_or(&name),
                "registryName": name,
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
        let plan = append_tool_schemas(json!([]), &[binding()], true);
        assert_eq!(plan[0]["function"]["name"], "mcp__s1__read_file");
        assert_eq!(
            plan[0]["function"]["parameters"]["properties"]["step"]["type"],
            "string"
        );
        let plain = append_tool_schemas(json!([]), &[binding()], false);
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
    fn requests_follow_declared_capabilities() {
        let tools_only = capability_requests(&json!({
            "capabilities": { "tools": {} }
        }));
        assert_eq!(
            tools_only.iter().map(|(method, _)| method.as_str()).collect::<Vec<_>>(),
            vec!["tools/list"]
        );

        let all = capability_requests(&json!({
            "capabilities": { "tools": {}, "resources": {}, "prompts": {} }
        }));
        assert_eq!(
            all.iter().map(|(method, _)| method.as_str()).collect::<Vec<_>>(),
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
