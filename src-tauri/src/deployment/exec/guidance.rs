//! DNS 与证书的**指导层**：V1 只做"人工配置指引 + 自动解析验证"，
//! 并预留服务商适配器接口。
//!
//! # 为什么 V1 不接服务商 API
//!
//! 自动写 DNS 记录意味着把用户的 API Token 放进部署路径里，而 DNS 记录写错的
//! 后果是**整站解析崩掉**（不只是这一台机器）。在"验证解析"这一步都没有跑顺
//! 之前接入自动写入，风险与收益不成比例。所以：
//!
//! * [`DnsProvider`] 是接口，V1 只有一个 [`ManualDnsProvider`]（`supports_automation() == false`）；
//! * 新增服务商 = 实现这个 trait + 注册到 [`registered_providers()`]，
//!   **不需要改动作模型**（DNS 写入从来不是动作，记录内容也不进执行路径）；
//! * 想用自动写入的域名，由 `IssueCertificate` 的 `dns_provider` 字段声明 ——
//!   而校验层只接受 `manual`，因此现在**没有**任何自动写入的路径存在。
//!
//! # 挑战方式的选择（泛域名只能 DNS-01）
//!
//! `*.example.com` 无法用 HTTP-01 验证（CA 只能验具体主机名），因此
//! [`certificate_plan`] 会为泛域名强制 `Dns01`；任何试图用 HTTP-01 签泛域名的
//! 组合都会得到 `blocked_reason`，而不是"试一下看看"。

use crate::deployment::action::model::CertificateChallenge;
use crate::deployment::model::{DnsStatus, DomainBinding, EnvironmentKind, SslMode};

/// 要让用户在 DNS 上添加的一条记录。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DnsRecordInstruction {
    /// `A` / `AAAA` / `CNAME` / `TXT`。
    pub record_type: String,
    /// 记录名（相对域名或 `@`）。
    pub name: String,
    /// 记录值（HTTP-01 的 TXT 值由 CA 在签发时给出，这里如实留占位说明）。
    pub value: String,
    /// 这条记录是干什么的（人话）。
    pub purpose: String,
}

/// DNS 服务商适配器。
///
/// **V1 的边界写在类型上**：只有 `supports_automation() == false` 的实现存在。
pub trait DnsProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    /// 是否支持自动写入记录。V1 全部为 `false`。
    fn supports_automation(&self) -> bool;
    /// 这个域名需要哪些记录（由 provider 决定表述细节）。
    fn instructions(&self, binding: &DomainBinding) -> Vec<DnsRecordInstruction>;
}

/// 人工 DNS（V1 唯一的实现）。
pub struct ManualDnsProvider;

impl DnsProvider for ManualDnsProvider {
    fn id(&self) -> &'static str {
        "manual"
    }

    fn name(&self) -> &'static str {
        "人工配置"
    }

    fn supports_automation(&self) -> bool {
        false
    }

    fn instructions(&self, binding: &DomainBinding) -> Vec<DnsRecordInstruction> {
        let target = binding.domain.trim_start_matches("*.");
        vec![
            DnsRecordInstruction {
                record_type: "A".to_string(),
                name: if target == binding.domain {
                    "@".to_string()
                } else {
                    format!("*.{}", target.split('.').next().unwrap_or("@"))
                },
                value: "<服务器公网 IP>".to_string(),
                purpose: "把域名（含泛解析）指向这台服务器".to_string(),
            },
            DnsRecordInstruction {
                record_type: "TXT".to_string(),
                name: format!("_acme-challenge.{target}"),
                value: "<certbot 在签发时输出的值>".to_string(),
                purpose: "DNS-01 验证（泛域名证书只能走这条路）".to_string(),
            },
        ]
    }
}

/// 已注册的服务商清单（`(id, 展示名, 是否支持自动写入)`）。
pub fn registered_providers() -> Vec<(&'static str, &'static str, bool)> {
    let manual = ManualDnsProvider;
    vec![(manual.id(), manual.name(), manual.supports_automation())]
}

/// 按 id 取适配器。V1 只认 `manual`（其余返回 `None`，**不猜**）。
pub fn provider(id: &str) -> Option<Box<dyn DnsProvider>> {
    match id {
        "manual" | "" => Some(Box::new(ManualDnsProvider)),
        _ => None,
    }
}

/// 证书签发计划（给用户看的"会发生什么"）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CertificatePlan {
    pub domain: String,
    /// 是否泛域名（决定挑战方式）。
    pub wildcard: bool,
    pub challenge: CertificateChallenge,
    /// 需要人工配置 DNS 记录。
    pub manual_dns_required: bool,
    /// 明文列出前置条件（会展示给用户，也用于预检）。
    pub preconditions: Vec<String>,
    /// 非空 = 现在不能签发（原因要能被人直接读懂）。
    pub blocked_reason: Option<String>,
    /// V1 是否会自动执行签发（HTTP-01 + certbot 存在时才是 true）。
    pub will_execute: bool,
}

/// 为一个域名绑定推导证书签发计划。
pub fn certificate_plan(
    binding: &DomainBinding,
    environment_kind: EnvironmentKind,
    certbot_available: Option<bool>,
) -> CertificatePlan {
    let wildcard = binding.domain.starts_with("*.");
    let challenge = if wildcard {
        CertificateChallenge::Dns01
    } else {
        CertificateChallenge::Http01
    };

    let mut preconditions: Vec<String> = Vec::new();
    let mut blocked: Option<String> = None;

    if binding.ssl_mode == SslMode::None {
        blocked = Some("这个域名没有启用 HTTPS（ssl_mode = none）".to_string());
    }
    if binding.ssl_mode == SslMode::Acme && binding.dns_credential_ref.is_none() && wildcard {
        // 泛域名的 DNS 凭据缺失：V1 不需要凭据（人工配置），但要在计划里说清楚。
        preconditions.push("泛域名需要人工在权威 DNS 添加 _acme-challenge TXT 记录".to_string());
    }

    match challenge {
        CertificateChallenge::Http01 => {
            preconditions.push("域名必须解析到本机（80 端口可达）".to_string());
            preconditions.push("服务器上必须安装 certbot".to_string());
            if binding.dns_status == DnsStatus::Mismatched {
                blocked = Some(format!(
                    "域名 {} 解析到的地址与期望不符，HTTP-01 会失败",
                    binding.domain
                ));
            } else if matches!(
                binding.dns_status,
                DnsStatus::Unknown | DnsStatus::Unchecked
            ) {
                preconditions.push("执行时会先验证解析，未生效则不会申请证书".to_string());
            }
            if certbot_available == Some(false) {
                blocked = Some("服务器上没有安装 certbot，无法自动签发证书".to_string());
            }
        }
        CertificateChallenge::Dns01 => {
            preconditions.push("人工在权威 DNS 添加 _acme-challenge TXT 记录".to_string());
            preconditions.push("添加后重新验证解析，再由人工确认继续".to_string());
            preconditions.push("V1 不调用任何 DNS 服务商 API（没有自动写入路径）".to_string());
        }
    }

    if environment_kind == EnvironmentKind::Production {
        preconditions.push("生产环境的证书签发需要单独确认".to_string());
    }

    let will_execute = challenge == CertificateChallenge::Http01 && blocked.is_none();
    CertificatePlan {
        domain: binding.domain.clone(),
        wildcard,
        challenge,
        manual_dns_required: challenge == CertificateChallenge::Dns01,
        preconditions,
        blocked_reason: blocked,
        will_execute,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::model::{DnsStatus, DomainBinding, SslMode, SslStatus};

    fn binding(domain: &str, ssl_mode: SslMode, dns: DnsStatus) -> DomainBinding {
        DomainBinding {
            id: "dom-1".to_string(),
            environment_id: "env-1".to_string(),
            service_unit_id: Some("svc-1".to_string()),
            domain: domain.to_string(),
            listen_port: 443,
            path_prefix: "/".to_string(),
            dns_credential_ref: None,
            dns_status: dns,
            dns_checked_at: None,
            ssl_mode,
            ssl_status: SslStatus::Pending,
            ssl_expires_at: None,
            notes: String::new(),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn wildcard_domains_are_forced_to_dns_validation() {
        let plan = certificate_plan(
            &binding("*.example.com", SslMode::Acme, DnsStatus::Resolved),
            EnvironmentKind::Staging,
            Some(true),
        );
        assert!(plan.wildcard);
        assert_eq!(plan.challenge, CertificateChallenge::Dns01);
        assert!(plan.manual_dns_required);
        // 泛域名从不自动执行：V1 没有 DNS 服务商写入路径。
        assert!(!plan.will_execute);
    }

    #[test]
    fn a_resolved_plain_domain_can_be_issued_automatically() {
        let plan = certificate_plan(
            &binding("app.example.com", SslMode::Acme, DnsStatus::Resolved),
            EnvironmentKind::Staging,
            Some(true),
        );
        assert_eq!(plan.challenge, CertificateChallenge::Http01);
        assert!(!plan.manual_dns_required);
        assert!(plan.will_execute);
        assert!(plan.blocked_reason.is_none());
    }

    #[test]
    fn an_unverified_domain_is_not_issued_without_a_check() {
        let plan = certificate_plan(
            &binding("app.example.com", SslMode::Acme, DnsStatus::Unchecked),
            EnvironmentKind::Staging,
            Some(true),
        );
        assert!(
            plan.preconditions
                .iter()
                .any(|line| line.contains("先验证解析")),
            "{:?}",
            plan.preconditions
        );
        assert!(plan.will_execute, "会执行，但执行时会先验证解析");
    }

    #[test]
    fn a_mismatched_domain_blocks_http01() {
        let plan = certificate_plan(
            &binding("app.example.com", SslMode::Acme, DnsStatus::Mismatched),
            EnvironmentKind::Staging,
            Some(true),
        );
        assert!(!plan.will_execute);
        assert!(plan.blocked_reason.is_some());
    }

    #[test]
    fn a_missing_certbot_blocks_issuance_instead_of_failing_late() {
        let plan = certificate_plan(
            &binding("app.example.com", SslMode::Acme, DnsStatus::Resolved),
            EnvironmentKind::Staging,
            Some(false),
        );
        assert!(!plan.will_execute);
        assert!(plan.blocked_reason.unwrap().contains("certbot"));
    }

    #[test]
    fn a_domain_without_https_is_not_planned_at_all() {
        let plan = certificate_plan(
            &binding("app.example.com", SslMode::None, DnsStatus::Unknown),
            EnvironmentKind::Staging,
            Some(true),
        );
        assert!(plan.blocked_reason.is_some());
    }

    #[test]
    fn production_adds_an_individual_confirmation_requirement() {
        let plan = certificate_plan(
            &binding("app.example.com", SslMode::Acme, DnsStatus::Resolved),
            EnvironmentKind::Production,
            Some(true),
        );
        assert!(plan
            .preconditions
            .iter()
            .any(|line| line.contains("单独确认")));
    }

    #[test]
    fn only_manual_dns_is_registered() {
        let providers = registered_providers();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].0, "manual");
        assert!(!providers[0].2, "V1 不该有任何支持自动写入的服务商");
        assert!(provider("cloudflare").is_none(), "未实现的适配器必须拒绝");
    }

    #[test]
    fn manual_instructions_cover_a_and_acme_challenge() {
        let binding = binding("app.example.com", SslMode::Acme, DnsStatus::Resolved);
        let provider = provider("manual").expect("manual");
        let instructions = provider.instructions(&binding);
        assert!(instructions.iter().any(|item| item.record_type == "A"));
        assert!(instructions.iter().any(|item| {
            item.record_type == "TXT" && item.name == "_acme-challenge.app.example.com"
        }));
    }
}
