/** 超能视图内部的局部类型：只服务运行过程，不属于领域模型。 */
import type { AgentApproval } from "@/api/types/agent";
import type { ApprovalPhase } from "../AgentApprovalCard";

/**
 * 一条待确认的操作 + 它自己的阶段。
 *
 * 键是 `taskId:callId`：`callId` 只在一次运行内唯一（`call-0-0` 会重复），
 * 少了 taskId 两条任务的确认会抢同一格。
 */
export interface ApprovalEntry {
  approval: AgentApproval;
  phase: ApprovalPhase;
  /** `phase === "failed"` 的原因（请求没送到后端）。 */
  failure: string | null;
  /** 已表态：卡片收起，但结果还要留给桌面通知。 */
  closed: boolean;
}

export const approvalKeyOf = (taskId: string, callId: string) => `${taskId}:${callId}`;

/**
 * 一个执行动作的结果。
 *
 * `receipt` 是给模型的**真实回执**；`paused` = 这一步因为归属失效停住了
 * （原因已经写回原对话），整条动作链到此为止。
 */
export interface ActionResult {
  receipt: string;
  paused?: boolean;
}
