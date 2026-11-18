import type { ReasoningEffort } from "@/api/types/agent";

/**
 * 输入框底栏的**模型选择**与它的两项设置（上下文长度 / 思考强度）。
 *
 * 能力由后端给出（`AiProviderView.context_window` / `reasoning_efforts`），
 * 这里只做展示与参数映射：
 * * 未知窗口 → 只有「自动」，绝不给 300K / 600K / 1M 的假档位；
 * * 「MAX」= 该模型支持的最高档：最高只到 `high` 就发 `high`。
 */

/** 一条可选的模型（来自已启用的提供方配置）。 */
export interface ProviderChoice {
  id: string;
  /** 配置名：菜单里的分组标题。 */
  name: string;
  model: string;
  isDefault: boolean;
  updatedAt: number;
  /** 上下文窗口（tokens）；`0` = 未知。 */
  contextWindow: number;
  /** 后端声明的输入预算档位（升序）；空 = 只有「自动」。 */
  budgets: number[];
  efforts: ReasoningEffort[];
}

/** 与后端的默认规则一致：优先明确默认，其次最近更新。 */
export function effectiveProvider(providers: ProviderChoice[], providerId: string | null) {
  if (providerId !== null) return providers.find((provider) => provider.id === providerId);
  return providers.reduce<ProviderChoice | undefined>((current, provider) => {
    if (!current || (provider.isDefault && !current.isDefault)) return provider;
    if (provider.isDefault === current.isDefault && provider.updatedAt > current.updatedAt) return provider;
    return current;
  }, undefined);
}

/** `auto` = 不传 `reasoning_effort`，沿用供应商默认值。 */
export type EffortChoice = ReasoningEffort | "auto";

/** 档位按"从低到高"排序；供应商返回的顺序不作数。 */
export const EFFORT_ORDER: readonly ReasoningEffort[] = ["low", "medium", "high", "max"];

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  max: "MAX",
};

export interface EffortTier {
  value: ReasoningEffort;
  label: string;
  /** 该模型支持的最高档（界面统一叫 MAX）。 */
  top: boolean;
}

/** 后端给的是 `string[]`，收成受支持的档位（未知值直接丢掉）。 */
export function normalizeEfforts(values: readonly string[] | undefined): ReasoningEffort[] {
  const raw = values ?? [];
  return EFFORT_ORDER.filter((effort) => raw.includes(effort));
}

/** 只列出**模型实际支持**的档位，最高档显示为 MAX。 */
export function effortTiers(efforts: readonly string[]): EffortTier[] {
  const supported = EFFORT_ORDER.filter((effort) => efforts.includes(effort));
  return supported.map((value, index) => {
    const top = index === supported.length - 1;
    return { value, label: top ? "MAX" : EFFORT_LABEL[value], top };
  });
}

export function effortLabel(choice: EffortChoice, efforts: readonly string[]): string {
  if (choice === "auto") return "默认";
  return effortTiers(efforts).find((tier) => tier.value === choice)?.label ?? "默认";
}

/**
 * 真正发出去的参数。
 *
 * 前端已把 MAX 收敛到模型最高档；这里再校验一次，模型不支持的档位不发。
 */
export function effortParam(
  choice: EffortChoice,
  efforts: readonly string[],
): ReasoningEffort | null {
  if (choice === "auto") return null;
  return efforts.includes(choice) ? choice : null;
}

const MIN_BUDGET = 16 * 1024;

/**
 * 菜单里能选的上下文预算（tokens）。
 *
 * 只用后端声明的档位（DeepSeek 是 300K / 600K / 1M），不自己按比例推算：
 * 界面写多少，请求就带多少。空数组 = 只显示「自动（由模型决定）」。
 */
export function contextOptions(budgets: readonly number[]): number[] {
  return budgets.filter((value) => Number.isFinite(value) && value >= MIN_BUDGET);
}

export function formatTokens(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))}M`;
  return `${Math.round(value / 1024)}K`;
}

/** 底栏模型按钮上的上下文文案（第二行只在编辑里出现，这里给菜单用）。 */
export function contextLabel(budget: number | null): string {
  return budget ? formatTokens(budget) : "自动";
}

/** 设置按**模型**记住（换会话不换模型就沿用上次选择）。 */
export function modelKey(providerId: string | null, model: string): string {
  return providerId ? `p:${providerId}` : `m:${model}`;
}

/** 按供应商（配置名）分组；空组不会出现。 */
export function groupProviders(
  providers: ProviderChoice[],
): { name: string; items: ProviderChoice[] }[] {
  const groups = new Map<string, ProviderChoice[]>();
  for (const provider of providers) {
    const list = groups.get(provider.name) ?? [];
    list.push(provider);
    groups.set(provider.name, list);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}
