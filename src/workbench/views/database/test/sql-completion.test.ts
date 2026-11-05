import { describe, expect, it } from "vitest";
import { EditorState } from "@uiw/react-codemirror";
import { CompletionContext } from "@codemirror/autocomplete";
import { sql as sqlLanguage } from "@codemirror/lang-sql";
import type { DbTable, DbTableDetail } from "@/api/types/database";
import { createSqlCompletion, type SqlCompletionMetadata } from "../sql-completion";

/**
 * SQL 补全按光标位置给不同的候选：
 * - `FROM`/`JOIN` 之后只给表；
 * - `别名.` 只给那张表的字段；
 * - 普通位置给字段 + 表 + 关键字；
 * - 字符串/注释里不弹。
 */

const table = (name: string, kind: DbTable["kind"] = "table"): DbTable => ({
  name,
  kind,
  engine: "InnoDB",
  estimated_rows: 10,
  comment: "",
});

const detail = (
  database: string,
  name: string,
  columns: [string, string][],
): DbTableDetail => ({
  database,
  table: name,
  kind: "table",
  engine: "InnoDB",
  collation: null,
  estimated_rows: 10,
  comment: "",
  create_sql: null,
  columns: columns.map(([column, type], index) => ({
    name: column,
    ordinal: index + 1,
    data_type: type,
    column_type: type,
    nullable: true,
    default_value: null,
    default_expression: null,
    primary_key: index === 0,
    auto_increment: false,
    unsigned: false,
    charset: null,
    collation: null,
    comment: "",
  })),
  indexes: [],
  primary_key: [],
  reliable_key: null,
});

const metadata = (): SqlCompletionMetadata => ({
  valid: () => true,
  tables: async () => [table("users"), table("orders", "view")],
  detail: async (database, name) =>
    detail(database, name, [
      ["id", "int"],
      ["name", "varchar(64)"],
      ["email", "varchar(128)"],
    ]),
});

/** 把光标放到文档末尾，按普通输入（非显式 Ctrl+Space）触发。 */
async function complete(doc: string, database: string | null = "ops") {
  const state = EditorState.create({
    doc,
    extensions: [sqlLanguage({ upperCaseKeywords: true })],
  });
  const source = createSqlCompletion("mysql", database, metadata());
  const result = await source(new CompletionContext(state, doc.length, false));
  return result?.options.map((option) => option.label) ?? [];
}

describe("createSqlCompletion", () => {
  it("FROM / JOIN 之后只给表名，不掺关键字", async () => {
    const labels = await complete("SELECT * FROM ");

    expect(labels).toContain("users");
    expect(labels).toContain("orders");
    expect(labels).not.toContain("SELECT");
  });

  it("别名之后只给那张表的字段", async () => {
    const labels = await complete("SELECT * FROM users u WHERE u.");

    expect(labels).toEqual(["id", "name", "email"]);
  });

  it("库名之后只给表名", async () => {
    const labels = await complete("SELECT * FROM ops.");

    expect(labels).toContain("users");
    expect(labels).not.toContain("id");
  });

  it("普通位置给字段 + 表 + 关键字", async () => {
    const labels = await complete("SELECT  FROM users u");

    expect(labels).toContain("id");
    expect(labels).toContain("u");
    expect(labels).toContain("SELECT");
  });

  it("字符串和注释里不弹补全", async () => {
    expect(await complete("SELECT 'from users', ")).toEqual([]);
    expect(await complete("-- from users\n")).toEqual([]);
  });

  it("会话失效时不补", async () => {
    const state = EditorState.create({
      doc: "SELECT * FROM ",
      extensions: [sqlLanguage({ upperCaseKeywords: true })],
    });
    const source = createSqlCompletion("mysql", "ops", {
      ...metadata(),
      valid: () => false,
    });
    const result = await source(new CompletionContext(state, "SELECT * FROM ".length, false));

    expect(result).toBeNull();
  });
});
