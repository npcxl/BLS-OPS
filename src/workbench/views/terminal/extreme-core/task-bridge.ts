/**
 * 任务卡 → 任务上下文（桥）。
 *
 * `task-context` 是纯数据模型，`task-view` 是渲染模型；两者形状不同，之前调用方
 * 各自把 `status` 翻译成"能不能继续""下一步是什么"，于是按钮、意图路由与卡片
 * 状态三处各说各话。这里只做**一次**映射，谁要判断任务都能拿到同一份上下文。
 *
 * 卡片本身不存 `phase` / `planKind`：它们由状态与步骤推导，避免出现"卡片显示
 * 待确认、上下文却是收集态"这种双写不一致。
 */
import type { DeployStep } from "./deploy-plan";
import {
  nextAction,
  type NextAction,
  type PlanKind,
  type TaskContext,
  type TaskPhase,
} from "./task-context";
import type { TaskStatus } from "./task";
import type { TaskCardModel } from "./task-view";

/** 卡片状态 → 任务阶段。 */
const PHASE: Record<TaskStatus, TaskPhase> = {
  inspecting: "collecting",
  waiting: "waiting",
  confirming: "confirming",
  running: "running",
  verifying: "running",
  done: "done",
  failed: "failed",
  // 已取消 = 还可以重试：和失败同一条链路（重跑未完成的步骤），不是"重新收集"。
  cancelled: "failed",
};

export function phaseOfCard(card: TaskCardModel): TaskPhase {
  return PHASE[card.status];
}

/** 步骤是否静态站点更新的那套（`static-*` 由 `buildStaticUpdatePlan` 生成）。 */
export function planKindOfCard(card: TaskCardModel): PlanKind | undefined {
  if (card.steps.length === 0) return undefined;
  if (card.steps.some((step) => step.id.startsWith("static-"))) return "static-update";
  switch (card.kind) {
    case "query":
      return "query";
    case "probe":
      return "probe";
    case "build":
      return "build";
    case "automation":
      return "automation";
    // 有步骤的部署任务都是"改一台已经存在的目标"，新建 Compose 只在生成计划时出现。
    default:
      return "compose-update";
  }
}

/**
 * 卡片 → 上下文。
 *
 * `verifiedTarget` 不从步骤文本里反推：卡片没存它就别假装核实过 —— 缺它时
 * `canContinue` 会要求先补事实，而不是拿一句 `detail` 当证据。
 */
export function contextOfCard(card: TaskCardModel): TaskContext {
  return {
    taskId: card.id,
    originMessageId: card.originMessageId ?? "",
    server: card.server,
    sessionId: card.sessionId,
    attachmentIds: [],
    planKind: planKindOfCard(card),
    phase: phaseOfCard(card),
    planVersion: 1,
  };
}

/**
 * store 里的任务 → 上下文列表。
 *
 * 传了 `sessionId` 就只保留这一台的任务：切服务器后说「开始吧」，不能推进
 * 上一台的任务。
 */
export function contextsOfTasks(
  tasks: Record<string, TaskCardModel>,
  sessionId?: string | null,
): TaskContext[] {
  return Object.values(tasks)
    .filter((card) => !sessionId || card.sessionId === sessionId)
    .map(contextOfCard);
}

/** 卡片上唯一的下一步（按钮就渲染它，不再并列三个）。 */
export function nextActionOfCard(card: TaskCardModel): NextAction {
  return nextAction(contextOfCard(card));
}

/**
 * 验证步骤：先按 id 里带 `verify` 认，再退回 `kind: "verify"`。
 *
 * * 静态计划里的 `static-inspect` 也是只读检查（`kind: verify`），按 kind 找会
 *   把它当"验证结果"；
 * * 宿主机模式改用 HTTP 码验证（`kind: "up"`、`id: verify`），只按 kind 找会
 *   漏掉它，卡片上就变成"没有验证"。
 */
export function verificationStep(card: TaskCardModel): DeployStep | undefined {
  return (
    card.steps.find((step) => /verify/i.test(step.id)) ??
    card.steps.find((step) => step.kind === "verify")
  );
}

/** 卡片按钮能派发的动作。 */
export type TaskCardAction = "confirm" | "retry" | "cancel" | "plan" | "inspect";
