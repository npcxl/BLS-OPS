//! P5.0 智能部署中心的 IPC 层（CRUD + 只读运行/版本）。
//!
//! # 边界
//!
//! * 命令**只做参数校验 + 落库**：没有 SSH、没有 SFTP、没有任何远程调用 ——
//!   本阶段不执行部署，因此也不存在"部署执行"入口。
//! * 前端传的是**结构化实体**（`deployment::model` 里的类型），不是命令字符串；
//!   每个实体在写库前都过 `deployment::validate`，那里会拒绝任何含 shell 元字符
//!   的文本，并保证 Secret 只有引用没有明文。
//! * 写操作全部记审计（`record_audit`），细节只记 id / 名称，绝不记密钥内容。
//!
//! # 与旧 P3 "P5 foundation" 的关系
//!
//! `commands/deployment.rs`（`project_*` / `deployment_*`，基于 `commands_json`）
//! 保持不动并标记为 legacy；本模块与它**没有数据往来**，唯一交集是
//! `deployment_service_unit_link_project`：把 P3.8 的已确认项目挂到服务上。

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, State};

use crate::db;
use crate::deployment::artifact::model::{
    ArtifactConfirmOutcome, ArtifactImportConfirmation, ArtifactImportTask, ImportSource,
    ImportStage, ImportStatus, ServiceCandidate,
};
use crate::deployment::artifact::{remote, tasks};
use crate::deployment::{model::*, validate};
use crate::state::AppState;

use super::{open_db, record_audit};

/// 统一补齐 id 与时间戳：前端只负责业务字段。
fn stamp(id: &mut String, created_at: &mut i64, updated_at: &mut i64) {
    if id.trim().is_empty() {
        *id = uuid::Uuid::new_v4().to_string();
    }
    let now = db::AppDb::now();
    if *created_at <= 0 {
        *created_at = now;
    }
    *updated_at = now;
}

fn require_application(conn: &Connection, id: &str) -> Result<(), String> {
    match db::application_exists(conn, id).map_err(|error| error.to_string())? {
        true => Ok(()),
        false => Err("应用不存在，请先创建应用".to_string()),
    }
}

fn require_environment(conn: &Connection, id: &str) -> Result<DeploymentEnvironment, String> {
    db::get_environment(conn, id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "环境不存在，请先创建环境".to_string())
}

// -- 应用 -------------------------------------------------------------------

#[tauri::command]
pub async fn deployment_application_list(
    state: State<'_, AppState>,
    server_id: Option<String>,
) -> Result<Vec<DeploymentApplication>, String> {
    let conn = open_db(&state)?;
    db::list_applications(&conn, server_id.as_deref()).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_application_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DeploymentApplication>, String> {
    let conn = open_db(&state)?;
    db::get_application(&conn, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_application_save(
    state: State<'_, AppState>,
    application: DeploymentApplication,
) -> Result<DeploymentApplication, String> {
    let conn = open_db(&state)?;
    let mut application = application;
    stamp(
        &mut application.id,
        &mut application.created_at,
        &mut application.updated_at,
    );
    validate::validate_application(&application).map_err(|error| error.to_string())?;
    db::upsert_application(&conn, &application).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_application_save",
        Some(&application.server_id),
        None,
        &format!(
            "{{\"id\":\"{}\",\"name\":\"{}\"}}",
            application.id, application.name
        ),
    );
    Ok(application)
}

#[tauri::command]
pub async fn deployment_application_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<DeploymentCascadeResult, String> {
    let conn = open_db(&state)?;
    let removed = db::delete_application_cascade(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_application_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\"}}"),
    );
    Ok(removed)
}

// -- 环境 -------------------------------------------------------------------

#[tauri::command]
pub async fn deployment_environment_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
) -> Result<Vec<DeploymentEnvironment>, String> {
    let conn = open_db(&state)?;
    db::list_environments(&conn, application_id.as_deref()).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_environment_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DeploymentEnvironment>, String> {
    let conn = open_db(&state)?;
    db::get_environment(&conn, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_environment_save(
    state: State<'_, AppState>,
    environment: DeploymentEnvironment,
) -> Result<DeploymentEnvironment, String> {
    let conn = open_db(&state)?;
    let mut environment = environment;
    stamp(
        &mut environment.id,
        &mut environment.created_at,
        &mut environment.updated_at,
    );
    validate::validate_environment(&environment).map_err(|error| error.to_string())?;
    require_application(&conn, &environment.application_id)?;
    // P5.0 一应用一台服务器：环境跟着应用走，避免出现"应用在 A、环境在 B"的
    // 悬空配置（多服务器映射留给后续阶段）。
    let application = db::get_application(&conn, &environment.application_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "应用不存在，请先创建应用".to_string())?;
    if application.server_id != environment.server_id {
        return Err("环境必须与应用在同一台服务器上（P5.0 暂不支持跨服务器环境）".to_string());
    }
    db::upsert_environment(&conn, &environment).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_environment_save",
        Some(&environment.server_id),
        None,
        &format!(
            "{{\"id\":\"{}\",\"name\":\"{}\"}}",
            environment.id, environment.name
        ),
    );
    Ok(environment)
}

#[tauri::command]
pub async fn deployment_environment_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<DeploymentCascadeResult, String> {
    let conn = open_db(&state)?;
    let removed = db::delete_environment_cascade(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_environment_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\"}}"),
    );
    Ok(removed)
}

// -- 服务 -------------------------------------------------------------------

#[tauri::command]
pub async fn deployment_service_unit_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
    environment_id: Option<String>,
) -> Result<Vec<ServiceUnit>, String> {
    let conn = open_db(&state)?;
    db::list_service_units(&conn, application_id.as_deref(), environment_id.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_service_unit_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ServiceUnit>, String> {
    let conn = open_db(&state)?;
    db::get_service_unit(&conn, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_service_unit_save(
    state: State<'_, AppState>,
    unit: ServiceUnit,
) -> Result<ServiceUnit, String> {
    let conn = open_db(&state)?;
    let mut unit = unit;
    stamp(&mut unit.id, &mut unit.created_at, &mut unit.updated_at);
    // 服务目录必须落在环境根目录内 —— 校验需要环境的 deploy_root。
    let environment = require_environment(&conn, &unit.environment_id)?;
    if environment.application_id != unit.application_id {
        return Err("服务必须归属于该环境所在的应用".to_string());
    }
    validate::validate_service_unit(&unit, Some(&environment.deploy_root))
        .map_err(|error| error.to_string())?;
    if let Some(artifact_id) = unit.artifact_id.as_deref() {
        if !artifact_id.trim().is_empty()
            && db::get_artifact(&conn, artifact_id)
                .map_err(|error| error.to_string())?
                .is_none()
        {
            return Err("所选制品不存在，请重新选择".to_string());
        }
    }
    db::upsert_service_unit(&conn, &unit).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_service_unit_save",
        Some(&environment.server_id),
        None,
        &format!("{{\"id\":\"{}\",\"name\":\"{}\"}}", unit.id, unit.name),
    );
    Ok(unit)
}

#[tauri::command]
pub async fn deployment_service_unit_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<i64, String> {
    let conn = open_db(&state)?;
    let relations =
        db::delete_service_unit_cascade(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_service_unit_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\",\"relations_removed\":{relations}}}"),
    );
    Ok(relations)
}

/// 把 P3.8 的已确认项目关联到这个服务（`project_id` 可空 = 只记路径）。
#[tauri::command]
pub async fn deployment_service_unit_link_project(
    state: State<'_, AppState>,
    unit_id: String,
    project_id: Option<String>,
    project_path: String,
) -> Result<ServiceUnit, String> {
    let conn = open_db(&state)?;
    let unit = db::get_service_unit(&conn, &unit_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "服务不存在".to_string())?;
    let path = project_path.trim();
    if path.is_empty() {
        return Err("项目路径不能为空".to_string());
    }
    let project_id = project_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    db::link_service_confirmed_project(&conn, &unit_id, project_id.as_deref(), path)
        .map_err(|error| error.to_string())?;
    let updated = db::get_service_unit(&conn, &unit_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "服务不存在".to_string())?;
    record_audit(
        &state,
        "deployment_service_unit_link_project",
        None,
        None,
        &format!(
            "{{\"unit\":\"{}\",\"path\":\"{}\"}}",
            unit.name,
            path.replace('"', "")
        ),
    );
    Ok(updated)
}

#[tauri::command]
pub async fn deployment_service_unit_unlink_project(
    state: State<'_, AppState>,
    unit_id: String,
) -> Result<ServiceUnit, String> {
    let conn = open_db(&state)?;
    db::unlink_service_confirmed_project(&conn, &unit_id).map_err(|error| error.to_string())?;
    let updated = db::get_service_unit(&conn, &unit_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "服务不存在".to_string())?;
    record_audit(
        &state,
        "deployment_service_unit_unlink_project",
        None,
        None,
        &format!("{{\"unit\":\"{}\"}}", updated.name),
    );
    Ok(updated)
}

/// 反查：某个已确认项目被哪些服务引用（项目视图里显示"已用于部署"）。
#[tauri::command]
pub async fn deployment_service_units_for_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<String>, String> {
    let conn = open_db(&state)?;
    db::service_units_for_confirmed_project(&conn, &project_id).map_err(|error| error.to_string())
}

// -- 服务关系 ---------------------------------------------------------------

#[tauri::command]
pub async fn deployment_service_relation_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
) -> Result<Vec<ServiceRelation>, String> {
    let conn = open_db(&state)?;
    db::list_service_relations(&conn, application_id.as_deref()).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_service_relation_save(
    state: State<'_, AppState>,
    relation: ServiceRelation,
) -> Result<ServiceRelation, String> {
    let conn = open_db(&state)?;
    let mut relation = relation;
    stamp(
        &mut relation.id,
        &mut relation.created_at,
        &mut relation.updated_at,
    );
    validate::validate_relation(&relation).map_err(|error| error.to_string())?;
    // 两端必须是同一个应用里的服务 —— 跨应用依赖是另一回事，别混进来。
    for service_id in [&relation.from_service_id, &relation.to_service_id] {
        let unit = db::get_service_unit(&conn, service_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "关系里引用的服务不存在".to_string())?;
        if unit.application_id != relation.application_id {
            return Err("只能连接同一个应用里的服务".to_string());
        }
    }
    db::upsert_service_relation(&conn, &relation).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_service_relation_save",
        None,
        None,
        &format!("{{\"id\":\"{}\"}}", relation.id),
    );
    Ok(relation)
}

#[tauri::command]
pub async fn deployment_service_relation_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    db::delete_service_relation(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_service_relation_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\"}}"),
    );
    Ok(())
}

// -- 容量画像 ---------------------------------------------------------------

#[tauri::command]
pub async fn deployment_capacity_get(
    state: State<'_, AppState>,
    environment_id: String,
) -> Result<Option<CapacityProfile>, String> {
    let conn = open_db(&state)?;
    db::get_capacity_profile(&conn, &environment_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_capacity_save(
    state: State<'_, AppState>,
    profile: CapacityProfile,
) -> Result<CapacityProfile, String> {
    let conn = open_db(&state)?;
    let mut profile = profile;
    stamp(
        &mut profile.id,
        &mut profile.created_at,
        &mut profile.updated_at,
    );
    validate::validate_capacity(&profile).map_err(|error| error.to_string())?;
    let environment = require_environment(&conn, &profile.environment_id)?;
    db::upsert_capacity_profile(&conn, &profile).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_capacity_save",
        Some(&environment.server_id),
        None,
        &format!(
            "{{\"environment\":\"{}\",\"basis\":\"{:?}\"}}",
            environment.name, profile.estimation_basis
        ),
    );
    Ok(profile)
}

// -- 域名绑定 ---------------------------------------------------------------

#[tauri::command]
pub async fn deployment_domain_list(
    state: State<'_, AppState>,
    environment_id: Option<String>,
) -> Result<Vec<DomainBinding>, String> {
    let conn = open_db(&state)?;
    db::list_domain_bindings(&conn, environment_id.as_deref()).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_domain_save(
    state: State<'_, AppState>,
    binding: DomainBinding,
) -> Result<DomainBinding, String> {
    let conn = open_db(&state)?;
    let mut binding = binding;
    stamp(
        &mut binding.id,
        &mut binding.created_at,
        &mut binding.updated_at,
    );
    validate::validate_domain_binding(&binding, None).map_err(|error| error.to_string())?;
    require_environment(&conn, &binding.environment_id)?;
    if let Some(service_id) = binding.service_unit_id.as_deref() {
        if !service_id.trim().is_empty() {
            let unit = db::get_service_unit(&conn, service_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "所选服务不存在".to_string())?;
            if unit.environment_id != binding.environment_id {
                return Err("域名绑定的服务必须属于同一个环境".to_string());
            }
        }
    }
    db::upsert_domain_binding(&conn, &binding).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_domain_save",
        None,
        None,
        &format!(
            "{{\"id\":\"{}\",\"domain\":\"{}\"}}",
            binding.id, binding.domain
        ),
    );
    Ok(binding)
}

#[tauri::command]
pub async fn deployment_domain_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    db::delete_domain_binding(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_domain_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\"}}"),
    );
    Ok(())
}

// -- 配置定义 ---------------------------------------------------------------

#[tauri::command]
pub async fn deployment_config_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
) -> Result<Vec<ConfigDefinition>, String> {
    let conn = open_db(&state)?;
    db::list_config_definitions(&conn, application_id.as_deref()).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_config_save(
    state: State<'_, AppState>,
    config: ConfigDefinition,
) -> Result<ConfigDefinition, String> {
    let conn = open_db(&state)?;
    let mut config = config;
    stamp(
        &mut config.id,
        &mut config.created_at,
        &mut config.updated_at,
    );
    validate::validate_config(&config).map_err(|error| error.to_string())?;
    require_application(&conn, &config.application_id)?;
    // 密钥类配置引用的 SecretRef 必须真实存在。
    if let (true, Some(reference)) = (config.secret, config.source_ref.as_deref()) {
        if db::get_secret_ref(&conn, reference)
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Err("所引用的密钥不存在，请先在密钥列表里创建".to_string());
        }
    }
    db::upsert_config_definition(&conn, &config).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_config_save",
        None,
        None,
        &format!("{{\"id\":\"{}\",\"key\":\"{}\"}}", config.id, config.key),
    );
    Ok(config)
}

#[tauri::command]
pub async fn deployment_config_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    db::delete_config_definition(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_config_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\"}}"),
    );
    Ok(())
}

// -- 密钥引用 ---------------------------------------------------------------

#[tauri::command]
pub async fn deployment_secret_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
) -> Result<Vec<SecretRef>, String> {
    let conn = open_db(&state)?;
    db::list_secret_refs(&conn, application_id.as_deref()).map_err(|error| error.to_string())
}

/// 保存密钥**引用**。这里从不接收、也不存密钥本体：
/// Keyring 方式只记账户名（明文用 `credential_save` 那套写进系统 Keyring），
/// 运行时文件方式只记路径模板。
#[tauri::command]
pub async fn deployment_secret_save(
    state: State<'_, AppState>,
    reference: SecretRef,
) -> Result<SecretRef, String> {
    let conn = open_db(&state)?;
    let mut reference = reference;
    stamp(
        &mut reference.id,
        &mut reference.created_at,
        &mut reference.updated_at,
    );
    validate::validate_secret_ref(&reference).map_err(|error| error.to_string())?;
    if let Some(application_id) = reference.application_id.as_deref() {
        if !application_id.trim().is_empty() {
            require_application(&conn, application_id)?;
        }
    }
    db::upsert_secret_ref(&conn, &reference).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_secret_save",
        None,
        None,
        &format!(
            "{{\"id\":\"{}\",\"name\":\"{}\",\"store\":\"{:?}\"}}",
            reference.id, reference.name, reference.store_kind
        ),
    );
    Ok(reference)
}

#[tauri::command]
pub async fn deployment_secret_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    db::delete_secret_ref(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_secret_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\"}}"),
    );
    Ok(())
}

// -- 制品元数据 -------------------------------------------------------------

#[tauri::command]
pub async fn deployment_artifact_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
    service_unit_id: Option<String>,
) -> Result<Vec<ArtifactRecord>, String> {
    let conn = open_db(&state)?;
    db::list_artifacts(&conn, application_id.as_deref(), service_unit_id.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_artifact_save(
    state: State<'_, AppState>,
    artifact: ArtifactRecord,
) -> Result<ArtifactRecord, String> {
    let conn = open_db(&state)?;
    let mut artifact = artifact;
    stamp(
        &mut artifact.id,
        &mut artifact.created_at,
        &mut artifact.updated_at,
    );
    validate::validate_artifact(&artifact).map_err(|error| error.to_string())?;
    require_application(&conn, &artifact.application_id)?;
    db::upsert_artifact(&conn, &artifact).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_artifact_save",
        None,
        None,
        &format!(
            "{{\"id\":\"{}\",\"kind\":\"{:?}\"}}",
            artifact.id, artifact.kind
        ),
    );
    Ok(artifact)
}

#[tauri::command]
pub async fn deployment_artifact_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    db::delete_artifact(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_artifact_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\"}}"),
    );
    Ok(())
}

// -- 方案（图） -------------------------------------------------------------

#[tauri::command]
pub async fn deployment_plan_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
    environment_id: Option<String>,
) -> Result<Vec<DeploymentPlan>, String> {
    let conn = open_db(&state)?;
    db::list_plans(&conn, application_id.as_deref(), environment_id.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_plan_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DeploymentPlanGraph>, String> {
    let conn = open_db(&state)?;
    db::get_plan_graph(&conn, &id).map_err(|error| error.to_string())
}

/// 保存整个方案图。校验顺序：实体合法性 → 图合法性（唯一 key / 无自环 /
/// 无重复边 / 无环 / 风险与审批不可下调）→ 事务写入。
#[tauri::command]
pub async fn deployment_plan_save(
    state: State<'_, AppState>,
    graph: DeploymentPlanGraph,
) -> Result<DeploymentPlanGraph, String> {
    let conn = open_db(&state)?;
    let mut graph = graph;
    stamp(
        &mut graph.plan.id,
        &mut graph.plan.created_at,
        &mut graph.plan.updated_at,
    );
    for node in graph.nodes.iter_mut() {
        let mut id = node.id.clone();
        let mut created_at = node.created_at;
        let mut updated_at = node.updated_at;
        stamp(&mut id, &mut created_at, &mut updated_at);
        node.id = id;
        node.created_at = created_at;
        node.updated_at = updated_at;
        node.plan_id = graph.plan.id.clone();
    }
    for edge in graph.edges.iter_mut() {
        if edge.id.trim().is_empty() {
            edge.id = uuid::Uuid::new_v4().to_string();
        }
        if edge.created_at <= 0 {
            edge.created_at = db::AppDb::now();
        }
        edge.plan_id = graph.plan.id.clone();
    }

    let environment = require_environment(&conn, &graph.plan.environment_id)?;
    if environment.application_id != graph.plan.application_id {
        return Err("方案必须归属于该环境的所在应用".to_string());
    }
    for node in &graph.nodes {
        if let Some(service_id) = node.service_unit_id.as_deref() {
            if !service_id.trim().is_empty() {
                let unit = db::get_service_unit(&conn, service_id)
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| format!("节点 {} 引用的服务不存在", node.node_key))?;
                if unit.environment_id != graph.plan.environment_id {
                    return Err(format!("节点 {} 引用的服务不属于该环境", node.node_key));
                }
            }
        }
    }
    validate::validate_plan_graph(&graph).map_err(|error| error.to_string())?;
    db::upsert_plan_graph(&conn, &graph).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_plan_save",
        Some(&environment.server_id),
        None,
        &format!(
            "{{\"id\":\"{}\",\"name\":\"{}\",\"version\":{},\"nodes\":{},\"edges\":{}}}",
            graph.plan.id,
            graph.plan.name,
            graph.plan.version,
            graph.nodes.len(),
            graph.edges.len()
        ),
    );
    db::get_plan_graph(&conn, &graph.plan.id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "方案保存后读取失败".to_string())
}

#[tauri::command]
pub async fn deployment_plan_delete(state: State<'_, AppState>, id: String) -> Result<i64, String> {
    let conn = open_db(&state)?;
    let runs = db::delete_plan_cascade(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_plan_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\",\"runs_removed\":{runs}}}"),
    );
    Ok(runs)
}

// -- 运行（只读：P5.0 不执行部署） -------------------------------------------

#[tauri::command]
pub async fn deployment_run_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
    plan_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<DeploymentRun>, String> {
    let conn = open_db(&state)?;
    db::list_runs(
        &conn,
        application_id.as_deref(),
        plan_id.as_deref(),
        limit.unwrap_or(50).min(500) as i64,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_run_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DeploymentRunDetail>, String> {
    let conn = open_db(&state)?;
    let Some(run) = db::get_run(&conn, &id).map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let nodes = db::list_run_nodes(&conn, &id).map_err(|error| error.to_string())?;
    Ok(Some(DeploymentRunDetail { run, nodes }))
}

// -- 版本 -------------------------------------------------------------------

#[tauri::command]
pub async fn deployment_release_list(
    state: State<'_, AppState>,
    environment_id: Option<String>,
    service_unit_id: Option<String>,
) -> Result<Vec<ReleaseRecord>, String> {
    let conn = open_db(&state)?;
    db::list_releases(&conn, environment_id.as_deref(), service_unit_id.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_release_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ReleaseRecord>, String> {
    let conn = open_db(&state)?;
    db::get_release(&conn, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_release_save(
    state: State<'_, AppState>,
    release: ReleaseRecord,
) -> Result<ReleaseRecord, String> {
    let conn = open_db(&state)?;
    let mut release = release;
    stamp(
        &mut release.id,
        &mut release.created_at,
        &mut release.updated_at,
    );
    validate::validate_release(&release).map_err(|error| error.to_string())?;
    require_environment(&conn, &release.environment_id)?;
    db::upsert_release(&conn, &release).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_release_save",
        None,
        None,
        &format!(
            "{{\"id\":\"{}\",\"version\":\"{}\",\"active\":{}}}",
            release.id, release.version_label, release.is_active
        ),
    );
    Ok(release)
}

#[tauri::command]
pub async fn deployment_release_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    db::delete_release(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_release_delete",
        None,
        None,
        &format!("{{\"id\":\"{id}\"}}"),
    );
    Ok(())
}

#[tauri::command]
pub async fn deployment_release_active(
    state: State<'_, AppState>,
    service_unit_id: String,
) -> Result<Option<ReleaseRecord>, String> {
    let conn = open_db(&state)?;
    db::active_release(&conn, &service_unit_id).map_err(|error| error.to_string())
}

// ===========================================================================
// P5.1 制品导入与多服务识别
// ===========================================================================
//
// 边界与 P5.0 完全一致：**只读写自己的 SQLite 与本地文件**。
// 唯一的远程动作是"读取服务器已有目录的清单"与"上传制品"，两者都走既有的
// SFTP 设施，且都不执行任何上传内容（见 `deployment::artifact` 的模块文档）。

/// 导入任务进度事件名。前端按 task id 订阅。
pub fn artifact_import_event(task_id: &str) -> String {
    format!("deployment-artifact-import-{task_id}")
}

/// 发起一次导入。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactImportStartRequest {
    pub application_id: String,
    /// 目标服务（可空 = 由识别结果决定，多服务时通常为空）。
    pub service_unit_id: Option<String>,
    pub source: ImportSource,
    /// 服务器目录来源必填：已连接的 SSH 会话 id。
    pub session_id: Option<String>,
}

fn persist_task(db: &db::AppDb, task: &ArtifactImportTask) {
    if let Ok(conn) = db.open() {
        let _ = db::upsert_import_task(&conn, task);
    }
}

#[tauri::command]
pub async fn deployment_artifact_import_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ArtifactImportStartRequest,
) -> Result<ArtifactImportTask, String> {
    {
        // 连接不能跨 await 持有（rusqlite 的 Connection 不是 Send）。
        let conn = open_db(&state)?;
        require_application(&conn, &request.application_id)?;
        if let Some(unit_id) = request.service_unit_id.as_deref() {
            if !unit_id.trim().is_empty() {
                db::get_service_unit(&conn, unit_id)
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "所选服务不存在".to_string())?;
            }
        }
    }
    if let ImportSource::DockerImageRef { reference } = &request.source {
        crate::safe::validate_image(reference.trim()).map_err(|error| error.to_string())?;
    }

    // 来源准备：远程目录的清单必须先用 SFTP 读（异步），然后再进同步流水线。
    let prepared = match &request.source {
        ImportSource::RemoteDirectory { path, .. } => {
            let session_id = request
                .session_id
                .clone()
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "读取服务器目录需要已连接的 SSH 会话".to_string())?;
            if !state.ssh.is_connected(&session_id).await {
                return Err("SSH 会话不存在或已断开，请先连接服务器".to_string());
            }
            let entries = remote::list_remote_tree(
                &state.ssh,
                &session_id,
                path,
                crate::deployment::artifact::limits::MAX_ENTRIES,
                crate::deployment::artifact::limits::MAX_DEPTH,
            )
            .await?;
            tasks::prepare_remote(entries)
        }
        other => tasks::prepare_local(other)?,
    };

    let mut task = ArtifactImportTask::new(
        uuid::Uuid::new_v4().to_string(),
        request.source.clone(),
        Some(request.application_id.clone()),
        tasks::now_ms(),
    );
    task.service_unit_id = request
        .service_unit_id
        .clone()
        .filter(|id| !id.trim().is_empty());
    task.status = ImportStatus::Running;

    let cancel = state.artifact_imports.insert(task.clone());
    let registry = state.artifact_imports.clone();
    let db = state.db.clone();
    let task_id = task.id.clone();
    let event = artifact_import_event(&task_id);
    let listener: tasks::TaskListener = {
        let app = app.clone();
        Arc::new(move |task: &ArtifactImportTask| {
            let _ = app.emit(&event, task);
            // 只在终态落库：中间进度没有持久化价值。
            if task.status != ImportStatus::Running {
                persist_task(&db, task);
            }
        })
    };
    let running = task.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tasks::run(running, prepared, registry, cancel, Some(listener));
    });
    Ok(task)
}

#[tauri::command]
pub async fn deployment_artifact_import_status(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<Option<ArtifactImportTask>, String> {
    if let Some(task) = state.artifact_imports.snapshot(&task_id) {
        return Ok(Some(task));
    }
    let conn = open_db(&state)?;
    db::get_import_task(&conn, &task_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_artifact_import_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
) -> Result<Vec<ArtifactImportTask>, String> {
    // 内存里的任务比库里新（正在跑的还没落库），合并时以内存为准。
    let mut merged = match application_id.as_deref() {
        Some(application) => state.artifact_imports.list_for_application(application),
        None => Vec::new(),
    };
    let known: HashSet<String> = merged.iter().map(|task| task.id.clone()).collect();
    {
        let conn = open_db(&state)?;
        let stored = db::list_import_tasks(&conn, application_id.as_deref(), 100)
            .map_err(|error| error.to_string())?;
        for task in stored {
            if !known.contains(&task.id) {
                merged.push(task);
            }
        }
    }
    merged.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(merged)
}

#[tauri::command]
pub async fn deployment_artifact_import_cancel(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<bool, String> {
    Ok(state.artifact_imports.cancel(&task_id))
}

#[tauri::command]
pub async fn deployment_artifact_import_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<ArtifactImportTask, String> {
    let previous = state
        .artifact_imports
        .snapshot(&task_id)
        .ok_or_else(|| "导入任务不存在（应用可能已重启）".to_string())?;
    if matches!(previous.source, ImportSource::RemoteDirectory { .. }) {
        return Err("服务器目录来源需要重新发起导入（重试需要已连接的 SSH 会话）".to_string());
    }
    // 先准备来源，再改状态 —— 准备失败时任务不该被留在"运行中"。
    let prepared = tasks::prepare_local(&previous.source)?;
    let (task, cancel) = state.artifact_imports.prepare_retry(&task_id)?;

    let registry = state.artifact_imports.clone();
    let db = state.db.clone();
    let event = artifact_import_event(&task_id);
    let listener: tasks::TaskListener = {
        let app = app.clone();
        Arc::new(move |task: &ArtifactImportTask| {
            let _ = app.emit(&event, task);
            if task.status != ImportStatus::Running {
                persist_task(&db, task);
            }
        })
    };
    let running = task.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tasks::run(running, prepared, registry, cancel, Some(listener));
    });
    Ok(task)
}

/// 把候选里的**相对**路径补成绝对路径（`deploy_root` 来自环境）。
fn absolute_under(root: &str, relative: &str) -> String {
    let root = root.trim_end_matches('/');
    let relative = relative.trim().trim_start_matches('/');
    if relative.is_empty() {
        root.to_string()
    } else {
        format!("{root}/{relative}")
    }
}

/// 识别阶段产出的运行方式里，路径是相对占位（`/dist`）。
/// 确认时按环境的部署根目录补全；`node` / `python3` 这类"命令名"保持原样。
fn absolute_runtime(runtime: ServiceRuntime, deploy_root: &str, sub_path: &str) -> ServiceRuntime {
    match runtime {
        ServiceRuntime::StaticNginx { site_name, .. } => ServiceRuntime::StaticNginx {
            site_name,
            root: absolute_under(deploy_root, sub_path),
        },
        ServiceRuntime::NativeProcess { entry, args } => {
            let entry = if entry.starts_with('/') {
                absolute_under(deploy_root, &entry)
            } else {
                entry
            };
            ServiceRuntime::NativeProcess { entry, args }
        }
        ServiceRuntime::DockerCompose {
            compose_path,
            project_name,
            service,
        } => ServiceRuntime::DockerCompose {
            compose_path: absolute_under(deploy_root, &compose_path),
            project_name,
            service,
        },
        other => other,
    }
}

fn artifact_source_ref(source: &ImportSource) -> String {
    // 规则只有一处：`ImportSource::source_ref()`。这里只负责转成 owned 值，
    // 因为同一个值会被写入多条制品记录。
    source.source_ref().to_string()
}

fn artifact_file_name(source: &ImportSource) -> Option<String> {
    match source {
        ImportSource::LocalArchive { path } | ImportSource::LocalFile { path, .. } => {
            Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        }
        _ => None,
    }
}

/// 确认导入：把识别结果落成**一个应用下的多个服务 + 各自独立的制品**。
#[tauri::command]
pub async fn deployment_artifact_import_confirm(
    state: State<'_, AppState>,
    confirmation: ArtifactImportConfirmation,
) -> Result<ArtifactConfirmOutcome, String> {
    let task = match state.artifact_imports.snapshot(&confirmation.task_id) {
        Some(task) => task,
        None => {
            let conn = open_db(&state)?;
            db::get_import_task(&conn, &confirmation.task_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "导入任务不存在（应用可能已重启，请重新导入）".to_string())?
        }
    };
    if task.application_id.as_deref() != Some(confirmation.application_id.as_str()) {
        return Err("导入任务与目标应用不一致".to_string());
    }
    if !task.is_confirmable() {
        return Err("本次导入存在阻断项或尚未分析完成，不能确认".to_string());
    }
    let inspection = task
        .inspection
        .clone()
        .ok_or_else(|| "识别结果还没生成，请等待分析完成".to_string())?;
    let fingerprint = task
        .fingerprint
        .clone()
        .ok_or_else(|| "制品指纹还没算出来，请等待分析完成".to_string())?;

    // 复核内容指纹：确认之前用户可能又改了本地文件，那样分析就失效了。
    if let Some(fresh) = tasks::revalidate(&task)? {
        if fingerprint.differs_from(&fresh) {
            return Err("制品内容已变化，识别结果已失效，请重新发起导入".to_string());
        }
    }

    let mut conn = open_db(&state)?;
    let environment = require_environment(&conn, &confirmation.environment_id)?;
    if environment.application_id != confirmation.application_id {
        return Err("环境不属于该应用".to_string());
    }
    let deploy_root = environment.deploy_root.clone();

    let selected: Vec<ServiceCandidate> = inspection
        .services
        .iter()
        .filter(|candidate| {
            confirmation
                .selected_service_ids
                .iter()
                .any(|id| id == &candidate.id)
        })
        .cloned()
        .collect();
    if !confirmation.selected_service_ids.is_empty()
        && selected.len() != confirmation.selected_service_ids.len()
    {
        return Err("有选中的服务候选在识别结果里找不到（请重新分析）".to_string());
    }

    let version_label = confirmation
        .version_label
        .clone()
        .filter(|label| !label.trim().is_empty())
        .unwrap_or_else(|| fingerprint.sha256.chars().take(12).collect::<String>());
    let source_kind = tasks::source_kind_of(&task.source);
    let base_source_ref = artifact_source_ref(&task.source);
    let file_name = artifact_file_name(&task.source);
    let now = db::AppDb::now();

    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let mut artifacts: Vec<ArtifactRecord> = Vec::new();
    let mut services: Vec<ServiceUnit> = Vec::new();

    let mut build_artifact =
        |unit_id: Option<String>, kind: ArtifactKind, sub_path: &str| -> ArtifactRecord {
            let mut notes = task.display_name.clone();
            if !sub_path.trim().is_empty() {
                notes = format!("{notes} · sub-path: {sub_path}");
            }
            ArtifactRecord {
                id: uuid::Uuid::new_v4().to_string(),
                application_id: confirmation.application_id.clone(),
                service_unit_id: unit_id,
                kind,
                source_kind,
                source_ref: base_source_ref.clone(),
                file_name: file_name.clone(),
                size_bytes: Some(fingerprint.size_bytes.min(i64::MAX as u64) as i64),
                sha256: Some(fingerprint.sha256.clone()),
                docker_digest: None,
                version_label: Some(version_label.clone()),
                built_at: fingerprint.newest_mtime_ms,
                checksum_verified: false,
                status: ArtifactStatus::Ready,
                notes,
                created_at: now,
                updated_at: now,
            }
        };

    if selected.is_empty() {
        // 只登记制品、不建服务。
        let artifact = build_artifact(None, inspection.artifact_kind, "");
        validate::validate_artifact(&artifact).map_err(|error| error.to_string())?;
        db::upsert_artifact(&transaction, &artifact).map_err(|error| error.to_string())?;
        artifacts.push(artifact);
    } else {
        for candidate in &selected {
            let unit_id = uuid::Uuid::new_v4().to_string();
            let mut artifact = build_artifact(
                Some(unit_id.clone()),
                candidate.artifact_kind,
                &candidate.source_path,
            );
            validate::validate_artifact(&artifact).map_err(|error| error.to_string())?;

            let unit = ServiceUnit {
                id: unit_id,
                application_id: confirmation.application_id.clone(),
                environment_id: confirmation.environment_id.clone(),
                name: candidate.name.clone(),
                role: candidate.role,
                service_kind: candidate.service_kind,
                runtime: absolute_runtime(
                    candidate.runtime.clone(),
                    &deploy_root,
                    &candidate.source_path,
                ),
                deploy_path: Some(absolute_under(&deploy_root, &candidate.source_path)),
                confirmed_project_id: None,
                confirmed_project_path: None,
                artifact_id: Some(artifact.id.clone()),
                status: "configured".to_string(),
                notes: format!(
                    "Imported from {} (confidence {})",
                    task.display_name, candidate.confidence
                ),
                created_at: now,
                updated_at: now,
            };
            validate::validate_service_unit(&unit, Some(&deploy_root))
                .map_err(|error| error.to_string())?;

            db::upsert_artifact(&transaction, &artifact).map_err(|error| error.to_string())?;
            db::upsert_service_unit(&transaction, &unit).map_err(|error| error.to_string())?;
            artifacts.push(artifact);
            services.push(unit);
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;

    if let Some(first) = artifacts.first() {
        let conn = open_db(&state)?;
        db::mark_import_task_confirmed(&conn, &confirmation.task_id, &first.id, now)
            .map_err(|error| error.to_string())?;
    }
    // 内存里的任务同步标记成已完成，避免用户再次确认时重复建服务。
    state
        .artifact_imports
        .update(&confirmation.task_id, |task| {
            task.stage = ImportStage::Done;
            task.artifact_id = artifacts.first().map(|artifact| artifact.id.clone());
            task.updated_at = now;
        });

    let server_id = environment.server_id.clone();
    record_audit(
        &state,
        "deployment_artifact_import_confirm",
        Some(&server_id),
        None,
        &format!(
            "{{\"task\":\"{}\",\"artifacts\":{},\"services\":{}}}",
            confirmation.task_id,
            artifacts.len(),
            services.len()
        ),
    );
    Ok(ArtifactConfirmOutcome {
        artifacts,
        services,
    })
}

/// 删除一条导入任务记录（不删制品）。
#[tauri::command]
pub async fn deployment_artifact_import_delete(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), String> {
    {
        let conn = open_db(&state)?;
        db::delete_import_task(&conn, &task_id).map_err(|error| error.to_string())?;
    }
    state.artifact_imports.remove(&task_id);
    Ok(())
}

/// 上传一个制品到服务器：`.part` → 流式 → 哈希校验 → 原子改名。
///
/// 上传成功后制品就"在服务器上"了 —— `source_kind` 改成
/// `server_existing_dir`、`source_ref` 指向落地路径，后续阶段的编译器就能
/// 直接引用它，不需要再记一个平行字段。
#[tauri::command]
pub async fn deployment_artifact_upload(
    state: State<'_, AppState>,
    artifact_id: String,
    session_id: String,
    remote_dir: String,
) -> Result<ArtifactRecord, String> {
    let mut artifact = {
        let conn = open_db(&state)?;
        db::get_artifact(&conn, &artifact_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "制品不存在".to_string())?
    };
    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".to_string());
    }
    if artifact.kind == ArtifactKind::DockerImage {
        return Err("镜像制品不需要上传：服务器会从仓库拉取".to_string());
    }
    let local = Path::new(&artifact.source_ref);
    if !local.exists() {
        return Err("制品来源在本机已不存在，请重新导入".to_string());
    }

    let progress = |_done: u64, _total: u64| {};
    let now = db::AppDb::now();

    if local.is_file() {
        let file_name = artifact
            .file_name
            .clone()
            .or_else(|| {
                local
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string)
            })
            .ok_or_else(|| "无法确定上传文件名".to_string())?;
        let outcome = remote::upload_artifact(
            &state.ssh,
            &session_id,
            local,
            &remote_dir,
            &file_name,
            artifact.sha256.as_deref(),
            &progress,
        )
        .await?;
        artifact.source_ref = outcome.remote_path;
        artifact.source_kind = ArtifactSourceKind::ServerExistingDir;
        artifact.size_bytes = Some(outcome.size_bytes.min(i64::MAX as u64) as i64);
        artifact.checksum_verified = true;
        artifact.notes = format!("{} · uploaded to {}", artifact.notes, artifact.source_ref);
    } else {
        // 目录：走既有的递归上传。逐个文件没有事务语义，因此**不谎称已校验**。
        let uploaded = state
            .ssh
            .sftp_upload(
                &session_id,
                &[artifact.source_ref.clone()],
                &remote_dir,
                &|_| {},
            )
            .await
            .map_err(|error| error.to_string())?;
        let name = local
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("artifact");
        artifact.source_ref = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
        artifact.source_kind = ArtifactSourceKind::ServerExistingDir;
        artifact.checksum_verified = false;
        artifact.notes = format!(
            "{} · uploaded {} file(s); per-file checksums are not verified for folders",
            artifact.notes,
            uploaded.len()
        );
    }
    artifact.status = ArtifactStatus::Uploaded;
    artifact.updated_at = now;
    validate::validate_artifact(&artifact).map_err(|error| error.to_string())?;

    {
        let conn = open_db(&state)?;
        db::upsert_artifact(&conn, &artifact).map_err(|error| error.to_string())?;
    }
    record_audit(
        &state,
        "deployment_artifact_upload",
        None,
        None,
        &format!(
            "{{\"artifact\":\"{}\",\"verified\":{}}}",
            artifact.id, artifact.checksum_verified
        ),
    );
    Ok(artifact)
}
