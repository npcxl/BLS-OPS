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
    let raw = CommandRawOutput {
        command_executed: capability.command().unwrap_or_default(),
        stdout: stdout.clone(),
        // run_capability 只回 stdout；stderr 已并入错误路径。保留字段以稳定前端契约。
        stderr: String::new(),
        duration_ms: started.elapsed().as_millis() as u64,
    };
    let structured = structure_output(entry.output_adapter, &stdout);

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
// P4.3 输出适配器：原始 stdout → 结构化视图
// ---------------------------------------------------------------------------

/// 未识别的适配器一律返回 `None`（前端显示原始输出，**不会因为没有
/// 专用 UI 而失效**）。空输出也算有效结果（"没有容器/服务"是事实）。
fn structure_output(adapter: &str, stdout: &str) -> Option<serde_json::Value> {
    match adapter {
        "docker-container-table" => Some(serde_json::json!({
            "adapter": adapter,
            "containers": docker::parse_ps(stdout),
        })),
        "systemd-unit-table" => Some(serde_json::json!({
            "adapter": adapter,
            "units": crate::systemd::parse_list_units(stdout),
        })),
        "journal-log-viewer" => Some(serde_json::json!({
            "adapter": adapter,
            "entries": parse_journal_lines(stdout),
        })),
        "nginx-config-tree" => {
            let sites = crate::deployment_collector::parse_nginx_effective(stdout);
            Some(serde_json::json!({
                "adapter": adapter,
                "sites": sites.iter().map(|site| serde_json::json!({
                    "server_name": site.name,
                    "listen_ports": site.listen_ports,
                    "root": site.root,
                    "proxy_targets": site.proxy_targets,
                    "config_file": site.config_file,
                })).collect::<Vec<_>>(),
            }))
        }
        "process-table" => Some(serde_json::json!({
            "adapter": adapter,
            "processes": parse_process_lines(stdout),
        })),
        "disk-usage-table" => Some(serde_json::json!({
            "adapter": adapter,
            "filesystems": parse_df_lines(stdout),
        })),
        "port-listener-table" => Some(serde_json::json!({
            "adapter": adapter,
            "listeners": parse_ss_lines(stdout),
        })),
        _ => None,
    }
}

/// `journalctl -o json`：逐行 JSON，抽 timestamp / unit / level / message。
/// 坏行跳过（半条写入不是日志）。level 是 `PRIORITY` 的数字文本。
fn parse_journal_lines(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter_map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).ok()?;
            let message = value.get("MESSAGE")?.as_str()?.to_string();
            let timestamp = value
                .get("__REALTIME_TIMESTAMP")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let unit = value
                .get("_SYSTEMD_UNIT")
                .and_then(|v| v.as_str())
                .unwrap_or("—")
                .to_string();
            let level = value
                .get("PRIORITY")
                .and_then(|v| v.as_str())
                .unwrap_or("6")
                .to_string();
            Some(serde_json::json!({
                "timestamp": timestamp,
                "unit": unit,
                "level": level,
                "message": message,
            }))
        })
        .collect()
}

/// `ps -eo pid,comm,etimes,pcpu,pmem --no-headers`：5 列，comm 是可执行名
/// 不含空格，因此 `split_whitespace` 安全；残缺行跳过。
fn parse_process_lines(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            Some(serde_json::json!({
                "pid": columns.next()?,
                "comm": columns.next()?,
                "etimes": columns.next()?,
                "pcpu": columns.next()?,
                "pmem": columns.next()?,
            }))
        })
        .collect()
}

/// `df -hP`：首行表头 + 6 列数据（文件系统/容量/已用/可用/使用%/挂载点）。
/// 挂载点可能含空格（极少见）：取前 5 列，剩余整体作为挂载点。
fn parse_df_lines(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter(|line| !line.trim_start().starts_with("Filesystem"))
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            Some(serde_json::json!({
                "filesystem": columns.next()?,
                "size": columns.next()?,
                "used": columns.next()?,
                "avail": columns.next()?,
                "use_percent": columns.next()?,
                "mounted_on": columns.collect::<Vec<_>>().join(" "),
            }))
        })
        .collect()
}

/// `ss -tlnp`：LISTEN 行 → 端口/PID/进程名。
fn parse_ss_lines(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter(|line| line.trim_start().starts_with("LISTEN"))
        .filter_map(|line| {
            let columns: Vec<&str> = line.split_whitespace().collect();
            let local = columns.get(3)?;
            let port = local.rsplit(':').next()?.to_string();
            let pid = line
                .split("pid=")
                .nth(1)
                .map(|rest| {
                    rest.chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>()
                })
                .unwrap_or_default();
            let process = line
                .split("users:((\"")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .unwrap_or("")
                .to_string();
            Some(serde_json::json!({
                "local": local,
                "port": port,
                "pid": pid,
                "process": process,
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// journalctl JSON 行 → 结构化日志（保留 PRIORITY 级别）。
    #[test]
    fn parses_journal_lines_with_levels() {
        let stdout = concat!(
            r#"{"__REALTIME_TIMESTAMP":"1699000000123456","_SYSTEMD_UNIT":"nginx.service","PRIORITY":"6","MESSAGE":"Started Nginx."}"#,
            "\n",
            r#"{"__REALTIME_TIMESTAMP":"1699000001000000","_SYSTEMD_UNIT":"nginx.service","PRIORITY":"3","MESSAGE":"bind() failed"}"#,
            "\n",
            "not-json-line\n",
            r#"{"MESSAGE":"no-timestamp-line"}"#,
            "\n",
        );
        let entries = parse_journal_lines(stdout);
        assert_eq!(entries.len(), 3, "坏行跳过但保留缺字段的行");
        assert_eq!(entries[0]["level"], "6");
        assert_eq!(entries[1]["level"], "3");
        assert_eq!(entries[1]["message"], "bind() failed");
        assert_eq!(entries[2]["unit"], "—");
    }

    /// ps 5 列与 df 6 列（挂载点含空格兜底）。
    #[test]
    fn parses_process_and_disk_tables() {
        let processes = parse_process_lines("1234 nginx 86400 1.2 0.5\n99 bash 10 0.0 0.1\n\n");
        assert_eq!(processes.len(), 2);
        assert_eq!(processes[0]["comm"], "nginx");
        assert_eq!(processes[0]["pid"], "1234");

        let disks = parse_df_lines(
            "Filesystem Size Used Avail Use% Mounted on\n\
             /dev/sda1 50G 20G 30G 40% /\n\
             tmpfs 8G 0 8G 0% /dev/shm\n",
        );
        assert_eq!(disks.len(), 2, "表头跳过");
        assert_eq!(disks[0]["use_percent"], "40%");
        assert_eq!(disks[0]["mounted_on"], "/");

        assert!(parse_process_lines("").is_empty());
    }

    /// ss LISTEN 行 → 端口 + 进程；非 LISTEN 行不收。
    #[test]
    fn parses_ss_listeners() {
        let stdout = concat!(
            "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n",
            "LISTEN 0      128    0.0.0.0:80         0.0.0.0:*          users:((\"nginx\",pid=912,fd=6))\n",
            "ESTAB  0      0      10.0.0.2:22        10.0.0.1:5000\n",
        );
        let listeners = parse_ss_lines(stdout);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0]["port"], "80");
        assert_eq!(listeners[0]["process"], "nginx");
        assert_eq!(listeners[0]["pid"], "912");
    }

    /// 未知适配器回落原始输出（不因无 UI 失效）。
    #[test]
    fn unknown_adapter_returns_none() {
        assert!(structure_output("generic-raw-output", "anything").is_none());
        assert!(structure_output("made-up", "").is_none());
    }
}
