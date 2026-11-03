/**
 * 表对象右键菜单的两条硬约束：
 *
 * 1. 「复制 SELECT」按连接的方言引用标识符 —— 在 PostgreSQL/SQLite 上复制出
 *    反引号包裹的标识符是一段非法 SQL；
 * 2. 逐项 DDL 能力：不能再拿 `schema_edit` 一个开关代表重命名/复制/清空/删除。
 */
import { describe, expect, it } from "vitest";

import type { Capability } from "@/api/types/database";
import type { SqlQuoteRules } from "../grid/copy-format";
import { buildSelectSql, ddlOperationState } from "../object-menu";

const MYSQL: SqlQuoteRules = { identifier_quote: "backtick", backslash_escapes: true };
const POSTGRES: SqlQuoteRules = { identifier_quote: "double_quote", backslash_escapes: false };
const TSQL: SqlQuoteRules = { identifier_quote: "bracket", backslash_escapes: false };

describe("复制 SELECT 使用连接的方言", () => {
  it("MySQL 用反引号", () => {
    expect(buildSelectSql({ database: "shop" }, { name: "orders" }, MYSQL)).toBe(
      "SELECT * FROM `shop`.`orders` LIMIT 200;",
    );
  });

  it("PostgreSQL / SQLite 用双引号", () => {
    expect(buildSelectSql({ database: "public" }, { name: "orders" }, POSTGRES)).toBe(
      'SELECT * FROM "public"."orders" LIMIT 200;',
    );
  });

  it("SQL Server 用方括号", () => {
    expect(buildSelectSql({ database: "dbo" }, { name: "orders" }, TSQL)).toBe(
      "SELECT * FROM [dbo].[orders] LIMIT 200;",
    );
  });

  it("标识符里的引用符被双写，不会把语句截断", () => {
    expect(buildSelectSql({ database: "a`b" }, { name: "c" }, MYSQL)).toBe(
      "SELECT * FROM `a``b`.`c` LIMIT 200;",
    );
    expect(buildSelectSql({ database: 'a"b' }, { name: "c" }, POSTGRES)).toBe(
      'SELECT * FROM "a""b"."c" LIMIT 200;',
    );
  });

  it("拿不到方言时退回 MySQL（与改造前行为一致）", () => {
    expect(buildSelectSql({ database: "shop" }, { name: "orders" })).toBe(
      "SELECT * FROM `shop`.`orders` LIMIT 200;",
    );
  });
});

describe("逐项 DDL 能力 → 菜单禁用状态", () => {
  const supported: Capability = { state: "supported" };
  const limited: Capability = { state: "limited", reason: "DDL 语法按产品版本存在差异" };
  const unsupported: Capability = {
    state: "unsupported",
    reason: "SQLite 没有 CREATE TABLE … LIKE：复制表尚未接入",
  };

  it("supported：可点、无原因", () => {
    expect(ddlOperationState(supported)).toEqual({ blocked: false, reason: undefined });
  });

  it("limited：仍然可点，但把边界带上", () => {
    expect(ddlOperationState(limited)).toEqual({
      blocked: false,
      reason: "DDL 语法按产品版本存在差异",
    });
  });

  it("unsupported：置灰，原因与主窗口同一句", () => {
    expect(ddlOperationState(unsupported)).toEqual({
      blocked: true,
      reason: "SQLite 没有 CREATE TABLE … LIKE：复制表尚未接入",
    });
  });

  it("注册表缺项时保守置灰（不发注定失败的请求）", () => {
    expect(ddlOperationState(undefined)).toEqual({ blocked: true, reason: undefined });
  });
});
