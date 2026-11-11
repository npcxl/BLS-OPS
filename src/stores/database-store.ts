/**
 * 数据库资产状态：连接配置、左侧树的按需加载元数据、每个连接的逻辑会话。
 *
 * 三条约定：
 * - **不预读**：展开连接才查库，展开库才查表，展开表才查字段/索引。
 * - **缓存有失效入口**：刷新按钮与"失效缓存"都会重新请求。
 * - **会话按连接共享**：一个连接一个 `DbSessionInfo`，切换标签不重连，
 *   关闭标签由 `pruneSessions` 统一断开（见 `Workbench`）。
 */
import { create } from "zustand";

import { databaseApi } from "@/api/ops-api";
import type {
  ConnectionTestResult,
  DatabaseProfile,
  DbDatabase,
  DbErrorInfo,
  DbSessionInfo,
  DbTable,
  DbTableDetail,
  ProfileRuntimeStatus,
} from "@/api/types/database";
import { pushToast } from "@/components/ui/toast";
import { i18n } from "@/i18n";

const dbKey = (profileId: string) => profileId;
export const tablesKey = (profileId: string, database: string) =>
  `${profileId}\u0001${database}`;
export const detailKey = (profileId: string, database: string, table: string) =>
  `${profileId}\u0001${database}\u0001${table}`;

/** 分类节点（表/视图/函数/查询/备份）的展开态 key。 */
export const categoryKey = (
  profileId: string,
  database: string,
  category: string,
) => `${profileId}\u0001${database}\u0001${category}`;

/**
 * 树的展开状态落 localStorage：重启后「上次打开的还是打开的」。
 *
 * 只存布尔，不存数据 —— 数据仍然由展开动作触发按需加载，缓存不跨进程。
 */
const EXPANDED_STORAGE_KEY = "blsops.database.expanded-tree";

interface PersistedExpanded {
  profiles: Record<string, boolean>;
  databases: Record<string, boolean>;
  /** 用户明确打开/关闭的数据库；与“展开表列表”分离。 */
  opened: Record<string, boolean>;
  tables: Record<string, boolean>;
  categories: Record<string, boolean>;
}

const EMPTY_EXPANDED: PersistedExpanded = {
  profiles: {},
  databases: {},
  opened: {},
  tables: {},
  categories: {},
};

const boolRecord = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
    if (typeof flag === "boolean") out[key] = flag;
  }
  return out;
};

function readExpanded(): PersistedExpanded {
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!raw) return EMPTY_EXPANDED;
    const parsed = JSON.parse(raw) as Partial<PersistedExpanded> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY_EXPANDED;
    const databases = boolRecord(parsed.databases);
    return {
      profiles: boolRecord(parsed.profiles),
      databases,
      // 旧版本没有 opened：已展开的库视为已打开，避免升级后全变灰。
      opened: parsed.opened ? boolRecord(parsed.opened) : databases,
      tables: boolRecord(parsed.tables),
      categories: boolRecord(parsed.categories),
    };
  } catch {
    // localStorage 不可用（隐私模式）或内容损坏：退回默认，不影响使用。
    return EMPTY_EXPANDED;
  }
}

const initialExpanded = readExpanded();

/**
 * Tauri 的 IPC 只有在响应带 JSON/文本头时才解析成值；后端没来得及回内容
 * （命令中断、panic、responder 被丢弃）时，前端拿到的是一个**原始字节**，
 * 原样 `String()` 只会得到 `[object ArrayBuffer]` —— 没有任何可行动信息。
 * 这里尽量把字节解成文本，再判断空响应。
 */
function ipcByteText(error: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    error instanceof ArrayBuffer
      ? new Uint8Array(error)
      : new Uint8Array(error.buffer, error.byteOffset, error.byteLength);
  if (bytes.length === 0) return "";
  return new TextDecoder().decode(bytes).trim();
}

/** 把所有异常统一成后端同款结构，界面只认一种错误形状。 */
export function toDbError(error: unknown): DbErrorInfo {
  if (error instanceof ArrayBuffer || ArrayBuffer.isView(error)) {
    const text = ipcByteText(error);
    return {
      // 桥接层失败：既不是后端 SQL 错误，也不是连接错误。
      stage: "ipc",
      code: null,
      sql_state: null,
      message:
        text ||
        "后端没有返回任何内容（IPC 空响应）：该命令可能被中断或异常退出，请重试；若每次都这样，请查看应用日志",
      detail: null,
      retryable: false,
    };
  }
  if (error && typeof error === "object" && "stage" in error && "message" in error) {
    const value = error as Partial<DbErrorInfo>;
    return {
      stage: value.stage ?? "config",
      code: value.code ?? null,
      sql_state: value.sql_state ?? null,
      message: value.message ?? String(error),
      detail: value.detail ?? null,
      retryable: value.retryable ?? false,
    };
  }
  return {
    stage: "config",
    code: null,
    sql_state: null,
    message: error instanceof Error ? error.message : String(error),
    detail: null,
    retryable: false,
  };
}

/** SQL 会话失效优先于仍存活的元数据连接池。Redis 单独使用运行时状态。 */
export function isSqlConnected(
  session?: DbSessionInfo,
  status?: ProfileRuntimeStatus,
  error?: DbErrorInfo | null,
): boolean {
  return session?.state === "lost" || error ? false : (status?.connected ?? !!session);
}

export interface OpenTableRequest {
  profileId: string;
  database: string;
  table: string;
  view: "data" | "structure";
  nonce: number;
}

interface DatabaseAssetState {
  profiles: DatabaseProfile[];
  loadingProfiles: boolean;
  profileError: DbErrorInfo | null;

  expandedProfiles: Record<string, boolean>;
  expandedDatabases: Record<string, boolean>;
  /** 数据库是否被用户打开；打开后切换当前库也不会变灰。 */
  openedDatabases: Record<string, boolean>;
  expandedTables: Record<string, boolean>;
  /** 分类节点（表/视图/函数/查询/备份）的展开态，`undefined` 视为展开。 */
  expandedCategories: Record<string, boolean>;

  databases: Record<string, DbDatabase[]>;
  tables: Record<string, DbTable[]>;
  details: Record<string, DbTableDetail>;

  loading: Record<string, boolean>;
  errors: Record<string, DbErrorInfo | null>;

  sessions: Record<string, DbSessionInfo>;
  sessionErrors: Record<string, DbErrorInfo | null>;
  statuses: Record<string, ProfileRuntimeStatus>;
  /** Redis 建连进行中：侧栏与键浏览器共用，用于显示"连接中"而不是空列表。 */
  redisConnecting: Record<string, boolean>;
  /**
   * 每个 Redis 连接当前选中的 db 编号。
   *
   * 侧栏的库节点与工作区的库选择器必须**同一份状态**：在侧栏点 db 3，
   * 工作区就得扫 db 3，反过来亦然。用 null 表示"还没选过"，回落到配置默认值。
   */
  redisDbIndex: Record<string, number>;

  /** 左侧树点击表 → 通知已打开的数据库标签切换到这个表。 */
  openTableRequest: OpenTableRequest | null;
  requestTable: (
    profileId: string,
    database: string,
    table: string,
    view?: "data" | "structure",
  ) => void;

  refreshProfiles: () => Promise<void>;
  toggleProfile: (profileId: string) => Promise<void>;
  toggleDatabase: (profileId: string, database: string) => Promise<void>;
  /** 显式打开数据库：标记打开状态并加载/展开表列表。 */
  openDatabase: (profileId: string, database: string) => Promise<void>;
  /** 显式关闭数据库：清除打开状态并收起表列表。 */
  closeDatabase: (profileId: string, database: string) => void;
  toggleTable: (profileId: string, database: string, table: string) => Promise<void>;
  /** 纯 UI 展开态，不触发任何查询（数据在展开数据库时已一并取回）。 */
  toggleCategory: (key: string) => void;
  refreshDatabases: (profileId: string) => Promise<void>;
  refreshTables: (profileId: string, database: string) => Promise<void>;
  refreshTableDetail: (profileId: string, database: string, table: string) => Promise<void>;
  invalidate: (profileId: string) => Promise<void>;

  ensureSession: (profileId: string) => Promise<DbSessionInfo | null>;
  /** 清掉某连接的连接错误（标签里的错误条点了 ×）。 */
  clearSessionError: (profileId: string) => void;
  /** 切换 Redis 连接的当前 db（侧栏库节点与工作区选择器共用）。 */
  selectRedisDb: (profileId: string, dbIndex: number) => void;
  /** Redis：建连（db_redis_connect），不产生 SQL 会话。 */
  redisConnect: (profileId: string) => Promise<void>;
  /** Redis：关掉运行时再建连（改过配置 / 用户点"重新连接"时用）。 */
  redisReconnect: (profileId: string) => Promise<void>;
  /**
   * 强制重连：关闭旧会话（不尝试恢复事务/临时表），再建立新会话。
   * 只用于用户显式点击"重新连接"；绝不自动调用。
   */
  reconnect: (profileId: string) => Promise<DbSessionInfo | null>;
  /**
   * 在**固定会话**上执行事务控制语句。
   *
   * 只有这三个：`START TRANSACTION` / `COMMIT` / `ROLLBACK`。
   * 不用 `SET autocommit`：那会改变整条物理连接的语义，而我们的会话与连接
   * 是绑定的，混用两种事务模型会让"这个标签到底提没提交"变得无法判断。
   */
  runSessionCommand: (
    profileId: string,
    sql: "START TRANSACTION" | "COMMIT" | "ROLLBACK",
  ) => Promise<void>;
  closeSession: (profileId: string) => Promise<void>;
  /** 关闭已经不在任何标签里的会话；切换标签不会触发（标签还在）。 */
  pruneSessions: (activeProfileIds: string[]) => Promise<void>;
  refreshStatus: (profileId: string) => Promise<void>;
  refreshSession: (profileId: string) => Promise<void>;
  /**
   * 显式断开一个连接：先关会话，再关掉 Rust 侧的连接运行时（隧道/连接池）。
   * 只用于用户在侧栏点"关闭连接"；标签关闭走 pruneSessions（保留运行时，重开更快）。
   */
  disconnectProfile: (profileId: string) => Promise<void>;

  saveProfile: (
    profile: DatabaseProfile,
    password: string | null,
  ) => Promise<DatabaseProfile>;
  deleteProfile: (id: string) => Promise<void>;
  testConnection: (
    profile: DatabaseProfile,
    password: string | null,
  ) => Promise<ConnectionTestResult>;
}

/** 按已加载的连接配置判断引擎；配置还没拉到时按 SQL 处理。 */
function isRedisProfile(get: () => DatabaseAssetState, profileId: string): boolean {
  return get().profiles.find((profile) => profile.id === profileId)?.engine === "redis";
}

/**
 * 同一 profile 的 Redis 建连请求去重表。
 *
 * 侧栏手动连接与键浏览器挂载时的自动建连会同时触发，合并成一个 promise
 * 后只发一次 `db_redis_connect`（Rust 侧虽然单飞，前端也不该白跑一趟）。
 */
const redisConnectInFlight = new Map<string, Promise<void>>();
const sqlConnectInFlight = new Map<string, Promise<DbSessionInfo | null>>();
const connectionEpoch = new Map<string, number>();
const statusRevision = new Map<string, number>();
const lostSessionError = (): DbErrorInfo => toDbError({
  stage: "tcp", message: i18n.t("会话连接已关闭，请重新连接"),
  detail: i18n.t("原事务与临时表无法恢复；重连不会自动重跑 SQL。"), retryable: true,
});

/**
 * 连接类错误：既留在 `sessionErrors`（树里能定位到具体连接），也弹到顶部
 * alert —— 只靠树上一个小红三角，用户根本不知道哪儿错了。
 */
function reportConnectError(
  profile: DatabaseProfile | undefined,
  info: DbErrorInfo,
  action: string,
): void {
  pushToast(info.message, "error", {
    title: profile ? `${profile.name} · ${action}` : action,
    label: info.stage,
    detail: info.detail ?? undefined,
    persist: true,
  });
}

/** 把当前展开态写回 localStorage（只写展开标记）。 */
function persistExpanded(get: () => DatabaseAssetState) {
  const state = get();
  try {
    window.localStorage.setItem(
      EXPANDED_STORAGE_KEY,
      JSON.stringify({
        profiles: state.expandedProfiles,
        databases: state.expandedDatabases,
        opened: state.openedDatabases,
        tables: state.expandedTables,
        categories: state.expandedCategories,
      } satisfies PersistedExpanded),
    );
  } catch {
    // 配额满/隐私模式：只影响"记住上次展开"，不影响功能。
  }
}

export const useDatabaseStore = create<DatabaseAssetState>()((set, get) => ({
  profiles: [],
  loadingProfiles: false,
  profileError: null,

  expandedProfiles: initialExpanded.profiles,
  expandedDatabases: initialExpanded.databases,
  openedDatabases: initialExpanded.opened,
  expandedTables: initialExpanded.tables,
  expandedCategories: initialExpanded.categories,

  databases: {},
  tables: {},
  details: {},

  loading: {},
  errors: {},

  sessions: {},
  sessionErrors: {},
  statuses: {},
  redisConnecting: {},
  redisDbIndex: {},
  openTableRequest: null,

  requestTable: (profileId, database, table, view = "data") =>
    set({
      openTableRequest: {
        profileId,
        database,
        table,
        view,
        nonce: Date.now() + Math.random(),
      },
    }),

  refreshProfiles: async () => {
    set({ loadingProfiles: true, profileError: null });
    try {
      const profiles = await databaseApi.listProfiles();
      set({ profiles, loadingProfiles: false });
    } catch (error) {
      set({ loadingProfiles: false, profileError: toDbError(error) });
    }
  },

  // 展开只在"从没加载过"时发请求：收起再展开直接命中缓存，
  // 也避免和对象列表的自动加载撞成两次一样的查询。要最新的走刷新按钮。
  toggleProfile: async (profileId) => {
    const expanded = !get().expandedProfiles[profileId];
    set((state) => ({
      expandedProfiles: { ...state.expandedProfiles, [profileId]: expanded },
    }));
    persistExpanded(get);
    // Redis 没有"数据库/表"目录树：展开只翻展开态，不做 SQL 元数据请求。
    const isRedis =
      get().profiles.find((entry) => entry.id === profileId)?.engine === "redis";
    if (isRedis) return;
    if (expanded && get().databases[profileId] === undefined) {
      await get().refreshDatabases(profileId);
    }
  },

  // 只改"展开"，不碰"已打开"：点箭头看一眼表列表，不该把库标成已打开。
  toggleDatabase: async (profileId, database) => {
    const key = tablesKey(profileId, database);
    const expanded = !get().expandedDatabases[key];
    set((state) => ({
      expandedDatabases: { ...state.expandedDatabases, [key]: expanded },
    }));
    persistExpanded(get);
    if (expanded && get().tables[key] === undefined) {
      await get().refreshTables(profileId, database);
    }
  },

  openDatabase: async (profileId, database) => {
    const key = tablesKey(profileId, database);
    set((state) => ({
      openedDatabases: { ...state.openedDatabases, [key]: true },
      expandedDatabases: { ...state.expandedDatabases, [key]: true },
    }));
    persistExpanded(get);
    if (get().tables[key] === undefined) {
      await get().refreshTables(profileId, database);
    }
  },

  closeDatabase: (profileId, database) => {
    const key = tablesKey(profileId, database);
    set((state) => ({
      openedDatabases: { ...state.openedDatabases, [key]: false },
      expandedDatabases: { ...state.expandedDatabases, [key]: false },
    }));
    persistExpanded(get);
  },

  toggleTable: async (profileId, database, table) => {
    const key = detailKey(profileId, database, table);
    const expanded = !get().expandedTables[key];
    set((state) => ({
      expandedTables: { ...state.expandedTables, [key]: expanded },
    }));
    persistExpanded(get);
    if (expanded && get().details[key] === undefined) {
      await get().refreshTableDetail(profileId, database, table);
    }
  },

  toggleCategory: (key) => {
    set((state) => ({
      // 缺省视为展开：只有明确收起过（false）的才需要再点一次打开。
      expandedCategories: {
        ...state.expandedCategories,
        [key]: state.expandedCategories[key] === false,
      },
    }));
    persistExpanded(get);
  },

  refreshDatabases: async (profileId) => {
    // Redis 没有 SQL 元数据目录树；这里直接返回，避免调用 SQL 命令报错。
    if (get().profiles.find((entry) => entry.id === profileId)?.engine === "redis") {
      return;
    }
    const key = dbKey(profileId);
    set((state) => ({
      loading: { ...state.loading, [key]: true },
      errors: { ...state.errors, [key]: null },
    }));
    try {
      const databases = await databaseApi.databases(profileId);
      set((state) => ({
        databases: { ...state.databases, [profileId]: databases },
        loading: { ...state.loading, [key]: false },
      }));
    } catch (error) {
      set((state) => ({
        loading: { ...state.loading, [key]: false },
        errors: { ...state.errors, [key]: toDbError(error) },
      }));
    } finally {
      await get().refreshStatus(profileId);
    }
  },

  refreshTables: async (profileId, database) => {
    const key = tablesKey(profileId, database);
    set((state) => ({
      loading: { ...state.loading, [key]: true },
      errors: { ...state.errors, [key]: null },
    }));
    try {
      const tables = await databaseApi.tables(profileId, database);
      set((state) => ({
        tables: { ...state.tables, [key]: tables },
        loading: { ...state.loading, [key]: false },
      }));
    } catch (error) {
      set((state) => ({
        loading: { ...state.loading, [key]: false },
        errors: { ...state.errors, [key]: toDbError(error) },
      }));
    }
  },

  refreshTableDetail: async (profileId, database, table) => {
    const key = detailKey(profileId, database, table);
    set((state) => ({
      loading: { ...state.loading, [key]: true },
      errors: { ...state.errors, [key]: null },
    }));
    try {
      const detail = await databaseApi.tableDetail(profileId, database, table);
      set((state) => ({
        details: { ...state.details, [key]: detail },
        loading: { ...state.loading, [key]: false },
      }));
    } catch (error) {
      set((state) => ({
        loading: { ...state.loading, [key]: false },
        errors: { ...state.errors, [key]: toDbError(error) },
      }));
    }
  },

  invalidate: async (profileId) => {
    try {
      await databaseApi.invalidateMetadata(profileId);
    } catch {
      // 缓存失效失败不影响后续请求：下一次展开仍会重新查。
    }
    const prefix = `${profileId}\u0001`;
    set((state) => ({
      databases: { ...state.databases, [profileId]: [] },
      tables: Object.fromEntries(
        Object.entries(state.tables).filter(([key]) => !key.startsWith(prefix)),
      ),
      details: Object.fromEntries(
        Object.entries(state.details).filter(([key]) => !key.startsWith(prefix)),
      ),
    }));
    await get().refreshDatabases(profileId);
  },

  ensureSession: (profileId) => {
    // 防御：Redis 没有 SQL 会话。任何入口误用 ensureSession 都必须改走
    // db_redis_connect —— 送进 db_connect 只会被后端以 unsupported 拒绝。
    if (isRedisProfile(get, profileId)) {
      return get().redisConnect(profileId).then(() => null);
    }

    const existing = get().sessions[profileId];
    if (existing) return Promise.resolve(existing.state === "lost" ? null : existing);
    const inflight = sqlConnectInFlight.get(profileId);
    if (inflight) return inflight;
    const epoch = connectionEpoch.get(profileId) ?? 0;
    const task = (async () => {
      set((state) => ({
        sessionErrors: { ...state.sessionErrors, [profileId]: null },
      }));
      try {
        const info = await databaseApi.connect(profileId, crypto.randomUUID());
        if ((connectionEpoch.get(profileId) ?? 0) !== epoch) {
          await databaseApi.disconnect(info.session_id).catch(() => undefined);
          return null;
        }
        set((state) => ({
          sessions: { ...state.sessions, [profileId]: info },
        }));
        void get().refreshStatus(profileId);
        return info;
      } catch (error) {
        if ((connectionEpoch.get(profileId) ?? 0) !== epoch) return null;
        const info = toDbError(error);
        set((state) => ({
          sessionErrors: { ...state.sessionErrors, [profileId]: info },
        }));
        reportConnectError(
          get().profiles.find((profile) => profile.id === profileId),
          info,
          i18n.t("连接失败"),
        );
        return null;
      }
    })();
    sqlConnectInFlight.set(profileId, task);
    void task.finally(() => {
      if (sqlConnectInFlight.get(profileId) === task) sqlConnectInFlight.delete(profileId);
    });
    return task;
  },

  /**
   * Redis 连接：走 db_redis_connect（无 SQL 会话概念），结果只体现在
   * statuses（绿点）里；错误放进 sessionErrors 供侧栏 / 键浏览器展示。
   *
   * 同一 profile 的并发调用合并成一次 IPC：侧栏手动点"打开连接"和键浏览器
   * 挂载时的自动建连经常同时发生，不能各发一条。
   */
  redisConnect: (profileId) => {
    const inflight = redisConnectInFlight.get(profileId);
    if (inflight) return inflight;

    const task = (async () => {
      set((state) => ({
        redisConnecting: { ...state.redisConnecting, [profileId]: true },
        sessionErrors: { ...state.sessionErrors, [profileId]: null },
      }));
      try {
        const status = await databaseApi.redisConnect(profileId);
        // Redis 的连接状态唯一来源就是 statuses，绝不写 sessions。
        set((state) => ({
          statuses: { ...state.statuses, [profileId]: status },
        }));
      } catch (error) {
        const info = toDbError(error);
        set((state) => ({
          sessionErrors: { ...state.sessionErrors, [profileId]: info },
        }));
        reportConnectError(
          get().profiles.find((profile) => profile.id === profileId),
          info,
          i18n.t("Redis 连接失败"),
        );
        // 失败后回读一次：上一次的运行时可能还在，绿灯不能凭旧值亮着。
        void get().refreshStatus(profileId);
      } finally {
        set((state) => ({
          redisConnecting: { ...state.redisConnecting, [profileId]: false },
        }));
        redisConnectInFlight.delete(profileId);
      }
    })();

    redisConnectInFlight.set(profileId, task);
    return task;
  },

  redisReconnect: async (profileId) => {
    // db_redis_connect 对已存在的运行时会直接复用，改过主机/密码/TLS 后
    // 不关旧的等于没重连：必须先把 Rust 侧运行时关掉。
    await get().disconnectProfile(profileId);
    await get().redisConnect(profileId);
  },

  runSessionCommand: async (profileId, sql) => {
    const session = get().sessions[profileId];
    if (!session) throw new Error(i18n.t("会话不存在，无法执行事务命令"));
    const started = await databaseApi.queryStart(session.session_id, sql);
    let terminal: string | null = null;
    let batchError: DbErrorInfo | null = null;
    try {
      for (let guard = 0; guard < 200; guard += 1) {
        const response = await databaseApi.queryNext(started.query_id);
        terminal = response.state;
        if (response.batch?.kind === "error") {
          batchError = response.batch.error;
        }
        if (
          terminal === "completed" ||
          terminal === "cancelled" ||
          terminal === "failed" ||
          terminal === "outcome_unknown"
        ) {
          break;
        }
        // 没到终态就不要无间隔打满 IPC；让后端有机会推进。
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await databaseApi.queryRelease(started.query_id).catch(() => undefined);
      // 事务状态以服务器 OK 包为准；重新读一次会话信息。
      await get().refreshSession(profileId);
    }

    if (batchError) {
      throw new Error(`${sql} 失败：${batchError.message}`);
    }
    if (
      terminal === null ||
      !["completed", "cancelled", "failed", "outcome_unknown"].includes(
        terminal,
      )
    ) {
      throw new Error(
        `${sql} 轮询超限：等待事务结果超过 ${200 * 25} ms（最后状态 ${terminal ?? "unknown"}），请重新检查会话`,
      );
    }
    if (terminal !== "completed") {
      const detail =
        terminal === "failed"
          ? "服务器执行失败"
          : terminal === "cancelled"
            ? "请求被取消"
            : "事务结果未知，服务器可能已经提交或回滚";
      throw new Error(`${sql} 未成功（${terminal}）：${detail}`);
    }
  },

  reconnect: async (profileId) => {
    // 换会话还会复用旧池和控制连接；显式重连必须完整重建运行时。
    await get().disconnectProfile(profileId);
    return get().ensureSession(profileId);
  },

  closeSession: async (profileId) => {
    connectionEpoch.set(profileId, (connectionEpoch.get(profileId) ?? 0) + 1);
    sqlConnectInFlight.delete(profileId);
    statusRevision.set(profileId, (statusRevision.get(profileId) ?? 0) + 1);
    const session = get().sessions[profileId];
    if (!session) return;
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[profileId];
      return { sessions };
    });
    try {
      await databaseApi.disconnect(session.session_id);
    } catch {
      // 关闭会话失败不影响标签关闭：Rust 端会随进程/连接回收。
    }
  },

  pruneSessions: async (activeProfileIds) => {
    const active = new Set(activeProfileIds);
    const stale = Object.keys(get().sessions).filter((id) => !active.has(id));
    for (const profileId of stale) {
      await get().closeSession(profileId);
    }
  },

  clearSessionError: (profileId) => {
    set((state) => ({
      sessionErrors: { ...state.sessionErrors, [profileId]: null },
    }));
  },

  selectRedisDb: (profileId, dbIndex) => {
    set((state) => ({
      redisDbIndex: { ...state.redisDbIndex, [profileId]: dbIndex },
    }));
  },

  refreshSession: async (profileId) => {
    const session = get().sessions[profileId];
    if (!session) return;
    try {
      const info = await databaseApi.sessionInfo(session.session_id);
      if (get().sessions[profileId]?.session_id !== session.session_id) return;
      if (get().sessions[profileId]?.state === "lost") return;
      set(state => ({
        sessions: { ...state.sessions, [profileId]: info },
        sessionErrors: { ...state.sessionErrors, [profileId]: info.state === "lost" ? lostSessionError() : null },
      }));
    } catch (error) {
      if (get().sessions[profileId]?.session_id !== session.session_id) return;
      set(state => ({
        sessions: { ...state.sessions, [profileId]: { ...session, state: "lost", transaction: "unknown" } },
        sessionErrors: { ...state.sessionErrors, [profileId]: toDbError(error) },
      }));
    }
  },

  refreshStatus: async (profileId) => {
    const revision = (statusRevision.get(profileId) ?? 0) + 1;
    statusRevision.set(profileId, revision);
    await Promise.all([get().refreshSession(profileId), (async () => {
      try {
        const status = await databaseApi.profileStatus(profileId);
        if (statusRevision.get(profileId) !== revision) return;
        set((state) => ({ statuses: { ...state.statuses, [profileId]: status } }));
      } catch {
        // 读取失败不把旧的绿色连接标识当成当前事实。
        // Redis 保持原有连接生命周期；本次只修 SQL 连接。
        if (isRedisProfile(get, profileId)) return;
        if (statusRevision.get(profileId) !== revision) return;
        set(state => ({ statuses: { ...state.statuses, [profileId]: {
          ...state.statuses[profileId], profile_id: profileId, generation: 0,
          connected: false, tunnel_active: false, tunnel_local_port: null,
          open_sessions: 0, active_queries: 0, server_version: null,
        } } }));
      }
    })()]);
  },

  disconnectProfile: async (profileId) => {
    await get().closeSession(profileId);
    try {
      // 只关会话的话 Rust 运行时（隧道/连接池）仍在，状态会一直是 connected；
      // 显式断开必须连运行时一起关，绿灯才会灭。Redis 没有会话，全靠这一步。
      await databaseApi.profileClose(profileId);
    } catch {
      // 运行时可能已经不存在；状态以下一次 refreshStatus 为准。
    }
    await get().refreshStatus(profileId);
  },

  saveProfile: async (profile, password) => {
    const saved = await databaseApi.saveProfile({ profile, password });
    set((state) => ({
      profiles: state.profiles.some((item) => item.id === saved.id)
        ? state.profiles.map((item) => (item.id === saved.id ? saved : item))
        : [saved, ...state.profiles],
    }));
    return saved;
  },

  deleteProfile: async (id) => {
    // 先关会话再删配置：避免运行时持有已删除配置的隧道。
    await get().closeSession(id);
    try {
      await databaseApi.profileClose(id);
    } catch {
      // 运行时可能本来就不存在。
    }
    await databaseApi.deleteProfile(id);
    set((state) => {
      const databases = { ...state.databases };
      delete databases[id];
      return {
        profiles: state.profiles.filter((profile) => profile.id !== id),
        databases,
      };
    });
  },

  testConnection: async (profile, password) => {
    return databaseApi.testConnection(profile, password);
  },
}));
