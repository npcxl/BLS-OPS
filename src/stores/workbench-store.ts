/**
 * Workbench UI state — spec §10, §14, §70.
 */
import { create } from "zustand";
import type {
  NavModule,
  SplitDirection,
  WorkbenchPane,
  WorkspaceTab,
  WorkspaceTabType,
} from "@/workbench/types";
import { useDomainStore } from "@/stores/domain-store";

const uuid = () => crypto.randomUUID();

function isLeafPane(pane: WorkbenchPane): boolean {
  return !pane.children || pane.children.length === 0;
}

function findPane(root: WorkbenchPane | null, id: string): WorkbenchPane | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findPane(child, id);
    if (found) return found;
  }
  return null;
}

function findLeafWithTab(root: WorkbenchPane, tabId: string): WorkbenchPane | null {
  if (root.tabs.some((tab) => tab.id === tabId)) return root;
  for (const child of root.children ?? []) {
    const found = findLeafWithTab(child, tabId);
    if (found) return found;
  }
  return null;
}

/**
 * The leaf pane holding a tab **of this type** for this server, if any.
 *
 * The tab type is part of the match on purpose: several modules open a tab for
 * the same server (a `project` tab and a `terminal` tab both carry that
 * server's id). Matching on `serverId` alone made the terminal sidebar focus
 * the *project* tab — the user picked a server under 终端 and got the project
 * view back.
 */
function findLeafWithServer(
  root: WorkbenchPane,
  serverId: string,
  tabType: WorkspaceTabType,
): WorkbenchPane | null {
  if (root.tabs.some((tab) => tab.serverId === serverId && tab.type === tabType)) return root;
  for (const child of root.children ?? []) {
    const found = findLeafWithServer(child, serverId, tabType);
    if (found) return found;
  }
  return null;
}

function mapPane(root: WorkbenchPane, id: string, fn: (p: WorkbenchPane) => WorkbenchPane): WorkbenchPane {
  if (root.id === id) return fn(root);
  if (!root.children) return root;
  return { ...root, children: root.children.map((child) => mapPane(child, id, fn)) };
}

function mapTab(root: WorkbenchPane, tabId: string, fn: (tab: WorkspaceTab) => WorkspaceTab): WorkbenchPane {
  const withTabs: WorkbenchPane = {
    ...root,
    tabs: root.tabs.map((tab) => (tab.id === tabId ? fn(tab) : tab)),
  };
  if (!root.children) return withTabs;
  return { ...withTabs, children: root.children.map((child) => mapTab(child, tabId, fn)) };
}

function firstLeafPane(root: WorkbenchPane): WorkbenchPane {
  if (isLeafPane(root)) return root;
  return firstLeafPane(root.children![0]);
}

function replacePane(root: WorkbenchPane, id: string, nextPane: WorkbenchPane): WorkbenchPane {
  return mapPane(root, id, () => nextPane);
}

function removePane(root: WorkbenchPane, id: string): WorkbenchPane | null {
  if (root.id === id) return null;
  if (!root.children) return root;

  const nextChildren: WorkbenchPane[] = [];
  let changed = false;
  for (const child of root.children) {
    if (child.id === id) {
      changed = true;
      continue;
    }
    const result = removePane(child, id);
    if (result !== child) changed = true;
    if (result) nextChildren.push(result);
  }

  if (!changed) return root;
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0];
  return { ...root, children: nextChildren };
}

const createHomeTab = (): WorkspaceTab => ({ id: uuid(), type: "home", title: "Home" });

/**
 * 模块导航标签 —— 存英文 key（natural keys），渲染处统一 `t(...)`。
 * tab title 可能是动态文案（如 server name），`t()` 未命中时原样返回，安全。
 */
const MODULE_LABELS: Record<NavModule, string> = {
  ssh: "Terminal",
  servers: "Servers",
  services: "Services",
  logs: "Logs",
  projects: "Projects",
  commands: "Commands",
  deploy: "Deploy",
  tasks: "Tasks",
  ai: "AI Assistant",
  settings: "Settings",
};

/**
 * Modules that own a real session-driven view rather than a placeholder page.
 *
 * They are opened as their own tab type instead of `type: "module"`, because
 * `TabContent` routes on tab type and each of these needs a live session.
 */
const MODULE_TAB_TYPES: Partial<Record<NavModule, WorkspaceTabType>> = {
  services: "service",
  logs: "logs",
  projects: "project",
  commands: "command_center",
};

/**
 * Inverse of {@link MODULE_TAB_TYPES} plus the terminal/monitor tab types.
 *
 * Keeps the navigation rail highlight in step with whichever tab the user just
 * clicked: activating a `logs` tab should light up the "日志" rail item, and a
 * `terminal` tab should keep the server list (`ssh`) rail item lit.
 */
const TAB_TYPE_TO_MODULE: Partial<Record<WorkspaceTabType, NavModule>> = {
  terminal: "ssh",
  server: "ssh",
  monitor: "ssh",
  service: "services",
  logs: "logs",
  project: "projects",
  command_center: "commands",
  workflow: "deploy",
  deployment: "deploy",
};

const createInitialRootPane = (): WorkbenchPane => {
  const home = createHomeTab();
  return { id: uuid(), tabs: [home], activeTabId: home.id };
};

interface WorkbenchState {
  activeModule: NavModule;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  rootPane: WorkbenchPane;
  focusedPaneId: string | null;
  commandPaletteOpen: boolean;
  globalActionsNonce: number;

  setModule: (m: NavModule) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  setSidebarWidth: (w: number) => void;
  focusPane: (id: string) => void;

  setCommandPaletteOpen: (open: boolean) => void;
  bumpGlobalActionsNonce: () => void;

  setActiveTab: (paneId: string, tabId: string) => void;
  openTab: (tab: WorkspaceTab, opts?: { paneId?: string; split?: SplitDirection }) => void;
  /**
   * Opens a terminal for a server, or — if a terminal tab for that server is
   * already open anywhere — focuses that existing tab instead. Clicking the
   * same server twice therefore never re-connects: one server, one live
   * session, exactly what keeps file-panel state (and the shell) alive while
   * you switch around.
   */
  openOrFocusServerTab: (tab: WorkspaceTab & { serverId: string }) => void;
  /**
   * Opens (or focuses, if already open) the module page tab in the focused pane.
   * 终端/服务器 share the left context sidebar (server list) instead of a page
   * tab, so for those this only switches the active module.
   */
  openModuleTab: (module: NavModule) => void;
  /**
   * Opens (or focuses, if already open for that server) a session-driven module
   * tab bound to a specific server, e.g. the "日志" tab for server X. Used by the
   * module's left server-list sidebar so picking a server loads its view directly.
   */
  openModuleTabForServer: (module: NavModule, serverId: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  closeTabById: (tabId: string) => void;
  closeOtherTabs: (paneId: string, tabId: string) => void;
  closeAllTabs: (paneId: string) => void;
  splitPane: (paneId: string, direction: SplitDirection) => void;
  replacePane: (paneId: string, nextPane: WorkbenchPane) => void;
  /** Patches a tab in place — used when a placeholder terminal picks a server. */
  updateTab: (tabId: string, patch: Partial<WorkspaceTab>) => void;
}

function normalizeTab(tab: WorkspaceTab): WorkspaceTab {
  return tab.type === "home" ? { ...tab, title: tab.title || "Home" } : tab;
}

function createSplitPane(target: WorkbenchPane, direction: SplitDirection, tab: WorkspaceTab): WorkbenchPane {
  const paneA: WorkbenchPane = { id: uuid(), tabs: target.tabs, activeTabId: target.activeTabId };
  const paneB: WorkbenchPane = { id: uuid(), tabs: [normalizeTab(tab)], activeTabId: tab.id };
  return {
    id: target.id,
    direction,
    tabs: [],
    activeTabId: null,
    children: [paneA, paneB],
  };
}

interface PanePatch {
  rootPane: WorkbenchPane;
  focusedPaneId: string | null;
}

/** Closing a tab may collapse a pane, so the root is rebuilt as a whole. */
function closeTabInPane(state: WorkbenchState, paneId: string, tabId: string): PanePatch | null {
  const pane = findPane(state.rootPane, paneId);
  if (!pane || !isLeafPane(pane)) return null;
  const index = pane.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return null;

  const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) {
    if (state.rootPane.id === paneId) {
      const home = createHomeTab();
      return {
        rootPane: { id: state.rootPane.id, tabs: [home], activeTabId: home.id },
        focusedPaneId: paneId,
      };
    }
    const nextRoot = removePane(state.rootPane, paneId) ?? createInitialRootPane();
    return { rootPane: nextRoot, focusedPaneId: firstLeafPane(nextRoot).id };
  }

  const activeTabId =
    pane.activeTabId === tabId ? (tabs[index] ?? tabs[index - 1] ?? tabs[0]).id : pane.activeTabId;
  return {
    rootPane: replacePane(state.rootPane, paneId, { ...pane, tabs, activeTabId }),
    focusedPaneId: paneId,
  };
}

export const useWorkbenchStore = create<WorkbenchState>()((set) => ({
  activeModule: "ssh",
  sidebarCollapsed: false,
  sidebarWidth: 244,
  rootPane: createInitialRootPane(),
  focusedPaneId: null,
  commandPaletteOpen: false,
  globalActionsNonce: 0,

  setModule: (m) => set({ activeModule: m }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setSidebarWidth: (w) => set({ sidebarWidth: w }),
  focusPane: (id) => set({ focusedPaneId: id }),

  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  bumpGlobalActionsNonce: () => set((state) => ({ globalActionsNonce: state.globalActionsNonce + 1 })),

  setActiveTab: (paneId, tabId) =>
    set((state) => {
      const pane = findPane(state.rootPane, paneId);
      if (!pane || !isLeafPane(pane)) return state;
      const tab = pane.tabs.find((t) => t.id === tabId);
      if (!tab) return state;
      const module = tab.type === "module" && tab.module
        ? tab.module
        : TAB_TYPE_TO_MODULE[tab.type] ?? state.activeModule;
      return {
        activeModule: module,
        rootPane: replacePane(state.rootPane, paneId, { ...pane, activeTabId: tabId }),
        focusedPaneId: paneId,
      };
    }),

  openTab: (tab, opts) =>
    set((state) => {
      const nextTab = normalizeTab(tab);
      if (opts?.split && state.focusedPaneId) {
        const focused = findPane(state.rootPane, state.focusedPaneId);
        if (focused && isLeafPane(focused) && focused.tabs.length > 0) {
          const branch = createSplitPane(focused, opts.split, nextTab);
          return {
            rootPane: replacePane(state.rootPane, focused.id, branch),
            focusedPaneId: branch.children?.[1]?.id ?? focused.id,
          };
        }
      }

      const targetPaneId = opts?.paneId ?? state.focusedPaneId ?? firstLeafPane(state.rootPane).id;
      const target = findPane(state.rootPane, targetPaneId);
      if (!target || !isLeafPane(target)) return state;

      const tabs = [...target.tabs, nextTab];
      return {
        rootPane: replacePane(state.rootPane, targetPaneId, {
          ...target,
          tabs,
          activeTabId: nextTab.id,
        }),
        focusedPaneId: targetPaneId,
      };
    }),

  openOrFocusServerTab: (tab) =>
    set((state) => {
      // A tab of this kind for this server may live in any pane; prefer the
      // focused pane's tab, then any other. Reusing it keeps the session (and
      // the file panel's directory state) exactly as the user left it.
      // The tab *type* is part of the match: a `project` tab for the same
      // server must never be reused as a terminal.
      const nextTab = normalizeTab(tab);
      // `tab.serverId` is required by this action's signature; `normalizeTab`'s
      // copy widens it back to optional, so match on the caller's value.
      const pane = findLeafWithServer(state.rootPane, tab.serverId, nextTab.type);
      if (pane) {
        const existing = pane.tabs.find(
          (item) => item.serverId === tab.serverId && item.type === nextTab.type,
        );
        if (existing) {
          return {
            activeModule: TAB_TYPE_TO_MODULE[existing.type] ?? state.activeModule,
            rootPane: replacePane(state.rootPane, pane.id, { ...pane, activeTabId: existing.id }),
            focusedPaneId: pane.id,
          };
        }
      }

      // None open: create a fresh session in the focused pane.
      const targetPaneId = state.focusedPaneId ?? firstLeafPane(state.rootPane).id;
      const target = findPane(state.rootPane, targetPaneId);
      if (!target || !isLeafPane(target)) return state;
      return {
        activeModule: TAB_TYPE_TO_MODULE[nextTab.type] ?? state.activeModule,
        rootPane: replacePane(state.rootPane, targetPaneId, {
          ...target,
          tabs: [...target.tabs, nextTab],
          activeTabId: nextTab.id,
        }),
        focusedPaneId: targetPaneId,
      };
    }),

  openModuleTab: (module) =>
    set((state) => {
      // 终端/服务器 render in the left context sidebar — switch the module and
      // surface one of its own tabs.
      //
      // The tab switch matters: `activeModule` only drives the left sidebar and
      // the rail highlight, while the right side renders `activeTabId`. Without
      // it, switching from 项目 to 终端 left 项目's tab on screen — the sidebar
      // changed but the content did not.
      if (module === "ssh" || module === "servers") {
        const paneId0 = state.focusedPaneId ?? firstLeafPane(state.rootPane).id;
        const pane0 = findPane(state.rootPane, paneId0);
        if (!pane0 || !isLeafPane(pane0)) return { activeModule: module };
        const own = pane0.tabs.find((tab) => TAB_TYPE_TO_MODULE[tab.type] === module);
        // No tab of this module is open: clear the selection so the pane shows
        // its empty state (pick a server on the left) instead of leaving
        // another module's tab — 项目, say — on screen under the 终端 rail.
        if (!own) {
          return {
            activeModule: module,
            rootPane: replacePane(state.rootPane, paneId0, { ...pane0, activeTabId: null }),
            focusedPaneId: paneId0,
          };
        }
        return {
          activeModule: module,
          rootPane: replacePane(state.rootPane, paneId0, { ...pane0, activeTabId: own.id }),
          focusedPaneId: paneId0,
        };
      }

      const paneId = state.focusedPaneId ?? firstLeafPane(state.rootPane).id;
      const pane = findPane(state.rootPane, paneId);
      if (!pane || !isLeafPane(pane)) return state;

      // Session-driven modules: reuse an open tab of that kind if there is
      // one, so clicking the rail twice does not spawn a second session.
      const tabType = MODULE_TAB_TYPES[module];
      if (tabType) {
        const existing = pane.tabs.find((tab) => tab.type === tabType);
        if (existing) {
          return {
            activeModule: module,
            rootPane: replacePane(state.rootPane, paneId, { ...pane, activeTabId: existing.id }),
            focusedPaneId: paneId,
          };
        }
        const tab = normalizeTab({
          id: uuid(),
          type: tabType,
          module,
          title: MODULE_LABELS[module],
          sessionId: uuid(),
        });
        return {
          activeModule: module,
          rootPane: replacePane(state.rootPane, paneId, {
            ...pane,
            tabs: [...pane.tabs, tab],
            activeTabId: tab.id,
          }),
          focusedPaneId: paneId,
        };
      }

      const existing = pane.tabs.find((tab) => tab.type === "module" && tab.module === module);
      if (existing) {
        return {
          activeModule: module,
          rootPane: replacePane(state.rootPane, paneId, { ...pane, activeTabId: existing.id }),
          focusedPaneId: paneId,
        };
      }
      const tab = normalizeTab({ id: uuid(), type: "module", module, title: MODULE_LABELS[module] });
      return {
        activeModule: module,
        rootPane: replacePane(state.rootPane, paneId, {
          ...pane,
          tabs: [...pane.tabs, tab],
          activeTabId: tab.id,
        }),
        focusedPaneId: paneId,
      };
    }),

  openModuleTabForServer: (module, serverId) =>
    set((state) => {
      const tabType = MODULE_TAB_TYPES[module];
      if (!tabType) return state;
      const paneId = state.focusedPaneId ?? firstLeafPane(state.rootPane).id;
      const pane = findPane(state.rootPane, paneId);
      if (!pane || !isLeafPane(pane)) return state;

      // Reuse the tab already bound to this server for this module.
      const existing = pane.tabs.find((tab) => tab.type === tabType && tab.serverId === serverId);
      if (existing) {
        return {
          activeModule: module,
          rootPane: replacePane(state.rootPane, paneId, { ...pane, activeTabId: existing.id }),
          focusedPaneId: paneId,
        };
      }

      const server = useDomainStore.getState().servers.find((s) => s.id === serverId);
      const tab = normalizeTab({
        id: uuid(),
        type: tabType,
        module,
        title: server ? server.name : MODULE_LABELS[module],
        subtitle: server ? `${server.host}:${server.port}` : undefined,
        serverId,
        sessionId: uuid(),
      });

      // If the active tab in this pane is the same module with no server bound
      // yet (the "pick a server" page), replace it so we don't accumulate a dead
      // selector tab.
      const active = pane.tabs.find((t) => t.id === pane.activeTabId);
      const isSelector = !!active && active.module === module && !active.serverId;
      const tabs = isSelector
        ? pane.tabs.map((t) => (t.id === active!.id ? tab : t))
        : [...pane.tabs, tab];

      return {
        activeModule: module,
        rootPane: replacePane(state.rootPane, paneId, {
          ...pane,
          tabs,
          activeTabId: tab.id,
        }),
        focusedPaneId: paneId,
      };
    }),

  closeTab: (paneId, tabId) => set((state) => closeTabInPane(state, paneId, tabId) ?? state),

  closeTabById: (tabId) =>
    set((state) => {
      const pane = findLeafWithTab(state.rootPane, tabId);
      if (!pane) return state;
      return closeTabInPane(state, pane.id, tabId) ?? state;
    }),

  closeOtherTabs: (paneId, tabId) =>
    set((state) => {
      const pane = findPane(state.rootPane, paneId);
      if (!pane || !isLeafPane(pane)) return state;
      const keep = pane.tabs.find((tab) => tab.id === tabId);
      if (!keep) return state;
      return {
        rootPane: replacePane(state.rootPane, paneId, { ...pane, tabs: [keep], activeTabId: keep.id }),
        focusedPaneId: paneId,
      };
    }),

  closeAllTabs: (paneId) =>
    set((state) => {
      const pane = findPane(state.rootPane, paneId);
      if (!pane || !isLeafPane(pane)) return state;
      if (state.rootPane.id === paneId) {
        const home = createHomeTab();
        return { rootPane: { id: state.rootPane.id, tabs: [home], activeTabId: home.id }, focusedPaneId: paneId };
      }
      const nextRoot = removePane(state.rootPane, paneId) ?? createInitialRootPane();
      return { rootPane: nextRoot, focusedPaneId: firstLeafPane(nextRoot).id };
    }),

  splitPane: (paneId, direction) =>
    set((state) => {
      const pane = findPane(state.rootPane, paneId);
      if (!pane || !isLeafPane(pane) || pane.tabs.length === 0) return state;
      const active = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
      // A split duplicates the view, not the connection: the clone starts its
      // own session instead of stealing the original's.
      const cloned: WorkspaceTab = {
        ...active,
        id: uuid(),
        title: `${active.title} 2`,
        sessionId: undefined,
      };
      const branch = createSplitPane(pane, direction, cloned);
      return {
        rootPane: replacePane(state.rootPane, paneId, branch),
        focusedPaneId: branch.children?.[1]?.id ?? paneId,
      };
    }),

  replacePane: (paneId, nextPane) =>
    set((state) => ({ rootPane: replacePane(state.rootPane, paneId, nextPane), focusedPaneId: paneId })),

  updateTab: (tabId, patch) =>
    set((state) => ({ rootPane: mapTab(state.rootPane, tabId, (tab) => ({ ...tab, ...patch })) })),
}));
