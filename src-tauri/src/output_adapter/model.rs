//! 统一输出协议（P4 输出适配引擎的**契约层**）。
//!
//! # 设计原则
//!
//! 所有命令结果先归一成**有限几种通用 UI 数据模型**，前端只按 `view` 分发渲染，
//! 不需要知道这是 Docker 还是 Nginx。这样新增几百条命令也不会让
//! `match adapter` 与前端组件失控。
//!
//! 铁律：
//! - **任何时候都保留原始输出**（[`StructuredCommandResult::raw`]）；
//! - 解析失败**自动回落 raw**，绝不能导致命令不可用；
//! - 不伪造数据：认不出的列就是字符串，不做"看起来像数字"的猜测。
//!
//! # 各 view 的 rows 契约
//!
//! | view       | rows 结构                                        |
//! | ---------- | ------------------------------------------------ |
//! | table      | 每行的 key 对应 [`ColumnDefinition::key`]         |
//! | key_value  | `{"key": "...", "value": "...", "tone"?: "..."}` |
//! | metrics    | `{"label": "...", "value": "...", "unit"?, "tone"?}` |
//! | log        | `{"timestamp"?, "level"?, "unit"?, "message"}`    |
//! | tree       | `{"label", "depth", "detail"?}`（扁平 + 缩进层级） |
//! | json       | rows 为空，结构化数据放 `json` 字段               |
//! | diff/progress | 保留协议位，当前无适配器产出，前端按 raw 渲染   |
//! | raw        | rows 为空，前端直接渲染 `raw.stdout`              |

use serde::{Deserialize, Serialize};

/// 通用 UI 视图类型（有限集合 —— 新增命令不新增视图）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewType {
    /// 表格：ps / df / ss / lsblk / docker ps / systemctl list-units…
    Table,
    /// 属性面板：docker info / systemctl show / sysctl / ulimit…
    KeyValue,
    /// 指标卡：free / uptime / vmstat / iostat…
    Metrics,
    /// 日志流：journalctl / tail / dmesg / docker logs / nginx 日志…
    Log,
    /// 树结构：tree / pstree / nginx 配置 / 进程父子关系…
    Tree,
    /// JSON 查看器：docker inspect / kubectl -o json / API 返回…
    Json,
    /// 差异视图：git diff / 配置修改前后（协议保留）。
    Diff,
    /// 任务进度：下载 / 构建 / 部署 / 镜像拉取（协议保留）。
    Progress,
    /// 纯文本：短且无结构的输出（自动识别的"就这样显示"一等公民）。
    ///
    /// 与 [`ViewType::Raw`] 的区别：raw = **没有识别出来**（含交互式程序与
    /// 解析失败）；text = **识别出来就是一段纯文本**（如 `hostname`、
    /// `whoami`、`cat VERSION`）。渲染一致，但语义不同 —— UI 不该对 text
    /// 显示"无法解析"之类的提示。
    Text,
    /// 原始终端：无法识别、交互式命令、解析失败。
    Raw,
}

impl ViewType {
    /// 该视图是否需要列定义（只有表格需要）。
    pub fn needs_columns(self) -> bool {
        matches!(self, ViewType::Table)
    }
}

/// 表格列定义。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDefinition {
    /// 行数据里的字段名。
    pub key: String,
    /// 表头文案。
    pub label: String,
    /// 数值列：等宽数字 + 右对齐。
    #[serde(default)]
    pub numeric: bool,
    /// 数值阈值着色（`>= warn` 黄、`>= danger` 红）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thresholds: Option<ColumnThresholds>,
}

/// 数值列的阈值着色规则（只有 `numeric` 列有意义）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnThresholds {
    /// 达到该值显示警告色。
    pub warn: f64,
    /// 达到该值显示危险色。
    pub danger: f64,
}

/// 头部摘要（"共 12 个容器 · 3 运行中"）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryItem {
    pub label: String,
    pub value: String,
    /// 语义色：`success` / `warning` / `danger` / `accent`；空 = 默认。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
}

/// 一个分区（`docker info` 这类输出天然分块时用它）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultSection {
    pub title: String,
    pub view: ViewType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<ColumnDefinition>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<serde_json::Value>,
}

/// 执行元信息（与原始输出一起永久留档）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandMeta {
    /// 实际执行的命令（与展示语法可能不同 —— 必须如实展示）。
    pub command: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    /// 输出是否被截断。
    pub truncated: bool,
}

/// 原始终端输出（**永久保留**，结构化只是第二种视图）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawOutput {
    pub stdout: String,
    pub stderr: String,
}

/// 统一的命令结果协议 —— 前端只需要这一个类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredCommandResult {
    pub view: ViewType,
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub summary: Vec<SummaryItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<ColumnDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<ResultSection>,
    /// 解析期的提示（如"部分行无法解析"），不是错误。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    pub meta: CommandMeta,
    pub raw: RawOutput,
    /// `view = json` 时的结构化数据（docker inspect / kubectl -o json）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<serde_json::Value>,
}

impl StructuredCommandResult {
    /// 回落视图：保留原始输出与元信息，不丢任何数据。
    ///
    /// **解析失败时永远走这里** —— 命令不会因为"没有专用 UI"而不可用。
    pub fn raw_fallback(title: impl Into<String>, meta: CommandMeta, raw: RawOutput) -> Self {
        Self {
            view: ViewType::Raw,
            title: title.into(),
            summary: Vec::new(),
            columns: Vec::new(),
            rows: Vec::new(),
            sections: Vec::new(),
            warnings: Vec::new(),
            meta,
            raw,
            json: None,
        }
    }

    /** 空结果也是有效结果（"没有容器/服务"是事实，不是错误）。 */
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty() && self.sections.is_empty() && self.json.is_none()
    }
}
