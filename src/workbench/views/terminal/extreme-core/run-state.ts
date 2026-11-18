/**
 * Agent 运行的**展示状态**（纯函数）。
 *
 * 后端只有 `running / waiting / success / failed / cancelled` 五个真状态，
 * 界面需要更细：请求刚发出但还没有任何步骤时是"正在分析"，点了停止到后端
 * 确认之间是"正在停止"，事件/快照对不上时是"状态待核对"。
 *
 * 把这些放在纯函数里，是为了能用一条条用例钉住：**只有真实终态才算完成**。
 */
import type { TaskStatus } from "./task";

export type RunState =
  /** 没有在跑的东西。 */
  | "idle"
  /** 请求已发出、还没有任何工具步骤：模型在想。 */
  | "analyzing"
  /** 有步骤在跑。 */
  | "running"
  /** 等用户确认某一步（写 / 危险操作）或补充信息。 */
  | "waiting"
  /** 已发取消，等后端确认（两阶段停止的第一阶段）。 */
  | "stopping"
  /** 事件丢了 / 快照超时 / 连接断了：需要重新核对，不能当成完成。 */
  | "stale"
  | "done"
  | "failed"
  | "cancelled";

export interface RunStateInput {
  /** 当前对话里最新的任务卡（没有就是 `null`）。 */
  task?: { status: TaskStatus; steps: unknown[] } | null;
  /** 请求在飞（`inFlight` / asking）。 */
  thinking: boolean;
  /** 用户已点停止、还没收到终态。 */
  stopping: boolean;
  /** 已判定为"状态待核对"。 */
  stale: boolean;
}

/** 终态：只有这三个可以显示"结束"。 */
const TERMINAL: RunState[] = ["done", "failed", "cancelled"];

export function isTerminalRun(state: RunState): boolean {
  return TERMINAL.includes(state);
}

export function deriveRunState(input: RunStateInput): RunState {
  const status = input.task?.status;
  /*
   * 顺序很重要：
   * 1. 终态优先 —— 卡已经完成就不该再显示"正在停止"（停止请求可能迟到了）；
   * 2. 停止 / 待核对是**界面态**，优先于 running；
   * 3. 剩下的按任务状态映射。
   */
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (input.stopping) return "stopping";
  if (input.stale) return "stale";
  if (status === "confirming" || status === "waiting") return "waiting";
  if (status === "running") {
    return (input.task?.steps.length ?? 0) > 0 ? "running" : "analyzing";
  }
  return input.thinking ? "analyzing" : "idle";
}

/** 过程区上那一行短句（不写"处理中"这种空话，说清在做什么）。 */
export function runStateLabel(state: RunState, t: (key: string) => string): string {
  switch (state) {
    case "analyzing":
      return t("正在分析…");
    case "running":
      return t("执行中");
    case "waiting":
      return t("等待你确认");
    case "stopping":
      return t("正在停止…");
    case "stale":
      return t("状态待核对");
    case "done":
      return t("已完成");
    case "failed":
      return t("执行失败");
    case "cancelled":
      return t("已停止");
    default:
      return "";
  }
}

/**
 * 输入框能不能发新消息。
 *
 * 只有**等待用户**（审批 / 补信息）与分析/执行中允许：正在停止时也允许输入
 * （消息会被受理并排队提示），"状态待核对"要先核对再发。
 */
export function canSendIn(state: RunState): boolean {
  return state === "idle" || state === "analyzing" || state === "running" ||
    state === "waiting" || state === "stopping";
}
