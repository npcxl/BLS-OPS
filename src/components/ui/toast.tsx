/**
 * 全局轻提示（toast）。
 *
 * 数据库侧的复制、提交、导出、开窗失败这些结果，之前各视图各写 inline
 * notice：有的停在页面里不消失，有的干脆没有反馈。这里提供一个最小的
 * store + host：任何地方 `pushToast("已提交 3 行", "success")` 即可，
 * 不需要往组件树里层层传 props。
 *
 * 刻意做得很轻：不排队、不做动画队列，最多堆 3 条，到点自动消失。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, TriangleAlert, X } from "@/components/icons";
import { cn } from "@/lib/cn";

export type ToastTone = "info" | "success" | "error";

interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
}

const MAX_VISIBLE = 3;
let items: ToastItem[] = [];
const listeners = new Set<(next: ToastItem[]) => void>();

const emit = () => {
  const next = [...items];
  for (const listener of listeners) listener(next);
};

export function dismissToast(id: string): void {
  items = items.filter((item) => item.id !== id);
  emit();
}

/** 弹一条提示；`error` 停留更久，方便看清错误。 */
export function pushToast(message: string, tone: ToastTone = "info"): void {
  const id = crypto.randomUUID();
  items = [...items, { id, message, tone }].slice(-MAX_VISIBLE);
  emit();
  window.setTimeout(() => dismissToast(id), tone === "error" ? 6000 : 3200);
}

export function ToastHost() {
  const [visible, setVisible] = useState<ToastItem[]>(items);

  useEffect(() => {
    const listener = (next: ToastItem[]) => setVisible(next);
    listeners.add(listener);
    listener(items);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (visible.length === 0) return null;

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[130] flex w-[320px] flex-col gap-1.5">
      {visible.map((item) => (
        <div
          key={item.id}
          className={cn(
            "pointer-events-auto flex items-start gap-1.5 rounded-[8px] border px-2.5 py-2 text-11 shadow-lg shadow-black/20",
            item.tone === "error"
              ? "border-danger/40 bg-danger/12 text-danger"
              : item.tone === "success"
                ? "border-success/40 bg-success/12 text-success"
                : "border-line bg-surface-3 text-fg",
          )}
        >
          {item.tone === "error" ? (
            <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          ) : item.tone === "success" ? (
            <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
          ) : null}
          <span className="min-w-0 flex-1 break-words leading-snug">{item.message}</span>
          <button
            type="button"
            aria-label="dismiss"
            className="shrink-0 opacity-60 hover:opacity-100"
            onClick={() => dismissToast(item.id)}
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
