//! 模型能力：思考强度档位与上下文窗口。
//!
//! # 只写确定知道的
//!
//! 这张表是模型能力的**唯一**来源：前端经 [`super::model::AiProviderView`] 读它，
//! 后端发请求与裁剪上下文也读它。于是不会出现"界面给了 300K、请求里发不出去"。
//!
//! 表里没有的模型一律返回「不支持思考强度、窗口未知」：界面只显示「默认」与
//! 「自动」，请求里不带 `reasoning_effort`，上下文按保守预算裁剪 —— 绝不为了
//! 填满菜单编造档位。
//!
//! 内置表认不出用户的模型时，由设置页的**能力声明**（[`CapabilityOverride`]）
//! 补齐，逐字段覆盖内置值；界面据 [`Capability::known`] 提示"该模型能力未登记"。

use serde::{Deserialize, Serialize};

/// 模型能力（纯数据，可单测）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelCapability {
    /// 上下文窗口（tokens）；`0` = 未知。
    pub context_window: u32,
    /// 供应商声明的**输入预算档位**（升序）。空 = 界面只给「自动」。
    pub budgets: &'static [u32],
    /// 支持的思考强度档位（升序）。空 = 不支持该参数。
    pub efforts: &'static [&'static str],
}

impl ModelCapability {
    pub fn supports(&self, effort: &str) -> bool {
        self.efforts.iter().any(|item| *item == effort)
    }

    /// 最高档。界面上的「MAX」就是它：模型最高只到 `high` 时，MAX 发 `high`。
    pub fn highest(&self) -> Option<&'static str> {
        self.efforts.last().copied()
    }
}

/// DeepSeek Chat Completions：`reasoning_effort` = 低 / 高 / 最大。
const DEEPSEEK_EFFORTS: &[&str] = &["low", "high", "max"];
/// OpenAI 推理模型（o1 / o3 / o4 / gpt-5 / gpt-6）：低 / 中 / 高。
const OPENAI_EFFORTS: &[&str] = &["low", "medium", "high"];

/// DeepSeek 全系（chat / reasoner / v3.x / v4）的上下文窗口。
pub const DEEPSEEK_CONTEXT_WINDOW: u32 = 1024 * 1024;

/// DeepSeek 可选的**输入预算**：300K / 600K / 1M。
///
/// 1M 就是满窗口：界面选了它就按 1M 带历史与材料，不再按「自动」的
/// 八折预算压回去 —— 否则菜单写着 1M、请求里只有 816K。
pub const DEEPSEEK_CONTEXT_BUDGETS: &[u32] = &[300 * 1024, 600 * 1024, 1024 * 1024];

/// 未知模型的保守输入预算：一次请求最多带 32K tokens。
pub const FALLBACK_INPUT_TOKENS: usize = 32 * 1024;

/// 任何预算都不低于 16K：再小就连工具说明和一轮结果都装不下。
pub const MIN_INPUT_TOKENS: u32 = 16 * 1024;

/// 按模型名识别能力。
///
/// 匹配规则刻意宽松（`contains("deepseek")`）：供应商常把版本号拼进模型名
/// （`deepseek-chat`、`deepseek-v3.2`、`deepseek-reasoner`），这些都走同一套
/// 参数；相反，认不出来的名字**绝不猜**。
pub fn model_capability(model: &str) -> ModelCapability {
    let name = model.trim().to_ascii_lowercase();
    if name.is_empty() {
        return unknown();
    }
    if name.contains("deepseek") {
        return ModelCapability {
            context_window: DEEPSEEK_CONTEXT_WINDOW,
            budgets: DEEPSEEK_CONTEXT_BUDGETS,
            efforts: DEEPSEEK_EFFORTS,
        };
    }
    // `o1` / `o3` / `o4-mini` / `gpt-5*` / `gpt-6*`：支持 reasoning_effort 的推理模型。
    if name.starts_with("o1")
        || name.starts_with("o3")
        || name.starts_with("o4")
        || name.starts_with("gpt-5")
        || name.starts_with("gpt-6")
    {
        return ModelCapability {
            context_window: 0,
            budgets: &[],
            efforts: OPENAI_EFFORTS,
        };
    }
    unknown()
}

fn unknown() -> ModelCapability {
    ModelCapability {
        context_window: 0,
        budgets: &[],
        efforts: &[],
    }
}

// ---------------------------------------------------------------------------
// 用户声明的能力覆盖
// ---------------------------------------------------------------------------

/// 用户在提供方设置里为某个模型**手工声明**的能力（`None` = 沿用内置表）。
///
/// # 为什么需要这一层
///
/// 内置表只认识 DeepSeek 与 OpenAI 推理模型。用户接的别家模型（MiMo、通义、
/// 自建网关的别名）落到 [`unknown`]，于是界面只剩「默认」、预算被压到 32K，
/// 而用户看不出是哪一步失效。把能力做成一等配置项，换模型不用改代码。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CapabilityOverride {
    pub context_window: Option<u32>,
    pub budgets: Option<Vec<u32>>,
    pub efforts: Option<Vec<String>>,
}

impl CapabilityOverride {
    /// 三个字段都空 —— 等于没声明，调用方可直接跳过解析。
    pub fn is_empty(&self) -> bool {
        self.context_window.is_none() && self.budgets.is_none() && self.efforts.is_none()
    }
}

/// 解析后的能力（owned：可能来自内置表，也可能来自用户声明）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Capability {
    /// 上下文窗口（tokens）；`0` = 未知。
    pub context_window: u32,
    /// 输入预算档位（升序）；空 = 只有「自动」。
    pub budgets: Vec<u32>,
    /// 思考强度档位（升序）；空 = 不支持该参数。
    pub efforts: Vec<String>,
    /// 是否**有任何依据**（内置表或用户声明）。false = 界面必须提示「未登记」。
    pub known: bool,
    /// 是否部分/全部来自用户声明。
    pub overridden: bool,
}

impl Capability {
    pub fn supports(&self, effort: &str) -> bool {
        self.efforts.iter().any(|item| item == effort)
    }

    /// 最高档。界面上的「MAX」就是它。
    pub fn highest(&self) -> Option<&str> {
        self.efforts.last().map(String::as_str)
    }

    /// 把界面选择解析成**真正发出去的**参数。
    ///
    /// * `None` / 空串 / `auto`：不传（沿用供应商默认档）；
    /// * `max` 而模型最高只到 `high`：发 `high`；
    /// * 模型不支持的档位：不传（后端不替用户"猜一个）。
    pub fn resolve_effort(&self, requested: Option<&str>) -> Option<String> {
        let requested = requested?.trim().to_ascii_lowercase();
        if requested.is_empty() || requested == "auto" {
            return None;
        }
        if self.supports(&requested) {
            return Some(requested);
        }
        if requested == "max" {
            return self.highest().map(str::to_string);
        }
        None
    }

    /// 「自动」档的输入预算：窗口留出 20% 给回复与后续工具调用。
    pub fn auto_input_tokens(&self) -> usize {
        let window = self.context_window as usize;
        if window == 0 {
            return FALLBACK_INPUT_TOKENS;
        }
        let reserve = (window / 5).max(4 * 1024);
        window
            .saturating_sub(reserve)
            .max(MIN_INPUT_TOKENS as usize)
    }

    /// 本次请求可用的输入预算（tokens）。
    ///
    /// * 命中声明的档位 → 原样生效（DeepSeek 的 1M 就是 1M）；
    /// * 不在档位表里但 >= 16K → 收敛到**窗口**以内（窗口未知时退回 auto）。
    ///   以前这里收敛到 `auto`（约 80% 窗口），于是"选了 300K、实际只有 245K"
    ///   这种静默缩水连日志都看不出来。
    pub fn input_budget(&self, requested: Option<u32>) -> usize {
        let auto = self.auto_input_tokens();
        match requested {
            Some(value) if self.budgets.contains(&value) => value as usize,
            Some(value) if value >= MIN_INPUT_TOKENS => {
                let ceiling = if self.context_window > 0 {
                    self.context_window as usize
                } else {
                    auto
                };
                (value as usize).min(ceiling)
            }
            _ => auto,
        }
    }
}

/// 把「内置表 + 用户声明」合成一份可用能力。
///
/// 覆盖是**逐字段**的：用户只填了窗口，预算与档位仍用内置表。
pub fn resolve_capability(model: &str, overrides: Option<&CapabilityOverride>) -> Capability {
    let builtin = model_capability(model);
    let overrides = overrides.filter(|item| !item.is_empty());
    let overridden = overrides.is_some();
    let context_window = overrides
        .and_then(|item| item.context_window)
        .unwrap_or(builtin.context_window);
    let mut budgets = overrides
        .and_then(|item| item.budgets.clone())
        .unwrap_or_else(|| builtin.budgets.to_vec());
    // 用户声明可能从旧版本 / 手写配置带进重复值：菜单不接受同一档位出现两次。
    budgets.sort_unstable();
    budgets.dedup();
    let efforts = overrides
        .and_then(|item| item.efforts.clone())
        .unwrap_or_else(|| {
            builtin
                .efforts
                .iter()
                .map(|item| (*item).to_string())
                .collect()
        });
    let known = context_window > 0 || !budgets.is_empty() || !efforts.is_empty();
    Capability {
        context_window,
        budgets,
        efforts,
        known,
        overridden,
    }
}

/// 把界面选择解析成**真正发出去的**参数（只看内置表）。
pub fn resolve_effort(model: &str, requested: Option<&str>) -> Option<String> {
    resolve_capability(model, None).resolve_effort(requested)
}

/// 带用户声明的档位解析。
pub fn resolve_effort_with(
    model: &str,
    overrides: Option<&CapabilityOverride>,
    requested: Option<&str>,
) -> Option<String> {
    resolve_capability(model, overrides).resolve_effort(requested)
}

/// 「自动」档的输入预算（只看内置表）。
pub fn auto_input_tokens(model: &str) -> usize {
    resolve_capability(model, None).auto_input_tokens()
}

/// 本次请求可用的输入预算（只看内置表）。
pub fn context_budget_tokens(model: &str, requested: Option<u32>) -> usize {
    resolve_capability(model, None).input_budget(requested)
}

/// 带用户声明的预算解析。
pub fn context_budget_tokens_with(
    model: &str,
    overrides: Option<&CapabilityOverride>,
    requested: Option<u32>,
) -> usize {
    resolve_capability(model, overrides).input_budget(requested)
}

/// 界面可选的上下文预算档位（空 = 只有「自动」）。
pub fn context_budget_options(model: &str, overrides: Option<&CapabilityOverride>) -> Vec<u32> {
    resolve_capability(model, overrides).budgets
}
