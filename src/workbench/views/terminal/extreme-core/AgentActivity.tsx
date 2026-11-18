import { Think } from "@ant-design/x";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status";
import type { ExecutionReport, ReportStatus } from "./execution-report";
import { reportStatusLabel } from "./execution-report";
import { useExtremeStore } from "@/stores/extreme-store";
import type { WorkspaceTarget } from "./RemoteWorkspacePanel";
import { TaskSteps } from "./TaskSteps";
import type { TaskArtifact, TaskCardModel } from "./task-view";

export function isAgentActivity(task: TaskCardModel) {
  return task.source === "agent" || task.steps.some((step) => step.kind === "tool");
}

export function showAgentActivity(task: TaskCardModel) {
  return task.steps.length > 0 || (task.status !== "done" && task.status !== "cancelled");
}

/** 状态 → 徽标语气。 */
const REPORT_TONE: Record<ReportStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  requested: "info",
  success: "success",
  partial: "warning",
  failed: "danger",
};

/**
 * 「执行结果」：平台替用户做的事（上传 / 生成计划 / 执行）的结果。
 *
 * 以前这些结果是一条 assistant 气泡，看着像模型说的话；现在固定挂在**发起它
 * 的那条任务**下面，一个动作一行。目录可点开右栏，失败原因直接写在这一行里。
 */
function ExecutionResults({
  reports,
  sessionId,
  onOpenTarget,
}: {
  reports: ExecutionReport[];
  sessionId: string;
  onOpenTarget?: (target: WorkspaceTarget) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="extreme-core-reports" aria-label={t("执行结果")}>
      <p className="extreme-core-reports-title">{t("执行结果")}</p>
      <ul className="space-y-1">
        {reports.map((report) => (
          <li key={report.id} className="extreme-core-report" data-status={report.status}>
            <div className="min-w-0 flex-1">
              <p className="break-words text-11 text-fg">{report.title}</p>
              {report.path && (
                <button
                  type="button"
                  className="extreme-core-report-path"
                  title={t("在右栏打开 {{path}}", { path: report.path })}
                  onClick={() =>
                    onOpenTarget?.({ kind: "directory", path: report.path!, sessionId })
                  }
                >
                  {report.path}
                </button>
              )}
              {report.detail && (
                <pre className="extreme-core-report-detail">{report.detail}</pre>
              )}
            </div>
            <StatusBadge tone={REPORT_TONE[report.status]}>
              {reportStatusLabel(report.status, t)}
            </StatusBadge>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentActivity({
  task,
  onPreview,
  onOpenTarget,
}: {
  task: TaskCardModel;
  onPreview?: (artifact: TaskArtifact, sessionId: string) => void;
  /** 执行结果里的目录：点开右栏。 */
  onOpenTarget?: (target: WorkspaceTarget) => void;
}) {
  const { t } = useTranslation();
  /*
   * **步骤默认收起**：运行中也只留一行「正在使用工具 · N 次」，要点开才看细节。
   * 一步一行地铺开会把对话挤没（尤其是重复重试的写入），用户只需要知道
   * "它在干什么"，细节按需展开。
   */
  const [expandedByUser, setExpanded] = useState<boolean>();
  const running = task.status === "running" || task.status === "inspecting" || task.status === "verifying";
  const waiting = task.status === "confirming" || task.status === "waiting";
  const expanded = expandedByUser ?? false;
  const detailsId = useId();
  /*
   * 订阅要用整条记录：`state.reports[task.id]` 没有时返回 `undefined`（引用
   * 稳定），不能在这里写 `?? []` —— 每次渲染一个新数组会让 zustand 反复重渲。
   */
  const reports = useExtremeStore((state) => state.reports[task.id]);
  if (!showAgentActivity(task)) {
    // 没有工具步骤、任务也结束了：只剩"执行结果"可能还有内容（例如上传）。
    return reports?.length ? (
      <ExecutionResults reports={reports} sessionId={task.sessionId} onOpenTarget={onOpenTarget} />
    ) : null;
  }

  const label = waiting
    ? t("等待你的确认")
    : task.status === "failed"
      ? t("执行失败")
      : task.status === "cancelled"
        ? t("已停止")
        : running
          ? t(task.steps.length ? "正在使用工具" : "正在分析请求")
          : t("处理过程");

  return (
    <>
      <Think
        className="extreme-core-agent-activity"
        data-agent-activity={task.id}
        loading={running}
        expanded={expanded}
        onExpand={setExpanded}
        destroyOnHidden={false}
        classNames={{ status: "extreme-core-agent-activity-header", content: "extreme-core-agent-activity-body" }}
        title={
          <button type="button" aria-expanded={expanded} aria-controls={detailsId} className="extreme-core-agent-activity-toggle">
            <span>{label}</span>
            {task.steps.length > 0 && (
              <span className="text-fg-muted">{t("工具调用 · {{n}} 次", { n: task.steps.length })}</span>
            )}
          </button>
        }
      >
        <div id={detailsId} hidden={!expanded}>
          {task.result && (task.status === "failed" || task.steps.length === 0) && (
            <p className="extreme-core-agent-activity-summary">{task.result}</p>
          )}
          {task.steps.length > 0 && <TaskSteps steps={task.steps} />}
          {onPreview && task.artifacts.length > 0 && (
            <div className="flex flex-wrap gap-1 px-3 pb-2">
              {task.artifacts.map((artifact) => (
                <Button key={artifact.path} variant="ghost" size="xs" title={artifact.path} onClick={() => onPreview(artifact, task.sessionId)}>
                  <FileText size={12} /> {artifact.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      </Think>
      {reports && reports.length > 0 && (
        <ExecutionResults reports={reports} sessionId={task.sessionId} onOpenTarget={onOpenTarget} />
      )}
    </>
  );
}
