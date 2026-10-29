/**
 * 传输任务中心：上传 / 下载的排队、进度、取消与重试。
 *
 * 任务表在后端，面板关掉不会丢；这里每次打开都拉全量，之后再靠
 * `transfer-progress` 事件增量更新。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  Loader2,
  RotateCcw,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import {
  opsApi,
  toErrorMessage,
  TRANSFER_EVENT,
  type TransferTask,
} from "@/api/ops-api";

function stateTone(state: TransferTask["state"]): string {
  switch (state) {
    case "completed":
      return "text-success";
    case "failed":
      return "text-danger";
    case "skipped":
      return "text-warning";
    case "cancelled":
      return "text-fg-subtle";
    default:
      return "text-accent";
  }
}

export function TransferCenterDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TransferTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const upsert = useCallback((task: TransferTask) => {
    setTasks((current) => {
      const list = current ?? [];
      const index = list.findIndex((item) => item.id === task.id);
      const next =
        index >= 0
          ? [...list.slice(0, index), task, ...list.slice(index + 1)]
          : [task, ...list];
      return next.sort((a, b) => b.created_at - a.created_at);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    void opsApi
      .transferList()
      .then(setTasks)
      .catch((cause) => {
        setTasks([]);
        setError(toErrorMessage(cause));
      });
    // 事件里带的是完整任务，直接覆盖同 id 的那一行。
    const unlisten = listen<TransferTask>(TRANSFER_EVENT, (event) => upsert(event.payload));
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [open, upsert]);

  const cancel = async (task: TransferTask) => {
    setBusy(task.id);
    try {
      upsert(await opsApi.transferCancel(task.id));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const retry = async (task: TransferTask) => {
    setBusy(task.id);
    try {
      upsert(await opsApi.transferRetry(task.id));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const clearFinished = async () => {
    setBusy("clear");
    try {
      await opsApi.transferClearFinished();
      setTasks(await opsApi.transferList());
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const running = tasks?.some((task) => task.state === "running" || task.state === "queued");

  return (
    <Modal
      open={open}
      width={600}
      title={t("Transfers")}
      description={t("Closing this panel won't stop transfers.")}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto flex items-center gap-1.5 text-11 text-fg-subtle">
            {running && <Loader2 size={11} className="animate-spin" />}
            {t("{{count}} items", { count: tasks?.length ?? 0 })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null || !tasks?.length}
            onClick={() => void clearFinished()}
          >
            {t("Clear finished")}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("Close")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {error && <p className="text-11 text-danger">{error}</p>}
        {tasks === null && (
          <div className="flex items-center gap-2 py-6 text-11 text-fg-subtle">
            <Loader2 size={13} className="animate-spin" />
            {t("Reading…")}
          </div>
        )}
        {tasks !== null && tasks.length === 0 && (
          <p className="py-6 text-11 text-fg-subtle">{t("No transfers yet.")}</p>
        )}
        {tasks?.map((task) => {
          const percent =
            task.total > 0
              ? Math.min(100, Math.round((task.transferred / task.total) * 100))
              : 0;
          const active = task.state === "running" || task.state === "queued";
          return (
            <div key={task.id} className="rounded-[8px] border border-line px-3 py-2">
              <div className="flex items-center gap-2">
                {task.kind === "upload" ? (
                  <ArrowUpFromLine size={12} className="shrink-0 text-fg-subtle" />
                ) : (
                  <ArrowDownToLine size={12} className="shrink-0 text-fg-subtle" />
                )}
                <span className="min-w-0 flex-1 truncate text-11 text-fg" title={task.name}>
                  {task.name}
                </span>
                <span className={cn("shrink-0 text-10", stateTone(task.state))}>
                  {t(
                    task.state === "queued"
                      ? "Queued"
                      : task.state === "running"
                        ? "Transferring"
                        : task.state === "completed"
                          ? "Done"
                          : task.state === "skipped"
                            ? "Skipped (already exists)"
                            : task.state === "cancelled"
                              ? "Cancelled"
                              : "Failed",
                  )}
                </span>
                {active && (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy === task.id}
                    onClick={() => void cancel(task)}
                  >
                    <Ban size={11} />
                    {t("Cancel")}
                  </Button>
                )}
                {!active && (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy === task.id}
                    onClick={() => void retry(task)}
                  >
                    <RotateCcw size={11} />
                    {t("Retry")}
                  </Button>
                )}
              </div>

              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  className={cn(
                    "h-full transition-[width] duration-200",
                    task.state === "failed" ? "bg-danger" : "bg-accent",
                  )}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-10 text-fg-subtle">
                <span className="truncate font-mono" title={task.target}>
                  {task.target}
                </span>
                <span className="shrink-0 tabular-nums">
                  {task.total > 0
                    ? `${(task.transferred / 1024 / 1024).toFixed(1)} / ${(task.total / 1024 / 1024).toFixed(1)} MB`
                    : `${(task.transferred / 1024 / 1024).toFixed(1)} MB`}
                </span>
              </div>
              {task.error && (
                <p className="mt-1 text-10 leading-relaxed text-danger">{task.error}</p>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
