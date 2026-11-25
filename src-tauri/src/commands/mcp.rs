//! MCP 服务管理 IPC：列表 / 保存 / 删除 / 测试连接 / 工具启停。
//!
//! 真正的 JSON-RPC 客户端在 `crate::mcp`；命令层只做参数与错误转换。

use serde_json::Value;
use tauri::State;

use crate::mcp::{self, McpServerConfig, McpServerInput, McpTestResult};
use crate::ops_error::{OpsError, OpsResult};
use crate::state::AppState;

#[tauri::command]
pub fn mcp_server_list(state: State<'_, AppState>) -> OpsResult<Vec<McpServerConfig>> {
    mcp::list_servers(&state.db).map_err(|error| OpsError::new("config", error.to_string()))
}

#[tauri::command]
pub fn mcp_server_save(
    state: State<'_, AppState>,
    request: McpServerInput,
) -> OpsResult<McpServerConfig> {
    mcp::save(&state.db, request).map_err(|error| OpsError::new("config", error.to_string()))
}

#[tauri::command]
pub fn mcp_server_delete(state: State<'_, AppState>, id: String) -> OpsResult<()> {
    mcp::delete(&state.db, &id).map_err(|error| OpsError::new("config", error.to_string()))
}

/// 测试连接并刷新能力（tools / resources / prompts）。
#[tauri::command]
pub async fn mcp_server_test(
    state: State<'_, AppState>,
    id: String,
) -> OpsResult<McpTestResult> {
    let db = state.db.clone();
    mcp::test(&db, &id)
        .await
        .map_err(|error| OpsError::new("mcp", error.to_string()))
}

/// 未保存配置的连接测试：表单里先测再存，不落库、不写钥匙串。
#[tauri::command]
pub async fn mcp_server_test_draft(request: McpServerInput) -> OpsResult<McpTestResult> {
    let config =
        mcp::draft_config(request).map_err(|error| OpsError::new("config", error.to_string()))?;
    Ok(mcp::test_draft(&config).await)
}

/// 官方 MCP Registry 搜索（关键词 / 分页 / 失败重试在客户端实现）。
#[tauri::command]
pub async fn mcp_registry_search(
    query: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> OpsResult<Value> {
    mcp::registry_search(&query, cursor.as_deref(), limit.unwrap_or(20))
        .await
        .map_err(|error| OpsError::new("mcp", error.to_string()))
}

/// 单个工具启用状态（只改缓存，不触发连接）。
#[tauri::command]
pub fn mcp_tool_set_enabled(
    state: State<'_, AppState>,
    id: String,
    tool: String,
    enabled: bool,
) -> OpsResult<()> {
    mcp::set_tool_enabled(&state.db, &id, &tool, enabled)
        .map_err(|error| OpsError::new("config", error.to_string()))
}
