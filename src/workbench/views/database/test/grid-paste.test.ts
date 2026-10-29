import { describe, expect, it } from "vitest";
import { parseClipboardMatrix, parsePasteValue, planPaste, type PasteColumn } from "../grid/paste";

const columns: PasteColumn[] = [
  { name: "id", dataType: "int", nullable: false },
  { name: "name", dataType: "varchar", nullable: true },
  { name: "photo", dataType: "blob", nullable: true },
  { name: "created_at", dataType: "datetime", nullable: true },
];

describe("粘贴 — 剪贴板解析", () => {
  it("解析 Excel/WPS 的 TSV，丢掉尾部换行", () => {
    expect(parseClipboardMatrix("a\tb\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("支持 CRLF、引号包裹的制表符与换行、双写引号", () => {
    expect(parseClipboardMatrix('"a\tb"\t"line1\nline2"\r\n"say ""hi"""\tplain\r\n')).toEqual([
      ["a\tb", "line1\nline2"],
      ['say "hi"', "plain"],
    ]);
  });

  it("空文本不产生行", () => {
    expect(parseClipboardMatrix("")).toEqual([]);
  });
});

describe("粘贴 — 值转换", () => {
  const asText = columns[1];
  const asInt = columns[0];
  const asDate = columns[3];

  it("`\\N` 永远是 NULL，文本列里的 NULL 只是字符串", () => {
    expect(parsePasteValue("\\N", asText)).toEqual({ kind: "null" });
    expect(parsePasteValue("NULL", asText)).toEqual({ kind: "value", value: "NULL" });
  });

  it("非文本列的 NULL / 空串按可空性处理", () => {
    expect(parsePasteValue("NULL", asInt)).toEqual({ kind: "null" });
    expect(parsePasteValue("", asDate)).toEqual({ kind: "null" });
    expect(parsePasteValue("", { name: "id", dataType: "int", nullable: false })).toBeNull();
  });

  it("数值与日期做类型检查，不合法就拒绝", () => {
    expect(parsePasteValue("42", asInt)).toEqual({ kind: "value", value: "42" });
    expect(parsePasteValue("4x2", asInt)).toBeNull();
    expect(parsePasteValue("2026-10-29 08:00:00", asDate)).toEqual({
      kind: "value",
      value: "2026-10-29 08:00:00",
    });
    expect(parsePasteValue("not a date", asDate)).toBeNull();
  });
});

describe("粘贴 — 变更计划", () => {
  it("按起点铺开矩阵，并统计行列", () => {
    const plan = planPaste({
      matrix: [
        ["1", "a"],
        ["2", "b"],
      ],
      start: { row: 0, col: 0 },
      columns,
      rowCount: 10,
    });
    expect(plan.cells).toEqual([
      { row: 0, col: 0, value: { kind: "value", value: "1" } },
      { row: 0, col: 1, value: { kind: "value", value: "a" } },
      { row: 1, col: 0, value: { kind: "value", value: "2" } },
      { row: 1, col: 1, value: { kind: "value", value: "b" } },
    ]);
    expect(plan.rows).toBe(2);
    expect(plan.cols).toBe(2);
    expect(plan.skipped).toEqual([]);
  });

  it("只读列（blob）被跳过并给出原因", () => {
    const plan = planPaste({
      matrix: [["1", "a", "binary-data"]],
      start: { row: 0, col: 0 },
      columns,
      rowCount: 5,
    });
    expect(plan.cells).toHaveLength(2);
    expect(plan.skipped).toEqual([
      { row: 0, col: 2, column: "photo", reason: "read_only" },
    ]);
  });

  it("类型不符被跳过，不静默写坏数据", () => {
    const plan = planPaste({
      matrix: [["abc", "a"]],
      start: { row: 0, col: 0 },
      columns,
      rowCount: 5,
    });
    expect(plan.cells).toHaveLength(1);
    expect(plan.skipped).toEqual([
      { row: 0, col: 0, column: "id", reason: "type_mismatch" },
    ]);
  });

  it("超出已加载范围的部分被丢弃并计数（绝不扩展查询）", () => {
    const plan = planPaste({
      matrix: [["2026-10-29 08:00:00", "extra"], ["2026-10-30 08:00:00", "x"]],
      start: { row: 1, col: 3 },
      columns,
      rowCount: 2,
    });
    // 起点在最后一行最后一列：第 1 行只有 created_at 可写，"extra" 越列；
    // 第 2 行整行超出已加载范围。
    expect(plan.cells).toEqual([
      { row: 1, col: 3, value: { kind: "value", value: "2026-10-29 08:00:00" } },
    ]);
    expect(plan.clipped).toBe(3);
    expect(plan.rows).toBe(1);
    expect(plan.cols).toBe(1);
  });

  it("无法定位的行整行跳过", () => {
    const plan = planPaste({
      matrix: [["1", "a"]],
      start: { row: 0, col: 0 },
      columns,
      rowCount: 5,
      isRowMutable: () => false,
    });
    expect(plan.cells).toHaveLength(0);
    expect(plan.skipped.every((skip) => skip.reason === "row_not_mutable")).toBe(true);
  });
});
