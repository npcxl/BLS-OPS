/**
 * 命令提交计划 —— **唯一入口** `executeTerminalCommand` 的决策层。
 *
 * 三条规则：
 *
 * 1. **交互式全屏程序**（vim / top / less …）留在原生终端：alternate screen
 *    的内容不是可解析文本，而且我们的标记行会被它们当成按键吃掉。
 * 2. **会吞 stdin 的程序**（`cat` 无参数 / REPL / `mysql`…）同样不注入标记 ——
 *    标记行会被当成**输入**而不是命令，既拿不到边界，还会往程序里打字。
 * 3. 其余命令注入受控标记，捕获输出并生成命令结果 Tab（终端快照 + 原始流）。
 *
 * 命令本身**从不改写**（不加包装、不加 `;` 前缀）：终端里回显的仍然是用户
 * 敲的那一行。
 */

import { INJECTED_LINES, MARKER_C_LINE, MARKER_D_LINE } from "./command-boundary";

/**
 * 命令来源（谁把它提交出去的）。
 *
 * 结果抽屉移除后它不再有可见标签，但**保留**：`execute` / 协调器 /
 * `CapturedResult.source` 都还带着它（诊断与将来恢复面板时都要用）。
 */
export type CommandSource = "input" | "rerun" | "history" | "suggest";

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
 *
 * ⚠️ `cd` 家族虽然也在这个集合里，但 `planCommandSubmission` **会先**用
 * [`CD_FAMILY`] 拦下它们并注入结束标记 —— 见那里的说明：
 * "不弹结果面板"和"不注入标记"是两件事，混成一件事会让 cwd 追踪彻底失效。
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

/**
 * 会改变 cwd 的内建命令。
 *
 * 这些命令**不要结果面板，但必须注入结束标记** —— 追踪当前目录唯一的硬依据
 * 是 `cd` 的**真实退出码**（成功才更新，失败目录不变）。
 *
 * 曾经的实现把"不弹结果面板"和"不注入标记"混成了一件事（都挂在 `capture`
 * 上），于是 `cd` 的退出码永远拿不到：`noteCd` 记下的待确认目标没人确认，
 * tracked cwd 一直停在登录目录 —— 之后再敲相对路径 `cd opt`，就会被解析成
 * `/root/opt`，文件面板跟着跳到一个不存在的目录（用户报的
 * "明明有路径为什么不存在"就是这条链路）。
 */
const CD_FAMILY = new Set(["cd", "chdir", "pushd", "popd"]);

/** 命令行里真正要执行的可执行名 —— 只看管道前的第一段。 */
function headExecutable(command: string): string {
  // 管道只有**第一段**可能读 stdin：`ps aux | grep nginx` 的 grep 不读 stdin，
  // `cat | grep x` 的 cat 才读。
  const head = command.split("|")[0];
  return (head.trim().split(/\s+/)[0] ?? "").toLowerCase();
}

/** 输出是否会被"吞掉"—— 真被吞掉时不能注入标记。 */
export function blocksCapture(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
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
  /** 是否捕获输出并生成命令结果 Tab（快照 + 原始流）。 */
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
 *
 * 是否捕获由**命令本身**决定（交互式 / 读 stdin / 无输出的内建命令不捕获），
 * 不再有全局开关：需要结果面板的命令一律捕获。
 */
export function planCommandSubmission(command: string, mode: SubmitMode = "full"): CommandPlan {
  const trimmed = command.trim();
  if (!trimmed) {
    return { capture: false, write: "", markers: [], reason: "空命令" };
  }
  // `cd` 家族：不生成结果面板，但照旧注入**结束标记**（唯一目的是拿退出码，
  // 见 `CD_FAMILY` 的说明）。它必须排在 `blocksCapture` 前面。
  if (CD_FAMILY.has(headExecutable(trimmed))) {
    return {
      capture: false,
      write: mode === "full" ? `${trimmed}\n ${MARKER_D_LINE}\n` : ` ${MARKER_D_LINE}\n`,
      markers: [MARKER_D_LINE],
      reason: "cd 家族：只取退出码用于 cwd 追踪，不生成结果面板",
    };
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
