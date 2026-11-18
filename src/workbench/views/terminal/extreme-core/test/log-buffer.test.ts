import { describe, expect, it } from "vitest";
import { appendChunk, emptyBuffer, filterLines, visibleLines } from "../log-buffer";

describe("日志缓冲", () => {
  it("跨块的半行会接上，不会拆出半行", () => {
    let buffer = appendChunk(emptyBuffer(), "第一行\n第二");
    expect(buffer.lines).toEqual(["第一行"]);
    expect(buffer.partial).toBe("第二");
    buffer = appendChunk(buffer, "行\n第三行\n");
    expect(buffer.lines).toEqual(["第一行", "第二行", "第三行"]);
    expect(buffer.partial).toBe("");
  });

  it("一个汉字被劈成两个字节块也不会乱码", () => {
    // 模拟 SSH 把 "日" 的 UTF-8 拆到两个块里。
    let buffer = appendChunk(emptyBuffer(), "日");
    buffer = appendChunk(buffer, "志\n");
    expect(buffer.lines).toEqual(["日志"]);
  });

  it("超过上限丢旧行并计数", () => {
    let buffer = emptyBuffer();
    for (let index = 0; index < 10; index += 1) {
      buffer = appendChunk(buffer, `line-${index}\n`, 5);
    }
    expect(buffer.lines).toHaveLength(5);
    expect(buffer.lines[4]).toBe("line-9");
    expect(buffer.dropped).toBe(5);
  });

  it("空块不改变缓冲", () => {
    const buffer = appendChunk(emptyBuffer(), "a\n");
    expect(appendChunk(buffer, "")).toBe(buffer);
  });

  it("过滤大小写不敏感", () => {
    const lines = ["GET /index", "error: boom", "POST /x"];
    expect(filterLines(lines, "ERROR")).toEqual(["error: boom"]);
    expect(filterLines(lines, "  ")).toBe(lines);
  });

  it("只渲染尾部若干行", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `l${index}`);
    expect(visibleLines(lines, 3)).toEqual(["l7", "l8", "l9"]);
    expect(visibleLines(lines, 99)).toBe(lines);
  });
});
