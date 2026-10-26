//! P5.6 **AI 部署草案的数据形状**（严格 Schema，`deny_unknown_fields`）。
//!
//! # 硬边界（写进类型里，不靠事后过滤）
//!
//! * **没有任何自由命令字段**：没有 `command` / `cmd` / `shell` / `script` /
//!   `entrypoint` / `args` —— 出现即 `serde` 解析失败，整份草案作废。
//! * 运行时是**受控枚举**（[`DraftRuntime`]），不是"模型随便写的启动命令"。
//! * 密钥只给 [`DraftService::secret_refs`]（引用既有 `SecretRef.id`），
//!   永远没有明文值的入口。
//! * 引用（Memory / Knowledge）只是 id 列表，真伪由 `validate` 阶段核对。

use serde::{Deserialize, Serialize};

use crate::deployment::model::{RiskLevel, ServiceKind, SslMode};
use crate::deployment::proposal::model::TopologyKind;
use crate::deployment::session::model::QuestionKind;

/// AI 可以选择的运行时（**封闭集合**）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftRuntime {
    StaticSite,
    NodeProcess,
    JavaProcess,
    PythonProcess,
    GoProcess,
    PhpProcess,
    DockerImage,
    DockerCompose,
    /// 外部托管（数据库、缓存等）—— 本机不起进程。
    ExternalManaged,
}

impl DraftRuntime {
    pub fn as_str(self) -> &'static str {
        match self {
            DraftRuntime::StaticSite => "static_site",
            DraftRuntime::NodeProcess => "node_process",
            DraftRuntime::JavaProcess => "java_process",
            DraftRuntime::PythonProcess => "python_process",
            DraftRuntime::GoProcess => "go_process",
            DraftRuntime::PhpProcess => "php_process",
            DraftRuntime::DockerImage => "docker_image",
            DraftRuntime::DockerCompose => "docker_compose",
            DraftRuntime::ExternalManaged => "external_managed",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            DraftRuntime::StaticSite => "静态站点",
            DraftRuntime::NodeProcess => "Node 进程",
            DraftRuntime::JavaProcess => "Java 进程",
            DraftRuntime::PythonProcess => "Python 进程",
            DraftRuntime::GoProcess => "Go 进程",
            DraftRuntime::PhpProcess => "PHP 进程",
            DraftRuntime::DockerImage => "容器镜像",
            DraftRuntime::DockerCompose => "Docker Compose",
            DraftRuntime::ExternalManaged => "外部托管",
        }
    }

    pub const ALL: &'static [DraftRuntime] = &[
        DraftRuntime::StaticSite,
        DraftRuntime::NodeProcess,
        DraftRuntime::JavaProcess,
        DraftRuntime::PythonProcess,
        DraftRuntime::GoProcess,
        DraftRuntime::PhpProcess,
        DraftRuntime::DockerImage,
        DraftRuntime::DockerCompose,
        DraftRuntime::ExternalManaged,
    ];

    /// 是否与既有 `ServiceRuntime` 家族对得上（编译器只能保证枚举存在，
    /// 具体映射由 PlanCompiler 负责并在那里再校验一次）。
    pub fn is_container(self) -> bool {
        matches!(
            self,
            DraftRuntime::DockerImage | DraftRuntime::DockerCompose
        )
    }
}

/// 一个服务的部署意图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DraftService {
    pub name: String,
    pub service_kind: ServiceKind,
    pub runtime: DraftRuntime,
    #[serde(default)]
    pub port: Option<u16>,
    /// 健康检查路径（必须以 `/` 开头，不允许含 shell 元字符）。
    #[serde(default)]
    pub health_path: Option<String>,
    /// 需要的环境变量**名称**。
    #[serde(default)]
    pub env_keys: Vec<String>,
    /// 引用既有 `SecretRef.id`（**不是明文**）。
    #[serde(default)]
    pub secret_refs: Vec<String>,
    /// 相对部署目录建议（必须落在环境 deploy_root 内，由 validate 核对）。
    #[serde(default)]
    pub deploy_path_hint: Option<String>,
    /// 依据（方案里的服务名 / 证据 id）。
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}

/// 域名意图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DraftDomain {
    pub domain: String,
    pub service_name: String,
    #[serde(default)]
    pub listen_port: Option<u16>,
    #[serde(default)]
    pub path_prefix: Option<String>,
    pub ssl_mode: SslMode,
}

/// 证书意图（**只有方式，没有凭据**）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DraftSsl {
    pub mode: SslMode,
    /// DNS 服务商名字（只是引用；没有可写 DNS 的适配器时进人工步骤）。
    #[serde(default)]
    pub dns_provider: Option<String>,
    #[serde(default)]
    pub dns_records: Vec<String>,
}

/// 依赖决策（`kind` 是受控词，validate 会核对）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DraftDependency {
    pub from_service: String,
    pub to_service: String,
    pub kind: String,
    pub required: bool,
    /// 指向外部服务（托管数据库等），不是本机进程。
    #[serde(default)]
    pub external: bool,
}

/// 容量建议（**只是建议**：最终数字仍由确定性容量评估算出）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DraftCapacity {
    #[serde(default)]
    pub expected_qps: Option<f64>,
    #[serde(default)]
    pub expected_concurrency: Option<u32>,
    #[serde(default)]
    pub memory_mb: Option<u32>,
    #[serde(default)]
    pub disk_gb: Option<u32>,
    #[serde(default)]
    pub note: String,
}

/// 风险条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DraftRisk {
    pub id: String,
    pub title: String,
    pub severity: RiskLevel,
    #[serde(default)]
    pub mitigation: String,
}

/// 阻塞问题（**只能问真正阻塞的**；非阻塞信息应写成假设）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DraftQuestion {
    pub id: String,
    pub kind: QuestionKind,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
}

/// AI 返回的部署草案（**严格 Schema**）。
///
/// 解析这一步就已经是安全边界的一半：任何多出来的字段（尤其是
/// `command` / `args` / `shell`）都会让整份 JSON 解析失败。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AiDeploymentDraft {
    pub summary: String,
    /// 拓扑（枚举；不在受支持集合内 → validate 拒绝）。
    pub topology: TopologyKind,
    pub services: Vec<DraftService>,
    #[serde(default)]
    pub dependency_decisions: Vec<DraftDependency>,
    #[serde(default)]
    pub domain_intent: Option<DraftDomain>,
    #[serde(default)]
    pub ssl_intent: Option<DraftSsl>,
    #[serde(default)]
    pub capacity_suggestions: DraftCapacity,
    #[serde(default)]
    pub assumptions: Vec<String>,
    #[serde(default)]
    pub risks: Vec<DraftRisk>,
    #[serde(default)]
    pub blocking_questions: Vec<DraftQuestion>,
    /// 引用的 Memory（`memory:<id>`）。
    #[serde(default)]
    pub memory_refs: Vec<String>,
    /// 引用的 Knowledge（`knowledge:<id>@<version>`）。
    #[serde(default)]
    pub knowledge_refs: Vec<String>,
    /// 为什么这么建议（展示用）。
    #[serde(default)]
    pub explanation: String,
}

impl AiDeploymentDraft {
    /// 草案里**有没有**自由命令类字段的痕迹（正常路径下永远为 false：
    /// 出现这类字段时 `serde` 已经解析失败）。留给界面/审计做二次确认。
    pub fn looks_like_it_carries_a_command(&self) -> bool {
        let text = format!("{:?}", self).to_lowercase();
        [
            "\"command\"",
            "\"cmd\"",
            "\"shell\"",
            "\"script\"",
            "\"entrypoint\"",
            "\"args\"",
        ]
        .iter()
        .any(|needle| text.contains(needle))
    }
}

// __APPEND__
