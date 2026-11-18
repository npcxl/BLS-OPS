import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 通知窗口是独立 WebView，这里只验证**主窗口侧**的行为：
 * 什么时候推、推什么、按钮点回来走哪条路。
 */
const bridge = vi.hoisted(() => ({
  push: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@/desktop-notification/bridge", () => ({
  pushDesktopNotification: bridge.push,
  dismissDesktopNotification: bridge.dismiss,
}));

/** 事件总线替身：测试自己触发 `app:collapsed` / 通知按钮。 */
const channels = vi.hoisted(() => {
  const handlers = new Map<string, ((event: { payload: unknown }) => void)[]>();
  return {
    handlers,
    emit(name: string, payload: unknown = {}) {
      for (const handler of handlers.get(name) ?? []) handler({ payload });
    },
    clear() {
      handlers.clear();
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: unknown) => void) => {
    const list = channels.handlers.get(name) ?? [];
    list.push(handler as never);
    channels.handlers.set(name, list);
    return () => undefined;
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: async () => undefined,
    unminimize: async () => undefined,
    setFocus: async () => undefined,
  }),
}));

import {
  hideApprovalNotification,
  installApprovalNotifications,
  syncApprovalNotification,
  type ApprovalNotice,
} from "../approval";

const t = (key: string, options?: Record<string, unknown>) =>
  Object.entries(options ?? {}).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
    key,
  );

const pending: ApprovalNotice = {
  callId: "call-1",
  operation: "重载 Nginx",
  server: "aliyun",
  impact: "配置校验通过后重载，已有连接可继续处理。",
  risk: "write",
  phase: "pending",
};

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

let dispose: () => void;
let decide: (callId: string, allow: boolean) => void;

beforeEach(() => {
  bridge.push.mockClear();
  bridge.dismiss.mockClear();
  channels.clear();
  setHidden(false);
  decide = vi.fn();
  dispose = installApprovalNotifications({ decide, open: vi.fn() }, t);
  syncApprovalNotification(null, t);
});

afterEach(() => {
  dispose();
  setHidden(false);
});

describe("审批通知", () => {
  it("应用在前台时不弹（确认条就在输入框上方）", () => {
    syncApprovalNotification(pending, t);
    expect(bridge.push).not.toHaveBeenCalled();
  });

  it("先有确认条、随后收起应用：补发一次，带两个按钮", () => {
    syncApprovalNotification(pending, t);
    setHidden(true);
    channels.emit("app:collapsed");

    expect(bridge.push).toHaveBeenCalledTimes(1);
    const payload = bridge.push.mock.calls[0][0];
    expect(payload.id).toBe("extreme-approval-call-1");
    expect(payload.title).toContain("确认重载 Nginx");
    expect(payload.body).toContain("配置校验通过后重载");
    expect(payload.body).toContain("aliyun");
    expect(payload.durationMs).toBe(0);
    expect(payload.buttons).toEqual([
      { key: "deny", label: "拒绝执行" },
      { key: "allow", label: "允许本次" },
    ]);
  });

  it("收起状态下出现待确认：立刻推", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    expect(bridge.push).toHaveBeenCalledTimes(1);
  });

  it("通知里点「拒绝执行」：转回主窗口，同一条审批", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    channels.emit("desktop-notification:decide", {
      id: "extreme-approval-call-1",
      key: "deny",
    });
    expect(decide).toHaveBeenCalledWith("call-1", false);
  });

  it("别的通知 id 不会误触当前审批", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    channels.emit("desktop-notification:decide", { id: "extreme-running", key: "allow" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("已拒绝：同一条通知就地更新成结果，按钮消失", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    bridge.push.mockClear();

    syncApprovalNotification({ ...pending, phase: "denied" }, t);
    expect(bridge.push).toHaveBeenCalledTimes(1);
    const payload = bridge.push.mock.calls[0][0];
    expect(payload.title).toBe("已拒绝 · 此步骤未执行");
    expect(payload.buttons).toBeUndefined();
  });

  it("提交失败：保留按钮并说明可以再试", () => {
    setHidden(true);
    syncApprovalNotification({ ...pending, phase: "failed", failure: "连接断开" }, t);
    const payload = bridge.push.mock.calls[0][0];
    expect(payload.title).toBe("确认没有送达");
    expect(payload.body).toContain("连接断开");
    expect(payload.body).toContain("可以再试一次");
    expect(payload.buttons).toHaveLength(2);
  });

  it("审批处理完 / 任务结束：通知自动收起", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    syncApprovalNotification(null, t);
    expect(bridge.dismiss).toHaveBeenCalledWith("extreme-approval-call-1");
  });

  it("回到前台：只关通知，审批本身还在（下次收起还能补发）", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    hideApprovalNotification();
    expect(bridge.dismiss).toHaveBeenCalledTimes(1);

    bridge.push.mockClear();
    setHidden(true);
    channels.emit("app:collapsed");
    expect(bridge.push).toHaveBeenCalledTimes(1);
  });
});
