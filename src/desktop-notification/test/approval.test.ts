import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 通知窗口是独立 WebView，这里只验证**主窗口侧**的行为：
 * 什么时候推、推什么、按钮点回来走哪条路。
 */
const bridge = vi.hoisted(() => ({
  push: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("@/desktop-notification/bridge", () => ({
  pushDesktopNotification: bridge.push,
  dismissDesktopNotification: bridge.dismiss,
  clearExtremeNotifications: bridge.clear,
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
  syncApprovalNotifications,
  type ApprovalNotice,
} from "../approval";

const t = (key: string, options?: Record<string, unknown>) =>
  Object.entries(options ?? {}).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
    key,
  );

const pending: ApprovalNotice = {
  taskId: "task-1",
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
let decide: (taskId: string, callId: string, allow: boolean) => void;

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
    expect(payload.id).toBe("extreme-approval-task-1|call-1");
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
      id: "extreme-approval-task-1|call-1",
      key: "deny",
    });
    expect(decide).toHaveBeenCalledWith("task-1", "call-1", false);
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
    expect(bridge.dismiss).toHaveBeenCalledWith("extreme-approval-task-1|call-1");
  });

  it("回到前台：只关通知，审批本身还在（下次收起还能补发）", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    hideApprovalNotification();
    expect(bridge.dismiss).toHaveBeenCalledTimes(1);

    /*
     * 同一个后台周期内不重复弹（用户刚关掉的那条不该立刻又冒出来）；
     * 真正回到前台、再收起，才是一个新周期，仍然有效的那条再提醒一次。
     */
    bridge.push.mockClear();
    channels.emit("app:collapsed");
    expect(bridge.push).not.toHaveBeenCalled();

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    syncApprovalNotification(pending, t);

    setHidden(true);
    channels.emit("app:collapsed");
    expect(bridge.push).toHaveBeenCalledTimes(1);
  });

  /*
   * A、B 两条对话同时等确认：各自一条通知，处理 A 不影响 B。
   * 以前只有一个全局槽位，后到的审批会覆盖先到的。
   */
  const other: ApprovalNotice = {
    taskId: "task-2",
    callId: "call-9",
    operation: "重启服务",
    server: "backup",
    impact: "会短暂中断连接。",
    risk: "danger",
    phase: "pending",
  };

  it("收起事件与页面可见性同时触发：同一条审批只显示一次", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    bridge.push.mockClear();

    // 同一次收起的两种通知来源（原生 + WebView）。
    channels.emit("app:collapsed");
    document.dispatchEvent(new Event("visibilitychange"));
    channels.emit("app:collapsed");

    expect(bridge.push).not.toHaveBeenCalled();
  });

  it("已允许 / 已拒绝 / 已过期且从未显示：收起时不补发", () => {
    setHidden(true);
    syncApprovalNotifications(
      [
        { ...pending, phase: "allowed", closed: true },
        { ...other, phase: "denied", closed: true },
        { ...other, taskId: "task-3", callId: "call-3", deadline: Date.now() - 1000 },
      ],
      t,
    );
    channels.emit("app:collapsed");
    expect(bridge.push).not.toHaveBeenCalled();
  });

  it("已经显示过的结果只就地更新，不再作为新提醒", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    bridge.push.mockClear();
    bridge.dismiss.mockClear();

    // 用户允许后回到前台：通知更新成结果；再收起不能重新弹。
    syncApprovalNotification({ ...pending, phase: "allowed", closed: true }, t);
    expect(bridge.push).toHaveBeenCalledTimes(1);
    expect(bridge.push.mock.calls[0][0].buttons).toBeUndefined();

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    bridge.push.mockClear();
    setHidden(true);
    channels.emit("app:collapsed");
    expect(bridge.push).not.toHaveBeenCalled();
  });

  it("已处理的通知即使还能收到点击，也不再提交审批", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    syncApprovalNotification({ ...pending, phase: "denied", closed: true }, t);
    channels.emit("desktop-notification:decide", {
      id: "extreme-approval-task-1|call-1",
      key: "allow",
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it("两个任务同时有效：只有真正待确认的进入通知，处理 A 不影响 B", () => {
    setHidden(true);
    syncApprovalNotifications(
      [{ ...pending, closed: true, phase: "allowed" }, other],
      t,
    );
    const ids = bridge.push.mock.calls.map((call) => call[0].id);
    expect(ids).toEqual(["extreme-approval-task-2|call-9"]);
  });

  it("A / B 同时待确认：两条通知都在，处理 A 不动 B", () => {
    setHidden(true);
    syncApprovalNotifications([pending, other], t);
    expect(bridge.push).toHaveBeenCalledTimes(2);
    const ids = bridge.push.mock.calls.map((call) => call[0].id);
    expect(ids).toContain("extreme-approval-task-1|call-1");
    expect(ids).toContain("extreme-approval-task-2|call-9");

    // 处理 A：B 的通知仍在（没有被撤掉，也没有被覆盖）。
    bridge.dismiss.mockClear();
    syncApprovalNotifications([{ ...pending, phase: "denied" }, other], t);
    expect(bridge.dismiss).not.toHaveBeenCalled();
    const byId = new Map(bridge.push.mock.calls.map((call) => [call[0].id, call[0]]));
    expect(byId.get("extreme-approval-task-1|call-1")?.title).toBe("已拒绝 · 此步骤未执行");
    expect(byId.get("extreme-approval-task-2|call-9")?.title).toContain("确认重启服务");
  });

  it("按钮按 id 路由到对应那一条：A 的决定不会落到 B 上", () => {
    setHidden(true);
    syncApprovalNotifications([pending, other], t);

    channels.emit("desktop-notification:decide", {
      id: "extreme-approval-task-1|call-1",
      key: "deny",
    });
    expect(decide).toHaveBeenCalledWith("task-1", "call-1", false);
    expect(decide).not.toHaveBeenCalledWith("task-2", "call-9", expect.anything());

    channels.emit("desktop-notification:decide", {
      id: "extreme-approval-task-2|call-9",
      key: "allow",
    });
    expect(decide).toHaveBeenCalledWith("task-2", "call-9", true);
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("B 处理完撤下时，只收起 B 那一条", () => {
    setHidden(true);
    syncApprovalNotifications([pending, other], t);
    bridge.dismiss.mockClear();
    // A 仍在列表里，B 被撤下。
    syncApprovalNotifications([pending], t);
    expect(bridge.dismiss).toHaveBeenCalledWith("extreme-approval-task-2|call-9");
    expect(bridge.dismiss).toHaveBeenCalledTimes(1);
  });

  /*
   * 多任务并存时点通知必须回到**这条审批所在的对话**：
   * 只带 serverId 会把用户送到当前对话，看起来就是"通知串台"。
   */
  it("通知带归属：点开回到发起这条审批的对话与任务", () => {
    setHidden(true);
    syncApprovalNotification(
      { ...pending, serverId: "srv-1", workspaceId: "ws-9" },
      t,
    );
    const payload = bridge.push.mock.calls[0][0];
    expect(payload.action).toEqual({
      kind: "extreme",
      serverId: "srv-1",
      server: "aliyun",
      taskId: "task-1",
      workspaceId: "ws-9",
    });
  });

  it("没有 serverId 时不猜服务器，只唤回主窗口", () => {
    setHidden(true);
    syncApprovalNotification(pending, t);
    expect(bridge.push.mock.calls[0][0].action).toEqual({ kind: "none" });
  });
});
