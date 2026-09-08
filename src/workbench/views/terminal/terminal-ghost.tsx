import type { Terminal } from "@xterm/xterm";
import type { SuggestAnchor } from "./terminal-suggest";

/**
 * 行内 ghost 提示（统一补全状态机的收起态，用户裁决 2026-09-08）：
 * 跟在光标后面的**灰色候选剩余部分** + 一个小 Tab 徽标。
 *
 * - **不是建议面板**：没有边框、没有列表、没有背景，`pointer-events-none`
 *   —— 不挡点击、不挡复制、不挡终端内容，绝不打扰输入；
 * - 位置锚定光标单元格右下角（`anchor`），与正在输入的行同行；
 * - 字体 / 字号 / 行高取自 xterm 实例，让 ghost 与真实文字对齐。
 */
export function TerminalGhost({
  text,
  anchor,
  terminal,
}: {
  text: string;
  anchor: SuggestAnchor;
  terminal: Terminal | null;
}) {
  const fontSize = terminal?.options.fontSize ?? 14;
  const rowHeight = Math.max(12, Math.round(fontSize * (terminal?.options.lineHeight ?? 1)));
  return (
    <div
      data-testid="terminal-ghost"
      aria-hidden
      className="pointer-events-none absolute z-20 flex select-none items-center whitespace-pre"
      style={{
        left: anchor.x,
        top: anchor.y - rowHeight,
        height: rowHeight,
        fontFamily: terminal?.options.fontFamily,
        fontSize,
        lineHeight: `${rowHeight}px`,
      }}
    >
      <span className="opacity-60">{text}</span>
      <kbd className="ml-1.5 self-center rounded border border-line bg-surface-3 px-1 text-9 leading-none text-fg-subtle">
        Tab
      </kbd>
    </div>
  );
}
