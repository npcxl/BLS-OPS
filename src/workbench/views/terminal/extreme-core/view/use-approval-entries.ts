/**
 * 挂起中的写 / 危险操作：**按 `taskId + callId` 逐条**保存，互不覆盖。
 *
 * 只做状态与增删改；真正的「表态」在后端调用那一层（`use-approval-actions`）。
 * 拆开是因为事件管线要能直接增删审批，而表态又要用到流式回复的收尾能力。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { AgentApproval } from "@/api/types/agent";
import type { TaskCardModel } from "../task-view";
import { approvalKeyOf, type ApprovalEntry } from "./types";

export function useApprovalEntries(
  tasks: Record<string, TaskCardModel>,
  workspaceId: string | null,
) {
  /**
   * 挂起中的写 / 危险操作，按 `taskId + callId` **逐条**管理。
   *
   * 以前只有一个槽位：B 的审批一到就把 A 的覆盖掉，窗口收起时也只能选出一条。
   * 现在每条自带阶段（待确认 / 提交中 / 已允许 / 已拒绝 / 未送达），互不覆盖。
   */
  const [approvalEntries, setApprovalEntries] = useState<Record<string, ApprovalEntry>>({});
  /** 同步副本：通知按钮与连点判断都读它（不等 React 重渲染）。 */
  const approvalEntriesRef = useRef<Record<string, ApprovalEntry>>(approvalEntries);
  approvalEntriesRef.current = approvalEntries;
  /** 当前对话要显示的确认条（按步骤顺序，逐条渲染）。 */
  const currentApprovals = useMemo(
    () =>
      Object.values(approvalEntries)
        .filter(
          (entry) =>
            !entry.closed && tasks[entry.approval.taskId]?.workspaceId === workspaceId,
        )
        .sort((a, b) => a.approval.stepIndex - b.approval.stepIndex),
    [approvalEntries, tasks, workspaceId],
  );
  /** 第一条当前审批：滚动定位与组合区高度判断都看它。 */
  const approval = currentApprovals[0]?.approval ?? null;
  /** 通知按钮与确认条按钮共用同一个入口（避免两份状态）。 */
  const decideApprovalRef = useRef<
    (allow: boolean, callId: string, taskId: string) => Promise<void>
  >(async () => undefined);

  /* --------------------------------------------------------------------- *
   * 审批：按 taskId + callId 逐条保存，互不覆盖
   * --------------------------------------------------------------------- */

  const setApprovalEntry = useCallback((next: AgentApproval) => {
    const key = approvalKeyOf(next.taskId, next.callId);
    setApprovalEntries((current) => ({
      ...current,
      [key]: { approval: next, phase: "pending", failure: null, closed: false },
    }));
  }, []);

  const updateApprovalEntry = useCallback(
    (key: string, patch: Partial<ApprovalEntry>) => {
      setApprovalEntries((current) => {
        const entry = current[key];
        if (!entry) return current;
        return { ...current, [key]: { ...entry, ...patch } };
      });
    },
    [],
  );

  /** 撤下 / 结算某些审批（按任务或按单条）。 */
  const dropApprovals = useCallback(
    (match: (entry: ApprovalEntry) => boolean) => {
      setApprovalEntries((current) => {
        let changed = false;
        const next = { ...current };
        for (const [key, entry] of Object.entries(current)) {
          if (!match(entry)) continue;
          delete next[key];
          changed = true;
        }
        return changed ? next : current;
      });
    },
    [],
  );

  /** 用户开口时收掉"已表态"的卡片（结果已经折成一行历史记录）。 */
  const dropClosedApprovals = useCallback(() => {
    dropApprovals((entry) => entry.closed);
  }, [dropApprovals]);

  return {
    approvalEntries,
    approvalEntriesRef,
    currentApprovals,
    approval,
    decideApprovalRef,
    setApprovalEntry,
    updateApprovalEntry,
    dropApprovals,
    dropClosedApprovals,
  };
}
