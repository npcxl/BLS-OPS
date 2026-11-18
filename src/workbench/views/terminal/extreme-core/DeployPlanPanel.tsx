import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Container } from "@/components/icons";

import { StatusBadge, StatusNotice } from "@/components/ui/status";
import type { DeployStep } from "./deploy-plan";
import { TaskSteps } from "./TaskSteps";

export interface DeployPlanPanelProps {
  plan: DeployStep[];
  /** 展开 / 收起步骤列表（收起后由任务卡与右栏承载进度）。 */
  open: boolean;
  onToggle: () => void;
  executing: boolean;
  doneCount: number;
  currentStep?: DeployStep;
  failedStep?: DeployStep;
  notice: string | null;
  /** 执行中：置位停止标记，当前步骤跑完即停。 */

  /** 待确认 / 继续：派发执行。 */

  /** 回滚命令已复制到剪贴板（页面负责提示）。 */
  onRollbackCopied?: () => void;
}

/**
 * 部署任务面板：计划摘要 + 步骤 + 日志 + 确认/取消。
 *
 * 只读 `DeployStep[]` 派发动作，不持有执行状态 —— 执行循环、取消标记与历史
 * 写入都留在页面的执行器里，这里收起也不影响任务继续跑。
 */
export function DeployPlanPanel({
  plan,
  open,
  onToggle,
  executing,
  doneCount,
  currentStep,
  failedStep,
  notice,
  onRollbackCopied,
}: DeployPlanPanelProps) {
  const { t } = useTranslation();
  if (plan.length === 0) return null;
  const rollback = plan.find((step) => step.rollback)?.rollback;

  return (
    <section className="mt-3 overflow-hidden rounded-[8px] border border-line bg-surface-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-hover"
      >
        <Container size={12} className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate text-12">
          {t("部署计划")}
          <span className="ml-1 text-fg-subtle">
            {doneCount}/{plan.length}
            {currentStep && ` · ${currentStep.title}`}
          </span>
        </span>
        {/* 状态取自真实步骤结果，不靠 "2/5" 让用户自己猜。 */}
        <StatusBadge
          tone={
            executing
              ? "info"
              : failedStep
                ? "danger"
                : doneCount === plan.length
                  ? "success"
                  : "neutral"
          }
        >
          {executing
            ? t("执行中")
            : failedStep
              ? t("失败")
              : doneCount === plan.length
                ? t("已完成")
                : t("待确认")}
        </StatusBadge>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {open && <TaskSteps steps={plan} />}

      {failedStep && (
        <div className="border-t border-line px-2.5 py-1.5">
          <StatusNotice tone="warning" icon>
            <span className="font-medium">{t("待处理")}：</span>
            {failedStep.title}
            <span className="ml-1 text-fg-muted">{failedStep.stderr?.trim() || failedStep.detail}</span>
          </StatusNotice>
          {/* 回滚命令只展示、不自动执行：让用户看清原因后自己决定。 */}
          {rollback && (
            <div className="mt-1.5 flex items-start gap-1.5 text-10 text-fg-subtle">
              <span className="shrink-0">{t("回滚")}：</span>
              <code className="min-w-0 flex-1 break-all">{rollback}</code>
              <button
                type="button"
                className="shrink-0 hover:text-fg"
                onClick={() => {
                  void navigator.clipboard.writeText(rollback);
                  onRollbackCopied?.();
                }}
              >
                {t("复制")}
              </button>
            </div>
          )}
        </div>
      )}

      {/*
       * **没有任务按钮**：执行、继续、停止全部从聊天进入（用户说「开始吧」
       * 或「停」）。面板只负责展示状态与结果。
       */}
      {notice && (
        <div className="border-t border-line px-2.5 py-1.5 text-11 text-fg-muted">{notice}</div>
      )}
    </section>
  );
}
