/**
 * 左右栏布局的**任务级记忆**。
 *
 * 这里锁住的是三条容易回归的规则：
 * 1. 真正新建任务才写默认值（左栏收起、右栏按设置），连续新建各自初始化；
 * 2. 已有任务切走再切回只恢复，不因为它是空白任务就重新收起；
 * 3. 升级前就存在的任务没有专属记录时，按旧全局偏好回退，并落成自己的记录。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_PREFS,
  useExtremeStore,
  type ExtremeState,
} from "@/stores/extreme-store";
import {
  DEFAULT_EXTREME_SETTINGS,
  useExtremeSettingsStore,
} from "@/stores/extreme-settings-store";

function resetStore(overrides: Partial<ExtremeState> = {}) {
  useExtremeStore.setState({
    active: true,
    serverId: "srv-1",
    server: "prod",
    serverHost: "10.0.0.1",
    sessionId: "sess-1",
    connections: { "srv-1": { sessionId: "sess-1", host: "10.0.0.1" } },
    lastWorkspaceByServer: {},
    workspaces: [],
    workspaceId: null,
    messages: [],
    draft: "",
    chatPrefs: DEFAULT_CHAT_PREFS,
    chatPrefsByWorkspace: {},
    paneByWorkspace: {},
    paneLists: {},
    paneMru: {},
    paneView: "hidden",
    paneViewByWorkspace: {},
    railCollapsed: false,
    railByWorkspace: {},
    ...overrides,
  });
}

const layout = (id: string) => {
  const state = useExtremeStore.getState();
  return {
    rail: state.railByWorkspace[id],
    pane: state.paneViewByWorkspace[id],
  };
};

describe("超能左右栏布局", () => {
  beforeEach(() => {
    localStorage.clear();
    useExtremeSettingsStore.setState({ ...DEFAULT_EXTREME_SETTINGS });
    resetStore();
  });

  it("新建任务不收起左栏，右栏若开着则收起、没开则保持收起", () => {
    resetStore({ railCollapsed: false, paneView: "split" });
    useExtremeStore.getState().addWorkspace([]);
    const a = useExtremeStore.getState().workspaceId!;
    expect(useExtremeStore.getState().railCollapsed).toBe(false);
    expect(useExtremeStore.getState().paneView).toBe("hidden");
    expect(layout(a)).toEqual({ rail: false, pane: "hidden" });

    // 原本左栏收起、右栏已隐藏时新建：两者各自保持原样（左栏仍收起，右栏仍隐藏）。
    useExtremeStore.getState().setRailCollapsed(true);
    useExtremeStore.getState().addWorkspace([]);
    const b = useExtremeStore.getState().workspaceId!;
    expect(useExtremeStore.getState().railCollapsed).toBe(true);
    expect(useExtremeStore.getState().paneView).toBe("hidden");
    expect(layout(b)).toEqual({ rail: true, pane: "hidden" });
  });

  it("在右栏开启的会话中新建任务会收起右栏，但不改动旧会话记录", () => {
    useExtremeStore.getState().addWorkspace([]);
    const a = useExtremeStore.getState().workspaceId!;
    useExtremeStore.getState().setPaneView("split");
    useExtremeSettingsStore.getState().update({ newTaskPane: "open" });

    useExtremeStore.getState().addWorkspace([]);
    const b = useExtremeStore.getState().workspaceId!;

    expect(layout(b)).toEqual({ rail: false, pane: "hidden" });
    expect(useExtremeStore.getState().paneView).toBe("hidden");
    // 旧会话 A 原本的右栏展开状态保留。
    expect(layout(a)).toEqual({ rail: false, pane: "split" });

    useExtremeStore.getState().openWorkspace(a);
    expect(useExtremeStore.getState().paneView).toBe("split");
  });

  it("空白任务手动展开后，切走再切回保持原样", () => {
    useExtremeStore.getState().addWorkspace([]);
    const a = useExtremeStore.getState().workspaceId!;
    expect(useExtremeStore.getState().messages).toHaveLength(0);

    useExtremeStore.getState().setRailCollapsed(false);
    useExtremeStore.getState().setPaneView("split");

    // B 是新任务：左栏保持不收起，右栏从 split 收起为 hidden。
    useExtremeStore.getState().addWorkspace([]);
    const b = useExtremeStore.getState().workspaceId!;
    expect(b).not.toBe(a);
    expect(layout(b)).toEqual({ rail: false, pane: "hidden" });
    expect(useExtremeStore.getState().railCollapsed).toBe(false);
    expect(useExtremeStore.getState().paneView).toBe("hidden");

    useExtremeStore.getState().openWorkspace(a);
    expect(useExtremeStore.getState().workspaceId).toBe(a);
    expect(useExtremeStore.getState().railCollapsed).toBe(false);
    expect(useExtremeStore.getState().paneView).toBe("split");
  });

  it("同一条空白任务再次打开不重新初始化", () => {
    useExtremeStore.getState().addWorkspace([]);
    const a = useExtremeStore.getState().workspaceId!;
    useExtremeStore.getState().setRailCollapsed(false);
    useExtremeStore.getState().setPaneView("expanded");

    // 点当前这一条：直接返回，不重载。
    useExtremeStore.getState().openWorkspace(a);
    expect(useExtremeStore.getState().railCollapsed).toBe(false);
    expect(useExtremeStore.getState().paneView).toBe("expanded");

    useExtremeStore.getState().addWorkspace([]);
    useExtremeStore.getState().openWorkspace(a);
    expect(useExtremeStore.getState().paneView).toBe("expanded");
    expect(useExtremeStore.getState().railCollapsed).toBe(false);
  });

  it("重新进入超能后恢复上次那条任务自己的布局", () => {
    useExtremeStore.getState().addWorkspace([]);
    const a = useExtremeStore.getState().workspaceId!;
    useExtremeStore.getState().setRailCollapsed(false);
    useExtremeStore.getState().setPaneView("split");

    useExtremeStore.getState().exit();
    resetStore({
      active: false,
      workspaces: useExtremeStore.getState().workspaces,
      railByWorkspace: useExtremeStore.getState().railByWorkspace,
      paneViewByWorkspace: useExtremeStore.getState().paneViewByWorkspace,
      lastWorkspaceByServer: { "srv-1": a },
    });
    useExtremeStore.getState().enter("srv-1", "prod", "sess-2", "10.0.0.1");

    expect(useExtremeStore.getState().workspaceId).toBe(a);
    expect(useExtremeStore.getState().railCollapsed).toBe(false);
    expect(useExtremeStore.getState().paneView).toBe("split");
  });

  it("自动展开右栏（附件 / AI 打开文件）也算这条任务的布局", () => {
    useExtremeStore.getState().addWorkspace([]);
    const a = useExtremeStore.getState().workspaceId!;
    useExtremeStore.getState().openPane("attachments");
    expect(useExtremeStore.getState().paneView).toBe("split");
    expect(layout(a).pane).toBe("split");

    useExtremeStore.getState().addWorkspace([]);
    useExtremeStore.getState().openWorkspace(a);
    expect(useExtremeStore.getState().paneView).toBe("split");
  });

  it("旧任务没有专属记录时按旧全局偏好回退，并落成自己的记录", () => {
    // 模拟升级前就存在的记录：只有 workspaces，没有任何 rail / pane 条目。
    const legacy = {
      id: "legacy-1",
      serverId: "srv-1",
      server: "prod",
      host: "10.0.0.1",
      serverKey: JSON.stringify(["prod", "10.0.0.1"]),
      sessionId: "sess-1",
      folders: [],
      messages: [],
      draft: "",
      updatedAt: Date.now(),
    };
    resetStore({
      workspaces: [legacy],
      workspaceId: null,
      railCollapsed: false,
      paneView: "hidden",
      lastWorkspaceByServer: { "srv-1": legacy.id },
    });

    useExtremeStore.getState().openWorkspace(legacy.id);

    // 旧全局偏好是"展开 / 右栏收起"：不被当成新任务重新收起。
    expect(useExtremeStore.getState().railCollapsed).toBe(false);
    expect(useExtremeStore.getState().paneView).toBe("hidden");
    // 回退值立刻成为它自己的记录，之后用户调整只影响这一条。
    expect(layout(legacy.id)).toEqual({ rail: false, pane: "hidden" });
  });
});
