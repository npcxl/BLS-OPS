//! P5.6 **用户 Memory** —— 与知识库分开的独立模型。
//!
//! * Knowledge = 人写的规范 / 手册 / 项目背景（长文本，版本化文档）；
//! * Memory = 从**用户行为与部署结果**学到的结构化偏好（受控 key + 类型化值）。
//!
//! # 安全边界（写进类型里）
//!
//! * `key` 是封闭枚举 [`MemoryKey`] —— "任意命令"无处可放；
//! * `value_json` 必须过 [`validate_value`] 的按 key 类型校验（枚举白名单 / 路径 /
//!   正整数），且任何字符串都禁止 shell 元字符；
//! * 安全策略、审批开关、Secret 明文**永远不能**成为 Memory（连 key 都不存在）。
//!
//! # 置信度（确定性规则，AI 不参与）
//!
//! 单次临时选择 = `pending`（不参与草案）；连续多次或用户明确表达 → 逐步 `active`；
//! 部署成功上调、失败/回滚下调。AI 只能提 [`MemoryCandidate`]，仍要过同一套校验。

use serde::{Deserialize, Serialize};

use crate::deployment::proposal::model::TopologyKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Preference,
    Correction,
    ProjectFact,
    Outcome,
    Avoidance,
}

impl MemoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryKind::Preference => "preference",
            MemoryKind::Correction => "correction",
            MemoryKind::ProjectFact => "project_fact",
            MemoryKind::Outcome => "outcome",
            MemoryKind::Avoidance => "avoidance",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            MemoryKind::Preference => "偏好",
            MemoryKind::Correction => "修正",
            MemoryKind::ProjectFact => "项目事实",
            MemoryKind::Outcome => "部署结果",
            MemoryKind::Avoidance => "避免",
        }
    }

    pub const ALL: &'static [MemoryKind] = &[
        MemoryKind::Preference,
        MemoryKind::Correction,
        MemoryKind::ProjectFact,
        MemoryKind::Outcome,
        MemoryKind::Avoidance,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    Global,
    Server,
    Application,
    Environment,
}

impl MemoryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryScope::Global => "global",
            MemoryScope::Server => "server",
            MemoryScope::Application => "application",
            MemoryScope::Environment => "environment",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            MemoryScope::Global => "全局",
            MemoryScope::Server => "服务器",
            MemoryScope::Application => "应用",
            MemoryScope::Environment => "环境",
        }
    }

    /// 检索优先级：环境 > 应用 > 服务器 > 全局。
    pub fn priority(self) -> u8 {
        match self {
            MemoryScope::Environment => 4,
            MemoryScope::Application => 3,
            MemoryScope::Server => 2,
            MemoryScope::Global => 1,
        }
    }

    pub fn needs_scope_id(self) -> bool {
        !matches!(self, MemoryScope::Global)
    }

    pub const ALL: &'static [MemoryScope] = &[
        MemoryScope::Global,
        MemoryScope::Server,
        MemoryScope::Application,
        MemoryScope::Environment,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemorySourceType {
    Explicit,
    RepeatedChoice,
    ProposalEdit,
    DeploymentResult,
}

impl MemorySourceType {
    pub fn as_str(self) -> &'static str {
        match self {
            MemorySourceType::Explicit => "explicit",
            MemorySourceType::RepeatedChoice => "repeated_choice",
            MemorySourceType::ProposalEdit => "proposal_edit",
            MemorySourceType::DeploymentResult => "deployment_result",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            MemorySourceType::Explicit => "用户明确表达",
            MemorySourceType::RepeatedChoice => "重复选择",
            MemorySourceType::ProposalEdit => "修改草案",
            MemorySourceType::DeploymentResult => "部署结果",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatus {
    /// 观察中：置信度不够，**不参与**草案生成（单次临时选择停在这里）。
    #[default]
    Pending,
    Active,
    /// 被用户停用（保留审计）。
    Rejected,
    Superseded,
}

impl MemoryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryStatus::Pending => "pending",
            MemoryStatus::Active => "active",
            MemoryStatus::Rejected => "rejected",
            MemoryStatus::Superseded => "superseded",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            MemoryStatus::Pending => "待确认",
            MemoryStatus::Active => "生效中",
            MemoryStatus::Rejected => "已停用",
            MemoryStatus::Superseded => "已被取代",
        }
    }

    pub const ALL: &'static [MemoryStatus] = &[
        MemoryStatus::Pending,
        MemoryStatus::Active,
        MemoryStatus::Rejected,
        MemoryStatus::Superseded,
    ];
}

/// **受控** Memory key。新增必须在这里登记（含 value 校验分支）。
///
/// 刻意没有 `command` / `args` / `secret` / `approval_override`：
/// 安全策略与审批永远不能被 Memory 影响。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKey {
    PreferredRuntime,
    PreferredTopology,
    PreferredDeployRoot,
    PreferredHealthPath,
    PreferredSslMode,
    PreferredPackageManager,
    PreferredReleaseRetention,
    PreferredNginxLayout,
    AvoidTopology,
}

impl MemoryKey {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryKey::PreferredRuntime => "preferred_runtime",
            MemoryKey::PreferredTopology => "preferred_topology",
            MemoryKey::PreferredDeployRoot => "preferred_deploy_root",
            MemoryKey::PreferredHealthPath => "preferred_health_path",
            MemoryKey::PreferredSslMode => "preferred_ssl_mode",
            MemoryKey::PreferredPackageManager => "preferred_package_manager",
            MemoryKey::PreferredReleaseRetention => "preferred_release_retention",
            MemoryKey::PreferredNginxLayout => "preferred_nginx_layout",
            MemoryKey::AvoidTopology => "avoid_topology",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            MemoryKey::PreferredRuntime => "首选运行时",
            MemoryKey::PreferredTopology => "首选拓扑",
            MemoryKey::PreferredDeployRoot => "首选部署根目录",
            MemoryKey::PreferredHealthPath => "首选健康检查路径",
            MemoryKey::PreferredSslMode => "首选证书方式",
            MemoryKey::PreferredPackageManager => "首选包管理器",
            MemoryKey::PreferredReleaseRetention => "保留版本数",
            MemoryKey::PreferredNginxLayout => "Nginx 站点布局",
            MemoryKey::AvoidTopology => "避免的拓扑",
        }
    }

    /// 建议作用域（用户可覆盖，但默认就是最合理的那一档）。
    pub fn default_scope(self) -> MemoryScope {
        match self {
            MemoryKey::PreferredRuntime
            | MemoryKey::PreferredPackageManager
            | MemoryKey::PreferredReleaseRetention
            | MemoryKey::PreferredNginxLayout => MemoryScope::Global,
            MemoryKey::PreferredTopology
            | MemoryKey::PreferredDeployRoot
            | MemoryKey::AvoidTopology => MemoryScope::Application,
            MemoryKey::PreferredHealthPath | MemoryKey::PreferredSslMode => {
                MemoryScope::Environment
            }
        }
    }

    pub const ALL: &'static [MemoryKey] = &[
        MemoryKey::PreferredRuntime,
        MemoryKey::PreferredTopology,
        MemoryKey::PreferredDeployRoot,
        MemoryKey::PreferredHealthPath,
        MemoryKey::PreferredSslMode,
        MemoryKey::PreferredPackageManager,
        MemoryKey::PreferredReleaseRetention,
        MemoryKey::PreferredNginxLayout,
        MemoryKey::AvoidTopology,
    ];

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|key| key.as_str() == value)
    }
}

/// 运行时白名单（与 artifact `Language` 的 serde 取值一致）。
pub const RUNTIME_VALUES: &[&str] = &[
    "node", "java", "go", "python", "rust", "php", "dotnet", "ruby", "static",
];

/// 包管理器白名单（与 artifact `PackageManager` 一致）。
pub const PACKAGE_MANAGER_VALUES: &[&str] = &[
    "npm", "pnpm", "yarn", "maven", "gradle", "cargo", "pip", "poetry", "composer", "bundler",
    "nuget",
];

pub const NGINX_LAYOUT_VALUES: &[&str] = &["site_per_app", "shared_site"];

/// 一条 Memory。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentMemory {
    pub id: String,
    pub kind: MemoryKind,
    pub scope: MemoryScope,
    #[serde(default)]
    pub scope_id: Option<String>,
    pub key: MemoryKey,
    pub value_json: serde_json::Value,
    /// 0-100。
    pub confidence: u8,
    pub source_type: MemorySourceType,
    #[serde(default)]
    pub source_event_id: Option<String>,
    pub status: MemoryStatus,
    #[serde(default)]
    pub success_count: u32,
    #[serde(default)]
    pub failure_count: u32,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl DeploymentMemory {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: impl Into<String>,
        kind: MemoryKind,
        scope: MemoryScope,
        scope_id: Option<String>,
        key: MemoryKey,
        value_json: serde_json::Value,
        source_type: MemorySourceType,
        now: i64,
    ) -> Self {
        Self {
            id: id.into(),
            kind,
            scope,
            scope_id,
            key,
            value_json,
            confidence: 0,
            source_type,
            source_event_id: None,
            status: MemoryStatus::Pending,
            success_count: 0,
            failure_count: 0,
            last_used_at: None,
            created_at: now,
            updated_at: now,
        }
    }
}

pub const CONFIDENCE_SINGLE_CHOICE: u8 = 30;
pub const CONFIDENCE_EXPLICIT: u8 = 90;
pub const CONFIDENCE_REPEATED_BASE: u8 = 50;
pub const CONFIDENCE_REPEATED_STEP: u8 = 10;
/// 达到这个置信度才自动 `active`。
pub const CONFIDENCE_ACTIVE_THRESHOLD: u8 = 70;
/// 下调后低于该值 → 退回 `pending`。
pub const CONFIDENCE_SUSPEND_THRESHOLD: u8 = 30;

/// 字符串里是否含 shell 元字符（所有字符串型 value 的兜底检查）。
pub fn contains_shell_meta(text: &str) -> bool {
    const META: &[&str] = &[
        "`", "$(", "${", ";", "&&", "||", "|", ">", "<", "\n", "\r", "\\", "*", "?", "~",
    ];
    META.iter().any(|token| text.contains(token))
}

/// **按 key 校验 value_json** —— Memory 的唯一写入口校验。
pub fn validate_value(key: MemoryKey, value: &serde_json::Value) -> Result<(), String> {
    match key {
        MemoryKey::PreferredRuntime => {
            expect_member(key, expect_str(key, value)?, RUNTIME_VALUES)?;
        }
        MemoryKey::PreferredPackageManager => {
            expect_member(key, expect_str(key, value)?, PACKAGE_MANAGER_VALUES)?;
        }
        MemoryKey::PreferredNginxLayout => {
            expect_member(key, expect_str(key, value)?, NGINX_LAYOUT_VALUES)?;
        }
        // 与 `deployment::model::SslMode` 的 serde 取值一致。
        MemoryKey::PreferredSslMode => {
            expect_member(key, expect_str(key, value)?, &["none", "manual", "acme"])?;
        }
        MemoryKey::PreferredTopology | MemoryKey::AvoidTopology => {
            let text = expect_str(key, value)?;
            serde_json::from_value::<TopologyKind>(serde_json::Value::String(text.to_string()))
                .map_err(|_| format!("拓扑取值 {text} 不在受支持范围内"))?;
        }
        MemoryKey::PreferredDeployRoot => {
            let text = expect_str(key, value)?;
            if !text.starts_with('/') {
                return Err("部署根目录必须是绝对路径（以 / 开头）".to_string());
            }
            if text.contains("..") || text.contains("//") || text.ends_with('/') {
                return Err("部署根目录不能含 .. / // / 结尾斜杠".to_string());
            }
        }
        MemoryKey::PreferredHealthPath => {
            let text = expect_str(key, value)?;
            if !text.starts_with('/') || text.contains("..") {
                return Err("健康检查路径必须以 / 开头且不能含 ..".to_string());
            }
        }
        MemoryKey::PreferredReleaseRetention => {
            let number = value
                .as_u64()
                .ok_or_else(|| "保留版本数必须是正整数".to_string())?;
            if !(1..=50).contains(&number) {
                return Err("保留版本数必须在 1..=50 之间".to_string());
            }
        }
    }
    Ok(())
}

fn expect_str<'a>(key: MemoryKey, value: &'a serde_json::Value) -> Result<&'a str, String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("`{}` 的值必须是字符串", key.as_str()))?;
    if text.trim().is_empty() {
        return Err(format!("`{}` 的值不能为空", key.as_str()));
    }
    if contains_shell_meta(text) {
        return Err(format!("`{}` 的值不能包含 shell 元字符", key.as_str()));
    }
    Ok(text)
}

fn expect_member(key: MemoryKey, value: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&value) {
        return Ok(());
    }
    Err(format!(
        "`{}` 的取值 {value} 不在受支持范围内：{}",
        key.as_str(),
        allowed.join(" / ")
    ))
}

/// 用户明确表达长期偏好 → 直接生效。
pub fn explicit_preference(mut memory: DeploymentMemory, now: i64) -> DeploymentMemory {
    memory.confidence = CONFIDENCE_EXPLICIT;
    memory.status = MemoryStatus::Active;
    memory.updated_at = now;
    memory
}

/// 观察到一个选择（`observations` 为**含本次**的累计次数）。
pub fn observe_choice(
    mut memory: DeploymentMemory,
    observations: u32,
    now: i64,
) -> DeploymentMemory {
    if observations <= 1 {
        // 单次临时选择**不会**立刻变成全局默认。
        memory.confidence = CONFIDENCE_SINGLE_CHOICE;
        memory.status = MemoryStatus::Pending;
    } else {
        // u8 运算：累计次数先夹到 20 步以内（再多重复也不会超过 100）。
        let steps = observations.saturating_sub(1).min(20) as u8;
        memory.confidence = CONFIDENCE_REPEATED_BASE
            .saturating_add(CONFIDENCE_REPEATED_STEP.saturating_mul(steps))
            .min(100);
        memory.status = if memory.confidence >= CONFIDENCE_ACTIVE_THRESHOLD {
            MemoryStatus::Active
        } else {
            MemoryStatus::Pending
        };
    }
    memory.updated_at = now;
    memory
}

/// 部署成功 → 计数 + 上调。
pub fn record_success(mut memory: DeploymentMemory, now: i64) -> DeploymentMemory {
    memory.success_count = memory.success_count.saturating_add(1);
    memory.confidence = memory.confidence.saturating_add(5).min(100);
    if memory.status == MemoryStatus::Pending && memory.confidence >= CONFIDENCE_ACTIVE_THRESHOLD {
        memory.status = MemoryStatus::Active;
    }
    memory.last_used_at = Some(now);
    memory.updated_at = now;
    memory
}

/// 部署失败 / 回滚 → 计数 + 下调（过低退回 `pending`）。
pub fn record_failure(mut memory: DeploymentMemory, now: i64) -> DeploymentMemory {
    memory.failure_count = memory.failure_count.saturating_add(1);
    memory.confidence = memory.confidence.saturating_sub(15);
    if memory.confidence < CONFIDENCE_SUSPEND_THRESHOLD {
        memory.status = MemoryStatus::Pending;
    }
    memory.last_used_at = Some(now);
    memory.updated_at = now;
    memory
}

/// AI 提出的 Memory 建议 —— **只是建议**，仍要过 [`validate_value`] 与确定性规则。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct MemoryCandidate {
    pub kind: MemoryKind,
    pub scope: MemoryScope,
    #[serde(default)]
    pub scope_id: Option<String>,
    pub key: MemoryKey,
    pub value_json: serde_json::Value,
    #[serde(default)]
    pub reason: String,
}

impl MemoryCandidate {
    pub fn validate(&self) -> Result<(), String> {
        validate_value(self.key, &self.value_json)?;
        if self.scope.needs_scope_id() && self.scope_id.as_deref().unwrap_or("").trim().is_empty() {
            return Err(format!("作用域 {} 必须给出具体 id", self.scope.as_str()));
        }
        Ok(())
    }
}
