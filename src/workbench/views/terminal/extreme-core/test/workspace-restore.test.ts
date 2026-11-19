import { beforeEach, describe, expect, it } from "vitest";
import { persistExtremeState, useExtremeStore } from "@/stores/extreme-store";
import { readLastWorkspaces, readWorkspaces } from "../workspace-history";

/**
 * 「打开超能就多一条空对话」的回归。
 *
 * 规则：
 * * 进入服务器：**上次选中的** → **这台最近使用的** → 欢迎态（不建记录）；
 * * 只有发第一条消息 / 点「新建任务」才落记录；
 * * 退出再进、重连、改名、应用重启都不新增。
 */

const KEYS = [
  "bls-ops.extreme-workspaces.v2",
  "bls-ops.extreme-workspaces.v1",
  "bls-ops.extreme-last-workspace.v1",
];

beforeEach(() => {
  for (const key of KEYS) localStorage.removeItem(key);
  useExtremeStore.setState({
    active: false,
    serverId: null,
    server: null,
    serverHost: null,
    sessionId: null,
    connections: {},
    lastWorkspaceByServer: {},
    workspaces: [],
    workspaceId: null,
    draft: "",
    messages: [],
    attachments: [],
    plan: null,
    planSession: null,
    planTaskId: null,
    notice: null,
    model: null,
    executing: false,
    tasks: {},
    taskVersions: {},
    panelShown: false,
    paneByWorkspace: {},
    paneLists: {},
    paneMru: {},
    paneTab: "files",
    paneView: "hidden",
    browserByWorkspace: {},
    logSourceByWorkspace: {},
    remotePathByWorkspace: {},
    unread: {},
  });
});

const store = () => useExtremeStore.getState();
const enter = (serverId: string, server: string, sessionId: string, host = "root@10.0.0.1:22") =>
  store().enter(serverId, server, sessionId, host);

/** 模拟"关掉应用再打开"：只保留磁盘上的东西。 */
function restart() {
  persistExtremeState();
  const workspaces = readWorkspaces();
  const last = readLastWorkspaces();
  useExtremeStore.setState({
    active: false,
    serverId: null,
    server: null,
    serverHost: null,
    sessionId: null,
    connections: {},
    lastWorkspaceByServer: last,
    workspaces,
    workspaceId: null,
    messages: [],
    draft: "",
    attachments: [],
    plan: null,
    planSession: null,
    planTaskId: null,
    notice: null,
    model: null,
    executing: false,
    tasks: {},
    taskVersions: {},
    panelShown: false,
  });
}

describe("进入超能不新建空对话", () => {
  it("这台服务器还没历史：欢迎态，不落记录", () => {
    enter("srv-a", "aliyun", "sess-1");
    expect(store().workspaceId).toBeNull();
    expect(store().workspaces).toHaveLength(0);
  });

  it("发第一条消息才落记录；退出再进三次数量不变、始终同一条", () => {
    enter("srv-a", "aliyun", "sess-1");
    const id = store().ensureWorkspace()!;
    store().pushMessage({ id: "m-1", role: "user", text: "看看这台机器" });

    for (let round = 0; round < 3; round += 1) {
      store().exit();
      enter("srv-a", "aliyun", "sess-1");
      expect(store().workspaceId).toBe(id);
      expect(store().workspaces).toHaveLength(1);
    }
  });

  it("应用重启（重新读盘）后仍恢复同一条，不新增", () => {
    enter("srv-a", "aliyun", "sess-1");
    const id = store().ensureWorkspace()!;
    store().pushMessage({ id: "m-1", role: "user", text: "看看这台机器" });
    store().setDraftText("半句草稿");

    restart();
    expect(store().lastWorkspaceByServer["srv-a"]).toBe(id);
    enter("srv-a", "aliyun", "sess-2");
    expect(store().workspaceId).toBe(id);
    expect(store().workspaces).toHaveLength(1);
    expect(store().messages.map((message) => message.text)).toEqual(["看看这台机器"]);
    // 未发送草稿也恢复。
    expect(store().draft).toBe("半句草稿");
  });

  it("上次选中的记录丢了：打开这台最近使用的一条，而不是新建", () => {
    enter("srv-a", "aliyun", "sess-1");
    store().ensureWorkspace();
    store().pushMessage({ id: "m-1", role: "user", text: "第一条" });
    store().exit();

    enter("srv-a", "aliyun", "sess-1");
    store().addWorkspace([]);
    const second = store().workspaceId!;
    store().pushMessage({ id: "m-2", role: "user", text: "第二条" });
    store().exit();

    // 模拟 last 映射丢失（换机器 / 清缓存）。
    useExtremeStore.setState({ lastWorkspaceByServer: {} });
    enter("srv-a", "aliyun", "sess-1");
    expect(store().workspaceId).toBe(second);
    expect(store().workspaces).toHaveLength(2);
  });

  it("重连（新 sessionId）与服务器改名都还回到同一条", () => {
    enter("srv-a", "aliyun", "sess-1");
    const id = store().ensureWorkspace()!;
    store().pushMessage({ id: "m-1", role: "user", text: "看看" });
    store().exit();

    enter("srv-a", "aliyun", "sess-2");
    expect(store().workspaceId).toBe(id);
    expect(store().sessionId).toBe("sess-2");

    store().exit();
    enter("srv-a", "aliyun-改名", "sess-3");
    expect(store().workspaceId).toBe(id);
    expect(store().workspaces).toHaveLength(1);
  });

  it("同名服务器 / 同地址不同账号互不干扰", () => {
    enter("srv-a", "aliyun", "sess-a1", "root@10.0.0.1:22");
    const a = store().ensureWorkspace()!;
    store().pushMessage({ id: "a-1", role: "user", text: "A 的对话" });

    enter("srv-b", "aliyun", "sess-b1", "deploy@10.0.0.1:22");
    expect(store().workspaceId).toBeNull();
    const b = store().ensureWorkspace()!;
    expect(b).not.toBe(a);

    enter("srv-a", "aliyun", "sess-a1", "root@10.0.0.1:22");
    expect(store().workspaceId).toBe(a);
  });
});

describe("快速连接与旧记录也能找回", () => {
  it("快速连接（没有 serverId）：按连接目标恢复，不会每次新开", () => {
    const quick = "quick:root@10.0.0.9:22";
    enter(quick, "10.0.0.9", "sess-1", "root@10.0.0.9:22");
    const id = store().ensureWorkspace()!;
    store().pushMessage({ id: "m-1", role: "user", text: "看看这台机器" });

    for (let round = 0; round < 3; round += 1) {
      store().exit();
      // 每次重新连接都是新 sessionId，但连接目标没变。
      enter(quick, "10.0.0.9", `sess-${round + 2}`, "root@10.0.0.9:22");
      expect(store().workspaceId).toBe(id);
      expect(store().workspaces).toHaveLength(1);
    }
  });

  it("未关联的旧记录：地址对得上就接管，并补上 serverId", () => {
    useExtremeStore.setState({
      workspaces: [
        {
          id: "legacy-1",
          serverId: null,
          server: "aliyun",
          host: "root@10.0.0.9:22",
          serverKey: "[]",
          sessionId: "",
          folders: [],
          messages: [{ id: "old", role: "user", text: "旧对话" }],
          draft: "",
          updatedAt: 10,
        },
      ],
      lastWorkspaceByServer: {},
    });

    enter("srv-new", "aliyun", "sess-1", "root@10.0.0.9:22");
    expect(store().workspaceId).toBe("legacy-1");
    expect(store().messages.map((message) => message.text)).toEqual(["旧对话"]);
    const adopted = store().workspaces.find((entry) => entry.id === "legacy-1")!;
    expect(adopted.serverId).toBe("srv-new");
    expect(store().workspaces).toHaveLength(1);
  });

  it("同地址不同账号：不接管（避免串到别人的历史）", () => {
    useExtremeStore.setState({
      workspaces: [
        {
          id: "legacy-2",
          serverId: null,
          server: "aliyun",
          host: "deploy@10.0.0.9:22",
          serverKey: "[]",
          sessionId: "",
          folders: [],
          messages: [{ id: "old", role: "user", text: "deploy 的对话" }],
          draft: "",
          updatedAt: 10,
        },
      ],
      lastWorkspaceByServer: {},
    });

    enter("srv-root", "aliyun", "sess-1", "root@10.0.0.9:22");
    expect(store().workspaceId).toBeNull();
    expect(store().workspaces).toHaveLength(1);
    expect(store().workspaces[0].serverId).toBeNull();
  });

  it("两台配置不同、地址相同：按 id 各归各的，不互相接管", () => {
    enter("srv-a", "aliyun", "sess-a", "root@10.0.0.9:22");
    const a = store().ensureWorkspace()!;
    store().pushMessage({ id: "m-a", role: "user", text: "A 的" });
    store().exit();

    // 另一个配置指向同一台机器：不应把 A 的历史抢过来。
    enter("srv-b", "aliyun-副本", "sess-b", "root@10.0.0.9:22");
    expect(store().workspaceId).toBeNull();
    expect(store().workspaces).toHaveLength(1);
    expect(store().workspaces[0].id).toBe(a);
  });
});

describe("右栏标签页按对话隔离", () => {
  it("打开 / 关闭标签；最后一个关闭时收起右栏", () => {
    enter("srv-tabs", "aliyun", "sess-tabs");
    const id = store().ensureWorkspace()!;

    store().openPane("files");
    expect(store().paneView).toBe("split");
    store().openPane("logs");
    expect(store().paneLists[id]).toEqual(["files", "logs"]);
    expect(store().paneTab).toBe("logs");

    // 关掉当前标签：切到最近使用的另一个。
    store().closePane("logs");
    expect(store().paneTab).toBe("files");
    expect(store().paneView).toBe("split");

    // 最后一个关掉：右栏收起，但标签页记录保留。
    store().closePane("files");
    expect(store().paneView).toBe("hidden");
    expect(store().paneLists[id]).toEqual([]);
  });

  it("两条对话各自恢复标签、浏览器地址与日志来源", () => {
    enter("srv-two", "aliyun", "sess-two");
    const a = store().ensureWorkspace()!;
    store().openPane("browser");
    store().setBrowserUrl(a, "https://a.example.com/docs");
    store().setLogSource(a, { kind: "journal", unit: "nginx", label: "nginx" });

    store().addWorkspace([]);
    const b = store().workspaceId!;
    store().openPane("logs");
    store().setBrowserUrl(b, "https://b.example.com/logs");

    store().openWorkspace(a);
    expect(store().paneTab).toBe("browser");
    // 新对话默认带一个「远程文件」标签，浏览器是后打开的。
    expect(store().paneLists[a]).toEqual(["files", "browser"]);
    expect(store().browserByWorkspace[a]).toBe("https://a.example.com/docs");
    expect(store().logSourceByWorkspace[a]).toMatchObject({ unit: "nginx" });

    store().openWorkspace(b);
    expect(store().paneTab).toBe("logs");
    expect(store().browserByWorkspace[b]).toBe("https://b.example.com/logs");
  });
});

describe("重命名与删除", () => {
  it("重命名立即生效，重启后仍在", () => {
    enter("srv-a", "aliyun", "sess-1");
    const id = store().ensureWorkspace()!;
    store().pushMessage({ id: "m-1", role: "user", text: "看看这台机器" });
    store().renameWorkspace(id, "  巡检 aliyun  ");

    expect(store().workspaces.find((entry) => entry.id === id)?.title).toBe("巡检 aliyun");
    restart();
    const saved = readWorkspaces().find((entry) => entry.id === id);
    expect(saved?.title).toBe("巡检 aliyun");
  });

  it("删除非当前对话只删记录", () => {
    enter("srv-a", "aliyun", "sess-1");
    const a = store().ensureWorkspace()!;
    store().addWorkspace([]);
    const b = store().workspaceId!;

    store().removeWorkspace(a);
    expect(store().workspaces.map((entry) => entry.id)).toEqual([b]);
    expect(store().workspaceId).toBe(b);
  });

  it("删除当前对话：切到同服务器最近的一条", () => {
    enter("srv-a", "aliyun", "sess-1");
    const a = store().ensureWorkspace()!;
    store().pushMessage({ id: "m-1", role: "user", text: "旧的" });
    store().addWorkspace([]);
    const b = store().workspaceId!;

    store().removeWorkspace(b);
    expect(store().workspaceId).toBe(a);
    expect(store().messages.map((message) => message.text)).toEqual(["旧的"]);

    store().removeWorkspace(a);
    // 一条都不剩：欢迎态，**不新建**记录。
    expect(store().workspaceId).toBeNull();
    expect(store().workspaces).toHaveLength(0);
  });

  it("删除后上次选中的指针同步移除（不会再指回已删的）", () => {
    enter("srv-a", "aliyun", "sess-1");
    const a = store().ensureWorkspace()!;
    store().removeWorkspace(a);
    expect(store().lastWorkspaceByServer["srv-a"]).toBeUndefined();
  });
});
