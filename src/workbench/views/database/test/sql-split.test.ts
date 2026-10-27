import { describe, expect, it } from "vitest";

import { splitSqlStatements, statementAtCursor } from "../sql-split";

describe("SQL 语句拆分", () => {
  it("按顶层分号拆分，并丢掉空语句", () => {
    const { statements } = splitSqlStatements("SELECT 1; ; SELECT 2;;");
    expect(statements).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("字符串里的分号不是分隔符", () => {
    const { statements } = splitSqlStatements("SELECT 'a;b'; SELECT \"c;d\";");
    expect(statements).toEqual(["SELECT 'a;b'", 'SELECT "c;d"']);
  });

  it("反引号标识符里的分号不是分隔符", () => {
    const { statements } = splitSqlStatements("SELECT `we;ird` FROM t; SELECT 2");
    expect(statements).toEqual(["SELECT `we;ird` FROM t", "SELECT 2"]);
  });

  it("行注释与块注释里的分号不拆分", () => {
    const { statements } = splitSqlStatements(
      "-- 说明; 不是分隔符\nSELECT 1; /* 块; 注释 */ SELECT 2; # 井号; 注释\nSELECT 3",
    );
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("-- 说明; 不是分隔符");
    expect(statements[1]).toContain("/* 块; 注释 */");
    expect(statements[2]).toContain("# 井号; 注释");
  });

  it("转义引号不会提前结束字符串", () => {
    const { statements } = splitSqlStatements("SELECT 'it\\'s; ok'; SELECT 2;");
    expect(statements).toEqual(["SELECT 'it\\'s; ok'", "SELECT 2"]);
  });

  it("连续两个单引号（SQL 标准转义）也能处理", () => {
    const { statements } = splitSqlStatements("SELECT 'a''b;c'; SELECT 2");
    expect(statements).toEqual(["SELECT 'a''b;c'", "SELECT 2"]);
  });

  it("DELIMITER 明确提示不支持，而不是悄悄拆错", () => {
    const { statements, warnings } = splitSqlStatements(
      "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;",
    );
    expect(statements.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("DELIMITER");
  });

  it("按光标定位当前语句", () => {
    const sql = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    expect(statementAtCursor(sql, 0)).toBe("SELECT 1");
    expect(statementAtCursor(sql, sql.indexOf("SELECT 2") + 2)).toBe("SELECT 2");
    expect(statementAtCursor(sql, sql.length)).toBe("SELECT 3");
  });
});
