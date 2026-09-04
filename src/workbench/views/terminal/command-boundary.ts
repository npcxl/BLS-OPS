/**
 * 命令边界 —— **用明确的受控标记取代"静默 400ms 猜命令结束了"**。
 *
 * # 为什么不再用静默时间
 *
 * 静默计时有两个致命缺陷：
 * - 慢命令（`sleep 5 && echo done`、分两批输出的长任务）会在第一批之后
 *   就被判定结束，输出被截断；
 * - 输出密集的命令（编译、日志流）永远等不到静默，只能靠硬超时截断。
 *
 * 两者都会让"命令结果"与终端里真实看到的输出不一致。
 *
 * # 方案：受控标记（OSC 133 Shell Integration）
 *
 * 提交命令时**我们自己**往 shell 里写两行受控标记（不改变用户命令本身）：
 *
 * ```text
 *  printf '\033]133;C\007'      → OSC 133 C：输出开始
 *  <用户命令>
 *  printf '\033]133;D;%d\007' $? → OSC 133 D：输出结束 + 退出码
 * ```
 *
 * 于是五个量全部是**测出来的**，不是猜的：
 *
 * | 量           | 来源                                   |
 * | ------------ | -------------------------------------- |
 * | command start| 提交时刻（`Date.now()`）                |
 * | output start | 收到 OSC 133 C                          |
 * | output end   | 收到 OSC 133 D                          |
 * | exit code    | OSC 133 D 的参数（`$?`）                |
 * | duration     | output end − command start              |
 *
 * 标记行由 shell 回显回终端，所以这里同时负责**把它们的回显从流里剔除** ——
 * 用户看到的仍然是：命令回显 + 真实输出。
 *
 * # 失败怎么办
 *
 * 标记缺失（shell 不支持 `printf` / 命令吞掉了 stdin）时**不猜**：由协调器的
 * 兜底定时器收场，并在结果里给出可见说明。兜底不是边界判定，只是护栏。
 */

/**
 * 一段按事件切分的内容：
 *
 * - `text` 段：清洗后的文本（已剔除 OSC 标记与注入行回显）—— 写进 xterm；
 * - `event` 段：该事件位于前后两段文本**之间**，本身没有可见内容。
 *
 * 用 `parts` 顺序驱动写终端，就能在 `output_end` 处**先截快照再写后续**
 * （否则 D 标记之后的提示符会混进快照尾部）。`text` / `events` 字段是
 * `parts` 的等价投影，保留给只看整体结果的旧调用方。
 */
export type BoundaryPart =
  | { kind: "text"; text: string }
  | { kind: "event"; event: BoundaryEvent };

/** 一次边界解析的产物。 */
export interface BoundaryParse {
  /** 清洗后的文本（已剔除 OSC 标记与注入行回显）—— 直接写进 xterm。 */
  text: string;
  events: BoundaryEvent[];
  /** 按事件切分的段落（文本与事件按原始字节顺序交错）。 */
  parts: BoundaryPart[];
}

export type BoundaryEvent =
  /** OSC 133 B：命令开始执行。 */
  | { type: "command_start" }
  /** OSC 133 C：其后所有内容都是命令输出。 */
  | { type: "output_start" }
  /** OSC 133 D：输出结束，带真实退出码。 */
  | { type: "output_end"; exitCode: number | null };

/** printf 认识的字面量 —— 写进 shell 的是 `\033` 四个字符，不是真 ESC。 */
const ESC_LITERAL = "\\033";
const BEL_LITERAL = "\\007";

/** 注入的"输出开始"标记行（OSC 133 C）。 */
export const MARKER_C_LINE = `printf '${ESC_LITERAL}]133;C${BEL_LITERAL}'`;
/** 注入的"输出结束"标记行（OSC 133 D，退出码来自 `$?`）。 */
export const MARKER_D_LINE = `printf '${ESC_LITERAL}]133;D;%d${BEL_LITERAL}' $?`;
/** 两条注入行（提交时带前导空格，尽量不进 shell 历史）。 */
export const INJECTED_LINES: string[] = [MARKER_C_LINE, MARKER_D_LINE];

/** OSC 133 序列：`ESC ] 133 ; <字母> [ ; <数字> ] (BEL | ST)`。 */
const OSC_133 = /\x1b\]133;([A-Z])(?:;(-?\d+))?(?:\x07|\x1b\\)/;

/**
 * OSC 133 的**任意前缀**（用于判断缓冲区尾部是不是"半个标记"）。
 *
 * 一块 SSH 数据完全可能把一个 20 字节的标记切成两半；不处理就会把
 * `\x1b]133;D;0\x07` 当成普通输出显示给用户看。
 */
const OSC_PREFIX =
  /^(?:\x1b(?:\](?:1(?:3(?:3(?:;(?:[A-Z](?:;(?:-?\d*(?:\x1b\\?)?)?)?)?)?)?)?)?)?)?$/;

/** 可能"还没到齐"的最大尾部长（注入行最长不到 40 字符，留足余量）。 */
const MAX_PARTIAL = 128;

interface Hit {
  start: number;
  end: number;
  event: BoundaryEvent | null;
}

function eventOf(letter: string, code: string | undefined): BoundaryEvent | null {
  switch (letter) {
    case "B":
      return { type: "command_start" };
    case "C":
      return { type: "output_start" };
    case "D": {
      const parsed = code === undefined ? Number.NaN : Number.parseInt(code, 10);
      return { type: "output_end", exitCode: Number.isFinite(parsed) ? parsed : null };
    }
    default:
      // A（提示符开始）等暂不参与结果判定。
      return null;
  }
}

/** 在缓冲区里找**最早**的一处待处理内容（OSC 标记或注入行回显）。 */
function findEarliest(buffer: string, injections: string[]): Hit | null {
  let best: Hit | null = null;

  const match = OSC_133.exec(buffer);
  if (match) {
    best = {
      start: match.index,
      end: match.index + match[0].length,
      event: eventOf(match[1], match[2]),
    };
  }

  for (const line of injections) {
    const at = buffer.indexOf(line);
    if (at < 0) continue;
    // 注入时带的前导空格（躲 shell 历史）也是回显的一部分，一并吃掉。
    let start = at;
    while (start > 0 && buffer[start - 1] === " ") start -= 1;
    let end = at + line.length;
    // 回显自带换行（终端是 \r\n），也要吃掉，否则终端会留一个空行。
    if (buffer[end] === "\r") end += 1;
    if (buffer[end] === "\n") end += 1;
    if (!best || start < best.start) {
      best = { start, end, event: null };
    }
  }
  return best;
}

function isPartial(tail: string, injections: string[]): boolean {
  if (tail.length === 0) return false;
  if (OSC_PREFIX.test(tail)) return true;
  // 注入行的任意前缀（含前导空格的情况）。
  return injections.some((line) => line.startsWith(tail) || ` ${line}`.startsWith(tail));
}

/**
 * 终端输出流的边界解析器。
 *
 * 用法：每次收到 SSH 输出块 → `feed(chunk)` → 拿 `text` 写进 xterm、拿
 * `events` 喂给协调器。**必须先于 xterm 处理**，否则用户会看到标记。
 */
export class CommandBoundaryParser {
  private buffer = "";
  private injections: string[] = [];

  /**
   * 声明本次提交注入了哪些标记行（它们的回显要从流里剔除）。
   * 没注入标记（交互式命令 / 不支持的 shell）时传空数组。
   */
  expect(lines: string[]): void {
    this.injections = lines;
  }

  feed(chunk: string): BoundaryParse {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** 流结束 / 连接断开：强制吐出残留（不再等"半个标记"）。 */
  flush(): BoundaryParse {
    return this.drain(true);
  }

  private drain(last: boolean): BoundaryParse {
    const parts: BoundaryPart[] = [];
    const events: BoundaryEvent[] = [];
    let accumulated = "";
    let buffer = this.buffer;

    const flushText = () => {
      if (accumulated !== "") {
        parts.push({ kind: "text", text: accumulated });
        accumulated = "";
      }
    };
    const pushEvent = (event: BoundaryEvent) => {
      // 事件发生在它前面的文本**之后** —— 先落文本段再落事件段。
      flushText();
      parts.push({ kind: "event", event });
      events.push(event);
    };

    for (;;) {
      const hit = findEarliest(buffer, this.injections);
      if (!hit) break;
      accumulated += buffer.slice(0, hit.start);
      if (hit.event) {
        pushEvent(hit.event);
      }
      // 注入行回显（无事件）：整段被剔除，不产生任何可见部分。
      buffer = buffer.slice(hit.end);
    }

    // 尾部可能只是"半个标记"——留到下一块再判（前缀的前缀仍是前缀，
    // 所以从最长的候选开始找，命中最长的那个就是要留下的长度）。
    let keep = 0;
    if (!last) {
      const limit = Math.min(buffer.length, MAX_PARTIAL);
      for (let length = limit; length > 0; length -= 1) {
        if (isPartial(buffer.slice(buffer.length - length), this.injections)) {
          keep = length;
          break;
        }
      }
    }

    const tail = keep > 0 ? buffer.slice(0, buffer.length - keep) : buffer;
    if (tail !== "") accumulated += tail;
    this.buffer = keep > 0 ? buffer.slice(buffer.length - keep) : "";
    flushText();

    // text / events 是 parts 的等价投影（保留旧调用方契约）。
    const text = parts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join("");
    return { text, events, parts };
  }
}
