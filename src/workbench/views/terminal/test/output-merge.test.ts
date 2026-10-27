/**
 * 输出合并的**核心不变量**。
 *
 * `use-terminal-session` 把同一轮事件循环里的多个 SSH 块拼起来再处理。
 * 这只有在"拼接后解析 == 逐块解析"时才安全 —— 否则 OSC 133 命令边界、
 * 标记剔除、文本顺序都会变。
 *
 * 这里直接对解析器做等价性验证，不依赖 xterm / Tauri IPC。
 */

import { describe, expect, it } from "vitest";

import { CommandBoundaryParser, type BoundaryPart } from "../command-boundary";

/** 把 parts 压成"文本 + 事件"的线性序列，便于比较不同分段方式。 */
function linear(parts: BoundaryPart[]): string {
  return parts
    .map((part) => (part.kind === "text" ? part.text : `<${part.event.type}>`))
    .join("");
}

describe("输出合并", () => {
  it("分块 feed 与一次性 feed 的文本、事件顺序完全一致", () => {
    const chunks = [
      "step one\r\n",
      "\x1b]133;D;0\x07",
      "prompt$ ",
      "step two\r\n",
      "\x1b]133;D;1\x07",
    ];

    const streamed = new CommandBoundaryParser();
    const perChunk = chunks.map((chunk) => streamed.feed(chunk));

    const merged = new CommandBoundaryParser();
    const once = merged.feed(chunks.join(""));

    expect(once.text).toBe(perChunk.map((part) => part.text).join(""));
    expect(once.events).toEqual(perChunk.flatMap((part) => part.events));
    expect(linear(once.parts)).toBe(perChunk.map((part) => linear(part.parts)).join(""));
  });

  it("标记被切在两个块之间时，合并不会让它漏进可见文本", () => {
    // OSC 133 D 从中间被拆开：逐块 feed 时解析器必须自己把它拼起来。
    const chunks = ["output\r\n\x1b]13", "3;D;0\x07", "prompt$ "];

    const streamed = new CommandBoundaryParser();
    const perChunk = chunks.map((chunk) => streamed.feed(chunk));

    const merged = new CommandBoundaryParser();
    const once = merged.feed(chunks.join(""));

    const visible = perChunk.map((part) => part.text).join("");
    expect(visible).not.toContain("133;D");
    expect(once.text).toBe(visible);
    expect(once.events).toEqual(perChunk.flatMap((part) => part.events));
  });

  it("尾部半截标记在合并后仍保持未完成状态（不能提前当文本写出）", () => {
    const chunks = ["done\r\n\x1b]133;D"];

    const merged = new CommandBoundaryParser();
    const once = merged.feed(chunks.join(""));
    // 没有 BEL 终止符：解析器应当把它留在缓冲区，而不是写进终端。
    expect(once.text).not.toContain("133;D");

    // 下一块补上终止符 → 事件才出现。
    const rest = merged.feed(";0\x07");
    expect(rest.events.some((event) => event.type === "output_end")).toBe(true);
    expect(rest.text).not.toContain("133;D");
  });
});
