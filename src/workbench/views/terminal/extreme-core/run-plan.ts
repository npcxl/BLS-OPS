/**
 * 运行记录（run）与计划。
 *
 * 一条**运行** = 用户的一次请求。简单查询只有一行状态，复杂任务才展开步骤。
 *
 * 三条原则：
 * 1. **AI 决定做什么，执行器决定这一步是否完成** —— 步骤状态只从执行结果来，
 *    不接受模型自己说"已完成"；
 * 2. **升级只增不减** —— 中途发现复杂度上升时，已完成的探测与证据原样保留；
 * 3. 步骤 id 稳定：同一 id 的新事件覆盖旧字段，但**已完成的不会被回退**。
 */

export type RunComplexity = "simple" | "plan";

export type RunStepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface RunStep {
  id: string;
  title: string;
  /** 目标：命令、路径或验证方式。 */
  detail?: string | null;
  command?: string | null;
  state: RunStepState;
  /** 执行器给出的一行结论/输出（证据），不是模型的描述。 */
  evidence?: string | null;
}

export type RunStatus = "running" | "waiting" | "done" | "failed" | "cancelled" | "stale";

export interface RunRecord {
  taskId: string;
  /** 这次要达成什么（用户的请求）。 */
  goal: string;
  status: RunStatus;
  complexity: RunComplexity;
  steps: RunStep[];
  /** 一句话进展：聊天里只显示它，完整步骤在右栏。 */
  headline: string;
  /**
   * 这一轮实际使用的上下文范围 / 输出形态 / 模型（发起时快照）。
   *
   * 运行中改选只影响下一条；这条记录保留当初的事实，便于回看"当时是怎么问的"。
   */
  meta?: string | null;
  updatedAt: number;
}

/** 执行器/卡片上的状态名（两套来源：deploy 的 success、agent 的 done）。 */
export function normalizeStepState(state: string | null | undefined): RunStepState {
  switch (state) {
    case "done":
    case "success":
      return "done";
    case "running":
    case "active":
      return "running";
    case "failed":
    case "error":
      return "failed";
    case "skipped":
    case "cancelled":
      return "skipped";
    default:
      return "pending";
  }
}

/**
 * 是否需要展开计划。
 *
 * 不看模型怎么说，看**事实**：写操作、步骤数、以及请求本身的规模词。
 * 一旦为 true 就保持（升级只增不减）。
 */
export function shouldPlan(input: {
  goal: string;
  steps: RunStep[];
  /** 已经出现过的审批/确认次数。 */
  approvals?: number;
}): boolean {
  const text = input.goal.trim();
  const steps = input.steps.length;
  const writes = input.steps.filter(
    (step) => step.state !== "pending" && Boolean(step.command),
  ).length;
  // 规模词：发布、部署、迁移、备份、回滚、证书、多台……
  const big =
    /(发布|部署|上线|迁移|备份|回滚|证书|灰度|扩容|升级|重建|多台|集群)/.test(text) ||
    // 「检查 A 和 B」这类并列目标，通常不止一步。
    /(并且|同时|顺便|以及|和.+再)/.test(text);
  return steps >= 3 || writes >= 2 || (input.approvals ?? 0) > 0 || big;
}

/**
 * 合并步骤（结构化事件）。
 *
 * * 新 id → 追加到末尾；
 * * 同 id → 覆盖 title/detail/command/evidence，但**状态不回退**：
 *   已经 `done` 的步骤不会被后来的 `pending` 覆盖。
 */
export function mergeSteps(current: RunStep[], incoming: RunStep[]): RunStep[] {
  const next = [...current];
  for (const step of incoming) {
    const at = next.findIndex((item) => item.id === step.id);
    if (at < 0) {
      next.push(step);
      continue;
    }
    const previous = next[at];
    const state =
      previous.state === "done" && step.state !== "failed" ? "done" : step.state;
    next[at] = {
      ...previous,
      ...step,
      state,
      evidence: step.evidence ?? previous.evidence,
    };
  }
  return next;
}

/** 一句话进展：按状态与当前步骤生成（聊天区/计划页顶部共用）。 */
export function headlineFor(record: Omit<RunRecord, "headline">): string {
  const current = record.steps.find((step) => step.state === "running");
  const failed = record.steps.find((step) => step.state === "failed");
  const done = record.steps.filter((step) => step.state === "done").length;
  switch (record.status) {
    case "waiting":
      return current ? `等待确认：${current.title}` : "等待你确认";
    case "failed":
      return failed ? `停在第 ${done + 1} 步：${failed.title}` : "执行失败";
    case "cancelled":
      return "已停止";
    case "done":
      return record.steps.length > 0
        ? `已完成 ${done}/${record.steps.length} 步`
        : "已完成";
    case "stale":
      return "状态待核对";
    default:
      if (current) return `正在执行：${current.title}`;
      return record.steps.length > 0 ? `准备执行（${record.steps.length} 步）` : "正在分析";
  }
}

/**
 * 从一次执行的结果构造计划页要展示的步骤。
 *
 * 输入是**执行器的事实**（命令、输出、状态），不是模型的描述。命令被截断到
 * 一行，避免把整段 stdout 塞进计划页。
 */
export function stepsFromExecution(
  steps: {
    id?: string;
    title: string;
    detail?: string | null;
    command?: string | null;
    state?: string | null;
    stdout?: string | null;
    stderr?: string | null;
  }[],
): RunStep[] {
  return steps.map((step, index) => {
    const output = (step.stderr || step.stdout || "").trim().split("\n")[0] ?? "";
    return {
      id: step.id ?? `step-${index}`,
      title: step.title,
      detail: step.detail ?? null,
      command: step.command ?? null,
      state: normalizeStepState(step.state),
      evidence: output.slice(0, 160) || null,
    };
  });
}

/** 失败后是否还能从已完成的结果继续（保留证据，不从头再来）。 */
export function canContinue(record: RunRecord): boolean {
  if (record.status !== "failed") return false;
  return record.steps.some((step) => step.state === "done");
}
