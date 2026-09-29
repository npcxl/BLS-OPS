//! 部署知识库：**编译期常量、离线、可版本化、可审计**。
//!
//! # 为什么是常量而不是数据库
//!
//! 方案要"相同输入可复现"。知识库一旦可变，同一个输入今天和明天的推荐就可能不同 ——
//! 那还叫什么可复现。所以知识**随代码走、带版本号**（[`KNOWLEDGE_VERSION`]），
//! 进方案指纹；升级知识库 = 改代码 = 版本号变 = 旧方案哈希对不上（这正是审计要的）。
//!
//! # 两条纪律
//!
//! 1. **条目必须写清来源**（`source`），且来源是"人可核对"的文档 / 手册，
//!    不是"经验之谈"。写不出来源的知识不许进库。
//! 2. **冲突声明式**：`conflicts_with` 显式列出会打架的条目；检索到冲突时
//!    交给 [`resolve_conflicts`]，用**服务器实时事实与安全策略**裁定，
//!    裁定不了就原样交回给用户（[`ConflictResolution::Unresolved`]）。
//!    **绝不静默选一条。**

use serde::{Deserialize, Serialize};

use super::model::{
    ConflictResolution, Evidence, EvidenceClass, EvidenceSource, KnowledgeConflict,
    KnowledgeReference, SecurityPolicy, TopologyKind,
};
use crate::capability_probe::ServerCapabilityProfile;

/// 知识库版本。**方案指纹的一部分**。
pub const KNOWLEDGE_VERSION: &str = "kb-2026.09.1";

// -- 结构 -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimKind {
    /// 硬约束（"不满足就不该这么部署"）。
    Constraint,
    /// 容量口径（每 QPS 多少 CPU 这类）。
    Sizing,
    /// 推荐做法。
    Pattern,
    /// 反面做法。
    AntiPattern,
    /// 上线前检查项。
    Checklist,
}

/// 容量口径。字段全是 `const`-friendly 的标量，方便进 `static`。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SizingRule {
    pub entry_id: &'static str,
    pub applies_to: &'static str,
    /// 每 QPS 需要多少毫核 CPU。
    pub cpu_millicores_per_qps: f64,
    pub base_cpu_cores: f64,
    pub base_memory_mb: i64,
    pub memory_mb_per_service: i64,
    pub disk_mb_per_service: i64,
    pub cost_per_vcpu_month: Option<f64>,
    pub cost_per_gb_memory_month: Option<f64>,
    pub headroom_percent: u8,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ClaimPayload {
    /// 只是说明（进方案说明，不参与决策）。
    Note,
    /// 偏好某种形态（`weight` 越大越优先）。
    PreferTopology {
        kind: TopologyKind,
        weight: u8,
    },
    /// 明确不推荐某种形态（需要 `reason`）。
    AvoidTopology {
        kind: TopologyKind,
        reason: &'static str,
    },
    /// 采用某种形态必须装了这个能力（`capability` 是能力字段名，如 `deployment.docker`）。
    RequiresCapability {
        topology: TopologyKind,
        capability: &'static str,
    },
    Sizing(SizingRule),
    /// 健康检查用这个路径。
    RequireHealthCheck {
        path: &'static str,
    },
    /// 备份间隔（RPO 相关）。
    RequireBackup {
        interval: &'static str,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Claim {
    pub id: &'static str,
    /// 冲突按 topic 配对：同 topic 且结论不同 = 冲突。
    pub topic: &'static str,
    pub statement: &'static str,
    pub kind: ClaimKind,
    pub payload: ClaimPayload,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AppliesTo {
    pub languages: &'static [&'static str],
    pub service_kinds: &'static [&'static str],
    pub topologies: &'static [&'static str],
    pub tags: &'static [&'static str],
}

#[derive(Debug)]
pub struct KnowledgeEntry {
    pub id: &'static str,
    pub title: &'static str,
    /// 人可核对的来源（文档名 / 手册名）。
    pub source: &'static str,
    pub applies: AppliesTo,
    pub claims: &'static [Claim],
    /// 被本条目取代的旧条目（留痕，不删）。
    pub supersedes: &'static [&'static str],
    pub conflicts_with: &'static [&'static str],
}

/// 打了这个标签的条目是**通用知识**（容量口径、可用性、备份、密钥纪律），
/// 任何检索都带上它。显式打标，不靠"标签猜"。
pub const UNIVERSAL_TAG: &str = "universal";

// -- 容量口径常量 -----------------------------------------------------------

/// 通用 Web 服务口径。**刻意保守**：宁可能力评估偏高，也不要上线就 OOM。
pub const WEB_SIZING: SizingRule = SizingRule {
    entry_id: "kb-capacity-web",
    applies_to: "通用 Web/API 服务（读写为主、无重型计算）",
    cpu_millicores_per_qps: 2.5,
    base_cpu_cores: 0.5,
    base_memory_mb: 256,
    memory_mb_per_service: 160,
    disk_mb_per_service: 512,
    cost_per_vcpu_month: Some(28.0),
    cost_per_gb_memory_month: Some(3.5),
    headroom_percent: 40,
};

/// JVM 口径：堆外开销更大。
pub const JVM_SIZING: SizingRule = SizingRule {
    entry_id: "kb-capacity-jvm",
    applies_to: "JVM 常驻进程（JAR）",
    cpu_millicores_per_qps: 3.0,
    base_cpu_cores: 1.0,
    base_memory_mb: 512,
    memory_mb_per_service: 768,
    disk_mb_per_service: 1024,
    cost_per_vcpu_month: Some(28.0),
    cost_per_gb_memory_month: Some(3.5),
    headroom_percent: 45,
};

/// 容器口径：每个容器有固定开销。
pub const CONTAINER_SIZING: SizingRule = SizingRule {
    entry_id: "kb-capacity-container",
    applies_to: "容器化服务（每个容器另有运行时开销）",
    cpu_millicores_per_qps: 2.5,
    base_cpu_cores: 0.5,
    base_memory_mb: 320,
    memory_mb_per_service: 200,
    disk_mb_per_service: 1024,
    cost_per_vcpu_month: Some(28.0),
    cost_per_gb_memory_month: Some(3.5),
    headroom_percent: 40,
};

// -- 条目 -------------------------------------------------------------------

pub static KNOWLEDGE: &[KnowledgeEntry] = &[
    KnowledgeEntry {
        id: "kb-static-frontend",
        title: "纯前端 / 静态站点交给 Nginx 托管",
        source: "Nginx 官方文档 server_name / root / try_files",
        applies: AppliesTo {
            languages: &["static"],
            service_kinds: &["static_nginx"],
            topologies: &[],
            tags: &["frontend", "static"],
        },
        claims: &[
            Claim {
                id: "kb-static-frontend.prefer",
                topic: "topology.static",
                statement: "静态产物用 Nginx 直接托管，不要为它跑一个 Node 进程。",
                kind: ClaimKind::Pattern,
                payload: ClaimPayload::PreferTopology {
                    kind: TopologyKind::StaticNginx,
                    weight: 95,
                },
            },
            Claim {
                id: "kb-static-frontend.health",
                topic: "health.static",
                statement: "静态站点的健康检查就是首页可取。",
                kind: ClaimKind::Checklist,
                payload: ClaimPayload::RequireHealthCheck { path: "/" },
            },
        ],
        supersedes: &[],
        conflicts_with: &[],
    },
    KnowledgeEntry {
        id: "kb-node-process",
        title: "Node 常驻进程用 systemd 托管",
        source: "systemd.service(5) Restart=always / Environment= 与 Node 官方部署建议",
        applies: AppliesTo {
            languages: &["node"],
            service_kinds: &["node_process"],
            topologies: &[],
            tags: &["api", "worker"],
        },
        claims: &[
            Claim {
                id: "kb-node-process.prefer",
                topic: "topology.process",
                statement: "单机上的长驻 Node 进程用 systemd 托管，重启与开机自启由它负责。",
                kind: ClaimKind::Pattern,
                payload: ClaimPayload::PreferTopology {
                    kind: TopologyKind::SystemdProcesses,
                    weight: 80,
                },
            },
            Claim {
                id: "kb-node-process.health",
                topic: "health.api",
                statement: "API 服务应暴露一个不依赖数据库的存活端点。",
                kind: ClaimKind::Checklist,
                payload: ClaimPayload::RequireHealthCheck { path: "/healthz" },
            },
            Claim {
                id: "kb-node-process.sizing",
                topic: "sizing.web",
                statement: "Web/API 的通用容量口径。",
                kind: ClaimKind::Sizing,
                payload: ClaimPayload::Sizing(WEB_SIZING),
            },
        ],
        supersedes: &[],
        conflicts_with: &[],
    },
    KnowledgeEntry {
        id: "kb-java-jar",
        title: "JAR 用 systemd 托管并限制堆上限",
        source: "systemd.exec(5) 与 JVM 容器感知内存（-XX:MaxRAMPercentage）",
        applies: AppliesTo {
            languages: &["java"],
            service_kinds: &["java_jar"],
            topologies: &[],
            tags: &["api"],
        },
        claims: &[
            Claim {
                id: "kb-java-jar.prefer",
                topic: "topology.process",
                statement: "JAR 用 systemd 托管即可，单机没必要为了一个进程引入容器。",
                kind: ClaimKind::Pattern,
                payload: ClaimPayload::PreferTopology {
                    kind: TopologyKind::SystemdProcesses,
                    weight: 80,
                },
            },
            Claim {
                id: "kb-java-jar.sizing",
                topic: "sizing.jvm",
                statement: "JVM 的常驻内存明显高于同规模的 Node/Python 进程。",
                kind: ClaimKind::Sizing,
                payload: ClaimPayload::Sizing(JVM_SIZING),
            },
            Claim {
                id: "kb-java-jar.health",
                topic: "health.api",
                statement: "Spring Boot 的存活端点默认在 /actuator/health。",
                kind: ClaimKind::Checklist,
                payload: ClaimPayload::RequireHealthCheck {
                    path: "/actuator/health",
                },
            },
        ],
        supersedes: &[],
        conflicts_with: &[],
    },
    KnowledgeEntry {
        id: "kb-compose-multi",
        title: "多服务成套部署用 Docker Compose",
        source: "Docker Compose 官方文档 (services / depends_on / ports)",
        applies: AppliesTo {
            languages: &[],
            service_kinds: &["docker_compose", "docker_image"],
            topologies: &[],
            tags: &["multi-service", "container"],
        },
        claims: &[
            Claim {
                id: "kb-compose-multi.prefer",
                topic: "topology.container",
                statement: "同一台机器上的一组容器用 compose 管理，网络与依赖一次说清。",
                kind: ClaimKind::Pattern,
                payload: ClaimPayload::PreferTopology {
                    kind: TopologyKind::DockerCompose,
                    weight: 85,
                },
            },
            Claim {
                id: "kb-compose-multi.requires",
                topic: "capability.container",
                statement: "用 compose 的前提是服务器上装了 Docker 与 Compose 插件。",
                kind: ClaimKind::Constraint,
                payload: ClaimPayload::RequiresCapability {
                    topology: TopologyKind::DockerCompose,
                    capability: "deployment.docker_compose",
                },
            },
            Claim {
                id: "kb-compose-multi.sizing",
                topic: "sizing.container",
                statement: "容器化服务的通用容量口径（含每容器运行时开销）。",
                kind: ClaimKind::Sizing,
                payload: ClaimPayload::Sizing(CONTAINER_SIZING),
            },
        ],
        supersedes: &[],
        conflicts_with: &["kb-selfhosted-db", "kb-single-process-simple"],
    },
    KnowledgeEntry {
        id: "kb-registry-image",
        title: "镜像引用要按 digest 固定",
        source: "Docker 官方文档：pull by digest（name@sha256:… 形式）",
        applies: AppliesTo {
            languages: &[],
            service_kinds: &["docker_image"],
            topologies: &[],
            tags: &["registry", "container"],
        },
        claims: &[Claim {
            id: "kb-registry-image.digest",
            topic: "artifact.registry",
            statement: "用 digest 而不是可变 tag 固定版本，回滚才有确定的落点。",
            kind: ClaimKind::Constraint,
            payload: ClaimPayload::Note,
        }],
        supersedes: &[],
        conflicts_with: &[],
    },
    KnowledgeEntry {
        id: "kb-external-managed",
        title: "数据库 / 缓存优先外部托管",
        source: "本工具既定边界：P5 只声明依赖与健康检查，不部署有状态中间件",
        applies: AppliesTo {
            languages: &[],
            service_kinds: &["external_managed"],
            topologies: &[],
            tags: &["database", "cache", "external"],
        },
        claims: &[
            Claim {
                id: "kb-external-managed.never-deploy",
                topic: "topology.external",
                statement: "有状态中间件不由本工具部署，只声明依赖与健康检查。",
                kind: ClaimKind::Constraint,
                payload: ClaimPayload::Note,
            },
            Claim {
                id: "kb-external-managed.prefer",
                topic: "topology.database",
                statement: "数据库走外部托管，与业务进程解耦，便于独立备份与升级。",
                kind: ClaimKind::Pattern,
                payload: ClaimPayload::PreferTopology {
                    kind: TopologyKind::HybridGateway,
                    weight: 30,
                },
            },
        ],
        supersedes: &[],
        conflicts_with: &[],
    },
    KnowledgeEntry {
        id: "kb-selfhosted-db",
        title: "小规模可以自带一个数据库容器",
        source: "Docker 官方镜像文档（postgres / mysql 数据卷与持久化）",
        applies: AppliesTo {
            languages: &[],
            service_kinds: &["docker_compose"],
            topologies: &[],
            tags: &["database", "self-hosted"],
        },
        claims: &[
            Claim {
                id: "kb-selfhosted-db.allow",
                topic: "topology.external",
                statement:
                    "预算紧张的小项目可以先用 compose 自带一个数据库容器，但必须配数据卷与备份。",
                kind: ClaimKind::Pattern,
                payload: ClaimPayload::PreferTopology {
                    kind: TopologyKind::DockerCompose,
                    weight: 20,
                },
            },
            Claim {
                id: "kb-selfhosted-db.backup",
                topic: "backup.database",
                statement: "自带数据库必须配置定期备份，否则一次误删就是永久损失。",
                kind: ClaimKind::Constraint,
                payload: ClaimPayload::RequireBackup { interval: "daily" },
            },
        ],
        supersedes: &[],
        // 与"外部托管""简单优先"两条直接对立 —— 这就是给冲突裁定准备的真实案例。
        conflicts_with: &["kb-external-managed", "kb-single-process-simple"],
    },
    KnowledgeEntry {
        id: "kb-single-process-simple",
        title: "单服务不要引入容器编排",
        source: "运维常识与 systemd 官方推荐：单进程用 init 系统托管即可",
        applies: AppliesTo {
            languages: &[],
            service_kinds: &["node_process", "python_venv", "native_binary", "java_jar"],
            topologies: &[],
            tags: &["simple", "single-service"],
        },
        claims: &[
            Claim {
                id: "kb-single-process-simple.avoid",
                topic: "topology.container",
                statement: "只有一个常驻进程时，为一个容器引入镜像构建与仓库是净负担。",
                kind: ClaimKind::AntiPattern,
                payload: ClaimPayload::AvoidTopology {
                    kind: TopologyKind::DockerCompose,
                    reason: "单进程用 systemd 更少活动部件，也更容易回滚",
                },
            },
            Claim {
                id: "kb-single-process-simple.prefer",
                topic: "topology.process",
                statement: "单进程优先 systemd。",
                kind: ClaimKind::Pattern,
                payload: ClaimPayload::PreferTopology {
                    kind: TopologyKind::SystemdProcesses,
                    weight: 60,
                },
            },
        ],
        supersedes: &[],
        conflicts_with: &["kb-compose-multi", "kb-selfhosted-db"],
    },
    KnowledgeEntry {
        id: "kb-capacity-web",
        title: "容量口径：每 QPS 约 2.5 毫核，预留 40% 余量",
        source: "通用 Web 服务容量经验值（保守档），仅用于给量级建议",
        applies: AppliesTo {
            languages: &[],
            service_kinds: &[],
            topologies: &[],
            tags: &[UNIVERSAL_TAG],
        },
        claims: &[
            Claim {
                id: "kb-capacity-web.rule",
                topic: "sizing.web",
                statement: "通用 Web 服务的容量口径。",
                kind: ClaimKind::Sizing,
                payload: ClaimPayload::Sizing(WEB_SIZING),
            },
            Claim {
                id: "kb-capacity-web.headroom",
                topic: "capacity.headroom",
                statement: "峰值之外至少留 30%–40% 余量，否则一次流量抖动就会打满。",
                kind: ClaimKind::Constraint,
                payload: ClaimPayload::Note,
            },
        ],
        supersedes: &[],
        conflicts_with: &[],
    },
    KnowledgeEntry {
        id: "kb-availability-single-node",
        title: "单机给不出 99.9% 的可用性承诺",
        source: "可用性串联公式（单节点无冗余时理论天花板受主机与网络单点限制）",
        applies: AppliesTo {
            languages: &[],
            service_kinds: &[],
            topologies: &[],
            tags: &["availability", "ha", UNIVERSAL_TAG],
        },
        claims: &[
            Claim {
                id: "kb-availability-single-node.limit",
                topic: "availability.single-node",
                statement: "单节点部署无法承诺 99.9% 及以上可用性：主机、网络、磁盘都是单点。",
                kind: ClaimKind::Constraint,
                payload: ClaimPayload::Note,
            },
            Claim {
                id: "kb-availability-single-node.avoid",
                topic: "topology.ha",
                statement: "要 99.9% 就别把负载均衡当成可选组件。",
                kind: ClaimKind::AntiPattern,
                payload: ClaimPayload::AvoidTopology {
                    kind: TopologyKind::DockerImages,
                    reason: "同一台机器上的多个容器并不构成冗余",
                },
            },
        ],
        supersedes: &[],
        conflicts_with: &[],
    },
    KnowledgeEntry {
        id: "kb-backup-rpo",
        title: "备份频率跟 RPO 挂钩",
        source: "备份与恢复惯例：RPO 决定备份间隔，RTO 决定恢复演练要求",
        applies: AppliesTo {
            languages: &[],
            service_kinds: &[],
            topologies: &[],
            tags: &["backup", "dr", UNIVERSAL_TAG],
        },
        claims: &[
            Claim {
                id: "kb-backup-rpo.interval",
                topic: "backup.interval",
                statement: "RPO 在 24 小时内 → 至少每日一次备份；RPO 越短，间隔越短。",
                kind: ClaimKind::Checklist,
                payload: ClaimPayload::RequireBackup { interval: "daily" },
            },
            Claim {
                id: "kb-backup-rpo.rto",
                topic: "backup.rto",
                statement: "RTO 决定回滚要有多快：可自动回滚的服务才能承诺分钟级 RTO。",
                kind: ClaimKind::Checklist,
                payload: ClaimPayload::Note,
            },
        ],
        supersedes: &[],
        conflicts_with: &[],
    },
    KnowledgeEntry {
        id: "kb-secrets-hygiene",
        title: "密钥只以引用形式存在",
        source: "本工具安全模型（SecretRef / OS Keyring）与制品导入扫描结论",
        applies: AppliesTo {
            languages: &[],
            service_kinds: &[],
            topologies: &[],
            tags: &["security", "secrets", UNIVERSAL_TAG],
        },
        claims: &[Claim {
            id: "kb-secrets-hygiene.ref",
            topic: "security.secrets",
            statement: "运行时密钥经 SecretRef 注入；制品里带私钥或 Token 直接阻断。",
            kind: ClaimKind::Constraint,
            payload: ClaimPayload::Note,
        }],
        supersedes: &[],
        conflicts_with: &[],
    },
];

// -- 检索 -------------------------------------------------------------------

/// 检索条件（由引擎从输入里汇总）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct KnowledgeQuery {
    pub languages: Vec<String>,
    pub service_kinds: Vec<String>,
    pub tags: Vec<String>,
    pub production_like: bool,
}

#[derive(Debug, Clone)]
pub struct KnowledgeHit {
    pub entry: &'static KnowledgeEntry,
    /// 命中了什么（进方案"依据"）。
    pub matched: Vec<String>,
}

/// 检索结果（方案直接消费它）。
#[derive(Debug, Clone)]
pub struct KnowledgeResult {
    pub version: String,
    pub references: Vec<KnowledgeReference>,
    pub hits: Vec<KnowledgeHit>,
    pub conflicts: Vec<KnowledgeConflict>,
    /// 倾向的形态（weight 降序）。
    pub preferred: Vec<(TopologyKind, u8, &'static str)>,
    /// 明确避开的形态。
    pub avoided: Vec<(TopologyKind, &'static str)>,
    /// 形态 → 必需能力。
    pub required_capabilities: Vec<(TopologyKind, &'static str)>,
    /// 健康检查路径建议（按 topic）。
    pub health_paths: Vec<(&'static str, &'static str)>,
    /// 容量口径（按 topic，后面的覆盖前面的）。
    pub sizing: Vec<(String, SizingRule)>,
    /// 备份建议。
    pub backup_interval: Option<(&'static str, &'static str)>,
    /// 强制要求的额外检查项（人话）。
    pub checklist: Vec<(&'static str, &'static str)>,
}

impl KnowledgeResult {
    pub fn empty() -> Self {
        Self {
            version: KNOWLEDGE_VERSION.to_string(),
            references: Vec::new(),
            hits: Vec::new(),
            conflicts: Vec::new(),
            preferred: Vec::new(),
            avoided: Vec::new(),
            required_capabilities: Vec::new(),
            health_paths: Vec::new(),
            sizing: Vec::new(),
            backup_interval: None,
            checklist: Vec::new(),
        }
    }
}

fn matches(entry: &KnowledgeEntry, query: &KnowledgeQuery) -> Vec<String> {
    let mut matched = Vec::new();
    for language in &query.languages {
        if entry.applies.languages.iter().any(|item| item == language) {
            matched.push(format!("language:{language}"));
        }
    }
    for kind in &query.service_kinds {
        if entry.applies.service_kinds.iter().any(|item| item == kind) {
            matched.push(format!("service_kind:{kind}"));
        }
    }
    for tag in &query.tags {
        if entry.applies.tags.iter().any(|item| item == tag) {
            matched.push(format!("tag:{tag}"));
        }
    }
    matched
}

/// 条目是否"总是适用"（通用知识：容量口径、可用性、备份、密钥纪律）。
fn always_applies(entry: &KnowledgeEntry) -> bool {
    entry.applies.tags.contains(&UNIVERSAL_TAG)
}

/// 确定性检索：同样的查询一定得到同样的结果（不依赖哈希顺序，最后按 id 排序）。
pub fn retrieve(query: &KnowledgeQuery) -> KnowledgeResult {
    let mut hits: Vec<KnowledgeHit> = Vec::new();
    for entry in KNOWLEDGE {
        let matched = matches(entry, query);
        let generic = always_applies(entry);
        if matched.is_empty() && !generic {
            continue;
        }
        let mut matched = matched;
        if generic && matched.is_empty() {
            matched.push("universal".to_string());
        }
        hits.push(KnowledgeHit { entry, matched });
    }
    hits.sort_by(|left, right| left.entry.id.cmp(right.entry.id));

    let mut result = KnowledgeResult {
        version: KNOWLEDGE_VERSION.to_string(),
        ..KnowledgeResult::empty()
    };

    for hit in &hits {
        result.references.push(KnowledgeReference {
            entry_id: hit.entry.id.to_string(),
            title: hit.entry.title.to_string(),
            version: KNOWLEDGE_VERSION.to_string(),
            source: hit.entry.source.to_string(),
            applies: hit.matched.join(", "),
            // 系统内置知识不给"片段"：它的作用是参与确定性评分，
            // 发给模型看的是**用户知识**（见 `deployment::knowledge`）。
            excerpt: String::new(),
            excerpt_hash: String::new(),
            last_verified_at: None,
            origin: super::model::KnowledgeOrigin::System,
        });
        for claim in hit.entry.claims {
            match claim.payload {
                ClaimPayload::PreferTopology { kind, weight } => {
                    result.preferred.push((kind, weight, claim.statement));
                }
                ClaimPayload::AvoidTopology { kind, reason } => {
                    result.avoided.push((kind, reason));
                }
                ClaimPayload::RequiresCapability {
                    topology,
                    capability,
                } => {
                    result.required_capabilities.push((topology, capability));
                }
                ClaimPayload::Sizing(rule) => {
                    result.sizing.push((claim.topic.to_string(), rule));
                }
                ClaimPayload::RequireHealthCheck { path } => {
                    result.health_paths.push((claim.topic, path));
                }
                ClaimPayload::RequireBackup { interval } => {
                    result.backup_interval = Some((claim.id, interval));
                }
                ClaimPayload::Note => {
                    if claim.kind == ClaimKind::Constraint || claim.kind == ClaimKind::Checklist {
                        result.checklist.push((claim.id, claim.statement));
                    }
                }
            }
        }
    }

    // 冲突：只认**显式声明**的（`conflicts_with` 双向或单向都算），
    // 且两边都真的被检索到 —— 没同时命中的条目不算冲突。
    let hit_ids: Vec<&str> = hits.iter().map(|hit| hit.entry.id).collect();
    let mut conflicts: Vec<KnowledgeConflict> = Vec::new();
    for hit in &hits {
        for other in hit.entry.conflicts_with {
            if !hit_ids.contains(other) {
                continue;
            }
            let Some(peer) = KNOWLEDGE.iter().find(|entry| entry.id == *other) else {
                continue;
            };
            let mut entries = vec![hit.entry.id.to_string(), peer.id.to_string()];
            entries.sort();
            if conflicts.iter().any(|existing| existing.entries == entries) {
                continue;
            }
            // **必须真的在同一个话题上打架才算冲突**。
            // 两条条目声明了 `conflicts_with` 却各说各的（比如"自带数据库"
            // 与"容器编排"），那是声明的粒度过粗，不是冲突 —— 报出来只会制造
            // 一堆假问题，最后逼得用户随便点一个，反而背离"不静默"的初衷。
            let Some(claim) = hit.entry.claims.iter().find(|claim| {
                peer.claims
                    .iter()
                    .any(|other_claim| other_claim.topic == claim.topic)
            }) else {
                continue;
            };
            let topic = claim.topic.to_string();
            let mut statements: Vec<String> = hit
                .entry
                .claims
                .iter()
                .chain(peer.claims.iter())
                .filter(|claim| claim.topic == topic)
                .map(|claim| claim.statement.to_string())
                .collect();
            statements.sort();
            statements.dedup();

            let mut topologies: Vec<TopologyKind> = Vec::new();
            let mut capability: Option<String> = None;
            for claim in hit.entry.claims.iter().chain(peer.claims.iter()) {
                match claim.payload {
                    ClaimPayload::PreferTopology { kind, .. } => topologies.push(kind),
                    ClaimPayload::AvoidTopology { kind, .. } => topologies.push(kind),
                    ClaimPayload::RequiresCapability {
                        capability: field, ..
                    } => capability = Some(field.to_string()),
                    _ => {}
                }
            }
            topologies.sort();
            topologies.dedup();

            conflicts.push(KnowledgeConflict {
                topic,
                entries,
                statements,
                topologies,
                capability,
                resolution: ConflictResolution::Unresolved,
                resolved_by: Vec::new(),
                explanation: format!(
                    "{} 与 {} 对同一主题给出不同结论，需要事实或策略裁定",
                    hit.entry.id, peer.id
                ),
            });
        }
    }
    conflicts.sort_by(|left, right| left.entries.cmp(&right.entries));
    result.conflicts = conflicts;

    result
        .preferred
        .sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    result.avoided.sort_by(|left, right| left.0.cmp(&right.0));
    result.required_capabilities.sort();
    result.required_capabilities.dedup();
    result.health_paths.sort();
    result.sizing.sort_by(|left, right| left.0.cmp(&right.0));
    result
}

// -- 冲突裁定 ---------------------------------------------------------------

/// 读一个能力字段（`deployment.docker` 这类路径）。
pub fn capability_value(profile: &ServerCapabilityProfile, field: &str) -> Option<bool> {
    let deployment = &profile.deployment;
    match field {
        "deployment.docker" => deployment.docker,
        "deployment.docker_compose" => deployment.docker_compose,
        "deployment.podman" => deployment.podman,
        "deployment.kubernetes" => deployment.kubernetes,
        "deployment.systemd" => deployment.systemd,
        "deployment.openrc" => deployment.openrc,
        "deployment.supervisor" => deployment.supervisor,
        "deployment.nginx" => deployment.nginx,
        "deployment.apache" => deployment.apache,
        "deployment.caddy" => deployment.caddy,
        "deployment.traefik" => deployment.traefik,
        "deployment.haproxy" => deployment.haproxy,
        "deployment.postgresql" => deployment.postgresql,
        "deployment.mysql" => deployment.mysql,
        "deployment.redis" => deployment.redis,
        "deployment.mongodb" => deployment.mongodb,
        _ => None,
    }
}

/// 用**服务器实时事实与安全策略**裁定知识库冲突。
///
/// 顺序即优先级：事实 → 策略 → 交给用户。
/// 裁定不了的一律保持 [`ConflictResolution::Unresolved`]，由引擎转成
/// `open_questions`（`BlocksPlan`），**绝不静默选一条**。
pub fn resolve_conflicts(
    conflicts: Vec<KnowledgeConflict>,
    capability: Option<&ServerCapabilityProfile>,
    policy: &SecurityPolicy,
) -> Vec<KnowledgeConflict> {
    let mut resolved: Vec<KnowledgeConflict> = Vec::new();
    for mut conflict in conflicts {
        // 1) 服务器实时事实：该形态需要的能力装没装。
        if let (Some(field), Some(profile)) = (conflict.capability.as_deref(), capability) {
            if let Some(installed) = capability_value(profile, field) {
                let evidence = Evidence::fact(
                    EvidenceSource::ServerFact {
                        field: field.to_string(),
                    },
                    format!(
                        "服务器实时事实：{field} = {}",
                        if installed { "已安装" } else { "未安装" }
                    ),
                );
                conflict.resolution = ConflictResolution::ServerFactWins;
                conflict.explanation = if installed {
                    format!("{field} 已安装，因此采用需要它的那条结论；另一条不适用。")
                } else {
                    format!("{field} 未安装，因此放弃需要它的那条结论（实时事实优先）。")
                };
                conflict.resolved_by = vec![evidence];
                resolved.push(conflict);
                continue;
            }
        }
        // 2) 安全策略：生产环境不允许自带数据库 / 一律要求备份。
        if conflict.topic == "topology.external" && policy.require_backup_for_production {
            conflict.resolution = ConflictResolution::PolicyWins;
            conflict.explanation =
                "安全策略要求生产环境必须可备份，自带数据库在没有备份方案时不被采纳。".to_string();
            conflict.resolved_by = vec![Evidence {
                class: EvidenceClass::Fact,
                source: EvidenceSource::Platform {
                    policy: "require_backup_for_production".to_string(),
                },
                detail: "安全策略：生产环境强制要求备份".to_string(),
                reference: None,
            }];
            resolved.push(conflict);
            continue;
        }
        // 3) 裁定不了：原样交回给用户（引擎会把它变成 open_question）。
        conflict.explanation = format!(
            "{}（无法用事实或策略裁定，需要你选择）",
            conflict.explanation
        );
        resolved.push(conflict);
    }
    resolved.sort_by(|left, right| left.entries.cmp(&right.entries));
    resolved
}
