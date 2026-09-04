import { useLayoutEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";

/**
 * 选中文字后浮出的"复制"小菜单。
 *
 * 两件事值得单独成文（并写成纯函数以便测试）：
 *
 * 1. **位置必须钳制在容器内**：锚点是选区末端（最后一个选中单元格的右
 *    下角）。从右往左选、或选区很长时，锚点会贴近甚至超出容器右缘 ——
 *    菜单直接 `left: x` 就会被裁掉一半（表现为"复制按钮和字符数错位"）。
 *    这里右侧放不下就翻到锚点左侧，下方放不下就翻到锚点上方，最后再夹到
 *    安全边距内。
 * 2. **复制走共用 `copyText`**（`copy-feedback` 的 `useCopyFeedback`），
 *    不再各自 `navigator.clipboard`，失败也有可见提示。
 */

export interface MenuPosition {
  x: number;
  y: number;
  menu: { width: number; height: number };
  container: { width: number; height: number };
  margin?: number;
}

/**
 * 菜单定位（**纯函数**，不碰 DOM 才好测）。
 *
 * - 右侧放不下 → 翻到锚点左侧（`x - 菜单宽`）；
 * - 下方放不下 → 翻到锚点上方；
 * - 两种翻转都放不下 → 夹到 `margin` 内（宁可贴边，也不溢出）；
 * - 容器尺寸不可用（还没布局 / jsdom 恒为 0）→ 原样返回，交给 CSS 兜底。
 */
export function clampMenuPosition({
  x,
  y,
  menu,
  container,
  margin = 8,
}: MenuPosition): { left: number; top: number } {
  const { width: menuWidth, height: menuHeight } = menu;
  const { width: containerWidth, height: containerHeight } = container;
  if (containerWidth <= 0 || containerHeight <= 0) return { left: x, top: y };

  const maxLeft = Math.max(margin, containerWidth - menuWidth - margin);
  const maxTop = Math.max(margin, containerHeight - menuHeight - margin);

  let left = x;
  // 右缘放不下 → 翻到锚点左侧（否则从右往左选时菜单被裁掉）。
  if (left + menuWidth + margin > containerWidth) left = x - menuWidth;
  left = Math.min(Math.max(margin, left), maxLeft);

  let top = y;
  // 下缘放不下 → 翻到锚点上方（选区贴着终端底部时）。
  if (top + menuHeight + margin > containerHeight) top = y - menuHeight - 4;
  top = Math.min(Math.max(margin, top), maxTop);

  return { left, top };
}

export function TerminalSelectionMenu({
  x,
  y,
  text,
  containerRef,
  onCopy,
}: {
  /** 锚点：选区末端（相对 `containerRef` 的 px 坐标）。 */
  x: number;
  y: number;
  text: string;
  /** 定位容器（`relative`），菜单被钳制在它的范围内。 */
  containerRef: React.RefObject<HTMLElement | null>;
  onCopy: (text: string) => void | Promise<void>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // 菜单宽度随"已选择 N 个字符"变化（字符数变多 → 更宽），所以 text 也要
  // 进依赖：每次重新测量、重新钳制。
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const container = containerRef.current;
    if (!menu || !container) return;
    setPosition(
      clampMenuPosition({
        x,
        y,
        menu: { width: menu.offsetWidth, height: menu.offsetHeight },
        container: { width: container.clientWidth, height: container.clientHeight },
      }),
    );
  }, [x, y, text, containerRef]);

  return (
    <div
      ref={menuRef}
      data-testid="terminal-selection-menu"
      // 未测量出来前先隐藏，避免"先画在错位置、再跳回来"的抖动。
      style={{
        left: position?.left ?? x,
        top: position?.top ?? y,
        visibility: position ? "visible" : "hidden",
      }}
      className="absolute z-40 flex max-w-[calc(100%-16px)] items-center gap-1 rounded-[9px] border border-line bg-surface-1 px-1.5 py-1 shadow-lg"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <span className="truncate px-1 text-11 tabular-nums text-fg-subtle">
        已选择 {text.length} 个字符
      </span>
      <button
        type="button"
        data-testid="selection-copy"
        onClick={() => void onCopy(text)}
        className="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-2 text-11 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
      >
        <Copy size={12} />
        复制
      </button>
    </div>
  );
}
