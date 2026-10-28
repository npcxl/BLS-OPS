import { describe, expect, it } from "vitest";
import { parseForeignKeys } from "../foreign-keys";

const MYSQL_DDL = [
  "CREATE TABLE `biz_order` (",
  "  `id` bigint NOT NULL AUTO_INCREMENT,",
  "  `tenant_id` varchar(32) NOT NULL,",
  "  `warehouse_code` varchar(64) DEFAULT NULL,",
  "  PRIMARY KEY (`id`),",
  "  KEY `idx_order_tenant` (`tenant_id`),",
  "  CONSTRAINT `fk_order_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,",
  "  CONSTRAINT `fk_order_warehouse` FOREIGN KEY (`tenant_id`, `warehouse_code`) REFERENCES `warehouse` (`tenant_id`, `code`)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
].join("\n");

describe("parseForeignKeys", () => {
  it("parses named foreign keys with actions", () => {
    const keys = parseForeignKeys(MYSQL_DDL);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual({
      name: "fk_order_tenant",
      columns: ["tenant_id"],
      refTable: "tenant",
      refColumns: ["id"],
      onDelete: "CASCADE",
      onUpdate: "RESTRICT",
    });
  });

  it("keeps composite columns and defaults actions to null", () => {
    const [, warehouse] = parseForeignKeys(MYSQL_DDL);
    expect(warehouse.columns).toEqual(["tenant_id", "warehouse_code"]);
    expect(warehouse.refColumns).toEqual(["tenant_id", "code"]);
    expect(warehouse.onDelete).toBeNull();
    expect(warehouse.onUpdate).toBeNull();
  });

  it("handles inline foreign keys and cross-database references", () => {
    const keys = parseForeignKeys(
      "CREATE TABLE `t` (FOREIGN KEY (`a`) REFERENCES `other_db`.`parent` (`id`) ON DELETE SET NULL)",
    );
    expect(keys).toEqual([
      {
        name: "",
        columns: ["a"],
        refTable: "parent",
        refColumns: ["id"],
        onDelete: "SET NULL",
        onUpdate: null,
      },
    ]);
  });

  it("returns an empty list without DDL or without foreign keys", () => {
    expect(parseForeignKeys(null)).toEqual([]);
    expect(parseForeignKeys("CREATE TABLE `t` (`id` bigint)")).toEqual([]);
  });
});
