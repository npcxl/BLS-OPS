/**
 * 远程提示符精简 —— **会话级，默认开**（用户可在设置里关掉）。
 *
 * # 痛点
 *
 * 云主机默认 PS1 是 `root@iZ2zeahqzmii45zto26u2dZ:/opt/bls-kox#`。主机名一长，
 * 提示符就吃掉半行，用户看不到自己敲了什么 —— 想要的只是当前目录：
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
 * # 为什么默认开（用户裁决，勿改回默认关）
 *
 * 这条需求用户提过多次，"给个开关、要自己去打开"等于没解决 —— 他要的是连上
 * 就是短的。代价可控：会话级、断开即还原、不落任何服务器文件、`$BASH_VERSION`
 * 门控保证只在 bash 生效，设置里随时能关。
 *
 * 仍然**绝不在用户正在输入时插字**（见 `TerminalView` 的注入点：只在连接成功
 * 那一瞬间发一次；设置变更从下一次连接生效）。
 */

export const COMPACT_PROMPT_KEY = "bls-ops.terminal.compactPrompt";

/**
 * 注入的 PS1 值。
 *
 * - `\[ \]` 必须包住非打印序列，否则 readline 按宽度算错光标位置，
 *   退格 / 换行会错乱；
 * - `\e`（ESC）、`\a`（BEL）、`\h`（短主机名）、`\w`（当前路径，家目录显示
 *   成 `~`）、`\$`（root 显示 `#`，普通用户 `$`）都是 bash 的 PS1 字面转义；
 * - **用 `\w` 而不是 `\W`**：`\W` 只给末级目录名（`/opt` → `opt`），用户根本
 *   看不出自己在哪一层，会当成乱码；`\w` 才是他要的"只保留当前路径"
 *   （`~` / `/opt` / `/opt/bls-kox`）；
 * - `$PWD` 由 bash 在**每次显示提示符时**展开 —— 所以 OSC 7 永远是最新目录。
 */
const PS1_VALUE = String.raw`\[\e]7;file://\h$PWD\a\]\w\$ `;

/**
 * 擦掉服务器自己画的那一行提示符（`printf` 的格式串）。
 *
 * 为什么要擦：`PS1` 只能等我们连上之后才改，而服务器在我们那条命令到达**之前**
 * 就已经把默认提示符（`lavm-er0ycrgnld:~#`）画在屏幕上了 —— 顺序上抢不过它。
 * 好消息是回显被边界解析器剔除时**连回显的换行一起吃掉**（`findEarliest`），
 * 所以光标正好停在那一行的末尾：抹掉整行、回到行首，用户从第一行起就只见精简
 * 提示符，上方的欢迎信息一行不动。
 *
 * 这两个转义由 `printf`（shell 内建，不依赖远程装了什么）解释：
 * `\033[2K` 擦整行、`\r` 回行首 —— **不做任何上下移动**，所以不可能吃掉
 * 上一行的登录信息。
 */
const ERASE_PROMPT_LINE = String.raw`\033[2K\r`;

/**
 * 注入的那一行（**不含回车**）—— 同时用于让边界解析器剔除终端回显。
 *
 * 前导空格：`HISTCONTROL=ignorespace` 下不进 shell 历史。
 * 长度受 `command-boundary.ts` 的 `MAX_PARTIAL` 约束（分块到达时要靠它兜住），
 * 加内容请同步那里与测试里的上限。
 */
export const COMPACT_PROMPT_LINE = ` [ -n "$BASH_VERSION" ] && PS1='${PS1_VALUE}' && printf '${ERASE_PROMPT_LINE}'`;

/**
 * 真正发给终端的内容：**必须以回车结尾，绝不要只发 `LINE`**。
 *
 * 少了这个 `\r`，这行字不会被执行，而是**留在用户当前的输入行里**：他接着
 * 敲的第一条命令会跟它粘成一条（`…PS1='…'ll` → bash 把 `ll` 拼进 PS1 字符串），
 * 于是命令没执行成，尾巴还被永久烙进提示符 —— 用户看到的就是 `opt# ll`
 * 这种"提示符自己多出两个字母"的鬼东西（真发生过，勿删本注释）。
 */
export const COMPACT_PROMPT_INPUT = `${COMPACT_PROMPT_LINE}\r`;

/**
 * 是否开启提示符精简。
 *
 * **默认开**：只有用户**主动关过**（存了 `"0"`）才关闭；读不到、读到脏值一律
 * 按开启处理 —— 否则老用户（localStorage 里根本没这个键）升级后仍然是长提示符，
 * 等于这次改动没生效。
 */
export function readCompactPrompt(): boolean {
  try {
    return window.localStorage.getItem(COMPACT_PROMPT_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveCompactPrompt(enabled: boolean): void {
  try {
    window.localStorage.setItem(COMPACT_PROMPT_KEY, enabled ? "1" : "0");
  } catch {
    /* 隐私模式等场景下写不进去，忽略即可 */
  }
}
