/**
 * 超能的**任务模型**。
 *
 * 之前超能只有"一个部署计划"：`plan` 状态挂在 store 上，没有 taskId，也无法
 * 表达"检查中 / 等待用户 / 已取消"这些阶段。要做任务工作台，先把这层抽出来：
 *
 * * `id` 就是 taskId —— 运行、日志、结果、写回都用它做主键；
 * * `target` 记录**稳定的**服务器/数据库标识，SSH 会话单独放 `sessionId`
 *   （重连后会变，不能拿它当身份）；
 * * `planVersion` / `approvedVersion` 解决"确认的是哪一版计划"：用户改了目标
 *   或执行范围，`planVersion` 加一，旧确认自动失效，必须重新确认。
 *
 * 这个文件只有类型与纯函数，不碰 React、不碰 Tauri，便于单测。
 */

/** 任务类型。只读的两类（查询、检测）不需要确认就能开始。 */
export type TaskKind = "deploy" | "query" | "probe" | "build" | "automation";

/**
 * 任务状态。
 *
 * `inspecting` / `waiting` / `confirming` 是**准备阶段**，线上还什么都没改；
 * `running` / `verifying` 才会动服务器；后三个是终态。
 */
export type TaskStatus =
  | "inspecting"
  | "waiting"
  | "confirming"
  | "running"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled";

/**
 * 允许的状态流转。
 *
 * 只允许"往前走"或有明确理由的回退：失败可以重试回 `running`，等待用户补齐
 * 信息可以回 `inspecting`。**不允许**从 `done` 直接跳 `running` —— 那意味着
 * 同一批操作被重跑，正是要防的事。
 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inspecting: ["waiting", "confirming", "running", "verifying", "done", "failed", "cancelled"],
  waiting: ["inspecting", "confirming", "cancelled", "failed"],
  confirming: ["running", "inspecting", "waiting", "cancelled"],
  running: ["verifying", "done", "failed", "cancelled"],
  verifying: ["done", "failed", "cancelled", "running"],
  done: [],
  failed: ["running", "inspecting", "cancelled"],
  cancelled: ["inspecting"],
};

/** 终态：不再有任何自动化动作。 */
export function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** 需要用户点确认才能进执行。 */
export function needsConfirm(status: TaskStatus): boolean {
  return status === "confirming";
}

/** 只读任务：查询与检测，**不需要确认**，也允许并行。 */
export function isReadOnly(kind: TaskKind): boolean {
  return kind === "query" || kind === "probe";
}

/** 写任务：同一目标上要复用执行锁，防止双击/重连重复触发。 */
export function isWriteTask(kind: TaskKind): boolean {
  return kind === "deploy" || kind === "build" || kind === "automation";
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 卡片上的一句话状态文案（不写"进行中"这种空话，说明在做什么）。 */
export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "inspecting":
      return "检查中";
    case "waiting":
      return "等待补充信息";
    case "confirming":
      return "待确认";
    case "running":
      return "执行中";
    case "verifying":
      return "验证中";
    case "done":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

/** 终态里"可以重试"的那些。`done` 不该重跑，`cancelled` 要重新检查。 */
export function canRetry(status: TaskStatus): boolean {
  return status === "failed" || status === "cancelled";
}

/** 任务的稳定目标：服务器 / 数据库标识 + 当前 SSH 会话。 */
export interface TaskTarget {
  /** 服务器记录的 id —— 重连后仍然是同一台，不能换成 sessionId。 */
  serverId?: string;
  /** 数据库 profile 的 id。 */
  databaseId?: string;
  /** 当前 SSH 会话；断线重连会变，所以只是"这次绑定到哪个连接"。 */
  sessionId?: string;
  /** 展示用的名字（主机名 / 库名）。 */
  label: string;
}

/**
 * 一张任务卡的完整数据。
 *
 * 卡片上**只显示** `result`（一句当前结果）与 `step`（当前步骤），其余细节
 * 折叠到"查看日志"。`bytes` 只在有真实字节数时出现 —— 不做模拟百分比。
 */
export interface TaskCard {
  /** taskId：运行、日志、结果、写回的主键。 */
  id: string;
  kind: TaskKind;
  title: string;
  /** 用户原话里的目标，用于"继续"时重新拼上下文。 */
  goal: string;
  status: TaskStatus;
  /** 一句话当前结果。 */
  result?: string;
  /** 当前正在做的事 + 开始时间（用来显示耗时）。 */
  step?: { title: string; startedAt: number };
  /** 真实字节进度（上传才有）。 */
  bytes?: { done: number; total: number };
  target: TaskTarget;
  /** 计划版本：目标或范围变化就 +1。 */
  planVersion: number;
  /** 用户确认过的版本；与 `planVersion` 不一致即视为"未确认"。 */
  approvedVersion?: number;
  /** 折叠到任务 Tab。 */
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 新建一张卡。默认展开、未确认。 */
export function createTask(input: {
  id: string;
  kind: TaskKind;
  title: string;
  goal: string;
  target: TaskTarget;
  now?: number;
}): TaskCard {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    goal: input.goal,
    // 只读任务直接进执行；写任务先检查。
    status: isReadOnly(input.kind) ? "running" : "inspecting",
    target: input.target,
    planVersion: 1,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 计划变更：版本 +1，**旧确认立即失效**。
 *
 * 用户改了目标服务、线上目录或执行范围，都必须重新确认 —— 确认的是"这次
 * 这一版计划"，不是"这个任务"。
 */
export function bumpPlan(task: TaskCard, now = Date.now()): TaskCard {
  return {
    ...task,
    planVersion: task.planVersion + 1,
    approvedVersion: undefined,
    status: task.status === "confirming" ? "confirming" : task.status,
    updatedAt: now,
  };
}

/** 用户点了确认：记下确认的是哪一版。 */
export function approvePlan(task: TaskCard, now = Date.now()): TaskCard {
  return {
    ...task,
    approvedVersion: task.planVersion,
    status: canTransition(task.status, "running") ? "running" : task.status,
    updatedAt: now,
  };
}

/** 当前这一版计划是否已经被确认过。 */
export function isApproved(task: TaskCard): boolean {
  return task.approvedVersion === task.planVersion;
}

/**
 * 状态流转。非法流转返回原对象（不抛错，调用方用 `===` 判断是否生效）。
 */
export function moveTask(task: TaskCard, to: TaskStatus, now = Date.now()): TaskCard {
  if (!canTransition(task.status, to)) return task;
  return {
    ...task,
    status: to,
    updatedAt: now,
    // 进终态时清掉"正在做"的那一步，避免卡片停在旧步骤上。
    step: isTerminal(to) ? undefined : task.step,
    bytes: isTerminal(to) ? undefined : task.bytes,
  };
}

/**
 * 同目标写任务的互斥判定。
 *
 * 同一台服务器上的两个写任务不能并行：第二次确认要排队或拒绝。只读任务
 * （查询、检测）不受影响 —— 它们互不影响，允许并行。
 */
export function conflictsWith(
  candidate: Pick<TaskCard, "kind" | "target" | "status">,
  running: Pick<TaskCard, "id" | "kind" | "target" | "status">[],
): string | null {
  if (!isWriteTask(candidate.kind)) return null;
  if (isTerminal(candidate.status)) return null;
  for (const other of running) {
    if (!isWriteTask(other.kind)) continue;
    if (isTerminal(other.status)) continue;
    // 有 serverId 就按 id 比（重连后仍指向同一台）；没有才退回到展示名。
    const sameServer =
      candidate.target.serverId && other.target.serverId
        ? candidate.target.serverId === other.target.serverId
        : candidate.target.label === other.target.label;
    if (sameServer) return other.id;
  }
  return null;
}
