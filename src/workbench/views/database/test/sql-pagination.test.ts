import { describe, expect, it } from "vitest";
import { pageableSql, wrapPageSql } from "../SqlWorkspace";

describe("sql pagination", () => {
  it("单条只读 SELECT / WITH 可翻页", () => {
    expect(pageableSql(["SELECT * FROM t"])).toBe("SELECT * FROM t");
    expect(pageableSql(["  WITH x AS (SELECT 1) SELECT * FROM x  "])).not.toBeNull();
  });

  it("多语句、写操作、锁定读、导出不分页", () => {
    expect(pageableSql(["SELECT 1", "SELECT 2"])).toBeNull();
    expect(pageableSql(["UPDATE t SET a = 1"])).toBeNull();
    expect(pageableSql(["SELECT * FROM t FOR UPDATE"])).toBeNull();
    expect(pageableSql(["SELECT * FROM t FOR KEY SHARE"])).toBeNull();
    expect(pageableSql(["SELECT * FROM t LOCK IN SHARE MODE"])).toBeNull();
    expect(pageableSql(["SELECT * INTO OUTFILE '/tmp/x' FROM t"])).toBeNull();
  });

  it("包装时去掉结尾分号，LIMIT/OFFSET 落在最外层", () => {
    expect(wrapPageSql("SELECT * FROM t;", 1000, 2000)).toBe(
      "SELECT * FROM (SELECT * FROM t) AS __ops_page LIMIT 1000 OFFSET 2000",
    );
  });

  it("直接对单表查询分页，保留结果列的来源", () => {
    expect(wrapPageSql("SELECT id, name FROM users ORDER BY id;", 1000, 2000, "mysql")).toBe(
      "SELECT id, name FROM users ORDER BY id\nLIMIT 1000 OFFSET 2000",
    );
    expect(pageableSql(["SELECT * FROM `bls`.`biz_inventory` LIMIT 200;"], "mysql")).toBeNull();
    expect(pageableSql(["SELECT id FROM users WHERE note = 'LIMIT'"], "mysql")).toBe(
      "SELECT id FROM users WHERE note = 'LIMIT'",
    );
  });
});
