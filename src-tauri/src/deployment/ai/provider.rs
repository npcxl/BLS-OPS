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
    render_prompt, AiCitation, AiNote, AiPrompt, AiReviewFailure, AiSuggestion,
};
use crate::deployment::proposal::model::AiRejectionKind;

/// 流式响应里**正在拼接**的一次工具调用（参数按片段到达）。
#[derive(Debug, Clone, Default)]
struct StreamToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// 模型通过 `tools` 原生发起的一次函数调用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeToolCall {
    pub id: String,
    pub name: String,
    /// 原始 JSON 字符串（与文本协议的 `body` 同一形态，便于共用解析）。
    pub arguments: String,
}

/// 一次带工具的原生答复。
#[derive(Debug, Clone)]
pub struct ToolReply {
    /// 模型正文（可能为空：纯工具调用轮次）。
    pub content: String,
    /// 原样的 assistant 消息：带 `tool_calls` 回灌时必须一字不改。
    pub message: serde_json::Value,
    pub tool_calls: Vec<NativeToolCall>,
}

use super::model::{
    AiCancel, AiDraftOutcome, AiProviderConfig, AiProviderError, AiProviderKind,
    AiProviderTestResult, AiRequestBudget, AiReviewOutcome,
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
    ///
    /// 返回 [`AiReviewOutcome`]：**不管成功失败都带真实尝试次数**（Provider
    /// 内部会重试，所以"试了几次"只有它知道）。
    /// `cancel` 会作用在请求与退避等待上，不是"跑完再看一眼"。
    async fn review(&self, prompt: &AiPrompt, cancel: &AiCancel) -> AiReviewOutcome;

    /// 让模型产出**部署草案**（P5.6）。
    ///
    /// 分工很明确：`review` 只能对**既有方案**提意见；`draft` 产出的是
    /// "打算怎么部署"，而且必须再过 [`crate::deployment::planner::validate_draft`]
    /// 与确定性编译器才能变成计划图 —— AI 在任何一环都拿不到执行入口。
    async fn draft(&self, prompt: &AiPrompt, cancel: &AiCancel) -> AiDraftOutcome;
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
    ///
    /// **明文 http 的策略只有一个来源：`config.allow_insecure_http`。**
    /// 保存校验、连接测试、正式复核走的是同一段代码，因此不会出现
    /// "保存时放行、调用时被拒"（或反过来）的错位。
    pub fn new(config: AiProviderConfig, api_key: String) -> Result<Self, AiProviderError> {
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
                allow_insecure_http: config.allow_insecure_http,
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
            config: AiProviderConfig { base_url, ..config },
            api_key,
            client,
            budget,
        })
    }

    pub fn budget(&self) -> AiRequestBudget {
        self.budget
    }

    /// **流式**对话：模型每吐出一段，就通过 `on_delta` 交给调用方。
    ///
    /// 与 `chat` 的区别只在读取方式：整段返回要等到最后一个 token，界面上
    /// 就是"点了发送、然后干等"；流式让文字边生成边出现，也更容易判断模型
    /// 是不是在胡说。取消同样生效（每块检查一次令牌）。
    pub async fn chat_stream<F>(
        &self,
        messages: Vec<serde_json::Value>,
        cancel: &AiCancel,
        mut on_delta: F,
    ) -> Result<String, AiProviderError>
    where
        F: FnMut(&str),
    {
        use futures_util::StreamExt as _;

        let body = serde_json::json!({
            "model": self.config.model,
            "messages": messages,
            "stream": true,
            "temperature": 0.2,
        });
        let target = url::completions_url(&self.config.base_url);

        /*
         * **等待响应也要能被取消**。
         *
         * `send()` 在服务端迟迟不回包时可能挂到总超时，用户点了「停止」却要
         * 干等到那一刻。用 `select!` 让取消令牌直接打断这次等待。
         */
        let requested = self
            .client
            .post(target)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send();
        let response = tokio::select! {
            _ = cancel.cancelled() => return Err(AiProviderError::Cancelled),
            result = requested => result.map_err(|error| {
                if error.is_timeout() {
                    AiProviderError::Timeout
                } else {
                    AiProviderError::Network(error.to_string())
                }
            })?,
        };

        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let bytes = response.bytes().await.unwrap_or_default();
            // 走同一套脱敏：不要把服务端原始响应整段带回界面。
            return Err(self.status_error(status, &bytes, None));
        }

        let mut stream = response.bytes_stream();
        /*
         * **按字节累积，只在换行边界解码**。
         *
         * 之前每块都独立 `from_utf8_lossy`：一个中文汉字占 3 字节，正好被切在
         * 两块里时会各自解出 U+FFFD，界面上就是"锟斤拷"。改成先攒字节、找到
         * `\n` 再整行解码，跨块的半个字符自然就拼回去了。
         */
        let mut pending: Vec<u8> = Vec::new();
        let mut full = String::new();
        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => return Err(AiProviderError::Cancelled),
                next = stream.next() => next,
            };
            let Some(chunk) = chunk else {
                break;
            };
            let bytes = chunk.map_err(|error| AiProviderError::Network(error.to_string()))?;
            pending.extend_from_slice(&bytes);
            while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = pending.drain(..=position).collect();
                if let Some(delta) = Self::parse_sse_line(&line, status, &mut full)? {
                    on_delta(&delta);
                }
            }
        }
        // 结尾可能没有换行：最后一段也要处理，否则尾字会被吞掉。
        if !pending.is_empty() {
            if let Some(delta) = Self::parse_sse_line(&pending, status, &mut full)? {
                on_delta(&delta);
            }
        }

        /*
         * **空回复当失败**。
         *
         * 供应商返回 200 但没有任何 content（配额耗尽、内容被拦截、`delta`
         * 结构异常）时，以前会 `Ok("")`，界面表现为"转了半天什么都没出现"。
         */
        if full.trim().is_empty() {
            return Err(AiProviderError::Http {
                status,
                detail: "模型返回了空回复（没有正文内容）".to_string(),
            });
        }
        Ok(full)
    }

    /// 解一行 SSE：返回本次新增的正文片段（没有正文就返回 `None`）。
    ///
    /// `[DONE]` 与 `error` 事件在这里统一处理：前者表示正常结束，后者要把
    /// 供应商给的原因带回界面，而不是静默跳过。
    fn parse_sse_line(
        line: &[u8],
        status: u16,
        full: &mut String,
    ) -> Result<Option<String>, AiProviderError> {
        // 只有整行都到齐了才解码，中文不会在中间被切断。
        let text = String::from_utf8_lossy(line);
        let text = text.trim();
        let Some(data) = text.strip_prefix("data:") else {
            return Ok(None);
        };
        let data = data.trim();
        if data.is_empty() {
            return Ok(None);
        }
        if data == "[DONE]" {
            return Ok(None);
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            return Ok(None);
        };
        // 供应商的错误事件（限流、内容审核、上下文超限…）。
        if let Some(error) = value.get("error") {
            let detail = error
                .get("message")
                .and_then(|message| message.as_str())
                .unwrap_or("模型返回了错误事件");
            return Err(AiProviderError::Http {
                status,
                detail: detail.to_string(),
            });
        }
        let Some(delta) = value["choices"][0]["delta"]["content"].as_str() else {
            return Ok(None);
        };
        if delta.is_empty() {
            return Ok(None);
        }
        full.push_str(delta);
        Ok(Some(delta.to_string()))
    }

    /// 通用对话（极核模式的问答）。
    ///
    /// 与部署复核共用同一套超时 / 重试 / 取消 / 预算，区别只有两点：
    /// * 输出是**纯文本**，不做 JSON 严格校验（问答不需要结构化）；
    /// * 不做语义合并 —— 结果只回给界面，**不产生任何可执行动作**。
    ///
    /// 密钥仍只在内存里（构造时传入，用完即弃），日志不记请求头。
    pub async fn chat(
        &self,
        messages: Vec<serde_json::Value>,
        cancel: &AiCancel,
    ) -> Result<String, AiProviderError> {
        self.chat_limited(messages, cancel, None).await
    }

    /// 与 [`Self::chat`] 相同，但可以指定单次输出上限。
    ///
    /// Agent 的工具调用结果是一段 JSON（`write_file` 的正文可能几 KB），按
    /// 默认 1200 tokens 容易被截断成"参数不是合法 JSON"；调用方在工具循环里
    /// 给一个更宽的上限，仍然被 `MAX_MAX_OUTPUT_TOKENS` 封顶。
    pub async fn chat_limited(
        &self,
        messages: Vec<serde_json::Value>,
        cancel: &AiCancel,
        max_output_tokens: Option<u32>,
    ) -> Result<String, AiProviderError> {
        let body = serde_json::json!({
            "model": self.config.model,
            "messages": messages,
            "stream": false,
            "temperature": 0.2,
        });
        let attempts = std::sync::atomic::AtomicU32::new(0);
        let max_tokens = max_output_tokens
            .map(|value| {
                value.clamp(
                    super::model::MIN_MAX_OUTPUT_TOKENS,
                    super::model::MAX_MAX_OUTPUT_TOKENS,
                )
            })
            .unwrap_or(self.config.max_output_tokens.max(256));
        let (status, bytes, _) = self
            .post_chat(&body, max_tokens, false, None, cancel, &attempts)
            .await?;
        if !(200..300).contains(&status) {
            return Err(self.status_error(status, &bytes, None));
        }
        let payload: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|error| AiProviderError::Http {
                status,
                detail: format!("响应不是合法 JSON：{error}"),
            })?;
        let content = payload["choices"][0]["message"]["content"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| AiProviderError::Http {
                status,
                detail: "响应里没有可用的 content".to_string(),
            })?;
        Ok(content.to_string())
    }

    /// 一次带**标准 function calling** 的对话（Agent 用）。
    ///
    /// 与 [`Self::chat_limited`] 的区别只有两点：
    /// * 请求里带 `tools` + `tool_choice: auto`；
    /// * 返回完整的 assistant 消息（含 `tool_calls`，必须原样回灌，否则后面的
    ///   `role: tool` 消息对不上，接口会直接 400）。
    ///
    /// 为什么不再只靠提示词约定 `<tool>` 文本：模型有自己的工具调用标记
    /// （`<|DSL| … invoke name="run_shell">` 之类），它不按我们的格式写，整段就
    /// 变成"普通回答"，循环里 0 次工具调用 —— 界面看起来就是"完成了 0 步"。
    pub async fn chat_with_tools(
        &self,
        messages: Vec<serde_json::Value>,
        tools: serde_json::Value,
        cancel: &AiCancel,
        max_output_tokens: Option<u32>,
    ) -> Result<ToolReply, AiProviderError> {
        let fallback = messages.clone();
        let body = serde_json::json!({ "messages": messages });
        let extra = serde_json::json!({ "tools": tools, "tool_choice": "auto" });
        let attempts = std::sync::atomic::AtomicU32::new(0);
        let max_tokens = max_output_tokens
            .map(|value| {
                value.clamp(
                    super::model::MIN_MAX_OUTPUT_TOKENS,
                    super::model::MAX_MAX_OUTPUT_TOKENS,
                )
            })
            .unwrap_or(self.config.max_output_tokens.max(256));
        let (status, bytes, _) = match self
            .post_chat(&body, max_tokens, false, Some(&extra), cancel, &attempts)
            .await
        {
            Ok(result) => result,
            // 网关不认识 `tools` / `tool_choice`：退回纯文本协议，别让整条任务失败。
            Err(AiProviderError::Http {
                status: 400 | 422, ..
            }) => {
                let content = self
                    .chat_limited(fallback, cancel, max_output_tokens)
                    .await?;
                return Ok(ToolReply {
                    message: serde_json::json!({ "role": "assistant", "content": content }),
                    content,
                    tool_calls: Vec::new(),
                });
            }
            Err(error) => return Err(error),
        };
        if !(200..300).contains(&status) {
            return Err(self.status_error(status, &bytes, None));
        }
        let payload: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|error| AiProviderError::Http {
                status,
                detail: format!("响应不是合法 JSON：{error}"),
            })?;
        let message = payload["choices"][0]["message"].clone();
        if !message.is_object() {
            return Err(AiProviderError::Http {
                status,
                detail: "响应里没有 message".to_string(),
            });
        }
        let content = message["content"].as_str().unwrap_or("").trim().to_string();
        let mut tool_calls = Vec::new();
        if let Some(list) = message["tool_calls"].as_array() {
            for (index, call) in list.iter().enumerate() {
                let name = call["function"]["name"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if name.is_empty() {
                    continue;
                }
                // 有的网关把 arguments 给成对象而不是字符串，两种都收。
                let arguments = match &call["function"]["arguments"] {
                    serde_json::Value::String(text) => text.clone(),
                    value if value.is_object() => value.to_string(),
                    _ => "{}".to_string(),
                };
                let id = call["id"]
                    .as_str()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("call-{index}"));
                tool_calls.push(NativeToolCall {
                    id,
                    name,
                    arguments,
                });
            }
        }
        Ok(ToolReply {
            content,
            message,
            tool_calls,
        })
    }

    /// **流式**的工具对话：正文边生成边回调，工具调用在结束时汇总。
    ///
    /// 与 [`Self::chat_with_tools`] 的区别只在读取方式。Agent 的答复要一边生成
    /// 一边上屏 —— 非流式时界面是"转圈半天、然后整段文字突然涌出来"。
    pub async fn chat_with_tools_stream<F>(
        &self,
        messages: Vec<serde_json::Value>,
        tools: serde_json::Value,
        cancel: &AiCancel,
        max_output_tokens: Option<u32>,
        // 已经按模型能力解析过的档位（`low` / `high` / `max`…）；`None` = 供应商默认。
        reasoning_effort: Option<&str>,
        mut on_delta: F,
    ) -> Result<ToolReply, AiProviderError>
    where
        F: FnMut(&str),
    {
        use futures_util::StreamExt as _;

        let fallback = messages.clone();
        let max_tokens = max_output_tokens
            .map(|value| {
                value.clamp(
                    super::model::MIN_MAX_OUTPUT_TOKENS,
                    super::model::MAX_MAX_OUTPUT_TOKENS,
                )
            })
            .unwrap_or(self.config.max_output_tokens.max(256));
        let body = serde_json::json!({
            "model": self.config.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "stream": true,
            "temperature": 0.2,
            "max_tokens": max_tokens,
        });
        /*
         * 思考模式下 `temperature` 不被支持：OpenAI 推理模型会直接 400，
         * DeepSeek 会忽略它。**明确选了档位才去掉** —— 默认档保持原来的 0.2。
         */
        let body = match reasoning_effort.filter(|effort| !effort.trim().is_empty()) {
            Some(effort) => {
                let mut body = body;
                body["reasoning_effort"] = serde_json::json!(effort);
                if let Some(fields) = body.as_object_mut() {
                    fields.remove("temperature");
                }
                body
            }
            None => body,
        };
        let target = url::completions_url(&self.config.base_url);

        let requested = self
            .client
            .post(target)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send();
        let response = tokio::select! {
            _ = cancel.cancelled() => return Err(AiProviderError::Cancelled),
            result = requested => result.map_err(|error| {
                if error.is_timeout() {
                    AiProviderError::Timeout
                } else {
                    AiProviderError::Network(error.to_string())
                }
            })?,
        };

        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let bytes = response.bytes().await.unwrap_or_default();
            // 网关不支持 `tools` / 流式工具：退回纯文本，别让整条任务失败。
            if matches!(status, 400 | 422) {
                let content = self
                    .chat_limited(fallback, cancel, max_output_tokens)
                    .await?;
                return Ok(ToolReply {
                    message: serde_json::json!({ "role": "assistant", "content": content }),
                    content,
                    tool_calls: Vec::new(),
                });
            }
            return Err(self.status_error(status, &bytes, None));
        }

        let mut stream = response.bytes_stream();
        let mut pending: Vec<u8> = Vec::new();
        let mut full = String::new();
        /*
         * **思考内容必须留着**：DeepSeek 带工具的下一轮要求 assistant 消息里
         * 原样带回 `reasoning_content`，否则会回 400。它不上屏（用户看正文），
         * 只随 `ToolReply.message` 一起回灌。
         */
        let mut reasoning = String::new();
        let mut calls: std::collections::BTreeMap<usize, StreamToolCall> =
            std::collections::BTreeMap::new();
        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => return Err(AiProviderError::Cancelled),
                next = stream.next() => next,
            };
            let Some(chunk) = chunk else { break };
            let bytes = chunk.map_err(|error| AiProviderError::Network(error.to_string()))?;
            pending.extend_from_slice(&bytes);
            while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = pending.drain(..=position).collect();
                if let Some(delta) =
                    Self::parse_stream_event(&line, status, &mut full, &mut reasoning, &mut calls)?
                {
                    on_delta(&delta);
                }
            }
        }
        if !pending.is_empty() {
            if let Some(delta) =
                Self::parse_stream_event(&pending, status, &mut full, &mut reasoning, &mut calls)?
            {
                on_delta(&delta);
            }
        }

        let mut native = Vec::new();
        let mut tool_calls = Vec::new();
        for (index, call) in calls {
            if call.name.trim().is_empty() {
                continue;
            }
            let id = if call.id.trim().is_empty() {
                format!("call-{index}")
            } else {
                call.id
            };
            let arguments = if call.arguments.trim().is_empty() {
                "{}".to_string()
            } else {
                call.arguments
            };
            native.push(serde_json::json!({
                "id": id,
                "type": "function",
                "function": { "name": call.name, "arguments": arguments },
            }));
            tool_calls.push(NativeToolCall {
                id,
                name: call.name,
                arguments,
            });
        }

        /*
         * **空回复当失败**：供应商返回 200 但既没有正文也没有工具调用时，以前
         * 会 `Ok("")`，界面表现为"转了半天什么都没出现"。
         */
        if full.trim().is_empty() && tool_calls.is_empty() {
            return Err(AiProviderError::Http {
                status,
                detail: "模型返回了空回复（没有正文内容）".to_string(),
            });
        }

        let has_tools = !native.is_empty();
        let mut message = if has_tools {
            serde_json::json!({ "role": "assistant", "content": full, "tool_calls": native })
        } else {
            serde_json::json!({ "role": "assistant", "content": full })
        };
        /*
         * 只有**带工具调用**的轮次才需要把思考内容回灌：纯正文轮已经结束，
         * 再传反而可能被供应商判成"非法字段"。
         */
        if has_tools && !reasoning.trim().is_empty() {
            message["reasoning_content"] = serde_json::json!(reasoning);
        }
        Ok(ToolReply {
            message,
            content: full.trim().to_string(),
            tool_calls,
        })
    }

    /// 解一行**流式工具对话**的 SSE：返回本次新增正文，同时累积 `tool_calls`
    /// 与思考内容（`reasoning_content`）。
    fn parse_stream_event(
        line: &[u8],
        status: u16,
        full: &mut String,
        reasoning: &mut String,
        calls: &mut std::collections::BTreeMap<usize, StreamToolCall>,
    ) -> Result<Option<String>, AiProviderError> {
        let text = String::from_utf8_lossy(line);
        let text = text.trim();
        let Some(data) = text.strip_prefix("data:") else {
            return Ok(None);
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return Ok(None);
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            // 心跳 / 非 JSON 行：跳过，别把整轮请求判死。
            return Ok(None);
        };
        if value.get("error").is_some() {
            return Err(AiProviderError::Http {
                status,
                detail: format!("模型流式响应报错：{}", value["error"]),
            });
        }
        let delta = &value["choices"][0]["delta"];
        // 思考内容不回调给界面（那里只显示正文），但必须完整留在 message 里。
        if let Some(thought) = delta["reasoning_content"].as_str() {
            reasoning.push_str(thought);
        }
        if let Some(items) = delta["tool_calls"].as_array() {
            for item in items {
                let index = item["index"].as_u64().unwrap_or(0) as usize;
                let entry = calls.entry(index).or_default();
                if let Some(id) = item["id"].as_str().filter(|id| !id.is_empty()) {
                    entry.id = id.to_string();
                }
                if let Some(name) = item["function"]["name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                {
                    entry.name.push_str(name);
                }
                if let Some(args) = item["function"]["arguments"].as_str() {
                    entry.arguments.push_str(args);
                }
            }
        }
        if let Some(content) = delta["content"].as_str() {
            if !content.is_empty() {
                full.push_str(content);
                return Ok(Some(content.to_string()));
            }
        }
        Ok(None)
    }

    /// 连接测试：一次**最小的**真实请求。
    ///
    /// 优先 `GET /models`（最轻、不消耗生成额度）；服务端不支持时退化为
    /// 一次只要求极少输出的 `chat/completions`。
    /// 连接测试。**尝试次数与 AI 复核同一套统计**（都来自 Provider 的重试循环）。
    pub async fn test_connection(&self) -> AiProviderTestResult {
        let started = Instant::now();
        let model = self.config.model.clone();
        let cancel = AiCancel::new();
        let attempts = std::sync::atomic::AtomicU32::new(0);
        let mut used = 0u32;
        match self.probe_models(&cancel, &attempts).await {
            Ok(()) => {
                used = attempts.load(std::sync::atomic::Ordering::Relaxed).max(1);
                AiProviderTestResult {
                    ok: true,
                    latency_ms: elapsed_ms(started),
                    model,
                    message: "连接成功（GET /models）".to_string(),
                    error_code: None,
                    attempts: used,
                }
            }
            Err(first) => {
                used = attempts.load(std::sync::atomic::Ordering::Relaxed).max(1);
                // 404/405 = 这个网关没实现 /models，换成最小生成请求再试一次。
                if matches!(
                    first,
                    AiProviderError::Http {
                        status: 404 | 405,
                        ..
                    }
                ) {
                    match self.probe_chat(&cancel, &attempts).await {
                        Ok(()) => AiProviderTestResult {
                            ok: true,
                            latency_ms: elapsed_ms(started),
                            model,
                            message: "连接成功（最小生成请求）".to_string(),
                            error_code: None,
                            attempts: attempts.load(std::sync::atomic::Ordering::Relaxed).max(1),
                        },
                        Err(error) => self.failure(started, model, error, used),
                    }
                } else {
                    self.failure(started, model, first, used)
                }
            }
        }
    }

    fn failure(
        &self,
        started: Instant,
        model: String,
        error: AiProviderError,
        attempts: u32,
    ) -> AiProviderTestResult {
        AiProviderTestResult {
            ok: false,
            latency_ms: elapsed_ms(started),
            model,
            message: error.user_message(),
            error_code: Some(error.code().to_string()),
            attempts,
        }
    }

    async fn probe_models(
        &self,
        cancel: &AiCancel,
        attempts: &std::sync::atomic::AtomicU32,
    ) -> Result<(), AiProviderError> {
        let target = url::models_url(&self.config.base_url);
        let mut attempt = 0u32;
        loop {
            if cancel.is_cancelled() {
                return Err(AiProviderError::Cancelled);
            }
            attempt += 1;
            attempts.store(attempt, std::sync::atomic::Ordering::Relaxed);
            let request = self
                .client
                .get(&target)
                .bearer_auth(&self.api_key)
                .header("accept", "application/json");
            let response = tokio::select! {
                outcome = request.send() => outcome.map_err(map_reqwest)?,
                _ = cancel.cancelled() => return Err(AiProviderError::Cancelled),
            };
            let status = response.status().as_u16();
            let retry_after = retry_after_seconds(&response);
            let body = self.read_limited(response).await?;
            if (200..300).contains(&status) {
                return Ok(());
            }
            let error = self.status_error(status, &body, retry_after);
            if !error.is_retryable() || attempt >= self.budget.max_attempts {
                return Err(error);
            }
            self.sleep_before_retry(attempt, retry_after, cancel)
                .await?;
        }
    }

    async fn probe_chat(
        &self,
        cancel: &AiCancel,
        attempts: &std::sync::atomic::AtomicU32,
    ) -> Result<(), AiProviderError> {
        let body = serde_json::json!({
            "model": self.config.model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 8,
            "stream": false,
        });
        let (status, bytes, _) = self
            .post_chat(&body, 4, true, None, cancel, attempts)
            .await?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(self.status_error(status, &bytes, None))
        }
    }

    /// 一次带有限重试的 `chat/completions` 调用。
    ///
    /// 取消点是**真的**：
    /// * 每轮开始前检查（取消后不会再发请求）；
    /// * `send()` 与 `select!` 竞争（请求还在飞也能立刻放弃）；
    /// * 退避等待与 `select!` 竞争（不会干等 8 秒）。
    async fn post_chat(
        &self,
        body: &serde_json::Value,
        max_tokens: u32,
        strict_json: bool,
        extra: Option<&serde_json::Value>,
        cancel: &AiCancel,
        attempts: &std::sync::atomic::AtomicU32,
    ) -> Result<(u16, Vec<u8>, u32), AiProviderError> {
        let target = url::completions_url(&self.config.base_url);
        let mut attempt = 0u32;
        let mut last_error: Option<AiProviderError> = None;

        while attempt < self.budget.max_attempts {
            if cancel.is_cancelled() {
                return Err(AiProviderError::Cancelled);
            }
            attempt += 1;
            attempts.store(attempt, std::sync::atomic::Ordering::Relaxed);
            let message = body["messages"].clone();
            let response = self
                .send_once(&target, max_tokens, &message, strict_json, extra, cancel)
                .await?;
            let status = response.status().as_u16();
            let retry_after = retry_after_seconds(&response);
            let bytes = self.read_limited(response).await?;
            if (200..300).contains(&status) {
                return Ok((status, bytes, attempt));
            }
            // 明确说"不认识 response_format"时，去掉它再试一次。
            if strict_json && status == 400 && mentions_response_format(&bytes) {
                let retry = self
                    .send_once(&target, max_tokens, &message, false, extra, cancel)
                    .await?;
                let retry_status = retry.status().as_u16();
                let retry_bytes = self.read_limited(retry).await?;
                if (200..300).contains(&retry_status) {
                    return Ok((retry_status, retry_bytes, attempt));
                }
                let error = self.status_error(retry_status, &retry_bytes, None);
                last_error = Some(error.clone());
                if !error.is_retryable() || attempt >= self.budget.max_attempts {
                    return Err(error);
                }
                continue;
            }
            let error = self.status_error(status, &bytes, retry_after);
            let retryable = error.is_retryable();
            last_error = Some(error.clone());
            if !retryable || attempt >= self.budget.max_attempts {
                return Err(error);
            }
            self.sleep_before_retry(attempt, retry_after, cancel)
                .await?;
        }
        Err(last_error.unwrap_or(AiProviderError::Timeout))
    }

    /// 发一次请求（**与取消信号竞争**，因此取消不会被"卡在网络里"耽误）。
    async fn send_once(
        &self,
        target: &str,
        max_tokens: u32,
        messages: &serde_json::Value,
        strict_json: bool,
        extra: Option<&serde_json::Value>,
        cancel: &AiCancel,
    ) -> Result<reqwest::Response, AiProviderError> {
        let mut payload = serde_json::json!({
            "model": self.config.model,
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "stream": false,
            "messages": messages.clone(),
        });
        if strict_json {
            // 要求结构化输出；不支持它的网关会被识别并去掉它重试一次。
            payload["response_format"] = serde_json::json!({"type": "json_object"});
        }
        // 额外字段（目前只有 Agent 的 `tools` / `tool_choice`）。
        if let Some(extra) = extra {
            if let Some(fields) = extra.as_object() {
                for (key, value) in fields {
                    payload[key] = value.clone();
                }
            }
        }
        let request = self
            .client
            .post(target)
            .bearer_auth(&self.api_key)
            .header("accept", "application/json")
            .json(&payload);
        tokio::select! {
            outcome = request.send() => outcome.map_err(map_reqwest),
            _ = cancel.cancelled() => Err(AiProviderError::Cancelled),
        }
    }

    /// 退避等待。**取消能打断等待**，不会让"取消"变成等 8 秒之后的迟到通知。
    async fn sleep_before_retry(
        &self,
        attempt: u32,
        retry_after: Option<u64>,
        cancel: &AiCancel,
    ) -> Result<(), AiProviderError> {
        let capped = retry_after
            .map(|seconds| seconds.min(self.budget.max_backoff_seconds))
            .unwrap_or_else(|| {
                self.budget
                    .base_backoff_seconds
                    .saturating_mul(1 << attempt.min(4))
                    .min(self.budget.max_backoff_seconds)
            });
        if capped == 0 {
            return Ok(());
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(capped)) => Ok(()),
            _ = cancel.cancelled() => Err(AiProviderError::Cancelled),
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
    fn status_error(&self, status: u16, body: &[u8], retry_after: Option<u64>) -> AiProviderError {
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

    async fn review(&self, prompt: &AiPrompt, cancel: &AiCancel) -> AiReviewOutcome {
        let attempts = std::sync::atomic::AtomicU32::new(0);
        let result = self.review_inner(prompt, cancel, &attempts).await;
        AiReviewOutcome {
            result,
            attempts: attempts.load(std::sync::atomic::Ordering::Relaxed).max(1),
        }
    }

    async fn draft(&self, prompt: &AiPrompt, cancel: &AiCancel) -> AiDraftOutcome {
        let attempts = std::sync::atomic::AtomicU32::new(0);
        let draft = self.draft_inner(prompt, cancel, &attempts).await;
        AiDraftOutcome {
            draft,
            attempts: attempts.load(std::sync::atomic::Ordering::Relaxed).max(1),
        }
    }
}

impl OpenAiCompatibleAdvisor {
    async fn review_inner(
        &self,
        prompt: &AiPrompt,
        cancel: &AiCancel,
        attempts: &std::sync::atomic::AtomicU32,
    ) -> Result<AiSuggestion, AiProviderError> {
        // 调用模型**之前**也检查一次：任务可能在准备阶段就被取消了。
        if cancel.is_cancelled() {
            return Err(AiProviderError::Cancelled);
        }
        let body = serde_json::json!({
            "messages": [
                {"role": "system", "content": prompt.system},
                {"role": "user", "content": render_prompt(prompt)},
            ],
        });
        let (_, bytes, _) = self
            .post_chat(
                &body,
                self.budget.max_output_tokens,
                true,
                None,
                cancel,
                attempts,
            )
            .await?;

        // 答复到手、还没解析时也可能被取消 —— 此时不该再往下走。
        if cancel.is_cancelled() {
            return Err(AiProviderError::Cancelled);
        }

        let content = extract_content(&bytes).ok_or_else(|| AiProviderError::RejectedContent {
            reason: "模型响应里没有可用的文本内容".to_string(),
            kind: AiRejectionKind::Other,
        })?;

        parse_suggestion(&content).map_err(|failure| AiProviderError::RejectedContent {
            reason: failure.reason.clone(),
            kind: failure.kind,
        })
    }

    /// 让模型产出部署草案（`draft` 的实现体）。
    ///
    /// 与 [`Self::review_inner`] 的关键区别：**不共用宽松解析器**。
    /// 草案必须是严格 Schema 的 JSON —— 未知字段、缺字段、包裹在 markdown 代码块里
    /// 都判为 `RejectedContent`，绝不"尽力修复"。理由：部署草案会直接变成计划图，
    /// 这里放过一个字段歧义，后面就没有第二道确定性校验能兜住。
    async fn draft_inner(
        &self,
        prompt: &AiPrompt,
        cancel: &AiCancel,
        attempts: &std::sync::atomic::AtomicU32,
    ) -> Result<crate::deployment::planner::AiDeploymentDraft, AiProviderError> {
        // 调用模型之前先看一次：任务可能在准备阶段就被取消。
        if cancel.is_cancelled() {
            return Err(AiProviderError::Cancelled);
        }
        let body = serde_json::json!({
            "messages": [
                {"role": "system", "content": prompt.system},
                {"role": "user", "content": render_prompt(prompt)},
            ],
        });
        let (_, bytes, _) = self
            .post_chat(
                &body,
                self.budget.max_output_tokens,
                true,
                None,
                cancel,
                attempts,
            )
            .await?;
        // 答复到手、还没解析时也可能被取消。
        if cancel.is_cancelled() {
            return Err(AiProviderError::Cancelled);
        }
        let content = extract_content(&bytes).ok_or_else(|| AiProviderError::RejectedContent {
            reason: "模型响应里没有可用的文本内容".to_string(),
            kind: AiRejectionKind::Other,
        })?;
        serde_json::from_str::<crate::deployment::planner::AiDeploymentDraft>(&content).map_err(
            |error| AiProviderError::RejectedContent {
                reason: format!("部署草案不符合严格 Schema：{error}"),
                kind: AiRejectionKind::InvalidJson,
            },
        )
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
    // `Bearer`/`authorization:` 后面的**下一个**词也要抹掉 ——
    // 按空格切分后它们是独立的一个 token，只判断前缀会漏掉那个真正的密钥。
    let mut redact_next = false;
    for token in text.split_inclusive(char::is_whitespace) {
        let body = token.trim_end();
        let suffix = &token[body.len()..];
        let lower = body.to_ascii_lowercase();
        let looks_like_key = body.starts_with("sk-")
            || lower.starts_with("api-key")
            || (body.len() >= 32 && body.chars().all(|ch| ch.is_ascii_hexdigit()));
        let is_bearer_marker = lower.trim_end_matches(':') == "bearer"
            || lower == "authorization:"
            || lower == "api-key:";
        if looks_like_key || redact_next || is_bearer_marker {
            out.push_str("<redacted>");
            redact_next = is_bearer_marker;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 整行中文解码：SSE 累积到换行后才解，汉字不会被切成两半。
    #[test]
    fn sse_line_decodes_whole_chinese_text() {
        let mut full = String::new();
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"你好，世界\"}}]}\n".as_bytes();
        let delta = OpenAiCompatibleAdvisor::parse_sse_line(line, 200, &mut full).expect("可解析");
        assert_eq!(delta.as_deref(), Some("你好，世界"));
        assert_eq!(full, "你好，世界");
    }

    /// 供应商的错误事件要带回原因，不能静默当成"没有正文"。
    #[test]
    fn sse_line_reports_provider_errors() {
        let mut full = String::new();
        let line = "data: {\"error\":{\"message\":\"context length exceeded\"}}".as_bytes();
        let error = OpenAiCompatibleAdvisor::parse_sse_line(line, 200, &mut full)
            .expect_err("错误事件应当失败");
        assert!(error.user_message().contains("context length exceeded"));
    }

    /// `[DONE]`、注释行、非 `data:` 行都不产生正文。
    #[test]
    fn sse_line_ignores_done_and_noise() {
        let mut full = String::new();
        for line in [
            &b"data: [DONE]"[..],
            &b": keep-alive"[..],
            &b"event: message"[..],
            &b"data: "[..],
        ] {
            let delta =
                OpenAiCompatibleAdvisor::parse_sse_line(line, 200, &mut full).expect("可解析");
            assert!(
                delta.is_none(),
                "不应产生正文: {}",
                String::from_utf8_lossy(line)
            );
        }
        assert!(full.is_empty());
    }
}
