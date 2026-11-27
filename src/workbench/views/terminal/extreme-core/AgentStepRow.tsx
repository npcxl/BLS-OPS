/**
 * 对话里的一行工具步骤（Codex 式：命令跟着正文走）。
 *
 * 收起时只有一行「操作名 · 状态 · 耗时」；展开才看命令、stdout / stderr 与
 * 退出码。失败的步骤**不展开也露出一行关键原因**，否则用户得点开每一行猜。
 *
 * 连续多条短命令由一个组承载（见 `AgentStepRun`）：只在**相邻**步骤之间合并，
 * 中间夹着正文就分开 —— 那说明模型在解释，不是一串机械执行。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStepTitle } from "./step-title-i18n";
import { useExtremeStore } from "@/stores/extreme-store";
import { useExtremeSettingsStore } from "@/stores/extreme-settings-store";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  FileText,
  Folder,
  Loader2,
  Plug,
  Terminal,
  TriangleAlert,
  XCircle,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { copyTextWithFeedback } from "@/lib/clipboard-feedback";
import ThoughtLine from "@/components/reactbits/ThoughtLine";
import { AgentApprovalCard } from "./AgentApprovalCard";
import { ExtremeIconButton } from "./ExtremeIconButton";
import type { DeployStep } from "./deploy-plan";
import { durationText } from "./format-time";
import type { MessageStepPart } from "./message-parts";
import type { ApprovalEntry } from "./view/types";

function firstLine(value: string | undefined): string {
  return (
    (value ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function clip(value: string, limit = 140): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** 这一行的实际状态（拒绝 = 未执行，优先于任务卡里的 failed）。 */
function rowState(
  step: DeployStep | undefined,
  part: MessageStepPart,
  approval: ApprovalEntry | undefined,
): string {
  if (part.denied || approval?.phase === "denied") return "skipped";
  if (approval && (approval.phase === "pending" || approval.phase === "sending" || approval.phase === "failed")) {
    return "waiting";
  }
  // 已允许、工具还没真正开始：先显示「已批准」；`tool_started` 到了再变运行中。
  if (approval?.phase === "allowed" && (!step || step.state === "waiting" || step.state === "pending")) {
    return "approved";
  }
  return step?.state ?? "pending";
}

/** 失败时那句话：stderr 首行 > stdout 首行 > 退出码。 */
function failureReason(step: DeployStep | undefined): string {
  if (!step || step.state !== "failed") return "";
  const reason = firstLine(step.stderr) || firstLine(step.stdout);
  if (reason) return clip(reason);
  if (step.exitCode != null) return `exit ${step.exitCode}`;
  return "";
}

/** 运行中步骤的实时计时（秒）：避免长命令看起来卡死。 */
function useLiveElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return undefined;
    }
    const began = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - began) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return elapsed;
}

function liveClock(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}:${String(secs).padStart(2, "0")}` : `${secs}s`;
}

/** 按工具类型给一枚轻图标，让读/列/写/命令/MCP 一眼可辨。 */
function ToolKindGlyph({ tool }: { tool?: string }) {
  if (!tool) return null;
  if (tool === "read_file") return <FileText size={11} className="shrink-0 text-fg-subtle" aria-hidden="true" />;
  if (tool === "list_dir") return <Folder size={11} className="shrink-0 text-fg-subtle" aria-hidden="true" />;
  if (tool === "write_file") return <FileDiff size={11} className="shrink-0 text-accent" aria-hidden="true" />;
  if (tool === "run_shell") return <Terminal size={11} className="shrink-0 text-fg-subtle" aria-hidden="true" />;
  if (tool.startsWith("mcp__")) return <Plug size={11} className="shrink-0 text-fg-subtle" aria-hidden="true" />;
  return null;
}

export function AgentStepRow({
  step,
  part,
  approval,
  goal,
  taskId,
  onDecide,
  onOpenOutput,
  onOpenChanges,
}: {
  step?: DeployStep;
  part: MessageStepPart;
  approval?: ApprovalEntry;
  goal?: string | null;
  /** 只有同一任务里的步骤才能被计划卡命中（两轮都叫 s1 时靠它区分）。 */
  taskId?: string;
  onDecide?: (allow: boolean) => void;
  onOpenOutput?: () => void;
  onOpenChanges?: () => void;
}) {
  const { t } = useTranslation();
  const defaultExpanded =
    useExtremeSettingsStore((state) => state.toolDetails) === "expanded";
  // 默认展开只决定**首次挂载**；当前对话里手动收起 / 展开优先。
  const [expanded, setExpanded] = useState(defaultExpanded);
  const state = rowState(step, part, approval);
  const running = state === "running";
  const waiting = state === "waiting";
  /*
   * 类别来自后端的结构化字段（旧记录没有 → 按真实执行保守展示）：
   * * `internal` 平台内部纠错：命令没执行，不是服务器失败；
   * * `denied`   权限 / 审批 / 安全边界拦下，或用户拒绝。
   */
  const internal = step?.category === "internal";
  const blocked = step?.category === "denied";
  const denied =
    (state === "skipped" && (Boolean(part.denied) || approval?.phase === "denied")) ||
    blocked;
  // 被平台拦下 / 内部纠错都不是红色"失败"。
  const failed = state === "failed" && !internal && !blocked;
  // `DeployStep.title` 已经是后端 summary / 命令首行算出来的操作名。
  const localize = useStepTitle();
  const title = localize(part.label?.trim() || step?.title || t("工具调用"));
  const liveSeconds = useLiveElapsed(running);
  const duration = running
    ? liveSeconds > 0
      ? liveClock(liveSeconds)
      : ""
    : !waiting && step?.elapsedMs
      ? durationText(step.elapsedMs, t)
      : "";
  // 只有真实执行失败才在收起状态露一行红色原因；内部纠错的原因留在展开详情里。
  const reason = !denied && !internal ? failureReason(step) : "";
  const canExpand = Boolean(
    step?.command || step?.script || step?.stdout || step?.stderr || step?.rollback || step?.backupPath,
  );
  const approvalPending = waiting && approval && onDecide;
  const canOpenDiff = Boolean(
    !approvalPending &&
      onOpenChanges &&
      step?.remotePath &&
      step.sourceTool === "write_file" &&
      step.state === "success",
  );
  /*
   * 状态文案。任务卡还没接回来（`step` 缺失）时不写「待执行」——
   * 那会让一条已经跑完的历史命令看起来像还没开始。
   */
  const statusText = running
    ? t("运行中")
    : internal
      ? // 内部纠错也是"没执行"：状态只说实话，为什么由展开里的说明负责。
        t("未执行")
      : state === "approved"
        ? t("已批准")
        : denied
          ? t("未执行")
          : waiting
            ? t("等待你的确认")
            : state === "success"
              ? step?.stale
                ? t("需重新核实")
                : t("已完成")
              : failed
                ? t("失败")
                : state === "skipped"
                  ? t("已跳过")
                  : step
                    ? t("待执行")
                    : "";

  return (
    <div
      className={cn(
        "extreme-core-step",
        running && "extreme-core-step-running",
        approvalPending && "extreme-core-step-with-approval",
      )}
      data-step-part={part.id}
      data-step-index={part.stepIndex}
      data-task-id={taskId ?? part.taskId ?? undefined}
      data-plan-step={part.planStepId}
      data-plan-group={part.groupId}
      data-state={state}
    >
      <button
        hidden={Boolean(approvalPending)}
        type="button"
        className="extreme-core-step-head"
        aria-expanded={canExpand ? expanded : undefined}
        onClick={() => canExpand && setExpanded((value) => !value)}
      >
        <span className="extreme-core-step-icon">
          {running ? (
            <Loader2 size={12} className="animate-spin" />
          ) : failed ? (
            <XCircle size={12} className="text-danger" />
          ) : denied || state === "skipped" ? (
            <span className="extreme-core-step-minus">–</span>
          ) : state === "success" ? (
            <Check size={12} className="text-success" />
          ) : waiting ? (
            <TriangleAlert size={12} className="text-warning" />
          ) : (
            <span className="extreme-core-step-dot" />
          )}
        </span>
        <ToolKindGlyph tool={step?.sourceTool} />
        {/*
         * 运行中用官方 ThoughtLine（呼吸 + 微光），结束后换回普通标题：
         * 快命令一结束就直接是结果，不会先亮一下再收。
         */}
        {running ? (
          <ThoughtLine
            label={title}
            working
            glyph="none"
            collapsible={false}
            fontSize={12}
            showTimer={false}
            className="extreme-core-step-thought"
          />
        ) : (
          <span className="extreme-core-step-title">{title}</span>
        )}
        {step?.server && step.sourceTool === "child_agent" && (
          <span className="extreme-core-step-status text-fg-subtle" title={t("子任务服务器")}>
            @{step.server}
          </span>
        )}
        {statusText && (
          <span
            className={cn(
              "extreme-core-step-status",
              failed && "text-danger",
              waiting && !denied && "text-warning",
              (denied || internal) && "text-fg-subtle",
            )}
          >
            {statusText}
          </span>
        )}
        {duration && <span className="extreme-core-step-duration">{duration}</span>}
        {canOpenDiff && (
          <span
            role="button"
            tabIndex={0}
            className="extreme-core-step-diff-link"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChanges?.();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onOpenChanges?.();
              }
            }}
          >
            <FileDiff size={11} />
            <span>{t("查看变更")}</span>
          </span>
        )}
        {canExpand && (
          <span className="extreme-core-step-chevron">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>

      {/* 失败不展开也给出关键原因：一行，够判断要不要点开。 */}
      {!approvalPending && reason && !expanded && <p className="extreme-core-step-reason">{reason}</p>}

      {approvalPending && (
        <div className="extreme-core-step-approval">
          <AgentApprovalCard
            approval={approval.approval}
            goal={goal}
            phase={approval.phase}
            failure={approval.failure}
            stepState={step?.state ?? null}
            onDecide={onDecide}
            onOpenChanges={onOpenChanges}
            onOpenOutput={onOpenOutput}
          />
        </div>
      )}

      {!approvalPending && expanded && (
        <div className="extreme-core-step-detail">
          {step?.detail && <p className="extreme-core-step-meta">{step.detail}</p>}
          {step?.risk && step.risk !== "read" && (
            <p className="extreme-core-step-meta">
              {t("风险")}：{step.risk === "danger" ? t("危险") : t("写入")}
            </p>
          )}
          {step?.command && (
            <div className="flex items-start gap-1">
              <pre className="extreme-core-step-code min-w-0 flex-1">{step.command}</pre>
              <ExtremeIconButton
                label={t("复制命令")}
                icon={Copy}
                iconSize={11}
                className="size-6 shrink-0"
                onClick={() => void copyTextWithFeedback(step.command!)}
              />
            </div>
          )}
          {step?.script && step.script !== step.command && (
            <details>
              <summary className="cursor-pointer select-none text-fg-subtle">
                {t("实际执行脚本（含 cd 包装与退出码）")}
              </summary>
              <pre className="extreme-core-step-code mt-1">{step.script}</pre>
            </details>
          )}
          {step?.exitCode != null && <p className="extreme-core-step-meta">exit {step.exitCode}</p>}
          {step?.childUsage && <p className="extreme-core-step-meta">{t("子任务累计用量（估算）：输入 {{input}}，输出 {{output}}", { input: step.childUsage.inputTokens.toLocaleString(), output: step.childUsage.outputTokens.toLocaleString() })}</p>}
          {step?.stale && (
            <p className="text-warning">
              {t("结果来自中断前，服务器状态可能已变化；使用前请重新核实。")}
            </p>
          )}
          {step?.stdout && (
            <div>
              <p className="extreme-core-step-meta">{t("输出")}</p>
              <pre className="extreme-core-step-code">{step.stdout}</pre>
            </div>
          )}
          {step?.stderr && (
            <div>
              <p className="extreme-core-step-meta">{t("错误输出")}</p>
              <pre className="extreme-core-step-code extreme-core-step-stderr">{step.stderr}</pre>
            </div>
          )}
          {step?.truncated && (
            <p className="text-warning">{t("输出过长，已截断（只保留前 8 MiB）")}</p>
          )}
          {step?.backupPath && (
            <p className="break-all">
              {t("备份")}：<code>{step.backupPath}</code>
            </p>
          )}
          {step?.rollback && (
            <p className="break-all text-warning">
              {t("回滚")} · <code>{step.rollback}</code>
            </p>
          )}
          {onOpenOutput && (
            <Button variant="ghost" size="xs" className="gap-1.5 rounded-full bg-surface-2 px-3 text-fg-muted hover:bg-surface-hover hover:text-fg" onClick={onOpenOutput}>
              <Terminal size={12} />
              {t("在右侧终端查看")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export interface AgentStepItem {
  part: MessageStepPart;
  step?: DeployStep;
  approval?: ApprovalEntry;
}

const ACTIVE = new Set(["running", "waiting", "approved"]);
const SETTLED = new Set(["success", "skipped", "failed"]);

/**
 * 一条命令或一组相邻命令。
 *
 * 组只在**全部落定**后折叠成一行；有步骤在跑 / 等确认时保持展开，当前那一步
 * 的转动才能被看见。组里的失败在折叠时也会露出一行原因。
 */
export function AgentStepRun({
  items,
  goal,
  taskId,
  forceOpen = false,
  onDecide,
  onOpenOutput,
  onOpenChanges,
}: {
  items: AgentStepItem[];
  goal?: string | null;
  /** 这一组命令属于哪次运行：计划卡定位时按它 + 步骤 id 精确匹配。 */
  taskId?: string;
  /** 定位期间强制展开折叠组，等目标节点挂载后再滚动。 */
  forceOpen?: boolean;
  /** 按**具体那一步**的审批表态：组里可能只有一条在等确认。 */
  onDecide?: (entry: ApprovalEntry, allow: boolean) => void;
  onOpenOutput?: () => void;
  onOpenChanges?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 计划卡定位：只展开**命中的那一组**（按 workspaceId + taskId + 计划步骤 id）。
  const reveal = useExtremeStore((state) => state.stepReveal);
  const currentWorkspace = useExtremeStore((state) => state.workspaceId);
  const revealHere = Boolean(
    reveal &&
      reveal.workspaceId === (currentWorkspace ?? "") &&
      reveal.taskId === (taskId ?? items[0]?.part.taskId ?? "") &&
      items.some((item) => item.part.planStepId === reveal.planStepId),
  );
  /*
   * 定位到折叠组里的命令后**保持展开**。
   *
   * 只靠 `revealHere` 的话，300ms 后 store 复位、组重新折叠，目标行直接
   * 消失 —— 视图被拉走，用户还得再点一次。展开状态留在组件里，定位结束
   * 也不回弹。
   */
  useEffect(() => {
    if (revealHere) setOpen(true);
  }, [revealHere]);
  if (items.length === 1) {
    const item = items[0];
    return (
      <AgentStepRow
        part={item.part}
        step={item.step}
        approval={item.approval}
        goal={goal}
        taskId={taskId}
        onDecide={
          item.approval && onDecide ? (allow) => onDecide(item.approval!, allow) : undefined
        }
        onOpenOutput={onOpenOutput}
        onOpenChanges={onOpenChanges}
      />
    );
  }

  const states = items.map((item) => rowState(item.step, item.part, item.approval));
  const active = states.some((state) => ACTIVE.has(state));
  const runningNow = states.includes("running");
  const waitingNow = states.includes("waiting");
  const approvedNow = states.includes("approved");
  const expanded = active || open || forceOpen || revealHere;
  // 内部纠错 / 被拦下的步骤不是红色失败；组标题也不该报「N 个失败」。
  const failed = items.filter(
    (item) =>
      rowState(item.step, item.part, item.approval) === "failed" &&
      item.step?.category !== "denied" &&
      item.step?.category !== "internal",
  );
  const succeeded = states.filter((state) => state === "success").length;
  const skipped = items.filter((item, index) => {
    const state = states[index];
    return state === "skipped" || (state === "failed" &&
      (item.step?.category === "denied" || item.step?.category === "internal"));
  }).length;
  const settled = states.every((state) => SETTLED.has(state));
  const totalMs = items.reduce((sum, item) => sum + (item.step?.elapsedMs ?? 0), 0);
  const duration = settled && totalMs > 0 ? durationText(totalMs, t) : "";
  const reason = !expanded && failed.length > 0 ? failureReason(failed[0].step) : "";
  const isChildGroup = items[0]?.part.groupId?.startsWith("children-") ?? false;
  /*
   * 子任务分组按**真实状态**计数：等待确认、运行中、失败、未执行、完成分开，
   * 不把"被依赖 / 断线拦下"算成失败，也不把聚合步骤算成一个子任务。
   */
  const childItems = items.filter((item) => item.step?.sourceTool === "child_agent");
  const childStates = childItems.map((item) => ({
    state: rowState(item.step, item.part, item.approval),
    blocked: Boolean(item.step?.blocked) || item.step?.category === "denied",
    stale: Boolean(item.step?.stale),
  }));
  const childTotal = childItems.length || Math.max(1, items.length - 1);
  const childWaiting = childStates.filter((item) => item.state === "waiting").length;
  const childQueued = childStates.filter(
    (item) => item.state === "pending" || item.state === "approved",
  ).length;
  const childRunning = childStates.filter((item) => item.state === "running").length;
  const childFailed = childStates.filter(
    (item) => item.state === "failed" && !item.blocked,
  ).length;
  const childSkipped = childStates.filter(
    (item) => item.state === "skipped" || (item.state === "failed" && item.blocked),
  ).length;
  const childSuccess = childStates.filter((item) => item.state === "success" && !item.stale).length;
  const childStale = childStates.filter((item) => item.stale).length;
  const staleSuffix = childStale > 0
    ? t(" · {{stale}} 个需重新核实", { stale: childStale })
    : "";
  const childBreakdown = [
    childWaiting > 0 ? t("{{count}} 个等待确认", { count: childWaiting }) : "",
    childQueued > 0 ? t("{{count}} 个待执行", { count: childQueued }) : "",
    childRunning > 0 ? t("{{count}} 个运行中", { count: childRunning }) : "",
    childFailed > 0 ? t("{{count}} 个失败", { count: childFailed }) : "",
    childSkipped > 0 ? t("{{count}} 个未执行", { count: childSkipped }) : "",
    childSuccess > 0 ? t("{{count}} 个完成", { count: childSuccess }) : "",
  ].filter(Boolean);
  const actionBreakdown = [
    succeeded > 0 ? t("{{count}} 个完成", { count: succeeded }) : "",
    failed.length > 0 ? t("{{count}} 个失败", { count: failed.length }) : "",
    skipped > 0 ? t("{{count}} 个未执行", { count: skipped }) : "",
  ].filter(Boolean);
  const label = isChildGroup
    ? t("{{n}} 个子任务", { n: childTotal }) +
      (childBreakdown.length > 0 ? ` · ${childBreakdown.join(" · ")}` : "") +
      staleSuffix
    : runningNow
    ? t("正在执行 {{n}} 个操作", { n: items.length })
    : waitingNow
      ? t("{{n}} 个操作 · 等待你的确认", { n: items.length })
      : approvedNow
        ? t("{{n}} 个操作 · 已批准，等待执行", { n: items.length })
        : settled && succeeded === items.length
          ? t("{{n}} 个操作 · 已完成", { n: items.length })
          : t("{{n}} 个操作", { n: items.length }) +
            (actionBreakdown.length > 0 ? ` · ${actionBreakdown.join(" · ")}` : "");
  const hasFailures = isChildGroup ? childFailed > 0 : failed.length > 0;
  const allSucceeded = isChildGroup ? childSuccess === childTotal : succeeded === items.length;

  return (
    <div
      className="extreme-core-step-group"
      data-step-group={items.length}
      data-state={active ? "running" : "settled"}
      data-task-id={taskId ?? items[0]?.part.taskId ?? undefined}
    >
      <button
        type="button"
        className="extreme-core-step-group-head"
        aria-expanded={expanded}
        // 计划卡定位：折叠时只能看到这一行，先点名它属于哪些计划步骤。
        data-plan-steps={items
          .map((item) => item.part.planStepId)
          .filter(Boolean)
          .join(" ")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="extreme-core-step-icon">
          {active ? (
            <Loader2 size={12} className="animate-spin" />
          ) : hasFailures ? (
            <XCircle size={12} className="text-danger" />
          ) : allSucceeded ? (
            <Check size={12} className="text-success" />
          ) : (
            <span className="extreme-core-step-minus">–</span>
          )}
        </span>
        <span className="extreme-core-step-title">{label}</span>
        {duration && <span className="extreme-core-step-duration">{duration}</span>}
        <span className="extreme-core-step-chevron">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {reason && <p className="extreme-core-step-reason">{reason}</p>}
      {expanded && (
        <div className="extreme-core-step-group-rows">
          {items.map((item) => (
            <AgentStepRow
              key={item.part.id}
              part={item.part}
              step={item.step}
              approval={item.approval}
              goal={goal}
              taskId={taskId}
              onDecide={
                item.approval && onDecide ? (allow) => onDecide(item.approval!, allow) : undefined
              }
              onOpenOutput={onOpenOutput}
              onOpenChanges={onOpenChanges}
            />
          ))}
        </div>
      )}
    </div>
  );
}
