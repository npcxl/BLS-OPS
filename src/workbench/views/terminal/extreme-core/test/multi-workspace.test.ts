import { beforeEach, describe, expect, it } from "vitest";
import { useExtremeStore } from "@/stores/extreme-store";
import { readWorkspaces } from "../workspace-history";

/**
 * 多服务器 / 多会话的**状态归属**。
 *
 * 四个标识各司其职：
 * * `serverId` 服务器配置（同名、同地址不同账号靠它区分）；
 * * `sessionId` 一次连接（重连会变）；
 * * `workspaceId` 一条对话；
 * * `taskId` 一次执行。
 */

const V1_KEY = "bls-ops.extreme-workspaces.v1";
const V2_KEY = "bls-ops.extreme-workspaces.v2";

beforeEach(() => {
  localStorage.removeItem(V1_KEY);
  localStorage.removeItem(V2_KEY);
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
  });
});

const store = () => useExtremeStore.getState();
const workspace = (id: string) => store().workspaces.find((entry) => entry.id === id)!;

/**
 * 进入并确保有一条对话。
 *
 * `enter` 本身**不再建记录**（欢迎态等第一条消息），这些用例关心的是后续的
 * 隔离与回写，所以统一在这里补一条。
 */
const enter = (serverId: string, server: string, sessionId: string, host?: string) => {
  useExtremeStore.getState().enter(serverId, server, sessionId, host);
  return useExtremeStore.getState().ensureWorkspace();
};

describe("切服务器：新开空白对话", () => {
  it("A 执行中切到 B，B 是空白对话，A 的消息与草稿原样保留", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const a = store().workspaceId!;
    store().pushMessage({ id: "a-1", role: "user", text: "看看 A" });
    store().setDraftText("半句草稿");

    enter("srv-b", "生产", "sess-b1", "root@10.0.0.2:22");
    const b = store().workspaceId!;

    expect(b).not.toBe(a);
    expect(store().messages).toHaveLength(0);
    expect(store().draft).toBe("");
    expect(store().serverId).toBe("srv-b");

    // A 的对话、草稿都在它自己那条上。
    expect(workspace(a).messages.map((message) => message.text)).toEqual(["看看 A"]);
    expect(workspace(a).draft).toBe("半句草稿");
  });

  it("再次进入同一台服务器（同连接）恢复原对话，不新建", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const a = store().workspaceId!;
    store().pushMessage({ id: "a-1", role: "user", text: "看看 A" });
    store().exit();

    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    expect(store().workspaceId).toBe(a);
    expect(store().messages.map((message) => message.text)).toEqual(["看看 A"]);
    expect(store().workspaces.filter((entry) => entry.serverId === "srv-a")).toHaveLength(1);
  });

  it("重连（新 sessionId）仍回到同一条对话，只换绑连接", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const a = store().workspaceId!;
    store().pushMessage({ id: "a-1", role: "user", text: "看看 A" });

    enter("srv-a", "生产", "sess-a2", "root@10.0.0.1:22");
    expect(store().workspaceId).toBe(a);
    expect(store().sessionId).toBe("sess-a2");
    expect(store().messages).toHaveLength(1);
    // 下一次从这台服务器进来，绑的是新连接。
    expect(store().connections["srv-a"].sessionId).toBe("sess-a2");
  });

  it("服务器改名不影响归属（按 serverId，不按名字）", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const a = store().workspaceId!;
    store().pushMessage({ id: "a-1", role: "user", text: "看看 A" });
    enter("srv-b", "测试", "sess-b1", "root@10.0.0.2:22");

    enter("srv-a", "生产-改名", "sess-a1", "root@10.0.0.1:22");
    expect(store().workspaceId).toBe(a);
    expect(store().messages).toHaveLength(1);
  });

  it("同名服务器、同地址不同账号不会串", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const a = store().workspaceId!;
    store().pushMessage({ id: "a-1", role: "user", text: "A 的对话" });

    // 同名 + 同地址，但账号不同 → 另一台配置。
    enter("srv-b", "生产", "sess-b1", "deploy@10.0.0.1:22");
    const b = store().workspaceId!;
    expect(b).not.toBe(a);
    expect(store().messages).toHaveLength(0);

    store().openWorkspace(a);
    expect(store().messages.map((message) => message.text)).toEqual(["A 的对话"]);
    expect(store().workspaceId).toBe(a);
  });
});

describe("同一台服务器两条对话", () => {
  it("草稿、附件、消息各自独立", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const w1 = store().workspaceId!;
    store().pushMessage({ id: "w1-msg", role: "user", text: "第一条对话" });
    store().setDraftText("草稿一");
    store().setAttachments(() => [
      {
        id: "att-1",
        name: "a.txt",
        size: 10,
        path: "a.txt",
        state: "ready",
        uploadState: "local",
      },
    ]);

    store().addWorkspace([]);
    const w2 = store().workspaceId!;
    expect(w2).not.toBe(w1);
    expect(store().messages).toHaveLength(0);
    expect(store().draft).toBe("");
    expect(store().attachments).toHaveLength(0);

    store().setDraftText("草稿二");
    store().pushMessage({ id: "w2-msg", role: "user", text: "第二条对话" });

    // 切回第一条：草稿、附件、消息都还原。
    store().openWorkspace(w1);
    expect(store().draft).toBe("草稿一");
    expect(store().attachments.map((item) => item.id)).toEqual(["att-1"]);
    expect(store().messages.map((message) => message.text)).toEqual(["第一条对话"]);

    // 第二条也还在。
    store().openWorkspace(w2);
    expect(store().draft).toBe("草稿二");
    expect(store().messages.map((message) => message.text)).toEqual(["第二条对话"]);
  });

  it("切回旧对话恢复任务卡与结论", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const w1 = store().workspaceId!;
    store().pushMessage({ id: "m-user", role: "user", text: "看看这台机器", taskId: "task-1" });
    store().pushMessage({ id: "m-reply", role: "assistant", text: "机器正常。", taskId: "task-1" });
    store().upsertTask({
      id: "task-1",
      source: "agent",
      kind: "probe",
      title: "生产 · 检测",
      workspaceId: w1,
      serverId: "srv-a",
      goal: "看看这台机器",
      status: "done",
      result: "已完成 1 步",
      server: "生产",
      sessionId: "sess-a1",
      cwd: "/srv/app",
      createdAt: 1,
      updatedAt: 2,
      steps: [],
      artifacts: [],
    });

    enter("srv-b", "测试", "sess-b1", "root@10.0.0.2:22");
    store().openWorkspace(w1);

    expect(store().messages.map((message) => message.text)).toEqual([
      "看看这台机器",
      "机器正常。",
    ]);
    expect(store().tasks["task-1"].workspaceId).toBe(w1);
    expect(store().tasks["task-1"].cwd).toBe("/srv/app");
    // 下一轮命令从这个任务停下的目录继续。
    const entry = workspace(w1);
    expect(entry.messages.some((message) => message.taskId === "task-1")).toBe(true);
  });
});

describe("异步回写按归属落库", () => {
  it("后台任务的结论只写回它自己那条对话，不动当前界面", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const a = store().workspaceId!;
    store().pushMessage({ id: "a-user", role: "user", text: "A 的提问", taskId: "task-a" });
    store().pushMessage({ id: "a-reply", role: "assistant", text: "" });

    enter("srv-b", "测试", "sess-b1", "root@10.0.0.2:22");
    const b = store().workspaceId!;
    store().pushMessage({ id: "b-user", role: "user", text: "B 的提问" });

    // A 的任务结束了：按 workspaceId 回写。
    store().patchMessageIn(a, "a-reply", { text: "A 的结论" });

    expect(store().workspaceId).toBe(b);
    expect(store().messages.map((message) => message.text)).toEqual(["B 的提问"]);
    expect(workspace(a).messages.find((message) => message.id === "a-reply")?.text).toBe(
      "A 的结论",
    );
  });

  it("给非当前对话追加消息不会出现在当前界面", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const a = store().workspaceId!;
    enter("srv-b", "测试", "sess-b1", "root@10.0.0.2:22");

    store().pushMessageTo(a, { id: "late", role: "assistant", text: "迟到的结论" });

    expect(store().messages).toHaveLength(0);
    expect(workspace(a).messages.map((message) => message.text)).toEqual(["迟到的结论"]);
  });

  it("执行标记按对话写：A 结束不会清掉 B 的执行中", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const a = store().workspaceId!;
    enter("srv-b", "测试", "sess-b1", "root@10.0.0.2:22");
    const b = store().workspaceId!;

    store().setExecutingFor(b, true);
    expect(store().executing).toBe(true);
    // A 那边结束：清的是 A，B 仍在执行。
    store().setExecutingFor(a, false);
    expect(store().executing).toBe(true);
    expect(workspace(b).context?.executing).toBe(true);
  });
});

describe("断连与未关联", () => {
  it("断连后当前对话只读（sessionId 置空），历史仍可打开", () => {
    enter("srv-a", "生产", "sess-a1", "root@10.0.0.1:22");
    const a = store().workspaceId!;
    store().pushMessage({ id: "a-1", role: "user", text: "看看 A" });

    store().markDisconnected("srv-a");
    expect(store().sessionId).toBeNull();
    expect(store().serverId).toBe("srv-a");
    expect(store().messages).toHaveLength(1);

    // 打开另一台的对话后，再回到 A：仍然是未连接。
    enter("srv-b", "测试", "sess-b1", "root@10.0.0.2:22");
    store().openWorkspace(a);
    expect(store().sessionId).toBeNull();
    expect(store().messages.map((message) => message.text)).toEqual(["看看 A"]);
  });

  it("打开未关联的旧对话时没有连接可用，不会借用当前服务器", () => {
    const legacy = {
      id: "w-old",
      serverKey: JSON.stringify(["生产", "10.0.0.1"]),
      sessionId: "sess-old",
      folders: [],
      messages: [{ id: "m-old", role: "user", text: "旧对话" }],
    };
    localStorage.setItem(V1_KEY, JSON.stringify([legacy]));

    const migrated = readWorkspaces();
    expect(migrated[0].serverId).toBeNull();
    expect(migrated[0].server).toBe("生产");
    expect(migrated[0].host).toBe("10.0.0.1");

    useExtremeStore.setState({ workspaces: migrated });
    enter("srv-b", "测试", "sess-b1", "root@10.0.0.2:22");
    store().openWorkspace("w-old");

    expect(store().serverId).toBeNull();
    expect(store().sessionId).toBeNull();
    expect(store().messages.map((message) => message.text)).toEqual(["旧对话"]);
  });
});
