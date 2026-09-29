//! P5.2 部署方案生成的 IPC。
//!
//! # 边界
//!
//! * **只读输入**：应用 / 环境 / 服务 / 依赖 / 制品 / 域名 / 容量问卷全部来自
//!   本机 SQLite；服务器能力来自**实时探测**（有会话时）或最近一次扫描的缓存。
//! * **不执行任何部署**：`confirm` 只把方案落成一份 `status = draft` 的计划
//!   （`approval_required` 原样保留），批准与执行属于后续阶段。
//! * **AI 可选**：当前没有配置任何模型提供方，因此 `advisor = None`；
//!   界面会如实显示"AI 未启用"，方案仍由确定性规则引擎完整产出。

use std::collections::HashMap;
use std::sync::Arc;

use tauri::{Emitter, State};

use crate::db;
use crate::deployment::model::{PlanStatus, ProposalSource};
use crate::deployment::proposal::{engine, model::*, ProposalInputs, SecurityPolicy};
use crate::deployment::validate;
use crate::state::AppState;

use super::{open_db, record_audit};

/// 生成一份方案。
#[tauri::command]
pub async fn deployment_proposal_generate(
    state: State<'_, AppState>,
    application_id: String,
    environment_id: Option<String>,
    session_id: Option<String>,
) -> Result<ProposalOutcome, String> {
    // ---- 读输入（连接不跨 await）----
    let (
        application,
        environment,
        services,
        relations,
        artifacts,
        domains,
        policy,
        capacity,
        import_tasks,
        server_id,
    ) = {
        let conn = open_db(&state)?;
        let application = db::get_application(&conn, &application_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "应用不存在".to_string())?;
        let environment = match environment_id.as_deref() {
            Some(id) if !id.trim().is_empty() => {
                db::get_environment(&conn, id).map_err(|error| error.to_string())?
            }
            _ => db::list_environments(&conn, Some(&application_id))
                .map_err(|error| error.to_string())?
                .into_iter()
                .next(),
        };
        let services = db::list_service_units(
            &conn,
            Some(&application_id),
            environment
                .as_ref()
                .map(|environment| environment.id.as_str()),
        )
        .map_err(|error| error.to_string())?;
        let relations = db::list_service_relations(&conn, Some(&application_id))
            .map_err(|error| error.to_string())?;
        let artifacts = db::list_artifacts(&conn, Some(&application_id), None)
            .map_err(|error| error.to_string())?;
        // P5.1 的识别结果挂在导入任务上；这里把它读出来，交给
        // `derive_service_facts` 还原成"这个服务实际用什么端口 / 查哪个健康端点"。
        let import_tasks = db::list_import_tasks(&conn, Some(application_id.as_str()), 200)
            .map_err(|error| error.to_string())?;
        let domains = db::list_domain_bindings(
            &conn,
            environment
                .as_ref()
                .map(|environment| environment.id.as_str()),
        )
        .map_err(|error| error.to_string())?;
        let policy =
            db::get_security_policy(&conn, &application_id).map_err(|error| error.to_string())?;
        // 容量问卷挂在环境上（没有环境就没有问卷）。
        let capacity = match environment.as_ref() {
            Some(environment) => db::get_capacity_profile(&conn, &environment.id)
                .map_err(|error| error.to_string())?,
            None => None,
        };
        let server_id = environment
            .as_ref()
            .map(|environment| environment.server_id.clone())
            .unwrap_or_else(|| application.server_id.clone());
        (
            application,
            environment,
            services,
            relations,
            artifacts,
            domains,
            policy,
            capacity,
            import_tasks,
            server_id,
        )
    };

    // 服务事实来自 P5.1 的识别结果：**精确匹配，匹配不上就是空集**，
    // 方案会如实写"端口未定 / 健康检查待确认"，而不是猜一个看着合理的值。
    let facts = crate::deployment::proposal::derive_service_facts(
        &services,
        &artifacts,
        &import_tasks,
        environment
            .as_ref()
            .map(|environment| environment.deploy_root.as_str()),
    );

    // ---- 服务器能力：实时事实优先，其次最近一次扫描的缓存 ----
    let capability = match session_id.as_deref().filter(|id| !id.trim().is_empty()) {
        Some(session) if state.ssh.is_connected(session).await => {
            crate::capability_probe::probe_capabilities(session, &state.ssh)
                .await
                .ok()
        }
        _ => state
            .project_scans
            .last_by_server
            .lock()
            .await
            .get(&server_id)
            .and_then(|scan| scan.capability.clone()),
    };

    let inputs = ProposalInputs {
        application,
        environment,
        server_id,
        services,
        relations,
        artifacts,
        domains,
        // 端口 / 健康检查 / 环境变量名：优先用 P5.1 的识别结果（上一步已还原）。
        facts,
        capability,
        capacity,
        policy,
        observed: None,
        now: db::AppDb::now(),
    };

    let mut outcome = engine::generate(&inputs, None);
    outcome.proposal.id = uuid::Uuid::new_v4().to_string();
    outcome.proposal.created_at = inputs.now;
    outcome.proposal.fingerprint.generated_at = inputs.now;

    {
        let conn = open_db(&state)?;
        db::upsert_proposal(&conn, &outcome.proposal).map_err(|error| error.to_string())?;
    }
    record_audit(
        &state,
        "deployment_proposal_generate",
        Some(&inputs.server_id),
        None,
        &format!(
            "{{\"proposal\":\"{}\",\"ready\":{},\"approvable\":{},\"input\":\"{}\",\"output\":\"{}\"}}",
            outcome.proposal.id,
            outcome.ready,
            outcome.approvable,
            outcome.proposal.fingerprint.input_hash,
            outcome.proposal.fingerprint.output_hash
        ),
    );
    Ok(outcome)
}

#[tauri::command]
pub async fn deployment_proposal_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<DeploymentProposal>, String> {
    let conn = open_db(&state)?;
    db::list_proposals(
        &conn,
        application_id.as_deref().filter(|id| !id.trim().is_empty()),
        limit.unwrap_or(20).min(200) as i64,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_proposal_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DeploymentProposal>, String> {
    let conn = open_db(&state)?;
    db::get_proposal(&conn, &id).map_err(|error| error.to_string())
}

/// 用户确认方案 → 落成一份**草案计划**（不是批准，也不执行）。
#[tauri::command]
pub async fn deployment_proposal_confirm(
    state: State<'_, AppState>,
    id: String,
) -> Result<crate::deployment::model::DeploymentPlanGraph, String> {
    let mut conn = open_db(&state)?;
    let proposal = db::get_proposal(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "方案不存在".to_string())?;
    if proposal.status != ProposalStatus::Draft {
        return Err("该方案已经处理过了（已确认或已拒绝）".to_string());
    }
    if !proposal.is_ready() {
        return Err("方案尚未就绪（存在阻塞项或缺少关键信息），不能确认".to_string());
    }
    let Some(environment_id) = proposal.environment_id.clone() else {
        return Err("方案没有目标环境".to_string());
    };

    // 节点 id 在这里才生成（方案本身是确定性的，落库才需要唯一 id）。
    let now = db::AppDb::now();
    let short = &proposal.fingerprint.output_hash[..8.min(proposal.fingerprint.output_hash.len())];
    let plan_id = uuid::Uuid::new_v4().to_string();
    let mut id_map: HashMap<String, String> = HashMap::new();
    let mut nodes = proposal.workflow.nodes.clone();
    for node in nodes.iter_mut() {
        let new_id = uuid::Uuid::new_v4().to_string();
        id_map.insert(node.id.clone(), new_id.clone());
        node.id = new_id;
        node.plan_id = plan_id.clone();
        node.created_at = now;
        node.updated_at = now;
    }
    let mut edges = proposal.workflow.edges.clone();
    for edge in edges.iter_mut() {
        let from = id_map
            .get(&edge.from_node_id)
            .cloned()
            .ok_or_else(|| "方案里的连线引用了不存在的节点".to_string())?;
        let to = id_map
            .get(&edge.to_node_id)
            .cloned()
            .ok_or_else(|| "方案里的连线引用了不存在的节点".to_string())?;
        edge.id = uuid::Uuid::new_v4().to_string();
        edge.plan_id = plan_id.clone();
        edge.from_node_id = from;
        edge.to_node_id = to;
        edge.created_at = now;
    }

    let graph = crate::deployment::model::DeploymentPlanGraph {
        plan: crate::deployment::model::DeploymentPlan {
            id: plan_id.clone(),
            application_id: proposal.application_id.clone(),
            environment_id: environment_id.clone(),
            name: format!("{} · {}", proposal.summary.headline, short),
            version: 1,
            // **确认 = 生成草案**，不是批准：`approval_required` 原样保留。
            status: PlanStatus::Draft,
            proposal_source: ProposalSource::Template,
            risk_level: crate::deployment::proposal::workflow::highest_risk(&nodes),
            notes: format!(
                "由 P5.2 规则引擎生成；方案 {}；输入 {} / 输出 {}；知识库 {}；引擎 {}",
                proposal.id,
                &proposal.fingerprint.input_hash[..12.min(proposal.fingerprint.input_hash.len())],
                short,
                proposal.fingerprint.knowledge_version,
                proposal.fingerprint.engine_version
            ),
            created_at: now,
            updated_at: now,
        },
        nodes,
        edges,
    };
    validate::validate_plan_graph(&graph).map_err(|error| error.to_string())?;

    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    db::upsert_plan_graph(&transaction, &graph).map_err(|error| error.to_string())?;
    db::mark_proposal_confirmed(&transaction, &id, &plan_id, now)
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;

    record_audit(
        &state,
        "deployment_proposal_confirm",
        Some(&proposal.server_id),
        None,
        &format!("{{\"proposal\":\"{}\",\"plan\":\"{}\"}}", id, plan_id),
    );
    let conn = open_db(&state)?;
    db::get_plan_graph(&conn, &plan_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "计划保存后读取失败".to_string())
}

#[tauri::command]
pub async fn deployment_proposal_reject(
    state: State<'_, AppState>,
    id: String,
) -> Result<DeploymentProposal, String> {
    let conn = open_db(&state)?;
    db::mark_proposal_status(&conn, &id, ProposalStatus::Rejected, db::AppDb::now())
        .map_err(|error| error.to_string())?;
    let proposal = db::get_proposal(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "方案不存在".to_string())?;
    record_audit(
        &state,
        "deployment_proposal_reject",
        None,
        None,
        &format!("{{\"proposal\":\"{id}\"}}"),
    );
    Ok(proposal)
}

#[tauri::command]
pub async fn deployment_proposal_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    db::delete_proposal(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_proposal_delete",
        None,
        None,
        &format!("{{\"proposal\":\"{id}\"}}"),
    );
    Ok(())
}

/// 读某应用的安全策略（没有记录 = 最保守的默认档）。
#[tauri::command]
pub async fn deployment_policy_get(
    state: State<'_, AppState>,
    application_id: String,
) -> Result<SecurityPolicy, String> {
    let conn = open_db(&state)?;
    db::get_security_policy(&conn, &application_id).map_err(|error| error.to_string())
}

/// 保存安全策略。**返回的是被钉硬之后的策略**（界面据此显示"哪些被恢复"）。
#[tauri::command]
pub async fn deployment_policy_save(
    state: State<'_, AppState>,
    application_id: String,
    policy: SecurityPolicy,
) -> Result<SecurityPolicy, String> {
    let (hardened, downgraded) = policy.hardened();
    let now = db::AppDb::now();
    {
        let conn = open_db(&state)?;
        db::upsert_security_policy(&conn, &application_id, &hardened, now)
            .map_err(|error| error.to_string())?;
    }
    if !downgraded.is_empty() {
        record_audit(
            &state,
            "deployment_policy_hardened",
            None,
            None,
            &format!(
                "{{\"application\":\"{}\",\"restored\":[{}]}}",
                application_id,
                downgraded
                    .iter()
                    .map(|field| format!("\"{field}\""))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        );
    }
    record_audit(
        &state,
        "deployment_policy_save",
        None,
        None,
        &format!("{{\"application\":\"{application_id}\"}}"),
    );
    Ok(hardened)
}

/// `generate` 一律以 `advisor = None` 调用 —— **确定性引擎不依赖网络**。
///
/// AI 复核是**独立的异步命令**（[`deployment_proposal_ai_review`]）：
/// 它在方案已经落库之后再跑，失败只影响"这次复核"，方案照常可用。
/// 没配置提供方时界面照实显示"AI 未配置"，**不许用模板文案假装分析过**。
pub const AI_ADVISOR_ENABLED: bool = false;

#[allow(dead_code)]
fn advisor_placeholder() -> Option<Arc<dyn crate::deployment::proposal::ProposalAdvisor>> {
    None
}

// -- P5.5 AI 复核（独立命令 + 后台任务 + 事件）-------------------------------

/// AI 复核事件名（按方案）。载荷是 [`AiReviewTask`]。
pub fn ai_review_event(proposal_id: &str) -> String {
    format!("deployment-proposal-ai-review-{proposal_id}")
}

/// 发起一次 AI 复核。
///
/// **立刻返回**（任务进入后台）：慢模型不该占着前端 invoke。
/// 流程：读方案 → 读启用的提供方 → 检索知识 → 组装脱敏提示词 → 请求模型 →
/// 严格校验答复 → 更新 `proposal.ai_review` 与 AI 指纹 → 记录知识引用 → 写审计 → 发事件。
///
/// 没有提供方时返回错误（界面显示"AI 未配置"并给出前往设置的入口），
/// **确定性方案不受影响**。
#[tauri::command]
pub async fn deployment_proposal_ai_review(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    proposal_id: String,
) -> Result<crate::deployment::ai::model::AiReviewTask, String> {
    use crate::deployment::ai::model::{AiReviewTask, AiTaskStatus};
    use crate::deployment::ai::{AiAdvisor, OpenAiCompatibleAdvisor};
    use crate::deployment::knowledge::{
        search, to_references, KnowledgeBudget, KnowledgeQueryInput,
    };
    use crate::deployment::proposal::ai::{build_prompt, merge_into, prompt_hash, PromptExtras};

    let now = db::AppDb::now();
    let config = {
        let conn = open_db(&state)?;
        db::default_provider(&conn).map_err(|error| error.to_string())?
    };
    let Some(config) = config else {
        return Err(
            "还没有配置可用的 AI 提供方：请在设置 → AI 模型里添加一个，并设为默认后重试"
                .to_string(),
        );
    };
    let proposal = {
        let conn = open_db(&state)?;
        db::get_proposal(&conn, &proposal_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "方案不存在".to_string())?
    };

    let task_id = uuid::Uuid::new_v4().to_string();
    let mut task = AiReviewTask::queued(&task_id, &proposal_id, now);
    task.provider_id = Some(config.id.clone());
    task.model = Some(config.model.clone());
    task.status = AiTaskStatus::Running;
    task.started_at = Some(now);
    task.attempts = 1;
    {
        let conn = open_db(&state)?;
        db::upsert_review_task(&conn, &task).map_err(|error| error.to_string())?;
    }
    let token = state.ai_reviews.register(&task_id);

    let db = state.db.clone();
    let emit_event = ai_review_event(&proposal_id);
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let api_key = crate::keyring::read_secret(&config.keyring_account());
        let outcome = match api_key {
            Err(error) => Err(
                crate::deployment::ai::model::AiProviderError::InvalidConfig(format!(
                    "读不到 API Key（可能已被系统凭据管理器清理）：{error}"
                )),
            ),
            Ok(api_key) => match OpenAiCompatibleAdvisor::new(config.clone(), api_key, false) {
                Err(error) => Err(error),
                Ok(advisor) => {
                    // ---- 知识检索（与"检索测试"同一个函数、同一套预算）----
                    let (documents, capacity) = match db.open() {
                        Ok(conn) => (
                            db::list_documents(
                                &conn,
                                Some(&proposal.application_id),
                                proposal.environment_id.as_deref(),
                                false,
                            )
                            .unwrap_or_default(),
                            proposal
                                .environment_id
                                .as_deref()
                                .and_then(|environment_id| {
                                    db::get_capacity_profile(&conn, environment_id)
                                        .ok()
                                        .flatten()
                                })
                                .and_then(|profile| serde_json::to_value(profile).ok()),
                        ),
                        Err(_) => (Vec::new(), None),
                    };
                    let terms = build_terms(&proposal);
                    let query = KnowledgeQueryInput {
                        application_id: Some(proposal.application_id.clone()),
                        environment_id: proposal.environment_id.clone(),
                        terms,
                        categories: Vec::new(),
                        tags: Vec::new(),
                        limit: KnowledgeBudget::default().max_hits,
                    };
                    let hits = search(&documents, &query, KnowledgeBudget::default());
                    let references = to_references(&proposal.knowledge_references, &hits);

                    let extras = PromptExtras {
                        capacity,
                        capability: None,
                    };
                    let prompt = build_prompt(&proposal, &references, &extras);
                    let hash = prompt_hash(&prompt);
                    let result = advisor.review(&prompt).await;

                    // ---- 合并：只动 AI 相关字段，确定性结论一个字节不改 ----
                    let mut updated = proposal.clone();
                    let review = merge_into(
                        &mut updated,
                        &config.model,
                        crate::deployment::proposal::PROMPT_VERSION,
                        &hash,
                        &references,
                        result.map_err(|error| crate::deployment::proposal::ai::AiReviewFailure {
                            reason: error.user_message(),
                            kind: match error {
                                crate::deployment::ai::model::AiProviderError::RejectedContent {
                                    kind,
                                    ..
                                } => kind,
                                _ => crate::deployment::proposal::model::AiRejectionKind::ProviderError,
                            },
                        }),
                        task.attempts,
                        Some(i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)),
                    );

                    if let Ok(conn) = db.open() {
                        let _ = db::upsert_proposal(&conn, &updated);
                        // 知识引用记录：当时用的是哪一版，事后能查。
                        for reference in &references {
                            let _ = db::record_usage(
                                &conn,
                                &crate::deployment::knowledge::model::KnowledgeUsageRecord {
                                    id: format!("{}:{}", updated.id, reference.entry_id),
                                    document_id: reference.entry_id.clone(),
                                    version: reference.version.parse().unwrap_or(0),
                                    proposal_id: updated.id.clone(),
                                    used_by: "ai_review".to_string(),
                                    created_at: db::AppDb::now(),
                                },
                            );
                        }
                    }
                    Ok(review)
                }
            },
        };

        let finished = db::AppDb::now();
        let mut stored = AiReviewTask::queued(&task_id, &proposal_id, now);
        stored.provider_id = Some(config.id.clone());
        stored.model = Some(config.model.clone());
        stored.started_at = Some(now);
        stored.finished_at = Some(finished);
        stored.duration_ms = Some(i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX));
        stored.attempts = task.attempts;
        match outcome {
            Ok(review) => {
                stored.status = if review.status
                    == crate::deployment::proposal::model::AiReviewStatus::Failed
                {
                    AiTaskStatus::Failed
                } else {
                    AiTaskStatus::Succeeded
                };
                stored.error = review
                    .rejected
                    .first()
                    .map(|rejection| rejection.reason.clone())
                    .filter(|_| {
                        review.status == crate::deployment::proposal::model::AiReviewStatus::Failed
                    });
                stored.error_code = stored.error.as_ref().map(|_| "provider_error".to_string());
            }
            Err(error) => {
                stored.status = AiTaskStatus::Failed;
                stored.error = Some(error.user_message());
                stored.error_code = Some(error.code().to_string());
            }
        }
        if token.load(std::sync::atomic::Ordering::Relaxed) {
            stored.status = AiTaskStatus::Cancelled;
            stored.error = Some("AI 复核已取消".to_string());
            stored.error_code = Some("cancelled".to_string());
        }
        if let Ok(conn) = db.open() {
            let _ = db::upsert_review_task(&conn, &stored);
        }
        let _ = app.emit(&emit_event, stored.clone());
    });

    Ok(task)
}

/// 查一次复核任务的状态（轮询兜底；主路径是事件）。
#[tauri::command]
pub async fn deployment_proposal_ai_review_status(
    state: State<'_, AppState>,
    proposal_id: String,
) -> Result<Option<crate::deployment::ai::model::AiReviewTask>, String> {
    let conn = open_db(&state)?;
    db::latest_review_task(&conn, &proposal_id).map_err(|error| error.to_string())
}

/// 取消一次正在进行（或还在重试）的复核。
#[tauri::command]
pub async fn deployment_proposal_ai_review_cancel(
    state: State<'_, AppState>,
    proposal_id: String,
) -> Result<bool, String> {
    let task = {
        let conn = open_db(&state)?;
        db::latest_review_task(&conn, &proposal_id).map_err(|error| error.to_string())?
    };
    let Some(task) = task else {
        return Ok(false);
    };
    Ok(state.ai_reviews.cancel(&task.id))
}

/// 从方案上下文里抽检索词：**只取名字与开关，不取任何值**（这些词会进提示词）。
fn build_terms(proposal: &crate::deployment::proposal::model::DeploymentProposal) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    for service in &proposal.services {
        parts.push(service.name.clone());
        // 运行方式与形态用 Debug 名即可（它们只是检索词，不是展示文案）。
        parts.push(format!("{:?}", service.service_kind));
    }
    for domain in &proposal.domains {
        parts.push("ssl".to_string());
        let _ = domain;
    }
    for risk in &proposal.risks {
        parts.push(risk.title.clone());
    }
    for unknown in &proposal.unknowns {
        parts.push(unknown.question.clone());
    }
    parts.push(format!("{:?}", proposal.recommended_topology.kind));
    crate::deployment::knowledge::terms_from_context(&parts)
}
