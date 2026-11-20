/**
 * 对话区的"跟随最新内容"。
 *
 * 为什么不用"距底多远"来判断：程序化写入 `scrollTop` 之后内容又长高，浏览器
 * 补发的 `scroll` 事件算出来的距离会大于容差 —— 自动跟随就被自己给关了，用户
 * 从此得一直手动往下拖。**距离不是意图**：只有用户自己滚动、拖拽或按键才应该
 * 关掉跟随；滚回底部再打开。
 *
 * 这里把这件事收成一处：真实输入 → 关闭跟随；`scroll` → 只在"用户已经回到
 * 底部"时重新打开；同一帧的多次贴底请求合并成一次写入。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** 用户自己滚到距底这么多像素以内，算"回到最新"（只在用户滚动时判定）。 */
const NEAR_BOTTOM = 24;

/**
 * 自动跟随的**最小内容增量**（px）。
 *
 * 流式输出时每个 token 都会让内容长高几像素，如果每帧都贴底，滚动条会一直
 * 高频抖动、阅读也晃。攒够这个高度再滚一次；停止增长后再补一次收尾。
 */
const FOLLOW_STEP = 28;

/** 内容停止增长后，最多等这么久把最后一段补齐（ms）。 */
const SETTLE_MS = 150;

const UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);

export interface ChatScroll {
  /** 挂到滚动容器上。 */
  ref: RefObject<HTMLDivElement | null>;
  /** 用户是否还想跟着最新内容（意图，不是距离）。 */
  stick: RefObject<boolean>;
  /** 下一帧贴底（同一帧多次调用只写一次）。 */
  follow: () => void;
  /** 还原到某个阅读位置：这次写入不算用户滚动，也顺带关掉跟随。 */
  restore: (top: number) => void;
  /** 当前是否在底部（滚到最下面按钮据此显隐）。 */
  atBottom: boolean;
  /** 用户点「滚到最下面」：恢复跟随并直接落到底。 */
  scrollToBottom: () => void;
}

export function useChatScroll(enabled: boolean): ChatScroll {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const previousTop = useRef(0);
  const frame = useRef<number | null>(null);
  /** 上一次真正贴底时的 scrollHeight：用来判断"又长高了多少"。 */
  const lastBottom = useRef(0);
  /** 内容增长不足一步时，等它停下来的收尾定时器。 */
  const settle = useRef<number | null>(null);
  /** 是否在底部：滚到最下面的按钮据此显隐。 */
  const [atBottom, setAtBottom] = useState(true);

  const syncAtBottom = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const next = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM;
    setAtBottom((previous) => (previous === next ? previous : next));
  }, []);

  const writeTop = useCallback((top: number) => {
    const node = ref.current;
    if (!node) return;
    const next = Math.max(0, Math.min(top, node.scrollHeight - node.clientHeight));
    if (Math.abs(node.scrollTop - next) >= 1) node.scrollTop = next;
    previousTop.current = node.scrollTop;
    syncAtBottom();
  }, [syncAtBottom]);

  /** 取消"攒够再贴底"的收尾定时器。 */
  const clearSettle = useCallback(() => {
    if (settle.current !== null) {
      window.clearTimeout(settle.current);
      settle.current = null;
    }
  }, []);

  const follow = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!stick.current) return;
      const node = ref.current;
      if (!node) return;
      const bottom = node.scrollHeight;
      const grew = bottom - lastBottom.current;
      /*
       * 小幅增长（流式 token）：先不滚，攒够 `FOLLOW_STEP` 再动；
       * 内容停下来后由 `SETTLE_MS` 的定时器补最后一次，保证最终确实在底部。
       */
      if (grew > 0 && grew < FOLLOW_STEP) {
        if (settle.current === null) {
          settle.current = window.setTimeout(() => {
            settle.current = null;
            if (!stick.current) return;
            const current = ref.current;
            if (!current) return;
            lastBottom.current = current.scrollHeight;
            writeTop(current.scrollHeight);
          }, SETTLE_MS);
        }
        return;
      }
      clearSettle();
      lastBottom.current = bottom;
      writeTop(bottom);
    });
  }, [clearSettle, writeTop]);

  const restore = useCallback(
    (top: number) => {
      stick.current = false;
      writeTop(top);
    },
    [writeTop],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const node = ref.current;
    if (!node) return undefined;
    previousTop.current = node.scrollTop;
    lastBottom.current = node.scrollHeight;
    syncAtBottom();
    clearSettle();

    /** 用户主动离开底部：立刻停止跟随（不等到下一次 `scroll`）。 */
    const release = () => {
      stick.current = false;
    };
    const onWheel = (event: WheelEvent) => {
      // 往上滚才是"我要看历史"；往下滚交给 `scroll` 判到没到底。
      if (event.deltaY < 0) release();
    };
    let touchY: number | undefined;
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const onTouchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (next !== undefined && touchY !== undefined && next > touchY) release();
      touchY = next;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === node && (UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey))) {
        release();
      }
    };
    /*
     * `scroll` 只做一件事：用户自己滚回底部时恢复跟随。
     * 代码写的那些位置（贴底、还原阅读位置）在这里被认出来并跳过。
     */
    const onScroll = () => {
      const movedUp = node.scrollTop < previousTop.current - 1;
      previousTop.current = node.scrollTop;
      const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (gap < NEAR_BOTTOM) stick.current = true;
      else if (movedUp) release();
      syncAtBottom();
    };

    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("scroll", onScroll, { passive: true });

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        if (stick.current) follow();
        syncAtBottom();
      });
      /*
       * 两个方向都要盯：
       * - 内容容器长高（流式正文、步骤、执行活动）；
       * - 滚动容器**自己**变矮 —— 确认卡挂在容器外，它出现时 `clientHeight`
       *   被挤小，浏览器既不补 `scroll` 事件，内容容器也没变高，底部就这样
       *   被顶出可视区。只有观察容器自身才能补上这一滚。
       */
      observer.observe(node);
      if (node.firstElementChild) observer.observe(node.firstElementChild);
    }

    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      clearSettle();
    };
  }, [clearSettle, enabled, follow, syncAtBottom]);

  const scrollToBottom = useCallback(() => {
    stick.current = true;
    const node = ref.current;
    if (!node) return;
    clearSettle();
    lastBottom.current = node.scrollHeight;
    writeTop(node.scrollHeight);
  }, [clearSettle, writeTop]);

  // 卸载：还没跑的那一帧取消掉，别往已经不在的容器里写。
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      clearSettle();
    },
    [clearSettle],
  );

  return { ref, stick, follow, restore, atBottom, scrollToBottom };
}
