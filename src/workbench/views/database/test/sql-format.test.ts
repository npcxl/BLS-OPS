import { describe, expect, it } from "vitest";
import { formatSql } from "../sql-format";

describe("formatSql", () => {
  it("大写关键字并按子句换行", () => {
    expect(formatSql("select id, name from users where id = 1 and status = 'ok'")).toBe(
      ["SELECT id, name", "FROM users", "WHERE id = 1", "  AND status = 'ok'"].join("\n"),
    );
  });

  it("字符串与注释里的内容原样保留", () => {
    const out = formatSql("select 'select from' as a -- from\nfrom t");
    expect(out).toContain("'select from'");
    expect(out).toContain("-- from");
    // 字符串里的 select/from 不能变成关键字换行
    expect(out.split("\n").filter((line) => line.includes("'select from'"))).toHaveLength(1);
  });

  it("LEFT JOIN / DELETE FROM 不会被拆成两行", () => {
    expect(formatSql("select * from a left join b on a.id = b.id")).toContain("LEFT JOIN b");
    expect(formatSql("delete from t where id = 1")).toContain("DELETE FROM t");
  });

  it("括号里的子查询跟着缩进", () => {
    const out = formatSql("select * from (select id from t) x");
    expect(out).toContain("  SELECT id");
  });

  it("重复格式化结果稳定", () => {
    const once = formatSql("select a,b from t where a=1 and b=2");
    expect(formatSql(once)).toBe(once);
  });
});
