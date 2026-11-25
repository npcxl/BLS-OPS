/**
 * 传输中心：**不打断文件浏览**的紧凑面板（停靠在文件面板底部）。
 *
 * 与旧版模态框的区别：
 * - 不做遮罩、不抢占焦点：打开面板后照样能双击目录、拖拽上传；
 * - 默认只看当前服务器，可切到全部（跨服务器时每行标出服务器名）；
 * - 运行中 / 排队在前，已结束默认折叠，避免历史记录把活动任务挤下去；
 * - 大批次先给一条摘要（`已完成 8 / 12`），展开才看单个文件。
 *
 * 所有状态来自 `useTransferStore`：面板关掉任务照跑，重新打开时先拿全量
 * 快照校对，再按 `(attempt, revision)` 丢弃迟到的旧数据。
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpDown, ChevronDown, Loader2, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import type { TransferTask } from "@/api/ops-api";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session-store";
import {
  isActiveState,
  useTransferStore,
  useTransferSync,
  type TransferScope,
} from "@/stores/transfer-store";
import { TransferBatchRow, TransferTaskRow } from "./TransferTaskRow";

/** 达到这个数量才折叠成批次摘要；两三个文件直接列更好读。 */
export const BATCH_THRESHOLD = 4;

export type TransferEntry =
  | { kind: "task"; task: TransferTask }
  | { kind: "batch"; id: string; tasks: TransferTask[] };

/** 活动任务的展示优先级：正在写的 > 收尾 > 取消中 > 排队。 */
function activeRank(task: TransferTask): number {
  switch (task.state) {
    case "running":
      return 0;
    case "finalizing":
      return 1;
    case "cancelling":
      return 2;
    default:
      return 3;
  }
}

/** 运行中 / 排队在前（同一档按入队顺序），已结束在后（最近结束的在前）。 */
export function sortTransferTasks(tasks: TransferTask[]): TransferTask[] {
  return [...tasks].sort((a, b) => {
    const aActive = isActiveState(a.state);
    const bActive = isActiveState(b.state);
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive) {
      const rank = activeRank(a) - activeRank(b);
      return rank !== 0 ? rank : a.created_at - b.created_at;
    }
    return b.updated_at - a.updated_at;
  });
}

/**
 * 按 `batch_id` 折叠：同一批次达到 [`BATCH_THRESHOLD`] 才变成摘要，
 * 否则逐个列出来（一条上传两个文件不需要"批次"这一层）。
 */
export function groupTransferEntries(tasks: TransferTask[]): TransferEntry[] {
  const sorted = sortTransferTasks(tasks);
  const batches = new Map<string, TransferTask[]>();
  for (const task of sorted) {
    const key = task.batch_id || task.id;
    const group = batches.get(key);
    if (group) group.push(task);
    else batches.set(key, [task]);
  }

  const entries: TransferEntry[] = [];
  const emitted = new Set<string>();
  for (const task of sorted) {
    const key = task.batch_id || task.id;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const group = batches.get(key) ?? [task];
    if (group.length >= BATCH_THRESHOLD) {
      entries.push({ kind: "batch", id: key, tasks: group });
    } else {
      for (const item of group) entries.push({ kind: "task", task: item });
    }
  }
  return entries;
}

export function TransferCenterPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useTransferSync();

  const tasks = useTransferStore((state) => state.tasks);
  const samples = useTransferStore((state) => state.samples);
  const pending = useTransferStore((state) => state.pending);
  const cancelRequested = useTransferStore((state) => state.cancelRequested);
  const actionErrors = useTransferStore((state) => state.actionErrors);
  const loaded = useTransferStore((state) => state.loaded);
  const loading = useTransferStore((state) => state.loading);
  const error = useTransferStore((state) => state.error);
  const refresh = useTransferStore((state) => state.refresh);
  const cancel = useTransferStore((state) => state.cancel);
  const retry = useTransferStore((state) => state.retry);
  const clearFinished = useTransferStore((state) => state.clearFinished);
  const sessions = useSessionStore((state) => state.sessions);

  /** 每次打开都从「当前服务器」开始：别的服务器上的任务要用户主动切过去看。 */
  const [scope, setScope] = useState<TransferScope>("session");
  const [showFinished, setShowFinished] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, true>>({});
  const [confirmClear, setConfirmClear] = useState(false);

  const serverName = useCallback(
    (id: string) => sessions[id]?.title ?? null,
    [sessions],
  );
  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      if (current[id]) {
        const next = { ...current };
        delete next[id];
        return next;
      }
      return { ...current, [id]: true };
    });
  }, []);

  const { active, finished, total } = useMemo(() => {
    const visible = Object.values(tasks).filter(
      (task) => scope === "all" || task.session_id === sessionId,
    );
    return {
      active: visible.filter((task) => isActiveState(task.state)),
      finished: visible.filter((task) => !isActiveState(task.state)),
      total: visible.length,
    };
  }, [tasks, scope, sessionId]);

  const activeEntries = useMemo(() => groupTransferEntries(active), [active]);
  const finishedEntries = useMemo(() => groupTransferEntries(finished), [finished]);
  const showServer = scope === "all";
  const empty = loaded && total === 0;

  const renderEntry = (entry: TransferEntry) => {
    if (entry.kind === "batch") {
      const id = `batch:${entry.id}`;
      return (
        <TransferBatchRow
          key={id}
          tasks={entry.tasks}
          samples={samples}
          server={showServer ? serverName(entry.tasks[0]?.session_id ?? "") : null}
          expanded={Boolean(expanded[id])}
          onToggle={() => toggle(id)}
        />
      );
    }
    const { task } = entry;
    return (
      <TransferTaskRow
        key={task.id}
        task={task}
        sample={samples[task.id]}
        server={showServer ? serverName(task.session_id) : null}
        busy={Boolean(pending[task.id])}
        cancelRequested={Boolean(cancelRequested[task.id])}
        actionError={actionErrors[task.id]}
        expanded={Boolean(expanded[task.id])}
        onToggle={() => toggle(task.id)}
        onCancel={() => void cancel(task.id)}
        onRetry={() => void retry(task.id)}
      />
    );
  };

  return (
    <section
      aria-label={t("Transfers")}
      className="flex max-h-[46%] min-h-[132px] shrink-0 flex-col border-t border-line bg-surface-1"
    >
      <header className="flex h-8 shrink-0 items-center gap-1.5 px-2">
        <ArrowUpDown size={12} className="shrink-0 text-fg-muted" />
        <span className="shrink-0 text-11 font-medium text-fg">{t("Transfers")}</span>
        <span className="shrink-0 text-10 text-fg-subtle">
          {active.length > 0 ? t("{{count}} active", { count: active.length }) : t("Idle")}
        </span>
        {loading && <Loader2 size={10} className="shrink-0 animate-spin text-fg-subtle" />}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <div
            role="tablist"
            aria-label={t("Transfer scope")}
            className="flex items-center rounded-[5px] bg-surface-2 p-0.5 text-10"
          >
            {(
              [
                ["session", t("This server")],
                ["all", t("All servers")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={scope === value}
                onClick={() => setScope(value)}
                className={cn(
                  "rounded-[4px] px-1.5 py-0.5 transition-colors",
                  scope === value
                    ? "bg-surface-1 text-fg shadow-sm"
                    : "text-fg-subtle hover:text-fg",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label={t("Close")}
            title={t("Close")}
            onClick={onClose}
            className="rounded-[4px] p-0.5 text-fg-subtle hover:bg-surface-hover hover:text-fg"
          >
            <X size={12} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {/* 加载失败：保留已显示的任务，只在上方给出可重试的错误条。 */}
        {error ? (
          <ErrorState
            compact
            error={error}
            title={t("Could not load transfers")}
            onRetry={() => void refresh()}
            className="px-2 py-2"
          />
        ) : null}

        {!loaded && loading && (
          <div className="flex items-center gap-2 px-3 py-3 text-11 text-fg-subtle">
            <Loader2 size={12} className="animate-spin" />
            {t("Reading…")}
          </div>
        )}

        {empty && (
          <p className="px-3 py-3 text-11 text-fg-subtle">{t("No transfers yet.")}</p>
        )}

        {/* 轻分隔：不用卡片边框，靠行间距与 1px 分隔线分组。 */}
        <div className="divide-y divide-line/40">{activeEntries.map(renderEntry)}</div>

        {finished.length > 0 && (
          <button
            type="button"
            aria-expanded={showFinished}
            onClick={() => setShowFinished((value) => !value)}
            className={cn(
              "flex w-full items-center gap-1 px-2 py-1 text-10 text-fg-subtle hover:text-fg",
              active.length > 0 && "mt-1 border-t border-line/70",
            )}
          >
            <ChevronDown
              size={10}
              className={cn("transition-transform", !showFinished && "-rotate-90")}
            />
            {t("Finished transfers")}
            <span className="tabular-nums">· {finished.length}</span>
          </button>
        )}

        {showFinished && (
          <div className="divide-y divide-line/40">{finishedEntries.map(renderEntry)}</div>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-1 border-t border-line px-2 py-1">
        <span className="text-10 text-fg-subtle">{t("{{count}} items", { count: total })}</span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={finished.length === 0 || Boolean(pending.clear)}
          onClick={() => setConfirmClear(true)}
        >
          {t("Clear finished")}
        </Button>
      </footer>

      <ConfirmDialog
        open={confirmClear}
        title={t("Clear finished transfers?")}
        description={t(
          "Finished records are removed from this list. Files already transferred stay where they are.",
        )}
        consequences={[t("{{count}} records will be cleared", { count: finished.length })]}
        confirmLabel={t("Clear finished")}
        pending={Boolean(pending.clear)}
        onConfirm={() => {
          void clearFinished().then(() => setConfirmClear(false));
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </section>
  );
}
