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
  /**
   * 能力是否有依据（内置表命中或用户声明）。
   *
   * false = 这个模型名后端没登记过：思考强度与上下文菜单只剩「默认 / 自动」，
   * 界面要说明原因并指到设置页，不能让它看起来像功能坏了。
   */
  capabilityKnown: boolean;
}

/** 与后端的默认规则一致：优先明确默认，其次最近更新。 */
export function effectiveProvider(providers: ProviderChoice[], providerId: string | null) {
  // 选中的模型被停用 / 删除：回退到有效默认，别让下一条请求没有模型。
  if (providerId !== null) {
    const explicit = providers.find((provider) => provider.id === providerId);
    if (explicit) return explicit;
  }
  return providers.reduce<ProviderChoice | undefined>((current, provider) => {
    if (!current || (provider.isDefault && !current.isDefault)) return provider;
    if (provider.isDefault === current.isDefault && provider.updatedAt > current.updatedAt) return provider;
    return current;
  }, undefined);
}

/** `auto` = 不传 `reasoning_effort`，沿用供应商默认值。 */
export type EffortChoice = ReasoningEffort | "auto";

/**
 * 点击发送那一刻锁定的模型设置。
 *
 * 之后等终端输出 / 附件、切对话、改菜单都不再影响这份快照；续跑同一个
 * `taskId` 也从任务自己的快照里取。
 */
export interface ModelSelection {
  providerId: string | null;
  /** 供应商配置里的模型名（只用于按模型记忆的设置键）。 */
  model: string;
  effort: EffortChoice;
  contextBudget: number | null;
}

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

/**
 * 只列出**模型实际支持**的档位；最高档统一叫 MAX。
 *
 * 供应商的最高档可能叫 `high`，但对用户来说它仍然是"最高"：选它就应该
 * 走 MAX 的强制计划。请求里发 `max`，由后端按模型能力解析成实际档位；
 * `planRequired` 也按**这个选择**判定，而不是按解析后的参数。
 */
export function effortTiers(efforts: readonly string[]): EffortTier[] {
  const supported = EFFORT_ORDER.filter((effort) => efforts.includes(effort));
  return supported.map((value, index) => {
    const top = index === supported.length - 1;
    return top
      ? { value: "max" as ReasoningEffort, label: "MAX", top: true }
      : { value, label: EFFORT_LABEL[value], top: false };
  });
}

/**
 * 把保存的档位收成当前模型菜单里的值。
 *
 * 旧记录可能存的是 `high`（当时最高档还不叫 MAX）：换到只到 high 的模型时
 * 应当显示 MAX，而不是掉回「默认」——用户选的是"最高"，不是某个枚举值。
 */
export function normalizeEffortChoice(
  choice: EffortChoice,
  efforts: readonly string[],
): EffortChoice {
  if (choice === "auto") return "auto";
  if (efforts.length === 0) return "auto";
  const tiers = effortTiers(efforts);
  if (tiers.some((tier) => tier.value === choice)) return choice;
  if (choice === "max") return "max";
  if (choice === highestEffort(efforts)) return "max";
  return "auto";
}

/** 用户选的是不是 MAX（= 本轮要强制计划；与供应商实际档位无关）。 */
export function planRequiredFor(choice: EffortChoice): boolean {
  return choice === "max";
}

export function effortLabel(choice: EffortChoice, efforts: readonly string[]): string {
  if (choice === "auto") return "默认";
  return effortTiers(efforts).find((tier) => tier.value === choice)?.label ?? "默认";
}

/** 该模型实际支持的最高档；一档都没有时为空。 */
export function highestEffort(efforts: readonly string[]): ReasoningEffort | null {
  const supported = EFFORT_ORDER.filter((effort) => efforts.includes(effort));
  return supported[supported.length - 1] ?? null;
}

/**
 * 真正发出去的参数。
 *
 * MAX 原样发 `max`，由**后端**按模型能力解析（模型最高只到 high 就发 high）。
 * 前端不替用户收敛：`planRequired` 要按用户的选择判定，参数解析是另一件事。
 */
export function effortParam(
  choice: EffortChoice,
  efforts: readonly string[],
): ReasoningEffort | null {
  if (choice === "auto") return null;
  if (choice === "max") return "max";
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
  const valid = budgets
    .filter((value) => Number.isFinite(value) && value >= MIN_BUDGET)
    .sort((a, b) => a - b);
  /*
   * 按**显示档位**去重：比如 1048576 和 1200000 都会显示成 1M，并排出现
   * 就是两个无法区分的选项。保留较小的那个，避免菜单写 1M、实际超出窗口。
   * 360K / 720K 这类标签不同的自定义档位仍然保留。
   */
  const byLabel = new Map<string, number>();
  for (const value of valid) {
    const label = formatTokens(value);
    const previous = byLabel.get(label);
    if (previous === undefined || value < previous) byLabel.set(label, value);
  }
  return [...byLabel.values()].sort((a, b) => a - b);
}

/** 把已保存的预算对到菜单里的同档位；显示为同一档（如 1M）时用保留值。 */
export function matchBudget(value: number, budgets: readonly number[]): number | null {
  if (budgets.includes(value)) return value;
  const label = formatTokens(value);
  return budgets.find((budget) => formatTokens(budget) === label) ?? null;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))}M`;
  if (value < 1024) return `${Math.round(value)}`;
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
