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
use crate::ops_error::{OpsError, OpsResult};

/// 表单校验 / 配置不合法：`config` 阶段。
fn invalid(message: impl Into<String>) -> OpsError {
    OpsError::new("config", message)
}

/// 配置读写（SQLite + 系统钥匙串）：`io` 阶段。
fn store_error(error: impl ToString) -> OpsError {
    OpsError::from_stage("io", error)
}

fn view(config: &AiProviderConfig) -> AiProviderView {
    AiProviderView::from_config(config, db::has_api_key(config))
}

#[tauri::command]
pub async fn ai_provider_list(state: State<'_, AppState>) -> OpsResult<Vec<AiProviderView>> {
    let conn = state.db.open().map_err(store_error)?;
    let providers = db::list_providers(&conn).map_err(store_error)?;
    Ok(providers.iter().map(view).collect())
}

#[tauri::command]
pub async fn ai_provider_get(
    state: State<'_, AppState>,
    id: String,
) -> OpsResult<Option<AiProviderView>> {
    let conn = state.db.open().map_err(store_error)?;
    Ok(db::get_provider(&conn, &id)
        .map_err(store_error)?
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
) -> OpsResult<AiProviderView> {
    let now = AppDb::now();
    let conn = state.db.open().map_err(store_error)?;

    let id = request
        .id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let existing = db::get_provider(&conn, &id).map_err(store_error)?;

    // Base URL 是**唯一能让请求跑到别处去**的配置，先过一遍严格校验。
    let base_url = url::validate_base_url(
        &request.base_url,
        url::BaseUrlPolicy {
            allow_insecure_http: request.allow_insecure_http,
        },
    )
    .map_err(|error| invalid(error.user_message()))?;
    if request.name.trim().is_empty() {
        return Err(invalid("提供方名称不能为空"));
    }
    if request.model.trim().is_empty() {
        return Err(invalid("模型名不能为空"));
    }

    /*
     * **第一个提供方自动启用并设为默认**。
     *
     * 以前 `enabled` / `is_default` 完全由表单决定，而表单里这两个开关不显眼：
     * 用户填完 URL / 模型 / Key 保存后，库里是 `enabled=0, is_default=0` ——
     * `default_provider()` 取不到，极核就一直说"还没有配置 AI 模型"（配置看起来
     * 没生效）。现在首个提供方直接可用，不需要再找一遍"设为默认"。
     */
    let is_first = existing.is_none()
        && conn
            .query_row("SELECT COUNT(*) FROM ai_providers", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(store_error)?
            == 0;
    let enabled = request.enabled || is_first;
    let is_default = request.is_default || is_first;

    let mut config = match existing {
        Some(existing) => AiProviderConfig {
            name: request.name.clone(),
            provider_kind: request.provider_kind,
            base_url,
            model: request.model.clone(),
            enabled,
            is_default,
            allow_insecure_http: request.allow_insecure_http,
            timeout_seconds: request.timeout_seconds,
            max_output_tokens: request.max_output_tokens,
            context_window: request.context_window,
            context_budgets: request.context_budgets.clone(),
            reasoning_efforts: request.reasoning_efforts.clone(),
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
            enabled,
            is_default,
            allow_insecure_http: request.allow_insecure_http,
            timeout_seconds: request.timeout_seconds,
            max_output_tokens: request.max_output_tokens,
            context_window: request.context_window,
            context_budgets: request.context_budgets.clone(),
            reasoning_efforts: request.reasoning_efforts.clone(),
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
            .map_err(|error| store_error(format!("保存 API Key 到系统凭据管理器失败：{error}")))?;
        config.api_key_ref = Some(account);
    } else if config.api_key_ref.is_none() {
        return Err(invalid(
            "新建提供方必须填 API Key（它只写进系统凭据管理器，不会存进数据库）",
        ));
    }

    // 停用的提供方不能是默认：显式校正，绝不写入"disabled 且 default"的组合。
    if !config.enabled {
        config.is_default = false;
    }
    db::upsert_provider(&conn, &config).map_err(store_error)?;
    if config.is_default {
        db::set_default_provider(&conn, &config.id).map_err(store_error)?;
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
) -> OpsResult<()> {
    let conn = state.db.open().map_err(store_error)?;
    let existing = db::get_provider(&conn, &id).map_err(store_error)?;
    let account = existing
        .as_ref()
        .map(|config| config.keyring_account())
        .unwrap_or_else(|| format!("ai-provider:{id}"));
    db::delete_provider(&conn, &id).map_err(store_error)?;
    if delete_secret {
        // 删不掉也要说清楚：钥匙串条目没清理等于凭据还在本机。
        if let Err(error) = crate::keyring::delete_secret(&account) {
            return Err(store_error(format!(
                "配置已删除，但系统凭据管理器里的条目没删掉：{error}"
            )));
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
pub async fn ai_provider_set_default(state: State<'_, AppState>, id: String) -> OpsResult<()> {
    let conn = state.db.open().map_err(store_error)?;
    db::set_default_provider(&conn, &id).map_err(store_error)?;
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
) -> OpsResult<AiProviderTestResult> {
    let config = {
        let conn = state.db.open().map_err(store_error)?;
        db::get_provider(&conn, &id)
            .map_err(store_error)?
            .ok_or_else(|| "提供方不存在".to_string())?
    };
    let api_key = crate::keyring::read_secret(&config.keyring_account())
        .map_err(|_| "这个提供方还没有保存可用的 API Key".to_string())?;
    // 明文 http 的策略来自配置本身（`allow_insecure_http`），与保存校验一致。
    let advisor =
        OpenAiCompatibleAdvisor::new(config, api_key).map_err(|error| error.user_message())?;
    let result = advisor.test_connection().await;
    // 审计只记结论，不记任何请求细节。
    record_audit(
        &state,
        "ai_provider_test",
        None,
        None,
        &format!(
            "{{\"provider\":\"{id}\",\"ok\":{},\"code\":\"{}\",\"attempts\":{}}}",
            result.ok,
            result.error_code.clone().unwrap_or_else(|| "-".to_string()),
            result.attempts
        ),
    );
    Ok(result)
}

/// **未保存配置**的连接测试。
///
/// 表单里先测再存，不能因为"还没保存"就没有 id / 钥匙串条目。明文 Key 只在
/// 这次请求的内存里用一次：**不落库、不写钥匙串、不写审计**。编辑已有提供方
/// 时 Key 留空，则临时读一次已保存的 Key（仍然不回传给前端）。
#[tauri::command]
pub async fn ai_provider_test_draft(
    state: State<'_, AppState>,
    request: AiProviderSaveRequest,
) -> OpsResult<AiProviderTestResult> {
    let base_url = url::validate_base_url(
        &request.base_url,
        url::BaseUrlPolicy {
            allow_insecure_http: request.allow_insecure_http,
        },
    )
    .map_err(|error| invalid(error.user_message()))?;
    if request.model.trim().is_empty() {
        return Err(invalid("模型名不能为空"));
    }

    let api_key = match request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        Some(key) => key.to_string(),
        None => {
            let id = request
                .id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| invalid("测试前请先填写 API Key"))?;
            let conn = state.db.open().map_err(store_error)?;
            let existing = db::get_provider(&conn, id)
                .map_err(store_error)?
                .ok_or_else(|| invalid("提供方不存在"))?;
            crate::keyring::read_secret(&existing.keyring_account())
                .map_err(|_| invalid("这个提供方还没有保存可用的 API Key"))?
        }
    };

    let now = AppDb::now();
    let config = AiProviderConfig {
        id: request
            .id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| "draft".to_string()),
        name: if request.name.trim().is_empty() {
            "draft".to_string()
        } else {
            request.name.clone()
        },
        provider_kind: request.provider_kind,
        base_url,
        model: request.model.clone(),
        api_key_ref: None,
        enabled: true,
        is_default: false,
        allow_insecure_http: request.allow_insecure_http,
        timeout_seconds: request.timeout_seconds,
        max_output_tokens: request.max_output_tokens,
        context_window: request.context_window,
        context_budgets: request.context_budgets.clone(),
        reasoning_efforts: request.reasoning_efforts.clone(),
        created_at: now,
        updated_at: now,
    };
    let advisor =
        OpenAiCompatibleAdvisor::new(config, api_key).map_err(|error| error.user_message())?;
    Ok(advisor.test_connection().await)
}

/// 一轮对话消息（只带角色与文本，前端不可能传别的）。
#[derive(Debug, serde::Deserialize)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, serde::Serialize)]
pub struct AiChatReply {
    /// 模型答复正文。
    pub content: String,
    /// **实际使用的模型名**（界面要显示出来，用户才知道是谁在回答）。
    pub model: String,
}

/// 极核模式的对话入口：读**默认**提供方 → 钥匙串取 Key → 一次 OpenAI 兼容调用。
///
/// 刻意不做的事：
/// * 不落库、不写审计 —— 问答内容属于用户与模型之间的事；
/// * 不解析命令、不产生任何执行动作 —— 计划仍由确定性引擎生成并经用户确认；
/// * 不把 Key、请求头或原始响应带回前端。
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    task_id: String,
    messages: Vec<ChatTurn>,
) -> OpsResult<AiChatReply> {
    let config = {
        let conn = state.db.open().map_err(store_error)?;
        db::default_provider(&conn)
            .map_err(store_error)?
            .ok_or_else(|| "还没有配置 AI 模型".to_string())?
    };
    let model = config.model.clone();
    let api_key = crate::keyring::read_secret(&config.keyring_account())
        .map_err(|_| "这个提供方还没有保存可用的 API Key".to_string())?;
    let advisor =
        OpenAiCompatibleAdvisor::new(config, api_key).map_err(|error| error.user_message())?;
    let payload: Vec<serde_json::Value> = messages
        .into_iter()
        .map(|turn| serde_json::json!({ "role": turn.role, "content": turn.content }))
        .collect();
    /*
     * **真实取消**：把令牌登记到与部署复核共用的注册表里。
     *
     * 前端点「停止」时调 `ai_chat_cancel(task_id)`，`post_chat` 在等待响应的
     * 循环里看到取消就断开 —— 后端不再继续读响应、也不再计费到超时。
     * 只丢弃前端状态、让请求在后台跑完，是假取消。
     */
    let cancel = state.ai_reviews.register(&task_id);
    let content = advisor
        .chat(payload, &cancel)
        .await
        .map_err(|error| error.user_message())?;
    Ok(AiChatReply { content, model })
}

/// **流式**对话：模型每吐出一段就发一次 `ai-chat-delta` 事件。
///
/// 事件负载：`{ taskId, delta }`。前端按 `taskId` 过滤，避免两台服务器同时
/// 在回答时把文字拼到同一个气泡里。取消仍然走 `ai_chat_cancel`。
#[tauri::command]
pub async fn ai_chat_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    messages: Vec<ChatTurn>,
) -> OpsResult<AiChatReply> {
    let config = {
        let conn = state.db.open().map_err(store_error)?;
        db::default_provider(&conn)
            .map_err(store_error)?
            .ok_or_else(|| "还没有配置 AI 模型".to_string())?
    };
    let model = config.model.clone();
    let api_key = crate::keyring::read_secret(&config.keyring_account())
        .map_err(|_| "这个提供方还没有保存可用的 API Key".to_string())?;
    let advisor =
        OpenAiCompatibleAdvisor::new(config, api_key).map_err(|error| error.user_message())?;
    let payload: Vec<serde_json::Value> = messages
        .into_iter()
        .map(|turn| serde_json::json!({ "role": turn.role, "content": turn.content }))
        .collect();
    let cancel = state.ai_reviews.register(&task_id);
    // Tauri 2 的事件发射是 trait 方法，需要显式引入。
    use tauri::Emitter as _;
    let channel = task_id.clone();
    let outcome = advisor
        .chat_stream(payload, &cancel, move |delta| {
            let _ = app.emit(
                "ai-chat-delta",
                serde_json::json!({ "taskId": channel.as_str(), "delta": delta }),
            );
        })
        .await;
    /*
     * **结束后必须注销**。
     *
     * 成功、失败、被取消都会走到这里；不注销的话登记表会随着每次提问一直
     * 长下去（`AiReviewRegistry::forget` 的注释也特意写了这一条）。
     * 先取结果再注销，避免 `?` 提前返回把它跳过。
     */
    state.ai_reviews.forget(&task_id);
    let content = outcome.map_err(|error| error.user_message())?;
    Ok(AiChatReply { content, model })
}

/// 取消一次进行中的对话请求。
///
/// 返回 `true` 表示请求当时还在跑并被置位；`false` 表示已经结束了。
#[tauri::command]
pub async fn ai_chat_cancel(state: State<'_, AppState>, task_id: String) -> OpsResult<bool> {
    Ok(state.ai_reviews.cancel(&task_id))
}
