/**
 * 终端内联补全（原位提示）的纯逻辑：光标锚点定位算法 + 键盘判定。
 *
 * 抽成纯函数是为了可测：定位的翻转规则与按键→动作的映射都在这里，
 * React 组件只负责测量与渲染。
 */

/** 光标锚点（px，相对终端定位容器；= 光标单元格的右下角）。 */
export interface SuggestAnchor {
  x: number;
  y: number;
  /**
   * 光标所在行高（px）。翻到上方时需要让开**正在输入的整行** ——
   * 否则面板会盖住用户敲的命令，看不见自己在打什么。
   */
  rowHeight?: number;
}

/** 提示面板尺寸（px）。 */
export interface SuggestBox {
  width: number;
  height: number;
}

/** 定位容器（relative 包装层）的可用尺寸（px）。 */
export interface SuggestViewport {
  width: number;
  height: number;
}

/** 面板与光标的间隔（px）。 */
export const SUGGEST_GAP = 6;

/** 面板与容器边缘的最小间距（px）。 */
const VIEWPORT_MARGIN = 4;

/**
 * 计算面板位置：默认在光标**右下方**（间隔 6px）；
 * 右侧放不下 → 向左展开；底部放不下 → 翻到光标上方；
 * 面板比容器还大 → 贴边（clamp 到 MARGIN）。
 *
 * 翻到上方时：锚点 y 是**光标行底缘**。若不额外让开一行，面板顶到光标
 * 行内 —— 用户正在敲的命令会被整个盖住。有 `rowHeight` 时按"让出整行 +
 * 间隔"上移（面板底缘停在光标行的上缘之上），保证输入始终可见。
 */
export function computeSuggestPosition(
  anchor: SuggestAnchor,
  panel: SuggestBox,
  viewport: SuggestViewport,
  gap: number = SUGGEST_GAP,
): { left: number; top: number } {
  let left = anchor.x + gap;
  if (left + panel.width > viewport.width - VIEWPORT_MARGIN) {
    left = anchor.x - gap - panel.width;
  }
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

  let top = anchor.y + gap;
  if (top + panel.height > viewport.height - VIEWPORT_MARGIN) {
    // 让开正在输入的那一行（rowHeight），再留间隔；无 rowHeight 时保持旧行为。
    top = anchor.y - (anchor.rowHeight ?? 0) - gap - panel.height;
  }
  if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;

  return { left, top };
}

/** 键盘判定产出的动作。`none` = 不拦截，按键照常发给远程 shell。 */
export type SuggestKeyAction =
  | { type: "none" }
  | { type: "move"; delta: 1 | -1 }
  | { type: "accept" }
  | { type: "dismiss" };

export interface SuggestKeyEventInput {
  key: string;
  /** 输入法组合中（keydown keyCode 229）：绝不拦截，方向键与 Enter 属于 IME。 */
  isComposing?: boolean;
}

/**
 * 提示面板打开时的按键映射：
 *
 * | 按键          | 动作                     |
 * | ------------- | ------------------------ |
 * | `↑` / `↓`     | 上下选择候选              |
 * | `→`           | 填入当前候选（不执行）    |
 * | `Tab`         | 补全当前候选（不执行）    |
 * | `←` / `Esc`   | 关闭面板，恢复 shell 按键 |
 * | `Enter`       | 填入候选（不执行）        |
 *
 * **第一次 Enter 只填入**。填入后视图层记录 dismissedDraft（= 填入后的草稿），
 * 面板关闭、hasHits 变 false —— 第二次 Enter 在这里落到 `none`，穿透给
 * shell 正常执行。用户继续输入/删除/修改草稿后才会重新检索。
 */
export function resolveSuggestKey(
  event: SuggestKeyEventInput,
  hasHits: boolean,
): SuggestKeyAction {
  if (event.isComposing) return { type: "none" };
  if (!hasHits) return { type: "none" };
  switch (event.key) {
    case "ArrowDown":
      return { type: "move", delta: 1 };
    case "ArrowUp":
      return { type: "move", delta: -1 };
    case "ArrowRight":
    case "Tab":
    case "Enter":
      return { type: "accept" };
    case "ArrowLeft":
    case "Escape":
      return { type: "dismiss" };
    default:
      return { type: "none" };
  }
}

/**
 * 把"替换范围 + 待插入文本"换算成按键序列。
 *
 * 终端没有可编程光标，只能退格 + 输入：先删掉 `[start, cursor)` 之间的字符
 * （Backspace = `\x7f`），再写入 `insertText`。
 *
 * 前提是"光标就在行尾"（终端里由 LineEditor 还原的当前行），这也是本函数
 * 只回退不前进的原因。
 */
export function keysForReplace(
  line: string,
  range: { start: number; end: number },
  insertText: string,
  cursor: number = line.length,
): string {
  const start = Math.max(0, Math.min(range.start, line.length));
  const end = Math.max(start, Math.min(range.end, line.length));
  const backspaces = Math.max(0, cursor - start);
  const forward = Math.max(0, end - cursor);
  return "\x7f".repeat(backspaces) + insertText + "\x1b[C".repeat(forward);
}
