//! 容量评估：**确定性、可解释、带假设**。
//!
//! # 用户不知道 QPS 怎么办
//!
//! 不逼用户编一个数字，也不偷偷替他决定。做的是**带假设的估算**：
//!
//! ```text
//! 峰值 QPS（直接填）            ← 事实
//!   否则 平均 QPS × 3           ← 推断 + 假设"峰值是均值 3 倍"
//!   否则 并发 ÷ 0.5s            ← 推断 + 假设"平均响应 0.5 秒"
//!   否则 DAU × 5% ÷ 0.5s        ← 推断 + 两条假设
//!   否则 不知道                  ← 未知（生产环境直接挡下来）
//! ```
//!
//! 每一条假设都进 [`Assumption`]，并写清"假设不成立会怎样"。
//! 用户看过之后可以把假设改掉再重算 —— 方案是可复现的，不是算命的。
//!
//! # 数字从哪来
//!
//! 每 QPS 多少 CPU、每服务多少内存，来自知识库的 [`SizingRule`]（可版本化、
//! 可追溯来源）。本模块只做算术，不藏私货。

use super::knowledge::KnowledgeResult;
use super::model::{
    Assumption, CapacityRecommendation, Evidence, EvidenceClass, EvidenceSource, Statement,
    StatementImpact, Unknown,
};
use crate::deployment::model::CapacityProfile;

/// 峰值 / 平均 倍数（估算用）。
const PEAK_FACTOR: f64 = 3.0;
/// 平均响应时间（秒），把并发换算成 QPS 用。
const AVG_RESPONSE_SECONDS: f64 = 0.5;
/// DAU → 同时在线比例。
const DAU_CONCURRENCY_RATIO: f64 = 0.05;
/// 每个 WebSocket 长连接按多少 KB 内存算。
const KB_PER_WEBSOCKET: f64 = 50.0;
/// 完全没数据时的兜底量级（只在给出显式假设的前提下使用）。
const FALLBACK_PEAK_QPS: f64 = 10.0;
/// 磁盘按一年数据增长预留。
const GROWTH_MONTHS: f64 = 12.0;

/// 估算输入。
pub struct CapacityInput<'a> {
    pub profile: Option<&'a CapacityProfile>,
    /// 生产类环境（staging / production）：问卷缺失会挡下来。
    pub production_like: bool,
    pub environment_name: &'a str,
    pub service_count: usize,
    /// 是否采用容器化形态（容器有额外运行时开销）。
    pub containers: bool,
    /// 是否含 JVM 服务（JVM 口径不同）。
    pub jvm: bool,
    /// 实测到的服务器资源；`None` = 没采集。
    pub observed: Option<&'a super::model::ServerResourceFacts>,
    pub min_headroom_percent: u8,
    pub require_backup: bool,
    pub knowledge: &'a KnowledgeResult,
}

/// 估算结果。
pub struct CapacityEstimate {
    pub recommendation: CapacityRecommendation,
    pub unknowns: Vec<Unknown>,
    pub statements: Vec<Statement>,
    /// 服务器装不下时的说明（引擎据此报 Capability 违规）。
    pub insufficient: Option<String>,
    /// 是否需要备份（策略或 RPO 要求）。
    pub backup_required: bool,
}

fn user_evidence(field: &str, detail: impl Into<String>) -> Evidence {
    Evidence::fact(
        EvidenceSource::UserInput {
            field: field.to_string(),
        },
        detail,
    )
}

fn kb_evidence(rule: &super::knowledge::SizingRule) -> Evidence {
    Evidence::knowledge(
        rule.entry_id,
        super::knowledge::KNOWLEDGE_VERSION,
        format!("容量口径：{}", rule.applies_to),
    )
}

/// 响应时间：问卷里填了目标就用它（**事实**），否则用经验值（**推断 + 假设**）。
fn response_time(profile: &CapacityProfile) -> (f64, EvidenceClass) {
    match profile.response_target_ms {
        Some(ms) if ms > 0 => (ms as f64 / 1000.0, EvidenceClass::Fact),
        _ => (AVG_RESPONSE_SECONDS, EvidenceClass::Inference),
    }
}

fn round_up(value: f64, step: f64) -> f64 {
    if step <= 0.0 {
        return value;
    }
    (value / step).ceil() * step
}

/// 跑一次容量评估。**纯函数**（不读盘、不联网），因此必然可复现。
pub fn estimate(input: &CapacityInput<'_>) -> CapacityEstimate {
    let mut unknowns: Vec<Unknown> = Vec::new();
    let mut statements: Vec<Statement> = Vec::new();
    let mut assumptions: Vec<Assumption> = Vec::new();
    let mut evidence: Vec<Evidence> = Vec::new();

    // ---- 1. 峰值 QPS ----
    let profile = input.profile;
    let (peak_qps, peak_basis) = match profile {
        Some(profile) if profile.peak_qps.is_some() => {
            let value = profile.peak_qps.unwrap_or(0.0);
            evidence.push(user_evidence("peak_qps", "峰值 QPS 由用户直接填写"));
            (Some(value), EvidenceClass::Fact)
        }
        Some(profile) if profile.avg_qps.is_some() => {
            let average = profile.avg_qps.unwrap_or(0.0);
            let peak = average * PEAK_FACTOR;
            evidence.push(user_evidence("avg_qps", "平均 QPS 由用户填写"));
            evidence.push(Evidence::derived(
                "capacity.peak-from-average",
                format!("峰值按平均的 {PEAK_FACTOR:.0} 倍估算"),
            ));
            assumptions.push(Assumption {
                id: "as-peak-factor".to_string(),
                statement: format!("峰值流量约为平均流量的 {PEAK_FACTOR:.0} 倍。"),
                class: EvidenceClass::Inference,
                evidence: vec![Evidence::derived(
                    "capacity.peak-factor",
                    "通用流量形态经验值",
                )],
                if_wrong: "峰值更高时 CPU 会先打满，表现为高峰期响应变慢；需要按实际峰值调高 CPU 或加副本。"
                    .to_string(),
            });
            (Some(peak), EvidenceClass::Inference)
        }
        Some(profile) if profile.concurrent_users.is_some() => {
            let concurrent = profile.concurrent_users.unwrap_or(0) as f64;
            let (response_seconds, response_basis) = response_time(profile);
            let peak = concurrent / response_seconds;
            evidence.push(user_evidence("concurrent_users", "并发数由用户填写"));
            evidence.push(Evidence::derived(
                "capacity.qps-from-concurrency",
                format!("按响应时间 {response_seconds} 秒，把并发换算成峰值 QPS"),
            ));
            if response_basis == EvidenceClass::Inference {
                assumptions.push(Assumption {
                    id: "as-response-time".to_string(),
                    statement: format!("平均响应时间约 {response_seconds} 秒。"),
                    class: EvidenceClass::Inference,
                    evidence: vec![Evidence::derived(
                        "capacity.response-time",
                        "通用 Web 服务响应时间经验值（问卷里填了响应目标就会用它）",
                    )],
                    if_wrong: "响应更慢（例如接口里做了重查询）时，同样的并发会产生更少的 QPS、但占用更久的连接，需要更多内存与连接数上限。"
                        .to_string(),
                });
            } else {
                evidence.push(user_evidence(
                    "response_target_ms",
                    "响应时间目标由用户填写，直接用于并发换算",
                ));
            }
            (Some(peak), EvidenceClass::Inference)
        }
        Some(profile) if profile.expected_dau.is_some() => {
            let dau = profile.expected_dau.unwrap_or(0) as f64;
            let concurrent = dau * DAU_CONCURRENCY_RATIO;
            let (response_seconds, response_basis) = response_time(profile);
            let peak = concurrent / response_seconds;
            evidence.push(user_evidence("expected_dau", "DAU 由用户填写"));
            evidence.push(Evidence::derived(
                "capacity.qps-from-dau",
                format!(
                    "按同时在线 {:.0}% 与响应 {response_seconds} 秒估算",
                    DAU_CONCURRENCY_RATIO * 100.0
                ),
            ));
            assumptions.push(Assumption {
                id: "as-dau-concurrency".to_string(),
                statement: format!(
                    "同时在线人数约为 DAU 的 {:.0}%。",
                    DAU_CONCURRENCY_RATIO * 100.0
                ),
                class: EvidenceClass::Inference,
                evidence: vec![Evidence::derived(
                    "capacity.dau-ratio",
                    "通用互联网产品同时在线比例经验值",
                )],
                if_wrong: "同时在线比例更高（例如打开就长时间停留的应用）时，真实并发与内存占用都会被低估。"
                    .to_string(),
            });
            if response_basis == EvidenceClass::Inference {
                assumptions.push(Assumption {
                    id: "as-response-time".to_string(),
                    statement: format!("平均响应时间约 {response_seconds} 秒。"),
                    class: EvidenceClass::Inference,
                    evidence: vec![Evidence::derived(
                        "capacity.response-time",
                        "通用 Web 服务响应时间经验值（问卷里填了响应目标就会用它）",
                    )],
                    if_wrong: "响应更慢时同上：连接占用更久，需要更多内存与连接数上限。"
                        .to_string(),
                });
            } else {
                evidence.push(user_evidence(
                    "response_target_ms",
                    "响应时间目标由用户填写，直接用于并发换算",
                ));
            }
            (Some(peak), EvidenceClass::Inference)
        }
        _ => (None, EvidenceClass::Unknown),
    };

    // 缺关键字段就如实说，并且**分档**：生产挡计划，其它只提醒。
    match (profile, peak_qps) {
        (None, _) if input.production_like => {
            unknowns.push(
                Unknown::blocking(
                    "q-capacity-profile",
                    "这个环境还没有容量问卷，先填一下 DAU / 并发 / QPS 中的至少一项。",
                    "生产环境的机器规格与带宽必须由容量倒推；问卷缺失时任何规格都是猜的。",
                )
                .suggest("如果还没有数据，可以先按 DAU 估算，方案会明确标出估算假设。"),
            );
        }
        (Some(_), None) if input.production_like => {
            unknowns.push(
                Unknown::blocking(
                    "q-capacity-numbers",
                    "容量问卷里还没有任何量级数据（DAU / 并发 / QPS 至少给一个）。",
                    "没有量级就无法给出可信的 CPU / 内存建议；生产环境不接受纯猜测的规格。",
                )
                .suggest("先按 DAU 估算：并发按 5%、响应按 0.5 秒，方案会把这两条写成显式假设。"),
            );
        }
        (Some(_), None) => {
            unknowns.push(
                Unknown::info(
                    "q-capacity-numbers",
                    "容量问卷里没有量级数据，本次按默认档位给出参考规格。",
                    "非生产环境可以用参考规格起步，但上线前应按真实流量复核。",
                )
                .suggest(format!("默认按峰值 {FALLBACK_PEAK_QPS:.0} QPS 估算")),
            );
        }
        (None, _) => {
            unknowns.push(Unknown::info(
                "q-capacity-profile",
                "这个环境还没有容量问卷。",
                "没有量级数据时规格只能给参考档，不能当作承诺。",
            ));
        }
        _ => {}
    }

    // ---- 2. 可用性 / RPO / RTO ----
    let availability = profile.and_then(|profile| profile.availability_target.clone());
    if let Some(target) = &availability {
        // 进证据：规则引擎判断"单机能不能给这个承诺"时要读它。
        evidence.push(user_evidence(
            "availability_target",
            format!("目标可用性 {target}%"),
        ));
    }
    if input.production_like && availability.is_none() {
        unknowns.push(
            Unknown::approval(
                "q-availability",
                "生产环境的目标可用性是多少？",
                "没定可用性就无法判断「单机够不够」：99.9% 及以上必须做冗余，单机给不出这个承诺。",
            )
            .suggest("99.9"),
        );
    }
    let rpo = profile.and_then(|profile| profile.rpo_minutes);
    let rto = profile.and_then(|profile| profile.rto_minutes);
    let backup_required =
        input.require_backup || rpo.is_some() || (input.production_like && profile.is_some());
    if input.production_like && rpo.is_none() {
        unknowns.push(
            Unknown::approval(
                "q-rpo",
                "能接受多少数据丢失（RPO）？",
                "RPO 直接决定备份频率；不定 RPO 就没法给出备份方案，出事时只能认损。",
            )
            .suggest("1440（一天）"),
        );
    }
    if input.production_like && rto.is_none() {
        unknowns.push(
            Unknown::info(
                "q-rto",
                "能接受多长的恢复时间（RTO）？",
                "RTO 决定回滚要有多快；不填的话回滚策略只能给保守方案。",
            )
            .suggest("60"),
        );
    }

    // ---- 3. 口径选择（知识库）----
    let rule = pick_sizing(input);
    evidence.push(kb_evidence(&rule));

    // ---- 4. 算规格 ----
    let effective_peak = peak_qps.unwrap_or(FALLBACK_PEAK_QPS);
    if peak_qps.is_none() {
        assumptions.push(Assumption {
            id: "as-fallback-peak".to_string(),
            statement: format!("没有量级数据时按峰值 {FALLBACK_PEAK_QPS:.0} QPS 估算。"),
            class: EvidenceClass::Inference,
            evidence: vec![Evidence::derived(
                "capacity.fallback",
                "小规模站点的保守起步档",
            )],
            if_wrong: "真实流量更大时规格会不足，需要按实际峰值重新评估并扩配。".to_string(),
        });
    }

    let headroom = input.min_headroom_percent.max(rule.headroom_percent);
    let factor = 1.0 + f64::from(headroom) / 100.0;
    let service_count = input.service_count.max(1) as f64;

    let cpu_raw =
        (rule.base_cpu_cores + effective_peak * rule.cpu_millicores_per_qps / 1000.0) * factor;
    let vcpu = round_up(cpu_raw.max(0.5), 0.5);

    let mut memory_raw =
        rule.base_memory_mb as f64 + rule.memory_mb_per_service as f64 * service_count;
    if let Some(profile) = profile {
        if let Some(connections) = profile.websocket_connections {
            if connections > 0 {
                memory_raw += connections as f64 * KB_PER_WEBSOCKET / 1024.0;
                evidence.push(user_evidence(
                    "websocket_connections",
                    format!("{connections} 个长连接按每连接 {KB_PER_WEBSOCKET:.0} KB 计入内存"),
                ));
                assumptions.push(Assumption {
                    id: "as-websocket-memory".to_string(),
                    statement: format!("每个 WebSocket 连接约占 {KB_PER_WEBSOCKET:.0} KB 内存。"),
                    class: EvidenceClass::Inference,
                    evidence: vec![Evidence::derived(
                        "capacity.websocket-memory",
                        "长连接内存占用经验值（含缓冲与内核套接字）",
                    )],
                    if_wrong: "单连接占用更高时（例如服务端为每个连接建缓存）内存会被低估。"
                        .to_string(),
                });
            }
        }
    }
    let memory_mb = round_up(memory_raw * factor, 128.0) as i64;

    let mut disk_gb = rule.disk_mb_per_service as f64 * service_count / 1024.0;
    if let Some(profile) = profile {
        if let Some(growth) = profile.monthly_data_growth_gb {
            disk_gb += growth / 1024.0 * GROWTH_MONTHS;
            evidence.push(user_evidence(
                "monthly_data_growth_gb",
                format!("按月增长 {growth} GB，预留 {GROWTH_MONTHS:.0} 个月"),
            ));
        }
    }
    let disk_gb = round_up(disk_gb.max(1.0), 1.0);

    // ---- 5. 带宽 ----
    let bandwidth_mbps = profile.and_then(|profile| {
        let monthly = profile.monthly_bandwidth_gb?;
        // 月总量 → 平均 Mbps（1 GB = 8192 Mb；30 天 = 2 592 000 秒）。
        let average = monthly * 8192.0 / (30.0 * 86_400.0);
        evidence.push(user_evidence(
            "monthly_bandwidth_gb",
            format!("按月流量 {monthly} GB 折算平均带宽"),
        ));
        Some(round_up(average * PEAK_FACTOR, 1.0))
    });

    // ---- 6. 能否装下 ----
    let mut insufficient: Option<String> = None;
    let fits_on_server = match input.observed {
        Some(observed) => {
            let mut shortages: Vec<String> = Vec::new();
            if vcpu > observed.cpu_cores {
                shortages.push(format!(
                    "CPU 需要 {vcpu:.1} 核，实测只有 {:.1} 核",
                    observed.cpu_cores
                ));
            }
            if memory_mb > observed.memory_mb {
                shortages.push(format!(
                    "内存需要 {memory_mb} MB，实测只有 {} MB",
                    observed.memory_mb
                ));
            }
            if disk_gb > observed.disk_free_gb {
                shortages.push(format!(
                    "磁盘需要 {disk_gb:.1} GB，实测可用 {:.1} GB",
                    observed.disk_free_gb
                ));
            }
            if shortages.is_empty() {
                Some(true)
            } else {
                insufficient = Some(shortages.join("；"));
                Some(false)
            }
        }
        None => {
            unknowns.push(Unknown::info(
                "q-server-resources",
                "服务器当前 CPU / 内存 / 磁盘没有采集到：这里给的是「需要多少」，还没核对「够不够」。",
                "不核对就上线，可能在部署到一半时才发现磁盘不够（那时回滚更麻烦）。",
            ));
            None
        }
    };

    // ---- 7. 成本 ----
    let mut monthly_cost_hint = None;
    if let (Some(cpu_price), Some(memory_price)) =
        (rule.cost_per_vcpu_month, rule.cost_per_gb_memory_month)
    {
        let cost = vcpu * cpu_price + (memory_mb as f64 / 1024.0) * memory_price;
        monthly_cost_hint = Some((cost * 100.0).round() / 100.0);
        evidence.push(Evidence::derived(
            "capacity.cost",
            format!(
                "按每 vCPU {cpu_price}/月、每 GB 内存 {memory_price}/月估算（通用云主机量级，仅作参考）"
            ),
        ));
    }
    let budget = profile.and_then(|profile| profile.monthly_budget);
    if let (Some(cost), Some(budget)) = (monthly_cost_hint, budget) {
        if cost > budget {
            statements.push(
                Statement::inference(
                    "cap-budget",
                    format!("估算月成本 {cost} 高于预算 {budget}，需要调整规格或预算。"),
                    vec![
                        user_evidence("monthly_budget", format!("预算 {budget}")),
                        Evidence::derived("capacity.cost", format!("估算 {cost}")),
                    ],
                )
                .with_impact(StatementImpact::Blocking),
            );
        }
    } else if input.production_like && budget.is_none() {
        unknowns.push(Unknown::info(
            "q-budget",
            "没有填月度预算，成本估算只能给量级参考。",
            "预算会影响「能不能加冗余」，没有上限就无法给出取舍建议。",
        ));
    }

    // ---- 8. 结论说明 ----
    statements.push(Statement::inference(
        "cap-summary",
        format!(
            "建议 {vcpu:.1} vCPU / {memory_mb} MB 内存 / {disk_gb:.1} GB 磁盘，已含 {headroom}% 余量。"
        ),
        evidence.clone(),
    ));
    if let Some(target) = &availability {
        statements.push(Statement::fact(
            "cap-availability",
            format!("目标可用性 {target}%。"),
            vec![user_evidence("availability_target", format!("{target}%"))],
        ));
    }
    if let (Some(rpo), Some(rto)) = (rpo, rto) {
        statements.push(Statement::fact(
            "cap-dr",
            format!("RPO {rpo} 分钟 / RTO {rto} 分钟。"),
            vec![
                user_evidence("rpo_minutes", format!("{rpo} 分钟")),
                user_evidence("rto_minutes", format!("{rto} 分钟")),
            ],
        ));
    }

    let recommendation = CapacityRecommendation {
        peak_qps,
        peak_qps_basis: peak_basis,
        concurrent_users: profile.and_then(|profile| profile.concurrent_users),
        vcpu,
        memory_mb,
        disk_gb,
        bandwidth_mbps,
        headroom_percent: headroom,
        monthly_cost_hint,
        fits_on_server,
        assumptions: assumptions.clone(),
        unknowns: unknowns.clone(),
        evidence,
    };

    unknowns.sort_by(|left, right| left.id.cmp(&right.id));
    statements.sort_by(|left, right| left.id.cmp(&right.id));

    CapacityEstimate {
        recommendation,
        unknowns,
        statements,
        insufficient,
        backup_required,
    }
}

/// 选一套容量口径：JVM 优先，其次容器，最后通用。
///
/// 话题名是知识库里的固定取值（`sizing.jvm` / `sizing.container` / `sizing.web`），
/// 找不到就回退到内置的通用口径 —— 回退也必须能被追溯（调用方会记证据）。
fn pick_sizing(input: &CapacityInput<'_>) -> super::knowledge::SizingRule {
    let find = |topic: &str| -> Option<super::knowledge::SizingRule> {
        input
            .knowledge
            .sizing
            .iter()
            .find(|(name, _)| name == topic)
            .map(|(_, rule)| *rule)
    };
    if input.jvm {
        if let Some(rule) = find("sizing.jvm") {
            return rule;
        }
    }
    if input.containers {
        if let Some(rule) = find("sizing.container") {
            return rule;
        }
    }
    find("sizing.web").unwrap_or(super::knowledge::WEB_SIZING)
}
