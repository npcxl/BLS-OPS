import { describe, expect, it } from "vitest";

import { MYSQL_SPLIT_RULES, splitSqlStatements, statementAtCursor } from "../sql-split";

const POSTGRES = {
  ...MYSQL_SPLIT_RULES,
  hash_line_comment: false,
  backslash_escapes: false,
  dollar_quoting: true,
};

const SQLSERVER = {
  ...MYSQL_SPLIT_RULES,
  hash_line_comment: false,
  backslash_escapes: false,
  batch_terminator: "GO",
};

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
    const spaced = "  SELECT 1;\n\nSELECT 2;\nDELETE FROM users;";
    expect(statementAtCursor(spaced, 0)).toBe("SELECT 1");
    expect(statementAtCursor(spaced, spaced.indexOf("\n\n") + 1)).toBe("SELECT 1");
  });

  describe("方言语义", () => {
    it("PostgreSQL：`$$ … $$` 里的分号不拆分", () => {
      const { statements } = splitSqlStatements(
        "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1;",
        POSTGRES,
      );
      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("RETURN 1; END;");
      expect(statements[1]).toBe("SELECT 1");
    });

    it("PostgreSQL：`#` 不是注释，反斜杠也不是转义", () => {
      // `#` 只是普通字符：整行都是一条语句。
      const hash = splitSqlStatements("# select 1; SELECT 2;", POSTGRES);
      expect(hash.statements).toEqual(["# select 1", "SELECT 2"]);

      // 标准 SQL 里 `'a\'` 在第二个引号处就结束，因此后续分号是分隔符。
      const quoted = splitSqlStatements("SELECT 'a\\'; SELECT 2;", POSTGRES);
      expect(quoted.statements).toEqual(["SELECT 'a\\'", "SELECT 2"]);
    });

    it("SQL Server：独占一行的 GO 是批分隔符", () => {
      const { statements } = splitSqlStatements(
        "SELECT 1\nGO\nSELECT 2\n  go  \nSELECT 3",
        SQLSERVER,
      );
      expect(statements).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
      // 不与标识符混淆：`GOTO` 不是批分隔符。
      const notBatch = splitSqlStatements("SELECT GOTO FROM t\nGO", SQLSERVER);
      expect(notBatch.statements[0]).toContain("GOTO");
    });

    it("MySQL 默认仍然把 `#` 当注释、反斜杠当转义", () => {
      const hash = splitSqlStatements("# 注释; 不分隔\nSELECT 1;");
      expect(hash.statements).toEqual(["# 注释; 不分隔\nSELECT 1"]);
      const escaped = splitSqlStatements("SELECT 'it\\'s; ok'; SELECT 2;");
      expect(escaped.statements).toEqual(["SELECT 'it\\'s; ok'", "SELECT 2"]);
    });
  });
});
