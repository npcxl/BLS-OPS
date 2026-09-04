/**
 * 命令提交计划 —— **唯一入口** `executeTerminalCommand` 的决策层。
 *
 * 三条规则：
 *
 * 1. **交互式全屏程序**（vim / top / less …）留在原生终端：alternate screen
 *    的内容不是可解析文本，而且我们的标记行会被它们当成按键吃掉。
 * 2. **会吞 stdin 的程序**（`cat` 无参数 / REPL / `mysql`…）同样不注入标记 ——
 *    标记行会被当成**输入**而不是命令，既拿不到边界，还会往程序里打字。
 * 3. 其余命令注入受控标记，捕获输出并生成结构化结果 Tab。
 *
 * 命令本身**从不改写**（不加包装、不加 `;` 前缀）：终端里回显的仍然是用户
 * 敲的那一行。
 */

import { INJECTED_LINES, MARKER_C_LINE, MARKER_D_LINE } from "./command-boundary";

/** 命令来源（结果 Tab 上可见，便于区分"我敲的"和"重跑的"）。 */
export type CommandSource = "input" | "rerun" | "history" | "suggest";

export const COMMAND_SOURCE_LABELS: Record<CommandSource, string> = {
  input: "手动输入",
  rerun: "重新运行",
  history: "历史命令",
  suggest: "命令建议",
};

/**
 * 交互式全屏程序：alternate screen 内容不可解析，且会吞掉标记行。
 *
 * 注意 `exit` / `clear` / `ssh` 也在内 —— 它们要么结束会话，要么把标记
 * 发给远端主机。
 */
const INTERACTIVE = new Set([
  "vim",
  "vi",
  "nvim",
  "nano",
  "emacs",
  "top",
  "htop",
  "btop",
  "atop",
  "less",
  "more",
  "watch",
  "man",
  "exit",
  "logout",
  "clear",
  "reset",
  "ssh",
  "telnet",
  "ftp",
  "sftp",
  "mysql",
  "mariadb",
  "psql",
  "redis-cli",
  "mongo",
  "mongosh",
]);

/** REPL / 交互解释器：拿到 stdin 就不吐提示符，标记永远等不到。 */
const REPL = new Set([
  "python",
  "python3",
  "python2",
  "node",
  "nodejs",
  "deno",
  "php",
  "perl",
  "ruby",
  "irb",
  "lua",
  "bc",
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "su",
  "sudoedit",
  "passwd",
  "read",
  "nc",
  "ncat",
  "socat",
  "screen",
  "tmux",
]);

/**
 * 有参数就读文件、没参数就读 stdin 的过滤器。
 *
 * `tail -n 50 /var/log/x` 没问题；`tail` 或 `tail -f` 就必须排除
 * （前者读 stdin、后者永不结束）。
 */
const FILE_OR_STDIN = new Set([
  "cat",
  "tac",
  "head",
  "tail",
  "sed",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "awk",
  "gawk",
  "mawk",
  "sort",
  "uniq",
  "wc",
  "tr",
  "cut",
  "paste",
  "join",
  "tee",
  "xargs",
  "dd",
  "base64",
  "gzip",
  "gunzip",
  "zcat",
  "tar",
  "jq",
  "less",
  "more",
]);

/**
 * 只改 shell 自己状态、不产生可解析输出的内建命令。
 *
 * `cd` / `export` / `alias` 之类在终端里意义重大，但它们的 stdout 恒为空 ——
 * 给它们弹一个"空结果面板"纯属噪音。注意这里只影响**是否捕获**，命令照常
 * 发往 shell（`cd` 必须生效、文件面板仍会跟随）。
 */
const LOCAL_BUILTINS = new Set([
  "cd",
  "chdir",
  "pushd",
  "popd",
  "export",
  "set",
  "unset",
  "alias",
  "unalias",
  "source",
  ".",
  "eval",
  "hash",
  "jobs",
  "fg",
  "bg",
  "disown",
  "history",
  "exit",
]);

/** 输出是否会被"吞掉"—— 真被吞掉时不能注入标记。 */
export function blocksCapture(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  // 管道只有**第一段**可能读 stdin：`ps aux | grep nginx` 的 grep 不读 stdin，
  // `cat | grep x` 的 cat 才读。所以只看管道前的第一段。
  const head = trimmed.split("|")[0];
  const tokens = head.trim().split(/\s+/);
  const exe = (tokens[0] ?? "").toLowerCase();
  if (!exe) return true;
  if (LOCAL_BUILTINS.has(exe)) return true;
  if (INTERACTIVE.has(exe) || REPL.has(exe)) return true;
  if (FILE_OR_STDIN.has(exe)) {
    // 要能捕获，必须**看起来真的给了文件**：`/var/log/x` / `./a.log` /
    // `~/x` / 带扩展名的 `error.log`。`grep foo` 的 `foo` 是**模式**不是文件
    // （它会去读 stdin，标记行会被当输入吃掉）。
    const looksLikeFile = (token: string) =>
      token.includes("/") || token.startsWith("~") || /\.[A-Za-z0-9]{1,5}$/.test(token);
    const args = tokens.slice(1).filter((token) => !token.startsWith("-"));
    if (!args.some(looksLikeFile)) return true;
    if (/(^|\s)(--follow|-f|-F)(\s|$)/.test(head)) return true; // `tail -f` 永不结束
  }
  return false;
}

/**
 * 命令行在终端里的状态 —— 决定"要不要连命令一起写"。
 *
 * - `line-ready`：命令行**已经**在终端上（用户手敲、或建议已补全）→
 *   只补一个回车 + 结束标记（此时 output start 由"收到第一块输出"判定）；
 * - `full`：命令行还没写进终端（结果重运行、命令历史）→ 连命令一起写，
 *   顺带把"输出开始"标记也发出去。
 */
export type SubmitMode = "line-ready" | "full";

export interface CommandPlan {
  /** 是否捕获输出并生成结构化结果 Tab。 */
  capture: boolean;
  /** 写到 PTY 的文本（可能含受控标记行）。 */
  write: string;
  /** 需要从输出流里剔除回显的注入行（未注入则为空）。 */
  markers: string[];
  /** 不捕获的原因（诊断用，不是错误）。 */
  reason?: string;
}

/**
 * 生成一次提交的写出内容 —— **命令本身从不改写**（不加包装、不加前缀）：
 * 终端里回显的仍然是用户敲的那一行。
 */
export function planCommandSubmission(
  command: string,
  mode: SubmitMode = "full",
): CommandPlan {
  const trimmed = command.trim();
  if (!trimmed) {
    return { capture: false, write: "", markers: [], reason: "空命令" };
  }
  if (blocksCapture(trimmed)) {
    // `line-ready` 时命令行已经写好了 —— 什么都不补（回车由调用方随按键
    // 数据一起发出）。
    return {
      capture: false,
      write: mode === "full" ? `${trimmed}\n` : "",
      markers: [],
      reason: "交互式 / 会读 stdin / 无输出的内建命令，留在原生终端",
    };
  }
  if (mode === "line-ready") {
    // 命令行已经在终端上：只补**结束标记**（回车由调用方随按键数据一起发出）。
    return {
      capture: true,
      write: ` ${MARKER_D_LINE}\n`,
      markers: [MARKER_D_LINE],
    };
  }
  return {
    capture: true,
    // 前导空格：尽量让标记行不进 shell 历史（HISTCONTROL=ignorespace 时生效）。
    write: ` ${MARKER_C_LINE}\n${trimmed}\n ${MARKER_D_LINE}\n`,
    markers: INJECTED_LINES,
  };
}
