import { describe, expect, it } from "vitest";
import { createScopeTracker } from "../request-scope";

/**
 * 异步探测（日志来源 / 面板目标）的归属判断。
 *
 * 同一台服务器上的几条对话共用一条 SSH 连接，只看 `sessionId` 分不出是谁发
 * 的；探测回来时用户可能已经切到别的对话。这里把"结果只回到发起它的那条
 * 对话"钉成断言。
 */
describe("请求归属", () => {
  const A = { workspaceId: "ws-a", sessionId: "sess-1" };
  const B = { workspaceId: "ws-b", sessionId: "sess-1" };

  it("还在发起的对话与连接里：结果可用", () => {
    const tracker = createScopeTracker();
    const scope = tracker.begin(A.workspaceId, A.sessionId);
    expect(tracker.accept(scope, A)).toBe(true);
  });

  it("切到同一台服务器的另一条对话：结果不可用（否则会开别人的右栏）", () => {
    const tracker = createScopeTracker();
    const scope = tracker.begin(A.workspaceId, A.sessionId);
    expect(tracker.accept(scope, B)).toBe(false);
  });

  it("重连换了连接：结果不可用", () => {
    const tracker = createScopeTracker();
    const scope = tracker.begin(A.workspaceId, A.sessionId);
    expect(tracker.accept(scope, { workspaceId: A.workspaceId, sessionId: "sess-2" })).toBe(false);
  });

  it("同一条对话又发了一次：只认最后那次", () => {
    const tracker = createScopeTracker();
    const first = tracker.begin(A.workspaceId, A.sessionId);
    const second = tracker.begin(A.workspaceId, A.sessionId);
    expect(tracker.accept(first, A)).toBe(false);
    expect(tracker.accept(second, A)).toBe(true);
  });

  it("切走再切回来：早先那次请求已经过期，不再动界面", () => {
    const tracker = createScopeTracker();
    const scope = tracker.begin(A.workspaceId, A.sessionId);
    // 中间在 B 查了一次日志：最新请求号被 B 顶掉。
    tracker.begin(B.workspaceId, B.sessionId);
    expect(tracker.accept(scope, A)).toBe(false);
  });

  it("latest 记录最近一次请求的归属", () => {
    const tracker = createScopeTracker();
    expect(tracker.latest()).toBeNull();
    const scope = tracker.begin(A.workspaceId, A.sessionId);
    expect(tracker.latest()).toEqual(scope);
  });
});
