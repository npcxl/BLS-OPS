import { describe, expect, it } from "vitest";
import type { ExtremeAttachment, ExtremeMessage } from "@/stores/extreme-store";
import type { ActionScope } from "../action-scope";
import { buildMessages } from "../view/prompt";
import type { TaskCardModel } from "../task-view";

/**
 * 用**这条消息**的附件指代「这个文件」。
 *
 * 线上问题：用户新拖入一个文件，`focusId` 还停在上一轮的文件上，模型就继续
 * 读旧文件。这里验证两件事：
 * 1. 用户轮次里有显式的「本条消息附带的文件」；
 * 2. 焦点按消息附件重算，新文件排在旧文件前面。
 */
function attachment(
  id: string,
  name: string,
  text: string,
  path: string,
): ExtremeAttachment {
  return {
    id,
    name,
    size: text.length,
    path,
    state: "ready",
    text,
    binary: false,
    uploadState: "uploaded",
  };
}

function scope(attachments: ExtremeAttachment[], focusId: string | null): ActionScope {
  return {
    workspaceId: "ws-a",
    serverId: "srv-a",
    server: "A",
    sessionId: "sess-a",
    requestId: 1,
    home: "/root",
    permission: "readonly",
    preflight: null,
    envChecks: [],
    attachments,
    prefs: { context: "session", output: "auto", picked: [] },
    focusId,
    selectedAttachmentIds: ["att-new"],
    plan: null,
    planSession: null,
    planTaskId: null,
    candidates: null,
  };
}

it("includes historical execution facts only for the session context, before the current request", () => {
  const old = { id: "old", role: "assistant", text: "", parts: [
    { kind: "step", id: "p", taskId: "t", stepIndex: 0 },
  ] } as ExtremeMessage;
  const current: ExtremeMessage = { id: "new", role: "user", text: "现在状态如何？" };
  const task = { workspaceId: "ws-a", serverId: "srv-a", steps: [
    { id: "agent-0", state: "success", command: "docker ps", stdout: "api Up" },
  ] } as TaskCardModel;
  const currentScope = scope([], null);
  const ctx = { locale: "zh-CN", historicalTasks: { t: task } };
  const turns = buildMessages(current, currentScope, [old, current], ctx);
  expect(turns.some((turn) => turn.content.includes("操作记录（成功）：docker ps") && turn.content.includes("api Up"))).toBe(true);
  expect(turns[turns.length - 1]?.content).toBe("现在状态如何？");
  currentScope.prefs.context = "only";
  expect(buildMessages(current, currentScope, [old, current], ctx).some((turn) => turn.content.includes("操作记录（成功）"))).toBe(false);
});

it("preserves conversation text, selections and operation outcomes in chronological order", () => {
  const old = { id: "old", role: "assistant", text: "先检查。\n已经确认。", parts: [
    { kind: "text", id: "p1", text: "先检查。" },
    { kind: "step", id: "p2", taskId: "t", stepIndex: 0 },
    { kind: "text", id: "p3", text: "已经确认。" },
    { kind: "question", id: "p4", taskId: "t", status: "answered", question: {
      questionId: "q", taskId: "t", workspaceId: "ws-a", serverId: "srv-a", question: "选哪个？", kind: "single", options: [{ id: "a", label: "服务 A" }], allowCustom: false, deadline: 1,
    }, answer: { selected: ["a"], custom: "" }, draftSelected: [], draftCustom: "", draftCustomActive: false },
  ] } as ExtremeMessage;
  const current: ExtremeMessage = { id: "new", role: "user", text: "继续" };
  const task = { workspaceId: "ws-a", serverId: "srv-a", steps: [{ id: "agent-0", state: "success", command: "ls", stdout: "x".repeat(500) }] } as TaskCardModel;
  const turns = buildMessages(current, scope([], null), [old, current], { locale: "zh-CN", historicalTasks: { t: task } });
  const history = turns.find((turn) => turn.role === "assistant")?.content ?? "";
  expect(history.indexOf("先检查。")).toBeLessThan(history.indexOf("操作记录"));
  expect(history.indexOf("操作记录")).toBeLessThan(history.indexOf("已经确认。"));
  expect(history).toContain("x".repeat(500));
  expect(history).toContain("用户选择：选哪个？ → 服务 A");
});

it("uses global memory across context modes and excludes legacy scoped records", () => {
  const current: ExtremeMessage = { id: "m", role: "user", text: "检查服务" };
  const memories = [
    { id: "1", scope: "global" as const, serverId: null, workspaceId: null, content: "全局偏好", source: "user", updatedAt: 1 },
    { id: "2", scope: "server" as const, serverId: "srv-a", workspaceId: null, content: "当前服务器服务", source: "user", updatedAt: 2 },
    { id: "3", scope: "server" as const, serverId: "srv-b", workspaceId: null, content: "其他服务器秘密", source: "user", updatedAt: 3 },
    { id: "4", scope: "conversation" as const, serverId: "srv-a", workspaceId: "ws-b", content: "其他对话内容", source: "user", updatedAt: 4 },
    { id: "5", scope: "server" as const, serverId: "srv-a", workspaceId: null, content: "过期主机名", source: "observed:task:1", updatedAt: 1 },
  ];
  const currentScope = scope([], null);
  const turns = buildMessages(current, currentScope, [current], { locale: "zh-CN", memories });
  const text = turns.map((turn) => turn.content).join("\n");
  expect(text).toContain("全局偏好");
  expect(text).not.toContain("当前服务器服务");
  expect(text).not.toContain("其他服务器秘密");
  expect(text).not.toContain("其他对话内容");
  expect(text).not.toContain("过期主机名");
  currentScope.prefs.context = "only";
  expect(buildMessages(current, currentScope, [current], { locale: "zh-CN", memories }).map((turn) => turn.content).join("\n")).toContain("全局偏好");
});

describe("buildMessages：同名新旧包只认本次勾选", () => {
  it("会话里还有旧 dist.zip 时，明确只用本次勾选的新包路径", () => {
    const oldPackage: ExtremeAttachment = {
      id: "att-old",
      name: "dist.zip",
      size: 8.4 * 1024 * 1024,
      path: "dist.zip",
      state: "ready",
      binary: true,
      uploadState: "uploaded",
      staged: true,
      remotePath: "/root/.bls-ops/staging/ws-a/att-old/dist.zip",
      stagedPath: "/root/.bls-ops/staging/ws-a/att-old/dist.zip",
    };
    const newPackage: ExtremeAttachment = {
      ...oldPackage,
      id: "att-new",
      size: 478 * 1024,
      remotePath: "/root/.bls-ops/staging/ws-a/att-new/dist.zip",
      stagedPath: "/root/.bls-ops/staging/ws-a/att-new/dist.zip",
    };
    const message: ExtremeMessage = {
      id: "m-new",
      role: "user",
      text: "更新服务。",
      attachmentIds: ["att-new"],
      attachmentSnapshot: [
        {
          id: "att-new",
          name: "dist.zip",
          size: 478 * 1024,
          remotePath: newPackage.remotePath,
        },
      ],
    };

    const messages = buildMessages(message, scope([oldPackage, newPackage], "att-new"), [message], {
      locale: "zh-CN",
    });
    const system = messages.find((turn) => turn.role === "system")?.content ?? "";

    // 本次勾选区只点名新包（并带确切服务器路径）。
    const chosen = system.slice(system.indexOf("本次发送指定的文件"));
    expect(chosen).toContain("att-new");
    expect(chosen).toContain("478");
    expect(chosen.slice(0, chosen.indexOf("这条消息附带的文件"))).not.toContain("att-old");
  });
});

describe("buildMessages：本条消息的附件", () => {
  it("用户轮次明确指代新附件，焦点不再沿用上一轮", () => {
    const oldFile = attachment(
      "att-old",
      "index.html",
      "<div id=\"root\"></div>",
      "/opt/bls-ops/dist/index.html",
    );
    const newFile = attachment(
      "att-new",
      "pydistutils.cfg",
      "[install]\nprefix=/usr/local",
      "/root/pydistutils.cfg",
    );
    const message: ExtremeMessage = {
      id: "m-new",
      role: "user",
      text: "更改这个文件内容，往里面随便写点单词。",
      attachmentIds: ["att-new"],
    };

    const messages = buildMessages(
      message,
      scope([oldFile, newFile], "att-old"),
      [message],
      { locale: "zh-CN" },
    );

    const user = messages.find((turn) => turn.role === "user" && turn.content.includes(message.text));
    expect(user?.content).toContain("【本条消息附带的文件】");
    expect(user?.content).toContain("pydistutils.cfg");
    expect(user?.content).not.toContain("index.html");

    const system = messages.find((turn) => turn.role === "system")?.content ?? "";
    // 附件正文块里，本条消息的焦点文件排在第一（旧文件不会抢额度）。
    const blocks = system.slice(system.indexOf("用户上传的附件"));
    expect(blocks).toContain("--- pydistutils.cfg");
    expect(blocks).toContain("--- index.html");
    expect(blocks.indexOf("--- pydistutils.cfg")).toBeLessThan(
      blocks.indexOf("--- index.html"),
    );
  });
});
