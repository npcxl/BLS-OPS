/**
 * 数据库引擎目录：连接表单、信息面板、侧栏共用的**唯一事实来源**。
 *
 * 每加一种引擎只改这里，避免"下拉里补了、默认端口没跟上、保存校验还要求主机"
 * 这类各写各的碎片化。
 *
 * `supported` 表示**当前版本是否真的有驱动**：
 * - `true`：能测试连接、能执行；
 * - `false`：配置可以先存下来，但连接会明确告知尚未适配 —— 不会假装能连。
 */
import type { DbEngine } from "@/api/types/database";

export type EngineTransport = "network" | "file";

export interface DbEngineMeta {
  id: DbEngine;
  label: string;
  /** 默认端口。文件型为 0（没有端口）。 */
  defaultPort: number;
  transport: EngineTransport;
  supported: boolean;
  /** 默认数据库字段的标签（SQLite 是"文件路径"）。 */
  databaseLabel: string;
  databasePlaceholder: string;
}

export const DB_ENGINES: DbEngineMeta[] = [
  {
    id: "mysql",
    label: "MySQL",
    defaultPort: 3306,
    transport: "network",
    supported: true,
    databaseLabel: "默认数据库（可选）",
    databasePlaceholder: "留空则连接后手动选择",
  },
  {
    id: "mariadb",
    label: "MariaDB",
    defaultPort: 3306,
    transport: "network",
    // 与 MySQL 同协议，直接走 MySQL 驱动；个别认证插件可能需要在服务端调整。
    supported: true,
    databaseLabel: "默认数据库（可选）",
    databasePlaceholder: "留空则连接后手动选择",
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    defaultPort: 5432,
    transport: "network",
    supported: false,
    databaseLabel: "默认数据库（可选）",
    databasePlaceholder: "例如 postgres",
  },
  {
    id: "sqlite",
    label: "SQLite",
    defaultPort: 0,
    transport: "file",
    supported: false,
    databaseLabel: "数据库文件路径",
    databasePlaceholder: "/opt/app/data/app.db",
  },
  {
    id: "sqlserver",
    label: "SQL Server",
    defaultPort: 1433,
    transport: "network",
    supported: false,
    databaseLabel: "默认数据库（可选）",
    databasePlaceholder: "例如 master",
  },
  {
    id: "oracle",
    label: "Oracle",
    defaultPort: 1521,
    transport: "network",
    supported: false,
    databaseLabel: "服务名 / SID",
    databasePlaceholder: "例如 ORCLPDB1",
  },
  {
    id: "redis",
    label: "Redis",
    defaultPort: 6379,
    transport: "network",
    supported: true,
    databaseLabel: "默认 db index（0-15，可选）",
    databasePlaceholder: "留空 = db 0；cluster 模式忽略",
  },
];

const BY_ID = new Map(DB_ENGINES.map((engine) => [engine.id, engine]));

/** 未知引擎按 MySQL 处理：至少表单不会崩，连接时后端仍会拒绝。 */
export function engineMeta(id: DbEngine | string): DbEngineMeta {
  return BY_ID.get(id as DbEngine) ?? DB_ENGINES[0];
}

export function isFileEngine(id: DbEngine | string): boolean {
  return engineMeta(id).transport === "file";
}

export function isEngineSupported(id: DbEngine | string): boolean {
  return engineMeta(id).supported;
}

/** 端口是否仍是某个引擎的默认值（切引擎时据此决定要不要跟着改，不覆盖手填）。 */
export function isDefaultPort(port: number): boolean {
  return DB_ENGINES.some((engine) => engine.defaultPort === port);
}

/**
 * 切引擎时的用户名默认值。
 *
 * 只有 MySQL/MariaDB 有"默认 root"这回事；Redis 的用户名是 ACL 可选项，
 * 带着 root 去 AUTH 一个空密码必然失败（默认配置连不上，报错还很难懂）。
 * 所以切到其它引擎时，把**自动填的** root 清掉，手填的其它名字保留。
 */
export function usernameForEngine(engine: DbEngine | string, current: string): string {
  const trimmed = current.trim();
  if (engine === "mysql" || engine === "mariadb") {
    return trimmed === "" ? "root" : current;
  }
  return trimmed === "root" ? "" : current;
}
