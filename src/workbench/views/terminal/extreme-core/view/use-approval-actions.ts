/**
 * 审批的**表态入口**与桌面通知。
 *
 * 卡片与通知共用同一个函数（`decideApprovalRef`），避免两套状态各自判断
 * "点了没有"。后端明确回"没有这个等待者"时收起卡片，网络失败则保留按钮。
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { opsApi } from "@/api/ops-api";
import { toAppError } from "@/lib/app-error";
import {
  hideApprovalNotification,
  installApprovalNotifications,
  syncApprovalNotifications,
} from "@/desktop-notification/approval";
import { useExtremeStore } from "@/stores/extreme-store";
import type { TFn } from "./helpers";
import { approvalKeyOf, type ApprovalEntry } from "./types";

type Store = ReturnType<typeof useExtremeStore.getState>;

/** 通知标题用的一句话：超长命令截断，避免整行看不懂。 */
function clip(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export interface ApprovalActionsDeps {
  t: TFn;
  approvalEntries: Record<string, ApprovalEntry>;
  approvalEntriesRef: MutableRefObject<Record<string, ApprovalEntry>>;
  decideApprovalRef: MutableRefObject<
    (allow: boolean, callId: string, taskId: string) => Promise<void>
  >;
  updateApprovalEntry: (key: string, patch: Partial<ApprovalEntry>) => void;
  dropApprovals: (match: (entry: ApprovalEntry) => boolean) => void;
  setNotice: Store["setNotice"];
}

export function useApprovalActions(deps: ApprovalActionsDeps) {
  const {
    t,
    approvalEntries,
    approvalEntriesRef,
    decideApprovalRef,
    updateApprovalEntry,
    dropApprovals,
    setNotice,
  } = deps;

  /**
   * 对**指定**那条挂起中的写 / 危险操作表态。
   *
   * 按 `taskId + callId` 定位，所以：
   * * 通知里点 A 的处理完，B 的仍然在；
   * * 重复点同一条不会重复提交（`sending` / `closed` 直接忽略）。
   *
   * 拒绝也要回后端：模型拿到"用户拒绝"后换方案，而不是一直等在那里。
   */
  const decideApprovalById = useCallback(
    async (allow: boolean, callId: string, taskId: string) => {
      const key = approvalKeyOf(taskId, callId);
      const entry = approvalEntriesRef.current[key];
      if (!entry) return;
      // 已经在提交 / 已表态：通知与卡片重复点击都挡在这里。
      if (entry.phase === "sending" || entry.closed) return;
      const ownerId =
        useExtremeStore.getState().tasks[taskId]?.workspaceId ?? useExtremeStore.getState().workspaceId;
      if (!ownerId) return;
      updateApprovalEntry(key, { phase: "sending", failure: null });
      try {
        const accepted = await opsApi.aiAgentApprove(taskId, callId, allow);
        if (!accepted) {
          /*
           * 后端明确说"没有这个等待者"：这一步已经结束/超时，按钮留着也没用。
           * 这不是"没送达"，重试也不会成功，所以直接收起并说明。
           */
          dropApprovals((item) => approvalKeyOf(item.approval.taskId, item.approval.callId) === key);
          if (useExtremeStore.getState().workspaceId === ownerId) {
            setNotice(t("这一步已经结束或超时，确认没有生效。"));
          }
          return;
        }
        /*
         * **确认送达后不再另起气泡**：这一步就在时间线里，状态更新直接落在
         * 同一个步骤上（执行中 → 成功 / 失败；拒绝 → 未执行）。另发一条聊天
         * 回执会把结论推到回执下方，顺序就乱了。
         */
        /*
         * 后端收下了决定：把结果状态从"正在提交"推进到最终态。
         *
         * 通知窗口靠它把那条推送更新成"已拒绝 · 此步骤未执行"；停在
         * `sending` 的话通知会一直显示"正在提交…"，用户不知道到底生效了没有。
         */
        updateApprovalEntry(key, {
          phase: allow ? "allowed" : "denied",
          closed: true,
          failure: null,
        });
      } catch (cause) {
        /*
         * **请求没送到后端**：这一步仍在等确认。保留按钮，把原因写在条上，
         * 用户可以直接再点一次。
         */
        updateApprovalEntry(key, { phase: "failed", failure: toAppError(cause).message });
      }
    },
    [dropApprovals, setNotice, t, updateApprovalEntry],
  );
  decideApprovalRef.current = decideApprovalById;

  /*
   * 翻译函数要**稳定引用**：它以前直接进 effect 依赖，切语言 / `t` 身份变化
   * 会重装监听器（旧实例的清理还会把新实例的 handlers 摘掉）。
   */
  const translateRef = useRef(t);
  translateRef.current = t;
  const translate = useCallback(
    (key: string, options?: Record<string, unknown>) => translateRef.current(key, options),
    [],
  );

  /*
   * 审批 → 桌面通知。
   *
   * **每条都在**：A、B 同时等确认时各自一条通知，处理 A 不会顺手把 B 的
   * 通知撤掉；卡片与通知共享同一个状态，任一端处理完另一端同步更新。
   * 只有主窗口收起时才真的弹（判断在 `syncApprovalNotifications` 里）。
   * 已处理 / 已过期 / 已撤下的条目由通知层过滤，不当作新提醒。
   */
  useEffect(() => {
    syncApprovalNotifications(
      Object.values(approvalEntries).map((entry) => ({
        taskId: entry.approval.taskId,
        callId: entry.approval.callId,
        /*
         * 通知标题只放一句话操作：没有 summary 时退回命令首行，但要截断 ——
         * 一整条带参数的命令会把通知标题撑成一行看不懂的长串。
         */
        operation: clip(
          entry.approval.summary?.trim() ||
            entry.approval.command.split("\n")[0]?.trim() ||
            entry.approval.path ||
            "",
          80,
        ),
        server: entry.approval.server,
        // 通知的点击归属：不带这两项，用户点开会被送到"当前对话"而不是这条审批。
        serverId: entry.approval.serverId,
        workspaceId:
          entry.approval.workspaceId ??
          useExtremeStore.getState().tasks[entry.approval.taskId]?.workspaceId ??
          null,
        impact:
          entry.approval.impact?.trim() || t("影响未知：这一步会改动服务器上的内容。"),
        risk: entry.approval.risk === "danger" ? "danger" : "write",
        phase: entry.phase,
        failure: entry.failure,
        closed: entry.closed,
        deadline: entry.approval.deadline,
      })),
      translate,
    );
  }, [approvalEntries, t, translate]);

  /** 通知按钮路由：按 taskId + callId 找到那一条，与卡片走同一个入口。 */
  useEffect(
    () =>
      installApprovalNotifications(
        {
          decide: (taskId, callId, allow) => {
            void decideApprovalRef.current(allow, callId, taskId);
          },
          open: () => {
            // 回来时确认条就在眼前：通知先收起，避免两处同时可点。
            hideApprovalNotification();
          },
        },
        translate,
      ),
    [translate],
  );

  return { decideApprovalById };
}
