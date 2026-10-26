/**
 * 编辑器搜索的扫描语义。
 *
 * 这里钉的是"性能修复没有改变正确性"：
 * 1. 有上限，且必须**明确标记**被截断（不能把下限伪装成精确总数）；
 * 2. 空查询不算匹配；
 * 3. 当前序号只在已有区间里定位 —— 光标移动不该重新扫全文。
 */

import { EditorSelection, EditorState } from "@uiw/react-codemirror";
import { SearchQuery } from "@codemirror/search";
import { describe, expect, it } from "vitest";

import { activeMatchIndex, matchRanges, scanChunk, scanMatches } from "../cm-search";

const target = (doc: string, cursor = 0) => ({
  state: EditorState.create({ doc, selection: EditorSelection.single(cursor) }),
});

const query = (search: string, caseSensitive = false) => new SearchQuery({ search, caseSensitive });

describe("匹配扫描", () => {
  it("到达上限就停止，并标记 truncated", () => {
    const scan = scanMatches(target("x ".repeat(10)), query("x"), 3);
    expect(scan.ranges).toHaveLength(3);
    expect(scan.truncated).toBe(true);
    // 前三个区间必须仍然正确（不能为了快而乱给位置）。
    expect(scan.ranges.map((range) => range.from)).toEqual([0, 2, 4]);
  });

  it("没到上限时 truncated 为假（界面显示精确数字）", () => {
    const scan = scanMatches(target("x ".repeat(10)), query("x"), 50);
    expect(scan.ranges).toHaveLength(10);
    expect(scan.truncated).toBe(false);
  });

  it("空查询不产生匹配", () => {
    expect(scanMatches(target("anything"), query(""))).toEqual({ ranges: [], truncated: false });
  });

  it("大小写选项影响扫描结果", () => {
    expect(matchRanges(target("Abc abc"), query("abc", false))).toHaveLength(2);
    expect(matchRanges(target("Abc abc"), query("abc", true))).toHaveLength(1);
  });

  it("当前序号在已有区间上定位：光标在匹配上取该匹配", () => {
    const ranges = matchRanges(target("a b a b a"), query("a"));
    expect(ranges).toHaveLength(3);
    expect(activeMatchIndex(target("a b a b a", 0), ranges)).toBe(0);
    expect(activeMatchIndex(target("a b a b a", 4), ranges)).toBe(1);
  });

  it("光标越过最后一个匹配时回绕到第一个（与 VSCode 一致）", () => {
    const doc = "a b a";
    const ranges = matchRanges(target(doc), query("a"));
    expect(activeMatchIndex(target(doc, doc.length), ranges)).toBe(0);
  });

  it("没有匹配时序号为 -1", () => {
    expect(activeMatchIndex(target("abc", 0), [])).toBe(-1);
  });

  it("大文件 + 零命中：分块能扫完，不会一次扫全文", () => {
    // 200 KiB，没有任何 "zzzz"。默认块 64 KiB → 至少 4 轮。
    const doc = "x".repeat(200 * 1024);
    const state = target(doc);
    let position = 0;
    let lastFrom = -1;
    let rounds = 0;
    for (;;) {
      const chunk = scanChunk(state, query("zzzz"), position, { lastFrom });
      expect(chunk.ranges).toHaveLength(0);
      position = chunk.position;
      rounds += 1;
      if (chunk.done) break;
      expect(rounds).toBeLessThan(50);
    }
    expect(position).toBe(doc.length);
    expect(rounds).toBeGreaterThan(1);
  });

  it("分块扫描与整篇扫描结果一致（含跨块匹配、不重复）", () => {
    // 故意用很小的块和重叠，逼出跨块场景。
    const doc = "abc 123 abc 456 abc 789 abc";
    const full = matchRanges(target(doc), query("abc"));

    let position = 0;
    let lastFrom = -1;
    const collected: { from: number; to: number }[] = [];
    for (;;) {
      const chunk = scanChunk(target(doc), query("abc"), position, {
        chunkChars: 7,
        overlapChars: 4,
        lastFrom,
      });
      collected.push(...chunk.ranges);
      if (chunk.ranges.length > 0) lastFrom = chunk.ranges[chunk.ranges.length - 1].from;
      position = chunk.position;
      if (chunk.done) break;
    }
    expect(collected).toEqual(full);
  });

  it("跨块边界的匹配不会被漏掉（长度 ≤ 重叠区）", () => {
    // 块 6、重叠 4：把 "abcdef" 切成若干段，"cdef" 必然跨边界。
    const doc = "xxabcdefyy";
    let position = 0;
    let lastFrom = -1;
    const collected: { from: number; to: number }[] = [];
    for (;;) {
      const chunk = scanChunk(target(doc), query("cdef"), position, {
        chunkChars: 6,
        overlapChars: 4,
        lastFrom,
      });
      collected.push(...chunk.ranges);
      if (chunk.ranges.length > 0) lastFrom = chunk.ranges[chunk.ranges.length - 1].from;
      position = chunk.position;
      if (chunk.done) break;
    }
    expect(collected).toEqual(matchRanges(target(doc), query("cdef")));
  });

  it("结果被截断且光标越过已扫描范围时，不回绕成第 1 个", () => {
    const doc = "a ".repeat(5);
    const scan = scanMatches(target(doc), query("a"), 3);
    expect(scan.truncated).toBe(true);
    // 光标在最后一个已扫描匹配之后：真实位置是"第 4 个"，不能显示成 1。
    const index = activeMatchIndex(target(doc, doc.length), scan.ranges, true);
    expect(index).toBe(scan.ranges.length);
    // 未截断时仍然保持回绕语义（VSCode 行为）。
    expect(activeMatchIndex(target(doc, doc.length), scan.ranges, false)).toBe(0);
  });
});
