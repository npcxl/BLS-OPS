//! 敏感内容检测（**只留存在性与掩码证据**）。
//!
//! # 三条底线
//!
//! 1. **明文永不离开函数**：命中的值只用来生成 [`RedactedEvidence`]（前 4 字符 +
//!    长度 + 模式名），随后即被丢弃。返回值里没有任何字段能装下原文，日志、
//!    SQLite、IPC 全链路也就拿不到明文。
//! 2. **不猜编码**：`decode_text` 解不出来就跳过（二进制当文本匹配会造假发现）。
//! 3. **预算有限**：文件数 / 单文件字节 / 总字节三道上限；到顶就停，并在报告里
//!    标 `truncated` —— 不说"已扫完"。
//!
//! # 为什么不用正则库
//!
//! 这些模式都是"固定前缀 + 定长后缀"，手写扫描既够用又少一个依赖；更重要的
//! 是这条路径处理的是**不可信输入**，逻辑越简单越容易审。

use super::limits;
use super::model::{
    FindingKind, FindingSeverity, RedactedEvidence, SecurityFinding, SecurityScanReport,
};
use super::source::{decode_text, ContentSource, SourceEntry};

/// 命中记录（算完掩码立刻丢弃原文）。
struct Hit {
    kind: FindingKind,
    pattern: &'static str,
    location: String,
    detail: String,
    evidence: RedactedEvidence,
}

/// 文件名里出现这些词，就一定扫（不管扩展名）。
const SECRET_FILE_HINTS: &[&str] = &[
    ".env",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials",
    "keystore",
    "truststore",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "kubeconfig",
    "service-account",
    "service_account",
];

/// 这些扩展名当作文本扫（二进制扩展名一律跳过）。
const TEXT_EXTENSIONS: &[&str] = &[
    "env",
    "json",
    "yml",
    "yaml",
    "properties",
    "ini",
    "conf",
    "cfg",
    "toml",
    "xml",
    "txt",
    "md",
    "sh",
    "bash",
    "zsh",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "py",
    "rb",
    "php",
    "java",
    "kt",
    "go",
    "rs",
    "cs",
    "sql",
    "gradle",
    "tf",
    "tfvars",
    "pem",
    "key",
    "crt",
    "pub",
];

/// 名字像密钥的环境变量名 / 配置键。
pub fn secret_like_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    [
        "SECRET",
        "TOKEN",
        "PASSWORD",
        "PASSWD",
        "PWD",
        "API_KEY",
        "APIKEY",
        "ACCESS_KEY",
        "PRIVATE_KEY",
        "CREDENTIAL",
        "AUTH",
        "SIGNING",
        "SALT",
        "SESSION_KEY",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

/// 扫一遍内容来源。返回**只有内容类发现**的报告（结构类由清点阶段给出）。
pub fn scan_source(source: &dyn ContentSource) -> SecurityScanReport {
    let mut report = SecurityScanReport::empty();
    let mut hits: Vec<Hit> = Vec::new();

    let candidates = candidates(source.entries());
    report.entries_checked = source.entries().len() as u64;

    for entry in candidates {
        if report.files_scanned as usize >= limits::MAX_SECRET_SCAN_FILES
            || report.bytes_scanned >= limits::MAX_SECRET_SCAN_TOTAL_BYTES
        {
            report.truncated = true;
            break;
        }
        let Some((_, bytes)) = source
            .read_many(
                &[entry.path.clone()],
                limits::MAX_SECRET_SCAN_BYTES_PER_FILE,
            )
            .into_iter()
            .next()
        else {
            continue;
        };
        report.files_scanned += 1;
        report.bytes_scanned += bytes.len() as u64;
        let Some(text) = decode_text(&bytes) else {
            continue;
        };
        // 单文件超预算：只扫前 N 字节（密钥几乎都在文件头部）。
        let text = if text.len() > limits::MAX_SECRET_SCAN_BYTES_PER_FILE {
            report.truncated = true;
            text.chars()
                .take(limits::MAX_SECRET_SCAN_BYTES_PER_FILE)
                .collect::<String>()
        } else {
            text
        };
        hits.extend(scan_text(&entry.path, &text));
    }

    report.findings = hits
        .into_iter()
        .map(|hit| SecurityFinding {
            kind: hit.kind,
            severity: hit.kind.default_severity(),
            location: hit.location,
            detail: hit.detail,
            evidence: Some(hit.evidence),
            blocking: hit.kind.blocks_import(),
        })
        .collect();
    dedup(&mut report.findings);
    report
}

/// 哪些文件值得扫（名字命中优先，其次按文本扩展名）。
fn candidates(entries: &[SourceEntry]) -> Vec<&SourceEntry> {
    let mut hinted: Vec<&SourceEntry> = Vec::new();
    let mut textual: Vec<&SourceEntry> = Vec::new();
    for entry in entries {
        if entry.is_dir {
            continue;
        }
        let lower = entry.lower_path();
        if SECRET_FILE_HINTS.iter().any(|hint| lower.contains(hint)) {
            hinted.push(entry);
            continue;
        }
        let extension = lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
        if TEXT_EXTENSIONS.contains(&extension)
            && entry.size <= limits::MAX_SECRET_SCAN_BYTES_PER_FILE as u64
        {
            textual.push(entry);
        }
    }
    hinted.sort_by(|left, right| left.path.cmp(&right.path));
    textual.sort_by(|left, right| left.path.cmp(&right.path));
    // 名字命中的一定先扫（它们最可能是真密钥文件）。
    hinted.extend(textual);
    hinted
}

/// 扫一段文本，返回命中（原文不进 Hit）。
fn scan_text(path: &str, text: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    scan_private_keys(path, text, &mut hits);
    scan_prefixed_tokens(path, text, &mut hits);
    scan_assignments(path, text, &mut hits);
    scan_cloud_files(path, text, &mut hits);
    scan_registry_tokens(path, text, &mut hits);
    hits
}

/// PEM / OpenSSH 私钥。
fn scan_private_keys(path: &str, text: &str, hits: &mut Vec<Hit>) {
    const MARKERS: &[(&str, &str)] = &[
        ("-----BEGIN RSA PRIVATE KEY-----", "pem_rsa_private_key"),
        ("-----BEGIN EC PRIVATE KEY-----", "pem_ec_private_key"),
        ("-----BEGIN DSA PRIVATE KEY-----", "pem_dsa_private_key"),
        ("-----BEGIN OPENSSH PRIVATE KEY-----", "openssh_private_key"),
        ("-----BEGIN PRIVATE KEY-----", "pem_pkcs8_private_key"),
        (
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
            "pem_encrypted_private_key",
        ),
        ("-----BEGIN PGP PRIVATE KEY BLOCK-----", "pgp_private_key"),
    ];
    for (marker, pattern) in MARKERS {
        if let Some(index) = text.find(marker) {
            hits.push(Hit {
                kind: FindingKind::PrivateKey,
                pattern,
                location: format!("{path}:{}", line_number(text, index)),
                detail: format!(
                    "发现私钥（{pattern}）：私钥绝不能进制品 —— 请改为在部署时用密钥引用注入"
                ),
                evidence: RedactedEvidence::mask(marker, pattern),
            });
            return; // 一个文件一条就够，别刷屏
        }
    }
}

/// 固定前缀的访问令牌。
fn scan_prefixed_tokens(path: &str, text: &str, hits: &mut Vec<Hit>) {
    const PREFIXES: &[(&str, &str, usize)] = &[
        ("AKIA", "aws_access_key_id", 16),
        ("ASIA", "aws_temporary_access_key_id", 16),
        ("ghp_", "github_personal_access_token", 30),
        ("gho_", "github_oauth_token", 30),
        ("ghs_", "github_app_token", 30),
        ("github_pat_", "github_fine_grained_pat", 22),
        ("glpat-", "gitlab_personal_access_token", 20),
        ("xoxb-", "slack_bot_token", 10),
        ("xoxp-", "slack_user_token", 10),
        ("xoxa-", "slack_app_token", 10),
        ("sk-ant-", "anthropic_api_key", 20),
        ("sk-", "openai_api_key", 20),
        ("AIza", "google_api_key", 35),
        ("ya29.", "google_oauth_token", 20),
        ("SG.", "sendgrid_api_key", 20),
        ("SK", "twilio_api_key", 32),
    ];
    for (prefix, pattern, min_tail) in PREFIXES {
        let mut from = 0;
        while let Some(offset) = text[from..].find(prefix) {
            let index = from + offset;
            // 前缀必须落在词首（避免 `task-` 里的 `sk-` 误报）。
            let boundary_ok = index == 0
                || !text[..index]
                    .chars()
                    .next_back()
                    .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_');
            let token = take_token(&text[index..], 256);
            if boundary_ok && token.len() >= prefix.len() + min_tail && token.len() <= 512 {
                hits.push(Hit {
                    kind: FindingKind::AccessToken,
                    pattern,
                    location: format!("{path}:{}", line_number(text, index)),
                    detail: format!(
                        "发现访问令牌（{pattern}）：请改用密钥引用，不要把令牌打进制品"
                    ),
                    evidence: RedactedEvidence::mask(&token, pattern),
                });
                break;
            }
            from = index + prefix.len();
            if from >= text.len() {
                break;
            }
        }
    }
}

/// `KEY=VALUE` 形式的赋值（.env / properties / compose environment 行）。
fn scan_assignments(path: &str, text: &str, hits: &mut Vec<Hit>) {
    for (index, line) in text.split('\n').enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_start_matches("export ").trim();
        let value = value.trim().trim_matches(['"', '\'']);
        if key.is_empty() || value.is_empty() {
            continue;
        }
        if !secret_like_key(key) {
            continue;
        }
        // 占位值不算（`${...}` / `changeme` / `your-...` / 全 x）。
        if value.starts_with("${") || value.starts_with('$') || value.len() < 6 {
            continue;
        }
        let lower_value = value.to_ascii_lowercase();
        if lower_value.contains("changeme")
            || lower_value.contains("your-")
            || lower_value.contains("example")
            || lower_value.contains("placeholder")
            || lower_value.chars().all(|ch| ch == 'x' || ch == '*')
        {
            continue;
        }
        // URL 里的凭据（`mysql://user:pass@host`）也归这一类。
        if value.contains("://") && !value.contains('@') {
            continue;
        }
        hits.push(Hit {
            kind: FindingKind::CredentialFile,
            pattern: "key_value_secret",
            location: format!("{path}:{}", index + 1),
            detail: format!(
                "疑似明文密钥（键名 {key} 像密钥且带有实际取值）：值已脱敏，建议改为密钥引用"
            ),
            evidence: RedactedEvidence::mask(value, "key_value_secret"),
        });
    }
}

/// 云凭据文件（GCP service account / AWS credentials / kubeconfig / Azure 连接串）。
fn scan_cloud_files(path: &str, text: &str, hits: &mut Vec<Hit>) {
    let lower = path.to_ascii_lowercase();
    let checks: &[(&str, &str, &str)] = &[
        (
            "\"type\": \"service_account\"",
            "gcp_service_account",
            "GCP 服务账号凭据（含私钥）",
        ),
        (
            "\"type\":\"service_account\"",
            "gcp_service_account",
            "GCP 服务账号凭据（含私钥）",
        ),
        ("aws_secret_access_key", "aws_credentials", "AWS 访问密钥"),
        ("aws_access_key_id", "aws_credentials", "AWS 访问密钥"),
        ("\"auths\"", "docker_config_auth", "Docker 仓库登录凭据"),
        (
            "DefaultEndpointsProtocol=",
            "azure_connection_string",
            "Azure 存储连接串",
        ),
        ("AccountKey=", "azure_account_key", "Azure 存储账户密钥"),
        ("client_secret", "oauth_client_secret", "OAuth 客户端密钥"),
    ];
    for (needle, pattern, description) in checks {
        if let Some(index) = text.find(needle) {
            // 只对"凭据文件"或明显像密钥的上下文报警，避免误伤正常代码。
            let file_is_credential = lower.contains("credentials")
                || lower.contains("service-account")
                || lower.contains("service_account")
                || lower.contains("kubeconfig")
                || lower.contains(".docker")
                || lower.contains(".env")
                || needle.starts_with("DefaultEndpointsProtocol")
                || needle.starts_with("AccountKey");
            if !file_is_credential {
                continue;
            }
            hits.push(Hit {
                kind: if needle.contains("docker") {
                    FindingKind::DockerRegistryAuth
                } else {
                    FindingKind::CloudCredential
                },
                pattern,
                location: format!("{path}:{}", line_number(text, index)),
                detail: format!("发现{description}：请移到密钥引用，不要随制品分发"),
                evidence: RedactedEvidence::mask(needle, pattern),
            });
            return;
        }
    }
}

/// 包管理器 / 镜像仓库令牌（.npmrc、.pypirc、.docker/config.json）。
fn scan_registry_tokens(path: &str, text: &str, hits: &mut Vec<Hit>) {
    let lower = path.to_ascii_lowercase();
    let registry_file = lower.ends_with(".npmrc")
        || lower.ends_with(".pypirc")
        || lower.ends_with(".netrc")
        || lower.contains(".docker/config.json");
    if !registry_file {
        return;
    }
    for marker in ["_authToken", "_password", "auth =", "\"auth\""] {
        if let Some(index) = text.find(marker) {
            let tail = take_token(&text[index + marker.len()..], 256);
            let value = tail
                .trim_start_matches(['=', ' ', ':', '"'])
                .trim_end_matches(['"', ',']);
            if value.len() < 6 {
                continue;
            }
            hits.push(Hit {
                kind: FindingKind::PackageRegistryToken,
                pattern: "registry_token",
                location: format!("{path}:{}", line_number(text, index)),
                detail: "发现包管理器 / 镜像仓库令牌：请改为在部署时注入密钥引用".to_string(),
                evidence: RedactedEvidence::mask(value, "registry_token"),
            });
            return;
        }
    }
}

/// 从 `text` 起点取出一个"令牌样"的连续片段（到空白 / 引号 / 结构字符为止）。
fn take_token(text: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(max) {
        if ch.is_whitespace()
            || matches!(
                ch,
                '"' | '\'' | ',' | ';' | ')' | '(' | '<' | '>' | '`' | '\\'
            )
        {
            break;
        }
        out.push(ch);
    }
    out
}

/// 第几行（1 起算）—— 证据定位到行，方便用户自己去改。
fn line_number(text: &str, index: usize) -> usize {
    text[..index.min(text.len())].matches('\n').count() + 1
}

/// 去重：同一文件同一模式只报一次。
fn dedup(findings: &mut Vec<SecurityFinding>) {
    let mut seen: Vec<(FindingKind, String)> = Vec::new();
    findings.retain(|finding| {
        let key = (finding.kind, finding.location.clone());
        if seen.contains(&key) {
            false
        } else {
            seen.push(key);
            true
        }
    });
}

/// 把清点阶段的结构性发现与内容类发现合并成一份报告。
pub fn merge(structural: Vec<SecurityFinding>, content: SecurityScanReport) -> SecurityScanReport {
    let mut findings = structural;
    findings.extend(content.findings);
    dedup(&mut findings);
    findings.sort_by_key(|finding| std::cmp::Reverse(finding.severity));
    SecurityScanReport {
        findings,
        entries_checked: content.entries_checked,
        files_scanned: content.files_scanned,
        bytes_scanned: content.bytes_scanned,
        truncated: content.truncated,
    }
}

/// 严重级别的人话（UI 直接用）。
pub fn severity_label(severity: FindingSeverity) -> &'static str {
    match severity {
        FindingSeverity::Info => "提示",
        FindingSeverity::Low => "低",
        FindingSeverity::Medium => "中",
        FindingSeverity::High => "高",
        FindingSeverity::Critical => "阻断",
    }
}
