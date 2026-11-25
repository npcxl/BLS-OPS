import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import type { AgentEvent, AgentSnapshot } from "@/api/types/agent";
import { useExtremeStore } from "@/stores/extreme-store";
import { ExtremeCoreView } from "../extreme-core/ExtremeCoreView";

// 顶部栏要窗口 API；jsdom 里没有 Tauri 运行时。
const win = vi.hoisted(() => ({
  close: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async () => () => {}),
  scaleFactor: vi.fn(async () => 1),
  show: vi.fn(async () => {}),
  unminimize: vi.fn(async () => {}),
  setFocus: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  Channel: class {},
}));

/** 通知桥：这里只关心"推了什么/收起了哪条"。 */
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

/** 事件总线替身：测试自己触发 `app:collapsed` 与通知按钮。 */
const channels = vi.hoisted(() => {
  const handlers = new Map<string, ((event: { payload: unknown }) => void)[]>();
  return {
    add(name: string, handler: (event: { payload: unknown }) => void) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
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
    channels.add(name, handler as never);
    return () => undefined;
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@/components/backgrounds/shape-waves", () => ({ default: () => null }));
vi.mock("@/components/backgrounds/aero-shards", () => ({ default: () => null }));
vi.mock("@/hooks/use-theme", () => ({
  getThemeMode: () => "dark",
  setThemeMode: () => undefined,
  useThemeMode: () => ["dark", () => undefined],
}));
vi.mock("../extreme-core/preflight", () => ({
  runPreflight: () => Promise.reject(new Error("Preflight unavailable in test")),
}));

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    taskId: "task-test",
    status: "running",
    model: "test-model",
    content: "",
    error: null,
    cwd: "/root",
    server: "server",
    sessionId: "approval-notice-test",
    steps: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function emitAgent(event: Partial<AgentEvent> & { taskId: string; kind: string }) {
  await act(async () => {
    channels.emit("agent-event", event);
  });
}

async function flush(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function submit(holder: HTMLElement, text: string) {
  const textarea = holder.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  });
}

const APPROVAL = {
  stepIndex: 0,
  callId: "call-0-0",
  tool: "run_shell",
  command: "systemctl reload nginx",
  summary: "重载 Nginx",
  risk: "write",
  state: "waiting",
  impact: "配置校验通过后重载，已有连接可继续处理。",
  cwd: "/root",
} as const;

it("收起后推通知：在通知里点「拒绝执行」，回到会话看到同一条已拒绝", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot());
  const approve = vi.spyOn(opsApi, "aiAgentApprove").mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-approval-notice";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  bridge.push.mockClear();
  bridge.dismiss.mockClear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "aliyun", sessionId, "203.0.113.80");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "重载 nginx");
    const taskId = run.mock.calls[0][0].taskId;
    await emitAgent({ ...APPROVAL, taskId, kind: "tool_started" });
    await emitAgent({ ...APPROVAL, taskId, kind: "approval_required" });
    await flush();

    // 前台：确认条在，但**不弹通知**。
    expect(holder.querySelector('[data-testid="agent-approval"]')).not.toBeNull();
    expect(bridge.push).not.toHaveBeenCalled();

    // 收起应用 → 补发一次，内容与按钮都对。
    await act(async () => {
      channels.emit("app:collapsed");
    });
    expect(bridge.push).toHaveBeenCalledTimes(1);
    const payload = bridge.push.mock.calls[0][0];
    /*
     * 通知 id 带 **taskId**：`callId` 只在一次运行内唯一（`call-0-0` 会重复），
     * 不带 taskId 的话两条任务的确认会抢同一个通知槽。
     */
    const noticeId = `extreme-approval-${taskId}|call-0-0`;
    expect(payload.id).toBe(noticeId);
    expect(payload.title).toContain("确认重载 Nginx");
    expect(payload.body).toContain("配置校验通过后重载");
    expect(payload.body).toContain("aliyun");
    expect(payload.buttons.map((item: { key: string }) => item.key)).toEqual(["deny", "allow"]);

    // 在通知里点「拒绝执行」：走同一个 approve，不另开一条链路。
    await act(async () => {
      channels.emit("desktop-notification:decide", {
        id: noticeId,
        key: "deny",
      });
    });
    await flush();
    expect(approve).toHaveBeenCalledWith(taskId, "call-0-0", false);

    // 会话里确认条收起；不再追加一条停在“已允许 / 已拒绝”的气泡。
    expect(
      holder.querySelector('[data-testid="agent-approval"]')?.closest("[hidden]"),
    ).not.toBeNull();
    expect(holder.textContent).not.toContain("已拒绝执行");

    // 通知同步更新成结果：同 id、无按钮、几秒后自己收起。
    const calls = bridge.push.mock.calls;
    const resolved = calls[calls.length - 1]?.[0];
    expect(resolved.id).toBe(noticeId);
    expect(resolved.title).toBe("已拒绝 · 此步骤未执行");
    expect(resolved.buttons).toBeUndefined();

    // 后端拒绝后把这步标失败。
    await emitAgent({
      ...APPROVAL,
      taskId,
      kind: "tool_finished",
      state: "failed",
      stderr: "用户拒绝执行这条命令",
    });
    await flush();
    expect(useExtremeStore.getState().tasks[taskId].steps[0].state).toBe("failed");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    approve.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});
