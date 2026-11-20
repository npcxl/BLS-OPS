import { useTranslation } from "react-i18next";
import { X } from "@/components/icons";
import { cn } from "@/lib/cn";
import { PageInspector } from "@/workbench/page-layout";
import type { DeployStep } from "./deploy-plan";
import { TaskSteps } from "./TaskSteps";
import { ExtremeIconButton } from "./ExtremeIconButton";
import type { PreflightField } from "./preflight";
import type { ExtremeRightTab } from "@/stores/extreme-store";

export interface InspectorPanelProps {
  tab: ExtremeRightTab;
  onTabChange: (tab: ExtremeRightTab) => void;
  onClose: () => void;
  /** 预检结果：字段 + 一句话摘要（未检查/权限不足各有自己的颜色）。 */
  details: PreflightField[];
  summary: string;
  preflightError: string | null;
  plan: DeployStep[] | null;
}

/**
 * 右栏：预检 / 步骤 / 日志。
 *
 * 纯展示，默认收起；数据全部来自页面（预检结果与当前计划），所以收起面板
 * 不会中断任何执行。
 */
export function InspectorPanel({
  tab,
  onTabChange,
  onClose,
  details,
  summary,
  preflightError,
  plan,
}: InspectorPanelProps) {
  const { t } = useTranslation();

  return (
    <PageInspector className="extreme-core-inspector">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {(
          [
            ["preflight", t("预检")],
            ["steps", t("步骤")],
            ["logs", t("日志")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onTabChange(id)}
            className={cn(
              "rounded-[6px] px-2 py-0.5 text-11",
              tab === id ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-hover",
            )}
          >
            {label}
          </button>
        ))}
        <ExtremeIconButton
          label={t("收起详情")}
          icon={X}
          iconSize={12}
          className="ml-auto"
          onClick={onClose}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {tab === "preflight" &&
          (preflightError ? (
            <p className="text-11 text-danger">{preflightError}</p>
          ) : details.length === 0 ? (
            <p className="text-11 text-fg-subtle">{t("正在检查…")}</p>
          ) : (
            <dl className="space-y-1.5">
              {details.map((field) => (
                <div key={field.label}>
                  <dt className="text-10 text-fg-subtle">{t(field.label)}</dt>
                  <dd
                    className={cn(
                      "truncate text-11",
                      field.state === "checked"
                        ? "text-fg"
                        : field.state === "missing"
                          ? "text-warning"
                          : field.state === "denied"
                            ? "text-danger"
                            : "text-fg-subtle",
                    )}
                    title={field.value ?? undefined}
                  >
                    {field.value ?? t("尚未检查")}
                  </dd>
                </div>
              ))}
              <div className="pt-1 text-10 text-fg-subtle">{summary}</div>
            </dl>
          ))}

        {tab === "steps" &&
          (!plan || plan.length === 0 ? (
            <p className="text-11 text-fg-subtle">{t("还没有部署步骤")}</p>
          ) : (
            <TaskSteps steps={plan} />
          ))}

        {tab === "logs" &&
          (!plan || plan.every((step) => !step.stdout && !step.stderr) ? (
            <p className="text-11 text-fg-subtle">{t("还没有输出")}</p>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-10 text-fg-muted">
              {plan
                .map((step) => `$ ${step.command ?? step.title}\n${step.stdout ?? ""}${step.stderr ?? ""}`)
                .join("\n")}
            </pre>
          ))}
      </div>
    </PageInspector>
  );
}
