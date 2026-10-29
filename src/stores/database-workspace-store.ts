/**
 * 数据库工作区的工作项模型。
 *
 * 一个"工作项"是右侧列表里的一行，也是中央一个**独立**的页面：
 * - `table`：一张表的数据/结构/索引/DDL；
 * - `query`：一份 SQL 与它的结果。
 *
 * 关键约束：
 * - 工作项按稳定 id 去重：同一张表双击两次只定位已有项，不会开两份；
 * - 每个工作项的状态（分页、筛选、待修改、SQL、结果、滚动位置）独立，
 *   切换只改可见性，**不卸载**（见 `WorkItemHost`），所以不会丢状态；
 * - 右侧列表是唯一的切换入口，不在中央再放一排横向标签。
 */
import { create } from "zustand";

export type WorkItemKind = "table" | "query" | "structure" | "objects";

export interface WorkItem {
  id: string;
  kind: WorkItemKind;
  profileId: string;
  /** 跨连接分组时显示；表工作项也用于路径。 */
  connectionName: string;
  database: string | null;
  /** 表名，或查询的默认名。 */
  objectName: string;
  /** 可重命名的显示名。 */
  title: string;
  pinned: boolean;
  createdAt: number;
  /** 表格待提交修改数量（由表格页上报）。 */
  pendingCount: number;
  /** 查询执行中 / 表格加载中。 */
  running: boolean;
  /** SQL 与上次保存/打开相比有变化。 */
  dirty: boolean;
  savedQueryId: string | null;
}

export interface DdlTarget {
  profileId: string;
  database: string;
  table: string;
}

export interface FieldCardTarget {
  profileId: string;
  database: string;
  table: string;
  column: string;
}

export interface SavedQuery {
  id: string;
  profileId: string;
  connectionName: string;
  database: string | null;
  name: string;
  sql: string;
  updatedAt: number;
}

const SAVED_KEY = "ops.db.savedQueries";

function loadSaved(): SavedQuery[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SavedQuery =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as SavedQuery).id === "string" &&
        typeof (entry as SavedQuery).sql === "string",
    );
  } catch {
    return [];
  }
}

function persistSaved(queries: SavedQuery[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(queries));
  } catch {
    // 存不下只影响"保存的查询"，不阻塞编辑。
  }
}

interface WorkspaceState {
  items: WorkItem[];
  activeId: string | null;
  rightCollapsed: boolean;
  rightWidth: number;
  savedQueries: SavedQuery[];

  openTable: (args: {
    profileId: string;
    connectionName: string;
    database: string;
    table: string;
  }) => string;
  /**
   * 表结构是**独立工作项**：可以和表数据页同时打开，切换时互不影响。
   */
  openStructure: (args: {
    profileId: string;
    connectionName: string;
    database: string;
    table: string;
  }) => string;
  /** 点击左侧数据库：打开该库全部表/视图的搜索列表。 */
  openDatabaseObjects: (args: {
    profileId: string;
    connectionName: string;
    database: string;
  }) => string;
  newQuery: (args: {
    profileId: string;
    connectionName: string;
    database: string | null;
    sql?: string;
    savedQueryId?: string;
    title?: string;
  }) => string;
  setActive: (id: string) => void;
  close: (id: string) => void;
  togglePin: (id: string) => void;
  rename: (id: string, title: string) => void;
  /** 表重命名后同步已打开的数据/结构工作项。 */
  renameTableItems: (
    profileId: string,
    database: string,
    oldTable: string,
    newTable: string,
  ) => void;
  setStatus: (
    id: string,
    patch: Partial<Pick<WorkItem, "pendingCount" | "running" | "dirty">>,
  ) => void;
  setRightCollapsed: (collapsed: boolean) => void;
  setRightWidth: (width: number) => void;

  /**
   * 右侧面板：默认是"已打开"列表；点 DDL 时临时切换为 DDL 预览并加宽，
   * 关闭后恢复原来的列表和宽度。
   */
  rightPanel: "items" | "ddl" | "connection";
  ddl: DdlTarget | null;
  widthBeforeDdl: number | null;
  showDdl: (target: DdlTarget) => void;
  hideDdl: () => void;

  /** 左侧点连接时，右侧显示该连接的属性（类型、版本、主机、TLS…）。 */
  connectionInfo: string | null;
  widthBeforeConnection: number | null;
  showConnectionInfo: (profileId: string) => void;
  hideConnectionInfo: () => void;

  /** 结构页点击字段后，在右侧插入的字段信息卡片。 */
  fieldCard: FieldCardTarget | null;
  showFieldCard: (target: FieldCardTarget) => void;
  hideFieldCard: () => void;

  /**
   * 外部（快捷键 / 命令面板）请求关闭某个工作项。
   *
   * 关闭必须经过 `DatabaseView` 里的事务安全协调器（检查运行中查询、
   * 待提交修改、未保存草稿、未提交事务），所以这里只**投递请求**，
   * 由对应连接的 DatabaseView 消费后再决定是否弹确认。
   */
  closeRequest: {
    id: string;
    profileId: string;
    /** one = 只关这一项；right = 关它右侧的全部（命令面板用）。 */
    mode: "one" | "right";
  } | null;
  requestClose: (id: string, profileId: string, mode?: "one" | "right") => void;
  /** 消费掉请求；只清匹配的那一条，避免误清后续新请求。 */
  consumeCloseRequest: (id: string) => void;

  saveQuery: (args: {
    itemId: string;
    profileId: string;
    connectionName: string;
    database: string | null;
    name: string;
    sql: string;
  }) => SavedQuery;
  deleteSavedQuery: (id: string) => void;
  markQuerySaved: (itemId: string, savedQueryId: string, title: string) => void;
}

const tableId = (profileId: string, database: string, table: string) =>
  `table:${profileId}:${database}:${table}`;

export const useDatabaseWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  items: [],
  activeId: null,
  rightCollapsed: false,
  rightWidth: 220,
  rightPanel: "items",
  ddl: null,
  widthBeforeDdl: null,
  connectionInfo: null,
  widthBeforeConnection: null,
  fieldCard: null,
  closeRequest: null,
  savedQueries: loadSaved(),

  requestClose: (id, profileId, mode = "one") =>
    set({ closeRequest: { id, profileId, mode } }),
  consumeCloseRequest: (id) =>
    set((state) =>
      state.closeRequest?.id === id ? { closeRequest: null } : {},
    ),

  openTable: ({ profileId, connectionName, database, table }) => {
    const id = tableId(profileId, database, table);
    const existing = get().items.find((item) => item.id === id);
    if (existing) {
      set({ activeId: id });
      return id;
    }
    set((state) => ({
      items: [
        ...state.items,
        {
          id,
          kind: "table",
          profileId,
          connectionName,
          database,
          objectName: table,
          title: table,
          pinned: false,
          createdAt: Date.now(),
          pendingCount: 0,
          running: false,
          dirty: false,
          savedQueryId: null,
        },
      ],
      activeId: id,
    }));
    return id;
  },

  openStructure: ({ profileId, connectionName, database, table }) => {
    const id = `structure:${profileId}:${database}:${table}`;
    const existing = get().items.find((item) => item.id === id);
    if (existing) {
      set({ activeId: id });
      return id;
    }
    set((state) => ({
      items: [
        ...state.items,
        {
          id,
          kind: "structure",
          profileId,
          connectionName,
          database,
          objectName: table,
          title: `${table} · 结构`,
          pinned: false,
          createdAt: Date.now(),
          pendingCount: 0,
          running: false,
          dirty: false,
          savedQueryId: null,
        },
      ],
      activeId: id,
    }));
    return id;
  },

  openDatabaseObjects: ({ profileId, connectionName, database }) => {
    const id = `objects:${profileId}:${database}`;
    const existing = get().items.find((item) => item.id === id);
    if (existing) {
      set({ activeId: id });
      return id;
    }
    set((state) => ({
      items: [
        ...state.items,
        {
          id,
          kind: "objects",
          profileId,
          connectionName,
          database,
          objectName: database,
          title: `${database} · 对象`,
          pinned: false,
          createdAt: Date.now(),
          pendingCount: 0,
          running: false,
          dirty: false,
          savedQueryId: null,
        },
      ],
      activeId: id,
    }));
    return id;
  },

  newQuery: ({ profileId, connectionName, database, sql, savedQueryId, title }) => {
    // 同一份保存的查询只允许一个工作项：再次打开时聚焦原有工作项，
    // 不覆盖它里面尚未保存的编辑。
    if (savedQueryId) {
      const existing = get().items.find(
        (item) => item.savedQueryId === savedQueryId,
      );
      if (existing) {
        set({ activeId: existing.id });
        return existing.id;
      }
    }
    const id = `query:${crypto.randomUUID()}`;
    const count = get().items.filter(
      (item) => item.kind === "query" && item.profileId === profileId,
    ).length;
    const name = title ?? `查询 ${count + 1}`;
    set((state) => ({
      items: [
        ...state.items,
        {
          id,
          kind: "query",
          profileId,
          connectionName,
          database,
          objectName: name,
          title: name,
          pinned: false,
          createdAt: Date.now(),
          pendingCount: 0,
          running: false,
          dirty: !!sql,
          savedQueryId: savedQueryId ?? null,
        },
      ],
      activeId: id,
    }));
    return id;
  },

  setActive: (id) => set({ activeId: id }),

  close: (id) =>
    set((state) => {
      const items = state.items.filter((item) => item.id !== id);
      const activeId =
        state.activeId === id ? (items[items.length - 1]?.id ?? null) : state.activeId;
      return { items, activeId };
    }),

  togglePin: (id) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, pinned: !item.pinned } : item,
      ),
    })),

  rename: (id, title) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, title: title.trim() || item.objectName } : item,
      ),
    })),

  renameTableItems: (profileId, database, oldTable, newTable) =>
    set((state) => ({
      items: state.items.map((item) => {
        if (
          item.profileId !== profileId ||
          item.database !== database ||
          item.objectName !== oldTable ||
          (item.kind !== "table" && item.kind !== "structure")
        ) {
          return item;
        }
        return {
          ...item,
          objectName: newTable,
          title:
            item.kind === "structure" ? `${newTable} · 结构` : newTable,
        };
      }),
    })),

  setStatus: (id, patch) =>
    set((state) => {
      const item = state.items.find((entry) => entry.id === id);
      if (!item) return state;
      // 值没变就不要生成新数组：子组件 effect 上报状态时否则会触发循环渲染。
      const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
        (key) => item[key] !== patch[key],
      );
      if (!changed) return state;
      return {
        items: state.items.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      };
    }),

  setRightCollapsed: (collapsed) => set({ rightCollapsed: collapsed }),

  // DDL 面板需要比默认列表宽；上限放到 560，仍不允许把数据区挤没。
  setRightWidth: (width) =>
    set({ rightWidth: Math.max(160, Math.min(560, width)) }),

  showDdl: (target) =>
    set((state) => {
      // 连接信息/DDL 互斥；以进入临时面板前的宽度为基准，避免越开越宽。
      const baseWidth =
        state.rightPanel === "connection"
          ? state.widthBeforeConnection ?? state.rightWidth
          : state.rightPanel === "ddl"
            ? state.widthBeforeDdl ?? state.rightWidth
            : state.rightWidth;
      return {
        rightPanel: "ddl",
        ddl: target,
        rightCollapsed: false,
        connectionInfo: null,
        widthBeforeConnection: null,
        widthBeforeDdl: baseWidth,
        rightWidth: Math.max(420, baseWidth),
        // DDL 与字段卡片不同时占右侧。
        fieldCard: null,
      };
    }),

  hideDdl: () =>
    set((state) => ({
      rightPanel: "items",
      ddl: null,
      rightWidth: state.widthBeforeDdl ?? state.rightWidth,
      widthBeforeDdl: null,
    })),

  showConnectionInfo: (profileId) =>
    set((state) => {
      const baseWidth =
        state.rightPanel === "connection"
          ? state.widthBeforeConnection ?? state.rightWidth
          : state.rightPanel === "ddl"
            ? state.widthBeforeDdl ?? state.rightWidth
            : state.rightWidth;
      return {
        rightPanel: "connection",
        connectionInfo: profileId,
        ddl: null,
        widthBeforeDdl: null,
        fieldCard: null,
        rightCollapsed: false,
        widthBeforeConnection: baseWidth,
        rightWidth: Math.max(300, baseWidth),
      };
    }),

  hideConnectionInfo: () =>
    set((state) => ({
      rightPanel: "items",
      connectionInfo: null,
      rightWidth: state.widthBeforeConnection ?? state.rightWidth,
      widthBeforeConnection: null,
    })),

  showFieldCard: (target) =>
    set((state) => {
      const restoreConnection =
        state.rightPanel === "connection"
          ? {
              rightPanel: "items" as const,
              connectionInfo: null,
              rightWidth: state.widthBeforeConnection ?? state.rightWidth,
              widthBeforeConnection: null,
            }
          : {};
      return {
        fieldCard: target,
        // 字段卡片需要右侧区域可见；如果 DDL/连接信息开着，先恢复列表和宽度。
        rightCollapsed: false,
        ...(state.rightPanel === "ddl"
          ? {
              rightPanel: "items" as const,
              ddl: null,
              rightWidth: state.widthBeforeDdl ?? state.rightWidth,
              widthBeforeDdl: null,
            }
          : restoreConnection),
      };
    }),
  hideFieldCard: () => set({ fieldCard: null }),

  saveQuery: ({ itemId, profileId, connectionName, database, name, sql }) => {
    const existing = get().items.find((item) => item.id === itemId)?.savedQueryId;
    const saved: SavedQuery = {
      id: existing ?? crypto.randomUUID(),
      profileId,
      connectionName,
      database,
      name: name.trim() || "未命名查询",
      sql,
      updatedAt: Date.now(),
    };
    set((state) => {
      const queries = state.savedQueries.some((entry) => entry.id === saved.id)
        ? state.savedQueries.map((entry) => (entry.id === saved.id ? saved : entry))
        : [saved, ...state.savedQueries];
      persistSaved(queries);
      return {
        savedQueries: queries,
        items: state.items.map((item) =>
          item.id === itemId
            ? {
                ...item,
                savedQueryId: saved.id,
                title: saved.name,
                objectName: saved.name,
                dirty: false,
              }
            : item,
        ),
      };
    });
    return saved;
  },

  deleteSavedQuery: (id) =>
    set((state) => {
      const queries = state.savedQueries.filter((entry) => entry.id !== id);
      persistSaved(queries);
      return { savedQueries: queries };
    }),

  markQuerySaved: (itemId, savedQueryId, title) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === itemId ? { ...item, savedQueryId, title, dirty: false } : item,
      ),
    })),
}));

/** 固定项置顶，其余按打开顺序。 */
export function orderedItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}
