//! OpenAI 兼容协议的 Provider 实现。
//!
//! # 只做一次网络调用
//!
//! 全项目**唯一**发 HTTP 请求的地方就在这里（`reqwest`）。它做的事：
//! `POST {base}/chat/completions`，把模型答复里的 JSON 抠出来，转成
//! [`AiSuggestion`]。**不执行任何服务器操作**，也不碰 SSH / Docker / SFTP / 钥匙串
//! （密钥由调用方从钥匙串读出后传进来，用完即弃）。
//!
//! # 不发出去的东西（写在这里是为了它可被审计）
//!
//! 请求体只有 [`AiPrompt`] 的内容：分区后的**方案摘要**（拓扑、服务名、角色、
//! 端口、健康检查是否有、容量估算、风险与未知项、知识片段）。
//! 以下内容**从不进入请求**：API Key（只在 `Authorization` 头里，且不记日志）、
//! 环境变量值、SecretRef 解析值、SSH 凭据、证书私钥、DNS Token、制品原文、
//! `.env` 内容、数据库密码、部署日志、用户主目录里的任何文件。
//! `AiPrompt` 的类型本身就是这条保证：`payload` 全部由引擎的结构化字段拼成，
//! 没有任何"把文件内容塞进去"的入口。
//!
//! # 答复的处理
//!
//! 1. 抠出 JSON 对象（容忍前后有解释性文字；但有 Markdown 代码围栏直接拒）；
//! 2. **严格反序列化**（`deny_unknown_fields`）—— 多一个字段就是拒绝；
//! 3. 交给 `proposal::ai::merge_into` 做语义校验（命令、长度、伪造引用、
//!    想改确定性结论）。
//!
//! 第 3 步在合并层做，因为它需要"本次真实发送了哪些知识"这个上下文。

use std::fmt;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Deserialize;

use crate::deployment::proposal::ai::{
    AiCitation, AiNote, AiPrompt, AiReviewFailure, AiSuggestion, render_prompt,
};
use crate::deployment::proposal::model::AiRejectionKind;

use super::model::{
    AiProviderConfig, AiProviderError, AiProviderKind, AiProviderTestResult, AiRequestBudget,
};
use super::url;

/// 异步提供方接口。
///
/// **异步是必须的**：真实模型调用是网络请求，在同步 trait 里 `block_on`
/// 会把整个运行时卡住。确定性引擎（同步纯函数）不依赖这个接口 ——
/// 它在 `proposal::ai::merge_into` 那一层与网络解耦。
#[async_trait]
pub trait AiAdvisor: Send + Sync {
    /// 提供方 id（进审计：这次是谁答的）。
    fn provider_id(&self) -> String;
    /// 模型名（进方案指纹）。
    fn model(&self) -> String;
    /// 跑一次复核。
    async fn review(&self, prompt: &AiPrompt) -> Result<AiSuggestion, AiProviderError>;
}

/// OpenAI 兼容的提供方。
pub struct OpenAiCompatibleAdvisor {
    config: AiProviderConfig,
    /// **只在内存里**：来自钥匙串，用完即弃，绝不写进任何结构体字段之外的地方。
    api_key: String,
    client: reqwest::Client,
    budget: AiRequestBudget,
}

impl fmt::Debug for OpenAiCompatibleAdvisor {
    /// 手写 `Debug`：确保 `{:?}` 永远不会带出 API Key。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiCompatibleAdvisor")
            .field("provider_id", &self.config.id)
            .field("model", &self.config.model)
            .field("base_url", &self.config.base_url)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

impl OpenAiCompatibleAdvisor {
    /// 构造（会校验配置与会话预算）。
    pub fn new(
        config: AiProviderConfig,
        api_key: String,
        allow_insecure_http: bool,
    ) -> Result<Self, AiProviderError> {
        if config.provider_kind != AiProviderKind::OpenAiCompatible {
            return Err(AiProviderError::InvalidConfig(format!(
                "暂不支持这种提供方类型：{}",
                config.provider_kind.as_str()
            )));
        }
        if config.model.trim().is_empty() {
            return Err(AiProviderError::InvalidConfig("模型名不能为空".to_string()));
        }
        let base_url = url::validate_base_url(
            &config.base_url,
            url::BaseUrlPolicy {
                allow_insecure_http,
            },
        )?;
        if api_key.trim().is_empty() {
            return Err(AiProviderError::InvalidConfig(
                "还没有保存 API Key：请在设置里填一次（只写进系统凭据管理器）".to_string(),
            ));
        }
        let budget = config.budget();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(budget.connect_seconds))
            .timeout(Duration::from_secs(u64::from(budget.timeout_seconds)))
            // **不跟随重定向**：配置指向哪就只问哪，不给"跳到别处"的机会。
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("BLS-OPS/deployment-reviewer")
            .build()
            .map_err(|error| AiProviderError::Network(error.to_string()))?;

        Ok(Self {
            config: AiProviderConfig {
                base_url,
                ..config
            },
            api_key,
            client,
            budget,
        })
    }

    pub fn budget(&self) -> AiRequestBudget {
        self.budget
    }

    /// 连接测试：一次**最小的**真实请求。
    ///
    /// 优先 `GET /models`（最轻、不消耗生成额度）；服务端不支持时退化为
    /// 一次只要求极少输出的 `chat/completions`。
    pub async fn test_connection(&self) -> AiProviderTestResult {
        let started = Instant::now();
        let model = self.config.model.clone();
        match self.probe_models().await {
            Ok(()) => AiProviderTestResult {
                ok: true,
                latency_ms: elapsed_ms(started),
                model,
                message: "连接成功（GET /models）".to_string(),
                error_code: None,
            },
            Err(first) => {
                // 404/405 = 这个网关没实现 /models，换成最小生成请求再试一次。
                if matches!(first, AiProviderError::Http { status: 404 | 405, .. }) {
                    match self.probe_chat().await {
                        Ok(()) => AiProviderTestResult {
                            ok: true,
                            latency_ms: elapsed_ms(started),
                            model,
                            message: "连接成功（最小生成请求）".to_string(),
                            error_code: None,
                        },
                        Err(error) => self.failure(started, model, error),
                    }
                } else {
                    self.failure(started, model, first)
                }
            }
        }
    }

    fn failure(
        &self,
        started: Instant,
        model: String,
        error: AiProviderError,
    ) -> AiProviderTestResult {
        AiProviderTestResult {
            ok: false,
            latency_ms: elapsed_ms(started),
            model,
            message: error.user_message(),
            error_code: Some(error.code().to_string()),
        }
    }

    async fn probe_models(&self) -> Result<(), AiProviderError> {
        let target = url::models_url(&self.config.base_url);
        let response = self
            .client
            .get(&target)
            .bearer_auth(&self.api_key)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = response.status();
        let body = self.read_limited(response).await?;
        if status.is_success() {
            return Ok(());
        }
        Err(self.status_error(status.as_u16(), &body, &[]))
    }

    async fn probe_chat(&self) -> Result<(), AiProviderError> {
        let body = serde_json::json!({
            "model": self.config.model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 8,
            "stream": false,
        });
        let (status, bytes, _) = self.post_chat(&body, 4).await?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(self.status_error(status, &bytes, &[]))
        }
    }

    /// 一次带有限重试的 `chat/completions` 调用。
    async fn post_chat(
        &self,
        body: &serde_json::Value,
        max_tokens: u32,
    ) -> Result<(u16, Vec<u8>, u32), AiProviderError> {
        let target = url::completions_url(&self.config.base_url);
        let mut attempt = 0u32;
        let mut last_error: Option<AiProviderError> = None;

        while attempt < self.budget.max_attempts {
            attempt += 1;
            let request = self
                .client
                .post(&target)
                .bearer_auth(&self.api_key)
                .header("accept", "application/json")
                .json(&serde_json::json!({
                    "model": self.config.model,
                    "max_tokens": max_tokens,
                    "temperature": 0.2,
                    "stream": false,
                    // 要求结构化输出；不支持它的网关会在下面被识别并重试一次。
                    "response_format": {"type": "json_object"},
                    "messages": body["messages"].clone(),
                }));

            match request.send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let retry_after = retry_after_seconds(&response);
                    let bytes = self.read_limited(response).await?;
                    if (200..300).contains(&status) {
                        return Ok((status, bytes, attempt));
                    }
                    // 明确说"不认识 response_format"时，去掉它再试一次。
                    if status == 400 && mentions_response_format(&bytes) {
                        let retry = self
                            .client
                            .post(&target)
                            .bearer_auth(&self.api_key)
                            .header("accept", "application/json")
                            .json(&serde_json::json!({
                                "model": self.config.model,
                                "max_tokens": max_tokens,
                                "temperature": 0.2,
                                "stream": false,
                                "messages": body["messages"].clone(),
                            }))
                            .send()
                            .await
                            .map_err(map_reqwest)?;
                        let retry_status = retry.status().as_u16();
                        let retry_bytes = self.read_limited(retry).await?;
                        if (200..300).contains(&retry_status) {
                            return Ok((retry_status, retry_bytes, attempt));
                        }
                        let error = self.status_error(retry_status, &retry_bytes, &[]);
                        last_error = Some(error.clone());
                        if !error.is_retryable() || attempt >= self.budget.max_attempts {
                            return Err(error);
                        }
                        continue;
                    }
                    let error = self.status_error(status, &bytes, &[]);
                    let retryable = error.is_retryable();
                    last_error = Some(error.clone());
                    if !retryable || attempt >= self.budget.max_attempts {
                        return Err(error);
                    }
                    self.sleep_before_retry(attempt, retry_after).await;
                }
                Err(error) => {
                    let mapped = map_reqwest(error);
                    let retryable = mapped.is_retryable();
                    last_error = Some(mapped.clone());
                    if !retryable || attempt >= self.budget.max_attempts {
                        return Err(mapped);
                    }
                    self.sleep_before_retry(attempt, None).await;
                }
            }
        }
        Err(last_error.unwrap_or(AiProviderError::Timeout))
    }

    async fn sleep_before_retry(&self, attempt: u32, retry_after: Option<u64>) {
        let capped = retry_after
            .map(|seconds| seconds.min(self.budget.max_backoff_seconds))
            .unwrap_or_else(|| {
                self.budget
                    .base_backoff_seconds
                    .saturating_mul(1 << attempt.min(4))
                    .min(self.budget.max_backoff_seconds)
            });
        if capped > 0 {
            tokio::time::sleep(Duration::from_secs(capped)).await;
        }
    }

    /// 读响应体，**带硬上限**（超了立刻放弃，不试图读完）。
    async fn read_limited(
        &self,
        mut response: reqwest::Response,
    ) -> Result<Vec<u8>, AiProviderError> {
        let limit = self.budget.max_response_bytes;
        if let Some(length) = response.content_length() {
            if length as usize > limit {
                return Err(AiProviderError::ResponseTooLarge);
            }
        }
        let mut collected: Vec<u8> = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(map_reqwest)? {
            if collected.len() + chunk.len() > limit {
                return Err(AiProviderError::ResponseTooLarge);
            }
            collected.extend_from_slice(&chunk);
        }
        Ok(collected)
    }

    /// 把非 2xx 状态映射成**脱敏**的错误。
    fn status_error(
        &self,
        status: u16,
        body: &[u8],
        retry_after: Option<u64>,
    ) -> AiProviderError {
        let detail = sanitize_server_message(&String::from_utf8_lossy(body), &self.api_key);
        match status {
            401 | 403 => AiProviderError::Auth(detail),
            429 => AiProviderError::RateLimited {
                retry_after_seconds: retry_after,
            },
            _ => AiProviderError::Http { status, detail },
        }
    }
}

#[async_trait]
impl AiAdvisor for OpenAiCompatibleAdvisor {
    fn provider_id(&self) -> String {
        self.config.id.clone()
    }

    fn model(&self) -> String {
        self.config.model.clone()
    }

    async fn review(&self, prompt: &AiPrompt) -> Result<AiSuggestion, AiProviderError> {
        let body = serde_json::json!({
            "messages": [
                {"role": "system", "content": prompt.system},
                {"role": "user", "content": render_prompt(prompt)},
            ],
        });
        let (_, bytes, _) = self
            .post_chat(&body, self.budget.max_output_tokens)
            .await?;

        let content = extract_content(&bytes).ok_or_else(|| AiProviderError::RejectedContent {
            reason: "模型响应里没有可用的文本内容".to_string(),
            kind: AiRejectionKind::Other,
        })?;

        parse_suggestion(&content).map_err(|failure| AiProviderError::RejectedContent {
            reason: failure.reason.clone(),
            kind: failure.kind,
        })
    }
}

// -- 响应解析（纯函数，全部有单测）-------------------------------------------

/// 从 OpenAI 兼容响应里取出模型文本。
pub fn extract_content(bytes: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct Response {
        #[serde(default)]
        choices: Vec<Choice>,
    }
    #[derive(Deserialize)]
    struct Choice {
        #[serde(default)]
        message: Option<Message>,
        #[serde(default)]
        text: Option<String>,
    }
    #[derive(Deserialize)]
    struct Message {
        #[serde(default)]
        content: Option<String>,
    }

    let parsed: Response = serde_json::from_slice(bytes).ok()?;
    let choice = parsed.choices.into_iter().next()?;
    choice
        .message
        .and_then(|message| message.content)
        .or(choice.text)
}

/// 把模型答复解析成 [`AiSuggestion`]，失败时给出**分类**。
pub fn parse_suggestion(content: &str) -> Result<AiSuggestion, AiReviewFailure> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(failure("模型返回了空内容", AiRejectionKind::Empty));
    }
    if trimmed.contains("```") {
        return Err(failure(
            "模型返回了 Markdown 代码块：只接受纯 JSON",
            AiRejectionKind::Markdown,
        ));
    }
    let json = extract_json_object(trimmed).ok_or_else(|| {
        failure(
            "模型返回的内容里找不到 JSON 对象（只接受 JSON）",
            AiRejectionKind::InvalidJson,
        )
    })?;

    let raw: RawSuggestion = serde_json::from_str(json).map_err(|error| {
        let text = error.to_string();
        if text.contains("unknown field") {
            failure(
                &format!("模型返回了未知字段：{text}"),
                AiRejectionKind::UnknownField,
            )
        } else {
            failure(
                &format!("模型返回的 JSON 结构不符合约定：{text}"),
                AiRejectionKind::InvalidJson,
            )
        }
    })?;

    Ok(raw.into_suggestion())
}

fn failure(reason: &str, kind: AiRejectionKind) -> AiReviewFailure {
    AiReviewFailure {
        reason: reason.to_string(),
        kind,
    }
}

/// 严格结构：**多一个字段就是错误**（模型不许自创字段）。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
struct RawSuggestion {
    #[serde(default)]
    notes: Vec<RawNote>,
    #[serde(default)]
    alternatives: Vec<String>,
    #[serde(default)]
    open_questions: Vec<String>,
    #[serde(default)]
    knowledge_citations: Vec<RawCitation>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
struct RawNote {
    text: String,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    evidence_ids: Vec<String>,
    /// 数字或字符串都接受（模型经常把 85 写成 "85"），取值会被夹到 0-100。
    #[serde(default)]
    confidence: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
struct RawCitation {
    knowledge_id: String,
    /// 数字或字符串（系统知识是 `kb-2026.09.1`）。
    version: serde_json::Value,
    #[serde(default)]
    note: Option<String>,
}

impl RawSuggestion {
    fn into_suggestion(self) -> AiSuggestion {
        AiSuggestion {
            notes: self
                .notes
                .into_iter()
                .map(|note| AiNote {
                    text: note.text,
                    target: note.target,
                    evidence_ids: note.evidence_ids,
                    confidence: note.confidence.as_ref().and_then(parse_confidence),
                })
                .collect(),
            alternatives: self.alternatives,
            open_questions: self.open_questions,
            knowledge_citations: self
                .knowledge_citations
                .into_iter()
                .map(|citation| AiCitation {
                    knowledge_id: citation.knowledge_id,
                    version: value_to_text(&citation.version),
                    note: citation.note,
                })
                .collect(),
        }
    }
}

fn parse_confidence(value: &serde_json::Value) -> Option<u8> {
    let number = match value {
        serde_json::Value::Number(number) => number.as_f64()?,
        serde_json::Value::String(text) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !number.is_finite() {
        return None;
    }
    Some(number.clamp(0.0, 100.0).round() as u8)
}

fn value_to_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.trim().to_string(),
        serde_json::Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// 从（可能夹着解释性文字的）文本里抠出第一个**完整的** JSON 对象。
///
/// 用花括号配对而不是"找第一个 { 与最后一个 }"：后者在模型多说一句话时
/// 会把无关内容并进 JSON，反而制造出一个更奇怪的解析错误。
pub fn extract_json_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes[start..].iter().enumerate() {
        let ch = *byte as char;
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let end = start + offset + 1;
                    return text.get(start..end);
                }
            }
            _ => {}
        }
    }
    None
}

/// 服务端错误信息脱敏：抹掉 API Key、常见的密钥样式，压平空白并截断。
pub fn sanitize_server_message(raw: &str, api_key: &str) -> String {
    let mut text = raw.to_string();
    if !api_key.is_empty() {
        text = text.replace(api_key, "<redacted>");
    }
    text = redact_key_like(&text);
    let flattened: String = text
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let collapsed = flattened.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated: String = collapsed.chars().take(200).collect();
    if truncated.is_empty() {
        "（服务端没有给出可读信息）".to_string()
    } else {
        truncated
    }
}

/// 把像密钥的片段打掉：`sk-xxxx`、`Bearer xxxx`、长十六进制串。
fn redact_key_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for token in text.split_inclusive(char::is_whitespace) {
        let body = token.trim_end();
        let suffix = &token[body.len()..];
        let looks_like_key = body.starts_with("sk-")
            || body.starts_with("Bearer ")
            || body.to_ascii_lowercase().starts_with("api-key")
            || (body.len() >= 32 && body.chars().all(|ch| ch.is_ascii_hexdigit()));
        if looks_like_key {
            out.push_str("<redacted>");
        } else {
            out.push_str(body);
        }
        out.push_str(suffix);
    }
    out
}

fn mentions_response_format(bytes: &[u8]) -> bool {
    String::from_utf8_lossy(bytes)
        .to_ascii_lowercase()
        .contains("response_format")
}

fn retry_after_seconds(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

fn map_reqwest(error: reqwest::Error) -> AiProviderError {
    if error.is_timeout() {
        return AiProviderError::Timeout;
    }
    if error.is_connect() {
        return AiProviderError::Network(format!("连接失败：{}", short(&error.to_string())));
    }
    AiProviderError::Network(short(&error.to_string()))
}

fn short(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(160).collect()
}

fn elapsed_ms(started: Instant) -> i64 {
    i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)
}

/// 供测试复用：把"像密钥的东西"打掉的行为直接可测。
pub fn redact_for_tests(text: &str) -> String {
    redact_key_like(text)
}
