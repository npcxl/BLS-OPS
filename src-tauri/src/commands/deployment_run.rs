//! P5.3 / P5.4 的执行入口。
//!
//! # 边界
//!
//! 这一层只做三件事：**装配**（把数据库里的实体拼成 `RunSetup`）、
//! **落库/审计**、**推事件**。所有判定都在引擎与执行器里 —— 命令层没有
//! "顺手放宽一下"的余地，因为这里根本没有判定逻辑。
//!
//! # 事件
//!
//! 每条**环境**一个事件名（`deployment-run-env-{environment_id}`）：界面上
//! 用户盯着的是"这个环境现在怎么样"，而不是某一次运行的 id。载荷是
//! [`DeploymentRunDetail`]（运行 + 全部节点），前端整体替换状态即可。

use std::sync::Arc;

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, State};

use crate::db::{self, AppDb};
use crate::deployment::exec::guidance::{certificate_plan, CertificatePlan, DnsRecordInstruction};
use crate::deployment::model::*;
use crate::deployment::run::{
    preflight, read_meta, write_meta, DeploymentRunDetail, PreflightInputs, PreflightReport,
    RunExecutor, RunSetup, StartOptions,
};
use crate::deployment::validate as plan_validate;
use crate::state::AppState;

use super::{open_db, record_audit};

/// 运行事件名（按环境）。
pub fn deployment_run_event(environment_id: &str) -> String {
    format!("deployment-run-env-{environment_id}")
}

// -- 装配 --------------------------------------------------------------------

/// 装配一次运行需要的全部输入。
///
/// `version_label` 为空 = 新建运行（由调用方生成）；重试/继续时必须传入
/// **上一次运行用过的标签**，否则会写到一个新的发布目录里，回滚就对不上了。
fn load_setup(
    conn: &Connection,
    plan: &DeploymentPlanGraph,
    version_label: &str,
) -> Result<RunSetup, String> {
    let environment = db::get_environment(&conn, &plan.plan.environment_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "计划所属的环境不存在".to_string())?;
    let application_id = plan.plan.application_id.clone();
    let services = db::list_service_units(&conn, Some(&application_id), Some(&environment.id))
        .map_err(|error| error.to_string())?;
    let artifacts = db::list_artifacts(&conn, Some(&application_id), None)
        .map_err(|error| error.to_string())?;
    let domains = db::list_domain_bindings(&conn, Some(&environment.id))
        .map_err(|error| error.to_string())?;
    let configs = db::list_config_definitions(&conn, Some(&application_id))
        .map_err(|error| error.to_string())?;
    let secret_refs =
        db::list_secret_refs(&conn, Some(&application_id)).map_err(|error| error.to_string())?;
    let policy =
        db::get_security_policy(&conn, &application_id).map_err(|error| error.to_string())?;
    let import_tasks = db::list_import_tasks(&conn, Some(application_id.as_str()), 200)
        .map_err(|error| error.to_string())?;
    let application = db::get_application(&conn, &application_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "计划所属的应用不存在".to_string())?;

    // 服务事实：与 P5.2 方案用的是**同一条**连接键（制品 fingerprint → 导入任务）。
    let facts = crate::deployment::run::facts_from_tasks(
        &services,
        &artifacts,
        &import_tasks,
        Some(environment.deploy_root.as_str()),
    );

    Ok(RunSetup {
        environment_kind: environment.kind,
        deploy_root: environment.deploy_root.clone(),
        version_label: version_label.to_string(),
        image_namespace: slug(&application.name),
        services,
        artifacts,
        domains,
        configs,
        facts,
        secret_refs,
        policy,
    })
}

/// 应用名 → 镜像命名空间 / compose 项目名（只保留安全字符）。
fn slug(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "app".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 新的版本标签：`v<计划版本>.<该计划已运行次数 + 1>`。
///
/// 刻意不用时间戳：同一份计划的第 N 次部署就该叫 `v1.N`，人一眼看得懂，
/// 而且重试时会**沿用同一个标签**（从运行元数据里读回来）。
fn next_version_label(conn: &Connection, plan: &DeploymentPlanGraph) -> String {
    let count = db::list_runs(conn, None, Some(&plan.plan.id), 1000)
        .map(|runs| runs.len())
        .unwrap_or(0);
    // 计划版本号只可能来自数据库里的正整数（校验层要求 >= 1），因此这里
    // 拼出来的一定是安全字符；仍然过一遍校验，失败就退回 `v1`。
    let prefix = format!("v{}", plan.plan.version.max(1));
    if plan_validate::validate_token(&prefix, "版本前缀").is_err() {
        return format!("v1.{}", count + 1);
    }
    format!("{prefix}.{}", count + 1)
}

fn load_plan(conn: &Connection, plan_id: &str) -> Result<DeploymentPlanGraph, String> {
    db::get_plan_graph(conn, plan_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "计划不存在".to_string())
}

/// 推事件的闭包。
fn emitter(app: AppHandle, environment_id: &str) -> Arc<dyn Fn(DeploymentRunDetail) + Send + Sync> {
    let event = deployment_run_event(environment_id);
    Arc::new(move |detail: DeploymentRunDetail| {
        let _ = app.emit(&event, detail);
    })
}

// -- 预检 --------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PreflightOutcome {
    pub report: PreflightReport,
    pub environment_id: String,
    pub environment_kind: EnvironmentKind,
    pub version_label: String,
    /// 需要单独确认的节点（UI 可以先摆出来）。
    pub approval_nodes: Vec<String>,
}

#[tauri::command]
pub async fn deployment_run_preflight(
    state: State<'_, AppState>,
    plan_id: String,
    session_id: Option<String>,
) -> Result<PreflightOutcome, String> {
    let (plan, setup, compiled, connected, locked) = {
        let conn = open_db(&state)?;
        let plan = load_plan(&conn, &plan_id)?;
        let version = next_version_label(&conn, &plan);
        let setup = load_setup(&conn, &plan, &version)?;
        let compiled = setup.compile(&plan)?;
        let connected = match session_id.as_deref().filter(|id| !id.trim().is_empty()) {
            Some(session_id) => state.ssh.is_connected(session_id).await,
            None => false,
        };
        let locked = state.env_locks.holder(&plan.plan.environment_id);
        (plan, setup, compiled, connected, locked)
    };

    let report = preflight(&PreflightInputs {
        plan: &plan,
        services: &setup.services,
        artifacts: &setup.artifacts,
        domains: &setup.domains,
        configs: &setup.configs,
        secret_refs: &setup.secret_refs,
        policy: &setup.policy,
        environment_kind: setup.environment_kind,
        session_connected: connected,
        locked_by: locked,
        rollback_steps: compiled.rollback_steps.len(),
    });
    Ok(PreflightOutcome {
        report,
        environment_id: plan.plan.environment_id.clone(),
        environment_kind: setup.environment_kind,
        version_label: setup.version_label.clone(),
        approval_nodes: compiled
            .steps
            .iter()
            .filter(|step| step.approval_required)
            .map(|step| step.node_key.clone())
            .collect(),
    })
}

// -- 开始运行 ----------------------------------------------------------------

#[tauri::command]
pub async fn deployment_run_start(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: String,
    session_id: String,
    // 是否预先批准本次运行里所有需要确认的节点（"这个计划我已经审过"）。
    approve_high_risk: bool,
) -> Result<DeploymentRunDetail, String> {
    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".to_string());
    }
    let (plan, setup, server_id, environment_id) = {
        let conn = open_db(&state)?;
        let plan = load_plan(&conn, &plan_id)?;
        let version = next_version_label(&conn, &plan);
        let setup = load_setup(&conn, &plan, &version)?;
        let environment = db::get_environment(&conn, &plan.plan.environment_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "计划所属的环境不存在".to_string())?;
        (
            plan,
            setup,
            environment.server_id.clone(),
            environment.id.clone(),
        )
    };

    let mut executor = RunExecutor::with_keyring(
        state.db.clone(),
        state.ssh.clone(),
        state.runs.clone(),
        state.env_locks.clone(),
        setup,
        plan,
        emitter(app.clone(), &environment_id),
    )
    .with_session(&session_id);

    // 预先批准的节点写进运行元数据（可审计：批准是显式记录下来的）。
    let approvals = if approve_high_risk {
        let compiled = executor.setup.compile(&executor.plan)?;
        compiled
            .steps
            .iter()
            .filter(|step| step.approval_required)
            .map(|step| step.node_key.clone())
            .collect()
    } else {
        Vec::new()
    };
    let options = StartOptions {
        session_id: session_id.clone(),
        trigger: RunTrigger::Manual,
        approved_nodes: approvals,
        skip_preflight: false,
    };

    let run = executor.prepare(&options)?;
    record_audit(
        &state,
        "deployment_run_start",
        Some(&server_id),
        None,
        &format!(
            "{{\"plan\":\"{plan_id}\",\"run\":\"{}\",\"version\":\"{}\"}}",
            run.id, executor.setup.version_label
        ),
    );

    let nodes = {
        let conn = open_db(&state)?;
        db::list_run_nodes(&conn, &run.id).map_err(|error| error.to_string())?
    };
    let detail = DeploymentRunDetail {
        run: run.clone(),
        nodes,
    };
    let running = run.clone();
    tauri::async_runtime::spawn(async move {
        let _ = executor.execute(running, None).await;
    });
    Ok(detail)
}

// -- 审批 / 重试 / 继续 / 取消 / 回滚 ----------------------------------------

#[tauri::command]
pub async fn deployment_run_approve_node(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    node_key: String,
    session_id: Option<String>,
) -> Result<DeploymentRunDetail, String> {
    state.runs.approve(&run_id, &node_key);
    let (run, server_id) = {
        let conn = open_db(&state)?;
        let run = db::get_run(&conn, &run_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "运行不存在".to_string())?;
        // 批准要**落库**：重启之后这次批准仍然有效，且可审计。
        let mut updated = run.clone();
        let mut meta = read_meta(&updated);
        if !meta.approved_nodes.iter().any(|key| key == &node_key) {
            meta.approved_nodes.push(node_key.clone());
        }
        write_meta(&mut updated, &meta);
        db::upsert_run(&conn, &updated).map_err(|error| error.to_string())?;
        let server_id = run.server_id.clone();
        (updated, server_id)
    };
    record_audit(
        &state,
        "deployment_run_approve_node",
        Some(&server_id),
        None,
        &format!("{{\"run\":\"{run_id}\",\"node\":\"{node_key}\"}}"),
    );

    // 暂停中的运行：批准之后立刻从**这个节点**接着跑。
    if run.status == RunStatus::Paused {
        let session_id = session_id
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "继续执行需要已连接的 SSH 会话".to_string())?;
        return resume_inner(app, &state, &run, &session_id, Some(node_key)).await;
    }
    let nodes = {
        let conn = open_db(&state)?;
        db::list_run_nodes(&conn, &run_id).map_err(|error| error.to_string())?
    };
    Ok(DeploymentRunDetail { run, nodes })
}

/// 重试一个失败节点 / 从一个节点继续（同一个实现）。
#[tauri::command]
pub async fn deployment_run_resume(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    session_id: String,
    from_node_key: Option<String>,
) -> Result<DeploymentRunDetail, String> {
    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".to_string());
    }
    let run = {
        let conn = open_db(&state)?;
        db::get_run(&conn, &run_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "运行不存在".to_string())?
    };
    let node_key = match from_node_key {
        Some(key) if !key.trim().is_empty() => Some(key),
        _ => {
            // 没指定就"从第一个未完成的节点继续"。
            let nodes = {
                let conn = open_db(&state)?;
                db::list_run_nodes(&conn, &run_id).map_err(|error| error.to_string())?
            };
            nodes
                .iter()
                .find(|node| {
                    !matches!(
                        node.status,
                        RunNodeStatus::Succeeded | RunNodeStatus::Skipped
                    )
                })
                .map(|node| node.node_key.clone())
        }
    };
    resume_inner(app, &state, &run, &session_id, node_key).await
}

async fn resume_inner(
    app: AppHandle,
    state: &State<'_, AppState>,
    run: &DeploymentRun,
    session_id: &str,
    from_node_key: Option<String>,
) -> Result<DeploymentRunDetail, String> {
    let (plan, setup) = {
        let conn = open_db(&state)?;
        let plan = load_plan(&conn, &run.plan_id)?;
        // **沿用原运行的版本标签**：换一个就等于部署到另一个目录，回滚会失效。
        let version = {
            let meta = read_meta(run);
            if meta.version_label.is_empty() {
                next_version_label(&conn, &plan)
            } else {
                meta.version_label.clone()
            }
        };
        let setup = load_setup(&conn, &plan, &version)?;
        (plan, setup)
    };

    let mut resumed = run.clone();
    resumed.status = RunStatus::Running;
    resumed.error_message = None;
    if resumed.started_at.is_none() {
        resumed.started_at = Some(AppDb::now());
    }
    resumed.finished_at = None;

    let environment_id = run.environment_id.clone();
    // 重新占锁（暂停时锁没放，但进程重启过就得重新拿）。
    state.env_locks.acquire(&environment_id, &run.id)?;
    let executor = RunExecutor::with_keyring(
        state.db.clone(),
        state.ssh.clone(),
        state.runs.clone(),
        state.env_locks.clone(),
        setup,
        plan,
        emitter(app, &environment_id),
    )
    .with_session(session_id);
    executor.save_run(&resumed);

    let nodes = {
        let conn = open_db(state)?;
        db::list_run_nodes(&conn, &run.id).map_err(|error| error.to_string())?
    };
    let detail = DeploymentRunDetail {
        run: resumed.clone(),
        nodes,
    };
    let running = resumed.clone();
    tauri::async_runtime::spawn(async move {
        let _ = executor.execute(running, from_node_key).await;
    });
    Ok(detail)
}

#[tauri::command]
pub async fn deployment_run_cancel(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<bool, String> {
    let cancelled = state.runs.cancel(&run_id);
    if cancelled {
        // 取消是协作式的：正在跑的动作跑完当前这一步才停，因此这里只记状态过渡。
        let mut run = {
            let conn = open_db(&state)?;
            db::get_run(&conn, &run_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "运行不存在".to_string())?
        };
        let environment_id = run.environment_id.clone();
        let now = AppDb::now();
        run.status = RunStatus::Cancelled;
        run.finished_at = Some(now);
        {
            let conn = open_db(&state)?;
            db::upsert_run(&conn, &run).map_err(|error| error.to_string())?;
        }
        state.env_locks.release(&environment_id, &run_id);
        state.runs.forget(&run_id);
        record_audit(
            &state,
            "deployment_run_cancel",
            Some(&run.server_id),
            None,
            &format!("{{\"run\":\"{run_id}\"}}"),
        );
    }
    Ok(cancelled)
}

#[tauri::command]
pub async fn deployment_run_rollback(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    session_id: String,
) -> Result<DeploymentRunDetail, String> {
    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".to_string());
    }
    let run = {
        let conn = open_db(&state)?;
        db::get_run(&conn, &run_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "运行不存在".to_string())?
    };
    let (plan, setup) = {
        let conn = open_db(&state)?;
        let plan = load_plan(&conn, &run.plan_id)?;
        let version = read_meta(&run).version_label;
        let version = if version.is_empty() {
            next_version_label(&conn, &plan)
        } else {
            version
        };
        let setup = load_setup(&conn, &plan, &version)?;
        (plan, setup)
    };
    let environment_id = run.environment_id.clone();
    let executor = RunExecutor::with_keyring(
        state.db.clone(),
        state.ssh.clone(),
        state.runs.clone(),
        state.env_locks.clone(),
        setup,
        plan,
        emitter(app, &environment_id),
    )
    .with_session(&session_id);
    record_audit(
        &state,
        "deployment_run_rollback",
        Some(&run.server_id),
        None,
        &format!("{{\"run\":\"{run_id}\"}}"),
    );
    let finished = executor.rollback(run, &session_id).await?;
    let nodes = {
        let conn = open_db(&state)?;
        db::list_run_nodes(&conn, &run_id).map_err(|error| error.to_string())?
    };
    Ok(DeploymentRunDetail {
        run: finished,
        nodes,
    })
}

// -- DNS / SSL 指导 ----------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DnsGuidance {
    pub domain: String,
    pub dns_status: DnsStatus,
    pub provider_id: String,
    pub provider_name: String,
    /// V1 恒为 `false`：没有服务商自动写入路径。
    pub automation_supported: bool,
    pub instructions: Vec<DnsRecordInstruction>,
    pub registered_providers: Vec<RegisteredProvider>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RegisteredProvider {
    pub id: String,
    pub name: String,
    pub automation_supported: bool,
}

/// 域名的手动配置指引（V1：只有指引与验证，不调用任何服务商 API）。
#[tauri::command]
pub async fn deployment_dns_guidance(
    state: State<'_, AppState>,
    binding_id: String,
) -> Result<DnsGuidance, String> {
    let binding = {
        let conn = open_db(&state)?;
        load_binding(&conn, &binding_id)?
    };
    let provider_id = binding
        .dns_credential_ref
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "manual".to_string());
    let adapter = crate::deployment::exec::guidance::provider(&provider_id)
        .ok_or_else(|| format!("没有这个 DNS 服务商适配器：{provider_id}"))?;
    Ok(DnsGuidance {
        domain: binding.domain.clone(),
        dns_status: binding.dns_status,
        provider_id: adapter.id().to_string(),
        provider_name: adapter.name().to_string(),
        automation_supported: adapter.supports_automation(),
        instructions: adapter.instructions(&binding),
        registered_providers: crate::deployment::exec::guidance::registered_providers()
            .into_iter()
            .map(|(id, name, automation)| RegisteredProvider {
                id: id.to_string(),
                name: name.to_string(),
                automation_supported: automation,
            })
            .collect(),
    })
}

/// 证书签发计划（挑战方式、前置条件、为什么现在不能签）。
#[tauri::command]
pub async fn deployment_ssl_plan(
    state: State<'_, AppState>,
    binding_id: String,
    session_id: Option<String>,
) -> Result<CertificatePlan, String> {
    let binding = {
        let conn = open_db(&state)?;
        load_binding(&conn, &binding_id)?
    };
    let environment_kind = {
        let conn = open_db(&state)?;
        db::get_environment(&conn, &binding.environment_id)
            .map_err(|error| error.to_string())?
            .map(|environment| environment.kind)
            .unwrap_or(EnvironmentKind::Development)
    };
    // certbot 是否存在：有会话就问一句，没有就如实标"未知"。
    let certbot = match session_id.as_deref().filter(|id| !id.trim().is_empty()) {
        Some(session_id) => {
            if !state.ssh.is_connected(session_id).await {
                None
            } else {
                Some(
                    crate::remote::has_tool(
                        &state.ssh,
                        session_id,
                        crate::safe::ProbeTool::Certbot,
                    )
                    .await,
                )
            }
        }
        None => None,
    };
    Ok(certificate_plan(&binding, environment_kind, certbot))
}

fn load_binding(conn: &Connection, binding_id: &str) -> Result<DomainBinding, String> {
    db::list_domain_bindings(conn, None)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|binding| binding.id == binding_id)
        .ok_or_else(|| "域名绑定不存在".to_string())
}
