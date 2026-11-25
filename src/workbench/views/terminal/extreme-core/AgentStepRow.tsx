/**
 * 对话里的一行工具步骤（Codex 式：命令跟着正文走）。
 *
 * 收起时只有一行「操作名 · 状态 · 耗时」；展开才看命令、stdout / stderr 与
 * 退出码。失败的步骤**不展开也露出一行关键原因**，否则用户得点开每一行猜。
 *
 * 连续多条短命令由一个组承载（见 `AgentStepRun`）：只在**相邻**步骤之间合并，
 * 中间夹着正文就分开 —— 那说明模型在解释，不是一串机械执行。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtremeSettingsStore } from "@/stores/extreme-settings-store";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Terminal,
  TriangleAlert,
  XCircle,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import ThoughtLine from "@/components/reactbits/ThoughtLine";
import { AgentApprovalCard } from "./AgentApprovalCard";
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

export function AgentStepRow({
  step,
  part,
  approval,
  goal,
  onDecide,
  onOpenOutput,
  onOpenChanges,
}: {
  step?: DeployStep;
  part: MessageStepPart;
  approval?: ApprovalEntry;
  goal?: string | null;
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
  const denied = state === "skipped" && (Boolean(part.denied) || approval?.phase === "denied");
  const failed = state === "failed";
  // `DeployStep.title` 已经是后端 summary / 命令首行算出来的操作名。
  const title = part.label?.trim() || step?.title || t("工具调用");
  const duration = !running && !waiting && step?.elapsedMs ? durationText(step.elapsedMs, t) : "";
  const reason = !denied ? failureReason(step) : "";
  const canExpand = Boolean(
    step?.command || step?.script || step?.stdout || step?.stderr || step?.rollback || step?.backupPath,
  );
  const approvalPending = waiting && approval && onDecide;
  /*
   * 状态文案。任务卡还没接回来（`step` 缺失）时不写「待执行」——
   * 那会让一条已经跑完的历史命令看起来像还没开始。
   */
  const statusText = running
    ? t("运行中")
    : state === "approved"
      ? t("已批准")
      : denied
      ? t("未执行")
      : waiting
        ? t("等待你的确认")
        : state === "success"
          ? t("已完成")
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
        {statusText && (
          <span
            className={cn(
              "extreme-core-step-status",
              failed && "text-danger",
              waiting && !denied && "text-warning",
              denied && "text-fg-subtle",
            )}
          >
            {statusText}
          </span>
        )}
        {duration && <span className="extreme-core-step-duration">{duration}</span>}
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
            <pre className="extreme-core-step-code">{step.command}</pre>
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
            <Button variant="ghost" size="xs" className="gap-1 px-1 text-accent" onClick={onOpenOutput}>
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
  onDecide,
  onOpenOutput,
  onOpenChanges,
}: {
  items: AgentStepItem[];
  goal?: string | null;
  /** 按**具体那一步**的审批表态：组里可能只有一条在等确认。 */
  onDecide?: (entry: ApprovalEntry, allow: boolean) => void;
  onOpenOutput?: () => void;
  onOpenChanges?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (items.length === 1) {
    const item = items[0];
    return (
      <AgentStepRow
        part={item.part}
        step={item.step}
        approval={item.approval}
        goal={goal}
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
  const expanded = active || open;
  const failed = items.filter(
    (item) => rowState(item.step, item.part, item.approval) === "failed",
  );
  const denied = states.some((state) => state === "skipped");
  const settled = states.every((state) => SETTLED.has(state));
  const totalMs = items.reduce((sum, item) => sum + (item.step?.elapsedMs ?? 0), 0);
  const duration = settled && totalMs > 0 ? durationText(totalMs, t) : "";
  const reason = !expanded && failed.length > 0 ? failureReason(failed[0].step) : "";
  const label = runningNow
    ? t("正在执行 {{n}} 个操作", { n: items.length })
    : waitingNow
      ? t("{{n}} 个操作 · 等待你的确认", { n: items.length })
      : approvedNow
        ? t("{{n}} 个操作 · 已批准，等待执行", { n: items.length })
        : failed.length > 0
      ? t("{{n}} 个操作 · {{failed}} 个失败", { n: items.length, failed: failed.length })
      : denied
        ? t("{{n}} 个操作 · 未执行", { n: items.length })
        : settled
          ? t("{{n}} 个操作 · 已完成", { n: items.length })
          : t("{{n}} 个操作", { n: items.length });

  return (
    <div className="extreme-core-step-group" data-step-group={items.length} data-state={active ? "running" : "settled"}>
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
          ) : failed.length > 0 ? (
            <XCircle size={12} className="text-danger" />
          ) : (
            <Check size={12} className="text-success" />
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
