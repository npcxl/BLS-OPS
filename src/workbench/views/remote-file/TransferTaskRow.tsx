/**
 * 传输中心的两行式任务行 / 批次摘要。
 *
 * 视觉契约（与远程文件列表保持同一套背景、字体与 hover）：
 * - 不要独立卡片边框，行与行之间只用轻分隔；
 * - 第一行：方向图标 + 文件名 + **一个**状态 + **一个**当前可用操作；
 * - 第二行：进度、已传 / 总大小、可用的实时速度；完整路径放 title 与展开区；
 * - 只有活动任务画进度条 —— 已结束的记录不该再动。
 */
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
} from "@/components/icons";
import type { TransferTask } from "@/api/ops-api";
import { cn } from "@/lib/cn";
import { formatSize, formatSpeed } from "@/lib/format";
import { isActiveState, isRetryableState, type TransferSample } from "@/stores/transfer-store";

export function directionIcon(kind: TransferTask["kind"], className?: string) {
  const Icon = kind === "upload" ? ArrowUpFromLine : ArrowDownToLine;
  return <Icon size={12} className={cn("shrink-0 text-fg-muted", className)} />;
}

export function stateLabel(t: TFunction, task: TransferTask): string {
  switch (task.state) {
    case "queued":
      return t("Queued");
    case "running":
      return t("Transferring");
    case "finalizing":
      return t("Finishing…");
    case "cancelling":
      return t("Cancelling…");
    case "completed":
      return t("Completed");
    case "skipped":
      return t("Skipped (already exists)");
    case "cancelled":
      return t("Cancelled");
    default:
      return t("Failed");
  }
}

function stateTone(task: TransferTask): string {
  switch (task.state) {
    case "completed":
      return "text-success";
    case "failed":
      return "text-danger";
    case "skipped":
      return "text-warning";
    case "cancelled":
    case "cancelling":
      return "text-fg-subtle";
    case "finalizing":
      return "text-fg-muted";
    default:
      return "text-accent";
  }
}

/** 进度百分比；`null` = 大小未知，画不定进度。 */
export function percentOf(task: TransferTask): number | null {
  if (task.state === "finalizing") return 100;
  if (!task.size_known) return null;
  if (task.total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((task.transferred / task.total) * 100)));
}

function sizeText(t: TFunction, task: TransferTask): string {
  if (!task.size_known) {
    return task.transferred > 0
      ? t("{{size}} transferred", { size: formatSize(task.transferred) })
      : t("Size unknown");
  }
  if (task.state === "queued" || task.state === "skipped") return formatSize(task.total);
  return `${formatSize(task.transferred)} / ${formatSize(task.total)}`;
}

/** 底部细进度条：活动任务 only。 */
export function TransferProgress({ task }: { task: TransferTask }) {
  const { t } = useTranslation();
  if (task.state === "queued") {
    // 排队中：还没开始，画一条空轨道就够，不要假装在动。
    return (
      <div
        role="progressbar"
        aria-label={t("Queued")}
        className="mt-1 h-[3px] overflow-hidden rounded-full bg-surface-2"
      />
    );
  }
  const percent = percentOf(task);
  const indeterminate = percent === null;
  const value = percent ?? 0;
  return (
    <div
      role="progressbar"
      aria-label={t("Transferring")}
      aria-valuemin={0}
      aria-valuemax={100}
      // 不确定进度不设 aria-valuenow —— 设了就等于谎称知道百分比。
      aria-valuenow={indeterminate ? undefined : value}
      className="mt-1 h-[3px] overflow-hidden rounded-full bg-surface-2"
    >
      {indeterminate ? (
        <div
          className={cn(
            "ops-connect-sweep h-full w-1/3 rounded-full",
            task.state === "cancelling" ? "bg-fg-subtle/50" : "bg-accent",
          )}
        />
      ) : (
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200",
            task.state === "failed"
              ? "bg-danger"
              : task.state === "cancelling"
                ? "bg-fg-subtle/50"
                : task.state === "completed"
                  ? "bg-success"
                  : "bg-accent",
            task.state === "finalizing" && "animate-pulse",
          )}
          style={{ width: `${value}%` }}
        />
      )}
    </div>
  );
}

export function TransferTaskRow({
  task,
  sample,
  server,
  busy,
  cancelRequested,
  actionError,
  expanded,
  onToggle,
  onCancel,
  onRetry,
}: {
  task: TransferTask;
  sample?: TransferSample;
  /** 跨服务器视图里显示服务器名；当前服务器视图传 null。 */
  server?: string | null;
  busy: boolean;
  /** 本地已点取消、后端还没回执：按钮立刻进入「正在取消」并禁止重复提交。 */
  cancelRequested: boolean;
  actionError?: unknown;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const active = isActiveState(task.state);
  const cancelling = task.state === "cancelling" || (cancelRequested && active);
  const retryable = isRetryableState(task.state);
  const speed =
    active && task.state === "running" && sample && sample.speed > 0
      ? formatSpeed(sample.speed)
      : null;
  const hasDetail = Boolean(task.error) || actionError !== undefined;

  return (
    <div className="group px-2 py-1.5 hover:bg-surface-hover/60">
      <div className="flex items-center gap-1.5">
        {directionIcon(task.kind)}
        <span className="min-w-0 flex-1 truncate text-11 text-fg" title={task.name}>
          {task.name}
        </span>
        {server && (
          <span className="max-w-[82px] shrink-0 truncate text-10 text-fg-subtle" title={server}>
            {server}
          </span>
        )}
        <span className={cn("shrink-0 text-10 tabular-nums", stateTone(task))}>
          {cancelling ? t("Cancelling…") : stateLabel(t, task)}
        </span>

        {/* 一个状态配一个动作：进行中能取消，失败/取消能重传，成功没有按钮。
            正在取消时按钮**直接消失**：状态文字已经说明，重复提交也没有第二个入口。 */}
        {active ? (
          cancelling ? null : (
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="shrink-0 rounded-[4px] px-1 py-0.5 text-10 text-fg-muted hover:bg-surface-active hover:text-fg disabled:cursor-default disabled:text-fg-subtle"
            >
              {t("Cancel")}
            </button>
          )
        ) : retryable ? (
          <button
            type="button"
            disabled={busy}
            onClick={onRetry}
            className={cn(
              "shrink-0 rounded-[4px] px-1 py-0.5 text-10",
              busy ? "cursor-default text-fg-subtle" : "text-accent hover:bg-accent/12",
            )}
          >
            {busy
              ? t("Retrying…")
              : task.kind === "upload"
                ? t("Upload again")
                : t("Download again")}
          </button>
        ) : null}

        {hasDetail && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={t("Details")}
            onClick={onToggle}
            className="shrink-0 rounded-[4px] p-0.5 text-fg-subtle hover:bg-surface-active hover:text-fg"
          >
            <ChevronDown
              size={10}
              className={cn("transition-transform", !expanded && "-rotate-90")}
            />
          </button>
        )}
      </div>

      {active && <TransferProgress task={task} />}

      <div className="mt-0.5 flex items-center gap-1.5 pl-[18px] text-10 text-fg-subtle">
        <span className="shrink-0 tabular-nums">{sizeText(t, task)}</span>
        {speed && <span className="shrink-0 tabular-nums">· {speed}</span>}
        <span className="ml-auto min-w-0 truncate font-mono opacity-70" title={task.target}>
          {task.target}
        </span>
      </div>

      {/* 失败原因默认收起：列表要紧凑，展开才看细节。 */}
      {expanded && (
        <div className="mt-1 space-y-0.5 border-t border-line/60 pt-1 pl-[18px] text-10">
          <p className="break-all font-mono text-fg-subtle">
            {task.source} → {task.target}
          </p>
          {task.error && <p className="break-words text-danger">{task.error}</p>}
          {actionError !== undefined && <ActionError cause={actionError} />}
        </div>
      )}

      {/* 操作失败必须在**这一行**说清楚：全局 toast 会飘走，用户找不到是哪一条。 */}
      {!expanded && actionError !== undefined && (
        <div className="mt-0.5 pl-[18px] text-10">
          <ActionError cause={actionError} />
        </div>
      )}
    </div>
  );
}

function ActionError({ cause }: { cause: unknown }) {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return (
    <p className="break-words leading-relaxed text-danger" role="alert">
      {message}
    </p>
  );
}

/**
 * 大批次摘要：`已完成 8 / 12`，点开才看单个文件。
 *
 * 只有同一批次的任务数量达到阈值才折叠 —— 两三个文件直接列出来更好读。
 */
export function TransferBatchRow({
  tasks,
  samples,
  server,
  expanded,
  onToggle,
}: {
  tasks: TransferTask[];
  samples: Record<string, TransferSample>;
  server?: string | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const total = tasks.length;
  const done = tasks.filter((task) => task.state === "completed").length;
  const failed = tasks.filter((task) => task.state === "failed").length;
  const active = tasks.filter((task) => isActiveState(task.state)).length;
  const transferred = tasks.reduce(
    (sum, task) => sum + (task.size_known ? task.transferred : 0),
    0,
  );
  const bytes = tasks.reduce((sum, task) => sum + (task.size_known ? task.total : 0), 0);
  const unknown = tasks.some((task) => !task.size_known);
  const percent =
    unknown || bytes <= 0 ? null : Math.min(100, Math.round((transferred / bytes) * 100));
  const first = tasks[0];
  const target = first?.target ?? "";
  const folder = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : target;
  const speed = tasks.reduce((sum, task) => sum + (samples[task.id]?.speed ?? 0), 0);

  return (
    <div className="hover:bg-surface-hover/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        <ChevronDown
          size={10}
          className={cn("shrink-0 text-fg-subtle transition-transform", !expanded && "-rotate-90")}
        />
        {directionIcon(first?.kind ?? "upload")}
        <span className="min-w-0 flex-1 truncate text-11 text-fg" title={folder}>
          {t("{{count}} files", { count: total })}
        </span>
        {server && (
          <span className="max-w-[82px] shrink-0 truncate text-10 text-fg-subtle" title={server}>
            {server}
          </span>
        )}
        <span className="shrink-0 text-10 tabular-nums text-fg-muted">
          {t("{{done}} of {{total}} done", { done, total })}
        </span>
        {failed > 0 && (
          <span className="shrink-0 text-10 tabular-nums text-danger">
            {t("{{count}} failed", { count: failed })}
          </span>
        )}
      </button>
      {active > 0 && (
        <div className="pb-1 pl-[30px] pr-2">
          <div
            role="progressbar"
            aria-label={t("Transferring")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-[3px] overflow-hidden rounded-full bg-surface-2"
          >
            {percent === null ? (
              <div className="ops-connect-sweep h-full w-1/3 rounded-full bg-accent" />
            ) : (
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-10 text-fg-subtle">
            <span className="tabular-nums">
              {percent === null
                ? t("{{size}} transferred", { size: formatSize(transferred) })
                : `${formatSize(transferred)} / ${formatSize(bytes)}`}
            </span>
            {speed > 0 && <span className="tabular-nums">· {formatSpeed(speed)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
