import { describe, expect, it } from "vitest";
import { activeMatchIndex } from "../cm-search";

/**
 * 只测纯函数部分。`matchRanges` / apply / replace 需要真实 EditorView，
 * 交给组件测试或人工冒烟——为它们伪造 DOM 会测到 jsdom 而不是搜索逻辑。
 */
describe("activeMatchIndex（VSCode 式 N/M 计数）", () => {
  const ranges = [
    { from: 0, to: 3 },
    { from: 10, to: 13 },
    { from: 20, to: 23 },
  ];

  /** 最小替身：只需要 selection.main.from。 */
  const viewAt = (from: number) =>
    ({ state: { selection: { main: { from } } } }) as never;

  it("没有匹配时返回 -1", () => {
    expect(activeMatchIndex(viewAt(0), [])).toBe(-1);
  });

  it("光标正好停在某个匹配起点时返回该序号", () => {
    expect(activeMatchIndex(viewAt(0), ranges)).toBe(0);
    expect(activeMatchIndex(viewAt(10), ranges)).toBe(1);
    expect(activeMatchIndex(viewAt(20), ranges)).toBe(2);
  });

  it("光标在匹配之间时取后一个匹配（与跳转后行为一致）", () => {
    expect(activeMatchIndex(viewAt(5), ranges)).toBe(1);
    expect(activeMatchIndex(viewAt(15), ranges)).toBe(2);
  });

  it("光标超过所有匹配时回绕到第一个", () => {
    expect(activeMatchIndex(viewAt(100), ranges)).toBe(0);
  });

  it("光标在首个匹配之前时算第一个", () => {
    expect(activeMatchIndex(viewAt(-1), ranges)).toBe(0);
  });
});
