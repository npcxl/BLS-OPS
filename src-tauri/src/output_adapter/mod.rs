//! 统一输出适配引擎 —— 把任意命令的原始输出归一成有限的通用 UI 模型。
//!
//! # 为什么
//!
//! 之前是后端 `match adapter` + 前端 `if (adapter === ...)` 双份堆砌，
//! 每加一条命令就要动两处、写一套专用组件。命令一多必然失控。
//!
//! # 架构
//!
//! ```text
//! stdout ──► registry（按 adapter id 查表）
//!              ├─ 第一层 机器可读：generic::json
//!              ├─ 第二层 通用文本：generic::{table,key_value,log,tree,metrics}
//!              └─ 第三层 专用语义：domain::{docker,systemd,nginx,linux}
//!            ──► StructuredCommandResult（统一协议）
//!              ──► 前端 CommandResultRenderer 按 view 分发（只认 9 种视图）
//! ```
//!
//! # 铁律
//!
//! - 统一的是**输出协议、解析框架、UI 容器**，不是写一个万能解析器硬猜；
//! - 任何时候都保留原始输出（[`model::StructuredCommandResult::raw`]）；
//! - 解析失败自动回落 raw，命令绝不因"没有专用 UI"而不可用，且回落原因可见。

pub mod auto;
pub mod domain;
pub mod generic;
pub mod model;
pub mod registry;
#[cfg(test)]
mod tests;

pub use auto::{adapt_auto, has_shell_operator};
pub use model::{
    ColumnDefinition, ColumnThresholds, CommandMeta, RawOutput, ResultSection,
    StructuredCommandResult, SummaryItem, ViewType,
};
pub use registry::{AdapterContext, AdapterOutcome, AdapterRegistry};

/// 知识库未给专用适配器时的默认 adapter id。
pub const AUTO_ADAPTER: &str = "auto";

/// 全局注册表（进程内只建一次）。
static REGISTRY: std::sync::OnceLock<AdapterRegistry> = std::sync::OnceLock::new();

pub fn registry() -> &'static AdapterRegistry {
    REGISTRY.get_or_init(AdapterRegistry::builtins)
}

/// 便捷入口：按 adapter id 把 stdout 适配成统一协议。
pub fn adapt(
    adapter_id: &str,
    stdout: &str,
    title: impl Into<String>,
    meta: CommandMeta,
    raw: RawOutput,
) -> StructuredCommandResult {
    let ctx = AdapterContext {
        title: title.into(),
        meta,
        raw,
    };
    registry().adapt(adapter_id, stdout, &ctx)
}
