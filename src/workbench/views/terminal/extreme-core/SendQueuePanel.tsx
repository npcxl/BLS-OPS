import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, ChevronDown, ChevronRight, CornerDownLeft, ListTodo, Pencil, Trash2 } from "@/components/icons";
import type { QueuedSend } from "./send-queue";
import { ExtremeIconButton } from "./ExtremeIconButton";

/**
 * 输入框上方的发送队列（Codex 式：可排序、可编辑、可一键立即插队补充）。
 *
 * 只在**当前对话**有排队项时出现，按入队顺序排列；一次只派发队首。
 * 中止当前任务后，队列 effect 会把下一条接着派发出去。
 */
export function SendQueuePanel({
  items,
  running = false,
  onMoveUp,
  onEdit,
  onDrop,
  onRetry,
  onSteerNow,
}: {
  items: QueuedSend[];
  running?: boolean;
  onMoveUp: (id: string) => void;
  onEdit: (item: QueuedSend) => void;
  onDrop: (id: string) => void;
  onRetry: (id: string) => void;
  onSteerNow?: (item: QueuedSend) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  if (items.length === 0) return null;

  return (
    <div className="extreme-core-send-queue w-full shrink-0">
      <div
        className="overflow-hidden rounded-lg border border-line/70 bg-surface-1/95 shadow-sm"
        data-testid="send-queue-panel"
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex h-8 w-full items-center gap-1.5 px-2.5 text-left text-12 text-fg-muted transition-colors hover:bg-surface-hover"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <span className="font-medium">{t("Queue ({{n}})", { n: items.length })}</span>
          <span className="text-11 text-fg-subtle">{t("Sent in order")}</span>
        </button>

        {open && (
          <ul className="max-h-44 overflow-y-auto border-t border-line/60">
            {items.map((item, index) => (
              <li
                key={item.id}
                data-queue-id={item.id}
                className="flex min-w-0 items-center gap-2 border-b border-line/40 px-2.5 py-1.5 last:border-b-0 hover:bg-surface-hover/60"
              >
                <ListTodo size={12} className="shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate text-12 text-fg" title={item.text}>
                      {item.text}
                    </span>
                    {item.attachments.length > 0 && (
                      <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-10 text-fg-subtle">
                        {t("{{n}} 个附件", { n: item.attachments.length })}
                      </span>
                    )}
                  </span>
                  {item.error && (
                    <span className="block truncate text-10 text-danger" title={item.error}>
                      {item.error}
                    </span>
                  )}
                </span>

                {item.error && (
                  <button
                    type="button"
                    className="shrink-0 text-11 text-accent hover:underline"
                    onClick={() => onRetry(item.id)}
                  >
                    {t("Retry")}
                  </button>
                )}
                {running && !item.error && item.attachments.length === 0 && onSteerNow && (
                  <ExtremeIconButton
                    label={t("立即补充给当前任务")}
                    icon={CornerDownLeft}
                    iconSize={12}
                    className="size-6 text-accent"
                    onClick={() => onSteerNow(item)}
                  />
                )}
                <ExtremeIconButton
                  label={t("Move up")}
                  icon={ArrowUp}
                  iconSize={12}
                  className="size-6"
                  disabled={index === 0}
                  onClick={() => onMoveUp(item.id)}
                />
                <ExtremeIconButton
                  label={t("Edit")}
                  icon={Pencil}
                  iconSize={12}
                  className="size-6"
                  onClick={() => onEdit(item)}
                />
                <ExtremeIconButton
                  label={t("Delete")}
                  icon={Trash2}
                  iconSize={12}
                  className="size-6"
                  danger
                  onClick={() => onDrop(item.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
