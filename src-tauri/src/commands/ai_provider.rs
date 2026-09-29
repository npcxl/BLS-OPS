//! P5.5 AI 提供方 IPC。
//!
//! # 密钥的处理（只有这里是入口）
//!
//! ```text
//! 前端（只有 has_api_key 布尔值）
//!   → ai_provider_save(api_key: Option<String>）
//!   → Rust：立刻写进系统钥匙串，随后**只**把账户名存进 SQLite
//!   → 之后任何读密钥都发生在 Rust 内部（连接测试、AI 复核）
//! ```
//!
//! * 没有"读取 API Key"的 IPC —— 前端拿不到原 Key，因此也就泄露不了；
//! * `api_key` 为 `None` / 空串 = **保留原密钥**（前端不回显，改配置不必重填）；
//! * 删除时可以要求同步删除钥匙串条目（`delete_secret`），由用户显式决定；
//! * 审计只记 id 与事件，**绝不记**密钥或请求头。

use tauri::State;

use crate::db::{self, AppDb};
use crate::deployment::ai::model::{
    AiProviderConfig, AiProviderSaveRequest, AiProviderTestResult, AiProviderView,
};
use crate::deployment::ai::url;
use crate::deployment::ai::OpenAiCompatibleAdvisor;
use crate::state::AppState;

use super::record_audit;

fn view(config: &AiProviderConfig) -> AiProviderView {
    AiProviderView::from_config(config, db::has_api_key(config))
}

#[tauri::command]
pub async fn ai_provider_list(state: State<'_, AppState>) -> Result<Vec<AiProviderView>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    let providers = db::list_providers(&conn).map_err(|error| error.to_string())?;
    Ok(providers.iter().map(view).collect())
}

#[tauri::command]
pub async fn ai_provider_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<AiProviderView>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    Ok(db::get_provider(&conn, &id)
        .map_err(|error| error.to_string())?
        .as_ref()
        .map(view))
}

/// 保存（新建或更新）。
///
/// **明文密钥的生命周期只到这个函数结束**：写完钥匙串之后，
/// 我们只保留账户名 `ai-provider:<id>`。
#[tauri::command]
pub async fn ai_provider_save(
    state: State<'_, AppState>,
    request: AiProviderSaveRequest,
) -> Result<AiProviderView, String> {
    let now = AppDb::now();
    let conn = state.db.open().map_err(|error| error.to_string())?;

    let id = request
        .id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let existing = db::get_provider(&conn, &id).map_err(|error| error.to_string())?;

    // Base URL 是**唯一能让请求跑到别处去**的配置，先过一遍严格校验。
    let base_url = url::validate_base_url(
        &request.base_url,
        url::BaseUrlPolicy {
            allow_insecure_http: request.allow_insecure_http,
        },
    )
    .map_err(|error| error.user_message())?;
    if request.name.trim().is_empty() {
        return Err("提供方名称不能为空".to_string());
    }
    if request.model.trim().is_empty() {
        return Err("模型名不能为空".to_string());
    }

    let mut config = match existing {
        Some(existing) => AiProviderConfig {
            name: request.name.clone(),
            provider_kind: request.provider_kind,
            base_url,
            model: request.model.clone(),
            enabled: request.enabled,
            is_default: request.is_default,
            allow_insecure_http: request.allow_insecure_http,
            timeout_seconds: request.timeout_seconds,
            max_output_tokens: request.max_output_tokens,
            updated_at: now,
            ..existing
        },
        None => AiProviderConfig {
            id: id.clone(),
            name: request.name.clone(),
            provider_kind: request.provider_kind,
            base_url,
            model: request.model.clone(),
            api_key_ref: None,
            enabled: request.enabled,
            is_default: request.is_default,
            allow_insecure_http: request.allow_insecure_http,
            timeout_seconds: request.timeout_seconds,
            max_output_tokens: request.max_output_tokens,
            created_at: now,
            updated_at: now,
        },
    };

    // ---- 密钥：只在有值时更新钥匙串 ----
    if let Some(api_key) = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        let account = config.keyring_account();
        crate::keyring::save_secret(&account, api_key)
            .map_err(|error| format!("保存 API Key 到系统凭据管理器失败：{error}"))?;
        config.api_key_ref = Some(account);
    } else if config.api_key_ref.is_none() {
        return Err(
            "新建提供方必须填 API Key（它只写进系统凭据管理器，不会存进数据库）".to_string(),
        );
    }

    db::upsert_provider(&conn, &config).map_err(|error| error.to_string())?;
    if config.is_default {
        db::set_default_provider(&conn, &config.id).map_err(|error| error.to_string())?;
    }
    record_audit(
        &state,
        "ai_provider_save",
        None,
        None,
        &format!(
            "{{\"provider\":\"{}\",\"kind\":\"{}\",\"has_key\":true}}",
            config.id,
            config.provider_kind.as_str()
        ),
    );
    Ok(view(&config))
}

/// 删除。`delete_secret` 由用户在界面上显式决定（默认不删，避免误伤）。
#[tauri::command]
pub async fn ai_provider_delete(
    state: State<'_, AppState>,
    id: String,
    delete_secret: bool,
) -> Result<(), String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    let existing = db::get_provider(&conn, &id).map_err(|error| error.to_string())?;
    let account = existing
        .as_ref()
        .map(|config| config.keyring_account())
        .unwrap_or_else(|| format!("ai-provider:{id}"));
    db::delete_provider(&conn, &id).map_err(|error| error.to_string())?;
    if delete_secret {
        // 删不掉也要说清楚：钥匙串条目没清理等于凭据还在本机。
        if let Err(error) = crate::keyring::delete_secret(&account) {
            return Err(format!(
                "配置已删除，但系统凭据管理器里的条目没删掉：{error}"
            ));
        }
    }
    record_audit(
        &state,
        "ai_provider_delete",
        None,
        None,
        &format!("{{\"provider\":\"{id}\",\"deleted_secret\":{delete_secret}}}"),
    );
    Ok(())
}

#[tauri::command]
pub async fn ai_provider_set_default(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::set_default_provider(&conn, &id).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "ai_provider_set_default",
        None,
        None,
        &format!("{{\"provider\":\"{id}\"}}"),
    );
    Ok(())
}

/// 连接测试：**Rust 读钥匙串 → 发最小请求 → 只回状态 / 耗时 / 脱敏错误**。
///
/// 不返回请求头、不返回 Key、不返回原始响应，也不写进任何方案。
#[tauri::command]
pub async fn ai_provider_test(
    state: State<'_, AppState>,
    id: String,
) -> Result<AiProviderTestResult, String> {
    let config = {
        let conn = state.db.open().map_err(|error| error.to_string())?;
        db::get_provider(&conn, &id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "提供方不存在".to_string())?
    };
    let api_key = crate::keyring::read_secret(&config.keyring_account())
        .map_err(|_| "这个提供方还没有保存可用的 API Key".to_string())?;
    let advisor = OpenAiCompatibleAdvisor::new(config, api_key, false)
        .map_err(|error| error.user_message())?;
    let result = advisor.test_connection().await;
    // 审计只记结论，不记任何请求细节。
    record_audit(
        &state,
        "ai_provider_test",
        None,
        None,
        &format!(
            "{{\"provider\":\"{id}\",\"ok\":{},\"code\":\"{}\"}}",
            result.ok,
            result.error_code.clone().unwrap_or_else(|| "-".to_string())
        ),
    );
    Ok(result)
}
