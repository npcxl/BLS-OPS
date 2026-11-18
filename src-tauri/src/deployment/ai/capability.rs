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
/// OpenAI 推理模型（o1 / o3 / o4 / gpt-5）：低 / 中 / 高。
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
    // `o1` / `o3` / `o4-mini` / `gpt-5*`：支持 reasoning_effort 的推理模型。
    if name.starts_with("o1")
        || name.starts_with("o3")
        || name.starts_with("o4")
        || name.starts_with("gpt-5")
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

/// 把界面选择解析成**真正发出去的**参数。
///
/// * `None` / 空串 / `auto`：不传（沿用供应商默认档）；
/// * `max` 而模型最高只到 `high`：发 `high`；
/// * 模型不支持的档位：不传（后端不替用户"猜一个）。
pub fn resolve_effort(model: &str, requested: Option<&str>) -> Option<String> {
    let requested = requested?.trim().to_ascii_lowercase();
    if requested.is_empty() || requested == "auto" {
        return None;
    }
    let capability = model_capability(model);
    if capability.supports(&requested) {
        return Some(requested);
    }
    if requested == "max" {
        return capability.highest().map(str::to_string);
    }
    None
}

/// 「自动」档的输入预算：窗口留出 20% 给回复与后续工具调用。
pub fn auto_input_tokens(model: &str) -> usize {
    let window = model_capability(model).context_window as usize;
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
/// 用户选的档位按**供应商声明的预算**原样生效（DeepSeek 的 1M 就是 1M）；
/// 不在档位表里的值（旧前端、手写请求）仍收敛到「自动」以内，避免把请求
/// 发到窗口外换回一个 400。
pub fn context_budget_tokens(model: &str, requested: Option<u32>) -> usize {
    let capability = model_capability(model);
    let auto = auto_input_tokens(model);
    match requested {
        Some(value) if capability.budgets.contains(&value) => value as usize,
        Some(value) if value >= MIN_INPUT_TOKENS => (value as usize).min(auto),
        _ => auto,
    }
}

/// 界面可选的上下文预算档位（空 = 只有「自动」）。
pub fn context_budget_options(model: &str) -> Vec<u32> {
    model_capability(model).budgets.to_vec()
}
