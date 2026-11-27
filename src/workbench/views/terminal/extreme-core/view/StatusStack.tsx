/**
 * 输入区上方的**运行状态堆栈**：错误、确认条、连接/通知、停止与队列。
 *
 * 全部由真实任务状态派生（`statusLine` / `currentApprovals` / `currentQueue`），
 * 这里只负责呈现与把动作转发回对应入口。
 */
import { useTranslation } from "react-i18next";
import { X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import type { ExtremeMessage, TerminalPane, WorkspacePane } from "@/stores/extreme-store";
import { AgentApprovalCard } from "../AgentApprovalCard";
import type { TaskCardModel } from "../task-view";
import { approvalKeyOf, type ApprovalEntry } from "./types";

export interface StatusStackProps {
  askError: string | null;
  retryMessage: ExtremeMessage | null;
  currentApprovals: ApprovalEntry[];
  tasks: Record<string, TaskCardModel>;
  decideApprovalById: (allow: boolean, callId: string, taskId: string) => Promise<void>;
  openPaneTab: (tab: WorkspacePane, terminal?: TerminalPane) => void;
  /** 审批卡上的「查看变更」：定位到这条审批对应的文件。 */
  openChanges: (taskId: string, changeId?: string) => void;
  sessionId: string | null;
  reconnect: () => void;
  notice: string | null;
  setNotice: (text: string | null) => void;
  stopOverdueId: string | null;
  activeTask: TaskCardModel | undefined;
  forceStop: () => Promise<void>;
  staleTask: string | null;
  stopPending: boolean;
  statusLine: string;
  recheckTask: (taskId: string) => Promise<void>;
  /** 部署计划正在执行：没有 Agent 操作链可看，进度行仍由这里承担。 */
  executing: boolean;
}

export function StatusStack({
  askError,
  retryMessage,
  currentApprovals,
  tasks,
  decideApprovalById,
  openPaneTab,
  openChanges,
  sessionId,
  reconnect,
  notice,
  setNotice,
  stopOverdueId,
  activeTask,
  forceStop,
  staleTask,
  stopPending,
  statusLine,
  recheckTask,
  executing,
}: StatusStackProps) {
  const { t } = useTranslation();
  /**
   * 输入框上方**一次只留最需要处理的一件事**。
   *
   * 运行进度已经在聊天里的操作链上，不再在输入框上方重复；这里按
   * 「待确认 > 待核对 > 停止超时 > 发送失败 > 普通 notice」排序，只显示第一条。
   * 连接状态例外：没连接时发送/执行都不可用，必须始终可见。
   */
  const hasApprovals = currentApprovals.length > 0;
  const showStale = !hasApprovals && Boolean(staleTask) && !stopPending;
  const showStopOverdue = !hasApprovals && !showStale && stopOverdueId === activeTask?.id;
  const showAskError = !hasApprovals && !showStale && !showStopOverdue && Boolean(askError);
  const showNotice =
    !hasApprovals && !showStale && !showStopOverdue && !showAskError && Boolean(notice);
  return (
    <>
          {showAskError && askError && (
            <div className="shrink-0 px-4 pt-2">
              <div className="mx-auto w-full max-w-3xl">
                <StatusNotice tone="danger" icon>
                  <span className="mr-1">{askError}</span>
                  {/没有配置|还没有配置/.test(askError) && (
                    <span className="text-fg-muted">
                      {t("在左栏「设置」里配置默认模型与 API Key。")}
                    </span>
                  )}
                  {/*
                   * 不给「重试」按钮：直接回一句「重试」就走同一条路由
                   * （`Sender` → `ask` → 上一个问题作为上下文重新发起）。
                   */}
                  {retryMessage && (
                    <span className="ml-2 text-fg-subtle">{t("回复「重试」重新执行。")}</span>
                  )}
                </StatusNotice>
              </div>
            </div>
          )}

          {/*
           * 确认条：**当前对话的每一条**都排在输入框上方（按步骤顺序）。
           * 别的对话的审批不出现在这里，只在左栏标「待确认」+ 桌面通知。
           */}
          <div className="max-h-[min(40vh,360px)] shrink-0 overflow-y-auto">
          {currentApprovals.map((entry) => (
            <div key={approvalKeyOf(entry.approval.taskId, entry.approval.callId)}>
              <AgentApprovalCard
                approval={entry.approval}
                goal={tasks[entry.approval.taskId]?.goal}
                phase={entry.phase}
                failure={entry.failure}
                stepState={
                  tasks[entry.approval.taskId]?.steps.find(
                    (step) => step.id === `agent-${entry.approval.stepIndex}`,
                  )?.state ?? null
                }
                onDecide={(allow) =>
                  void decideApprovalById(allow, entry.approval.callId, entry.approval.taskId)
                }
                onOpenChanges={
                  entry.approval.changeId
                    ? () =>
                        openChanges(
                          entry.approval.taskId,
                          entry.approval.changeId ?? undefined,
                        )
                    : undefined
                }
                onOpenOutput={() => {
                  // 「查看输出」：右栏切到终端 › 执行输出 —— 这条命令就在那一列里。
                  openPaneTab("terminal", "output");
                }}
              />
            </div>
          ))}
          </div>

          {/*
           * 这一段是连接状态：超能的命令都绑在一条 SSH 会话上，会话没了就必须
           * 明确说明并给出重连入口 —— 否则用户只会看到"发不出去"。
           */}
          {!sessionId && (
            <div
              role="status"
              className="mx-auto mb-1 flex w-full max-w-[880px] flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-11 text-danger"
            >
              <span className="min-w-0 flex-1">
                {t("服务器未连接：发送与执行都不可用。")}
              </span>
              <Button size="xs" variant="ghost" onClick={reconnect}>
                {t("重新连接")}
              </Button>
            </div>
          )}

          {/*
           * 操作反馈条：`setNotice` 写的都是"刚才发生了什么"（拒绝、送达失败、
           * 停止中不能发送…）。以前只写不显示，等于没有反馈。
           */}
          {showNotice && (
            <div className="mb-1 flex min-w-0 shrink-0 justify-center px-4">
              <div
                role="status"
                className="flex w-fit max-w-[min(100%,28rem)] items-start gap-1.5 rounded-lg bg-surface-2 py-1 pe-1 ps-2.5 text-11 text-fg-muted"
              >
                <span className="min-w-0 break-words py-0.5">{notice}</span>
                <Tooltip label={t("关闭提示")}>
                  <button
                    type="button"
                    aria-label={t("关闭提示")}
                    className="grid size-5 shrink-0 place-items-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                    onClick={() => setNotice(null)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
            </div>
          )}

          {/*
           * 停止迟迟没有后端确认：把「强制结束」摆出来。
           *
           * 只在同一个对话里显示；用户切走时它不该跟着出现在别人的界面上。
           */}
          {showStopOverdue && (
            <div
              role="status"
              className="mx-auto mb-1 flex w-full max-w-[880px] flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-11 text-warning"
            >
              <span className="min-w-0 flex-1">
                {t("停止还没有被后端确认：可以再点一次停止，或强制结束这次运行。")}
              </span>
              <Button size="xs" variant="ghost" onClick={() => void forceStop()}>
                {t("强制结束")}
              </Button>
            </div>
          )}

          {/*
           * 过程状态行：**由真实任务状态派生**，不是自己猜的 loading。
           *
           * 这里只说明"在做什么"，**不放停止按钮** —— 停止统一在 Prompt Bar
           * 右下角那一个键上（见 `stopRun`）。「状态待核对」多给一个
           * 「重新核对」；停止请求是否生效由按钮自己反映。
           */}
          {showStale && staleTask && (
            <div
              role="status"
              className="mx-auto mb-1 flex w-full max-w-[880px] flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-11 text-warning"
            >
              <span className="min-w-0 flex-1">
                {t("状态待核对：这次运行的进度没有拿到，可能仍在服务器上执行。")}
              </span>
              <Button size="xs" variant="ghost" onClick={() => void recheckTask(staleTask)}>
                {t("重新核对")}
              </Button>
            </div>
          )}

          {/*
           * 普通运行进度不在这里：聊天里的操作链已经显示。
           * 只有「停止请求还没落地」需要一句说明 —— 那是用户刚做的动作。
           *
           * `showStopOverdue` 时不再显示这一行：同一个停止动作已经有一条
           * 「停止还没有被后端确认」，两句话并排只会让用户不知道该信哪条。
           */}
          {!hasApprovals && !showStopOverdue && (stopPending || executing) && statusLine && (
            <div
              role="status"
              aria-live="polite"
              className="mx-auto mb-1 flex w-full max-w-[880px] items-center gap-2 px-1 text-11 text-fg-subtle"
            >
              <span className="min-w-0 flex-1 truncate" title={statusLine}>
                {statusLine}
              </span>
            </div>
          )}

    </>
  );
}
