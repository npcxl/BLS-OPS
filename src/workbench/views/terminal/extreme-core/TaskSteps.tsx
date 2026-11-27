import { ThoughtChain } from "@ant-design/x";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { copyTextWithFeedback } from "@/lib/clipboard-feedback";
import type { DeployStep } from "./deploy-plan";
import { useStepTitle } from "./step-title-i18n";

/** 六种步骤状态都要有映射：`waiting` / `skipped` 在真实执行里会出现。 */
const STEP_STATUS = {
  pending: undefined,
  waiting: undefined,
  running: "loading",
  success: "success",
  failed: "error",
  skipped: undefined,
} as const;

const RISK_LABEL = {
  read: "只读",
  write: "写入",
  danger: "危险",
} as const;

/**
 * 连续重复的同一步合并成一条。
 *
 * 模型重试时后端会再发一次"解压归档"（同样的标题、同样的影响），逐条铺开就是
 * 六行一模一样的东西。这里只合并**相邻**且标题/影响/命令完全相同的步骤，
 * 保留最后一次的状态与输出，并用次数标出来 —— 不改变执行记录本身。
 */
export interface StepGroup {
  step: DeployStep;
  /** 连续出现几次（1 = 没有重复）。 */
  repeat: number;
}

export function groupSteps(steps: DeployStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const step of steps) {
    const previous = groups[groups.length - 1];
    /*
     * 只合并**显示上完全相同**的相邻步骤。类别必须一起比较：一次内部纠错
     * 和一次真实执行即使命令相同，也不是同一条记录（审计与状态都要保留）。
     */
    const same =
      previous &&
      previous.step.title === step.title &&
      (previous.step.command ?? "") === (step.command ?? "") &&
      (previous.step.detail ?? "") === (step.detail ?? "") &&
      (previous.step.risk ?? "") === (step.risk ?? "") &&
      (previous.step.category ?? "") === (step.category ?? "");
    if (same) {
      // 保留最新一条（状态/输出/退出码以最后这次为准）。
      previous.step = step;
      previous.repeat += 1;
      continue;
    }
    groups.push({ step, repeat: 1 });
  }
  return groups;
}

export function TaskSteps({
  steps,
  onLocateStep,
}: {
  steps: DeployStep[];
  /** 点步骤标题：定位到聊天里对应的那条命令（按 taskId + 步骤 id）。 */
  onLocateStep?: (stepId: string) => void;
}) {
  const { t } = useTranslation();
  // 步骤标题是 Rust 拼的（"解压归档" / "重启服务 nginx"），英文界面要兜底。
  const localize = useStepTitle();
  return (
    <ThoughtChain
      className="px-3 py-2.5"
      line="solid"
      items={groupSteps(steps).map(({ step, repeat }) => ({
        key: step.id,
        title: (
          <button
            type="button"
            title={t("在聊天里定位这一步")}
            onClick={(event) => {
              // ThoughtChain 自己会展开/收起，这里只拦点击、不再冒泡。
              event.stopPropagation();
              onLocateStep?.(step.id);
            }}
            className={cn(
              "relative inline-block max-w-full overflow-hidden truncate rounded-[4px] align-baseline text-left hover:text-fg",
              // 当前步骤扫光：一眼看出"正在刷新的是这一步"，不是整列一起动。
              step.state === "running" && "extreme-step-sweep",
            )}
          >
            {repeat > 1 ? `${localize(step.title)} ×${repeat}` : localize(step.title)}
          </button>
        ),
        // `detail` 是执行器拼好的整句（已按当前语言写过），不能当成 key 再查一次。
        description: step.detail || undefined,
        // 内部纠错 / 被拦下不是"执行失败"：面板里保留记录，但不上红色错误态。
        status:
          step.category === "internal" || step.category === "denied"
            ? undefined
            : STEP_STATUS[step.state],
        collapsible: Boolean(
          step.command || step.script || step.stdout || step.stderr || step.rollback || step.backupPath || step.childUsage,
        ),
        content: (
          <div className="min-w-0 space-y-1 text-11 text-fg-muted">
            {/* Agent 步骤标出风险：危险操作即使执行完了也要看得见。 */}
            {step.risk && (
              <p>
                {t("风险")}：{t(RISK_LABEL[step.risk])}
              </p>
            )}
            {step.command && <pre className="overflow-x-auto rounded-md bg-surface-2 px-2 py-1">{step.command}</pre>}
            {/* `cd` 包装、退出码回传与内部标记：调试用，默认收起。 */}
            {step.script && step.script !== step.command && (
              <details>
                <summary className="cursor-pointer select-none text-fg-subtle">
                  {t("实际执行脚本（含 cd 包装与退出码）")}
                </summary>
                <pre className="mt-1 overflow-x-auto rounded-md bg-surface-2 px-2 py-1">
                  {step.script}
                </pre>
              </details>
            )}
            {step.exitCode != null && <p>exit {step.exitCode}</p>}
            {step.childUsage && <p>{t("子任务累计用量（估算）：输入 {{input}}，输出 {{output}}", { input: step.childUsage.inputTokens.toLocaleString(), output: step.childUsage.outputTokens.toLocaleString() })}</p>}
            {(step.stdout || step.stderr) && (
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 px-2 py-1">
                {[step.stdout, step.stderr].filter(Boolean).join("\n")}
              </pre>
            )}
            {step.truncated && (
              <p className="text-warning">{t("输出过长，已截断（只保留前 8 MiB）")}</p>
            )}
            {/* 写文件的备份：路径与回滚命令都要能被复制出来。 */}
            {step.backupPath && (
              <p className="break-all">
                {t("备份")}：<code>{step.backupPath}</code>
              </p>
            )}
            {step.rollback && (
              <p className="break-all text-warning">
                {t("回滚")} · <code>{step.rollback}</code>
                <button
                  type="button"
                  className="ml-1.5 hover:text-fg"
                  onClick={() => void copyTextWithFeedback(step.rollback ?? "")}
                >
                  {t("复制")}
                </button>
              </p>
            )}
          </div>
        ),
      }))}
    />
  );
}
