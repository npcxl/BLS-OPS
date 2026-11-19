import { describe, expect, it } from "vitest";
import { checkScope, planValidFor, scopeForeground, type ActionScope, type ScopeWorld } from "../action-scope";

/**
 * 归属核对：A 的动作只能落在 A 的对话与 A 那条连接上。
 *
 * 这些分支就是"等探测 / 等终端输出时切到 B"之后必须先跑的那道闸门：
 * 断连、重连、换服务器都会让这一步**暂停**，而不是借用当前前台的连接。
 */

function scope(overrides: Partial<ActionScope> = {}): ActionScope {
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
    attachments: [],
    prefs: { context: "session", output: "auto", picked: [] },
    focusId: null,
    selectedAttachmentIds: [],
    plan: null,
    planSession: null,
    planTaskId: null,
    candidates: null,
    ...overrides,
  };
}

function world(overrides: Partial<ScopeWorld> = {}): ScopeWorld {
  return {
    workspaceId: "ws-b",
    sessionId: "sess-b",
    workspaces: [
      { id: "ws-a", serverId: "srv-a" },
      { id: "ws-b", serverId: "srv-b" },
    ],
    connections: {
      "srv-a": { sessionId: "sess-a" },
      "srv-b": { sessionId: "sess-b" },
    },
    ...overrides,
  };
}

describe("动作归属", () => {
  it("原连接还在：允许继续，即使前台已经切到 B", () => {
    expect(checkScope(scope(), world())).toEqual({ ok: true });
    // 前台是 B：动作能继续跑，但不允许动界面。
    expect(scopeForeground(scope(), world())).toBe(false);
    expect(scopeForeground(scope(), { workspaceId: "ws-a" })).toBe(true);
  });

  it("原连接断开 / 被重连换掉：暂停，不能拿前台连接顶替", () => {
    expect(checkScope(scope(), world({ connections: { "srv-b": { sessionId: "sess-b" } } }))).toEqual({
      ok: false,
      reason: "disconnected",
    });
    expect(
      checkScope(scope(), world({ connections: { "srv-a": { sessionId: "sess-a2" } } })),
    ).toEqual({ ok: false, reason: "reconnected" });
  });

  it("对话被删除 / 重新绑到别的服务器：暂停", () => {
    expect(checkScope(scope(), world({ workspaces: [{ id: "ws-b", serverId: "srv-b" }] }))).toEqual({
      ok: false,
      reason: "workspace-missing",
    });
    expect(
      checkScope(
        scope(),
        world({
          workspaces: [{ id: "ws-a", serverId: "srv-z" }],
          connections: { "srv-z": { sessionId: "sess-z" } },
        }),
      ),
    ).toEqual({ ok: false, reason: "no-server" });
  });

  it("计划必须与发起时是同一条连接", () => {
    const step = { id: "s1", kind: "up" as const, title: "x", detail: "docker compose up -d", state: "pending" as const };
    expect(planValidFor(scope({ plan: [step], planSession: "sess-a" }))).toBe(true);
    expect(planValidFor(scope({ plan: [step], planSession: "sess-old" }))).toBe(false);
    expect(planValidFor(scope({ plan: [], planSession: "sess-a" }))).toBe(false);
  });
});
