/**
 * 终端输出净化 —— 解析前必须做的清洗（P4 输出质量）。
 *
 * 终端原始流里除了命令真正的输出，还混着：
 * - ANSI CSI/OSC 控制序列（颜色、光标移动、清屏）
 * - `\r\n` 与单独的 `\r`（进度条覆盖）
 * - 退格（进度条、`^H` 动画）
 * - **命令回显**（我们在 PTY 里输入的命令被 shell 回显回来）
 * - **Shell 提示符**（`$` / `#` 及自定义 PS1）
 *
 * 这些直接喂给表格解析器会导致表头识别失败、第一列混入颜色码、回显
 * 变成数据行、列错位。所以保留**两份数据**：
 * - `raw`：完整原始内容（交给 xterm，用户看到的永远是原样）
 * - `normalized`：清洗后的文本（只交给适配器解析）
 */

/** OSC（Operating System Command）：`ESC ] ... BEL` 或 `ESC ] ... ESC \`。 */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** CSI（Control Sequence Introducer）：`ESC [ ... final-byte`。 */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** 其余两字节转义序列（`ESC ( B` 字符集选择等）。 */
const ESC_OTHER = /\x1b[@-Z\\-_]/g;
/** 其他 C0 控制字符（保留 \n \t）。 */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * 去掉 ANSI 控制序列与其他控制字符。
 *
 * 不清掉 `\n` 和 `\t` —— 它们是有意义的结构。
 */
export function stripAnsi(text: string): string {
  return text.replace(OSC, "").replace(CSI, "").replace(ESC_OTHER, "").replace(CONTROL, "");
}

/**
 * 处理行内覆盖：单独的 `\r`（不带 `\n`）表示回到行首覆盖。
 *
 * 进度条（`\r[====>    ] 40%`）会反复覆盖同一行 —— 只保留最后一次的
 * 内容，否则解析出几十行重复数据。`\r\n` 是正常换行，**必须原样保留**。
 */
export function applyCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  // 先按 \r\n（CRLF，正常换行）切成块 —— CRLF 里的 \r 不是覆盖；
  // 每块内部再按 \n 切可见行，行内的孤立 \r 才是覆盖，取最后一段。
  return text
    .split("\r\n")
    .map((part) =>
      part
        .split("\n")
        .map((line) => {
          if (!line.includes("\r")) return line;
          const segments = line.split("\r");
          for (let i = segments.length - 1; i >= 0; i -= 1) {
            if (segments[i].length > 0) return segments[i];
          }
          return "";
        })
        .join("\n"),
    )
    .join("\r\n");
}

/** 处理退格：`abc\b\b d` → `a d`（退格删除前一个字符）。 */
export function applyBackspaces(text: string): string {
  if (!text.includes("\b")) return text;
  const out: string[] = [];
  for (const char of text) {
    if (char === "\b") {
      out.pop();
    } else {
      out.push(char);
    }
  }
  return out.join("");
}

/**
 * 去掉命令回显：输出开头可能包含用户自己输入的那条命令。
 *
 * 只有当**第一行**正好是这条命令（去空白后）时才移除 —— 保守处理，
 * 绝不误删真正的数据行。
 */
export function stripCommandEcho(text: string, command: string): string {
  const lines = text.split("\n");
  const target = command.trim();
  if (!target) return text;
  for (let i = 0; i < Math.min(lines.length, 2); i += 1) {
    const cleaned = stripAnsi(lines[i]).trim();
    if (cleaned === target || cleaned === `${target};`) {
      lines.splice(i, 1);
      return lines.join("\n");
    }
  }
  return text;
}

/**
 * 去掉尾部 Shell 提示符。
 *
 * **只清尾部最后一行**，且只在该行"看起来像提示符"时（以常见提示符
 * 结尾且没有实质内容）。绝不在中间行做判断 —— 那是猜测。
 */
export function stripTrailingPrompt(text: string): string {
  const lines = text.split("\n");
  // 末尾的空行先去掉（命令结束后 shell 会再打一次提示符 + 换行）。
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) return text;
  const lastIndex = lines.length - 1;
  const last = stripAnsi(lines[lastIndex]).trim();
  // 提示符特征：以 $ # % > 结尾，且很短（PS1 不会是几十个字符的数据）。
  if (last.length <= 80 && /[$#%>]\s*$/.test(last) && !/\S+\s+\S+\s+\S+/.test(last)) {
    lines.splice(lastIndex, 1);
  }
  return lines.join("\n");
}

/**
 * 完整清洗流程：原始终端输出 → 适配器可用的文本。
 *
 * 顺序很重要：先应用 `\r`/退格（还原视觉结果），再清 ANSI，最后才
 * 去回显与提示符（需要在干净文本上比对）。
 */
export function normalizeForParsing(raw: string, command: string): string {
  let text = raw;
  text = applyCarriageReturns(text);
  text = applyBackspaces(text);
  text = stripAnsi(text);
  // 统一换行符（终端是 \r\n）：之后的回显比对与提示符剥离只处理 \n。
  text = text.replace(/\r\n/g, "\n");
  text = stripCommandEcho(text, command);
  text = stripTrailingPrompt(text);
  return text;
}

// ── 命令标准化（匹配用）──────────────────────────────────────────────────

/**
 * 把用户输入标准化，用于匹配知识库。
 *
 * 处理：前导 `sudo`、多余空白、管道/重定向之后的部分（主命令）。
 * 返回 `null` = 无法提取有效命令（空输入、以管道开头等）。
 */
export function canonicalCommand(input: string): string | null {
  let text = input.trim();
  if (!text) return null;

  // 去掉前导 sudo（可重复：`sudo sudo df`）。
  for (;;) {
    const stripped = text.replace(/^sudo\s+/i, "").trim();
    if (stripped === text) break;
    text = stripped;
  }
  if (!text) return null;

  // 只取管道/逻辑运算符之前的**主命令**：后面的 `grep/awk` 会改变输出结构，
  // 不能沿用原适配器（见 hasPipeline）。
  const cut = text.search(/[|;&]/);
  if (cut === 0) return null; // 以管道开头：没有主命令
  if (cut > 0) text = text.slice(0, cut);

  text = text.replace(/\s+/g, " ").trim();
  return text || null;
}

/** 输入是否含管道/链式命令（输出结构可能被改变）。 */
export function hasPipeline(input: string): boolean {
  return /[|;&]/.test(input.trim());
}
