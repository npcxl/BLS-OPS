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
import type { DeployStep } from "../deploy-plan";
import type { TaskArtifact, TaskCardModel } from "../task-view";
import type { WorkspaceTarget } from "../RemoteWorkspacePanel";

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
}: ChatColumnProps) {
  const { t } = useTranslation();
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
              onPreview={openArtifact}
              sessionId={sessionId ?? undefined}
              onOpenWorkspaceTarget={openWorkspaceTarget}
              onResumeTask={(task) => void resumeTask(task)}
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
