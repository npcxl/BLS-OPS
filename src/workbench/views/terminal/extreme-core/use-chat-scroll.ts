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
import { useCallback, useEffect, useRef, type RefObject } from "react";

/** 用户自己滚到距底这么多像素以内，算"回到最新"（只在用户滚动时判定）。 */
const NEAR_BOTTOM = 24;

/** 会让视图移动的按键：按下即视为用户接管。 */
const SCROLL_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  " ",
]);

export interface ChatScroll {
  /** 挂到滚动容器上。 */
  ref: RefObject<HTMLDivElement | null>;
  /** 用户是否还想跟着最新内容（意图，不是距离）。 */
  stick: RefObject<boolean>;
  /** 下一帧贴底（同一帧多次调用只写一次）。 */
  follow: () => void;
  /** 还原到某个阅读位置：这次写入不算用户滚动，也顺带关掉跟随。 */
  restore: (top: number) => void;
}

export function useChatScroll(enabled: boolean): ChatScroll {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** 这一次 `scrollTop` 是代码写的，不是用户滚的。 */
  const programmatic = useRef(false);
  const frame = useRef<number | null>(null);

  const writeTop = useCallback((top: number) => {
    const node = ref.current;
    if (!node || Math.abs(node.scrollTop - top) < 1) return;
    programmatic.current = true;
    node.scrollTo({ top });
    /*
     * 位置没变时不会有 `scroll` 事件（上面的判断已经挡掉），但浏览器也可能
     * 把事件排在下一帧：这里兜底清一次标志，免得下一次真实滚动被吞掉。
     */
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, []);

  const follow = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!stick.current) return;
      const node = ref.current;
      if (node) writeTop(node.scrollHeight);
    });
  }, [writeTop]);

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

    /** 用户主动离开底部：立刻停止跟随（不等到下一次 `scroll`）。 */
    const release = () => {
      stick.current = false;
    };
    const onWheel = (event: WheelEvent) => {
      // 往上滚才是"我要看历史"；往下滚交给 `scroll` 判到没到底。
      if (event.deltaY < 0) release();
    };
    const onTouchMove = () => release();
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) release();
    };
    /*
     * `scroll` 只做一件事：用户自己滚回底部时恢复跟随。
     * 代码写的那些位置（贴底、还原阅读位置）在这里被认出来并跳过。
     */
    const onScroll = () => {
      if (programmatic.current) {
        programmatic.current = false;
        return;
      }
      const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
      stick.current = gap < NEAR_BOTTOM;
    };

    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("scroll", onScroll, { passive: true });

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        if (stick.current) follow();
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
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [enabled, follow]);

  // 卸载：还没跑的那一帧取消掉，别往已经不在的容器里写。
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );

  return { ref, stick, follow, restore };
}
