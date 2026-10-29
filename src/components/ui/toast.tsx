/**
 * 全局提示（toast / alert）。
 *
 * 按 tone 分两种形态：
 * - `error` → 屏幕**顶部居中**的 alert：默认常驻（点 × 才消失），长文本整段
 *   换行显示，带阶段标签与详情。错误缩在右下角一闪而过等于没提示 —— 用户
 *   那时往往正盯着左边的树或表单，根本不会往角落看。
 * - `info` / `success` → 右下角轻提示，几秒后自动消失。
 *
 * 任何地方 `pushToast("...", "error", { label: "auth", detail })` 即可，
 * 不需要往组件树里层层传 props。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, TriangleAlert, X } from "@/components/icons";
import { cn } from "@/lib/cn";

export type ToastTone = "info" | "success" | "error";

export interface ToastOptions {
  /** 第一行的小标题，例如「订单库 · 连接失败」。 */
  title?: string;
  /** 小标签，例如错误阶段（auth / tcp / tls / ssh_tunnel）。 */
  label?: string;
  /** 第二行详情：后端原始报错、主机端口等，完整换行不截断。 */
  detail?: string;
  /** `false` 表示自动消失（默认 error 常驻，其余自动消失）。 */
  persist?: boolean;
}

interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  title?: string;
  label?: string;
  detail?: string;
  persist: boolean;
}

/** 错误最多堆 3 条、轻提示 2 条：够看见，又不至于糊满屏幕。 */
const MAX_ERRORS = 3;
const MAX_NOTES = 2;
/** 错误默认常驻；临时性错误（扫描失败之类）显式 persist:false，给 8s。 */
const ERROR_TTL_MS = 8000;
const NOTE_TTL_MS = 3200;

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

/**
 * 弹一条提示。
 *
 * 同一标题 + 同一文案的常驻错误不会重复堆叠（用户连点几次「重试」失败时，
 * 屏幕上只留一条而不是一墙）。
 */
export function pushToast(
  message: string,
  tone: ToastTone = "info",
  options: ToastOptions = {},
): void {
  const persist = options.persist ?? tone === "error";
  if (
    persist &&
    items.some(
      (item) =>
        item.tone === tone &&
        item.message === message &&
        item.title === options.title,
    )
  ) {
    return;
  }

  const id = crypto.randomUUID();
  const item: ToastItem = {
    id,
    message,
    tone,
    title: options.title,
    label: options.label,
    detail: options.detail,
    persist,
  };
  items = [...items, item];
  // 分池裁剪：错误不会被轻提示挤掉，反之亦然。
  const errors = items.filter((entry) => entry.tone === "error").slice(-MAX_ERRORS);
  const notes = items.filter((entry) => entry.tone !== "error").slice(-MAX_NOTES);
  items = [...errors, ...notes];
  emit();
  if (!persist) {
    window.setTimeout(
      () => dismissToast(id),
      tone === "error" ? ERROR_TTL_MS : NOTE_TTL_MS,
    );
  }
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

  const errors = visible.filter((item) => item.tone === "error");
  const notes = visible.filter((item) => item.tone !== "error");

  return createPortal(
    <>
      {errors.length > 0 && (
        <div className="pointer-events-none fixed left-1/2 top-3 z-[130] flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-1.5">
          {errors.map((item) => (
            <div
              key={item.id}
              role="alert"
              className="pointer-events-auto flex items-start gap-2 rounded-[10px] border border-danger/40 bg-surface-1 px-3 py-2 text-12 shadow-lg shadow-black/25"
            >
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {item.label && (
                    <span className="shrink-0 rounded bg-danger/12 px-1 py-px text-10 font-medium text-danger">
                      {item.label}
                    </span>
                  )}
                  {item.title && (
                    <span className="min-w-0 truncate text-11 text-fg-muted">
                      {item.title}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 break-words leading-snug text-fg">
                  {item.message}
                </p>
                {item.detail && (
                  <p className="mt-1 break-words text-11 leading-relaxed text-fg-subtle">
                    {item.detail}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label="dismiss"
                className="shrink-0 rounded p-0.5 text-fg-subtle hover:bg-surface-hover hover:text-fg"
                onClick={() => dismissToast(item.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[130] flex w-[320px] flex-col gap-1.5">
          {notes.map((item) => (
            <div
              key={item.id}
              className={cn(
                "pointer-events-auto flex items-start gap-1.5 rounded-[8px] border px-2.5 py-2 text-11 shadow-lg shadow-black/20",
                item.tone === "success"
                  ? "border-success/40 bg-success/12 text-success"
                  : "border-line bg-surface-3 text-fg",
              )}
            >
              {item.tone === "success" && (
                <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 break-words leading-snug">
                {item.message}
              </span>
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
        </div>
      )}
    </>,
    document.body,
  );
}
