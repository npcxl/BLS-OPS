import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { DbColumn, DbErrorInfo } from "@/api/types/database";
import {
  buildMessageLog,
  buildSummaryRows,
  buildSummaryTsv,
  formatSeconds,
  statementLine,
  totalElapsedMs,
  type StatementResultLike,
} from "../result-log";

/** 极简 t：只做 {{name}} 插值，未命中直接返回 key（与 natural keys 一致）。 */
const t = ((key: string, options?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ""))) as unknown as TFunction;

const column = (name: string): DbColumn => ({
  index: 0,
  name,
  org_name: name,
  table: "",
  org_table: "",
  type_name: "int",
  type_code: 3,
  nullable: true,
  unsigned: false,
  binary: false,
  primary_key: false,
  auto_increment: false,
  decimals: 0,
  charset: 0,
});

const error = (overrides: Partial<DbErrorInfo> = {}): DbErrorInfo => ({
  stage: "query",
  code: 1064,
  sql_state: "42000",
  message: "You have an error in your SQL syntax",
  detail: "near 'LIMIT 400' at line 3",
  retryable: false,
  ...overrides,
});

function result(overrides: Partial<StatementResultLike> = {}): StatementResultLike {
  return {
    key: "1",
    statement: "SELECT * FROM `kox`.`ai_conversation` LIMIT 200",
    columns: [column("id")],
    affectedRows: 0,
    lastInsertId: null,
    warnings: 0,
    info: "",
    elapsedMs: 4,
    receivedRows: 20,
    truncated: false,
    error: null,
    ...overrides,
  };
}

describe("消息视图", () => {
  it("SELECT 成功：语句 + 返回行数 + 查询时间（秒）", () => {
    const text = buildMessageLog([result()], 4, t);
    expect(text).toBe(
      [
        "[1] SELECT * FROM `kox`.`ai_conversation` LIMIT 200",
        "> 返回 20 行",
        "> 查询时间: 0.004s",
        "",
        "> 总耗时: 0.004s · 共 1 个结果",
      ].join("\n"),
    );
  });

  it("DML 成功：显示影响行数与 last_insert_id，不写返回行", () => {
    const text = buildMessageLog(
      [
        result({
          statement: "UPDATE invoice_header SET apply_status = 0 WHERE id IN (1, 2)",
          columns: [],
          affectedRows: 3,
          lastInsertId: "15280",
          info: "Rows matched: 3  Changed: 3",
        }),
      ],
      12,
      t,
    );
    expect(text).toContain("> 影响 3 行");
    expect(text).toContain("> last_insert_id = 15280");
    expect(text).toContain("> Rows matched: 3  Changed: 3");
    expect(text).not.toContain("返回");
  });

  it("错误：给出错误消息与错误码，且不冒充成功", () => {
    const text = buildMessageLog(
      [result({ columns: [], receivedRows: 0, error: error() })],
      2,
      t,
    );
    expect(text).toContain("> 错误: You have an error in your SQL syntax");
    expect(text).toContain("> code: 1064 42000");
    expect(text).toContain("> near 'LIMIT 400' at line 3");
    expect(text).not.toContain("返回 0 行");
  });

  it("标注警告与截断", () => {
    const text = buildMessageLog(
      [result({ warnings: 2, truncated: true })],
      4,
      t,
    );
    expect(text).toContain("> 警告 2 条");
    expect(text).toContain("> 结果已截断");
  });

  it("多语句按顺序编号，总耗时累加", () => {
    const text = buildMessageLog(
      [result({ key: "1" }), result({ key: "2", statement: "SELECT 2", elapsedMs: 6 })],
      10,
      t,
    );
    expect(text.startsWith("[1] SELECT * FROM")).toBe(true);
    expect(text).toContain("[2] SELECT 2");
    expect(text).toContain("> 总耗时: 0.010s · 共 2 个结果");
  });

  it("没有结果时给一句明确说明", () => {
    expect(buildMessageLog([], 0, t)).toBe("这次执行没有返回结果");
  });
});

describe("总耗时兜底", () => {
  it("后端没回总量（0）时用各语句耗时之和，不能比单条还快", () => {
    expect(totalElapsedMs([result({ elapsedMs: 4 })], 0)).toBe(4);
    expect(buildMessageLog([result({ elapsedMs: 4 })], 0, t)).toContain("> 总耗时: 0.004s");
  });

  it("多语句求和", () => {
    expect(
      totalElapsedMs([result({ elapsedMs: 4 }), result({ key: "2", elapsedMs: 6 })], 0),
    ).toBe(10);
  });

  it("后端总量更大时用总量（含解析与 IPC 开销）", () => {
    expect(totalElapsedMs([result({ elapsedMs: 4 })], 40)).toBe(40);
  });

  it("NaN / 缺失字段按 0 处理，不会把总和吞掉", () => {
    expect(totalElapsedMs([result({ elapsedMs: Number.NaN })], Number.NaN)).toBe(0);
    expect(
      totalElapsedMs([result({ elapsedMs: Number.NaN }), result({ key: "2", elapsedMs: 7 })], 0),
    ).toBe(7);
    expect(totalElapsedMs([], 0)).toBe(0);
  });
});

describe("摘要视图", () => {
  it("一行一个结果集，区分返回行与影响行", () => {
    const rows = buildSummaryRows(
      [
        result(),
        result({
          key: "2",
          statement: "DELETE FROM t WHERE id = 1",
          columns: [],
          affectedRows: 1,
          elapsedMs: 1500,
        }),
      ],
      t,
    );
    expect(rows).toEqual([
      {
        key: "1",
        index: 1,
        ok: true,
        status: "成功",
        counts: "返回 20 行",
        elapsed: "0.004s",
        statement: "SELECT * FROM `kox`.`ai_conversation` LIMIT 200",
        error: "",
      },
      {
        key: "2",
        index: 2,
        ok: true,
        status: "成功",
        counts: "影响 1 行",
        elapsed: "1.50s",
        statement: "DELETE FROM t WHERE id = 1",
        error: "",
      },
    ]);
  });

  it("失败的结果标记状态并带上错误消息", () => {
    const [row] = buildSummaryRows([result({ error: error() })], t);
    expect(row.ok).toBe(false);
    expect(row.status).toBe("失败");
    expect(row.error).toBe("You have an error in your SQL syntax");
  });

  it("复制成 TSV，带表头且列数一致", () => {
    const rows = buildSummaryRows([result(), result({ key: "2", columns: [], affectedRows: 0 })], t);
    const tsv = buildSummaryTsv(rows, t);
    const lines = tsv.split("\n");
    expect(lines[0]).toBe("#\t状态\t行数\t耗时\t语句");
    expect(lines[1].split("\t")).toHaveLength(5);
    expect(lines).toHaveLength(3);
  });
});

describe("文本工具", () => {
  it("时间格式：毫秒转秒，超过 1 秒保留两位", () => {
    expect(formatSeconds(0)).toBe("0.000s");
    expect(formatSeconds(4)).toBe("0.004s");
    expect(formatSeconds(999)).toBe("0.999s");
    expect(formatSeconds(1500)).toBe("1.50s");
  });

  it("语句摘要取第一行非空内容并截断", () => {
    expect(statementLine("\n\n  SELECT 1\nFROM t")).toBe("SELECT 1");
    expect(statementLine("a".repeat(200), 10)).toBe(`${"a".repeat(10)}…`);
    expect(statementLine("   ")).toBe("");
  });
});
