/**
 * 超能的**任务上下文**：聊天、计划、任务卡共享的同一份事实。
 *
 * 之前的毛病是三条路径各算各的：聊天回答一段、`generatePlan` 按附件猜一段、
 * `planUpdate` 又另起一个 taskId。于是"目标已定位成静态站点"，计划却是
 * Compose 新建，历史里还多一条。
 *
 * 这里只放纯数据与纯函数（不碰 React/Tauri），由页面在**创建任务时**填写：
 * * `originMessageId` 显式记录发起消息，不再"找最近一条没挂卡的消息"；
 * * `verifiedTarget` 只接收**已核实**的探测事实（证据字符串必填）；
 * * `planKind` 由 `selectPlanKind` 依事实推导，不允许调用方各自决定。
 */
export type PlanKind =
  | "static-update"
  | "compose-update"
  | "compose-create"
  | "query"
  | "probe"
  | "build"
  | "automation";

/** 任务阶段：决定卡片上唯一下一步按钮显示什么。 */
export type TaskPhase =
  | "collecting"
  | "planned"
  | "confirming"
  | "running"
  | "waiting"
  | "done"
  | "failed";

/** 已核实的目标（来自只读探测，不是从用户名/扩展名猜的）。 */
export interface VerifiedTarget {
  kind: "static-site" | "compose-project" | "bare";
  /** 站点根目录或 Compose 项目目录（服务器绝对路径）。 */
  root?: string;
  /** Compose 服务名（仅 compose-project）。 */
  service?: string;
  /** 实测证据：凭什么判定是这个类型（命令输出摘要）。 */
  evidence: string;
}

export interface TaskContext {
  taskId: string;
  /** 发起这条任务的用户消息 id：创建时显式写入，卡片只挂这一条。 */
  originMessageId: string;
  server: string;
  sessionId: string;
  verifiedTarget?: VerifiedTarget;
  /** 这条任务用到的附件 id（如 dist.zip）。 */
  attachmentIds: string[];
  planKind?: PlanKind;
  phase: TaskPhase;
  /** 计划版本：目标或范围变化就 +1，旧确认自动失效。 */
  planVersion: number;
}

export function createTaskContext(input: {
  taskId: string;
  originMessageId: string;
  server: string;
  sessionId: string;
  attachmentIds?: string[];
  verifiedTarget?: VerifiedTarget;
}): TaskContext {
  return {
    taskId: input.taskId,
    originMessageId: input.originMessageId,
    server: input.server,
    sessionId: input.sessionId,
    verifiedTarget: input.verifiedTarget,
    attachmentIds: input.attachmentIds ?? [],
    phase: "collecting",
    planVersion: 1,
  };
}

/** 记录/替换已核实目标；目标变化视为新一版计划。 */
export function withVerifiedTarget(context: TaskContext, target: VerifiedTarget): TaskContext {
  const changed =
    context.verifiedTarget?.kind !== target.kind ||
    context.verifiedTarget?.root !== target.root ||
    context.verifiedTarget?.service !== target.service;
  return {
    ...context,
    verifiedTarget: target,
    planVersion: changed ? context.planVersion + 1 : context.planVersion,
  };
}

/** 计划已生成，进入待确认。 */
export function withPlan(context: TaskContext, planKind: PlanKind): TaskContext {
  return { ...context, planKind, phase: "confirming" };
}

/** 目标/范围变化：计划版本 +1，退回待确认。 */
export function bumpPlan(context: TaskContext): TaskContext {
  return { ...context, planVersion: context.planVersion + 1, phase: "confirming" };
}

/**
 * 这条任务还能不能"继续"（用户说「开始吧」时的候选）。
 *
 * 除了待确认/等待，"已核实目标但还没出计划"也算 —— 用户说「开始」时要能
 * **原地生成计划**，而不是回一段问答或另起一个任务。
 */
export function canContinue(
  context: Pick<TaskContext, "phase" | "verifiedTarget">,
): boolean {
  if (context.phase === "planned" || context.phase === "confirming" || context.phase === "waiting") {
    return true;
  }
  return context.phase === "collecting" && context.verifiedTarget !== undefined;
}

/** 计划是否已经展示过（没展示过就不该显示"0/0 失败"）。 */
export function hasPlan(context: Pick<TaskContext, "planKind">): boolean {
  return context.planKind !== undefined;
}

/**
 * 卡片上**唯一**的下一步。
 *
 * 没有计划时给"继续收集"，有计划待确认时给"确认执行"，失败时给"重试这一步"，
 * 不再用一句"执行失败 0/0"含糊过去。
 */
export type NextAction = "inspect" | "plan" | "confirm" | "run" | "retry" | "wait" | "done" | "none";

export function nextAction(context: TaskContext): NextAction {
  switch (context.phase) {
    case "collecting":
      return context.verifiedTarget ? "plan" : "inspect";
    case "planned":
      return "plan";
    case "confirming":
      return hasPlan(context) ? "confirm" : "plan";
    case "running":
      return "run";
    case "waiting":
      return "wait";
    case "done":
      return "done";
    case "failed":
      return context.planKind ? "retry" : "inspect";
    default:
      return "none";
  }
}

/** 计划选择所需的事实（全部来自只读探测）。 */
export interface PlanFacts {
  /** 目标目录/站点已确认是静态站点（Nginx root 下的 index.html）。 */
  staticSiteOnServer: boolean;
  /** dist.zip 已经在服务器上（不必再上传一次）。 */
  distZipOnServer: boolean;
  /** 服务器上确实有 Compose 项目（compose.yaml + 运行中的容器）。 */
  composeProjectOnServer: boolean;
  /** 附件里有 compose 文件（新建场景）。 */
  composeInAttachments: boolean;
}

/**
 * 依事实选计划类型 —— **不猜**。
 *
 * * 静态站点 + 服务器上已有 dist.zip → 静态更新（不重启共享 Nginx）；
 * * 服务器上确实是 Compose 项目 → 更新现有服务；
 * * 附件带 compose 文件 → 新建 Compose；
 * * 否则返回 null：先让用户补信息/先探测，而不是返回"缺 Compose"。
 */
export function selectPlanKind(facts: PlanFacts): PlanKind | null {
  if (facts.staticSiteOnServer && facts.distZipOnServer) return "static-update";
  if (facts.composeProjectOnServer) return "compose-update";
  if (facts.composeInAttachments) return "compose-create";
  return null;
}
