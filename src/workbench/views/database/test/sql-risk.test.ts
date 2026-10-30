import { describe, expect, it } from "vitest";
import { detectDestructive, shortSql } from "../sql-risk";

/**
 * 危险 SQL 的确认判定。
 *
 * 这里的每一条都对应"数据会被删掉"的场景 —— 漏报的代价是丢数据，
 * 误报的代价只是多按一次确认，所以口径刻意偏宽。
 */

const kinds = (statements: string[]) => detectDestructive(statements).map((hit) => hit.kind);

describe("detectDestructive", () => {
  it("识别 drop / truncate / 无 where 的 delete", () => {
    expect(kinds(["DROP TABLE users"])).toEqual(["drop"]);
    expect(kinds(["drop database shop"])).toEqual(["drop"]);
    expect(kinds(["TRUNCATE TABLE orders"])).toEqual(["truncate"]);
    expect(kinds(["truncate orders"])).toEqual(["truncate"]);
    expect(kinds(["DELETE FROM orders"])).toEqual(["delete-all"]);
    expect(kinds(["delete from orders limit 10"])).toEqual(["delete-all"]);
  });

  it("带 where 的 delete 不算整表删除", () => {
    expect(kinds(["DELETE FROM orders WHERE id = 1"])).toEqual([]);
    expect(kinds(["delete from orders\nwhere created_at < '2020-01-01'"])).toEqual([]);
  });

  it("字符串与注释里的 where 不算条件", () => {
    // 末尾注释里出现 where：语句本体仍然没有条件。
    expect(kinds(["DELETE FROM orders -- where id = 1"])).toEqual(["delete-all"]);
    // 字符串里的 where 同理。
    expect(kinds(["DELETE FROM orders LIMIT 'where'"])).toEqual(["delete-all"]);
  });

  it("前置注释不影响识别", () => {
    expect(kinds(["-- 清理旧数据\nDROP TABLE tmp_users"])).toEqual(["drop"]);
    expect(kinds(["/* note */ truncate tmp_users"])).toEqual(["truncate"]);
  });

  it("普通查询与更新不触发确认", () => {
    expect(kinds(["SELECT * FROM users", "UPDATE users SET name = 'x' WHERE id = 1"])).toEqual(
      [],
    );
    expect(kinds(["INSERT INTO users(id) VALUES (1)"])).toEqual([]);
  });

  it("多条语句里只报危险的那几条，且保持顺序", () => {
    const hits = detectDestructive([
      "select 1",
      "DROP TABLE a",
      "delete from b where id = 2",
      "TRUNCATE c",
    ]);
    expect(hits.map((hit) => hit.kind)).toEqual(["drop", "truncate"]);
    expect(hits[0]?.statement).toBe("DROP TABLE a");
  });

  it("statement 去掉结尾分号，方便展示", () => {
    const [hit] = detectDestructive(["DROP TABLE a;"]);
    expect(hit?.statement).toBe("DROP TABLE a");
  });
});

describe("shortSql", () => {
  it("折叠空白并截断超长语句", () => {
    expect(shortSql("delete   from\n\norders")).toBe("delete from orders");
    const long = `select ${"x".repeat(300)}`;
    expect(shortSql(long).endsWith("…")).toBe(true);
    expect(shortSql(long).length).toBeLessThanOrEqual(111);
  });
});
