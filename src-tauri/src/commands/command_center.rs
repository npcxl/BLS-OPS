//! P4 命令中心的 Tauri 命令：检索、执行、收藏、工具探测。
//!
//! 安全边界：前端只传 `knowledgeId` + [`CommandParams`]（结构化参数），
//! 动作在 `command_center::build_exec` 组装、命令字符串在 `safe.rs` 拼 ——
//! 这里没有任何 shell 文本通道。
//!
//! P4.3.2 服务器上下文：执行前对 `requires` 做 `command -v` 硬校验 ——
//! 没装 Docker 的服务器上，任何 docker 命令都到不了 shell；检索侧的
//! 置灰由 `command_probe_tools` 提供数据，两层防线互不依赖。

use serde::Serialize;
use tauri::State;

use super::{open_db, record_audit};
use crate::command_center::{build_exec, builtin_catalog, search, CommandParams, CommandSearchHit};
use crate::docker;
use crate::remote::run_capability;
use crate::safe::{Capability, ProbeTool};
use crate::state::AppState;

/// 一次执行的原始输出（**永久保留**，结构化只是第二种视图）。
#[derive(Debug, Clone, Serialize)]
pub struct CommandRawOutput {
    /// 实际执行的命令（可能与知识条目展示语法不同 —— 必须如实展示）。
    pub command_executed: String,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

/// 一次执行的完整结果。
#[derive(Debug, Clone, Serialize)]
pub struct CommandExecutionResult {
    pub knowledge_id: String,
    pub title: String,
    pub risk: crate::command_center::RiskLevel,
    pub raw: CommandRawOutput,
    /// 结构化视图（`{"adapter": "...", ...}`）；`null` = 无专用解析，
    /// 前端显示原始输出。
    pub structured: Option<serde_json::Value>,
}

/// 检索命令（前缀 / 中文别名 / 场景 / 子序列模糊 + 收藏使用加权）。
#[tauri::command]
pub async fn command_search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<CommandSearchHit>, String> {
    let ctx = {
        let conn = open_db(&state)?;
        search::SearchContext::load(&conn).map_err(|error| error.to_string())?
    };
    Ok(search::search(
        builtin_catalog(),
        &query,
        &ctx,
        limit.unwrap_or(12).clamp(1, 50) as usize,
    ))
}

/// 探测服务器上真实存在的工具（`command -v`，白名单枚举）。
///
/// 返回 `tools` 的**存在子集**。前端用它给"需要未安装工具"的命令置灰并
/// 解释原因；`command_execute` 里另有独立硬校验，这里只是体验层。
#[tauri::command]
pub async fn command_probe_tools(
    state: State<'_, AppState>,
    session_id: String,
    tools: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut installed = Vec::new();
    for name in tools.iter().take(24) {
        let Some(tool) = probe_tool_by_name(name) else {
            continue; // 非白名单工具名直接忽略（不可能来自 CATALOG 之外）。
        };
        match run_capability(&state.ssh, &session_id, &Capability::Probe(tool)).await {
            Ok(_) => installed.push(name.clone()),
            Err(_) => continue, // 未安装：不在返回列表里。
        }
    }
    Ok(installed)
}

/// 工具名 → 白名单探测枚举。与 `ProbeTool::name()` 对齐；
/// 名字不在白名单内返回 `None`（绝不探测任意字符串）。
fn probe_tool_by_name(name: &str) -> Option<ProbeTool> {
    let tool = match name {
        "docker" => ProbeTool::Docker,
        "docker-compose" => ProbeTool::DockerCompose,
        "podman" => ProbeTool::Podman,
        "systemctl" => ProbeTool::Systemctl,
        "nginx" => ProbeTool::Nginx,
        "git" => ProbeTool::Git,
        "node" => ProbeTool::Node,
        "npm" => ProbeTool::Npm,
        "pnpm" => ProbeTool::Pnpm,
        "yarn" => ProbeTool::Yarn,
        "java" => ProbeTool::Java,
        "mvn" => ProbeTool::Maven,
        "gradle" => ProbeTool::Gradle,
        "python3" => ProbeTool::Python,
        "pip3" => ProbeTool::Pip,
        "cargo" => ProbeTool::Cargo,
        "go" => ProbeTool::Go,
        "pm2" => ProbeTool::Pm2,
        "kubectl" => ProbeTool::Kubectl,
        "mysqladmin" => ProbeTool::Mysql,
        "psql" => ProbeTool::Psql,
        "redis-cli" => ProbeTool::Redis,
        "rabbitmqctl" => ProbeTool::Rabbitmq,
        "journalctl" => ProbeTool::Journalctl,
        _ => return None,
    };
    Some(tool)
}

/// 二级参数补全：从**服务器实时**取真实取值，用于把展示语法里的
/// `<unit>` / `<容器>` / `<路径>` 替换成具体值。
///
/// 这是"占位符绝不进 shell"的数据来源端：终端选中 `journalctl -u <unit>`
/// 后打开选择器，这里返回服务器上真的存在的服务单元名，用户选完才生成
/// `journalctl -u nginx.service -n 200 --no-pager`。
///
/// 取值全部走既有白名单能力（`Capability::ListServices` / `DockerPs` /
/// SFTP 列目录），本函数不拼任何 shell 文本。
#[tauri::command]
pub async fn command_param_values(
    state: State<'_, AppState>,
    session_id: String,
    param: String,
) -> Result<Vec<String>, String> {
    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".into());
    }
    match param.as_str() {
        // systemd 服务单元：`systemctl list-units --type=service --all`。
        "unit" => {
            let output = run_capability(&state.ssh, &session_id, &Capability::ListServices)
                .await
                .map_err(|e| e.to_string())?;
            let units = crate::systemd::parse_list_units(&output);
            let mut names: Vec<String> = units.into_iter().map(|unit| unit.unit).collect();
            names.sort();
            names.dedup();
            Ok(names)
        }
        // Docker 容器名：`docker ps -a`。
        "container" => {
            let output = run_capability(&state.ssh, &session_id, &Capability::DockerPs)
                .await
                .map_err(|e| e.to_string())?;
            let containers = docker::parse_ps(&output);
            let mut names: Vec<String> = containers
                .into_iter()
                .map(|container| container.name)
                .filter(|name| !name.trim().is_empty())
                .collect();
            names.sort();
            names.dedup();
            Ok(names)
        }
        // 远程目录：复用 SFTP 列目录（只读）。
        "path" => {
            let (current, entries) = state
                .ssh
                .sftp_list_dir(&session_id, None)
                .await
                .map_err(|e| e.to_string())?;
            let mut dirs: Vec<String> = entries
                .into_iter()
                .filter(|entry| entry.kind == "directory")
                .map(|entry| entry.path)
                .collect();
            dirs.sort();
            dirs.dedup();
            // 当前目录本身也是合法取值（相对路径场景）。
            let mut out = vec![current];
            out.extend(dirs);
            Ok(out)
        }
        _ => Err(format!("不支持的参数类型：{param}")),
    }
}

/// 执行一条知识库命令。
///
/// 只读命令直接执行；medium（restart / reload 等）要求前端先展示
/// 确认弹窗 —— 后端照常执行并写审计。执行前的两道防线：
/// ① `requires` 工具存在性硬校验（未安装直接拒绝）；
/// ② Nginx reload 特例：先自动跑 `nginx -t`，失败则拒绝 reload。
#[tauri::command]
pub async fn command_execute(
    state: State<'_, AppState>,
    session_id: String,
    knowledge_id: String,
    params: Option<CommandParams>,
) -> Result<CommandExecutionResult, String> {
    let params = params.unwrap_or_default();
    let Some(entry) = builtin_catalog().iter().find(|e| e.id == knowledge_id) else {
        return Err(format!("知识库中不存在命令 {knowledge_id}"));
    };
    if !entry.executable_now() {
        return Err("该命令当前不提供执行（见知识库说明）".to_string());
    }
    let exec = build_exec(entry.exec, &params, entry.requires).map_err(|e| e.to_string())?;
    let capability = exec.capability();

    // 硬校验：需要的服务器工具必须真实存在（与前端置灰独立）。
    for required in entry.requires {
        let Some(tool) = probe_tool_by_name(required.name()) else {
            continue;
        };
        let probe = run_capability(&state.ssh, &session_id, &Capability::Probe(tool)).await;
        if probe.is_err() {
            return Err(format!(
                "服务器未安装 {}，无法执行「{}」",
                required.name(),
                entry.title
            ));
        }
    }

    // Nginx reload 前置校验（与 services 模块同一纪律：先 nginx -t 再 reload）。
    if matches!(exec, crate::command_center::KnowledgeExec::NginxReload) {
        let test = run_capability(&state.ssh, &session_id, &Capability::NginxTest)
            .await
            .map_err(|error| format!("nginx -t 校验失败，已取消 reload：{error}"))?;
        if !test.to_lowercase().contains("successful") {
            return Err(format!("nginx -t 未通过，已取消 reload：{}", test.trim()));
        }
    }

    let started = std::time::Instant::now();
    let stdout = run_capability(&state.ssh, &session_id, &capability)
        .await
        .map_err(|error| error.to_string())?;
    let duration_ms = started.elapsed().as_millis() as u64;
    let command_executed = capability.command().unwrap_or_default();
    let raw = CommandRawOutput {
        command_executed: command_executed.clone(),
        stdout: stdout.clone(),
        // run_capability 只回 stdout；stderr 已并入错误路径。保留字段以稳定前端契约。
        stderr: String::new(),
        duration_ms,
    };
    let structured = structure_output(
        entry.output_adapter,
        &stdout,
        entry.title,
        &command_executed,
        duration_ms,
    );

    // 使用统计 + 审计（修改型命令必须留痕）。
    {
        let conn = open_db(&state)?;
        let _ = crate::db::command_usage_record(&conn, &knowledge_id);
    }
    if entry.mutability != crate::command_center::Mutability::Read {
        record_audit(
            &state,
            "command_center.execute",
            Some(&session_id),
            None,
            &format!("{} ({})", entry.id, entry.title),
        );
    }

    Ok(CommandExecutionResult {
        knowledge_id: knowledge_id.clone(),
        title: entry.title.to_string(),
        risk: entry.risk,
        raw,
        structured,
    })
}

/// 收藏 / 取消收藏，返回切换后的状态。
#[tauri::command]
pub async fn command_toggle_favorite(
    state: State<'_, AppState>,
    knowledge_id: String,
) -> Result<bool, String> {
    let conn = open_db(&state)?;
    crate::db::command_favorite_toggle(&conn, &knowledge_id).map_err(|error| error.to_string())
}

/// 收藏列表。
#[tauri::command]
pub async fn command_favorites(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn = open_db(&state)?;
    crate::db::command_favorites(&conn).map_err(|error| error.to_string())
}

/// 知识库元信息：分类统计（前端分组头） + 总数。
#[derive(Debug, Serialize)]
pub struct CommandCatalogMeta {
    pub total: u32,
    pub executable: u32,
    pub categories: Vec<(String, String, u32)>,
}

#[tauri::command]
pub async fn command_catalog_meta() -> Result<CommandCatalogMeta, String> {
    let catalog = builtin_catalog();
    let mut categories: Vec<(String, String, u32)> =
        crate::command_center::CommandCategory::ORDERED
            .iter()
            .map(|category| {
                (
                    serde_json::to_value(category)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default(),
                    category.label().to_string(),
                    catalog.iter().filter(|e| e.category == *category).count() as u32,
                )
            })
            .collect();
    categories.retain(|(_, _, count)| *count > 0);
    Ok(CommandCatalogMeta {
        total: catalog.len() as u32,
        executable: catalog.iter().filter(|e| e.executable_now()).count() as u32,
        categories,
    })
}

// ---------------------------------------------------------------------------
// 统一输出适配引擎：原始 stdout → StructuredCommandResult
//
// 解析逻辑全部在 `output_adapter` 模块（注册表 + 三层解析器），这里只负责
// 组装上下文。未注册/解析失败自动回落 raw —— 命令绝不会因为"没有专用 UI"
// 而不可用。
// ---------------------------------------------------------------------------

fn structure_output(
    adapter: &str,
    stdout: &str,
    title: &str,
    command_executed: &str,
    duration_ms: u64,
) -> Option<serde_json::Value> {
    let meta = crate::output_adapter::CommandMeta {
        command: command_executed.to_string(),
        exit_code: Some(0),
        duration_ms,
        truncated: false,
    };
    let raw = crate::output_adapter::RawOutput {
        stdout: stdout.to_string(),
        stderr: String::new(),
    };
    let result = crate::output_adapter::adapt(adapter, stdout, title, meta, raw);
    serde_json::to_value(result).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未知适配器 → **raw 回落**（不是错误，也不是 None）。
    ///
    /// 旧行为是返回 `None` 让前端显示原始输出；统一协议后返回
    /// `view = raw` 的结果 —— 用户看到的仍然是原始输出，但元信息与
    /// 原始 stdout 都在同一个对象里，且回落原因可见。
    #[test]
    fn unknown_adapter_falls_back_to_raw() {
        let meta = crate::output_adapter::CommandMeta {
            command: "echo hi".into(),
            exit_code: Some(0),
            duration_ms: 1,
            truncated: false,
        };
        let raw = crate::output_adapter::RawOutput {
            stdout: "anything".into(),
            stderr: String::new(),
        };
        let result =
            crate::output_adapter::adapt("generic-raw-output", "anything", "标题", meta, raw);
        assert_eq!(result.view, crate::output_adapter::ViewType::Raw);
        assert_eq!(result.raw.stdout, "anything", "原始输出必须完整保留");
        assert_eq!(result.meta.command, "echo hi");
    }
}
