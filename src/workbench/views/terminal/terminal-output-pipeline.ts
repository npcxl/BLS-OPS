/**
 * 输出写出流水线 —— 从 `TerminalView` 抽出的**可测**的一小段。
 *
 * 为什么必须按这个顺序：
 *
 * ```text
 * [输出文本] [OSC 133 D] [下一个提示符] [输出文本] [OSC 133 D]
 *      │          │            │            │           │
 *      │          │            └─ 抓完快照才写            │
 *      │          └─ 快照时机：D 之前的内容全部渲染完       │
 *      └─ 必须等 xterm write callback（渲染完成）再抓快照   │
 * ```
 *
 * 顺序错了，D 后面的提示符就会混进快照尾部；不排队（直接 `instance.write`
 * 然后立刻读 buffer）读到的则是尚未解析的旧内容 —— 所以这里只依赖
 * `write` 返回的 promise（`instance.write(data, callback)` 的 callback），
 * **严禁 setTimeout 猜渲染**。
 *
 * # 一批里有多个结束标记
 *
 * 输出合并后，一次 `feed` 可能吃到**两条命令**的完整输出（D1 和 D2）。
 * 按"第一个 D 之前的 before / 之后的 after"切分会让第二条命令的正文在
 * 抓完第一个快照之后才写入 —— 第二个快照看到的是不完整的内容。
 * 所以这里按**每一个** `output_end` 分段，逐段"写入 → 等渲染 → 抓快照"。
 */

import type { BoundaryPart } from "./command-boundary";

/** 按"输出结束"事件切分：D 之前的文本 / D 之后的文本。 */
export interface SplitOutput {
  before: string;
  after: string;
  /** 本次分块里是否出现了 `output_end`。 */
  sawEnd: boolean;
}

/**
 * 只按**第一个**结束标记切分。
 *
 * 保留给"只关心有没有结束"的调用方；真正写终端请用
 * [`segmentByOutputEnd`] —— 一批里可能有多个结束标记。
 */
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

/** 一个"写到下一个结束标记为止"的文本段。 */
export interface OutputSegment {
  /** 本段要写进终端的文本（可能为空：连续两个 D）。 */
  text: string;
  /** 写完后是否抓快照（这段后面跟着一个 `output_end`）。 */
  captureAfter: boolean;
}

/**
 * 按**每一个** `output_end` 把 parts 切成有序段。
 *
 * `[{text:"a"},{event:D1},{text:"b"},{event:D2}]`
 * → `[{text:"a",captureAfter:true},{text:"b",captureAfter:true}]`
 */
export function segmentByOutputEnd(parts: readonly BoundaryPart[]): OutputSegment[] {
  const segments: OutputSegment[] = [];
  let text = "";
  for (const part of parts) {
    if (part.kind === "text") {
      text += part.text;
      continue;
    }
    if (part.event.type === "output_end") {
      // 即使 text 为空也压一段：每个 D 都要抓一次快照（顺序不能合并）。
      segments.push({ text, captureAfter: true });
      text = "";
    }
  }
  if (text || segments.length === 0) {
    segments.push({ text, captureAfter: false });
  }
  return segments;
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
 * 写出 + 快照：**逐段** before →（等渲染完）→ capture → 下一段。
 *
 * 每个 `output_end` 都有自己的"写入完成 → 抓快照"，不是只处理第一个。
 */
export async function writeOutputParts(
  parts: readonly BoundaryPart[],
  deps: OutputWriteDeps,
): Promise<void> {
  const segments = segmentByOutputEnd(parts);
  for (const segment of segments) {
    if (segment.text) {
      await deps.write(segment.text);
    } else if (segment.captureAfter) {
      // 结束标记紧跟前一段（或单独成块）：先等此前排队的写入渲染完。
      await deps.flush();
    }
    if (segment.captureAfter) deps.capture();
  }
}
