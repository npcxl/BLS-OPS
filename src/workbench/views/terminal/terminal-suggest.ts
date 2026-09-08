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

/** 键盘事件输入（供状态机判定）。 */
export interface SuggestKeyEventInput {
  key: string;
  /** 输入法组合中（keydown keyCode 229）：绝不拦截，方向键与 Enter 属于 IME。 */
  isComposing?: boolean;
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

// ---------------------------------------------------------------------------
// 统一补全状态机（用户裁决 2026-09-08，勿回退）：
// **默认只有行内 ghost，面板只在 Tab / ArrowDown 后出现。**
//
// collapsed（ghost 态）：输入框只有灰色 ghost + Tab 徽标，没有面板；
//   Tab / ↓ = 接受第一条并展开面板；Enter = 直接执行第一条（无候选则穿透）；
//   Esc = 清空整行。
// expanded（面板态）：↑↓ 选择、Enter 执行当前项、Tab/→ 填入当前项、
//   Esc = 清空整行。继续编辑（行内容变化）→ 回 collapsed。
// ---------------------------------------------------------------------------

/** 统一状态机的动作。`none` = 不拦截，按键照常发给远程 shell。 */
export type TerminalCompleteAction =
  | { type: "none" }
  | { type: "move"; delta: 1 | -1 }
  | { type: "accept-first" }
  | { type: "accept-active" }
  | { type: "run-first" }
  | { type: "run-active" }
  | { type: "clear-line" };

export interface TerminalCompleteState {
  /** 面板是否已展开（Tab/ArrowDown 之后）。 */
  expanded: boolean;
  /** 是否有候选（决定 collapsed 的 Tab/↓/Enter 是否接管）。 */
  hasItems: boolean;
}

export function resolveTerminalCompleteKey(
  event: SuggestKeyEventInput,
  state: TerminalCompleteState,
): TerminalCompleteAction {
  if (event.isComposing) return { type: "none" };
  // Esc 任何状态都清空整行（用户裁决第七条：清输入、清 ghost、关面板）。
  if (event.key === "Escape") return { type: "clear-line" };

  if (state.expanded) {
    switch (event.key) {
      case "ArrowDown":
        return state.hasItems ? { type: "move", delta: 1 } : { type: "none" };
      case "ArrowUp":
        return state.hasItems ? { type: "move", delta: -1 } : { type: "none" };
      case "Enter":
        // 展开态 Enter = **执行**当前高亮项（与命令中心一致）；没有候选则
        // 穿透 —— shell 执行用户输入的原始命令。
        return state.hasItems ? { type: "run-active" } : { type: "none" };
      case "Tab":
      case "ArrowRight":
        // 填入当前高亮（不执行）：多级目录 / 继续补参数的路径。
        return state.hasItems ? { type: "accept-active" } : { type: "none" };
      default:
        return { type: "none" };
    }
  }

  switch (event.key) {
    case "Tab":
    case "ArrowDown":
      // 接受第一条并展开完整面板 —— 面板唯一的出现方式。
      return state.hasItems ? { type: "accept-first" } : { type: "none" };
    case "Enter":
      // 有 ghost 建议 → 直接执行第一条（参数/风险流程照走）；
      // 没有 → 穿透，shell 执行原始输入。
      return state.hasItems ? { type: "run-first" } : { type: "none" };
    default:
      return { type: "none" };
  }
}

/**
 * 行内 ghost 文本：第一条候选里**用户还没敲出来的部分**。
 *
 * 候选的 `insertText` 有两种语义，匹配策略随之不同：
 * 1. **token 替换**（目录 / 服务 / 容器名 / 进程…）：insertText 是当前
 *    token 的完整替换文本 → ghost = 去掉已敲的 partial（`cd o` + `ops/` → `ps/`）；
 * 2. **完整语法**（知识库 / 环境命令）：insertText 是整条命令 →
 *    ghost = 去掉与整行重合的前缀（`docker p` + `docker ps -a` → `s -a`）。
 *
 * 都不匹配（场景命中、裸 `cd` 的 `" ops/"`）→ 显示整条 insertText
 * （裸 `cd` 的 ghost 因此自带前导空格 —— 用户裁决：ghost 前自动含空格）。
 * 空行 / 无候选 → 空串（**不显示任何 ghost**）。
 */
export function ghostTextFor(
  item: { insertText: string } | undefined,
  line: string,
  parsedPrefix: string | null,
): string {
  if (!item) return "";
  const insert = item.insertText;
  if (!insert) return "";
  if (!line.trim()) return "";
  if (parsedPrefix && parsedPrefix.length > 0 && insert.startsWith(parsedPrefix)) {
    return insert.slice(parsedPrefix.length);
  }
  if (insert.startsWith(line)) return insert.slice(line.length);
  return insert;
}
