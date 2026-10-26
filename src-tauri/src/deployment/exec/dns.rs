//! P5.6 **DNS 就绪判定 + 服务商注册表**。
//!
//! # 为什么不能"自动改 DNS"
//!
//! 仓库里**没有任何**能写 DNS 的适配器（[`super::guidance::DnsProvider`] 的
//! `supports_automation()` 全部为 `false`）。所以流程是：
//!
//! 1. 没有可用 Provider → 生成**人工步骤**：告诉用户该加哪些记录，然后**暂停**；
//! 2. 解析已经生效 → 才允许继续走 HTTP-01 证书签发；
//! 3. 通配域名 / DNS-01 **继续**走人工，不假装能自动完成；
//! 4. Cloudflare / 阿里云 / 腾讯云已**预留**在注册表里（凭据将来只进 Keyring）。

/// 已知 DNS 服务商：`(id, 展示名, 是否支持自动写入)`。
///
/// **V1 全部为 `false`** —— 没有可用的写入适配器，就不假装有。
/// 将来接入时凭据只允许存 Keyring（`credential_ref`），不进数据库、不进日志。
pub const KNOWN_PROVIDERS: &[(&str, &str, bool)] = &[
    ("manual", "人工配置", false),
    ("cloudflare", "Cloudflare", false),
    ("alidns", "阿里云 DNS", false),
    ("tencentdnspod", "腾讯云 DNSPod", false),
];

pub fn provider_by_id(id: &str) -> Option<(&'static str, &'static str, bool)> {
    KNOWN_PROVIDERS
        .iter()
        .find(|(candidate, _, _)| *candidate == id)
        .copied()
}

/// DNS 解析观测结果（由调用方提供：可以是服务器侧 `dig`，也可以是本机解析）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DnsObservation {
    pub addresses: Vec<String>,
    /// 解析失败时的原因（如 `NXDOMAIN`、`SERVFAIL`）。
    pub error: Option<String>,
}

/// DNS 是否已就绪。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsReadiness {
    /// 已解析到目标地址 —— 可以继续 HTTP-01。
    Resolved { addresses: Vec<String> },
    /// 还没解析对 —— 需要用户加记录。
    NotResolved { reason: String },
    /// 无法判定（如离线）—— 按"未就绪"处理，绝不假设成功。
    Unknown { reason: String },
}

impl DnsReadiness {
    /// 只有明确解析到目标地址才算就绪。
    pub fn is_ready(&self) -> bool {
        matches!(self, DnsReadiness::Resolved { .. })
    }

    pub fn reason(&self) -> String {
        match self {
            DnsReadiness::Resolved { addresses } => {
                format!("已解析到 {}", addresses.join(" / "))
            }
            DnsReadiness::NotResolved { reason } | DnsReadiness::Unknown { reason } => {
                reason.clone()
            }
        }
    }
}

/// 判定 DNS 是否已指向目标地址。
pub fn readiness(expected_ip: Option<&str>, observation: &DnsObservation) -> DnsReadiness {
    if let Some(error) = &observation.error {
        if !error.trim().is_empty() {
            return DnsReadiness::Unknown {
                reason: format!("DNS 查询失败：{error}"),
            };
        }
    }
    let addresses: Vec<String> = observation
        .addresses
        .iter()
        .map(|address| address.trim().to_string())
        .filter(|address| !address.is_empty())
        .collect();
    if addresses.is_empty() {
        return DnsReadiness::NotResolved {
            reason: "域名还没有解析记录".to_string(),
        };
    }
    match expected_ip.map(str::trim).filter(|value| !value.is_empty()) {
        Some(expected) if addresses.iter().any(|address| address == expected) => {
            DnsReadiness::Resolved { addresses }
        }
        Some(expected) => DnsReadiness::NotResolved {
            reason: format!(
                "域名当前解析到 {}，尚未指向目标地址 {expected}",
                addresses.join(" / ")
            ),
        },
        None => DnsReadiness::Resolved { addresses },
    }
}

/// 人工步骤（V1 没有可用的 DNS 写入适配器时产出）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualDnsStep {
    pub provider_id: String,
    pub provider_name: String,
    pub domain: String,
    /// 需要用户添加的记录（`A` / `CNAME` / `TXT` …）。
    pub records: Vec<(String, String, String)>,
    pub instruction: String,
}

/// 生成人工 DNS 步骤：**不假装能自动写**，只告诉用户该做什么。
pub fn manual_step(provider_id: &str, domain: &str, target_ip: Option<&str>) -> ManualDnsStep {
    let (id, name, automated) =
        provider_by_id(provider_id).unwrap_or(("manual", "人工配置", false));
    let mut records = vec![(
        "A".to_string(),
        "@".to_string(),
        target_ip.unwrap_or("<服务器 IP>").to_string(),
    )];
    // 通配 / DNS-01 需要额外的 TXT 记录，同样交给用户。
    if domain.starts_with("*.") {
        records.push((
            "TXT".to_string(),
            "_acme-challenge".to_string(),
            "<CA 给出的值>".to_string(),
        ));
    }
    ManualDnsStep {
        provider_id: id.to_string(),
        provider_name: name.to_string(),
        domain: domain.to_string(),
        records,
        instruction: if automated {
            "该服务商已登记，但当前版本没有自动写入能力：请在控制台手动添加记录后回来继续。"
                .to_string()
        } else {
            format!(
                "请在「{name}」控制台为 {domain} 添加下面的记录，保存后回到这里点击「重新验证解析」。"
            )
        },
    }
}

/// HTTP-01 证书签发的前置条件。
///
/// 只有**明确解析到目标地址**才允许继续 —— 这是"人工步骤完成后自动往下走"的唯一闸门。
pub fn http01_precondition(readiness: &DnsReadiness) -> Result<(), String> {
    if readiness.is_ready() {
        return Ok(());
    }
    Err(format!(
        "HTTP-01 需要域名先解析到这台服务器：{}",
        readiness.reason()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_future_providers_are_registered_but_cannot_write_yet() {
        for id in ["cloudflare", "alidns", "tencentdnspod"] {
            let (_, name, automated) = provider_by_id(id).expect("应当已登记");
            assert!(!automated, "{name} 暂时不能自动写入 DNS");
        }
        assert!(provider_by_id("manual").is_some());
        assert!(provider_by_id("nonexistent").is_none());
    }

    #[test]
    fn dns_is_only_ready_when_it_points_at_the_target() {
        let ready = readiness(
            Some("203.0.113.10"),
            &DnsObservation {
                addresses: vec!["203.0.113.10".to_string()],
                error: None,
            },
        );
        assert!(ready.is_ready(), "{}", ready.reason());

        let wrong = readiness(
            Some("203.0.113.10"),
            &DnsObservation {
                addresses: vec!["198.51.100.7".to_string()],
                error: None,
            },
        );
        assert!(!wrong.is_ready());
        assert!(http01_precondition(&wrong).is_err());
    }

    #[test]
    fn missing_or_failed_dns_never_counts_as_ready() {
        let empty = readiness(Some("203.0.113.10"), &DnsObservation::default());
        assert!(!empty.is_ready(), "空记录必须算未就绪");

        let failed = readiness(
            Some("203.0.113.10"),
            &DnsObservation {
                addresses: vec![],
                error: Some("NXDOMAIN".to_string()),
            },
        );
        assert!(matches!(failed, DnsReadiness::Unknown { .. }));
        assert!(!failed.is_ready(), "查询失败绝不能假设已解析");
    }

    #[test]
    fn the_manual_step_tells_the_user_exactly_what_to_add() {
        let step = manual_step("manual", "shop.example.com", Some("203.0.113.10"));
        assert_eq!(step.domain, "shop.example.com");
        assert_eq!(step.records.len(), 1);
        assert_eq!(step.records[0].2, "203.0.113.10");
        assert!(
            step.instruction.contains("添加下面的记录"),
            "{}",
            step.instruction
        );

        // 通配域名还要一条 TXT。
        let wildcard = manual_step("cloudflare", "*.example.com", None);
        assert_eq!(wildcard.provider_name, "Cloudflare");
        assert!(
            wildcard.records.iter().any(|(kind, ..)| kind == "TXT"),
            "通配域名需要 TXT 记录"
        );
    }
}
