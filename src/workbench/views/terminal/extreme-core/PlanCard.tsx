/**
 * 当前对话的**执行计划卡**（右上角）。
 *
 * - 数据来自消息上的计划片段（跟着这一轮落盘）：切换会话各看各的，重开也还在；
 * - 首次出现轻量展开一次；用户手动收起后，步骤更新不会把它重新弹开；
 * - 步骤状态由真实工具事件推进（pending / running / waiting / done / failed / skipped）；
 * - 点某一步 → 定位到聊天里对应的命令或结果。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronUp, ListTodo, Loader2, Minus, XCircle } from "@/components/icons";
import BranchedMenu, { type BranchedMenuItem } from "@/components/reactbits/BranchedMenu";
import type { AgentPlan, AgentPlanStep } from "@/api/types/agent";
import { cn } from "@/lib/cn";
import { useExtremeSettingsStore } from "@/stores/extreme-settings-store";
import { EC } from "./theme";
import { isTerminal, type TaskStatus } from "./task";

/** 窄窗口：默认只留一个「计划」按钮。 */
const NARROW_MAX = 1180;

function useNarrow() {
  const [narrow, setNarrow] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth <= NARROW_MAX,
  );
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_MAX}px)`);
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);
  return narrow;
}

/**
 * 每个会话自己的收起状态。
 *
 * 放在模块级而不是组件里：切走再回来组件会重挂载，用户的收起动作不能因此
 * 被忘掉、又把卡片弹开。
 */
const collapsedByTask = new Map<string, boolean>();

function clip(value: string, limit = 26): string {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function stepIcon(step: AgentPlanStep, taskEnded: boolean) {
  if (taskEnded && (step.state === "running" || step.state === "verifying" || step.state === "waiting")) {
    return <span className="size-1.5 rounded-full bg-warning" />;
  }
  switch (step.state) {
    case "done":
      return <Check size={12} className="text-success" />;
    case "running":
    case "verifying":
      return <Loader2 size={12} className="animate-spin text-accent" />;
    case "waiting":
      return <span className="size-1.5 rounded-full bg-warning" />;
    case "failed":
      return <XCircle size={12} className="text-danger" />;
    case "skipped":
      return <Minus size={12} className="text-fg-subtle" />;
    default:
      return <span className="size-1.5 rounded-full bg-fg-subtle/40" />;
  }
}

/** 当前需要关注的步骤：运行 / 验证 / 等确认 > 失败 > 第一条未完成。 */
function currentStep(plan: AgentPlan): AgentPlanStep | undefined {
  return (
    plan.steps.find((step) => step.state === "running") ??
    plan.steps.find((step) => step.state === "verifying") ??
    plan.steps.find((step) => step.state === "waiting") ??
    plan.steps.find((step) => step.state === "failed") ??
    plan.steps.find((step) => step.state !== "done" && step.state !== "skipped")
  );
}

export function PlanCard({
  taskId,
  plan: rawPlan,
  taskStatus,
  onFocusStep,
}: {
  taskId: string;
  plan: AgentPlan;
  taskStatus?: TaskStatus;
  onFocusStep: (planStepId: string) => void;
}) {
  const { t } = useTranslation();
  /*
   * 修订后的计划只把**当前有效步骤**计入进度；被替换掉的历史步骤单独列出，
   * 既不假装没发生过，也不再拖累 "done/total"。
   */
  const plan = useMemo(() => ({ ...rawPlan, steps: rawPlan.steps.filter((step) => !step.superseded) }), [rawPlan]);
  const historySteps = useMemo(() => rawPlan.steps.filter((step) => step.superseded), [rawPlan]);
  const narrow = useNarrow();
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const planMode = useExtremeSettingsStore((state) => state.planCard);
  const planModeRef = useRef(planMode);
  planModeRef.current = planMode;
  // 首帧就按当前窗口宽度 / 用户默认 / 这个会话上次的收起状态渲染，避免闪一下。
  const [collapsed, setCollapsed] = useState(
    () => collapsedByTask.get(taskId) ?? (narrow || planMode === "collapsed"),
  );

  useEffect(() => {
    if (!taskId) return;
    const known = collapsedByTask.get(taskId);
    if (known !== undefined) {
      setCollapsed(known);
      return;
    }
    // 第一次看到这条计划：窄窗口或“默认收起”直接收成按钮，否则轻量展开一次。
    const initial = narrowRef.current || planModeRef.current === "collapsed";
    collapsedByTask.set(taskId, initial);
    setCollapsed(initial);
  }, [taskId]);

  const done = plan.steps.filter((step) => step.state === "done").length;
  const total = plan.steps.length;
  const current = currentStep(plan);
  const taskEnded = taskStatus ? isTerminal(taskStatus) : true;
  const statusUnknown = !taskStatus;
  const skipped = plan.steps.filter((step) => step.state === "skipped").length;
  // 终态不再显示运行动画；证据不足的步骤保留原状态，提示用户核对。
  const selected = !taskEnded && current && (current.state === "running" || current.state === "verifying" || current.state === "waiting")
    ? current.id
    : "";
  const items = useMemo<BranchedMenuItem[]>(
    () => [
      {
        label: t("步骤 {{n}}", { n: total }),
        children: [
          ...plan.steps.map((step) => ({
            value: step.id,
            label: clip(step.title || step.action || step.id),
            icon: stepIcon(step, taskEnded),
          })),
          // 修订时被替换的步骤：保留可追溯，但不参与计数。
          ...historySteps.map((step) => ({
            value: step.id,
            label: t("历史 · {{title}}", { title: clip(step.title || step.action || step.id) }),
            icon: <Minus size={12} className="text-fg-subtle" />,
          })),
        ],
      },
    ],
    [historySteps, plan.steps, t, total, taskEnded],
  );

  const setCollapsedPersisted = (value: boolean) => {
    setCollapsed(value);
    collapsedByTask.set(taskId, value);
  };

  // 空计划没有可展示的步骤（正常路径后端会拒绝空计划）。
  if (total === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        className="extreme-core-plan-toggle"
        aria-expanded={false}
        onClick={() => setCollapsedPersisted(false)}
      >
        <ListTodo size={13} />
        <span>{t("计划")}</span>
        <span className="extreme-core-plan-count">
          {done}/{total}
        </span>
      </button>
    );
  }

  return (
    <section className="extreme-core-plan-card" aria-label={t("执行计划")}>
      <div>
        <header className="extreme-core-plan-head">
          <div className="flex min-w-0 items-center gap-1.5">
            <ListTodo size={13} className="shrink-0 text-accent" />
            <span className="extreme-core-plan-title truncate text-11 font-medium">{t("执行计划")}</span>
            <span className="extreme-core-plan-count">
              {done}/{total}
            </span>
            {plan.revision > 1 && (
              <span className="shrink-0 text-10 text-fg-subtle">
                {t("第 {{n}} 版", { n: plan.revision })}
              </span>
            )}
          </div>
          <button
            type="button"
            className="extreme-core-plan-collapse"
            aria-label={t("收起计划")}
            onClick={() => setCollapsedPersisted(true)}
          >
            <ChevronUp size={13} />
          </button>
        </header>

        <div className="mx-4 mt-1 h-1 overflow-hidden rounded-full bg-surface-3/80" aria-hidden="true">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }}
          />
        </div>

        <p className="extreme-core-plan-current" title={current?.title || plan.summary}>
          {current
            ? statusUnknown
              ? t("任务状态待核对")
              : taskEnded ? t("任务已结束，部分步骤状态待核对") : current.title
            : skipped > 0 ? t("已结束，{{count}} 步未执行", { count: skipped }) : t("已全部完成")}
        </p>

        <div className="extreme-core-plan-scroll">
          <BranchedMenu
            items={items}
            defaultOpen={0}
            active={selected}
            onSelect={(value) => onFocusStep(value)}
            color="var(--plan-ink)"
            accentColor={EC.accent}
            lineColor="var(--plan-line)"
            width={260}
            rowHeight={27}
            indent={28}
            trunk={10}
            radius={7}
            lineWidth={1.25}
            fontSize={11}
            drawDuration={360}
            foldDuration={260}
            className={cn(narrow && "extreme-core-plan-tree")}
          />
        </div>

        {plan.prerequisites.length > 0 && (
          <div className="extreme-core-plan-notes">
            <p className="extreme-core-plan-note-title text-10 font-medium">{t("需要确认的前提")}</p>
            <ul className="mt-0.5 space-y-0.5">
              {plan.prerequisites.map((item) => (
                <li key={item} className="extreme-core-plan-note text-10 leading-4">
                  · {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        {plan.summary && (
          <p className="extreme-core-plan-foot" title={plan.summary}>
            {plan.summary}
          </p>
        )}
      </div>

      <span className="sr-only" aria-live="polite">
        {t("已完成 {{done}} / {{total}} 步", { done, total })}
      </span>
    </section>
  );
}
