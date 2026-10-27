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

const dbKey = (profileId: string) => profileId;
const tablesKey = (profileId: string, database: string) => `${profileId}\u0001${database}`;
const detailKey = (profileId: string, database: string, table: string) =>
  `${profileId}\u0001${database}\u0001${table}`;

/** 把所有异常统一成后端同款结构，界面只认一种错误形状。 */
export function toDbError(error: unknown): DbErrorInfo {
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
  expandedTables: Record<string, boolean>;

  databases: Record<string, DbDatabase[]>;
  tables: Record<string, DbTable[]>;
  details: Record<string, DbTableDetail>;

  loading: Record<string, boolean>;
  errors: Record<string, DbErrorInfo | null>;

  sessions: Record<string, DbSessionInfo>;
  sessionErrors: Record<string, DbErrorInfo | null>;
  statuses: Record<string, ProfileRuntimeStatus>;

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
  toggleTable: (profileId: string, database: string, table: string) => Promise<void>;
  refreshDatabases: (profileId: string) => Promise<void>;
  refreshTables: (profileId: string, database: string) => Promise<void>;
  refreshTableDetail: (profileId: string, database: string, table: string) => Promise<void>;
  invalidate: (profileId: string) => Promise<void>;

  ensureSession: (profileId: string) => Promise<DbSessionInfo | null>;
  closeSession: (profileId: string) => Promise<void>;
  /** 关闭已经不在任何标签里的会话；切换标签不会触发（标签还在）。 */
  pruneSessions: (activeProfileIds: string[]) => Promise<void>;
  refreshStatus: (profileId: string) => Promise<void>;

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

export const useDatabaseStore = create<DatabaseAssetState>()((set, get) => ({
  profiles: [],
  loadingProfiles: false,
  profileError: null,

  expandedProfiles: {},
  expandedDatabases: {},
  expandedTables: {},

  databases: {},
  tables: {},
  details: {},

  loading: {},
  errors: {},

  sessions: {},
  sessionErrors: {},
  statuses: {},
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

  toggleProfile: async (profileId) => {
    const expanded = !get().expandedProfiles[profileId];
    set((state) => ({
      expandedProfiles: { ...state.expandedProfiles, [profileId]: expanded },
    }));
    if (expanded) {
      await get().refreshDatabases(profileId);
    }
  },

  toggleDatabase: async (profileId, database) => {
    const key = tablesKey(profileId, database);
    const expanded = !get().expandedDatabases[key];
    set((state) => ({
      expandedDatabases: { ...state.expandedDatabases, [key]: expanded },
    }));
    if (expanded) {
      await get().refreshTables(profileId, database);
    }
  },

  toggleTable: async (profileId, database, table) => {
    const key = detailKey(profileId, database, table);
    const expanded = !get().expandedTables[key];
    set((state) => ({
      expandedTables: { ...state.expandedTables, [key]: expanded },
    }));
    if (expanded) {
      await get().refreshTableDetail(profileId, database, table);
    }
  },

  refreshDatabases: async (profileId) => {
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

  ensureSession: async (profileId) => {
    const existing = get().sessions[profileId];
    if (existing) return existing;

    set((state) => ({
      sessionErrors: { ...state.sessionErrors, [profileId]: null },
    }));
    try {
      const info = await databaseApi.connect(profileId, crypto.randomUUID());
      set((state) => ({
        sessions: { ...state.sessions, [profileId]: info },
      }));
      void get().refreshStatus(profileId);
      return info;
    } catch (error) {
      set((state) => ({
        sessionErrors: { ...state.sessionErrors, [profileId]: toDbError(error) },
      }));
      return null;
    }
  },

  closeSession: async (profileId) => {
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

  refreshStatus: async (profileId) => {
    try {
      const status = await databaseApi.profileStatus(profileId);
      set((state) => ({ statuses: { ...state.statuses, [profileId]: status } }));
    } catch {
      // 状态是装饰性的；失败不覆盖已有值。
    }
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
