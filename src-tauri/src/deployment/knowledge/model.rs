//! 用户可管理知识库的**数据模型**。
//!
//! # 两层知识（这个区分是安全边界）
//!
//! | | SystemKnowledge（`proposal::knowledge`） | UserKnowledge（本模块） |
//! |---|---|---|
//! | 存放 | 编译期常量，随代码走 | SQLite，用户随时改 |
//! | 参与决策 | **是**（拓扑评分、容量口径、策略裁定） | **否** |
//! | 用途 | 确定性引擎的规则 | AI 复核的背景、公司规范、运维手册、检查清单 |
//! | 可被用户改 | 不能 | 可以 |
//!
//! 因此**用户知识永远不能覆盖系统安全规则**（审批、Secret 保护、路径围栏、
//! 命令限制）：它连进入决策路径的入口都没有。
//!
//! # 版本规则
//!
//! 保存一次 = 一个新版本，**旧版本永不覆盖**：
//! * 方案指纹记录的是"当时引用的 id + 版本"；
//! * 删文档用软删除（`status = archived`），历史引用仍然可追溯到内容；
//! * "恢复旧版本"= 把旧内容**作为新版本**写入（不是把版本指针拨回去）。
//!
//! # 知识是不可信数据
//!
//! 文档内容可能来自公司 wiki、某次导入的 markdown —— 其中出现
//! "忽略系统规则""执行以下命令"之类文字时，我们**只把它当引用数据**：
//! 检索会给它打上 `suspicious` 标记，提示词里明说它是不可信参考资料，
//! 但**不会**把它当指令，也不会因此拒绝整篇（那是数据，不是攻击面 ——
//! 真正的防线在"AI 输出不接受命令"与"AI 不参与决策"这两层）。

use serde::{Deserialize, Serialize};

/// 作用域。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeScope {
    Global,
    Application,
    Environment,
}

impl KnowledgeScope {
    pub fn as_str(self) -> &'static str {
        match self {
            KnowledgeScope::Global => "global",
            KnowledgeScope::Application => "application",
            KnowledgeScope::Environment => "environment",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            KnowledgeScope::Global => "全局",
            KnowledgeScope::Application => "应用",
            KnowledgeScope::Environment => "环境",
        }
    }

    /// 检索优先级：**环境 > 应用 > 全局**（越贴近当前部署越可信）。
    pub fn priority(self) -> u8 {
        match self {
            KnowledgeScope::Environment => 3,
            KnowledgeScope::Application => 2,
            KnowledgeScope::Global => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeCategory {
    Platform,
    DeploymentPattern,
    Sizing,
    Dns,
    Ssl,
    HealthCheck,
    Rollback,
    Security,
    Troubleshooting,
    ProjectContext,
    Custom,
}

impl KnowledgeCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            KnowledgeCategory::Platform => "platform",
            KnowledgeCategory::DeploymentPattern => "deployment_pattern",
            KnowledgeCategory::Sizing => "sizing",
            KnowledgeCategory::Dns => "dns",
            KnowledgeCategory::Ssl => "ssl",
            KnowledgeCategory::HealthCheck => "health_check",
            KnowledgeCategory::Rollback => "rollback",
            KnowledgeCategory::Security => "security",
            KnowledgeCategory::Troubleshooting => "troubleshooting",
            KnowledgeCategory::ProjectContext => "project_context",
            KnowledgeCategory::Custom => "custom",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            KnowledgeCategory::Platform => "平台",
            KnowledgeCategory::DeploymentPattern => "部署形态",
            KnowledgeCategory::Sizing => "容量口径",
            KnowledgeCategory::Dns => "DNS",
            KnowledgeCategory::Ssl => "证书",
            KnowledgeCategory::HealthCheck => "健康检查",
            KnowledgeCategory::Rollback => "回滚",
            KnowledgeCategory::Security => "安全",
            KnowledgeCategory::Troubleshooting => "排障",
            KnowledgeCategory::ProjectContext => "项目背景",
            KnowledgeCategory::Custom => "自定义",
        }
    }

    pub const ALL: &'static [KnowledgeCategory] = &[
        KnowledgeCategory::Platform,
        KnowledgeCategory::DeploymentPattern,
        KnowledgeCategory::Sizing,
        KnowledgeCategory::Dns,
        KnowledgeCategory::Ssl,
        KnowledgeCategory::HealthCheck,
        KnowledgeCategory::Rollback,
        KnowledgeCategory::Security,
        KnowledgeCategory::Troubleshooting,
        KnowledgeCategory::ProjectContext,
        KnowledgeCategory::Custom,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeSourceType {
    /// 界面里手写的。
    Manual,
    /// 从 `.md` 文件导入。
    MarkdownFile,
    /// 粘贴进来的文本。
    ImportedText,
}

impl KnowledgeSourceType {
    pub fn as_str(self) -> &'static str {
        match self {
            KnowledgeSourceType::Manual => "manual",
            KnowledgeSourceType::MarkdownFile => "markdown_file",
            KnowledgeSourceType::ImportedText => "imported_text",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            KnowledgeSourceType::Manual => "手写",
            KnowledgeSourceType::MarkdownFile => "Markdown 导入",
            KnowledgeSourceType::ImportedText => "文本粘贴",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeDocStatus {
    Draft,
    Active,
    /// 软删除：文档不可检索，但历史方案里的引用仍然能读到内容与版本。
    Archived,
}

impl KnowledgeDocStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            KnowledgeDocStatus::Draft => "draft",
            KnowledgeDocStatus::Active => "active",
            KnowledgeDocStatus::Archived => "archived",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            KnowledgeDocStatus::Draft => "草稿",
            KnowledgeDocStatus::Active => "已启用",
            KnowledgeDocStatus::Archived => "已归档",
        }
    }
}

/// 一份知识文档的**当前版本**（`knowledge_documents`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct KnowledgeDocument {
    pub id: String,
    pub title: String,
    pub scope: KnowledgeScope,
    /// `scope = application` 时必填。
    pub application_id: Option<String>,
    /// `scope = environment` 时必填。
    pub environment_id: Option<String>,
    pub category: KnowledgeCategory,
    pub tags: Vec<String>,
    pub source_type: KnowledgeSourceType,
    /// 来源说明（文件名 / 手册名 / 链接标题 —— **人能核对的那种**）。
    pub source_name: String,
    /// 当前版本号（每次保存 +1）。
    pub version: i64,
    pub status: KnowledgeDocStatus,
    /// 当前版本正文（Markdown）。
    pub content: String,
    /// 正文哈希（内容变了版本就得变；提示词哈希要覆盖它）。
    pub content_hash: String,
    pub enabled: bool,
    pub last_verified_at: Option<i64>,
    pub note: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 一个历史版本（`knowledge_document_versions`，永不覆盖）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct KnowledgeVersion {
    pub id: String,
    pub document_id: String,
    pub version: i64,
    pub title: String,
    pub content: String,
    pub content_hash: String,
    pub source_type: KnowledgeSourceType,
    pub note: String,
    pub created_at: i64,
}

/// 方案引用知识的记录（供"被哪些方案引用"与"当时用的哪一版"查询）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct KnowledgeUsageRecord {
    pub id: String,
    pub document_id: String,
    pub version: i64,
    pub proposal_id: String,
    /// 使用它的地方：AI 复核 / 确定性引用。
    pub used_by: String,
    pub created_at: i64,
}

/// 检索入参（跨 IPC，因此要能序列化）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct KnowledgeQueryInput {
    pub application_id: Option<String>,
    pub environment_id: Option<String>,
    /// 检索词（服务技术栈、ServiceKind、Runtime 名、端口、域名、风险关键词…）。
    pub terms: Vec<String>,
    pub categories: Vec<KnowledgeCategory>,
    pub tags: Vec<String>,
    pub limit: usize,
}

/// 一条检索结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct KnowledgeHit {
    pub document_id: String,
    pub version: i64,
    pub title: String,
    /// 命中位置附近的一段（**已按预算截断**）。
    pub excerpt: String,
    /// 稳定排序用的分数（确定性算法，不含时间戳以外的随机因素）。
    pub score: u64,
    pub matched_terms: Vec<String>,
    pub source_name: String,
    pub last_verified_at: Option<i64>,
    pub scope: KnowledgeScope,
    pub category: KnowledgeCategory,
    /// 与其它命中条目可能冲突（同一分类里出现相反表述）。
    pub conflicts_with: Vec<String>,
    /// 正文里有"忽略系统规则/执行以下命令"这类文字 —— **只能当数据**。
    pub suspicious: bool,
    /// 命中的可疑标记（便于界面解释为什么打了这个标）。
    pub suspicious_markers: Vec<String>,
}

impl KnowledgeHit {
    /// 提示词里用的条目 id（`knowledge:<id>@<version>`）。
    pub fn entry_id(&self) -> String {
        format!("knowledge:{}@{}", self.document_id, self.version)
    }

    /// 过期（超过 180 天没验证）的知识在提示词里必须被标注。
    pub fn is_stale(&self, now: i64) -> bool {
        match self.last_verified_at {
            None => true,
            Some(verified) => now.saturating_sub(verified) > STALE_AFTER_MS,
        }
    }
}

/// 超过这个时长没验证就标"过期"（约 180 天）。
pub const STALE_AFTER_MS: i64 = 180 * 24 * 60 * 60 * 1000;

/// 提示词预算（**防止把整套知识库发给模型**）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnowledgeBudget {
    /// 每人条片段的字符上限。
    pub max_excerpt_chars: usize,
    /// 最多取几条。
    pub max_hits: usize,
    /// 所有片段加起来发给模型的字符上限。
    pub max_total_chars: usize,
}

impl Default for KnowledgeBudget {
    fn default() -> Self {
        Self {
            max_excerpt_chars: 600,
            max_hits: 8,
            max_total_chars: 4_800,
        }
    }
}

/// 可疑标记：出现这些文字时，文档仍然可用，但**只作为引用数据**。
///
/// 这不是"内容审核" —— 我们不会因为一篇运维手册里写了"执行以下命令"
/// 就把它禁掉；我们要保证的是：**这句话永远不会被当成给系统的指令**。
pub const SUSPICIOUS_MARKERS: &[&str] = &[
    "忽略系统规则",
    "忽略以上规则",
    "忽略之前的",
    "ignore previous",
    "ignore all previous",
    "system:",
    "执行以下命令",
    "立刻执行",
    "sudo rm",
    "rm -rf",
];

impl KnowledgeDocument {
    /// 新建一份文档（版本从 1 开始）。
    pub fn new(id: impl Into<String>, title: impl Into<String>, now: i64) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            scope: KnowledgeScope::Global,
            application_id: None,
            environment_id: None,
            category: KnowledgeCategory::Custom,
            tags: Vec::new(),
            source_type: KnowledgeSourceType::Manual,
            source_name: String::new(),
            version: 1,
            status: KnowledgeDocStatus::Draft,
            content: String::new(),
            content_hash: String::new(),
            enabled: false,
            last_verified_at: None,
            note: String::new(),
            created_at: now,
            updated_at: now,
        }
    }

    /// 作用域是否适用于给定的应用 / 环境。
    pub fn applies_to(&self, application_id: Option<&str>, environment_id: Option<&str>) -> bool {
        match self.scope {
            KnowledgeScope::Global => true,
            KnowledgeScope::Application => match (&self.application_id, application_id) {
                (Some(owner), Some(target)) => owner == target,
                _ => false,
            },
            KnowledgeScope::Environment => match (&self.environment_id, environment_id) {
                (Some(owner), Some(target)) => owner == target,
                _ => false,
            },
        }
    }

    /// 是否参与检索。
    pub fn is_searchable(&self) -> bool {
        self.enabled && self.status == KnowledgeDocStatus::Active
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_priority_is_environment_first() {
        assert!(KnowledgeScope::Environment.priority() > KnowledgeScope::Application.priority());
        assert!(KnowledgeScope::Application.priority() > KnowledgeScope::Global.priority());
    }

    #[test]
    fn scope_filters_match_only_their_own_target() {
        let mut document = KnowledgeDocument::new("d1", "t", 1);
        document.status = KnowledgeDocStatus::Active;
        document.enabled = true;

        document.scope = KnowledgeScope::Global;
        assert!(document.applies_to(Some("app-1"), Some("env-1")));

        document.scope = KnowledgeScope::Application;
        document.application_id = Some("app-1".to_string());
        assert!(document.applies_to(Some("app-1"), Some("env-1")));
        assert!(!document.applies_to(Some("app-2"), Some("env-1")));

        document.scope = KnowledgeScope::Environment;
        document.environment_id = Some("env-1".to_string());
        assert!(document.applies_to(Some("app-2"), Some("env-1")));
        assert!(!document.applies_to(Some("app-2"), Some("env-2")));
    }

    #[test]
    fn stale_documents_are_marked_by_the_last_verification_date() {
        let mut hit = KnowledgeHit {
            document_id: "d1".to_string(),
            version: 1,
            title: "t".to_string(),
            excerpt: String::new(),
            score: 1,
            matched_terms: Vec::new(),
            source_name: String::new(),
            last_verified_at: None,
            scope: KnowledgeScope::Global,
            category: KnowledgeCategory::Custom,
            conflicts_with: Vec::new(),
            suspicious: false,
            suspicious_markers: Vec::new(),
        };
        // 从来没验证过 = 过期（不能当新知识用）。
        assert!(hit.is_stale(1_000_000));
        hit.last_verified_at = Some(1_000_000);
        assert!(!hit.is_stale(1_000_000 + 1000));
        assert!(hit.is_stale(1_000_000 + STALE_AFTER_MS + 1));
    }

    #[test]
    fn entry_id_is_stable_and_carries_the_version() {
        let hit = KnowledgeHit {
            document_id: "doc-7".to_string(),
            version: 3,
            title: "t".to_string(),
            excerpt: String::new(),
            score: 0,
            matched_terms: Vec::new(),
            source_name: String::new(),
            last_verified_at: None,
            scope: KnowledgeScope::Global,
            category: KnowledgeCategory::Custom,
            conflicts_with: Vec::new(),
            suspicious: false,
            suspicious_markers: Vec::new(),
        };
        assert_eq!(hit.entry_id(), "knowledge:doc-7@3");
    }
}
