//! Provider 层测试。
//!
//! **全部走本地 Mock HTTP Server**：不依赖真实模型、不需要任何真实 API Key、
//! 不需要联网。这样"错误处理 / 重试 / 脱敏 / 严格解析"这些最容易出错的地方
//! 才真的被测到 —— 用真模型反而测不了 401 和 429。
//!
//! Mock server 用 `std::net::TcpListener` + 一个后台线程手写实现（不引 dev 依赖）：
//! 它只需要能做三件事 —— 收一个请求、按脚本回一个响应、把收到的请求记下来
//! 供断言。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::sync::{Arc, Mutex};

use super::model::*;
use super::provider::{parse_suggestion, AiAdvisor, OpenAiCompatibleAdvisor};
use super::url::{validate_base_url, BaseUrlPolicy};
use crate::deployment::proposal::ai::{AiPrompt, AiReviewFailure};
use crate::deployment::proposal::model::AiRejectionKind;

type Requests = Arc<Mutex<Vec<String>>>;

/// 一个会按脚本回答的极简 HTTP server。
struct MockServer {
    addr: SocketAddr,
    requests: Requests,
}

/// 脚本中的一次回答。
#[derive(Clone)]
enum Reply {
    /// 状态 + JSON 正文。
    Json(u16, String),
    /// 状态 + 额外响应头 + 正文。
    Raw {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: String,
    },
    /// 先睡一会儿再回答（模拟超时）。
    Slow(u64),
}

impl MockServer {
    fn spawn(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let requests: Requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        std::thread::spawn(move || {
            let mut index = 0usize;
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let request = read_request(&mut stream);
                if let Ok(mut captured) = captured.lock() {
                    captured.push(request);
                }
                let reply = replies
                    .get(index)
                    .cloned()
                    .or_else(|| replies.last().cloned())
                    .unwrap_or(Reply::Json(500, "{}".to_string()));
                index += 1;
                write_reply(&mut stream, reply);
            }
        });
        Self { addr, requests }
    }

    fn base_url(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    fn requests(&self) -> Vec<String> {
        self.requests
            .lock()
            .map(|list| list.clone())
            .unwrap_or_default()
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> String {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&buffer).to_string();
                if let Some(header_end) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|line| {
                            let lower = line.to_ascii_lowercase();
                            lower
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if buffer.len() >= header_end + 4 + length {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buffer).to_string()
}

fn write_reply(stream: &mut std::net::TcpStream, reply: Reply) {
    let (status, headers, body) = match reply {
        Reply::Json(status, body) => (status, Vec::new(), body),
        Reply::Raw {
            status,
            headers,
            body,
        } => (status, headers, body),
        Reply::Slow(seconds) => {
            std::thread::sleep(std::time::Duration::from_secs(seconds));
            (
                200,
                Vec::new(),
                chat_body("{\"notes\":[],\"alternatives\":[]}"),
            )
        }
    };
    let mut response = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
        if status == 200 { "OK" } else { "ERR" },
        body.len()
    );
    for (name, value) in headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(&body);
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn chat_body(content: &str) -> String {
    serde_json::json!({
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20},
    })
    .to_string()
}

fn config(base_url: &str) -> AiProviderConfig {
    let mut config = AiProviderConfig::new("p1", "本地 mock", 1);
    config.base_url = base_url.to_string();
    config.model = "mock-model".to_string();
    config.timeout_seconds = 5;
    // 测试用环回地址，`http` 是允许的。
    config
}

fn advisor(server: &MockServer, key: &str) -> OpenAiCompatibleAdvisor {
    OpenAiCompatibleAdvisor::new(config(&server.base_url()), key.to_string(), false)
        .expect("advisor")
}

fn prompt() -> AiPrompt {
    AiPrompt {
        system: "你是复核者".to_string(),
        payload: serde_json::json!({"deterministic_proposal": {"summary": "x"}}),
    }
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    // 仓库没有 tokio 的 dev-dependency；tauri 的 async_runtime 已经提供了
    // 运行时，测试直接复用它。
    tauri::async_runtime::block_on(future)
}

// -- 连接测试 ----------------------------------------------------------------

#[test]
fn a_successful_connection_is_reported_with_latency_and_model() {
    let server = MockServer::spawn(vec![Reply::Json(200, "{\"data\":[]}".to_string())]);
    let advisor = advisor(&server, "sk-secret-key-value");
    let result = block_on(advisor.test_connection());
    assert!(result.ok, "{}", result.message);
    assert_eq!(result.model, "mock-model");
    assert!(result.error_code.is_none());
    // 请求确实发出了，而且带的是 Bearer 头（不是把 Key 拼进 URL）。
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /v1/models"));
    assert!(
        requests[0].contains("authorization: Bearer sk-secret-key-value")
            || requests[0].contains("Authorization: Bearer sk-secret-key-value")
    );
}

#[test]
fn a_gateway_without_models_endpoint_falls_back_to_a_minimal_generation() {
    let server = MockServer::spawn(vec![
        Reply::Json(404, "{\"error\":\"not found\"}".to_string()),
        Reply::Json(200, chat_body("{}")),
    ]);
    let advisor = advisor(&server, "sk-x");
    let result = block_on(advisor.test_connection());
    assert!(result.ok, "{}", result.message);
    assert!(result.message.contains("最小生成请求"));
    assert_eq!(server.requests().len(), 2);
}

#[test]
fn an_invalid_key_is_reported_as_an_auth_failure_and_never_retried() {
    let server = MockServer::spawn(vec![Reply::Json(
        401,
        "{\"error\":{\"message\":\"invalid api key sk-abcdef0123456789\"}}".to_string(),
    )]);
    let advisor = advisor(&server, "sk-secret-key-value");
    let result = block_on(advisor.test_connection());
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some("auth"));
    // 只请求一次：认证失败重试没有意义。
    assert_eq!(server.requests().len(), 1);
    // 脱敏：既不回显我们自己的 Key，也不回显服务端回显出来的那串。
    assert!(
        !result.message.contains("sk-secret-key-value"),
        "{}",
        result.message
    );
    assert!(
        !result.message.contains("sk-abcdef0123456789"),
        "{}",
        result.message
    );
    assert!(result.message.contains("<redacted>"), "{}", result.message);
}

#[test]
fn a_forbidden_response_is_reported_as_auth_too() {
    let server = MockServer::spawn(vec![Reply::Json(
        403,
        "{\"error\":\"forbidden\"}".to_string(),
    )]);
    let advisor = advisor(&server, "sk-x");
    let result = block_on(advisor.test_connection());
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some("auth"));
}

#[test]
fn rate_limiting_is_retried_within_budget_then_succeeds() {
    let server = MockServer::spawn(vec![
        Reply::Raw {
            status: 429,
            headers: vec![("retry-after", "0".to_string())],
            body: "{\"error\":\"slow down\"}".to_string(),
        },
        Reply::Json(200, "{\"data\":[]}".to_string()),
    ]);
    let advisor = advisor(&server, "sk-x");
    let result = block_on(advisor.test_connection());
    assert!(result.ok, "限流后重试应当成功：{}", result.message);
    assert_eq!(server.requests().len(), 2);
}

#[test]
fn rate_limiting_that_never_clears_reports_a_rate_limit_error() {
    let server = MockServer::spawn(vec![Reply::Raw {
        status: 429,
        headers: vec![("retry-after", "0".to_string())],
        body: "{\"error\":\"slow down\"}".to_string(),
    }]);
    let advisor = advisor(&server, "sk-x");
    let result = block_on(advisor.test_connection());
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some("rate_limited"));
    // 有上限：不会无限重试。
    let attempts = server.requests().len();
    assert!(
        (1..=3).contains(&attempts),
        "重试次数应当有上限，实际 {attempts}"
    );
}

#[test]
fn a_server_error_is_retried_and_then_reported_redacted() {
    let server = MockServer::spawn(vec![Reply::Json(
        500,
        "{\"error\":\"internal boom sk-1234567890abcdefghij\"}".to_string(),
    )]);
    let advisor = advisor(&server, "sk-x");
    let result = block_on(advisor.test_connection());
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some("http"));
    assert!(
        !result.message.contains("sk-1234567890abcdefghij"),
        "{}",
        result.message
    );
}

// -- 复核调用 ----------------------------------------------------------------

#[test]
fn a_clean_json_answer_is_parsed_into_notes() {
    let content = serde_json::json!({
        "notes": [{"text": "建议补充回滚演练记录", "target": "rollback", "evidence_ids": [], "confidence": 80}],
        "alternatives": ["可以考虑对象存储托管静态站点"],
        "open_questions": ["上线窗口是什么时候？"],
        "knowledge_citations": []
    })
    .to_string();
    let server = MockServer::spawn(vec![Reply::Json(200, chat_body(&content))]);
    let advisor = advisor(&server, "sk-x");
    let suggestion = block_on(advisor.review(&prompt())).expect("应当解析成功");
    assert_eq!(suggestion.notes.len(), 1);
    assert_eq!(suggestion.notes[0].confidence, Some(80));
    assert_eq!(suggestion.alternatives.len(), 1);
    assert_eq!(suggestion.open_questions.len(), 1);
}

#[test]
fn the_request_body_carries_the_prompt_but_never_the_key() {
    let server = MockServer::spawn(vec![Reply::Json(
        200,
        chat_body("{\"notes\":[],\"alternatives\":[]}"),
    )]);
    let advisor = advisor(&server, "sk-top-secret");
    let _ = block_on(advisor.review(&prompt()));
    let request = server.requests().join("\n");
    // 提示词进去了（system + 分区输入）。
    assert!(request.contains("你是复核者"), "提示词应当发出去");
    assert!(request.contains("deterministic_proposal"));
    // 密钥只在 Authorization 头里出现一次，正文里没有。
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
    assert!(!body.contains("sk-top-secret"), "正文里不能出现密钥");
}

#[test]
fn markdown_code_fences_are_rejected() {
    let content = "```json\n{\"notes\":[],\"alternatives\":[]}\n```";
    let server = MockServer::spawn(vec![Reply::Json(200, chat_body(content))]);
    let advisor = advisor(&server, "sk-x");
    let error = block_on(advisor.review(&prompt())).expect_err("必须拒绝");
    match error {
        AiProviderError::RejectedContent { kind, .. } => {
            assert_eq!(kind, AiRejectionKind::Markdown)
        }
        other => panic!("错误类型不对：{other:?}"),
    }
}

#[test]
fn invalid_json_is_rejected() {
    let server = MockServer::spawn(vec![Reply::Json(200, chat_body("这不是 JSON"))]);
    let advisor = advisor(&server, "sk-x");
    let error = block_on(advisor.review(&prompt())).expect_err("必须拒绝");
    match error {
        AiProviderError::RejectedContent { kind, .. } => {
            assert_eq!(kind, AiRejectionKind::InvalidJson)
        }
        other => panic!("错误类型不对：{other:?}"),
    }
}

#[test]
fn an_unknown_field_is_rejected_instead_of_being_ignored() {
    let content = "{\"notes\":[],\"alternatives\":[],\"command\":\"rm -rf /\"}";
    let failure = parse_suggestion(content).expect_err("未知字段必须被拒");
    assert_eq!(failure.kind, AiRejectionKind::UnknownField);
    assert!(
        failure.reason.contains("unknown field"),
        "{}",
        failure.reason
    );
}

#[test]
fn prose_around_the_json_is_tolerated_but_a_missing_object_is_not() {
    // 兼容现实：模型常常前后各说一句话。
    let parsed =
        parse_suggestion("好的，我的建议如下：{\"notes\":[],\"alternatives\":[\"a\"]} 以上。")
            .expect("应当能抠出 JSON");
    assert_eq!(parsed.alternatives.len(), 1);
    // 完全没有 JSON 对象 → 明确拒绝。
    assert!(parse_suggestion("我认为这个方案不错。").is_err());
}

#[test]
fn confidence_accepts_numbers_and_strings_and_is_clamped() {
    let content = "{\"notes\":[{\"text\":\"a\",\"confidence\":\"85\"},{\"text\":\"b\",\"confidence\":900}],\"alternatives\":[]}";
    let suggestion = parse_suggestion(content).expect("应当解析成功");
    assert_eq!(suggestion.notes[0].confidence, Some(85));
    assert_eq!(suggestion.notes[1].confidence, Some(100));
}

#[test]
fn citation_versions_accept_both_numbers_and_system_labels() {
    let content = "{\"notes\":[],\"alternatives\":[],\"knowledge_citations\":[{\"knowledge_id\":\"k1\",\"version\":2},{\"knowledge_id\":\"kb\",\"version\":\"kb-2026.09.1\"}]}";
    let suggestion = parse_suggestion(content).expect("应当解析成功");
    assert_eq!(suggestion.knowledge_citations[0].version, "2");
    assert_eq!(suggestion.knowledge_citations[1].version, "kb-2026.09.1");
}

#[test]
fn a_gateway_that_rejects_response_format_gets_a_second_chance_without_it() {
    let server = MockServer::spawn(vec![
        Reply::Json(
            400,
            "{\"error\":\"unsupported parameter: response_format\"}".to_string(),
        ),
        Reply::Json(200, chat_body("{\"notes\":[],\"alternatives\":[]}")),
    ]);
    let advisor = advisor(&server, "sk-x");
    let suggestion = block_on(advisor.review(&prompt())).expect("去掉 response_format 后应当成功");
    assert!(suggestion.notes.is_empty());
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].contains("你是复核者"));
    assert!(!requests[1].contains("response_format"), "第二次不该再带它");
}

#[test]
fn an_oversized_response_is_refused_instead_of_being_read_whole() {
    let huge = chat_body(&"x".repeat(200 * 1024));
    let server = MockServer::spawn(vec![Reply::Json(200, huge)]);
    let advisor = advisor(&server, "sk-x");
    let error = block_on(advisor.review(&prompt())).expect_err("必须拒绝超大响应");
    assert_eq!(error.code(), "response_too_large");
}

/// 真实超时：Mock 睡 8 秒，预算被夹到最小值 5 秒 → 必然超时。
///
/// 这个用例**故意慢**（约 5 秒）：它是唯一能证明"我们真的会放弃一个卡住的
/// 模型服务"的方式。超时后不允许重试（同一份预算里连试 3 次会把界面卡 15 秒）。
#[test]
fn a_stalled_server_hits_the_timeout_and_is_not_retried_forever() {
    let server = MockServer::spawn(vec![Reply::Slow(8)]);
    let mut config = config(&server.base_url());
    config.timeout_seconds = 5;
    let advisor = OpenAiCompatibleAdvisor::new(config, "sk-x".to_string(), false).expect("advisor");
    let error = block_on(advisor.review(&prompt())).expect_err("必须超时");
    assert_eq!(error.code(), "timeout");
    assert_eq!(error.user_message(), "请求模型超时");
}

// -- 脱敏 --------------------------------------------------------------------

#[test]
fn the_debug_impl_never_prints_the_key() {
    let server = MockServer::spawn(vec![Reply::Json(200, "{}".to_string())]);
    let advisor = advisor(&server, "sk-very-secret-value");
    let text = format!("{advisor:?}");
    assert!(!text.contains("sk-very-secret-value"), "{text}");
    assert!(text.contains("<redacted>"), "{text}");
}

#[test]
fn server_messages_are_scrubbed_of_key_like_tokens() {
    let scrubbed = super::provider::sanitize_server_message(
        "bad key sk-abcdef0123456789 and Bearer zzzzzz and 0123456789abcdef0123456789abcdef",
        "sk-abcdef0123456789",
    );
    assert!(!scrubbed.contains("sk-abcdef0123456789"), "{scrubbed}");
    assert!(!scrubbed.contains("zzzzzz"), "{scrubbed}");
    assert!(
        !scrubbed.contains("0123456789abcdef0123456789abcdef"),
        "{scrubbed}"
    );
    assert!(scrubbed.contains("<redacted>"), "{scrubbed}");
}

#[test]
fn a_missing_key_is_a_config_error_not_a_request() {
    let error =
        OpenAiCompatibleAdvisor::new(config("https://api.example.com/v1"), String::new(), false)
            .expect_err("没有密钥就该拒绝");
    assert_eq!(error.code(), "invalid_config");
}

// -- 与合并层的接口 ----------------------------------------------------------

#[test]
fn review_failures_keep_their_classification() {
    let failure = AiReviewFailure::provider("connection refused");
    assert!(failure.is_provider_failure());
    let rejected = parse_suggestion("### hi").expect_err("非 JSON 内容必须被拒");
    assert!(!rejected.is_provider_failure(), "内容被拒 ≠ 请求失败");
    assert_eq!(rejected.kind, AiRejectionKind::InvalidJson);
}

#[test]
fn base_url_validation_is_reused_by_the_provider() {
    // 明文公网 http 在默认策略下会被 Provider 构造拦住（不是等到发请求）。
    let mut config = config("http://api.example.com/v1");
    config.model = "m".to_string();
    let error =
        OpenAiCompatibleAdvisor::new(config, "sk-x".to_string(), false).expect_err("应当被拒");
    assert_eq!(error.code(), "invalid_config");
    assert!(validate_base_url("https://api.example.com/v1", BaseUrlPolicy::default()).is_ok());
}
