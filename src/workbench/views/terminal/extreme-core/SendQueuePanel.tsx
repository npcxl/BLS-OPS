import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, ArrowUp, ChevronDown, Pencil, Trash2 } from "@/components/icons";
import { cn } from "@/lib/cn";
import type { QueuedSend } from "./send-queue";
import { ExtremeIconButton } from "./ExtremeIconButton";

/**
 * 输入框上方的排队消息卡（参考 Antigravity：独立圆角浮卡 + 简洁单行标题 + 右侧极简图标组）。
 *
 * 只在**当前对话**有排队项时出现，按入队顺序排列；一次只派发队首。
 * 中止当前任务后，队列 effect 会把下一条接着派发出去。
 */
export function SendQueuePanel({
  items,
  running = false,
  waitingLabel,
  onMoveUp,
  onEdit,
  onDrop,
  onRetry,
  onSteerNow,
}: {
  items: QueuedSend[];
  running?: boolean;
  /** 当前正在执行的任务摘要，展示在计数徽章右侧。 */
  waitingLabel?: string | null;
  onMoveUp: (id: string) => void;
  onEdit: (item: QueuedSend) => void;
  onDrop: (id: string) => void;
  onRetry: (id: string) => void;
  onSteerNow?: (item: QueuedSend) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  if (items.length === 0) return null;

  const hasError = items.some((item) => Boolean(item.error));
  const cleanWaiting = waitingLabel?.trim() || "";
  const statusText = hasError
    ? t("有消息发送失败，请重试")
    : running
      ? cleanWaiting
        ? t("等待当前任务：{{task}}", { task: cleanWaiting })
        : t("等待当前任务完成")
      : t("当前任务结束后按顺序发送");

  return (
    <div className="extreme-core-send-queue w-full shrink-0">
      <div
        className="extreme-core-queue-tray overflow-hidden rounded-2xl border border-line/65 bg-surface-1/95 backdrop-blur-md"
        data-testid="send-queue-panel"
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "flex w-full items-center gap-2 px-4 text-left transition-colors hover:bg-fg/[0.025]",
            open ? "pb-1.5 pt-3" : "py-2.5",
          )}
        >
          <span className="shrink-0 text-12 font-medium text-fg">{t("排队消息")}</span>
          <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-fg/[0.06] px-1.5 text-11 font-medium tabular-nums text-fg-muted">
            {items.length}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-12",
              hasError ? "text-danger" : "text-fg-subtle",
            )}
            title={statusText}
          >
            {statusText}
          </span>
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 text-fg-subtle transition-transform duration-150",
              !open && "-rotate-90",
            )}
          />
        </button>

        {open && (
          <ul className="max-h-48 space-y-0.5 overflow-y-auto px-2 pb-2.5 pt-0.5">
            {items.map((item, index) => (
              <li
                key={item.id}
                data-queue-id={item.id}
                className={cn(
                  "group/qitem flex min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 transition-colors",
                  item.error ? "bg-danger/[0.06] hover:bg-danger/10" : "hover:bg-fg/[0.035]",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="min-w-0 truncate text-[13.5px] leading-6 text-fg"
                      title={item.text}
                    >
                      {item.text}
                    </span>
                    {item.attachments.length > 0 && (
                      <span className="shrink-0 rounded-full border border-line/60 bg-surface-2 px-2 py-0.5 text-10 leading-none text-fg-muted">
                        {t("{{n}} 个附件", { n: item.attachments.length })}
                      </span>
                    )}
                  </span>
                  {item.error && (
                    <span className="mt-0.5 block truncate text-11 text-danger" title={item.error}>
                      {item.error}
                    </span>
                  )}
                </span>

                <div className="flex shrink-0 items-center gap-0.5">
                  {item.error && (
                    <button
                      type="button"
                      className="mr-1 rounded-full bg-accent/12 px-2.5 py-0.5 text-11 font-medium text-accent transition-colors hover:bg-accent/20"
                      onClick={() => onRetry(item.id)}
                    >
                      {t("Retry")}
                    </button>
                  )}
                  {items.length > 1 && index > 0 && (
                    <ExtremeIconButton
                      label={t("Move up")}
                      icon={ArrowUp}
                      iconSize={13}
                      className="size-7 opacity-0 transition-opacity group-hover/qitem:opacity-100 group-focus-within/qitem:opacity-100"
                      onClick={() => onMoveUp(item.id)}
                    />
                  )}
                  {running && !item.error && item.attachments.length === 0 && onSteerNow && (
                    <ExtremeIconButton
                      label={t("立即补充给当前任务")}
                      icon={ArrowRight}
                      iconSize={14}
                      className="size-7"
                      onClick={() => onSteerNow(item)}
                    />
                  )}
                  <ExtremeIconButton
                    label={t("Edit")}
                    icon={Pencil}
                    iconSize={13}
                    className="size-7"
                    onClick={() => onEdit(item)}
                  />
                  <ExtremeIconButton
                    label={t("Delete")}
                    icon={Trash2}
                    iconSize={13}
                    className="size-7"
                    danger
                    onClick={() => onDrop(item.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
