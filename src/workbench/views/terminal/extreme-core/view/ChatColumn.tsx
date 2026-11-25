/**
 * 中间那一列：消息、部署过程、时间轴。
 *
 * 只负责排版与把回调接上 —— 滚动意图、任务卡与审批都在各自的模块里。
 */
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import type { ExtremeAttachment, ExtremeMessage } from "@/stores/extreme-store";
import { MessageList } from "../MessageList";
import { DeployPlanPanel } from "../DeployPlanPanel";
import { MessageTimeline } from "../MessageTimeline";
import { GlassIconButton } from "../GlassIconButton";
import { PlanCard } from "../PlanCard";
import type { DeployStep } from "../deploy-plan";
import type { TaskArtifact, TaskCardModel } from "../task-view";
import type { WorkspaceTarget } from "../RemoteWorkspacePanel";
import type { AgentPlan } from "@/api/types/agent";
import type { ApprovalEntry } from "./types";

export interface ChatColumnProps {
  welcome: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  stickToBottom: RefObject<boolean>;
  atBottom: boolean;
  scrollToBottom: () => void;
  messages: ExtremeMessage[];
  asking: boolean;
  attachments: ExtremeAttachment[];
  sessionTasks: Record<string, TaskCardModel>;
  openArtifact: (artifact: TaskArtifact, sessionId: string) => void;
  sessionId: string | null;
  openWorkspaceTarget: (target: WorkspaceTarget) => Promise<boolean>;
  resumeTask: (task: TaskCardModel) => Promise<void>;
  quoteMessage: (message: ExtremeMessage) => void;
  editMessage: (message: ExtremeMessage) => void;
  retryInterrupted: (message: ExtremeMessage) => void;
  resendMessage: (message: ExtremeMessage) => void;
  /** 任务结果里的「查看变更」：按 taskId 打开右栏对应的那一轮。 */
  openChanges: (taskId: string, changeId?: string) => void;
  plan: DeployStep[] | null | undefined;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  executing: boolean;
  doneCount: number;
  currentStep: DeployStep | null | undefined;
  failedStep: DeployStep | null | undefined;
  notice: string | null;
  setNotice: (text: string | null) => void;
  workspaceId: string | null;
  /** 当前对话最近一版 MAX 计划（右上角计划卡）。 */
  planCard: { taskId: string; plan: AgentPlan } | null;
  /** 审批条目：画在对应步骤上（同一件事不再占输入框上方一条）。 */
  approvals?: Record<string, ApprovalEntry>;
  /** 审批表态（与 MessageList 的公开签名一致）。 */
  onDecideApproval?: (allow: boolean, callId: string, taskId: string) => void;
}

export function ChatColumn({
  welcome,
  scrollRef,
  stickToBottom,
  atBottom,
  scrollToBottom,
  messages,
  asking,
  attachments,
  sessionTasks,
  openArtifact,
  sessionId,
  openWorkspaceTarget,
  resumeTask,
  quoteMessage,
  editMessage,
  retryInterrupted,
  resendMessage,
  openChanges,
  plan,
  panelOpen,
  setPanelOpen,
  executing,
  doneCount,
  currentStep,
  failedStep,
  notice,
  setNotice,
  workspaceId,
  planCard,
  approvals,
  onDecideApproval,
}: ChatColumnProps) {
  const { t } = useTranslation();
  /*
   * 计划卡 → 聊天里的命令：按 `data-plan-step` 找到那一步，滚到可见处并
   * 短暂高亮。计划本身不改聊天内容，只做定位。
   */
  const focusPlanStep = (planStepId: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const findRow = () =>
      Array.from(root.querySelectorAll<HTMLElement>("[data-plan-step]")).find(
        (item) => item.dataset.planStep === planStepId,
      );
    const reveal = (node: HTMLElement) => {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.dataset.planFocus = "1";
      window.setTimeout(() => {
        delete node.dataset.planFocus;
      }, 1600);
    };
    const row = findRow();
    if (row) {
      reveal(row);
      return;
    }
    /*
     * 这一步可能在一组已完成的命令里（组默认折叠）：
     * 先展开那一组，等一帧行渲染出来再定位。
     */
    const group = Array.from(root.querySelectorAll<HTMLElement>("[data-plan-steps]")).find(
      (node) => (node.dataset.planSteps ?? "").split(" ").includes(planStepId),
    );
    if (!group) return;
    group.click();
    window.requestAnimationFrame(() => {
      const inside = findRow();
      if (inside) reveal(inside);
    });
  };
  // 贴底判定不在这里做：真实输入（滚轮 / 触摸 / 按键）在 `useChatScroll` 里监听。
  return (
          <div className="extreme-core-chat-layout relative flex min-h-0 flex-1">
          <div
            ref={scrollRef}
            tabIndex={0}
            className={cn(
              "extreme-core-chat min-h-0 min-w-0 flex-1 overflow-y-auto py-5 [overflow-anchor:none]",
              welcome && "hidden",
            )}
          >
            <div className="extreme-core-column mx-auto w-full">

              <MessageList
              messages={messages}
              asking={asking}
              attachments={attachments}
              tasks={sessionTasks}
              approvals={approvals}
              onDecideApproval={onDecideApproval}
              onPreview={openArtifact}
              sessionId={sessionId ?? undefined}
              onOpenWorkspaceTarget={openWorkspaceTarget}
              onResumeTask={(task) => void resumeTask(task)}
              onOpenChanges={(task) => openChanges(task.id)}
              onQuote={quoteMessage}
              onEdit={editMessage}
              onRetryMessage={retryInterrupted}
              onResendMessage={resendMessage}
            />

              {/* 部署过程：面板只读步骤与状态，执行循环与取消标记留在页面。 */}
              <DeployPlanPanel
                plan={plan ?? []}
                open={panelOpen}
                onToggle={() => setPanelOpen(!panelOpen)}
                executing={executing}
                doneCount={doneCount}
                currentStep={currentStep ?? undefined}
                failedStep={failedStep ?? undefined}
                notice={notice}
                onRollbackCopied={() => setNotice(t("回滚命令已复制。"))}
              />
            </div>
          </div>
          {/* 计划卡：贴在聊天内容区右上角，不随滚动跑；收起后只剩一个按钮。 */}
          {!welcome && planCard && (
            <div className="pointer-events-none absolute right-3 top-3 z-10 max-w-[calc(100%-1.5rem)]">
              <div className="pointer-events-auto">
                <PlanCard
                  key={planCard.taskId}
                  taskId={planCard.taskId}
                  plan={planCard.plan}
                  onFocusStep={focusPlanStep}
                />
              </div>
            </div>
          )}
          {/* 消息时间轴：贴在正文左缘，独立于左侧会话列表；欢迎页不显示。 */}
          {!welcome && (
            <MessageTimeline
              messages={messages}
              asking={asking}
              workspaceId={workspaceId}
              scrollRef={scrollRef}
              stick={stickToBottom}
            />
          )}
          {!welcome && !atBottom && (
            <div className="absolute bottom-4 right-4 z-20">
              <GlassIconButton
                label={t("Scroll to bottom")}
                onClick={scrollToBottom}
                size={44}
              />
            </div>
          )}
          </div>
  );
}
