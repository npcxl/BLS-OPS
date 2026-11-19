/**
 * 右栏外缘拖动：把主窗口右侧拉到鼠标位置，新增宽度全部给右栏。
 *
 * 关键约束：
 * * 每帧传的是**绝对目标宽度**（拖拽开始时的窗口宽度 + 位移），不是增量；
 * * 后端按当前显示器工作区夹紧，左边缘与高度不动；
 * * 中间帧用 rAF 合并，松手才把最终宽度落盘；
 * * 取消 / 窗口失焦时恢复拖拽前的窗口与右栏宽度。
 */
import type { PointerEvent as ReactPointerEvent } from "react";

import { opsApi } from "@/api/ops-api";

export interface PaneOuterDragOptions {
  /** 拖拽开始时的右栏可见宽度（通常是 `paneFit`）。 */
  basePaneWidth: number;
  /** 拖拽过程中 / 结束时更新右栏宽度；`persist` 为 true 时才落盘。 */
  onPaneWidth: (width: number, persist: boolean) => void;
  /** 拖动状态：浏览器原生子视图要在拖动期间临时隐藏。 */
  onDraggingChange: (dragging: boolean) => void;
  /** 正常松手：记下这次实际向外加了多少，供收起右栏时按需回收。 */
  onCommitted?: (info: { baseWindow: number; added: number }) => void;
  onError?: (cause: unknown) => void;
}

export function beginPaneOuterDrag(
  event: ReactPointerEvent<HTMLElement>,
  options: PaneOuterDragOptions,
): void {
  if (event.button !== 0) return;
  event.preventDefault();

  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const baseWindow = window.innerWidth;
  const basePane = options.basePaneWidth;

  let latest = 0;
  let frame: number | null = null;
  let inFlight = false;
  let queued = 0;
  let done = false;
  let reportedError = false;

  try {
    handle.setPointerCapture(pointerId);
  } catch {
    // 浏览器预览 / 测试环境没有 pointer capture：window 监听仍然能收到移动。
  }
  options.onDraggingChange(true);

  const reportError = (cause: unknown) => {
    if (reportedError) return;
    reportedError = true;
    options.onError?.(cause);
  };

  const apply = (target: number) => {
    if (done) return;
    if (inFlight) {
      queued = target;
      return;
    }
    inFlight = true;
    void opsApi
      .extremePanelResize(target)
      .then((outcome) => {
        inFlight = false;
        if (done) return;
        const added = outcome.widened ? Math.max(0, outcome.added) : 0;
        // 外扩成功：右栏拿新增宽度（聊天宽度不变）；没有空间 / 最大化：
        // 退化成窗口内分栏，按拖动位移增加右栏宽度。
        options.onPaneWidth(basePane + (added > 0 ? added : latest), false);
        if (queued && queued !== target) {
          const next = queued;
          queued = 0;
          apply(next);
        }
      })
      .catch((cause: unknown) => {
        inFlight = false;
        if (done) return;
        // 后端不可用（浏览器预览）也别让拖拽卡住：退回窗口内分栏。
        options.onPaneWidth(basePane + latest, false);
        reportError(cause);
      });
  };

  const schedule = () => {
    if (frame !== null || done) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      apply(baseWindow + latest);
    });
  };

  const move = (moveEvent: PointerEvent) => {
    if (done) return;
    latest = Math.max(0, moveEvent.clientX - startX);
    schedule();
  };

  const detach = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      // 已经释放 / 不支持 capture。
    }
  };

  const finish = () => {
    if (done) return;
    done = true;
    if (frame !== null) cancelAnimationFrame(frame);
    detach();
    options.onDraggingChange(false);
    // 最终落一次绝对目标：中间帧可能被 rAF 合并掉了。
    void opsApi
      .extremePanelResize(baseWindow + latest)
      .then((outcome) => {
        const added = outcome.widened ? Math.max(0, outcome.added) : 0;
        options.onPaneWidth(basePane + (added > 0 ? added : latest), true);
        options.onCommitted?.({ baseWindow, added });
      })
      .catch(() => options.onPaneWidth(basePane + latest, true));
  };

  const cancel = () => {
    if (done) return;
    done = true;
    if (frame !== null) cancelAnimationFrame(frame);
    detach();
    options.onDraggingChange(false);
    options.onPaneWidth(basePane, true);
    // 取消要连窗口一起还原；用户手动改过窗口也没关系，这是本次拖拽的起点。
    void opsApi.extremePanelResize(baseWindow, true).catch(() => undefined);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
}
