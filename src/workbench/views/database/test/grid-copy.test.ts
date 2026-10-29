import { describe, expect, it } from "vitest";
import type { DbColumn, DbValue } from "@/api/types/database";
import { buildCopyText, uniqueColumnNames } from "../grid/copy-format";
import {
  EMPTY_SELECTION,
  selectAll,
  selectCellAt,
  type SelectionState,
} from "../grid/selection";

function column(name: string, typeName = "varchar", extra: Partial<DbColumn> = {}): DbColumn {
  return {
    index: 0,
    name,
    org_name: name,
    table: "users",
    org_table: "users",
    type_name: typeName,
    type_code: 0,
    nullable: true,
    unsigned: false,
    binary: false,
    primary_key: false,
    auto_increment: false,
    decimals: 0,
    charset: 0,
    ...extra,
  };
}

const text = (value: string, truncated = false): DbValue => ({
  kind: "text",
  value,
  bytes: value.length,
  truncated,
});

const request = (options: {
  columns: DbColumn[];
  rows: DbValue[][];
  format: "tsv" | "csv" | "json" | "insert";
  selection?: SelectionState;
  includeHeaders?: boolean;
  table?: { database: string; table: string } | null;
  maxChars?: number;
}) => ({
  columns: options.columns,
  rows: options.rows,
  selection: options.selection ?? selectAll(EMPTY_SELECTION, {
    rows: options.rows.length,
    cols: options.columns.length,
  }),
  format: options.format,
  includeHeaders: options.includeHeaders,
  table: options.table,
  maxChars: options.maxChars,
});

describe("复制 — NULL 与空字符串", () => {
  it("TSV 里 NULL 是空字段，空字符串是显式引号", async () => {
    const result = await buildCopyText(
      request({
        columns: [column("a"), column("b"), column("c")],
        rows: [[{ kind: "null" }, text(""), text("x")]],
        format: "tsv",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('\t""\tx\n');
  });

  it("CSV 同样区分，并按需加引号", async () => {
    const result = await buildCopyText(
      request({
        columns: [column("a"), column("b")],
        rows: [[{ kind: "null" }, text("x,y")]],
        format: "csv",
      }),
    );
    expect(result.ok && result.text).toBe(',"x,y"\n');
  });

  it("JSON 用 null 表示 NULL，空串仍是空串", async () => {
    const result = await buildCopyText(
      request({
        columns: [column("a"), column("b")],
        rows: [[{ kind: "null" }, text("")]],
        format: "json",
      }),
    );
    expect(result.ok && result.text).toBe('[\n  {"a":null,"b":""}\n]\n');
  });
});

describe("复制 — 转义", () => {
  it("制表符、换行、引号在 TSV 中被引号包裹并双写", async () => {
    const result = await buildCopyText(
      request({
        columns: [column("a"), column("b"), column("c")],
        rows: [[text("x\ty"), text("line1\nline2"), text('say "hi"')]],
        format: "tsv",
      }),
    );
    expect(result.ok && result.text).toBe('"x\ty"\t"line1\nline2"\t"say ""hi"""\n');
  });

  it("带表头时首行是列名（含重复列名去重）", async () => {
    const columns = [column("id"), column("id"), column("name")];
    expect(uniqueColumnNames(columns)).toEqual(["id", "id_2", "name"]);
    const result = await buildCopyText(
      request({
        columns,
        rows: [[{ kind: "null" }, text("1"), text("a")]],
        format: "tsv",
        includeHeaders: true,
      }),
    );
    expect(result.ok && result.text.split("\n")[0]).toBe("id\tid_2\tname");
  });
});

describe("复制 — 精度与类型", () => {
  it("大整数、DECIMAL、日期原样输出（不做 Number 转换）", async () => {
    const result = await buildCopyText(
      request({
        columns: [
          column("id", "bigint"),
          column("price", "decimal"),
          column("created", "datetime"),
        ],
        rows: [
          [
            { kind: "int", value: "9007199254740993", unsigned: true },
            { kind: "decimal", value: "12.30" },
            { kind: "date_time", value: "2026-10-29 08:00:00.123456", timezone: "UTC" },
          ],
        ],
        format: "tsv",
      }),
    );
    expect(result.ok && result.text).toBe("9007199254740993\t12.30\t2026-10-29 08:00:00.123456\n");
  });

  it("二进制未截断复制 base64，截断时给占位符并报告不完整", async () => {
    const full = await buildCopyText(
      request({
        columns: [column("blob", "blob")],
        rows: [[{ kind: "binary", base64: "AAEC", bytes: 3, truncated: false }]],
        format: "tsv",
      }),
    );
    expect(full.ok && full.text).toBe("base64:AAEC\n");
    // 未截断的 base64 是无损的：只提示"这是二进制"，不算不完整。
    expect(full.ok && full.issues).toEqual([{ code: "binary", cells: 1 }]);
    expect(full.ok && full.partialCells).toBe(0);

    const truncated = await buildCopyText(
      request({
        columns: [column("blob", "blob")],
        rows: [[{ kind: "binary", base64: "AA", bytes: 1_000_000, truncated: true }]],
        format: "tsv",
      }),
    );
    expect(truncated.ok && truncated.text).toBe("[binary 1000000 B truncated]\n");
    expect(truncated.ok && truncated.issues).toEqual([
      { code: "truncated", cells: 1 },
      { code: "binary", cells: 1 },
    ]);
    expect(truncated.ok && truncated.partialCells).toBe(1);
  });

  it("超长字段被截断时照原样复制，但明确报告不是完整数据", async () => {
    const result = await buildCopyText(
      request({
        columns: [column("body", "longtext")],
        rows: [[text("first 64K", true)]],
        format: "csv",
      }),
    );
    expect(result.ok && result.text).toBe("first 64K\n");
    expect(result.ok && result.issues).toEqual([{ code: "truncated", cells: 1 }]);
    expect(result.ok && result.partialCells).toBe(1);
  });
});

describe("复制 — SQL INSERT", () => {
  const table = { database: "shop", table: "users" };

  it("没有可靠表名时不提供 INSERT", async () => {
    const result = await buildCopyText(
      request({ columns: [column("id")], rows: [[text("1")]], format: "insert", table: null }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_target");
  });

  it("字段属于别的表时拒绝生成", async () => {
    const result = await buildCopyText(
      request({
        columns: [column("id", "int", { org_table: "orders" })],
        rows: [[{ kind: "int", value: "1", unsigned: false }]],
        format: "insert",
        table,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_target");
  });

  it("生成带 NULL、数字字面量与转义字符串的 INSERT", async () => {
    const result = await buildCopyText(
      request({
        columns: [column("id", "bigint"), column("nick"), column("note")],
        rows: [[{ kind: "int", value: "9007199254740993", unsigned: false }, { kind: "null" }, text("O'Reilly")]],
        format: "insert",
        table,
      }),
    );
    expect(result.ok && result.text).toBe(
      "INSERT INTO `shop`.`users` (`id`, `nick`, `note`) VALUES\n(9007199254740993, NULL, 'O''Reilly');\n",
    );
  });

  it("截断或二进制字段拒绝生成 INSERT（不能把预览写进 SQL）", async () => {
    const result = await buildCopyText(
      request({
        columns: [column("body")],
        rows: [[text("preview", true)]],
        format: "insert",
        table,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsafe_values");
  });

  it("多块选择的列不一致时拒绝生成", async () => {
    const columns = [column("a"), column("b")];
    const rows = [[text("1"), text("2")]];
    const first = selectCellAt(EMPTY_SELECTION, { row: 0, col: 0 }, { rows: 1, cols: 2 });
    // Ctrl+点击追加第二列：两个块列不同，INSERT 的列清单无法统一。
    const selection = selectCellAt(first, { row: 0, col: 1 }, { rows: 1, cols: 2 }, {
      toggle: true,
    });
    const result = await buildCopyText({
      columns,
      rows,
      selection,
      format: "insert",
      table,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_target");
  });
});

describe("复制 — 预算与空选择", () => {
  it("没有选择时返回 empty，不产生剪贴板内容", async () => {
    const result = await buildCopyText(
      request({ columns: [column("a")], rows: [[text("1")]], format: "tsv", selection: EMPTY_SELECTION }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty");
  });

  it("超过字符预算时拒绝复制，提示改用导出", async () => {
    const rows: DbValue[][] = Array.from({ length: 50 }, () => [text("x".repeat(100))]);
    const result = await buildCopyText(
      request({ columns: [column("a")], rows, format: "tsv", maxChars: 1000 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too_large");
  });

  it("只复制选中的矩形区域", async () => {
    const rows = [
      [text("a1"), text("b1"), text("c1")],
      [text("a2"), text("b2"), text("c2")],
    ];
    const columns = [column("a"), column("b"), column("c")];
    const start = selectCellAt(EMPTY_SELECTION, { row: 0, col: 1 }, { rows: 2, cols: 3 });
    const selection = selectCellAt(start, { row: 1, col: 2 }, { rows: 2, cols: 3 }, { shift: true });
    const result = await buildCopyText({ columns, rows, selection, format: "tsv" });
    expect(result.ok && result.text).toBe("b1\tc1\nb2\tc2\n");
    expect(result.ok && result.cells).toBe(4);
  });
});
