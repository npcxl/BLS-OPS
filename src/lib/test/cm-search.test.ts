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

import { activeMatchIndex, matchRanges, scanMatches } from "../cm-search";

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
});
