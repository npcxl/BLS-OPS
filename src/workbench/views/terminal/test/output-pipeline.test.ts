/**
 * 输出写出流水线：**一批里有多个结束标记**时的顺序。
 *
 * 合并输出后，一次 `feed` 可能吃到两条命令的完整输出（D1 + D2）。
 * 旧实现只按第一个 D 切分，第二条命令的正文会在抓完第一个快照之后才写 ——
 * 第二个快照看到的是不完整内容。这里钉住"每个 D 都有独立的写入→抓快照"。
 */

import { describe, expect, it } from "vitest";

import type { BoundaryPart } from "../command-boundary";
import {
  segmentByOutputEnd,
  writeOutputParts,
  type OutputWriteDeps,
} from "../terminal-output-pipeline";

const text = (value: string): BoundaryPart => ({ kind: "text", text: value });
const end = (code = 0): BoundaryPart =>
  ({ kind: "event", event: { type: "output_end", exitCode: code } }) as unknown as BoundaryPart;

function harness() {
  const log: string[] = [];
  const deps: OutputWriteDeps = {
    write: async (value) => {
      log.push(`write:${value}`);
    },
    flush: async () => {
      log.push("flush");
    },
    capture: () => {
      log.push("capture");
    },
  };
  return { log, deps };
}

describe("输出流水线", () => {
  it("按每个结束标记分段", () => {
    expect(segmentByOutputEnd([text("a"), end(), text("b"), end()])).toEqual([
      { text: "a", captureAfter: true },
      { text: "b", captureAfter: true },
    ]);
  });

  it("两个结束标记：写一段 → 抓一次快照，再写下一段 → 再抓一次", async () => {
    const { log, deps } = harness();
    await writeOutputParts([text("a"), end(), text("b"), end()], deps);
    expect(log).toEqual(["write:a", "capture", "write:b", "capture"]);
  });

  it("没有结束标记：只写文本，不抓快照", async () => {
    const { log, deps } = harness();
    await writeOutputParts([text("running...")], deps);
    expect(log).toEqual(["write:running..."]);
  });

  it("连续两个结束标记：中间没有文本也要各抓一次", async () => {
    const { log, deps } = harness();
    await writeOutputParts([text("a"), end(), end()], deps);
    // 第二段没有文本 → 先 flush 等此前写入渲染完，再抓快照。
    expect(log).toEqual(["write:a", "capture", "flush", "capture"]);
  });

  it("刚好以结束标记收尾：最后一段空文本不产生多余写入", async () => {
    const { log, deps } = harness();
    await writeOutputParts([text("a"), end()], deps);
    expect(log).toEqual(["write:a", "capture"]);
  });
});
