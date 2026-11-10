import { describe, expect, it } from "vitest";
import { pageableSql, wrapPageSql } from "../SqlWorkspace";

/**
 * 结果分页只在「单条只读 SELECT」上成立：外层包一层 LIMIT/OFFSET 是唯一
 * 能做随机翻页的方式；多语句、写操作、锁定读都包不进派生表。
 */
describe("sql pagination", () => {
  it("单条只读 SELECT / WITH 可翻页", () => {
    expect(pageableSql(["SELECT * FROM t"])).toBe("SELECT * FROM t");
    expect(pageableSql(["  WITH x AS (SELECT 1) SELECT * FROM x  "])).not.toBeNull();
  });

  it("多语句、写操作、锁定读、导出不分页", () => {
    expect(pageableSql(["SELECT 1", "SELECT 2"])).toBeNull();
    expect(pageableSql(["UPDATE t SET a = 1"])).toBeNull();
    expect(pageableSql(["SELECT * FROM t FOR UPDATE"])).toBeNull();
    expect(pageableSql(["SELECT * INTO OUTFILE '/tmp/x' FROM t"])).toBeNull();
  });

  it("包装时去掉结尾分号，LIMIT/OFFSET 落在最外层", () => {
    expect(wrapPageSql("SELECT * FROM t;", 1000, 2000)).toBe(
      "SELECT * FROM (SELECT * FROM t) AS __ops_page LIMIT 1000 OFFSET 2000",
    );
  });
});
