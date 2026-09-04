/**
 * 远程当前目录（cwd）追踪 —— 终端补全的"我在哪儿"。
 *
 * # 为什么不能从提示符猜
 *
 * `root@host:~#` 这种文本是**人看的装饰**：PS1 可能被改成一个表情，也可能
 * 只显示 basename，更可能压根不带路径。拿它当 cwd 会在错误的目录下列目录，
 * 而用户看到的候选是"这台机器上根本不存在"的东西 —— 比不补全更糟。
 *
 * 所以 cwd 只来自四条可信来源，按优先级：
 *
 * 1. **Shell Integration 的 OSC 7**（shell 自己上报，最准）；
 * 2. **SSH 会话维护的 cwd 状态**（我们跟踪用户显式执行的 `cd`，且**只有
 *    命令真的成功**才更新）；
 * 3. **受控 pwd 探测**（前两条都没有时才用，见 `CWD_PROBE_LINE`）；
 * 4. 都没有 → `unknown`：补全如实告知"不知道当前目录"，绝不猜、绝不读本地。
 *
 * 每个 SSH 会话一份状态（按 sessionId），切 Tab 互不干扰。
 */

import { normalizeRemotePath } from "./completion/path-input";

/** cwd 的来源。 */
export type CwdSource = "osc7" | "tracked" | "probe" | "home" | "unknown";

export interface CwdState {
  path: string | null;
  source: CwdSource;
  /** 上一次的目录，供 `cd -` 使用。 */
  previous: string | null;
  /** 已提交但还没确认成功的 `cd` 目标。 */
  pending: string | null;
}

const EMPTY: CwdState = { path: null, source: "unknown", previous: null, pending: null };

// -- OSC 7 ------------------------------------------------------------------

/**
 * OSC 7：`ESC ] 7 ; file://<host>/<path> (BEL | ST)`。
 *
 * 路径是 percent-encoded（空格是 `%20`，中文是 `%E4%B8%AD`），必须解码。
 */
const OSC_7 = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/;

/** 从一段输出里取出 OSC 7 上报的目录；没有则 null。 */
export function parseOsc7(text: string): string | null {
  const match = OSC_7.exec(text);
  if (!match) return null;
  return decodeOsc7Path(match[1]);
}

/**
 * 解析 OSC 7 的 URI 部分。
 *
 * `file://host/path` → `/path`；本地形式 `file:///path` 同样支持。主机名里
 * 的冒号（IPv6）会让 `split("/")` 出错，所以按"第三个斜杠之后"切。
 */
export function decodeOsc7Path(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed) return null;
  let rest = trimmed;
  if (rest.startsWith("file://")) rest = rest.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const path = rest.slice(slash);
  if (!path.startsWith("/")) return null;
  try {
    return normalizeRemotePath(decodeURIComponent(path));
  } catch {
    // 畸形编码（单个 % 之类）：解码失败时退回原文，至少目录还能用。
    return normalizeRemotePath(path);
  }
}

/**
 * 流式 OSC 7 扫描器。
 *
 * 一块 SSH 数据完全可能把序列切成两半（`…file://host/et` + `c/nginx\x1b\\`），
 * 所以要跨 chunk 缓存"半个序列"。
 */
export class Osc7Scanner {
  private buffer = "";

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const found: string[] = [];

    for (;;) {
      const start = this.buffer.indexOf("\x1b]7;");
      if (start === -1) {
        // 只保留可能是"半个序列头部"的尾巴，避免无限增长。
        this.buffer = tailPartial(this.buffer);
        return found;
      }
      const end = findTerminator(this.buffer, start + 4);
      if (end === -1) {
        this.buffer = this.buffer.slice(start);
        return found;
      }
      const path = decodeOsc7Path(this.buffer.slice(start + 4, end));
      if (path) found.push(path);
      this.buffer = this.buffer.slice(end + 1);
    }
  }
}

/** 序列终结符：BEL 或 ST（`ESC \`）。 */
function findTerminator(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\x07") return i;
    if (text[i] === "\x1b" && text[i + 1] === "\\") return i;
  }
  return -1;
}

/** 保留缓冲区尾部"可能是 OSC 7 前缀"的部分。 */
function tailPartial(text: string): string {
  const marker = "\x1b]7;";
  for (let length = Math.min(marker.length - 1, text.length); length > 0; length -= 1) {
    if (marker.startsWith(text.slice(text.length - length))) {
      return text.slice(text.length - length);
    }
  }
  return text.endsWith("\x1b") ? "\x1b" : "";
}

// -- cd 解析 ----------------------------------------------------------------

/**
 * 取出 `cd` 命令的参数（去引号、去转义）。
 *
 * 支持：`cd`、`cd ~`、`cd -`、`cd ../..`、`cd /abs`、`cd "path with spaces"`。
 * 不是 cd 命令（或带 `&&`/`;` 的复合命令）返回 null —— 复合命令的成功与否
 * 不能代表 `cd` 成功，不能拿它更新 cwd。
 */
export function parseCdArgument(command: string): string | null {
  const match = /^cd(?:\s+([\s\S]*))?$/.exec(command.trim());
  if (!match) return null;
  const raw = (match[1] ?? "").trim();
  // 复合命令的退出码代表整条流水线，不能证明 `cd` 成功 —— 宁可不跟踪，
  // 也不能把 cwd 更新到一个根本没进去的目录。
  if (raw !== "" && /&&|\|\||[;|]|\n/.test(raw)) return null;
  if (raw === "") return ""; // 裸 `cd` = 回家目录
  return unquoteArgument(raw);
}

/** 去掉一层包裹引号并解开反斜杠转义。 */
export function unquoteArgument(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.endsWith(first) && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    return first === "'" ? inner : unescapeShell(inner);
  }
  return unescapeShell(trimmed);
}

function unescapeShell(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && i + 1 < text.length) {
      out += text[i + 1];
      i += 1;
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * 把 cd 参数解析成绝对路径。
 *
 * 返回 `null` 表示"解析不出来"（家目录未知 / 参数形态不支持），调用方必须
 * 如实告知用户，**不能拿当前目录顶替**。
 */
export function resolveCd(
  current: string | null,
  arg: string,
  home: string | null,
  previous: string | null,
): string | null {
  if (arg === "-") return previous;
  if (arg === "" || arg === "~" || arg.startsWith("~/")) {
    if (home === null) return null;
    if (arg === "" || arg === "~") return home;
    return normalizeRemotePath(`${home.replace(/\/+$/, "")}/${arg.slice(2)}`);
  }
  if (arg.startsWith("/")) return normalizeRemotePath(arg);
  if (current === null) return null;
  return normalizeRemotePath(`${current.replace(/\/+$/, "")}/${arg}`);
}

// -- 受控 pwd 探测 ----------------------------------------------------------

/**
 * 受控 pwd 探测行。
 *
 * 让 **shell 自己**把 cwd 以 OSC 7 报回来（不是我们解析提示符）。三点保证：
 * - 前导空格：bash/zsh 的 `HISTCONTROL=ignorespace` 下不进命令历史；
 * - `printf` 只输出 OSC 序列，**不产生任何可见文字**；
 * - 整行作为"注入行"交给 `CommandBoundaryParser.expect()`，终端回显会被
 *   剔除，用户看不到这行命令。
 *
 * 仍然会多出一个新的提示符行（按了回车），这是唯一可观察的痕迹。
 */
export const CWD_PROBE_LINE =
  " printf '\\033]7;file://%s%s\\033\\\\' \"$HOSTNAME\" \"$PWD\"";

/** 探测超时：超时即放弃，不无限重试。 */
export const CWD_PROBE_TIMEOUT_MS = 2500;

// -- 追踪器 ----------------------------------------------------------------

/**
 * 每个 SSH 会话一份 cwd 状态。
 *
 * 用法（TerminalView）：
 * - 连接成功 → `setHome(sessionId, home)`（登录目录，兜底用）；
 * - 收到输出 → `osc7Scanner.feed()` → `setFromOsc7()`；
 * - 提交命令 → `noteCd(sessionId, command)`；
 * - 命令结束（OSC 133 D 的退出码）→ `onCommandEnd(sessionId, exitCode)`。
 */
export class RemoteCwdTracker {
  private states = new Map<string, CwdState>();
  private scanners = new Map<string, Osc7Scanner>();
  /** 登录/家目录单独存：它是"兜底答案"，不是"追踪到的目录"。 */
  private homes = new Map<string, string>();

  /** 扫描某个会话的输出流，返回本次上报的所有目录（取最后一个）。 */
  feedOutput(sessionId: string, chunk: string): string | null {
    let scanner = this.scanners.get(sessionId);
    if (!scanner) {
      scanner = new Osc7Scanner();
      this.scanners.set(sessionId, scanner);
    }
    const paths = scanner.feed(chunk);
    const last = paths[paths.length - 1] ?? null;
    if (last) this.setFromOsc7(sessionId, last);
    return last;
  }

  /** Shell Integration 上报：最高优先级，无条件覆盖。 */
  setFromOsc7(sessionId: string, path: string): void {
    const state = this.stateOf(sessionId);
    const previous = state.path ?? state.previous;
    this.states.set(sessionId, {
      path,
      source: "osc7",
      previous,
      // OSC 7 是权威结果，任何待定的 cd 都作废。
      pending: null,
    });
  }

  /** 受控探测的结果。 */
  setFromProbe(sessionId: string, path: string): void {
    const state = this.stateOf(sessionId);
    // OSC 7 已经给过答案就不覆盖（优先级 1 > 3）。
    if (state.source === "osc7") return;
    this.states.set(sessionId, {
      path,
      source: "probe",
      previous: state.path ?? state.previous,
      pending: null,
    });
  }

  /** 当前目录（`null` = 还不知道）。 */
  get(sessionId: string): string | null {
    return this.stateOf(sessionId).path;
  }

  /** 家目录（`null` = 还不知道）。 */
  home(sessionId: string): string | null {
    return this.homes.get(sessionId) ?? null;
  }

  /** 登录目录（连接成功后由 SFTP 侧拿到），仅作兜底。 */
  setHome(sessionId: string, home: string): void {
    this.homes.set(sessionId, home);
    const state = this.stateOf(sessionId);
    if (state.path !== null) return;
    this.states.set(sessionId, { ...state, path: home, source: "home" });
  }

  /**
   * 用户提交了一条命令：如果是 `cd`，记下待定目标（还没确认成功）。
   *
   * 复合命令（`cd /x && ls`）不算 —— 它的退出码不能代表 `cd` 成功。
   */
  noteCd(sessionId: string, command: string): void {
    const arg = parseCdArgument(command);
    if (arg === null) return;
    const state = this.stateOf(sessionId);
    const target = resolveCd(state.path, arg, this.home(sessionId), state.previous);
    this.states.set(sessionId, { ...state, pending: target });
  }

  /**
   * 命令结束：`cd` 成功（退出码 0）才更新 cwd，失败一律不更新。
   *
   * `exitCode` 为 `null`（shell 没上报）时保守起见**不更新**追踪值 —— 但
   * 会清掉待定目标，避免它污染下一次判定。
   */
  onCommandEnd(sessionId: string, exitCode: number | null): void {
    const state = this.stateOf(sessionId);
    const pending = state.pending;
    if (pending === null) return;
    if (exitCode !== 0) {
      // cd 失败：目录没变，待定目标作废。
      this.states.set(sessionId, { ...state, pending: null });
      return;
    }
    const previous = state.path ?? state.previous;
    this.states.set(sessionId, {
      path: pending,
      source: "tracked",
      previous,
      pending: null,
    });
  }

  stateOf(sessionId: string): CwdState {
    return this.states.get(sessionId) ?? { ...EMPTY };
  }

  /** 是否需要受控探测（前两条来源都没有答案）。 */
  needsProbe(sessionId: string): boolean {
    const state = this.stateOf(sessionId);
    return state.path === null || state.source === "home";
  }

  /** 断开连接 / 切换目标：整个会话的状态一起丢掉。 */
  forget(sessionId: string): void {
    this.states.delete(sessionId);
    this.scanners.delete(sessionId);
    this.homes.delete(sessionId);
  }
}
