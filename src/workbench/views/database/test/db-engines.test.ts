/**
 * 数据库引擎目录：连接表单的所有引擎差异都从这里取。
 *
 * 回归点：引擎清单、默认端口、文件型判定、是否已适配必须一致 —— 之前在表单里
 * 手写端口联动，加引擎时很容易漏。
 */
import { describe, expect, it } from "vitest";
import {
  DB_ENGINES,
  engineMeta,
  isDefaultPort,
  isEngineSupported,
  isFileEngine,
  usernameForEngine,
} from "../db-engines";

describe("db-engines", () => {
  it("covers every engine the product lists", () => {
    const ids = DB_ENGINES.map((engine) => engine.id);
    expect(ids).toEqual([
      "mysql",
      "mariadb",
      "postgres",
      "sqlite",
      "sqlserver",
      "oracle",
      "redis",
    ]);
  });

  it("uses each engine's own default port", () => {
    expect(engineMeta("mysql").defaultPort).toBe(3306);
    expect(engineMeta("mariadb").defaultPort).toBe(3306);
    expect(engineMeta("postgres").defaultPort).toBe(5432);
    expect(engineMeta("sqlserver").defaultPort).toBe(1433);
    expect(engineMeta("oracle").defaultPort).toBe(1521);
    expect(engineMeta("redis").defaultPort).toBe(6379);
    // 文件型没有端口。
    expect(engineMeta("sqlite").defaultPort).toBe(0);
    expect(isFileEngine("sqlite")).toBe(true);
  });

  it("only claims support where a driver exists", () => {
    // 有驱动的：MySQL 协议（含 MariaDB）与 Redis。
    expect(isEngineSupported("mysql")).toBe(true);
    expect(isEngineSupported("mariadb")).toBe(true);
    expect(isEngineSupported("redis")).toBe(true);
    // 没有驱动的一律 false，不能在 UI 上假装能测连接。
    expect(isEngineSupported("postgres")).toBe(false);
    expect(isEngineSupported("sqlite")).toBe(false);
    expect(isEngineSupported("sqlserver")).toBe(false);
    expect(isEngineSupported("oracle")).toBe(false);
  });

  it("gives the file engine its own labels", () => {
    expect(engineMeta("sqlite").databaseLabel).toBe("数据库文件路径");
    expect(engineMeta("mysql").databaseLabel).toBe("默认数据库（可选）");
  });

  it("recognises default ports without clobbering custom ones", () => {
    expect(isDefaultPort(3306)).toBe(true);
    expect(isDefaultPort(5432)).toBe(true);
    // 用户手填的非默认端口不该被切引擎覆盖。
    expect(isDefaultPort(13306)).toBe(false);
  });

  it("falls back safely for an unknown engine", () => {
    // 老配置里可能有已下线的引擎名：表单不能崩。
    expect(engineMeta("unknown-db").id).toBe("mysql");
  });

  it("never carries the auto-filled root username over to Redis", () => {
    // MySQL 默认 root；切到 Redis 必须清空，否则拿 root 去 AUTH 空密码必失败。
    expect(usernameForEngine("mysql", "")).toBe("root");
    expect(usernameForEngine("redis", "root")).toBe("");
    expect(usernameForEngine("postgres", "root")).toBe("");
    // 用户手填的 ACL 用户名不能被清掉。
    expect(usernameForEngine("redis", "bls")).toBe("bls");
    // 切回 MySQL 且用户名为空时补回 root。
    expect(usernameForEngine("mysql", "")).toBe("root");
  });
});
