import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { canContinue, type RunRecord, type RunStep } from "./run-plan";
import { useStepTitle } from "./step-title-i18n";

/**
 * 「计划」标签的内容。
 *
 * 简单查询只有一行状态（结果在对话里）；复杂任务才展开步骤。步骤状态与证据
 * 全部来自执行器，模型的说法不进这里。
 */
export function RunPlanPanel({
  record,
  onFocusStep,
}: {
  record: RunRecord;
  onFocusStep: (step: RunStep) => void;
}) {
  const { t } = useTranslation();
  // 步骤标题由执行器拼好（中文），英文界面按动词 + 目标改写。
  const localize = useStepTitle();
  const total = record.steps.length;
  const done = record.steps.filter((step) => step.state === "done").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-1.5 border-b border-line/60 px-2.5 py-2">
        <span
          className={cn(
            "mt-1 size-1.5 shrink-0 rounded-full",
            record.status === "done"
              ? "bg-success"
              : record.status === "failed"
                ? "bg-danger"
                : record.status === "waiting"
                  ? "bg-warning"
                  : record.status === "cancelled"
                    ? "bg-fg-subtle"
                    : "bg-accent animate-pulse",
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-11 text-fg">{record.headline}</p>
          <p className="truncate text-10 text-fg-subtle" title={record.goal}>
            {record.goal}
          </p>
        </div>
        {total > 0 && (
          <span className="shrink-0 text-10 tabular-nums text-fg-subtle">
            {done}/{total}
          </span>
        )}
      </div>

      {record.complexity === "simple" ? (
        <p className="px-3 py-2 text-11 text-fg-subtle">
          {t("简单查询：结果已回到对话，完整过程在「终端 → 执行输出」。")}
        </p>
      ) : (
        <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 py-1">
          {record.steps.map((step, index) => (
            <li key={step.id}>
              <button
                type="button"
                onClick={() => onFocusStep(step)}
                className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-hover"
              >
                <span
                  className={cn(
                    "mt-1 size-1.5 shrink-0 rounded-full",
                    step.state === "done"
                      ? "bg-success"
                      : step.state === "running"
                        ? "bg-accent animate-pulse"
                        : step.state === "failed"
                          ? "bg-danger"
                          : step.state === "skipped"
                            ? "bg-fg-subtle/50"
                            : "bg-fg-subtle/30",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-11 text-fg" title={localize(step.title)}>
                    {index + 1}. {localize(step.title)}
                  </span>
                  {(step.detail || step.command) && (
                    <span className="block truncate font-mono text-10 text-fg-subtle">
                      {step.detail || step.command}
                    </span>
                  )}
                  {step.evidence && (
                    <span className="block truncate text-10 text-fg-muted" title={step.evidence}>
                      {step.evidence}
                    </span>
                  )}
                </span>
                {step.state === "failed" && (
                  <span className="shrink-0 text-10 text-danger">{t("失败")}</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}

      {record.meta && (
        <p className="truncate border-t border-line/60 px-2.5 py-1 text-10 text-fg-subtle" title={record.meta}>
          {record.meta}
        </p>
      )}

      {canContinue(record) && (
        <p className="border-t border-line/60 px-2.5 py-1.5 text-10 text-fg-subtle">
          {t("已完成的步骤与证据都保留：可以让我从失败处继续，不必从头再来。")}
        </p>
      )}
    </div>
  );
}
