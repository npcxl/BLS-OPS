/**
 * 远程提示符精简 —— **会话级**，由用户在设置里主动开启（默认关）。
 *
 * # 痛点
 *
 * 云主机默认 PS1 是 `root@iZ2zeahqzmii45zto26u2dZ:/opt/bls-kox#`。主机名一长，
 * 提示符就吃掉半行，用户看不到自己敲了什么 —— 想要的是只留目录：
 * `~#` / `/#` / `bls-kox#`。
 *
 * # 三条原则
 *
 * 1. **不碰服务器上任何配置文件**：不写 `~/.bashrc`，只往当前会话的 shell
 *    里发一次赋值。断开即失效，别的客户端（Xshell / 原生 ssh）完全不受影响。
 * 2. **不认识的 shell 直接不注入**：整条命令用 `$BASH_VERSION` 门控（zsh /
 *    dash / fish 下 `[ -n ... ]` 为假，什么都不会发生）—— 绝不在别人的 shell
 *    里留下一串看不懂的转义。
 * 3. **精简的同时顺带上报 OSC 7**：提示符里嵌一个 `file://<host><$PWD>`，
 *    我们因此拿到**权威 cwd**（补全与文件面板跟随会更准），而用户只看到 `\W`。
 *
 * # 为什么默认关
 *
 * 开启后我们会在连接成功时**往远程 shell 里写一条命令**，这属于改变远程会话
 * 行为 —— 必须由用户点头，不做默认（也绝不在用户正在输入时插字，见
 * `TerminalView` 的注入点：只在连接成功那一瞬间发一次）。
 */

export const COMPACT_PROMPT_KEY = "bls-ops.terminal.compactPrompt";

/**
 * 注入的 PS1 值。
 *
 * - `\[ \]` 必须包住非打印序列，否则 readline 按宽度算错光标位置，
 *   退格 / 换行会错乱；
 * - `\e`（ESC）、`\a`（BEL）、`\h`（短主机名）、`\W`（当前目录名）、
 *   `\$`（root 显示 `#`，普通用户 `$`）都是 bash 的 PS1 字面转义；
 * - `$PWD` 由 bash 在**每次显示提示符时**展开 —— 所以 OSC 7 永远是最新目录。
 */
const PS1_VALUE = String.raw`\[\e]7;file://\h$PWD\a\]\W\$ `;

/**
 * 连接成功后注入的那一行。
 *
 * 前导空格：`HISTCONTROL=ignorespace` 下不进 shell 历史。
 */
export const COMPACT_PROMPT_COMMAND = ` [ -n "$BASH_VERSION" ] && PS1='${PS1_VALUE}'`;

/** 是否开启了提示符精简（默认关：读不到 / 脏值一律按关闭处理）。 */
export function readCompactPrompt(): boolean {
  try {
    return window.localStorage.getItem(COMPACT_PROMPT_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveCompactPrompt(enabled: boolean): void {
  try {
    window.localStorage.setItem(COMPACT_PROMPT_KEY, enabled ? "1" : "0");
  } catch {
    /* 隐私模式等场景下写不进去，忽略即可 */
  }
}
