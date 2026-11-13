/**
 * 弧形输入栏的键盘决策（纯函数，便于回归测试）。
 *
 * 规则（与终端命令板保持一致，2026-11-13 用户裁决）：
 * - 中文输入法组词/选字期间**所有快捷键让给输入法**（回车是上屏，不是执行）；
 * - Tab：**有可用候选**才填入，否则不拦截（恢复正常焦点导航）；
 * - Enter：执行输入框里已确认的内容，不替用户执行候选；
 * - Ctrl+Space：展开 / 收起候选列表；
 * - ↑↓：列表展开时选候选，收起时翻历史；
 * - Esc：只收起候选或灰字，**草稿一字不动**；
 * - 数字、空格：正常输入（不参与选择）。
 */

export type ComposerAction =
  /** 不拦截，交给浏览器（打字、焦点导航都走这条）。 */
  | { type: "none" }
  /** 填入候选（Tab）。 */
  | { type: "complete" }
  /** 执行输入框内容（Enter）。 */
  | { type: "submit" }
  /** 展开 / 收起候选列表（Ctrl+Space）。 */
  | { type: "list-toggle" }
  /** 在候选列表里移动（↑↓，列表展开时）。 */
  | { type: "move"; delta: 1 | -1 }
  /** 翻历史命令（↑↓，列表收起时）。 */
  | { type: "history"; delta: 1 | -1 }
  /** 只收起候选，保留草稿（Esc）。 */
  | { type: "close-list" }
  /** 数字键直接选第 N 条（1-6）。 */
  | { type: "pick"; index: number }
  /** 翻页：`=` 下一页、`-` 上一页。 */
  | { type: "page"; delta: 1 | -1 };

/**
 * 按范围替换片段，返回新文本与补全后的光标位置。
 *
 * 补全**只改光标所在的词**：`docker logs ng|inx --tail 100` 补成
 * `docker logs nginx-prod --tail 100`，后面的参数、引号、管道都原样保留。
 */
export function replaceSegment(
  text: string,
  range: { start: number; end: number },
  insert: string,
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(range.start, text.length));
  const end = Math.max(start, Math.min(range.end, text.length));
  return {
    text: text.slice(0, start) + insert + text.slice(end),
    caret: start + insert.length,
  };
}

export interface ComposerKeyEvent {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  /** Alt 组合键：`Alt+1~6` 才是编号选择，裸数字照常输入。 */
  altKey?: boolean;
  /** 输入法组词/选字中（`event.nativeEvent.isComposing`）。 */
  isComposing?: boolean;
}

export interface ComposerKeyState {
  listOpen: boolean;
  /** 候选是否可用（对应当前会话 + 输入 + 光标）。 */
  hasUsableItems: boolean;
  /** 是否有候选（不看是否过期）。 */
  hasItems: boolean;
  /** 草稿非空。 */
  hasDraft: boolean;
  /** 候选总页数（≤1 时 `-` / `=` 正常输入）。 */
  pageCount?: number;
}

export function resolveComposerKey(
  event: ComposerKeyEvent,
  state: ComposerKeyState,
): ComposerAction {
  // 输入法优先：组词、选字期间一个键都不抢。
  if (event.isComposing) return { type: "none" };

  if (event.ctrlKey && event.code === "Space") return { type: "list-toggle" };

  if (event.key === "Tab") {
    // 没候选（或候选已过期）就放行，让 Tab 恢复正常的焦点导航。
    return state.hasUsableItems ? { type: "complete" } : { type: "none" };
  }

  /*
   * **候选栏可见时，裸数字 1-6 直接选第 N 条**（输入法式）。
   *
   * 用户反馈"有补全时按数字却输入了数字"——候选摆在眼前时，数字键就该是
   * 选择键，这是输入法的肌肉记忆。
   *
   * 不会误伤 `--tail 100`：命令词之后按空格自动收起候选（见 `endsWithSpace`），
   * 参数阶段的数字本来就落在"没有候选"的状态里，照常输入。真正越界（这一页
   * 只有 3 条却按 5）时 `pick` 会让调用方放行，数字仍然能打出来。
   */
  if (state.listOpen && state.hasItems) {
    if (/^[1-6]$/.test(event.key)) {
      return { type: "pick", index: Number(event.key) - 1 };
    }
    if (event.key === "=" || event.key === "-") {
      if ((state.pageCount ?? 1) > 1) {
        return { type: "page", delta: event.key === "=" ? 1 : -1 };
      }
    }
  }

  if (event.key === "Enter" && !event.shiftKey) return { type: "submit" };

  if (event.key === "Escape") {
    // 只收起候选；**不清草稿**（用户可能只是想关掉列表继续打）。
    return state.listOpen ? { type: "close-list" } : { type: "none" };
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const delta: 1 | -1 = event.key === "ArrowDown" ? 1 : -1;
    if (state.listOpen && state.hasItems) return { type: "move", delta };
    // 列表收起 → ↑↓ 翻历史（命令板的老语义）。
    return state.hasDraft || state.hasItems ? { type: "history", delta } : { type: "none" };
  }

  // 数字、空格、Ctrl+C 之外的键都不拦。
  return { type: "none" };
}
