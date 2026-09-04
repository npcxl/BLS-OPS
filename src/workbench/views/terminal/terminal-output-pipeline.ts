/**
 * 输出写出流水线 —— 从 `TerminalView` 抽出的**可测**的一小段。
 *
 * 为什么必须按这个顺序：
 *
 * ```text
 * [输出文本] [OSC 133 D] [下一个提示符]
 *      │          │            │
 *      │          │            └─ after：快照抓完**之后**才写
 *      │          └─ 快照时机：D 之前的内容全部**渲染完**
 *      └─ before：必须等 xterm write callback（渲染完成）再抓快照
 * ```
 *
 * 顺序错了，D 后面的提示符就会混进快照尾部；不排队（直接 `instance.write`
 * 然后立刻读 buffer）读到的则是尚未解析的旧内容 —— 所以这里只依赖
 * `write` 返回的 promise（`instance.write(data, callback)` 的 callback），
 * **严禁 setTimeout 猜渲染**。
 */

import type { BoundaryPart } from "./command-boundary";

/** 按"输出结束"事件切分：D 之前的文本 / D 之后的文本。 */
export interface SplitOutput {
  before: string;
  after: string;
  /** 本次分块里是否出现了 `output_end`。 */
  sawEnd: boolean;
}

export function splitAtOutputEnd(parts: readonly BoundaryPart[]): SplitOutput {
  let before = "";
  let after = "";
  let sawEnd = false;
  for (const part of parts) {
    if (part.kind === "text") {
      if (sawEnd) after += part.text;
      else before += part.text;
    } else if (part.event.type === "output_end") {
      sawEnd = true;
    }
  }
  return { before, after, sawEnd };
}

export interface OutputWriteDeps {
  /** 写进 xterm（**必须**是队列化写入，返回"渲染完成"的 promise）。 */
  write: (text: string) => Promise<void>;
  /** 等待队列里此前已排队的所有写入渲染完（本次没有可写文本时用它）。 */
  flush: () => Promise<void>;
  /** D 之前内容渲染完 → 抓快照（由调用方去读 xterm buffer）。 */
  capture: () => void;
}

/**
 * 写出 + 快照：before →（等渲染完）→ capture → after。
 *
 * 没有结束标记时只写文本、不抓快照（命令还在输出）。
 */
export async function writeOutputParts(
  parts: readonly BoundaryPart[],
  deps: OutputWriteDeps,
): Promise<void> {
  const { before, after, sawEnd } = splitAtOutputEnd(parts);
  if (!sawEnd) {
    await deps.write(before);
    return;
  }
  if (before) await deps.write(before);
  else await deps.flush(); // 结束标记单独成块：等此前排队的写入渲染完
  deps.capture();
  if (after) await deps.write(after);
}
