//! P4.0 命令数据规范：知识条目、风险分级与执行映射。
//!
//! 铁律：
//! - 产品名 / 命令名 / 参数全部是字符串或 `&'static str`，**不建产品枚举**
//!   （新增一条命令不改任何核心类型）；
//! - [`KnowledgeExec::capability`] 是知识库到安全白名单的**唯一**翻译点，
//!   命令字符串仍只在 `safe.rs` 拼；本模块绝不产生 shell 文本；
//! - `high` / `destructive` 风险条目第一批不入库（见 mod.rs 文档）。

use serde::{Deserialize, Serialize};

use crate::safe::{Capability, ContainerAction, ProbeTool, ServiceAction};

/// 命令风险等级（UI 标签见 [`RiskLevel::label`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    /// 只读：可直接运行。
    ReadOnly,
    /// 低风险修改：创建目录、上传文件；显示影响范围。
    Low,
    /// 中风险：restart / reload；必须二次确认。
    Medium,
    /// 高风险：覆盖配置、停生产服务；预检查 + 快照 + 确认 + 回滚。
    High,
    /// 删除：只能进 P4 软删除流程，**第一批不收录**。
    Destructive,
}

impl RiskLevel {
    pub fn label(self) -> &'static str {
        match self {
            RiskLevel::ReadOnly => "只读",
            RiskLevel::Low => "低风险",
            RiskLevel::Medium => "需确认",
            RiskLevel::High => "高风险",
            RiskLevel::Destructive => "删除",
        }
    }

    /// 排序权重（提示列表里只读排前面）。
    pub fn rank(self) -> u8 {
        match self {
            RiskLevel::ReadOnly => 0,
            RiskLevel::Low => 1,
            RiskLevel::Medium => 2,
            RiskLevel::High => 3,
            RiskLevel::Destructive => 4,
        }
    }
}

/// 命令的可变性（与风险正交：重启是 medium+change）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mutability {
    Read,
    Change,
    Delete,
}

impl Mutability {
    pub fn label(self) -> &'static str {
        match self {
            Mutability::Read => "读取",
            Mutability::Change => "会修改服务器",
            Mutability::Delete => "会删除数据",
        }
    }
}

/// 知识库的一级分类（UI 分组固定，产品无限扩展）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandCategory {
    /// 系统与环境（uname / free / df / env…）。
    System,
    /// 进程、端口和网络（ps / ss / lsof / curl…）。
    Process,
    /// systemd 与日志。
    Service,
    /// Docker 与 Compose。
    Container,
    /// Nginx 与网关。
    Gateway,
    /// Git 与构建环境。
    Vcs,
    /// 数据库与基础设施状态检查。
    Database,
}

impl CommandCategory {
    pub const ORDERED: [CommandCategory; 7] = [
        CommandCategory::Container,
        CommandCategory::Service,
        CommandCategory::Gateway,
        CommandCategory::Process,
        CommandCategory::System,
        CommandCategory::Vcs,
        CommandCategory::Database,
    ];

    pub fn label(self) -> &'static str {
        match self {
            CommandCategory::System => "系统与环境",
            CommandCategory::Process => "进程与网络",
            CommandCategory::Service => "systemd 与日志",
            CommandCategory::Container => "Docker 与 Compose",
            CommandCategory::Gateway => "Nginx 与网关",
            CommandCategory::Vcs => "Git 与构建环境",
            CommandCategory::Database => "数据库与中间件",
        }
    }
}

/// 一条命令知识（P4.1 数据规范）。
///
/// 生命周期：编译期内置（[`crate::command_center::builtin_catalog`]）→
/// 启动时 seed 进 SQLite + FTS5（`db::command_knowledge`）→ 检索/执行。
#[derive(Debug, Clone)]
pub struct CommandKnowledge {
    /// 稳定 ID：`docker.ps.all` / `systemctl.restart` / `nginx.test`。
    pub id: &'static str,
    /// 主可执行名（`docker` / `systemctl` / `nginx`）。
    pub executable: &'static str,
    /// 子命令与常用参数（`ps -a` / `restart <unit>`），用于展示与检索。
    pub subcommand: &'static str,
    /// 中文标题（`查看所有 Docker 容器`）。
    pub title: &'static str,
    /// 一句话说明。
    pub description: &'static str,
    pub category: CommandCategory,
    /// 使用场景（`部署检查` / `容器排障`），中文检索的主入口。
    pub scenarios: &'static [&'static str],
    /// 别名（`所有容器` / `容器列表`），中文模糊检索。
    pub aliases: &'static [&'static str],
    /// 展示语法（`docker ps -a`）。**不是**实际执行的命令 —— 实际执行命令
    /// 由 safe.rs 的固定模板生成，并在结果里如实回显。
    pub syntax: &'static str,
    pub risk: RiskLevel,
    pub mutability: Mutability,
    /// 输出适配器 ID（`docker-container-table` / `generic-raw-output`…）。
    pub output_adapter: &'static str,
    /// 需要服务器上存在的工具（`docker` / `nginx`）；空 = 系统自带。
    pub requires: &'static [ProbeTool],
    /// 动作类型；`ExecKind::None` = 仅展示（删除类、需上下文的流程等）。
    pub exec: ExecKind,
}

impl CommandKnowledge {
    /// 展示用完整命令行（executable + subcommand）。
    pub fn display_command(&self) -> String {
        if self.subcommand.is_empty() {
            self.executable.to_string()
        } else {
            format!("{} {}", self.executable, self.subcommand)
        }
    }

    /// 是否提供执行。
    pub fn executable_now(&self) -> bool {
        self.exec != ExecKind::None
    }
}

/// 执行一条知识命令所需的结构化参数。
///
/// 前端**只能**通过这里传参；任何字符串都会在 `safe::validate_*` 里过一遍，
/// 拒绝的参数永远不会变成 shell 文本。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CommandParams {
    /// Docker 容器名（logs / inspect）。
    #[serde(default)]
    pub container: Option<String>,
    /// systemd 单元名（status / restart / journal）。
    #[serde(default)]
    pub unit: Option<String>,
    /// 绝对路径（git status 的工作目录）。
    #[serde(default)]
    pub path: Option<String>,
    /// 行数（journal）。
    #[serde(default)]
    pub lines: Option<u32>,
}

/// 知识条目的**动作类型**（编译期，无参数）。
///
/// 静态知识库只声明"这是哪类动作"；真正的 [`KnowledgeExec`]（带容器名 /
/// 单元名等参数）在执行时由 [`build_exec`] 从结构化参数组装 —— 静态表里
/// 不能构造 String，运行时组装也保证参数永远来自前端的结构化字段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecKind {
    /// 仅展示知识，不提供执行。
    None,
    DockerPs,
    DockerImages,
    DockerStats,
    /// 需要 `params.container`。
    DockerLogs,
    /// 需要 `params.container`。
    DockerInspect,
    ListServices,
    /// 需要 `params.unit`。
    SystemdShow,
    /// 需要 `params.unit`。
    ServiceStatus,
    /// 需要 `params.unit`。
    ServiceStart,
    /// 需要 `params.unit`。
    ServiceStop,
    /// 需要 `params.unit`。
    ServiceRestart,
    /// 需要 `params.unit`。
    ServiceReload,
    /// 需要 `params.unit`（指定服务的日志，如 `journalctl -u <unit>`）。
    ///
    /// 与 [`ExecKind::JournalSystem`] 分开：`journalctl -p err`（全系统）不需要
    /// 单元名，两者混在一个变体里会让 `required_params` 返回空数组，前端就
    /// 不知道这条命令还缺服务名。
    JournalUnit,
    /// 全系统日志（`journalctl -p err`）：不需要 `unit`。
    JournalSystem,
    NginxVersion,
    NginxTest,
    NginxEffectiveConfig,
    NginxReload,
    ProcessList,
    DiskFree,
    MemoryInfo,
    UptimeInfo,
    Uname,
    OsRelease,
    /// 版本探测：工具取条目 `requires[0]`（编译期白名单）。
    ToolVersion,
    /// 需要 `params.path`。
    GitStatus,
    ListenSockets,
    /// 需要 `params.container`。
    ContainerStart,
    /// 需要 `params.container`。
    ContainerStop,
    /// 需要 `params.container`。
    ContainerRestart,
}

impl ExecKind {
    /// 该动作需要哪些结构化参数（前端提示用）。
    pub fn required_params(self) -> &'static [&'static str] {
        match self {
            ExecKind::DockerLogs | ExecKind::DockerInspect => &["container"],
            ExecKind::ContainerStart | ExecKind::ContainerStop | ExecKind::ContainerRestart => {
                &["container"]
            }
            ExecKind::SystemdShow
            | ExecKind::ServiceStatus
            | ExecKind::ServiceStart
            | ExecKind::ServiceStop
            | ExecKind::ServiceRestart
            | ExecKind::ServiceReload => &["unit"],
            ExecKind::GitStatus => &["path"],
            ExecKind::JournalUnit => &["unit"],
            // 全系统日志不需要单元名。
            ExecKind::JournalSystem => &[],
            _ => &[],
        }
    }
}

/// 展示语法里的占位符（`journalctl -u <unit>` → `["unit"]`）。
///
/// **终端填充的唯一事实来源**：语法里还有占位符就说明这条命令不能直接写进
/// shell —— 必须先替换成真值（`<unit>` 会被 bash 当成输入重定向）。
/// 与 `required_params`（执行侧）分开：执行走白名单拼命令，填充走这里。
pub fn placeholders_in(syntax: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = syntax;
    while let Some(start) = rest.find('<') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('>') else {
            break;
        };
        let name = after[..end].trim();
        if !name.is_empty() {
            out.push(name.to_string());
        }
        rest = &after[end + 1..];
    }
    out
}

/// 从结构化参数组装执行动作（**唯一**的知识 → Capability 组装点）。
///
/// 缺参数返回 `Err`（不会落到 shell）；参数内容的最终校验在
/// `safe::Capability::command()` 内部（网络 I/O 之前）。
pub fn build_exec(
    kind: ExecKind,
    params: &CommandParams,
    requires: &[ProbeTool],
) -> anyhow::Result<KnowledgeExec> {
    let need = |value: &Option<String>, name: &str| -> anyhow::Result<String> {
        value
            .clone()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("缺少参数 {name}"))
    };
    Ok(match kind {
        ExecKind::None => anyhow::bail!("该命令当前不提供执行（见知识库说明）"),
        ExecKind::DockerPs => KnowledgeExec::DockerPs,
        ExecKind::DockerImages => KnowledgeExec::DockerImages,
        ExecKind::DockerStats => KnowledgeExec::DockerStats,
        ExecKind::DockerLogs => KnowledgeExec::DockerLogs {
            container: need(&params.container, "container")?,
        },
        ExecKind::DockerInspect => KnowledgeExec::DockerInspect {
            container: need(&params.container, "container")?,
        },
        ExecKind::ListServices => KnowledgeExec::ListServices,
        ExecKind::SystemdShow => KnowledgeExec::SystemdShow {
            unit: need(&params.unit, "unit")?,
        },
        ExecKind::ServiceStatus => KnowledgeExec::ServiceStatus {
            unit: need(&params.unit, "unit")?,
        },
        ExecKind::ServiceStart => KnowledgeExec::ServiceStart {
            unit: need(&params.unit, "unit")?,
        },
        ExecKind::ServiceStop => KnowledgeExec::ServiceStop {
            unit: need(&params.unit, "unit")?,
        },
        ExecKind::ServiceRestart => KnowledgeExec::ServiceRestart {
            unit: need(&params.unit, "unit")?,
        },
        ExecKind::ServiceReload => KnowledgeExec::ServiceReload {
            unit: need(&params.unit, "unit")?,
        },
        ExecKind::JournalUnit => KnowledgeExec::Journal {
            unit: Some(need(&params.unit, "unit")?),
            lines: params.lines.unwrap_or(200).clamp(1, 2000),
        },
        ExecKind::JournalSystem => KnowledgeExec::Journal {
            unit: None,
            lines: params.lines.unwrap_or(200).clamp(1, 2000),
        },
        ExecKind::NginxVersion => KnowledgeExec::NginxVersion,
        ExecKind::NginxTest => KnowledgeExec::NginxTest,
        ExecKind::NginxEffectiveConfig => KnowledgeExec::NginxEffectiveConfig,
        ExecKind::NginxReload => KnowledgeExec::NginxReload,
        ExecKind::ProcessList => KnowledgeExec::ProcessList,
        ExecKind::DiskFree => KnowledgeExec::DiskFree,
        ExecKind::MemoryInfo => KnowledgeExec::MemoryInfo,
        ExecKind::UptimeInfo => KnowledgeExec::UptimeInfo,
        ExecKind::Uname => KnowledgeExec::Uname,
        ExecKind::OsRelease => KnowledgeExec::OsRelease,
        ExecKind::ToolVersion => KnowledgeExec::ToolVersion {
            tool: *requires
                .first()
                .ok_or_else(|| anyhow::anyhow!("缺少版本探测工具"))?,
        },
        ExecKind::GitStatus => KnowledgeExec::GitStatus {
            path: need(&params.path, "path")?,
        },
        ExecKind::ListenSockets => KnowledgeExec::ListenSockets,
        ExecKind::ContainerStart => KnowledgeExec::ContainerStart {
            container: need(&params.container, "container")?,
        },
        ExecKind::ContainerStop => KnowledgeExec::ContainerStop {
            container: need(&params.container, "container")?,
        },
        ExecKind::ContainerRestart => KnowledgeExec::ContainerRestart {
            container: need(&params.container, "container")?,
        },
    })
}

/// 知识库 → 安全白名单的执行映射。
///
/// **唯一**翻译点：每种变体对应一个固定的 [`Capability`] 构造；新增可执行
/// 命令 = 加变体 + 在 `capability()` 里接既有 Capability（必要时先在 safe.rs
/// 加白名单变体）。绝不在别处 `format!` 命令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KnowledgeExec {
    DockerPs,
    DockerImages,
    DockerStats,
    DockerLogs { container: String },
    DockerInspect { container: String },
    ComposePs,
    ListServices,
    SystemdShow { unit: String },
    ServiceStatus { unit: String },
    ServiceRestart { unit: String },
    ServiceReload { unit: String },
    ServiceStart { unit: String },
    ServiceStop { unit: String },
    Journal { unit: Option<String>, lines: u32 },
    NginxVersion,
    NginxTest,
    NginxEffectiveConfig,
    NginxReload,
    ProcessList,
    DiskFree,
    MemoryInfo,
    UptimeInfo,
    Uname,
    OsRelease,
    ToolVersion { tool: ProbeTool },
    GitStatus { path: String },
    ListenSockets,
    ContainerStart { container: String },
    ContainerStop { container: String },
    ContainerRestart { container: String },
}

impl KnowledgeExec {
    /// 翻译成安全白名单动作。参数校验发生在 `Capability::command()` 内部
    /// （网络 I/O 之前），这里只做结构映射。
    pub fn capability(&self) -> Capability {
        match self {
            KnowledgeExec::DockerPs => Capability::DockerPs,
            KnowledgeExec::DockerImages => Capability::DockerImages,
            KnowledgeExec::DockerStats => Capability::DockerStats,
            KnowledgeExec::DockerLogs { container } => Capability::DockerLogs {
                container: container.clone(),
                lines: 200,
            },
            KnowledgeExec::DockerInspect { container } => Capability::DockerInspect {
                container: container.clone(),
            },
            KnowledgeExec::ComposePs => Capability::DockerPs, // 第一批复用容器表（P4.5 再分化）
            KnowledgeExec::ListServices => Capability::ListServices,
            KnowledgeExec::SystemdShow { unit } => Capability::SystemdShowUnits {
                units: vec![unit.clone()],
            },
            KnowledgeExec::ServiceStatus { unit } => {
                Capability::ServiceStatus { unit: unit.clone() }
            }
            KnowledgeExec::ServiceRestart { unit } => Capability::ServiceAction {
                action: ServiceAction::Restart,
                unit: unit.clone(),
            },
            KnowledgeExec::ServiceReload { unit } => Capability::ServiceAction {
                action: ServiceAction::Reload,
                unit: unit.clone(),
            },
            KnowledgeExec::ServiceStart { unit } => Capability::ServiceAction {
                action: ServiceAction::Start,
                unit: unit.clone(),
            },
            KnowledgeExec::ServiceStop { unit } => Capability::ServiceAction {
                action: ServiceAction::Stop,
                unit: unit.clone(),
            },
            KnowledgeExec::Journal { unit, lines } => Capability::Journal {
                unit: unit.clone(),
                lines: *lines,
                priority: None,
            },
            KnowledgeExec::NginxVersion => Capability::NginxVersion,
            KnowledgeExec::NginxTest => Capability::NginxTest,
            KnowledgeExec::NginxEffectiveConfig => Capability::NginxEffectiveConfig,
            KnowledgeExec::NginxReload => Capability::NginxReload,
            KnowledgeExec::ProcessList => Capability::ProcessList,
            KnowledgeExec::DiskFree => Capability::DiskFree,
            KnowledgeExec::MemoryInfo => Capability::MemoryInfo,
            KnowledgeExec::UptimeInfo => Capability::UptimeInfo,
            KnowledgeExec::Uname => Capability::Uname,
            KnowledgeExec::OsRelease => Capability::OsRelease,
            KnowledgeExec::ToolVersion { tool } => Capability::ToolVersion(*tool),
            KnowledgeExec::GitStatus { path } => Capability::GitStatus { path: path.clone() },
            KnowledgeExec::ListenSockets => Capability::ListenSockets,
            KnowledgeExec::ContainerStart { container } => Capability::ContainerAction {
                action: ContainerAction::Start,
                container: container.clone(),
            },
            KnowledgeExec::ContainerStop { container } => Capability::ContainerAction {
                action: ContainerAction::Stop,
                container: container.clone(),
            },
            KnowledgeExec::ContainerRestart { container } => Capability::ContainerAction {
                action: ContainerAction::Restart,
                container: container.clone(),
            },
        }
    }
}

/// 检索命中（返回给提示面板的一行）。
#[derive(Debug, Clone, Serialize)]
pub struct CommandSearchHit {
    pub id: String,
    pub executable: String,
    pub subcommand: String,
    pub title: String,
    pub description: String,
    pub category: CommandCategory,
    pub syntax: String,
    pub risk: RiskLevel,
    pub mutability: Mutability,
    /// 输出适配器（前端决定渲染哪种结构化面板）。
    pub output_adapter: String,
    /// 需要的工具名（`docker`…）；空 = 系统自带。
    pub requires: Vec<String>,
    /// 执行前必须由用户提供的参数名（`container` / `unit` / `path`）。
    pub required_params: Vec<String>,
    /// 展示语法里未替换的占位符（`journalctl -u <unit>` → `["unit"]`）。
    /// **非空 = 禁止直接写进 shell**，必须先替换成真值。
    pub placeholders: Vec<String>,
    /// 是否可直接执行。
    pub can_execute: bool,
    /// 是否已收藏。
    pub favorite: bool,
    /// 综合得分（调试与排序稳定性用）。
    pub score: f64,
}
