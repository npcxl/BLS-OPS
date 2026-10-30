//! P5.6 **用户 Memory** IPC（查看 / 修改 / 停用 / 删除 / 记录部署结果）。
//!
//! # 边界
//!
//! * 所有写入都要过 [`DeploymentMemory::validate`]：受控 key + 按 key 类型校验的
//!   `value_json` + 作用域一致性 —— **安全策略、审批开关、Secret、任意命令
//!   连 key 都不存在**，因此永远进不来；
//! * 置信度与计数由**确定性规则**更新（`explicit_preference` / `observe_choice` /
//!   `record_success` / `record_failure`），AI 只能提候选，不能直接改。

use tauri::State;

use crate::db::{self, AppDb};
use crate::deployment::session::memory::{
    explicit_preference, record_failure, record_success, validate_value, DeploymentMemory,
    MemoryKey, MemoryKind, MemoryScope, MemorySourceType, MemoryStatus,
};
use crate::ops_error::{OpsError, OpsResult};
use crate::state::AppState;

use super::{open_db, record_audit};

/// 写入前统一校验（**唯一写入口**）。
fn validated(mut memory: DeploymentMemory, now: i64) -> Result<DeploymentMemory, String> {
    validate_value(memory.key, &memory.value_json)?;
    if memory.scope.needs_scope_id() && memory.scope_id.as_deref().unwrap_or("").trim().is_empty() {
        return Err(format!("作用域「{}」必须给出具体 id", memory.scope.label()));
    }
    memory.confidence = memory.confidence.min(100);
    memory.updated_at = now;
    Ok(memory)
}

#[tauri::command]
pub async fn deployment_memory_list(
    state: State<'_, AppState>,
    include_inactive: Option<bool>,
) -> OpsResult<Vec<DeploymentMemory>> {
    let conn = open_db(&state)?;
    db::deployment_session::list_memory(&conn, include_inactive.unwrap_or(false))
        .map_err(|error| OpsError::from(error.to_string()))
}

/// 新建 / 更新一条 Memory。
///
/// `explicit = true` 表示"用户明确表达"，会直接生效；否则按观察值累计，
/// **单次选择不会变成全局默认**。
#[tauri::command]
pub async fn deployment_memory_upsert(
    state: State<'_, AppState>,
    id: Option<String>,
    kind: MemoryKind,
    scope: MemoryScope,
    scope_id: Option<String>,
    key: MemoryKey,
    value_json: serde_json::Value,
    explicit: Option<bool>,
) -> OpsResult<DeploymentMemory> {
    let now = AppDb::now();
    let conn = open_db(&state)?;
    let existing = match id.as_deref().filter(|value| !value.trim().is_empty()) {
        Some(id) => db::deployment_session::get_memory(&conn, id).map_err(|e| e.to_string())?,
        None => None,
    };

    let mut memory = match existing {
        Some(mut previous) => {
            previous.kind = kind;
            previous.scope = scope;
            previous.scope_id = scope_id.filter(|value| !value.trim().is_empty());
            previous.key = key;
            previous.value_json = value_json;
            previous.updated_at = now;
            previous
        }
        None => {
            let mut fresh = DeploymentMemory::new(
                id.filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                kind,
                scope,
                scope_id.filter(|value| !value.trim().is_empty()),
                key,
                value_json,
                MemorySourceType::Explicit,
                now,
            );
            fresh
        }
    };
    memory = validated(memory, now)?;
    // "明确表达"才直接生效；否则交给观察规则（单次 = pending）。
    if explicit.unwrap_or(false) {
        memory = explicit_preference(memory, now);
    } else if memory.status == MemoryStatus::Pending && memory.confidence == 0 {
        memory.confidence = 0;
    }

    db::deployment_session::upsert_memory(&conn, &memory).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_memory_upsert",
        None,
        None,
        &format!(
            "{{\"memory\":\"{}\",\"key\":\"{}\",\"status\":\"{}\"}}",
            memory.id,
            memory.key.as_str(),
            memory.status.as_str()
        ),
    );
    Ok(memory)
}

/// 停用 / 启用（不删除，保留审计）。
#[tauri::command]
pub async fn deployment_memory_set_status(
    state: State<'_, AppState>,
    id: String,
    status: MemoryStatus,
) -> OpsResult<DeploymentMemory> {
    let now = AppDb::now();
    let conn = open_db(&state)?;
    let mut memory = db::deployment_session::get_memory(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| OpsError::from("Memory 不存在"))?;
    memory.status = status;
    memory.updated_at = now;
    db::deployment_session::upsert_memory(&conn, &memory).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_memory_set_status",
        None,
        None,
        &format!("{{\"memory\":\"{id}\",\"status\":\"{}\"}}", status.as_str()),
    );
    Ok(memory)
}

/// 删除一条 Memory（用户明确要求时才物理删除）。
#[tauri::command]
pub async fn deployment_memory_delete(
    state: State<'_, AppState>,
    id: String,
) -> OpsResult<()> {
    let conn = open_db(&state)?;
    db::deployment_session::delete_memory(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_memory_delete",
        None,
        None,
        &format!("{{\"memory\":\"{id}\"}}"),
    );
    Ok(())
}

/// 清空：默认**不动生效中的**条目（要一起清必须显式传 `include_active`）。
#[tauri::command]
pub async fn deployment_memory_clear(
    state: State<'_, AppState>,
    include_active: Option<bool>,
) -> OpsResult<usize> {
    let conn = open_db(&state)?;
    let removed = db::deployment_session::clear_memory(&conn, include_active.unwrap_or(false))
        .map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_memory_clear",
        None,
        None,
        &format!("{{\"removed\":{removed}}}"),
    );
    Ok(removed)
}

/// **部署结束后**由会话流程调用：按结果更新计数与置信度（确定性规则）。
#[tauri::command]
pub async fn deployment_memory_record_result(
    state: State<'_, AppState>,
    memory_ids: Vec<String>,
    succeeded: bool,
) -> OpsResult<Vec<DeploymentMemory>> {
    let now = AppDb::now();
    let conn = open_db(&state)?;
    let mut updated = Vec::new();
    for id in memory_ids {
        let Some(mut memory) =
            db::deployment_session::get_memory(&conn, &id).map_err(|e| e.to_string())?
        else {
            continue;
        };
        memory.source_type = MemorySourceType::DeploymentResult;
        memory = if succeeded {
            record_success(memory, now)
        } else {
            record_failure(memory, now)
        };
        db::deployment_session::upsert_memory(&conn, &memory).map_err(|e| e.to_string())?;
        updated.push(memory);
    }
    record_audit(
        &state,
        "deployment_memory_record_result",
        None,
        None,
        &format!("{{\"count\":{},\"succeeded\":{succeeded}}}", updated.len()),
    );
    Ok(updated)
}
