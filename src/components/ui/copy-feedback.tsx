import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";

/**
 * 复制反馈 —— 所有"点一下就复制"的结果视图共用这一份，**绝不各自写计时器**。
 *
 * - 成功：`复制成功`；失败：`复制失败，请检查剪贴板权限`（失败必须可见，
 *   不能看起来像成功了）；
 * - 连续复制时**重新计时**（不是叠加多个定时器）；
 * - 剪贴板写入统一走 `src/lib/clipboard.ts` 的 `copyText`。
 */

/** 提示停留时长（ms）。 */
export const COPY_NOTICE_MS = 1500;

export type CopyStatus = "idle" | "ok" | "error";

/** 模块级常量不能调 hook：这里存英文 key（natural keys），渲染处统一 t()。 */
export const COPY_NOTICE_TEXT: Record<Exclude<CopyStatus, "idle">, string> = {
  ok: "Copied",
  error: "Copy failed. Please check clipboard permission",
};

/**
 * 复制 + 提示状态。
 *
 * 返回 `copy(text)`（写剪贴板并提示）与 `notify(ok)`（已有自己的复制逻辑时
 * 只提示）。组件卸载时清掉定时器。
 */
export function useCopyFeedback(timeoutMs: number = COPY_NOTICE_MS) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const notify = useCallback(
    (ok: boolean) => {
      clearTimer(); // 连续复制 → 重新计时
      setStatus(ok ? "ok" : "error");
      timerRef.current = window.setTimeout(() => {
        setStatus("idle");
        timerRef.current = null;
      }, timeoutMs);
    },
    [clearTimer, timeoutMs],
  );

  const copy = useCallback(
    async (text: string) => {
      notify(await copyText(text));
    },
    [notify],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return { status, notify, copy };
}

/**
 * 结果面板底部的轻量提示。
 *
 * - 挂在**绝对定位**层（`pointer-events-none`）：不参与布局 → 既不会遮挡
 *   内容，也不会让面板尺寸跳动；
 * - 容器常驻 DOM + `aria-live="polite"`，内容变化才会被读屏播报。
 *
 * 父元素需要 `relative`（各结果视图的根容器都已加）。
 */
export function CopyNotice({ status, className }: { status: CopyStatus; className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      aria-live="polite"
      role="status"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center",
        className,
      )}
    >
      {status !== "idle" ? (
        <span
          data-testid="copy-notice"
          className={cn(
            "rounded-full border px-2.5 py-1 text-10 shadow-sm",
            status === "ok"
              ? "border-line bg-surface-3/95 text-fg"
              : "border-danger/40 bg-surface-1/95 text-danger",
          )}
        >
          {t(COPY_NOTICE_TEXT[status])}
        </span>
      ) : null}
    </div>
  );
}

/** 拖选超过这个距离（px）就认为是在选文字，不是"点一下"。 */
const DRAG_THRESHOLD_PX = 4;

/**
 * "点一下复制"的事件绑定 —— 三道闸，避免误触：
 *
 * 1. 拖选文字（移动超过阈值）→ 不复制；
 * 2. 当前存在选区（`window.getSelection()`）→ 不复制；
 * 3. 键盘 Enter / Space 触发的 click（没有 mousedown 坐标）→ 正常复制。
 */
export function clickCopyProps(onCopy: () => void) {
  let start: { x: number; y: number } | null = null;
  return {
    onMouseDown: (event: React.MouseEvent) => {
      start = { x: event.clientX, y: event.clientY };
    },
    onClick: (event: React.MouseEvent) => {
      const origin = start;
      start = null;
      // 用户是在选文字（拖选 / 已有选区）→ 让浏览器继续，不复制。
      if ((window.getSelection()?.toString() ?? "") !== "") return;
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > DRAG_THRESHOLD_PX) {
        return;
      }
      onCopy();
    },
  };
}

/** 可复制项的统一外观：copy 光标 + 轻微 hover 背景（键盘可聚焦）。 */
export const COPYABLE =
  "cursor-copy rounded-[3px] text-left transition-colors hover:bg-surface-2/70 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent";
