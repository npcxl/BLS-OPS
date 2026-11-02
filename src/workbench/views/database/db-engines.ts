/**
 * 数据库引擎目录（前端视图）。
 *
 * **不再在这里维护引擎清单**：产品、默认端口、必填字段、能力与方言规则都来自
 * 后端 `db_engines_catalog`。前端只做"把注册表变成表单需要的形状"这一件事。
 *
 * 为什么这么改：以前这里有一份手写的 7 项清单，后端 `validate_profile` 又有
 * 一份，端口/必填项/是否支持各写一遍。加一个引擎必然漏一处，最后变成
 * "界面说能连、后端说没有驱动"。
 */
import type {
  DbEngine,
  DriverFamily,
  EngineDescriptor,
  EngineOptions,
} from "@/api/types/database";

export type EngineTransport = "network" | "file";

/** 表单需要的派生信息（全部来自注册表，不额外声明事实）。 */
export interface DbEngineMeta {
  id: DbEngine | string;
  label: string;
  defaultPort: number;
  transport: EngineTransport;
  /** 能建立连接并真正工作。 */
  supported: boolean;
  /** 注册表里有没有这个引擎；老配置里已下线的名字会是 false。 */
  known: boolean;
  databaseLabel: string;
  databasePlaceholder: string;
  /** 不能连接时的原因（未适配 / 未知引擎）。 */
  unavailableReason: string | null;
  descriptor: EngineDescriptor | null;
}

export interface EngineCatalogState {
  entries: EngineDescriptor[];
  byId: Map<string, EngineDescriptor>;
}

const MAX_PORT = 65535;

let catalog: EngineCatalogState = { entries: [], byId: new Map() };
let revision = 0;

/** 目录已加载的版本号；0 表示还没加载过。 */
export function catalogRevision(): number {
  return revision;
}

export function isCatalogLoaded(): boolean {
  return revision > 0;
}

/**
 * 安装后端目录。幂等：同一份数据重复安装不会引起额外渲染（revision 仍会变，
 * 但调用方按 `ready` 判断，不依赖浅比较）。
 */
export function setEngineCatalog(entries: EngineDescriptor[]): void {
  const byId = new Map<string, EngineDescriptor>();
  for (const entry of entries) byId.set(entry.id, entry);
  catalog = { entries, byId };
  revision += 1;
}

/** 全部引擎（保持后端顺序：先能用的，再配置可保存的）。 */
export function engineCatalog(): readonly EngineDescriptor[] {
  return catalog.entries;
}

export function engineDescriptor(id: DbEngine | string): EngineDescriptor | null {
  return catalog.byId.get(id) ?? null;
}

const UNKNOWN: Omit<DbEngineMeta, "id"> = {
  label: "未知数据库",
  defaultPort: 0,
  transport: "network",
  supported: false,
  known: false,
  databaseLabel: "默认数据库（可选）",
  databasePlaceholder: "",
  unavailableReason: "未知的数据库类型：请重新选择",
  descriptor: null,
};

/**
 * 未知引擎**不回落 MySQL**：回落会让表单拿 MySQL 的端口/必填项去校验一个
 * 完全不同的产品，用户看到的错误全是错的。
 */
export function engineMeta(id: DbEngine | string): DbEngineMeta {
  const descriptor = engineDescriptor(id);
  if (!descriptor) return { ...UNKNOWN, id };
  return {
    id: descriptor.id,
    label: descriptor.product,
    defaultPort: descriptor.default_port ?? 0,
    transport: descriptor.transport === "local_file" ? "file" : "network",
    supported: descriptor.implementation === "implemented",
    known: true,
    databaseLabel: databaseLabel(descriptor),
    databasePlaceholder: databasePlaceholder(descriptor),
    unavailableReason:
      descriptor.implementation === "implemented" ? null : descriptor.note,
    descriptor,
  };
}

function databaseLabel(descriptor: EngineDescriptor): string {
  if (descriptor.fields.path) return "数据库文件路径";
  if (descriptor.id === "oracle") return "服务名 / SID";
  if (descriptor.requirements.database) return "数据库名";
  return "默认数据库（可选）";
}

function databasePlaceholder(descriptor: EngineDescriptor): string {
  if (descriptor.fields.path) return "/opt/app/data/app.db";
  if (descriptor.id === "postgres" || descriptor.id === "aurora_pg") return "例如 postgres";
  if (descriptor.id === "oracle") return "例如 ORCLPDB1";
  if (descriptor.id === "sqlserver") return "例如 master";
  if (descriptor.id === "redis") return "留空 = db 0；cluster 模式忽略";
  return "留空则连接后手动选择";
}

export function isFileEngine(id: DbEngine | string): boolean {
  return engineMeta(id).transport === "file";
}

export function isEngineSupported(id: DbEngine | string): boolean {
  return engineMeta(id).supported;
}

/** 端口是否仍是某个引擎的默认值（切引擎时据此决定要不要跟着改）。 */
export function isDefaultPort(port: number): boolean {
  return (
    port > 0 &&
    port <= MAX_PORT &&
    catalog.entries.some((entry) => entry.default_port === port)
  );
}

/**
 * 切引擎时的用户名默认值。
 *
 * 注册表用 `default_username` 声明（MySQL/MariaDB 是 root）。切到没有默认
 * 用户名的引擎时，把**自动填的** root 清掉，手填的其它名字保留。
 */
export function usernameForEngine(engine: DbEngine | string, current: string): string {
  const meta = engineMeta(engine);
  const fallback = meta.descriptor?.default_username ?? "";
  const trimmed = current.trim();
  if (trimmed === "") return fallback;
  if (fallback && trimmed === fallback) return current;
  // root 是 MySQL 系的自动默认值；带到别的引擎去 AUTH 必然失败。
  if (trimmed === "root" && !fallback) return "";
  return current;
}

/**
 * 切换引擎时归一化 `engine_options`：只保留目标引擎声明过的键。
 *
 * 否则从 SQLite 切到 MySQL 会把 `path` 一路带过去，后端校验直接报
 * "该数据库类型不使用文件路径" —— 用户没填过这个字段，却要为它改配置。
 */
export function engineOptionsFor(
  engine: DbEngine | string,
  current: EngineOptions | null | undefined,
): EngineOptions {
  const descriptor = engineDescriptor(engine);
  if (!descriptor) return {};
  const next: EngineOptions = {};
  const source = current ?? {};
  for (const field of descriptor.options) {
    const value = (source as Record<string, unknown>)[field.key];
    if (value === undefined || value === null) continue;
    if (field.kind.kind === "bool") {
      if (typeof value === "boolean") (next as Record<string, unknown>)[field.key] = value;
    } else if (typeof value === "string" && value.trim() !== "") {
      (next as Record<string, unknown>)[field.key] = value;
    }
  }
  return next;
}

/** 能力是否允许某个操作（`limited` 仍可用，但界面要显示原因）。 */
export function capabilityAllows(
  descriptor: EngineDescriptor | null | undefined,
  capability: keyof EngineDescriptor["capabilities"],
): boolean {
  if (!descriptor) return false;
  return descriptor.capabilities[capability].state !== "unsupported";
}

export function capabilityReason(
  descriptor: EngineDescriptor | null | undefined,
  capability: keyof EngineDescriptor["capabilities"],
): string | null {
  const value = descriptor?.capabilities[capability];
  if (!value || value.state === "supported") return null;
  return value.reason;
}

/** 引擎族：界面路由用（Redis / 文档型 / SQL）。 */
export function familyOf(id: DbEngine | string): DriverFamily | null {
  return engineDescriptor(id)?.family ?? null;
}
