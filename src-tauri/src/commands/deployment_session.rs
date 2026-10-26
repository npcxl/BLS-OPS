//! P5.6 统一部署会话 IPC。
//!
//! # 边界
//!
//! * **用户确认前不改服务器**：`confirm_and_start` 之前不存在任何写服务器的调用；
//! * 预检与启动都复用 `deployment_run` 的同一份实现（不另造第二条安全路径）；
//! * 幂等键防双击；预检阻塞退回 `needs_input` 且**不启动**；
//! * 高风险 / 生产节点仍需用户显式审批 —— AI 不能代替。

use tauri::{AppHandle, Emitter, State};

use crate::db::{self, AppDb};
use crate::deployment::session::confirm::{gate, ConfirmGate, ConfirmGateInput};
use crate::deployment::session::model::{
    DeploymentSession, DeploymentSessionEvent, SessionEventKind, SessionQuestion, SessionStatus,
};
use crate::state::AppState;

use super::deployment_run;
use super::{open_db, record_audit};

/// 会话事件名（前端订阅）。
pub fn session_event(session_id: &str) -> String {
    format!("deployment-session-{session_id}")
}

fn record(
    conn: &rusqlite::Connection,
    session_id: &str,
    kind: SessionEventKind,
    detail: &str,
    now: i64,
) -> Result<(), String> {
    // 事件 detail 只允许脱敏摘要。
    if crate::deployment::session::model::looks_like_secret(detail) {
        return Err("事件内容疑似包含密钥，已拒绝写入".to_string());
    }
    db::deployment_session::append_event(
        conn,
        &DeploymentSessionEvent::new(
            format!("{}:{}", session_id, now),
            session_id,
            kind,
            detail,
            now,
        ),
    )
    .map_err(|error| error.to_string())
}

/// 新建一个部署会话（**什么都不部署**，只是记录意图与目标）。
#[tauri::command]
pub async fn deployment_session_create(
    state: State<'_, AppState>,
    application_id: Option<String>,
    environment_id: Option<String>,
    server_id: Option<String>,
    user_description: String,
) -> Result<DeploymentSession, String> {
    let now = AppDb::now();
    let mut session = DeploymentSession::new(uuid::Uuid::new_v4().to_string(), now);
    session.application_id = application_id.filter(|value| !value.trim().is_empty());
    session.environment_id = environment_id.filter(|value| !value.trim().is_empty());
    session.server_id = server_id.filter(|value| !value.trim().is_empty());
    session.user_description = user_description;

    let conn = open_db(&state)?;
    db::deployment_session::upsert_session(&conn, &session).map_err(|error| error.to_string())?;
    record(
        &conn,
        &session.id,
        SessionEventKind::Created,
        "会话已创建",
        now,
    )?;
    record_audit(
        &state,
        "deployment_session_create",
        session.server_id.as_deref(),
        None,
        &format!("{{\"session\":\"{}\"}}", session.id),
    );
    Ok(session)
}

#[tauri::command]
pub async fn deployment_session_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DeploymentSession>, String> {
    let conn = open_db(&state)?;
    db::deployment_session::get_session(&conn, &id).map_err(|error| error.to_string())
}

/// 会话列表（最近优先）。
#[tauri::command]
pub async fn deployment_session_list(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<DeploymentSession>, String> {
    let conn = open_db(&state)?;
    db::deployment_session::list_sessions(&conn, limit.unwrap_or(20).min(100))
        .map_err(|error| error.to_string())
}

/// 会话事件（审计轨迹）。
#[tauri::command]
pub async fn deployment_session_events(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<DeploymentSessionEvent>, String> {
    let conn = open_db(&state)?;
    db::deployment_session::list_events(&conn, &id).map_err(|error| error.to_string())
}

/// 迁移会话状态（**只走状态机**；非法迁移直接报错）。
fn transition(
    conn: &rusqlite::Connection,
    session: &mut DeploymentSession,
    next: SessionStatus,
    now: i64,
    detail: &str,
) -> Result<(), String> {
    if crate::deployment::session::model::looks_like_secret(detail) {
        return Err("事件内容疑似包含密钥，已拒绝写入".to_string());
    }
    if !session.status.can_transition_to(next) {
        return Err(format!(
            "会话状态不能从「{}」变成「{}」",
            session.status.label(),
            next.label()
        ));
    }
    let from = session.status;
    session.status = next;
    session.updated_at = now;
    db::deployment_session::upsert_session(conn, session).map_err(|error| error.to_string())?;
    let event = DeploymentSessionEvent::new(
        format!("{}:{}:st", session.id, now),
        &session.id,
        SessionEventKind::StatusChanged,
        detail,
        now,
    )
    .with_status(from, next);
    db::deployment_session::append_event(conn, &event).map_err(|error| error.to_string())
}

/// 记录一条问题（进入 `needs_input`）。
#[tauri::command]
pub async fn deployment_session_ask(
    state: State<'_, AppState>,
    id: String,
    question: SessionQuestion,
) -> Result<DeploymentSession, String> {
    let now = AppDb::now();
    let conn = open_db(&state)?;
    let mut session = db::deployment_session::get_session(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "部署会话不存在".to_string())?;
    session.current_question = Some(question.clone());
    session.updated_at = now;
    db::deployment_session::upsert_session(&conn, &session).map_err(|error| error.to_string())?;
    record(
        &conn,
        &session.id,
        SessionEventKind::QuestionAsked,
        &format!("{}: {}", question.kind.as_str(), question.question),
        now,
    )?;
    Ok(session)
}

/// 记录用户对阻塞问题的回答（回答后回到分析）。
#[tauri::command]
pub async fn deployment_session_answer(
    state: State<'_, AppState>,
    id: String,
    question_id: String,
    answer: String,
) -> Result<DeploymentSession, String> {
    let now = AppDb::now();
    let conn = open_db(&state)?;
    let mut session = db::deployment_session::get_session(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "部署会话不存在".to_string())?;
    record(
        &conn,
        &session.id,
        SessionEventKind::AnswerRecorded,
        &format!(
            "{question_id} 已回答（长度 {}）",
            answer.trim().chars().count()
        ),
        now,
    )?;
    session.current_question = None;
    transition(
        &conn,
        &mut session,
        SessionStatus::Analyzing,
        now,
        "收到回答，重新分析",
    )?;
    Ok(session)
}

/// 确认结果（前端据此提示"下一步做什么"）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ConfirmOutcome {
    /// `started` / `replayed` / `needs_input` / `needs_approval`
    pub status: String,
    pub run_id: Option<String>,
    pub blocked_checks: Vec<String>,
    pub approval_nodes: Vec<String>,
    pub message: String,
    pub session: DeploymentSession,
}

/// **确认并开始部署** —— 唯一允许启动 RunExecutor 的会话入口。
///
/// 原子语义：幂等 → 状态 → 指纹 → 计划 → 预检 → 审批，任一不满足都**不启动**。
#[tauri::command]
pub async fn deployment_session_confirm_and_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    plan_id: String,
    current_fingerprint: String,
    session_id: String,
    idempotency_key: String,
    approve_high_risk: bool,
) -> Result<ConfirmOutcome, String> {
    let now = AppDb::now();
    let conn = open_db(&state)?;
    let mut session = db::deployment_session::get_session(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "部署会话不存在".to_string())?;

    // ---- 1) 幂等：同一个键确认过就直接回放，绝不产生第二次部署 ----
    if let Some(previous) =
        db::deployment_session::find_session_by_confirm_key(&conn, &idempotency_key)
            .map_err(|error| error.to_string())?
    {
        if let Some(result) = db::deployment_session::get_confirm_result(&conn, &previous.id)
            .map_err(|e| e.to_string())?
        {
            if !result.trim().is_empty() {
                let mut replayed: ConfirmOutcome =
                    serde_json::from_str(&result).map_err(|error| error.to_string())?;
                replayed.status = "replayed".to_string();
                return Ok(replayed);
            }
        }
    }

    // ---- 2) 状态与指纹（先挡住，避免无谓预检）----
    if session.status != SessionStatus::DraftReady {
        return Err(format!(
            "当前状态「{}」不能确认部署（需要：草案就绪）",
            session.status.label()
        ));
    }
    if session.input_fingerprint.trim().is_empty()
        || session.input_fingerprint != current_fingerprint
    {
        return Err("项目、服务器或需求已经变化，旧草案作废：请重新分析后再确认".to_string());
    }
    session.plan_id = Some(plan_id.clone());

    // ---- 3) 预检（与手动预检同一份实现）----
    let preflight = deployment_run::preflight_plan(&state, &plan_id, Some(&session_id)).await?;
    let blocked: Vec<String> = preflight
        .report
        .blocked_checks()
        .iter()
        .map(|check| format!("{}：{}", check.id, check.label))
        .collect();
    let approvals = preflight.approval_nodes.clone();

    let decision = gate(ConfirmGateInput {
        session: &session,
        current_fingerprint: &current_fingerprint,
        previous_result: None,
        can_run: preflight.report.can_run,
        blocked_checks: &blocked,
        approval_nodes: &approvals,
        approve_high_risk,
    });

    let outcome = match decision {
        ConfirmGate::Replay { .. } => unreachable!("幂等已在前面处理"),
        ConfirmGate::NotDraftReady { .. } | ConfirmGate::NoPlan => {
            return Err("会话状态不允许确认部署".to_string())
        }
        ConfirmGate::InputsChanged => return Err("输入已变化，请重新分析".to_string()),
        ConfirmGate::PreflightBlocked { checks } => {
            record(
                &conn,
                &session.id,
                SessionEventKind::PreflightBlocked,
                &format!("预检阻塞 {} 项", checks.len()),
                now,
            )?;
            transition(
                &conn,
                &mut session,
                SessionStatus::NeedsInput,
                now,
                "预检未通过，等待处理",
            )?;
            ConfirmOutcome {
                status: "needs_input".to_string(),
                run_id: None,
                blocked_checks: checks,
                approval_nodes: approvals,
                message: "预检未通过，尚未启动任何部署".to_string(),
                session: session.clone(),
            }
        }
        ConfirmGate::NeedsApproval { nodes } => ConfirmOutcome {
            status: "needs_approval".to_string(),
            run_id: None,
            blocked_checks: blocked.clone(),
            approval_nodes: nodes,
            message: "该计划包含需要你确认的高风险节点".to_string(),
            session: session.clone(),
        },
        ConfirmGate::Proceed => {
            transition(
                &conn,
                &mut session,
                SessionStatus::Preflight,
                now,
                "预检通过",
            )?;
            transition(
                &conn,
                &mut session,
                SessionStatus::Deploying,
                now,
                "开始部署",
            )?;
            let detail = deployment_run::start_run(
                app.clone(),
                &state,
                &plan_id,
                &session_id,
                approve_high_risk,
            )
            .await?;
            session.run_id = Some(detail.run.id.clone());
            session.updated_at = AppDb::now();
            db::deployment_session::upsert_session(&conn, &session)
                .map_err(|error| error.to_string())?;
            record(
                &conn,
                &session.id,
                SessionEventKind::RunStarted,
                &format!("运行 {}", detail.run.id),
                AppDb::now(),
            )?;
            ConfirmOutcome {
                status: "started".to_string(),
                run_id: Some(detail.run.id),
                blocked_checks: Vec::new(),
                approval_nodes: approvals,
                message: "已开始部署".to_string(),
                session: session.clone(),
            }
        }
    };

    // ---- 4) 记下这次确认（幂等键 + 结果），双击直接回放 ----
    db::deployment_session::set_confirm_result(
        &conn,
        &session.id,
        &idempotency_key,
        &serde_json::to_string(&outcome).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_session_confirm_and_start",
        session.server_id.as_deref(),
        None,
        &format!(
            "{{\"session\":\"{}\",\"plan\":\"{plan_id}\",\"status\":\"{}\"}}",
            session.id, outcome.status
        ),
    );
    let _ = app.emit(&session_event(&session.id), outcome.clone());
    Ok(outcome)
}

/// 本产品支持的拓扑全集。
///
/// 这是**形态**清单，不是"这台机器装了什么"——真实能力要连上服务器才知道，
/// 由预检门禁核实并阻断。给全集是为了让 AI 表达意图，不让它猜机器状态。
const ALL_TOPOLOGIES: &[crate::deployment::proposal::model::TopologyKind] = &[
    crate::deployment::proposal::model::TopologyKind::StaticNginx,
    crate::deployment::proposal::model::TopologyKind::SystemdProcesses,
    crate::deployment::proposal::model::TopologyKind::DockerCompose,
    crate::deployment::proposal::model::TopologyKind::DockerImages,
    crate::deployment::proposal::model::TopologyKind::HybridGateway,
];

/// 把校验拒绝转成**可读且脱敏**的一段文本（事件与错误提示共用）。
///
/// 用 `Debug` 而不是 `serde_json`：`DraftRejection` 刻意没实现 `Serialize` ——
/// 它是内部类型，不该被当成对外协议随便序列化。
fn describe_rejections(rejections: &[crate::deployment::planner::DraftRejection]) -> String {
    rejections
        .iter()
        .map(|item| format!("{item:?}"))
        .collect::<Vec<_>>()
        .join("；")
}

/// **分析会话**：组装提示词 → 调模型 → 七道校验 → 确定性计划图。
///
/// # 边界
///
/// * **什么都不部署**：本命令只产出计划图，`run_id` 始终为空；
///   真正启动必须另走 `confirm_and_start`（含幂等键与指纹校验）；
/// * **AI 只出意图**：草案先过 `validate_draft`（禁命令 / 禁越权目标 / 引用必须真实），
///   再由 `workflow::build` 这个**确定性**构造器生成节点与 `params_json`；
/// * **状态机不允许跳步**：`created → importing → analyzing`，
///   因为"读项目"与"问模型"是两个可分开失败的阶段。
#[tauri::command]
pub async fn deployment_session_analyze(
    state: State<'_, AppState>,
    id: String,
) -> Result<DeploymentSession, String> {
    use crate::deployment::ai::{AiAdvisor, OpenAiCompatibleAdvisor};
    use crate::deployment::planner::{
        as_inputs, build_draft_prompt, to_workflow_plan, validate_draft, DraftContext,
        DraftPromptInput,
    };
    use crate::deployment::proposal::workflow;

    let now = AppDb::now();

    // ---- 1) 前置校验 + 迁移（同步；连接在 await 前释放）----
    let (mut session, deploy_root) = {
        let conn = open_db(&state)?;
        let mut session = db::deployment_session::get_session(&conn, &id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "部署会话不存在".to_string())?;
        match session.status {
            // 重试路径：失败 / 回滚 / 已回答问题后都能再来一次。
            SessionStatus::Created
            | SessionStatus::Importing
            | SessionStatus::Analyzing
            | SessionStatus::NeedsInput
            | SessionStatus::Failed
            | SessionStatus::RolledBack => {}
            other => {
                return Err(format!(
                    "当前状态「{}」不能分析（方案已就绪或正在部署）",
                    other.label()
                ))
            }
        }
        let environment_id = session
            .environment_id
            .clone()
            .ok_or_else(|| "会话还没有关联环境，请先在向导里选择环境".to_string())?;
        let environment = db::get_environment(&conn, &environment_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "环境不存在".to_string())?;

        if session.status == SessionStatus::Created {
            transition(
                &conn,
                &mut session,
                SessionStatus::Importing,
                now,
                "准备读取项目",
            )?;
        }
        if session.status != SessionStatus::Analyzing {
            transition(
                &conn,
                &mut session,
                SessionStatus::Analyzing,
                now,
                "组装提示词并请求模型",
            )?;
        }
        (session, environment.deploy_root)
    };

    // ---- 2) 准备 AI 调用（密钥只在内存，用完即弃）----
    let config = {
        let conn = open_db(&state)?;
        db::default_provider(&conn)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "还没有可用的 AI 提供方，请先在设置里配置".to_string())?
    };
    let api_key = crate::keyring::read_secret(&config.keyring_account())
        .map_err(|error| format!("读不到 API Key（可能已被系统凭据管理器清理）：{error}"))?;
    let advisor = OpenAiCompatibleAdvisor::new(config.clone(), api_key)
        .map_err(|error| error.user_message())?;

    // 本期还没接 Memory / Knowledge 检索：给**空清单**，模型引用不了任何东西，
    // 也就不可能伪造引用（`validate_draft` 会拒）。
    let memory_refs: Vec<String> = Vec::new();
    let knowledge_refs: Vec<String> = Vec::new();
    let prompt = build_draft_prompt(&DraftPromptInput {
        user_description: &session.user_description,
        analysis: None,
        memory_refs: &memory_refs,
        knowledge_refs: &knowledge_refs,
        supported_topologies: ALL_TOPOLOGIES,
        deploy_root: &deploy_root,
    });

    // ---- 3) 调模型（这是唯一一次网络请求；没有任何服务器操作）----
    let cancel = crate::deployment::ai::AiCancel::new();
    let outcome = advisor.draft(&prompt, &cancel).await;

    // ---- 4) 七道校验：先看有没有"必须问用户"的阻塞问题 ----
    let draft = match outcome.draft {
        Ok(draft) => draft,
        Err(error) => {
            let conn = open_db(&state)?;
            let mut failed = session.clone();
            transition(
                &conn,
                &mut failed,
                SessionStatus::Failed,
                AppDb::now(),
                "模型请求失败",
            )?;
            return Err(error.user_message());
        }
    };
    let rejections = validate_draft(
        &draft,
        &DraftContext {
            allowed_memory_refs: &memory_refs,
            allowed_knowledge_refs: &knowledge_refs,
            supported_topologies: ALL_TOPOLOGIES,
            deploy_root: &deploy_root,
        },
    );
    if !draft.blocking_questions.is_empty() {
        // 有阻塞问题 → 问用户，**不生成计划图**。
        let question = &draft.blocking_questions[0];
        let conn = open_db(&state)?;
        session.current_question = Some(SessionQuestion {
            id: question.id.clone(),
            kind: question.kind,
            question: question.question.clone(),
            options: question.options.clone(),
        });
        transition(
            &conn,
            &mut session,
            SessionStatus::NeedsInput,
            AppDb::now(),
            "模型要求补充信息",
        )?;
        record(
            &conn,
            &session.id,
            SessionEventKind::QuestionAsked,
            "模型要求补充信息",
            AppDb::now(),
        )?;
        return Ok(session);
    }
    if !rejections.is_empty() {
        let conn = open_db(&state)?;
        let mut failed = session.clone();
        let detail = format!("草案未通过校验：{}", describe_rejections(&rejections));
        transition(
            &conn,
            &mut failed,
            SessionStatus::Failed,
            AppDb::now(),
            &detail,
        )?;
        return Err(detail);
    }

    // ---- 5) 确定性建图（AI 到此为止，后面没有模型参与）----
    let plan_input = to_workflow_plan(&draft);
    let workflow = workflow::build(&as_inputs(&plan_input));
    if workflow.nodes.is_empty() {
        let conn = open_db(&state)?;
        let mut failed = session.clone();
        transition(
            &conn,
            &mut failed,
            SessionStatus::Failed,
            AppDb::now(),
            "草案没有产出任何可执行步骤",
        )?;
        return Err("草案没有产出任何可执行步骤".to_string());
    }
    let plan_id = format!("plan-{}", session.id);
    let graph = crate::deployment::model::DeploymentPlanGraph {
        plan: crate::deployment::model::DeploymentPlan {
            id: plan_id.clone(),
            application_id: session
                .application_id
                .clone()
                .ok_or_else(|| "会话还没有关联应用，无法生成计划图".to_string())?,
            environment_id: session
                .environment_id
                .clone()
                .ok_or_else(|| "会话还没有关联环境，无法生成计划图".to_string())?,
            name: draft.summary.clone(),
            version: 1,
            status: crate::deployment::model::PlanStatus::Draft,
            // **AI 建议**：这个来源标记会一直留在计划上，界面上必须能看出来。
            proposal_source: crate::deployment::model::ProposalSource::AiProposed,
            risk_level: workflow::highest_risk(&workflow.nodes),
            notes: draft.assumptions.join("\n"),
            created_at: now,
            updated_at: now,
        },
        nodes: workflow.nodes,
        edges: workflow.edges,
    };
    crate::deployment::validate::validate_plan_graph(&graph)
        .map_err(|error| format!("生成的计划图没通过校验：{error}"))?;

    // ---- 6) 落库：计划图 + 会话进入 draft_ready（仍未启动任何部署）----
    let conn = open_db(&state)?;
    db::upsert_plan_graph(&conn, &graph).map_err(|error| error.to_string())?;
    transition(
        &conn,
        &mut session,
        SessionStatus::DraftReady,
        AppDb::now(),
        "草案已就绪，等待你确认",
    )?;
    session.plan_id = Some(plan_id.clone());
    session.updated_at = AppDb::now();
    db::deployment_session::upsert_session(&conn, &session).map_err(|error| error.to_string())?;
    record(
        &conn,
        &session.id,
        SessionEventKind::DraftGenerated,
        &format!("计划 {plan_id} 已生成，共 {} 个步骤", graph.nodes.len()),
        AppDb::now(),
    )?;
    record_audit(
        &state,
        "deployment_session_analyze",
        session.server_id.as_deref(),
        None,
        &format!(
            "{{\"session\":\"{}\",\"plan\":\"{plan_id}\",\"attempts\":{}}}",
            session.id, outcome.attempts
        ),
    );
    Ok(session)
}
