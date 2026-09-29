//! P5.5 用户知识库 IPC。
//!
//! # 版本纪律（在命令层，因为它需要"读旧 + 写新"两步）
//!
//! * 保存：当前内容先**追加为历史版本**，再把当前行改成新版本 —— 旧内容永不覆盖；
//! * 恢复：把某个旧版本的**内容**作为**新版本**写入（版本号继续 +1），
//!   这样"恢复"也是一次可追溯的编辑，而不是把指针拨回去、让历史对不上；
//! * 删除：归档（不参与检索，内容仍在），历史方案里的引用因此不会悬空。
//!
//! # 检索
//!
//! `deployment_knowledge_search_test` 用与 AI 复核**完全相同**的检索函数，
//! 因此"界面上试出来的结果"就是"模型将看到的东西"。
//!
//! 知识内容是**不可信数据**：出现"忽略系统规则""执行以下命令"这类文字时
//! 会打上 `suspicious` 标记，但仍然可用 —— 它只是被引用，不会变成指令。

use tauri::State;

use crate::db::{self, AppDb};
use crate::deployment::knowledge;
use crate::deployment::knowledge::model::{
    KnowledgeBudget, KnowledgeDocument, KnowledgeHit, KnowledgeQueryInput, KnowledgeUsageRecord,
    KnowledgeVersion,
};
use crate::state::AppState;

use super::record_audit;

/// 内容哈希（与 DB 层同一个函数，保证"库里的"和"界面算的"一致）。
fn hash(content: &str) -> String {
    db::hash_content(content)
}

#[tauri::command]
pub async fn deployment_knowledge_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
    environment_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<KnowledgeDocument>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::list_documents(
        &conn,
        application_id.as_deref(),
        environment_id.as_deref(),
        include_archived.unwrap_or(false),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_knowledge_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<KnowledgeDocument>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::get_document(&conn, &id).map_err(|error| error.to_string())
}

/// 保存（产生**新版本**）。
#[tauri::command]
pub async fn deployment_knowledge_save(
    state: State<'_, AppState>,
    document: KnowledgeDocument,
    note: Option<String>,
) -> Result<KnowledgeDocument, String> {
    let now = AppDb::now();
    let conn = state.db.open().map_err(|error| error.to_string())?;

    let id = document.id.trim().to_string();
    if id.is_empty() {
        return Err("知识 id 不能为空".to_string());
    }
    if document.title.trim().is_empty() {
        return Err("标题不能为空".to_string());
    }
    if document.content.trim().is_empty() {
        return Err("内容不能为空".to_string());
    }
    // 作用域与目标的对应关系：环境级必须给环境 id，应用级必须给应用 id。
    match document.scope {
        knowledge::model::KnowledgeScope::Environment if document.environment_id.is_none() => {
            return Err("环境级知识必须指定环境".to_string())
        }
        knowledge::model::KnowledgeScope::Application if document.application_id.is_none() => {
            return Err("应用级知识必须指定应用".to_string())
        }
        _ => {}
    }

    let existing = db::get_document(&conn, &id).map_err(|error| error.to_string())?;
    // 版本号：历史表里最大的那个 + 1（比"当前版本 + 1"更稳，避免历史缺失时撞号）。
    let versions = db::list_versions(&conn, &id).map_err(|error| error.to_string())?;
    let next_version = versions
        .iter()
        .map(|version| version.version)
        .max()
        .unwrap_or(
            existing
                .as_ref()
                .map(|document| document.version)
                .unwrap_or(0),
        )
        .max(1)
        + 1;

    // 1) 旧内容先保证进历史（若之前没记过，这里补上，避免内容丢失）。
    if let Some(previous) = existing.as_ref() {
        let recorded = versions
            .iter()
            .any(|version| version.version == previous.version);
        if !recorded {
            db::append_version(
                &conn,
                &KnowledgeVersion {
                    id: format!("{id}:v{}", previous.version),
                    document_id: id.clone(),
                    version: previous.version,
                    title: previous.title.clone(),
                    content: previous.content.clone(),
                    content_hash: previous.content_hash.clone(),
                    source_type: previous.source_type,
                    note: "（补记：首次进入版本管理）".to_string(),
                    created_at: previous.updated_at,
                },
            )
            .map_err(|error| error.to_string())?;
        }
    }

    // 2) 新内容作为新版本追加。
    let mut saved = document.clone();
    saved.id = id.clone();
    saved.version = next_version;
    saved.content_hash = hash(&document.content);
    saved.updated_at = now;
    if existing.is_none() {
        saved.created_at = now;
    }
    db::append_version(
        &conn,
        &KnowledgeVersion {
            id: format!("{id}:v{next_version}"),
            document_id: id.clone(),
            version: next_version,
            title: saved.title.clone(),
            content: saved.content.clone(),
            content_hash: saved.content_hash.clone(),
            source_type: saved.source_type,
            note: note.clone().unwrap_or_default(),
            created_at: now,
        },
    )
    .map_err(|error| error.to_string())?;
    db::upsert_document(&conn, &saved).map_err(|error| error.to_string())?;

    record_audit(
        &state,
        "deployment_knowledge_save",
        None,
        None,
        &format!(
            "{{\"document\":\"{id}\",\"version\":{next_version},\"scope\":\"{}\"}}",
            saved.scope.as_str()
        ),
    );
    Ok(saved)
}

#[tauri::command]
pub async fn deployment_knowledge_versions(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<KnowledgeVersion>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::list_versions(&conn, &id).map_err(|error| error.to_string())
}

/// 恢复某个历史版本 —— **作为新版本写入**，历史不被改写。
#[tauri::command]
pub async fn deployment_knowledge_restore(
    state: State<'_, AppState>,
    id: String,
    version: i64,
) -> Result<KnowledgeDocument, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    let current = db::get_document(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "知识文档不存在".to_string())?;
    let target = db::get_version(&conn, &id, version)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("没有第 {version} 版"))?;

    let mut restored = current.clone();
    restored.title = target.title.clone();
    restored.content = target.content.clone();
    restored.content_hash = hash(&target.content);
    restored.source_type = target.source_type;
    drop(conn);
    deployment_knowledge_save(state, restored, Some(format!("从第 {version} 版恢复"))).await
}

/// 归档（软删除）：不参与检索，历史引用仍可追溯。
#[tauri::command]
pub async fn deployment_knowledge_archive(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let now = AppDb::now();
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::archive_document(&conn, &id, now).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_knowledge_archive",
        None,
        None,
        &format!("{{\"document\":\"{id}\"}}"),
    );
    Ok(())
}

#[tauri::command]
pub async fn deployment_knowledge_usage(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<KnowledgeUsageRecord>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::usage_by_document(&conn, &id).map_err(|error| error.to_string())
}

/// 检索测试：与 AI 复核用的是同一个函数、同一套预算。
#[tauri::command]
pub async fn deployment_knowledge_search_test(
    state: State<'_, AppState>,
    query: KnowledgeQueryInput,
) -> Result<Vec<KnowledgeHit>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    let documents = db::list_documents(
        &conn,
        query.application_id.as_deref(),
        query.environment_id.as_deref(),
        false,
    )
    .map_err(|error| error.to_string())?;
    let limit = if query.limit == 0 { 8 } else { query.limit };
    let query = KnowledgeQueryInput { limit, ..query };
    Ok(knowledge::search(
        &documents,
        &query,
        KnowledgeBudget::default(),
    ))
}
