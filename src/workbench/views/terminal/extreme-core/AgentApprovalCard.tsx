import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import LiquidGlass from "liquid-glass-react";
import { ChevronDown, ChevronRight, Copy, FileDiff, ShieldAlert } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ExtremeIconButton } from "./ExtremeIconButton";
import { cn } from "@/lib/cn";
import { copyTextWithFeedback } from "@/lib/clipboard-feedback";
import type { AgentApproval } from "@/api/types/agent";

/**
 * 确认条的阶段。**只有 pending / failed 还需要用户表态**：
 * * `sending` —— 请求在路上，按钮先禁住，避免点两下；
 * * `allowed` —— 已允许，后续状态来自执行器（`stepState`）；
 * * `denied` —— 已拒绝，这一步不会执行。
 */
export type ApprovalPhase = "pending" | "sending" | "allowed" | "denied" | "failed";

/** 首屏摘要：后端给的一句话；老快照没带就退回命令首行。 */
function summaryOf(
  approval: AgentApproval,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const summary = approval.summary?.trim();
  if (summary) return summary;
  const first = approval.command.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (first) return first.length > 80 ? `${first.slice(0, 80)}…` : first;
  return approval.path
    ? t("修改 {{path}}", { path: approval.path })
    : t("需要你确认的写入操作");
}

/** 首屏影响：说清会发生什么；后端标了未知就照实说未知。 */
function impactOf(
  approval: AgentApproval,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const impact = approval.impact?.trim();
  if (impact) return impact;
  return t("影响未知：这一步会改动服务器上的内容，具体范围见详情。");
}

/**
 * 等待确认的剩余秒数。
 *
 * **以后端 deadline 为准**：重进恢复的确认卡可能只剩几秒，本地起算
 * 5 分钟会骗用户。旧后端 / 旧快照没有这个字段时，按"收到时刻 + 5min"
 * 兜底 —— 绝不显示 NaN。换了一条确认（callId 变了）兜底时刻跟着重置。
 */
function useRemainingSeconds(
  deadline: number | undefined,
  callId: string,
  active: boolean,
): number {
  const [fallback, setFallback] = useState(() => ({ callId, at: Date.now() }));
  if (fallback.callId !== callId) {
    setFallback({ callId, at: Date.now() });
  }
  const target =
    typeof deadline === "number" && Number.isFinite(deadline) && deadline > 0
      ? deadline
      : (fallback.callId === callId ? fallback.at : Date.now()) + 5 * 60 * 1000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return Math.max(0, Math.ceil((target - now) / 1000));
}

/**
 * Codex 式的**内联确认条**：贴在输入框上方，只占一条的高度。
 *
 * 首屏三样东西 —— 操作、服务器、真实影响；命令 / 路径 / 备份 / 回滚都在
 * 「查看命令与影响」里。允许之后原地变成「已允许 · 正在执行」，拒绝之后变成
 * 「已拒绝 · 此步骤未执行」，不跳走、不弹窗。
 */
/** 按操作类型给一条**可执行的验证建议**（计划预审的一部分）。 */
function verificationHint(approval: AgentApproval, t: (key: string) => string): string {
  const command = approval.command.toLowerCase();
  if (/nginx/.test(command) && /(conf|nginx\.conf|\/etc\/nginx)/.test(command)) {
    return t("建议：先 nginx -t 通过，再 reload 并确认站点返回 200");
  }
  if (/systemctl\s+(restart|start|stop)/.test(command)) {
    return t("建议：用 systemctl status 与端口 / 健康检查核对服务");
  }
  if (/docker\s+(compose|restart)/.test(command)) {
    return t("建议：用 docker ps 与容器健康状态核对");
  }
  if (approval.tool === "write_file") {
    return t("建议：重新读取文件核对内容，并检查引用它的服务");
  }
  return t("建议：执行后用只读命令核对结果（状态 / 端口 / 文件内容）");
}

export function AgentApprovalCard({
  approval,
  goal,
  phase,
  failure,
  stepState,
  onDecide,
  onOpenOutput,
  onOpenChanges,
}: {
  approval: AgentApproval;
  /** 这条任务的目标：预审时先看清"为什么要改这一处"。 */
  goal?: string | null;
  phase: ApprovalPhase;
  /** `phase === "failed"` 时的原因（请求没送达）。 */
  failure?: string | null;
  /** 执行器回报的这一步状态：`running` / `success` / `failed` / `skipped`。 */
  stepState?: string | null;
  onDecide: (allow: boolean) => void;
  /** 「查看输出」：跳到右侧面板里这条命令的位置。 */
  onOpenOutput?: () => void;
  /**
   * 「查看变更」：在右栏打开这条记录的真实 Diff。
   *
   * 只是**定位**到该任务 / 该批次 / 该文件，不产生第二张审批卡：
   * 允许 / 拒绝仍然只走这张卡上的按钮（taskId + callId）。
   */
  onOpenChanges?: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const danger = approval.risk === "danger";
  const pending = phase === "pending" || phase === "failed" || phase === "sending";
  const busy = phase === "sending";
  const remaining = useRemainingSeconds(approval.deadline, approval.callId, pending);

  const summary = summaryOf(approval, t);
  const impact = impactOf(approval, t);

  /** 允许之后的状态：执行器说什么就是什么。 */
  const runningLabel =
    stepState === "success"
      ? t("已允许 · 已完成")
      : stepState === "failed"
        ? t("已允许 · 执行失败")
        : stepState === "skipped"
          ? t("已允许 · 已跳过")
          : t("已允许 · 正在执行");

  /*
   * 已经表态之后**不再占一张卡**：收成一行操作记录。
   * 卡片只留给"还需要你决定"（pending / sending / failed）的状态，
   * 否则一次写入会在输入框上方挂一整块玻璃卡，把对话挤没。
   */
  if (phase === "allowed" || phase === "denied") {
    const tone =
      phase === "denied"
        ? "text-fg-subtle"
        : stepState === "success"
          ? "text-success"
          : stepState === "failed"
            ? "text-danger"
            : "text-fg-muted";
    return (
      <section
        data-testid="agent-approval"
        data-approval-task={approval.taskId}
        data-approval-key={`${approval.taskId}:${approval.callId}`}
        data-phase={phase}
        className="shrink-0 px-4 pt-1.5"
      >
        <div className="mx-auto flex w-full max-w-3xl min-w-0 items-center gap-2 text-11">
          <span className={cn("shrink-0", tone)}>
            {phase === "denied" ? t("已拒绝 · 未执行") : runningLabel}
          </span>
          <span className="min-w-0 flex-1 truncate text-fg-muted" title={approval.command}>
            {summary}
          </span>
          {phase === "allowed" && onOpenOutput && (
            <button
              type="button"
              className="shrink-0 text-accent hover:underline"
              onClick={onOpenOutput}
            >
              {t("查看输出")}
            </button>
          )}
          {approval.changeId && onOpenChanges && (
            <button
              type="button"
              className="flex shrink-0 items-center gap-0.5 text-accent hover:underline"
              onClick={onOpenChanges}
            >
              <FileDiff size={12} />
              {t("查看变更")}
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="agent-approval"
      data-approval-task={approval.taskId}
      /* 精确定位到**这一条**审批：同一任务的多条审批也要能各自滚到位。 */
      data-approval-key={`${approval.taskId}:${approval.callId}`}
      data-phase={phase}
      className="shrink-0 px-4 pt-2"
    >
      <div className="glass-host mx-auto w-full max-w-3xl">
        <LiquidGlass
          className="w-full [&>.glass]:w-full [&>.glass>div]:w-full"
          cornerRadius={10}
          padding="0"
          elasticity={0.06}
          style={{ width: "100%" }}
        >
          {/* 文字颜色必须写在这一层：液体玻璃的内容层自带 `text-white`。 */}
          <div
            className={cn(
              "w-full overflow-hidden rounded-[10px] border bg-surface-1/78 text-fg",
              danger ? "border-danger/40" : "border-line/70",
            )}
          >
            <div className="px-3 pb-1.5 pt-2">
              <div className="flex items-center gap-2">
                <ShieldAlert
                  size={14}
                  className={cn("shrink-0", danger ? "text-danger" : "text-warning")}
                />
                <span className="min-w-0 flex-1 truncate text-12 font-medium">{summary}</span>
                {danger && (
                  <span className="shrink-0 rounded-full border border-danger/50 px-1.5 text-10 text-danger">
                    {t("危险")}
                  </span>
                )}
                {approval.server && (
                  <span className="shrink-0 text-10 text-fg-subtle">{approval.server}</span>
                )}
                {/* 倒计时：超时不是"这一步跳过"，是整个任务停止 —— 必须让用户看见。 */}
                {pending && (
                  <span
                    className={cn(
                      "shrink-0 text-10 tabular-nums",
                      remaining <= 60 ? "text-danger" : "text-fg-subtle",
                    )}
                    title={t("超时后任务将停止")}
                  >
                    {t("剩余 {{time}}", {
                      time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`,
                    })}
                  </span>
                )}
              </div>
              {/*
               * 影响**直接写在条上**：这是用户做决定唯一需要的信息，不该藏在
               * 折叠里；危险操作再用强调色写一遍。
               */}
              <p
                className={cn(
                  "mt-1 break-words pl-[22px] text-11",
                  danger ? "text-danger" : "text-fg-muted",
                )}
              >
                {impact}
              </p>
              {pending && goal?.trim() && (
                <p className="mt-0.5 break-words pl-[22px] text-11 text-fg-muted">
                  {t("目标")}：{goal}
                </p>
              )}
              {pending && (
                <p className="mt-0.5 break-words pl-[22px] text-10 text-fg-subtle">
                  {verificationHint(approval, t)}
                </p>
              )}
              {pending && approval.backupPath && (
                <p className="mt-0.5 break-all pl-[22px] font-mono text-10 text-fg-subtle">
                  {t("改动前备份")}：{approval.backupPath}
                </p>
              )}
              {phase === "failed" && (
                <p className="mt-1 pl-[22px] text-11 text-danger">
                  {t("没有送达服务器：{{reason}}。可以再试一次。", {
                    reason: failure?.trim() || t("连接中断"),
                  })}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 border-t border-line/60 px-3 py-1.5">
              <button
                type="button"
                aria-expanded={expanded}
                className="flex items-center gap-0.5 text-11 text-fg-muted hover:text-fg"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {t("查看命令与影响")}
              </button>

              {/* 真实 Diff 在右栏：这里只负责定位，不放第二个"允许"按钮。 */}
              {approval.changeId && onOpenChanges && (
                <button
                  type="button"
                  onClick={onOpenChanges}
                  className="flex items-center gap-0.5 text-11 text-accent hover:underline"
                >
                  <FileDiff size={12} />
                  {t("查看变更")}
                </button>
              )}

              <span className="flex-1" />

              {pending && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => onDecide(false)}
                  >
                    {t("拒绝执行")}
                  </Button>
                  <Button
                    variant={danger ? "danger" : "primary"}
                    size="sm"
                    disabled={busy}
                    onClick={() => onDecide(true)}
                  >
                    {busy ? t("提交中…") : t("允许本次")}
                  </Button>
                </>
              )}
            </div>

            {expanded && (
              <div className="space-y-1.5 border-t border-line/60 px-3 py-2 text-11">
                {approval.path && (
                  <p className="break-all font-mono text-fg-muted">{approval.path}</p>
                )}
                <div className="flex items-start gap-1.5">
                  <pre className="max-h-40 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-surface-2 px-2 py-1 font-mono text-11">
                    {approval.command}
                  </pre>
                  <ExtremeIconButton
                    label={t("复制命令")}
                    icon={Copy}
                    iconSize={12}
                    className="size-6"
                    onClick={() => void copyTextWithFeedback(approval.command)}
                  />
                </div>
                {approval.backupPath && (
                  <p className="break-all text-fg-muted">
                    {t("备份")}：<span className="font-mono">{approval.backupPath}</span>
                  </p>
                )}
                {approval.rollback && (
                  <p className="break-all text-fg-muted">
                    {t("回滚")}：<span className="font-mono">{approval.rollback}</span>
                  </p>
                )}
                {approval.cwd && (
                  <p className="break-all text-fg-subtle">
                    {t("工作目录")}：<span className="font-mono">{approval.cwd}</span>
                  </p>
                )}
                {/* `cd` 包装与内部标记只给调试看，默认收起。 */}
                {approval.script && (
                  <details>
                    <summary className="cursor-pointer text-fg-subtle">
                      {t("实际执行脚本（调试）")}
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-surface-2 px-2 py-1 font-mono text-10 text-fg-muted">
                      {approval.script}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </div>
        </LiquidGlass>
      </div>
    </section>
  );
}
