/**
 * xterm 的 ANSI 调色板（跟随 App 主题：亮色优先，system 时跟系统）。
 *
 * # 为什么不用 App 的正文色当 ANSI 色
 *
 * App 的色令牌（`--fg` / `--success` …）是**给浅色底上的文字**选的：够深、
 * 够稳。但终端里的 ANSI 色是**前景/背景两用**的 —— 一个程序完全可能把
 * `green` 当背景用（`ls` 的 `LS_COLORS`、`\e[42m` 的提示条）。拿"深文字色"
 * 当背景，结果就是"暗底压暗字"，用户看到的是发闷的色块 —— 很怪。
 *
 * 所以这里两套都用**标准终端调色板**（亮色 = VS Code Light+，暗色 =
 * GitHub Dark 系），只把 background / foreground / cursor / selection 换回
 * 本 App 的令牌，让终端和周围界面仍然是一体。
 */

/**
 * 16 个标准 ANSI 槽位 —— 少一个 xterm 就会退回自己的默认值，
 * 两套主题的色感会当场分裂，所以这里显式列全（有测试兜底）。
 */
export function terminalTheme(dark: boolean): Record<string, string> {
  return dark
    ? {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#5b9cff",
        cursorAccent: "#0d1117",
        selectionBackground: "rgba(91,156,255,0.35)",
        black: "#16181d",
        red: "#f26057",
        green: "#4fd186",
        yellow: "#f0bb4e",
        blue: "#5b9cff",
        magenta: "#b39dff",
        cyan: "#6bd5e1",
        white: "#c7d0dc",
        brightBlack: "#6b7380",
        brightRed: "#ff7b72",
        brightGreen: "#7ee2a8",
        brightYellow: "#ffd484",
        brightBlue: "#9ecbff",
        brightMagenta: "#d2c5ff",
        brightCyan: "#9be8f0",
        brightWhite: "#eceef2",
      }
    : {
        background: "#f4f7fc",
        foreground: "#1f2329",
        cursor: "#3175f1",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(49,117,241,0.25)",
        // 亮色下这批值是 VS Code Light+ 的标准 ANSI 色：绿/黄/青都是**亮**
        // 的，当背景用时黑字依然读得清，当文字用时在白底上也够醒目。
        black: "#000000",
        red: "#cd3131",
        green: "#00bc00",
        yellow: "#949800",
        blue: "#0451a5",
        magenta: "#bc05bc",
        cyan: "#0598bc",
        white: "#555555",
        brightBlack: "#666666",
        brightRed: "#cd3131",
        brightGreen: "#14ce14",
        brightYellow: "#b5ba00",
        brightBlue: "#0451a5",
        brightMagenta: "#bc05bc",
        brightCyan: "#0598bc",
        // brightWhite 刻意不取纯白（#ffffff 在浅底上等于隐形），用一个比
        // `white` 更亮、又仍然看得见的中灰。
        brightWhite: "#6e7781",
      };
}
