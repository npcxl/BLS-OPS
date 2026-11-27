/**
 * 中间那一列：消息、部署过程、时间轴。
 *
 * 只负责排版与把回调接上 —— 滚动意图、任务卡与审批都在各自的模块里。
 */
import { useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { useExtremeStore, type ExtremeAttachment, type ExtremeMessage } from "@/stores/extreme-store";
import { MessageList } from "../MessageList";
import { DeployPlanPanel } from "../DeployPlanPanel";
import { MessageTimeline } from "../MessageTimeline";
import { GlassIconButton, ScrollDownIcon } from "../GlassIconButton";
import { PlanCard } from "../PlanCard";
import type { DeployStep } from "../deploy-plan";
import type { TaskArtifact, TaskCardModel } from "../task-view";
import type { WorkspaceTarget } from "../RemoteWorkspacePanel";
import type { AgentPlan } from "@/api/types/agent";
import { pickPlanRow } from "./locate-plan-step";
import type { ApprovalEntry } from "./types";

export interface ChatColumnProps {
  switching?: boolean;
  welcome: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  stickToBottom: RefObject<boolean>;
  atBottom: boolean;
  scrollToBottom: () => void;
  messages: ExtremeMessage[];
  asking: boolean;
  taskRunning?: boolean;
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
  onOpenOutput: (taskId: string) => void;
  /** 计划步骤定位：滚到聊天里对应的那条命令。 */
  locateStep?: (stepId: string) => void;
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
  switching = false,
  welcome,
  scrollRef,
  stickToBottom,
  atBottom,
  scrollToBottom,
  messages,
  asking,
  taskRunning = false,
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
  onOpenOutput,
  locateStep,
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
  /** 定位批次：切会话 / 连点会把上一批作废，迟到的回调不再动视图。 */
  const focusRunRef = useRef(0);
  useEffect(
    () => () => {
      focusRunRef.current += 1;
      useExtremeStore.setState({ stepReveal: null });
    },
    [workspaceId],
  );

  /*
   * 计划卡 → 聊天里的命令：**按卡片自己的 taskId + 计划步骤 id** 精确匹配。
   *
   * 同一步可能执行多次：优先正在运行的那条，其次最近一次。目标在折叠组里
   * 时只展开命中的那一组，等节点挂载后再滚动；定位期间暂停自动贴底，
   * 高亮结束只清高亮 —— 不把用户拉回底部。
   */
  const focusPlanStep = (taskId: string, planStepId: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const run = (focusRunRef.current += 1);
    const alive = () => run === focusRunRef.current;

    const pick = () => pickPlanRow(root, taskId, planStepId);
    const reveal = (node: HTMLElement) => {
      if (!alive()) return;
      stickToBottom.current = false;
      const attempts = node.closest<HTMLDetailsElement>("details.extreme-core-attempts");
      if (attempts) attempts.open = true;
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("extreme-core-locate-flash");
      window.setTimeout(() => node.classList.remove("extreme-core-locate-flash"), 1400);
    };

    const hit = pick();
    if (hit) {
      reveal(hit);
      return;
    }
    // 只展开命中的组：store 里带 workspaceId + taskId + planStepId，别的
    // 对话 / 别的任务不受影响。
    useExtremeStore.setState({
      stepReveal: { workspaceId: workspaceId ?? "", taskId, planStepId },
    });
    let tries = 0;
    const tick = () => {
      if (!alive()) return;
      const node = pick();
      if (node) {
        reveal(node);
        window.setTimeout(() => {
          if (alive()) useExtremeStore.setState({ stepReveal: null });
        }, 300);
        return;
      }
      tries += 1;
      if (tries > 20) {
        useExtremeStore.setState({ stepReveal: null });
        // 只有计划状态、没有聊天执行记录：位置不动，只提示。
        setNotice(t("暂无执行记录"));
        return;
      }
      window.setTimeout(tick, 30);
    };
    window.setTimeout(tick, 30);
  };
  // 贴底判定不在这里做：真实输入（滚轮 / 触摸 / 按键）在 `useChatScroll` 里监听。
  return (
          <div className="extreme-core-chat-layout relative flex min-h-0 flex-1">
          {switching && (
            <div className="extreme-workspace-skeleton" role="status" aria-label={t("正在切换任务…")}>
              <div className="extreme-workspace-skeleton-content" aria-hidden="true">
                <div className="extreme-workspace-skeleton-user" />
                <div className="extreme-workspace-skeleton-line" />
                <div className="extreme-workspace-skeleton-line short" />
                <div className="extreme-workspace-skeleton-line medium" />
              </div>
            </div>
          )}
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
              onOpenOutput={onOpenOutput}
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
                onLocateStep={locateStep}
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
                  taskStatus={sessionTasks[planCard.taskId]?.status}
                  onFocusStep={(stepId) => focusPlanStep(planCard.taskId, stepId)}
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
            <div className={cn("extreme-core-scroll-control absolute bottom-4 left-1/2 z-20 -translate-x-1/2", taskRunning && "extreme-core-scroll-running")}>
              <GlassIconButton
                label={t("Scroll to bottom")}
                onClick={scrollToBottom}
                size={44}
                icon={taskRunning ? (
                  <span className="extreme-core-scroll-indicator" aria-hidden="true">
                    <span className="extreme-core-scroll-activity"><span /><span /><span /></span>
                    <span className="extreme-core-scroll-arrow"><ScrollDownIcon /></span>
                  </span>
                ) : undefined}
              />
            </div>
          )}
          </div>
  );
}
