/**
 * Workbench UI state — spec §10, §14, §70.
 */
import { create } from "zustand";
import type { NavModule, SplitDirection, WorkbenchPane, WorkspaceTab } from "@/workbench/types";

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

const createHomeTab = (): WorkspaceTab => ({ id: uuid(), type: "home", title: "首页" });

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
  return tab.type === "home" ? { ...tab, title: tab.title || "首页" } : tab;
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
      return {
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
        connected: false,
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
