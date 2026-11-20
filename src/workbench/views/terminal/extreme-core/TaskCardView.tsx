import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronUp,
  Container,
  FileText,
  Play,
  RefreshCw,
  ShieldCheck,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { StatusBadge, StatusNotice } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { TaskSteps } from "./TaskSteps";
import { isTerminal, statusLabel, type TaskStatus } from "./task";
import { verificationStep } from "./task-bridge";
import { stepProgress, type TaskArtifact, type TaskCardModel } from "./task-view";
import { durationText } from "./format-time";

const TONE: Record<TaskStatus, "neutral" | "warning" | "info" | "success" | "danger"> = {
  inspecting: "info",
  waiting: "warning",
  confirming: "warning",
  running: "info",
  verifying: "info",
  done: "success",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warning",
};

const KIND_ICON = {
  deploy: Container,
  query: FileText,
  probe: ShieldCheck,
  build: RefreshCw,
  automation: Play,
} as const;

/**
 * 统一任务卡：部署 / 查询 / 检测 / 构建 / 传输**共用**同一个外壳。
 *
 * 首屏只给「目标 · 状态 · 关键结果 · 下一步」，步骤、日志、产物按需展开；
 * 历史详情也用它渲染，所以这里不依赖任何会话内状态。
 */
export function TaskCardView({
  task,
  onPreview,
  onResume,
  defaultExpanded = false,
}: {
  task: TaskCardModel;
  /** 打开任务产物（服务器绝对路径 + 任务自己的会话）。 */
  onPreview?: (artifact: TaskArtifact, sessionId: string) => void;
  /** 从检查点恢复（中断 / 失败的任务）。 */
  onResume?: (task: TaskCardModel) => void;
  defaultExpanded?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const Icon = KIND_ICON[task.kind] ?? Container;
  const progress = stepProgress(task.steps);
  const failedStep = task.steps.find((step) => step.state === "failed");
  const verify = verificationStep(task);
  const running = task.status === "running" || task.status === "verifying";
  /** 计划里会改动服务器的步骤（写 / 危险）：执行前就让人看清"要动哪里"。 */
  const writes = task.steps.filter(
    (step) => step.kind === "tool" && step.risk && step.risk !== "read",
  );
  /** 完成后显示真实执行耗时：createdAt → 最后一次 updatedAt。 */
  const elapsed = task.updatedAt - task.createdAt;

  return (
    <section className="overflow-hidden rounded-[10px] border border-line bg-surface-1/95">
      <header className="flex items-center gap-2 px-3 py-2">
        <Icon size={13} className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate text-12 font-medium">{task.title}</span>
        {isTerminal(task.status) && elapsed > 0 && (
          <span className="shrink-0 text-10 text-fg-subtle">
            {t("用时 {{duration}}", { duration: durationText(elapsed, t) })}
          </span>
        )}
        <StatusBadge tone={TONE[task.status]} dot={running}>
          {t(statusLabel(task.status))}
        </StatusBadge>
      </header>

      <div className="space-y-1 border-t border-line px-3 py-2">
        {task.goal && <p className="truncate text-11 text-fg-muted">{t("目标")}：{task.goal}</p>}
        {writes.length > 0 && (
          <p
            className="truncate text-11 text-fg-subtle"
            title={writes.map((step) => t(step.title)).join(t("、"))}
          >
            {t("拟改动")}：{writes.map((step) => t(step.title)).join(t("、"))}
          </p>
        )}
        <p className="text-12">
          {t("当前")}：
          {progress.total > 0 ? `${progress.done}/${progress.total}` : "—"}
          {progress.current ? ` · ${t(progress.current.title)}` : ""}
        </p>
        <p className={cn("text-12", task.status === "failed" ? "text-danger" : "text-fg-muted")}>{task.result}</p>
        {/* 关键结果按任务类型取不同字段，避免每种任务一个卡片组件。 */}
        {/*
         * Agent 任务（`tool` 步骤）没有"部署验证"这一步：显示"未执行验证"
         * 只会让人以为漏了一步。
         */}
        {(task.status === "done" || verify?.state === "failed") &&
          (verify || !task.steps.some((step) => step.kind === "tool")) && (
          <p
            className={cn(
              "text-11",
              verify?.state === "failed"
                ? "text-danger"
                : verify?.state === "success"
                  ? "text-success"
                  : "text-fg-muted",
            )}
          >
            {t("验证结果")}：
            {verify
              ? verify.state === "success"
                ? t("通过")
                : verify.state === "failed"
                  ? t("未通过")
                  : t("等待执行")
              : t("未执行验证")}
            {verify?.detail ? ` · ${verify.detail}` : ""}
          </p>
        )}
        {task.kind === "probe" && (
          <p className="text-11 text-fg-muted">
            {t("异常项")}：{task.steps.filter((step) => step.state === "failed").length}
          </p>
        )}
        {task.kind === "query" && progress.current?.stdout && (
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-[6px] bg-surface-2 px-2 py-1 font-mono text-11 text-fg-muted">
            {progress.current.stdout.slice(0, 600)}
          </pre>
        )}
        {task.artifacts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {task.artifacts.map((artifact) => (
              <Button
                key={artifact.path}
                variant="ghost"
                size="xs"
                className="gap-1"
                title={artifact.path}
                onClick={() => onPreview?.(artifact, task.sessionId)}
              >
                <FileText size={12} />
                {artifact.name}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-3 py-1.5">
        <Button variant="ghost" size="xs" className="gap-1" onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? t("收起详情") : t("查看步骤")}
        </Button>
        <span className="text-11 text-fg-subtle">
          {progress.done}/{progress.total}
        </span>
        {onResume &&
          (task.status === "interrupted" ||
            (task.status === "failed" && task.steps.length > 0)) && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto gap-1 text-accent"
            onClick={() => onResume(task)}
          >
            {t("继续执行")}
          </Button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-line">
          {task.steps.length === 0 ? (
            <p className="px-3 py-2 text-11 text-fg-subtle">{t("这条记录没有保存步骤")}</p>
          ) : (
            <TaskSteps steps={task.steps} />
          )}
          {failedStep && (
            <StatusNotice tone="danger" icon className="m-2">
              <span className="font-medium">{t(failedStep.title)}</span>
              <span className="ml-1 text-fg-muted">{failedStep.stderr?.trim() || failedStep.detail}</span>
            </StatusNotice>
          )}
          {task.outcome && task.outcome.evidence.length > 0 && (
            <div className="border-t border-line px-3 py-2">
              <p className="text-11 text-fg-muted">{t("结论依据")}</p>
              <ul className="mt-1 space-y-0.5">
                {task.outcome.evidence.map((item) => (
                  <li key={item} className="truncate font-mono text-10 text-fg-subtle" title={item}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
