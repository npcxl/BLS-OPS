/**
 * 数据库工作区的工作项模型。
 *
 * 一个"工作项"是顶部标签条上的一个标签，也是中央一个**独立**的页面：
 * - `table`：一张表的数据/结构/索引/DDL；
 * - `query`：一份 SQL 与它的结果；
 * - `structure`：表结构编辑器；
 * - `objects`：某个库的对象清单。
 *
 * 关键约束：
 * - 工作项按稳定 id 去重：同一张表打开两次只定位已有标签，不会开两份；
 * - 每个工作项的状态（分页、筛选、待修改、SQL、结果、滚动位置）独立，
 *   切换只改可见性，**不卸载**（见 `WorkItemHost`），所以不会丢状态；
 * - 标签条是唯一的切换入口（顶部），右侧只放检查器/DDL，不重复维护第二份列表；
 * - `preview` 标签是"单击预览"的那一个：同一连接的预览标签只保留一个，
 *   下一次单击替换它；开始编辑（有草稿/待提交/运行中）时自动升级为常驻。
 */
import { create } from "zustand";
import { i18n } from "@/i18n";

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
  /** 固定在标签条最左侧（不参与预览替换）。 */
  pinned: boolean;
  /**
   * 预览标签：单击资产树时打开的那个。
   * 同一连接最多一个；被下一次单击替换。开始编辑后自动置 false。
   */
  preview: boolean;
  /** 标签顺序（拖动排序写入）；固定项仍然置顶。 */
  order: number;
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

/**
 * 工作项的两种展示：顶部标签条（默认）或右侧竖排列表。
 *
 * 两种模式是**同一份** `items` 的两种视图，切换只改渲染位置，不动工作项本身：
 * 标签条更适合少量标签的横向切换，右侧列表在标签很多、标题又长时更好扫。
 */
export type WorkItemLayout = "top" | "right";

const SAVED_KEY = "ops.db.savedQueries";
const LAYOUT_KEY = "ops.db.workItemLayout";

function loadLayout(): WorkItemLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "right" ? "right" : "top";
  } catch {
    return "top";
  }
}

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
  /** 顶部标签条 / 右侧列表，落 localStorage（重启后保持上次的选择）。 */
  layout: WorkItemLayout;
  setLayout: (layout: WorkItemLayout) => void;

  openTable: (args: {
    profileId: string;
    connectionName: string;
    database: string;
    table: string;
    /** 单击资产树 = 预览；双击 / 明确打开 = 常驻。 */
    preview?: boolean;
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
  /** 把预览标签升级为常驻（开始编辑 / 双击打开时调用）。 */
  promote: (id: string) => void;
  /** 拖动排序：把 draggedId 放到 targetId 的位置。 */
  reorder: (draggedId: string, targetId: string) => void;
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

/** 新标签排在最后；`reorder` 只归一化单个连接的顺序，所以取全局最大值。 */
function nextOrder(items: WorkItem[]): number {
  return items.reduce((max, item) => (item.order > max ? item.order : max), 0) + 1;
}

/**
 * 单击预览时替换掉同一连接上旧的预览标签。
 *
 * 有未保存内容的预览标签**不能静默销毁**：待提交修改、未保存 SQL、运行中的
 * 查询都说明用户已经在里面干活了，这时把它升级为常驻标签，只替换真正空闲的
 * 那一个。这也是"开始编辑后自动固定"的兜底。
 */
function dropReplacedPreview(
  items: WorkItem[],
  args: { profileId: string; preview: boolean },
): WorkItem[] {
  if (!args.preview) return items;
  return items.flatMap((item) => {
    if (item.profileId !== args.profileId || !item.preview) return [item];
    const busy = item.pendingCount > 0 || item.dirty || item.running;
    return busy ? [{ ...item, preview: false }] : [];
  });
}

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
  layout: loadLayout(),

  setLayout: (layout) => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // 存不下只影响"下次启动用哪种展示"，当前会话仍然照常切换。
    }
    set({ layout });
  },

  requestClose: (id, profileId, mode = "one") =>
    set({ closeRequest: { id, profileId, mode } }),
  consumeCloseRequest: (id) =>
    set((state) =>
      state.closeRequest?.id === id ? { closeRequest: null } : {},
    ),

  openTable: ({ profileId, connectionName, database, table, preview = false }) => {
    const id = tableId(profileId, database, table);
    const existing = get().items.find((item) => item.id === id);
    if (existing) {
      set((state) => ({
        activeId: id,
        // 已经打开过的表被"明确打开"时，顺手把预览标签升级为常驻：
        // 用户既然点了两次（或从菜单打开），就不该再被下一次单击顶掉。
        items: preview
          ? state.items
          : state.items.map((item) =>
              item.id === id && item.preview ? { ...item, preview: false } : item,
            ),
      }));
      return id;
    }
    set((state) => ({
      items: [
        ...dropReplacedPreview(state.items, { profileId, preview }),
        {
          id,
          kind: "table",
          profileId,
          connectionName,
          database,
          objectName: table,
          title: table,
          pinned: false,
          preview,
          order: nextOrder(state.items),
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
          preview: false,
          order: nextOrder(state.items),
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
          // 走 i18n：以前硬编码中文，英文界面这里会漏出「对象」。
        title: `${database} · ${i18n.t("对象")}`,
          pinned: false,
          preview: false,
          order: nextOrder(state.items),
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
          preview: false,
          order: nextOrder(state.items),
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

  setActive: (id) => set(state => state.activeId === id ? state : { activeId: id }),

  close: (id) =>
    set((state) => {
      const ordered = orderedItems(state.items.filter((item) => item.id !== id));
      const removedIndex = orderedItems(state.items).findIndex((item) => item.id === id);
      const items = state.items.filter((item) => item.id !== id);
      // 关掉当前标签后落到它右边那个（没有就退回左边），与浏览器/编辑器的
      // 习惯一致；不要跳到列表末尾 —— 那会让上下文突然变成另一张表。
      const fallback = ordered[Math.min(Math.max(removedIndex, 0), ordered.length - 1)];
      const activeId =
        state.activeId === id ? (fallback?.id ?? null) : state.activeId;
      return { items, activeId };
    }),

  togglePin: (id) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id
          ? {
              ...item,
              pinned: !item.pinned,
              // 固定一定意味着"不被预览替换"；取消固定不会把常驻降回预览。
              preview: item.pinned ? item.preview : false,
            }
          : item,
      ),
    })),

  promote: (id) =>
    set((state) =>
      state.items.some((item) => item.id === id && item.preview)
        ? {
            items: state.items.map((item) =>
              item.id === id ? { ...item, preview: false } : item,
            ),
          }
        : state,
    ),

  reorder: (draggedId, targetId) =>
    set((state) => {
      const dragged = state.items.find((item) => item.id === draggedId);
      const target = state.items.find((item) => item.id === targetId);
      if (!dragged || !target || dragged.id === target.id) return state;
      if (dragged.profileId !== target.profileId) return state;
      const group = orderedItems(
        state.items.filter((item) => item.profileId === dragged.profileId),
      );
      const from = group.findIndex((item) => item.id === draggedId);
      const to = group.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return state;
      const next = [...group];
      next.splice(from, 1);
      next.splice(to, 0, dragged);
      // 只归一化这一个连接的顺序：跨连接的标签条本来就分开渲染。
      const orderById = new Map(next.map((item, index) => [item.id, index + 1]));
      return {
        items: state.items.map((item) =>
          orderById.has(item.id)
            ? { ...item, order: orderById.get(item.id) as number }
            : item,
        ),
      };
    }),

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

/** 固定项置顶，其余按拖动后的顺序；`order` 相同才回退到打开时间。 */
export function orderedItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt - b.createdAt;
  });
}
