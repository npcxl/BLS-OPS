/**
 * 终端 / 命令输出字体 —— **用户可选**，终端与结果面板**共用同一套栈**
 * （否则同一份文本在两边对不齐）。
 *
 * 说明（诚实）：项目**不打包字体文件**（体积考虑）。这里只切换 CSS font stack，
 * 机器没装对应字体时按栈内后续字体回退 —— 显示效果取决于本机已装字体。
 * 中文等宽建议选"更纱黑体 Sarasa Mono SC"（需本机安装）。
 */

export interface TerminalFontOption {
  id: string;
  label: string;
  /** CSS font-family 值（含最后的 monospace 兜底）。 */
  stack: string;
}

export const TERMINAL_FONTS: TerminalFontOption[] = [
  {
    id: "cascadia",
    label: "Cascadia Mono",
    stack: '"Cascadia Mono", "Sarasa Mono SC", Consolas, monospace',
  },
  {
    id: "sarasa",
    label: "Sarasa Mono SC (CJK)",
    stack: '"Sarasa Mono SC", "Cascadia Mono", Consolas, monospace',
  },
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", "Sarasa Mono SC", Consolas, monospace',
  },
  {
    id: "consolas",
    label: "Consolas",
    stack: 'Consolas, "Cascadia Mono", monospace',
  },
  {
    id: "menlo",
    label: "Menlo",
    stack: 'Menlo, Consolas, monospace',
  },
  {
    id: "system",
    label: "System default mono",
    stack: "monospace",
  },
];

export const DEFAULT_TERMINAL_FONT_ID = "cascadia";
/** 持久化键（与增强终端开关同域，隐私模式写不进去也不影响使用）。 */
export const TERMINAL_FONT_KEY = "bls-ops.terminal.font";

/** 未知 id → 默认，绝不因为脏数据渲染成空 font-family。 */
export function resolveFontStack(id: string): string {
  const matched = TERMINAL_FONTS.find((option) => option.id === id);
  return (matched ?? TERMINAL_FONTS[0]).stack;
}

export function readTerminalFontId(): string {
  try {
    const stored = window.localStorage.getItem(TERMINAL_FONT_KEY);
    return stored && TERMINAL_FONTS.some((option) => option.id === stored)
      ? stored
      : DEFAULT_TERMINAL_FONT_ID;
  } catch {
    return DEFAULT_TERMINAL_FONT_ID;
  }
}

export function saveTerminalFontId(id: string): void {
  try {
    window.localStorage.setItem(TERMINAL_FONT_KEY, id);
  } catch {
    /* 隐私模式等场景下写不进去，忽略即可 */
  }
}

/**
 * 应用到 CSS 变量 —— xterm 与结果面板都读这两个变量，所以只改一处：
 * - `--font-terminal`：xterm `options.fontFamily`（切换后需 fit 重排）；
 * - `--font-command-output`：结果快照 `<pre>` / JSON 文本模式。
 */
export function applyTerminalFont(id: string): string {
  const stack = resolveFontStack(id);
  const root = document.documentElement;
  root.style.setProperty("--font-terminal", stack);
  root.style.setProperty("--font-command-output", stack);
  return stack;
}
