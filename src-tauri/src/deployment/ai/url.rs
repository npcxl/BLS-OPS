//! `base_url` 校验与 SSRF 说明。
//!
//! # 允许什么
//!
//! * 协议：**只有** `http` 与 `https`。`file:` / `ftp:` / `gopher:` / `data:` /
//!   `javascript:` 之类一律拒绝 —— 它们不是"另一个模型服务"，而是把请求
//!   变成读本地文件或别的协议探测。
//! * 主机：域名或 IP 字面量。
//! * 路径：可选（常见是 `/v1`），不允许 `.` / `..` 段。
//! * 端口：可选，1–65535。
//!
//! # 拒绝什么（每一条都对应一种真实的坑）
//!
//! * **URL 里带用户名 / 密码**：`https://user:pass@host/v1` —— 凭据会进
//!   错误信息与日志，而我们已经有钥匙串了。
//! * **query / fragment**：`?key=...`、`#...` 常常是"顺手把密钥塞进 URL"，
//!   也会让同名配置产生不同哈希。要授权就用钥匙串。
//! * **非本地的 `http`**：明文把 API Key 与提示词送上网。除非用户显式打开
//!   高风险开关（[`BaseUrlPolicy::allow_insecure_http`]），否则拒绝。
//! * **空主机 / 非法端口 / 控制字符**。
//!
//! # SSRF：我们的立场
//!
//! 这是**桌面应用**，用户就是发起人：本地模型（`http://127.0.0.1:11434/v1`）
//! 与内网自建网关是**正当用法**，因此我们**不**屏蔽环回与私网地址 —— 屏蔽它们
//! 才是"为了安全而让人没法用"。我们做的是：
//!
//! 1. 只允许 http(s)，别的协议连门都没有；
//! 2. 非本地 http 必须显式开启高风险选项（默认拒绝）；
//! 3. **不跟随重定向**（`reqwest` 侧设 `Policy::none()`），不给"跳到别处"的机会；
//! 4. 响应体有硬上限，且**永远不回显请求头 / 原始响应**给前端。
//!
//! 换句话说：我们防的是"配置被误导着指向不该去的地方"，而不是假装能把
//! 用户自己的网络权限收走。

use super::model::AiProviderError;

/// 是否允许非本地的明文 http。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BaseUrlPolicy {
    /// 默认 `false`：非本地的 `http://` 会被拒绝。
    pub allow_insecure_http: bool,
}

impl Default for BaseUrlPolicy {
    fn default() -> Self {
        Self {
            allow_insecure_http: false,
        }
    }
}

/// 环回 / 本机别名。这些地址上的 `http` 是允许的（本地模型）。
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(|ch| ch == '[' || ch == ']').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(address) => address.is_loopback(),
        Err(_) => false,
    }
}

/// 私网 / 链路本地地址（只用于给出更准确的提示文案，不用于放行）。
pub fn is_private_host(host: &str) -> bool {
    let host = host.trim_matches(|ch| ch == '[' || ch == ']').to_ascii_lowercase();
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(address)) => {
            address.is_private() || address.is_link_local() || address.is_unspecified()
        }
        Ok(std::net::IpAddr::V6(address)) => {
            address.is_loopback() || address.is_unspecified() || (address.segments()[0] & 0xfe00) == 0xfc00
        }
        Err(_) => false,
    }
}

/// 校验并规范化 `base_url`（去掉尾部 `/`）。
pub fn validate_base_url(raw: &str, policy: BaseUrlPolicy) -> Result<String, AiProviderError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AiProviderError::InvalidConfig(
            "Base URL 不能为空".to_string(),
        ));
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err(AiProviderError::InvalidConfig(
            "Base URL 不能包含控制字符".to_string(),
        ));
    }
    if value.chars().any(char::is_whitespace) {
        return Err(AiProviderError::InvalidConfig(
            "Base URL 不能包含空格".to_string(),
        ));
    }

    let (secure, rest) = if let Some(rest) = value.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = value.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err(AiProviderError::InvalidConfig(
            "Base URL 必须以 https:// 或 http:// 开头（不支持其它协议）".to_string(),
        ));
    };

    if rest.is_empty() {
        return Err(AiProviderError::InvalidConfig(
            "Base URL 缺少主机名".to_string(),
        ));
    }
    if rest.contains('@') {
        return Err(AiProviderError::InvalidConfig(
            "Base URL 不能携带用户名或密码：凭据请放在钥匙串里".to_string(),
        ));
    }
    if rest.contains('?') || rest.contains('#') {
        return Err(AiProviderError::InvalidConfig(
            "Base URL 不能包含 query 或 fragment（密钥不要写在 URL 里）".to_string(),
        ));
    }

    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, String::new()),
    };
    if authority.is_empty() {
        return Err(AiProviderError::InvalidConfig(
            "Base URL 缺少主机名".to_string(),
        ));
    }

    // 主机与端口。IPv6 字面量用 `[::1]` 形式。
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']').ok_or_else(|| {
            AiProviderError::InvalidConfig("IPv6 主机名缺少右方括号".to_string())
        })?;
        let port = match tail.strip_prefix(':') {
            Some(port) => Some(port),
            None if tail.is_empty() => None,
            None => {
                return Err(AiProviderError::InvalidConfig(
                    "主机名与端口格式不正确".to_string(),
                ))
            }
        };
        (host.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), Some(port)),
            None => (authority.to_string(), None),
        }
    };

    if host.is_empty() {
        return Err(AiProviderError::InvalidConfig(
            "Base URL 缺少主机名".to_string(),
        ));
    }
    let host_ok = host
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':'))
        || host.parse::<std::net::IpAddr>().is_ok();
    if !host_ok || host.starts_with('.') || host.ends_with('.') {
        return Err(AiProviderError::InvalidConfig(format!(
            "主机名格式不正确：{host}"
        )));
    }
    if let Some(port) = port {
        let parsed: u32 = port
            .parse()
            .map_err(|_| AiProviderError::InvalidConfig(format!("端口不是数字：{port}")))?;
        if parsed == 0 || parsed > 65_535 {
            return Err(AiProviderError::InvalidConfig(format!(
                "端口必须在 1 到 65535 之间：{port}"
            )));
        }
    }

    // 路径不能有 `..`（否则可能被用来"跳出"网关前缀）。
    for segment in path.split('/') {
        if segment == ".." {
            return Err(AiProviderError::InvalidConfig(
                "Base URL 的路径不能包含 ..".to_string(),
            ));
        }
    }

    // 明文 http 只允许本机（本地模型），其余必须 https 或显式开启高风险选项。
    if !secure && !is_loopback_host(&host) && !policy.allow_insecure_http {
        let hint = if is_private_host(&host) {
            "内网地址"
        } else {
            "公网地址"
        };
        return Err(AiProviderError::InvalidConfig(format!(
            "非本机的 {hint} 必须使用 https（明文 http 会把 API Key 和提示词直接送上网）。\
             如果这是你自建的受信网关，请在设置里显式开启“允许明文 http”"
        )));
    }

    let mut normalized = format!(
        "{}://{}{}",
        if secure { "https" } else { "http" },
        authority,
        path
    );
    while normalized.ends_with('/') {
        normalized.pop();
    }
    Ok(normalized)
}

/// 拼出 `chat/completions` 的完整地址。
pub fn completions_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    format!("{base}/chat/completions")
}

/// 拼出 `models` 地址（连接测试优先用它：最轻的一次真实请求）。
pub fn models_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    format!("{base}/models")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(raw: &str) -> String {
        validate_base_url(raw, BaseUrlPolicy::default()).expect("应当通过")
    }

    #[test]
    fn https_anywhere_is_fine() {
        assert_eq!(ok("https://api.example.com/v1"), "https://api.example.com/v1");
        // 尾部斜杠会被规范掉（同一份配置不该有两种写法）。
        assert_eq!(ok("https://api.example.com/v1/"), "https://api.example.com/v1");
        assert_eq!(ok("  https://api.example.com  "), "https://api.example.com");
    }

    #[test]
    fn loopback_http_is_allowed_for_local_models() {
        assert_eq!(ok("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
        assert_eq!(ok("http://localhost:8000/v1"), "http://localhost:8000/v1");
        assert_eq!(ok("http://[::1]:8080/v1"), "http://[::1]:8080/v1");
    }

    #[test]
    fn non_local_http_is_blocked_until_explicitly_allowed() {
        let error = validate_base_url("http://api.example.com/v1", BaseUrlPolicy::default())
            .expect_err("公网明文 http 必须被拒");
        assert_eq!(error.code(), "invalid_config");
        assert!(error.user_message().contains("https"), "{}", error.user_message());

        // 内网同样默认拒绝（提示文案会说是内网）。
        let private =
            validate_base_url("http://10.0.0.5:8000/v1", BaseUrlPolicy::default()).expect_err("内网明文也要显式允许");
        assert!(private.user_message().contains("内网"), "{}", private.user_message());

        // 显式开启后才放行。
        let allowed = validate_base_url(
            "http://api.example.com/v1",
            BaseUrlPolicy {
                allow_insecure_http: true,
            },
        )
        .expect("显式允许后应通过");
        assert_eq!(allowed, "http://api.example.com/v1");
    }

    #[test]
    fn other_schemes_are_rejected_outright() {
        for raw in [
            "ftp://api.example.com",
            "file:///etc/passwd",
            "gopher://127.0.0.1:6379",
            "data:text/plain,hello",
            "api.example.com/v1",
        ] {
            let error = validate_base_url(raw, BaseUrlPolicy::default())
                .expect_err("必须拒绝非 http(s)");
            assert!(
                error.user_message().contains("https://"),
                "{raw} → {}",
                error.user_message()
            );
        }
    }

    #[test]
    fn credentials_in_the_url_are_rejected() {
        let error = validate_base_url("https://user:pass@api.example.com/v1", BaseUrlPolicy::default())
            .expect_err("不能携带凭据");
        assert!(error.user_message().contains("钥匙串"), "{}", error.user_message());
    }

    #[test]
    fn query_and_fragment_are_rejected() {
        assert!(validate_base_url("https://api.example.com/v1?key=abc", BaseUrlPolicy::default()).is_err());
        assert!(validate_base_url("https://api.example.com/v1#x", BaseUrlPolicy::default()).is_err());
    }

    #[test]
    fn malformed_hosts_and_ports_are_rejected() {
        assert!(validate_base_url("https://", BaseUrlPolicy::default()).is_err());
        assert!(validate_base_url("https:///v1", BaseUrlPolicy::default()).is_err());
        assert!(validate_base_url("https://api.example.com:0/v1", BaseUrlPolicy::default()).is_err());
        assert!(validate_base_url("https://api.example.com:99999/v1", BaseUrlPolicy::default()).is_err());
        assert!(validate_base_url("https://api.example.com:abc/v1", BaseUrlPolicy::default()).is_err());
        // 路径里的 `..` 会被用来跳出网关前缀。
        assert!(validate_base_url("https://api.example.com/../admin", BaseUrlPolicy::default()).is_err());
        // 空格与控制字符。
        assert!(validate_base_url("https://api.example.com/v 1", BaseUrlPolicy::default()).is_err());
        assert!(validate_base_url("https://api.example.com/v\n1", BaseUrlPolicy::default()).is_err());
    }

    #[test]
    fn completions_and_models_urls_are_appended_once() {
        assert_eq!(
            completions_url("https://api.example.com/v1"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(completions_url("https://api.example.com/v1/"), "https://api.example.com/v1/chat/completions");
        assert_eq!(models_url("https://api.example.com/v1"), "https://api.example.com/v1/models");
    }
}
