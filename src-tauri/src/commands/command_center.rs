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
use crate::command_center::{
    build_exec, builtin_catalog, search, CommandKnowledge, CommandParams, CommandSearchHit,
};
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
        Some(entry.output_adapter),
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

/// 命令文本 → 知识库条目（终端手动输入命令的识别入口）。
///
/// 两级匹配：
///
/// 1. **精确**：规范化（压空白、小写）后与条目 syntax / display 完全相等；
///    含 `<占位符>` 的条目跳过（要填真值，不能拿展示语法硬套）。
/// 2. **同命令家族**：精确失败后，可执行名相同、用户第二段是标志
///    （`-h`/`--xxx`）或与条目子命令首段一致 → 视为同家族
///    （`df -h`/`df -Th`/`sudo df -h` 都命中 `df.h` —— 它们输出列结构一致）。
///    绝不跨子命令匹配（`systemctl status` 不会错配成 `list-units`）。
///
/// # 为什么不再有"面板价值门槛"
///
/// 以前只给"有专用适配器"的命令弹结果面板，其余（知识库里占绝大多数）
/// 一律 `generic-raw-output` 不弹 —— 结果就是绝大多数命令白白放弃结构化。
/// 现在默认适配器是 `auto`（按输出形态自动识别），**任何非交互式命令都值得
/// 尝试**，所以门槛取消。
///
/// 返回完整命中（含真实 risk / mutability / can_execute —— 终端结果抽屉
/// 据此做风险门控，禁止伪装成只读）。`None` = 未识别（仍然走 auto，只是
/// 没有知识库的风险信息）。
#[tauri::command]
pub async fn command_match_text(text: String) -> Result<Option<CommandSearchHit>, String> {
    Ok(match_knowledge(&text).map(search::hit_for))
}

/// 规范化的命令文本 → 命中的知识条目。
fn match_knowledge(text: &str) -> Option<&'static CommandKnowledge> {
    let normalized = normalize_command(text);
    if normalized.is_empty() {
        return None;
    }
    let catalog = builtin_catalog();

    // 第一级：精确相等（含 `<占位符>` 的展示语法跳过 —— 用户不会输尖括号）。
    if let Some(entry) = catalog.iter().find(|entry| {
        let syntax = normalize_command(entry.syntax);
        let display = normalize_command(&entry.display_command());
        !syntax.contains('<') && (syntax == normalized || display == normalized)
    }) {
        return Some(entry);
    }
    // 第二级：同命令家族（可执行名一致）：
    // - `df -h` / `df -Th` / `sudo df -h`：第二段是**标志** → 同家族；
    // - `systemctl restart X`：第二段与条目子命令**首段**一致（restart ==
    //   restart）→ 语义相同，语法里的 `<unit>` 占位符不影响输出结构；
    // - 裸可执行名（`df` / `free` / `uptime`）→ 该命令第一个条目。
    let mut parts = normalized.split(' ');
    let exe = parts.next()?;
    let second = parts.next();
    catalog.iter().find(|entry| {
        entry.executable.eq_ignore_ascii_case(exe)
            && match second {
                None => true,
                Some(token) if token.starts_with('-') => entry
                    .subcommand
                    .split(' ')
                    .next()
                    .is_some_and(|head| head.starts_with('-')),
                Some(token) => entry.subcommand.split(' ').next() == Some(token),
            }
    })
}

fn normalize_command(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_lowercase()
}

/// **只解析已经产生的输出，绝不再次执行命令。**
///
/// 终端里的命令已经跑完了，这里把它的 stdout/stderr/退出码/耗时交给统一
/// 输出适配引擎，得到 `StructuredCommandResult`。重复执行会让 `docker ps`
/// 跑两次，修改型命令更是危险 —— 所以这个命令是纯函数，无任何 I/O。
///
/// `normalized` 是前端清洗后的解析输入（去 ANSI / 回显 / 提示符）；
/// `raw.stdout` 永远保留**真实终端输出** —— 两份数据严格分开。
///
/// # 两个输入都是可选的（可以都为空）
///
/// - `knowledge_id`：命中知识库时用它的 `output_adapter` 作为 **hint**；
/// - `adapter_hint`：直接指定 hint（命令中心 / 测试用）；
/// - 两者都没有 → 纯自动识别（绝大多数终端命令走这条路）。
#[tauri::command]
pub async fn command_adapt_output(
    command: String,
    duration_ms: u64,
    stdout: Option<String>,
    stderr: Option<String>,
    exit_code: Option<i32>,
    truncated: Option<bool>,
    normalized: Option<String>,
    knowledge_id: Option<String>,
    adapter_hint: Option<String>,
) -> Result<crate::output_adapter::StructuredCommandResult, String> {
    let stdout = stdout.unwrap_or_default();
    let stderr = stderr.unwrap_or_default();
    let (hint, title) = match knowledge_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => match builtin_catalog().iter().find(|entry| entry.id == id) {
            Some(entry) => (Some(entry.output_adapter), entry.title.to_string()),
            // 知识库里没有 → **不是错误**，退化为纯自动识别（终端里手敲的
            // 命令本就不一定在知识库里）。
            None => (adapter_hint.as_deref(), command.clone()),
        },
        None => (adapter_hint.as_deref(), command.clone()),
    };
    let meta = crate::output_adapter::CommandMeta {
        command: command.clone(),
        exit_code,
        duration_ms,
        truncated: truncated.unwrap_or(false),
    };
    let parse_input = normalized.unwrap_or_else(|| stdout.clone());
    let raw = crate::output_adapter::RawOutput {
        stdout: stdout.clone(),
        stderr,
    };
    let ctx = crate::output_adapter::AdapterContext { title, meta, raw };
    // 专用适配器只作 hint：失败后继续自动识别，绝不直接 raw。
    Ok(crate::output_adapter::adapt_auto(hint, &parse_input, &ctx))
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
    adapter_hint: Option<&str>,
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
    let ctx = crate::output_adapter::AdapterContext {
        title: title.to_string(),
        meta,
        raw,
    };
    // 专用适配器只是 hint：认不出来继续走统一自动识别，绝不直接 raw。
    let result = crate::output_adapter::adapt_auto(adapter_hint, stdout, &ctx);
    serde_json::to_value(result).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 命令文本 → 知识库条目：**确定性匹配**，认不出返回 None。
    ///
    /// 终端里输错一个字符就该走原始终端，而不是弹出不相干的结构化面板。
    #[test]
    fn matches_command_text_deterministically() {
        assert_eq!(
            match_knowledge("docker ps -a").map(|e| e.id),
            Some("docker.ps.all")
        );
        assert_eq!(match_knowledge("free -m").map(|e| e.id), Some("free.m"));
        assert_eq!(match_knowledge("uptime").map(|e| e.id), Some("uptime"));
        assert_eq!(match_knowledge("df -hP").map(|e| e.id), Some("df.h"));
        // 大小写与多余空格不敏感。
        assert_eq!(
            match_knowledge("  Docker   PS  -A ").map(|e| e.id),
            Some("docker.ps.all")
        );
        // 未收录 / 拼错 → None（走原始终端）。
        assert!(match_knowledge("echo hello").is_none());
        assert!(match_knowledge("docker pss").is_none());
        assert!(match_knowledge("").is_none());
        // 字面尖括号输入（现实中不会发生）走家族匹配到 json-viewer ——
        // 无害：inspect 的输出本来就是 JSON。
        assert_eq!(
            match_knowledge("docker inspect <容器>").map(|e| e.id),
            Some("docker.inspect")
        );
    }

    /// 同命令家族：`df -h` / `df -Th` / `df --output` 都命中 `df.h` ——
    /// 它们输出列结构一致。绝不跨子命令（`systemctl status` 命中
    /// `systemctl.status`，不会错配成 `list-units`）。
    ///
    /// 知识库里**没有专用适配器**的条目（现在默认 `auto`）同样参与匹配 ——
    /// 自动识别让每条命令都值得一个结果面板。
    #[test]
    fn flag_variants_match_the_same_family() {
        for text in ["df -h", "df -Th", "df --output=source,size", "df"] {
            let entry = match_knowledge(text).expect(text);
            assert_eq!(entry.id, "df.h", "text={text}");
        }
        // 跨子命令绝不匹配：`status` 命中 status 条目，不是 list-units。
        assert_eq!(
            match_knowledge("systemctl status nginx.service").map(|e| e.id),
            Some("systemctl.status")
        );
        // 没有专用适配器的命令也匹配（走 auto，不再被门槛挡掉）。
        assert_eq!(
            match_knowledge("du -sh /var").map(|e| e.id),
            Some("base.du")
        );
    }

    /// 匹配返回**完整命中**（真实 risk / mutability / can_execute）——
    /// 终端结果抽屉据此做风险门控，禁止伪装成只读。
    #[test]
    fn match_returns_real_risk_info() {
        // restart 语法含占位符 → 精确不命中；家族第二段 "restart" 与
        // systemctl.restart 子命令首段一致 → 命中。
        let restart =
            match_knowledge("systemctl restart nginx.service").expect("restart 应通过家族匹配命中");
        assert_eq!(restart.id, "systemctl.restart");
        assert_eq!(restart.risk, crate::command_center::RiskLevel::Medium);
        assert_eq!(
            restart.mutability,
            crate::command_center::Mutability::Change
        );
        assert!(restart.executable_now());

        let ps = match_knowledge("docker ps -a").expect("docker.ps.all");
        assert_eq!(ps.risk, crate::command_center::RiskLevel::ReadOnly);
        assert_eq!(ps.mutability, crate::command_center::Mutability::Read);
    }

    /// `command_adapt_output` 是**纯解析**：同样的输出永远得到同样的结果，
    /// 且不执行任何命令（这里没有任何 I/O 依赖，重复调用结果一致）。
    #[test]
    fn adapt_output_is_pure_parsing() {
        let stdout = "LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:((\"nginx\",pid=912,fd=6))\n";
        let first = adapt_output_for_test(Some("port-listener-table"), stdout);
        let second = adapt_output_for_test(Some("port-listener-table"), stdout);
        assert_eq!(first.view, crate::output_adapter::ViewType::Table);
        assert_eq!(first.rows.len(), 1);
        assert_eq!(first.rows[0]["port"], "80");
        // 纯函数：两次调用完全一致（没有隐式状态或重复执行）。
        assert_eq!(
            serde_json::to_value(&first).ok(),
            serde_json::to_value(&second).ok()
        );
    }

    /// 测试辅助：直接调用适配逻辑（与 `command_adapt_output` 命令体一致）。
    fn adapt_output_for_test(
        adapter_hint: Option<&str>,
        stdout: &str,
    ) -> crate::output_adapter::StructuredCommandResult {
        let meta = crate::output_adapter::CommandMeta {
            command: "test".into(),
            exit_code: Some(0),
            duration_ms: 1,
            truncated: false,
        };
        let raw = crate::output_adapter::RawOutput {
            stdout: stdout.to_string(),
            stderr: String::new(),
        };
        let ctx = crate::output_adapter::AdapterContext {
            title: "测试".into(),
            meta,
            raw,
        };
        crate::output_adapter::adapt_auto(adapter_hint, stdout, &ctx)
    }

    /// 未知 / 未命中的适配器 → **继续自动识别**，实在认不出才 raw 回落。
    ///
    /// 关键变化：以前"没有专用适配器"就等于 raw；现在专用适配器只是 hint，
    /// 失败后走 `adapt_auto`，输出仍然有结构化机会。
    #[test]
    fn unknown_adapter_falls_back_to_auto_then_raw() {
        // 一条**没有专用适配器**的标准列式表格。
        let table = concat!(
            "PID   COMMAND      CPU   MEM\n",
            "1     /sbin/init   0.0   0.1\n",
            "912   nginx        1.2   3.4\n",
            "1204  node         12.5  8.0\n",
        );
        let result = adapt_output_for_test(Some("made-up-adapter"), table);
        assert_eq!(
            result.view,
            crate::output_adapter::ViewType::Table,
            "专用适配器没认出来 → 自动识别接管，绝不直接 raw"
        );
        assert_eq!(result.rows.len(), 3);
        assert_eq!(result.rows[1]["command"], "nginx");
        assert_eq!(result.raw.stdout, table, "原始输出必须完整保留");

        // 真的认不出（一段散文 + 无 hint）→ raw，且原始输出完整。
        let prose = "正在处理，请稍候……\n这既不是表格也不是键值。\n";
        let result = adapt_output_for_test(None, prose);
        assert!(matches!(
            result.view,
            crate::output_adapter::ViewType::Raw | crate::output_adapter::ViewType::Text
        ));
        assert_eq!(result.raw.stdout, prose);
    }

    /// 管道命令**不得**套用主命令的专用适配器 —— 输出结构已被管道改变。
    #[test]
    fn pipeline_disables_specialized_hint() {
        // `ss -tulnp` 的专用表格列是 local/port/pid/process；
        // `| grep` 之后只剩一列，套用专用适配器会解析出空/错表。
        let stdout = "tcp LISTEN 0 128 0.0.0.0:80 users:((\"nginx\",pid=912,fd=6))\n";
        let meta = crate::output_adapter::CommandMeta {
            command: "ss -tulnp | grep 80".into(),
            exit_code: Some(0),
            duration_ms: 1,
            truncated: false,
        };
        let raw = crate::output_adapter::RawOutput {
            stdout: stdout.to_string(),
            stderr: String::new(),
        };
        let ctx = crate::output_adapter::AdapterContext {
            title: "监听端口".into(),
            meta,
            raw,
        };
        let result = crate::output_adapter::adapt_auto(Some("port-listener-table"), stdout, &ctx);
        assert_ne!(
            result
                .columns
                .iter()
                .map(|c| c.key.clone())
                .collect::<Vec<_>>(),
            vec![
                "local".to_string(),
                "port".to_string(),
                "pid".to_string(),
                "process".to_string()
            ],
            "管道命令不能套用 ss 的专用列定义"
        );
        assert!(
            result.warnings.iter().any(|w| w.contains("管道")),
            "跳过专用适配器的原因必须对可见：{:?}",
            result.warnings
        );
    }
}
