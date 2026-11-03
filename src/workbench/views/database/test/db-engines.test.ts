/**
 * 引擎目录：前端不再自己维护清单，全部行为都由后端的 `EngineDescriptor` 推导。
 *
 * 回归点：
 * - 未知引擎**不能**回落成 MySQL（以前会拿 MySQL 的端口去校验别的产品）；
 * - "能连接"只看 `implementation`，不是看名字在不在下拉里；
 * - 文件型没有 host/port/username，切引擎时要把不适用字段清掉。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Capability, EngineDescriptor } from "@/api/types/database";
import {
  capabilityAllows,
  capabilityReason,
  engineCatalog,
  engineChoices,
  engineMeta,
  engineOptionsFor,
  isDefaultPort,
  isEngineSupported,
  isFileEngine,
  listedEngines,
  setEngineCatalog,
  usernameForEngine,
} from "../db-engines";

const supported: Capability = { state: "supported" };
const unsupported = (reason: string): Capability => ({ state: "unsupported", reason });
const limited = (reason: string): Capability => ({ state: "limited", reason });

function descriptor(
  id: EngineDescriptor["id"],
  overrides: Partial<EngineDescriptor> = {},
): EngineDescriptor {
  return {
    id,
    product: id,
    family: "mysql",
    dialect: "mysql",
    transport: "network",
    implementation: "config_only",
    entry: { state: "listed" },
    default_port: 3306,
    default_username: null,
    fields: {
      host: true,
      port: true,
      username: true,
      password: true,
      database: true,
      path: false,
      uri: false,
      ssh_tunnel: true,
      tls: true,
    },
    requirements: { endpoint: "host_port", username: true, database: false },
    options: [],
    capabilities: {
      query: unsupported("尚未适配"),
      multiple_result_sets: unsupported("尚未适配"),
      cancel: unsupported("尚未适配"),
      transaction: unsupported("尚未适配"),
      read_only_enforcement: unsupported("尚未适配"),
      table_browse: unsupported("尚未适配"),
      keyset_pagination: unsupported("尚未适配"),
      table_edit: unsupported("尚未适配"),
      schema_edit: unsupported("尚未适配"),
      view_edit: unsupported("尚未适配"),
      export: unsupported("尚未适配"),
      export_sql: unsupported("尚未适配"),
    },
    ddl_operations: {
      create_table: unsupported("尚未适配"),
      rename_table: unsupported("尚未适配"),
      copy_table: unsupported("尚未适配"),
      truncate_table: unsupported("尚未适配"),
      drop_table: unsupported("尚未适配"),
      alter_columns: unsupported("尚未适配"),
      create_view: unsupported("尚未适配"),
      drop_view: unsupported("尚未适配"),
    },
    dialect_rules: {
      identifier_quote: "backtick",
      backslash_escapes: true,
      hash_line_comment: true,
      dollar_quoting: false,
      batch_terminator: null,
      statement_terminator: ";",
      qualified_by_schema: false,
      max_ident_bytes: 64,
    },
    verified: [{ versions: "—", level: "config_only", notes: "" }],
    note: "尚未适配",
    ...overrides,
  };
}

const CATALOG: EngineDescriptor[] = [
  descriptor("mysql", {
    product: "MySQL",
    implementation: "implemented",
    default_username: "root",
    capabilities: {
      ...descriptor("mysql").capabilities,
      query: supported,
      table_edit: supported,
    },
    verified: [{ versions: "MySQL 8.x", level: "manage", notes: "" }],
    note: "原生协议",
  }),
  descriptor("mariadb", {
    product: "MariaDB",
    implementation: "implemented",
    default_username: "root",
  }),
  descriptor("postgres", {
    product: "PostgreSQL",
    family: "postgres",
    dialect: "postgres",
    default_port: 5432,
    requirements: { endpoint: "host_port", username: true, database: true },
    note: "批次 3",
  }),
  descriptor("sqlite", {
    product: "SQLite",
    family: "sqlite",
    dialect: "sqlite",
    transport: "local_file",
    default_port: null,
    fields: {
      host: false,
      port: false,
      username: false,
      password: false,
      database: false,
      path: true,
      uri: false,
      ssh_tunnel: false,
      tls: false,
    },
    requirements: { endpoint: "file_path", username: false, database: false },
    options: [
      {
        key: "path",
        label: "数据库文件路径",
        placeholder: "",
        kind: { kind: "path" },
        required: true,
      },
    ],
    note: "本地文件",
  }),
  descriptor("sqlserver", {
    product: "SQL Server",
    default_port: 1433,
    family: "sqlserver",
    entry: { state: "hidden", reason: "开发计划中：驱动未接入" },
  }),
  descriptor("oracle", {
    product: "Oracle",
    default_port: 1521,
    family: "oracle",
    requirements: { endpoint: "host_port", username: true, database: true },
    entry: { state: "hidden", reason: "暂不在支持范围" },
    options: [
      {
        key: "identifier",
        label: "连接标识类型",
        placeholder: "service",
        kind: { kind: "enum", values: ["service", "sid"] },
        required: false,
      },
    ],
  }),
  descriptor("redis", {
    product: "Redis",
    family: "redis",
    dialect: "none",
    default_port: 6379,
    implementation: "implemented",
    requirements: { endpoint: "host_port", username: false, database: false },
    note: "键值引擎",
  }),
  // 有驱动但被移出一级入口：产品身份与可用性都必须保留。
  descriptor("tidb", {
    product: "TiDB",
    implementation: "implemented",
    default_port: 4000,
    entry: { state: "hidden", reason: "暂不作为新建连接的一级入口" },
    note: "MySQL 协议",
  }),
];

beforeEach(() => {
  setEngineCatalog(CATALOG);
});

describe("db-engines", () => {
  it("keeps the backend catalog order", () => {
    expect(engineCatalog().map((engine) => engine.id)).toEqual([
      "mysql",
      "mariadb",
      "postgres",
      "sqlite",
      "sqlserver",
      "oracle",
      "redis",
      "tidb",
    ]);
  });

  it("filters the new-connection list by the backend entry policy", () => {
    // 前端不写死名单：隐藏哪个由注册表的 `entry` 决定。
    expect(listedEngines().map((engine) => engine.id)).toEqual([
      "mysql",
      "mariadb",
      "postgres",
      "sqlite",
      "redis",
    ]);
    expect(listedEngines().every((engine) => engine.entry.state === "listed")).toBe(true);
  });

  it("keeps a hidden engine selectable when editing its own connection", () => {
    // 旧配置打开时：原产品名、原类型都要在，不能被静默改成 MySQL。
    const meta = engineMeta("tidb");
    expect(meta.known).toBe(true);
    expect(meta.label).toBe("TiDB");
    expect(meta.listed).toBe(false);
    expect(meta.hiddenReason).toBe("暂不作为新建连接的一级入口");

    expect(engineChoices("tidb").map((engine) => engine.id)).toContain("tidb");
    // 新建（没有当前引擎 / 当前引擎就在列表里）时不会看到隐藏的产品。
    expect(engineChoices(null).map((engine) => engine.id)).not.toContain("tidb");
    expect(engineChoices("mysql").map((engine) => engine.id)).not.toContain("tidb");
    // 当前引擎已在列表里时不重复插入。
    expect(engineChoices("mysql").filter((engine) => engine.id === "mysql")).toHaveLength(1);
    // 编辑旧连接：草稿已切到 mysql，原引擎 tidb 仍在候选里（切走再切回来不消失）。
    expect(engineChoices("mysql", "tidb").map((engine) => engine.id)).toContain("tidb");
    expect(engineChoices("tidb", "tidb").filter((engine) => engine.id === "tidb")).toHaveLength(1);
  });

  it("does not confuse hidden with unimplemented", () => {
    // 隐藏但已实现：仍可连接，能力也还在。
    expect(engineMeta("tidb").supported).toBe(true);
    expect(isEngineSupported("tidb")).toBe(true);
    // 隐藏且未实现：连接入口与"测试连接"一起禁用。
    expect(engineMeta("sqlserver").supported).toBe(false);
    expect(isEngineSupported("sqlserver")).toBe(false);
    expect(engineMeta("sqlserver").hiddenReason).toBe("开发计划中：驱动未接入");
  });

  it("takes default ports from the catalog", () => {
    expect(engineMeta("mysql").defaultPort).toBe(3306);
    expect(engineMeta("postgres").defaultPort).toBe(5432);
    expect(engineMeta("sqlserver").defaultPort).toBe(1433);
    expect(engineMeta("oracle").defaultPort).toBe(1521);
    expect(engineMeta("redis").defaultPort).toBe(6379);
    // 文件型没有端口。
    expect(engineMeta("sqlite").defaultPort).toBe(0);
    expect(isFileEngine("sqlite")).toBe(true);
    expect(isFileEngine("mysql")).toBe(false);
  });

  it("only claims support where a driver is implemented", () => {
    expect(isEngineSupported("mysql")).toBe(true);
    expect(isEngineSupported("mariadb")).toBe(true);
    expect(isEngineSupported("redis")).toBe(true);
    expect(isEngineSupported("postgres")).toBe(false);
    expect(isEngineSupported("sqlite")).toBe(false);
    expect(isEngineSupported("sqlserver")).toBe(false);
    expect(isEngineSupported("oracle")).toBe(false);
  });

  it("gives the file engine its own labels", () => {
    expect(engineMeta("sqlite").databaseLabel).toBe("数据库文件路径");
    expect(engineMeta("mysql").databaseLabel).toBe("默认数据库（可选）");
    expect(engineMeta("oracle").databaseLabel).toBe("服务名 / SID");
    expect(engineMeta("postgres").databaseLabel).toBe("数据库名");
  });

  it("recognises default ports without clobbering custom ones", () => {
    expect(isDefaultPort(3306)).toBe(true);
    expect(isDefaultPort(5432)).toBe(true);
    expect(isDefaultPort(13306)).toBe(false);
    expect(isDefaultPort(0)).toBe(false);
  });

  it("never falls back to MySQL for an unknown engine", () => {
    const meta = engineMeta("unknown-db");
    expect(meta.known).toBe(false);
    expect(meta.supported).toBe(false);
    expect(meta.id).toBe("unknown-db");
    expect(meta.label).not.toBe("MySQL");
    expect(meta.unavailableReason).toContain("未知");
  });

  it("never carries the auto-filled root username over to Redis", () => {
    expect(usernameForEngine("mysql", "")).toBe("root");
    expect(usernameForEngine("redis", "root")).toBe("");
    expect(usernameForEngine("postgres", "root")).toBe("");
    expect(usernameForEngine("redis", "bls")).toBe("bls");
    expect(usernameForEngine("mysql", "")).toBe("root");
  });

  it("drops engine options the target engine does not declare", () => {
    expect(engineOptionsFor("mysql", { path: "/data/app.db", schema: "public" })).toEqual({});
    expect(engineOptionsFor("sqlite", { path: "/data/app.db", schema: "tenant" })).toEqual({
      path: "/data/app.db",
    });
    expect(engineOptionsFor("oracle", { identifier: "sid" })).toEqual({ identifier: "sid" });
  });

  it("exposes capability state and reason for the UI", () => {
    const mysql = engineCatalog().find((engine) => engine.id === "mysql")!;
    expect(capabilityAllows(mysql, "query")).toBe(true);
    expect(capabilityReason(mysql, "query")).toBeNull();

    const postgres = engineCatalog().find((engine) => engine.id === "postgres")!;
    expect(capabilityAllows(postgres, "query")).toBe(false);
    expect(capabilityReason(postgres, "query")).toBe("尚未适配");
  });

  it("keeps limited capabilities usable but explains the limit", () => {
    const redis = engineCatalog().find((engine) => engine.id === "redis")!;
    const limitedSet: EngineDescriptor = {
      ...redis,
      capabilities: { ...redis.capabilities, export: limited("导出尚未接入") },
    };
    setEngineCatalog([limitedSet]);
    expect(capabilityAllows(limitedSet, "export")).toBe(true);
    expect(capabilityReason(limitedSet, "export")).toBe("导出尚未接入");
  });

  // 后端目录升级前可能没有新加的能力项（例如 `export_sql`）：
  // 缺项按"不允许"处理，不能因为读不到就抛出，也不能默认可点。
  it("treats a missing capability as disabled", () => {
    const mysql = engineCatalog().find((engine) => engine.id === "mysql")!;
    const withoutKey = {
      ...mysql,
      capabilities: { ...mysql.capabilities },
    } as EngineDescriptor;
    delete (withoutKey.capabilities as unknown as Record<string, Capability>).export_sql;
    expect(capabilityAllows(withoutKey, "export_sql")).toBe(false);
    expect(capabilityReason(withoutKey, "export_sql")).toBeNull();
  });
});
