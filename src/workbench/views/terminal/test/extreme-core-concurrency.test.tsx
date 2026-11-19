import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import type { AgentEvent, AgentSnapshot } from "@/api/types/agent";
import { useExtremeStore, type ExtremeAttachment } from "@/stores/extreme-store";
import { ExtremeCoreView } from "../extreme-core/ExtremeCoreView";

/**
 * 并发归属的验收用例。
 *
 * 这四条对应"后续动作必须属于发起它的对话 / 完成后发送是真正的队列 /
 * 多条审批并存 / 失败保留已输出的回复"。
 */

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

const bridge = vi.hoisted(() => ({ push: vi.fn(), dismiss: vi.fn(), clear: vi.fn() }));
vi.mock("@/desktop-notification/bridge", () => ({
  pushDesktopNotification: bridge.push,
  dismissDesktopNotification: bridge.dismiss,
  clearExtremeNotifications: bridge.clear,
}));

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
    sessionId: "",
    steps: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

async function emitAgent(event: Partial<AgentEvent> & { taskId: string; kind: string }) {
  await act(async () => {
    channels.emit("agent-event", event);
  });
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

/** 等到 `run` 的第 n 次调用出现（队列派发是异步的）。 */
async function waitForRuns(run: ReturnType<typeof vi.spyOn>, count: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (run.mock.calls.length >= count) return;
    await flush(1);
  }
  throw new Error(`expected ${count} agent runs, got ${run.mock.calls.length}`);
}

/** 点界面上文字为 `label` 的按钮（切换发送方式 / 取消排队）。 */
async function clickButton(holder: HTMLElement, label: string) {
  const button = Array.from(holder.querySelectorAll("button")).find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeTruthy();
  await act(async () => button!.click());
}

function textAttachment(id: string, name: string, text: string): ExtremeAttachment {
  return {
    id,
    name,
    path: name,
    size: text.length,
    state: "ready",
    text,
    uploadState: "local",
  };
}

it("A 等探测时切到服务器 B：A 的上传只用 A 的连接与附件，B 的右栏保持原样", async () => {
  const sessionA = "extreme-scope-a";
  const sessionB = "extreme-scope-b";
  const run = vi
    .spyOn(opsApi, "aiAgentRun")
    .mockResolvedValue(
      snapshot({ content: "先把文件传上去。\n[[upload]]\n[[panel:files:/var/log]]" }),
    );
  vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  // 第一次 sshExec 是右栏探测：测试自己决定什么时候"服务器回话"。
  let releaseProbe: ((value: { stdout: string; stderr: string; exit_code: number }) => void) | null =
    null;
  const ssh = vi.spyOn(opsApi, "sshExec").mockImplementation((session: string) => {
    if (session === sessionA && !releaseProbe) {
      return new Promise((resolve) => {
        releaseProbe = resolve as never;
      }) as never;
    }
    return Promise.resolve({ stdout: "yes", stderr: "", exit_code: 0 }) as never;
  });
  const write = vi.spyOn(opsApi, "sftpWriteFile").mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  bridge.push.mockClear();
  useExtremeStore.getState().enter("srv-scope-a", "A", sessionA, "10.0.0.1");
  const wsA = useExtremeStore.getState().ensureWorkspace()!;
  useExtremeStore.getState().setAttachments(() => [textAttachment("att-a", "a.txt", "A 的材料")]);
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "把文件传上去并打开日志目录");
    await waitForRuns(run, 1);
    // 模型的正文随终态事件回来；这之后才轮到右栏探测（挂起）。
    await emitAgent({
      taskId: run.mock.calls[0][0].taskId,
      kind: "finished",
      content: "先把文件传上去。\n[[upload]]\n[[panel:files:/var/log]]",
    });
    await flush(3);
    expect(ssh).toHaveBeenCalled();
    expect(releaseProbe).toBeTruthy();

    // 探测还没回来就切到另一台服务器 B。
    await act(async () => {
      useExtremeStore.getState().enter("srv-scope-b", "B", sessionB, "10.0.0.2");
    });
    const wsB = useExtremeStore.getState().workspaceId!;
    expect(wsB).not.toBe(wsA);
    const paneBefore = useExtremeStore.getState().paneView;
    expect(paneBefore).toBe("hidden");
    await flush(2);

    // A 的探测现在才回来。
    await act(async () => {
      releaseProbe?.({ stdout: "yes", stderr: "", exit_code: 0 });
    });
    await flush(10);

    // 上传落在 A 的连接上，写的是 A 的附件。
    expect(write).toHaveBeenCalled();
    expect(write.mock.calls.every((call) => call[0] === sessionA)).toBe(true);
    const executed = ssh.mock.calls.map((call) => String(call[0]));
    expect(executed.filter((session) => session === sessionB)).toHaveLength(0);

    const state = useExtremeStore.getState();
    // A 的附件状态写回 A 自己那条对话。
    const aAttachment = state.workspaces
      .find((entry) => entry.id === wsA)
      ?.context?.attachments.find((item) => item.id === "att-a");
    expect(aAttachment?.uploadState).toBe("uploaded");
    // B 没有被塞进 A 的附件。
    expect(state.attachments).toHaveLength(0);

    // B 的右栏保持原样：没有因为 A 的面板动作被打开。
    expect(state.workspaceId).toBe(wsB);
    expect(state.paneView).toBe(paneBefore);
    expect(state.panelTarget).toBeNull();

    // 续跑（把回执交给模型）仍然走 A 的连接。
    expect(run.mock.calls.length).toBeGreaterThan(1);
    expect(run.mock.calls[1][0].sessionId).toBe(sessionA);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    // 队列只放内存：用例之间必须清掉，否则下一条用例会替它派发。
    useExtremeStore.setState({ queuedSends: [] });
    run.mockRestore();
    ssh.mockRestore();
    write.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    bridge.push.mockClear();
    await i18n.changeLanguage(language);
  }
});

it("A 连排两条、B 排一条：三条都在各自对话里按顺序发送，且用入队时的模型与附件", async () => {
  const providers = vi.spyOn(opsApi, "aiProviderList").mockResolvedValue([
    {
      id: "pa",
      name: "A",
      model: "model-a",
      enabled: true,
      is_default: true,
      updated_at: 2,
      context_window: 1024 * 1024,
      context_budgets: [],
      reasoning_efforts: [],
    },
    {
      id: "pb",
      name: "B",
      model: "model-b",
      enabled: true,
      updated_at: 1,
      context_window: 1024 * 1024,
      context_budgets: [],
      reasoning_efforts: [],
    },
  ] as never);
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot({ status: "running" }));
  vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-queue-a", "A", "extreme-queue-a", "10.0.0.11");
  const wsA = useExtremeStore.getState().ensureWorkspace()!;
  useExtremeStore.getState().setProviderId("pa");
  useExtremeStore.getState().setAttachments(() => [textAttachment("att-q", "queued.txt", "入队时的材料")]);
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    // 勾选附件（右栏「附件」里的复选框）：这条排队项要带着它。
    await act(async () => useExtremeStore.getState().openPane("attachments"));
    const checkbox = holder.querySelector<HTMLInputElement>(
      `input[aria-label="${i18n.t("选择 {{name}}", { name: "queued.txt" })}"]`,
    );
    expect(checkbox).toBeTruthy();
    await act(async () => checkbox!.click());
    await flush(1);

    // A1：真正发出去（挂住），后面两条走「完成后发送」。
    await submit(holder, "A 第一条");
    await waitForRuns(run, 1);
    const taskA1 = run.mock.calls[0][0].taskId;
    await clickButton(holder, "完成后发送");
    // 上一条消息已经把勾选消费掉了：排队的那条重新勾一次附件。
    const again = holder.querySelector<HTMLInputElement>(
      `input[aria-label="${i18n.t("选择 {{name}}", { name: "queued.txt" })}"]`,
    );
    expect(again).toBeTruthy();
    await act(async () => again!.click());
    await flush(1);
    await submit(holder, "A 第二条");
    await submit(holder, "A 第三条");
    await flush(2);

    // 排队项只属于 A；切到 B 看不到 A 的队列。
    const queuedA = useExtremeStore.getState().queuedSends.filter((item) => item.workspaceId === wsA);
    expect(queuedA.map((item) => item.text)).toEqual(["A 第二条", "A 第三条"]);
    expect(queuedA[0].selection.providerId).toBe("pa");
    expect(queuedA[0].attachments.map((item) => item.name)).toEqual(["queued.txt"]);

    // 切到 B：B 自己先有一条在跑，再排一条。
    await act(async () => {
      useExtremeStore.getState().addWorkspace([]);
    });
    const wsB = useExtremeStore.getState().workspaceId!;
    useExtremeStore.getState().setProviderId("pb");
    await submit(holder, "B 第一条");
    await waitForRuns(run, 2);
    const taskB1 = run.mock.calls[1][0].taskId;
    await clickButton(holder, "完成后发送");
    await submit(holder, "B 第二条");
    expect(holder.querySelectorAll("[data-queue-id]")).toHaveLength(1);

    // 入队后把附件删掉、模型也换回另一个：已排队的那条仍然是入队时的样子。
    await act(async () => {
      useExtremeStore.getState().setAttachments(() => []);
      useExtremeStore.getState().setProviderId("pa");
    });

    // A1 结束 → A 的队列按顺序出队。
    await emitAgent({ taskId: taskA1, kind: "finished", content: "A1 完成" });
    await waitForRuns(run, 3);
    const a2 = run.mock.calls[2][0];
    expect(a2.messages[a2.messages.length - 1].content).toContain("A 第二条");
    expect(a2.providerId).toBe("pa");
    expect(
      a2.messages.map((message: { content: string }) => message.content).join("\n"),
    ).toContain("queued.txt");

    await emitAgent({ taskId: a2.taskId, kind: "finished", content: "A2 完成" });
    await waitForRuns(run, 4);
    const a3 = run.mock.calls[3][0];
    expect(a3.messages[a3.messages.length - 1].content).toContain("A 第三条");
    expect(a3.providerId).toBe("pa");

    // B 的仍然是 B 的模型（切到 A 之后再改也不影响）。
    await emitAgent({ taskId: taskB1, kind: "finished", content: "B1 完成" });
    await waitForRuns(run, 5);
    const b2 = run.mock.calls[4][0];
    expect(b2.messages[b2.messages.length - 1].content).toContain("B 第二条");
    expect(b2.providerId).toBe("pb");
    expect(b2.taskId).not.toBe(taskB1);

    // 全部出队：三个请求各自落在自己的对话里，没有互相覆盖。
    const remaining = useExtremeStore.getState().queuedSends;
    expect(remaining.filter((item) => item.workspaceId === wsA)).toHaveLength(0);
    expect(remaining.filter((item) => item.workspaceId === wsB)).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    // 队列只放内存：用例之间必须清掉，否则下一条用例会替它派发。
    useExtremeStore.setState({ queuedSends: [] });
    providers.mockRestore();
    run.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("A 与 B 同时待审批：收起后分别处理，拒绝 A 不影响 B，恢复后状态一致", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot({ status: "running" }));
  vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  const approve = vi.spyOn(opsApi, "aiAgentApprove").mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  bridge.push.mockClear();
  useExtremeStore.getState().enter("srv-appr-a", "A", "extreme-appr-a", "10.0.0.21");
  useExtremeStore.getState().ensureWorkspace();
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "A 的重启");
    await waitForRuns(run, 1);
    const taskA = run.mock.calls[0][0].taskId;
    await emitAgent({
      taskId: taskA,
      kind: "approval_required",
      stepIndex: 0,
      callId: "call-a",
      tool: "run_shell",
      command: "systemctl restart a",
      summary: "重启 A",
      risk: "write",
      cwd: "/root",
    });
    await flush(1);

    // 切到 B，也等一条确认。
    await act(async () => {
      useExtremeStore.getState().addWorkspace([]);
    });
    await submit(holder, "B 的重启");
    await waitForRuns(run, 2);
    const taskB = run.mock.calls[1][0].taskId;
    await emitAgent({
      taskId: taskB,
      kind: "approval_required",
      stepIndex: 0,
      callId: "call-b",
      tool: "run_shell",
      command: "systemctl restart b",
      summary: "重启 B",
      risk: "write",
      cwd: "/root",
    });
    await flush(1);

    // 当前是 B：只显示 B 自己的确认条（A 的不抢前台）。
    const cards = () => holder.querySelectorAll('[data-testid="agent-approval"]');
    expect(cards()).toHaveLength(1);
    expect(cards()[0].getAttribute("data-approval-task")).toBe(taskB);

    // 主窗口收起：两条审批各推一条通知。
    await act(async () => {
      channels.emit("app:collapsed");
    });
    const ids = bridge.push.mock.calls.map((call) => call[0].id);
    expect(ids).toContain(`extreme-approval-${taskA}|call-a`);
    expect(ids).toContain(`extreme-approval-${taskB}|call-b`);

    // 在通知里拒绝 A：只处理 A，B 的卡片与通知都还在。
    await act(async () => {
      channels.emit("desktop-notification:decide", {
        id: `extreme-approval-${taskA}|call-a`,
        key: "deny",
      });
    });
    await flush(3);
    expect(approve).toHaveBeenCalledWith(taskA, "call-a", false);
    expect(approve).not.toHaveBeenCalledWith(taskB, "call-b", expect.anything());
    expect(cards()).toHaveLength(1);
    expect(cards()[0].getAttribute("data-approval-task")).toBe(taskB);

    // 再允许 B：两边都处理完，卡片全部收起。
    await act(async () => {
      channels.emit("desktop-notification:decide", {
        id: `extreme-approval-${taskB}|call-b`,
        key: "allow",
      });
    });
    await flush(3);
    expect(approve).toHaveBeenCalledWith(taskB, "call-b", true);
    expect(cards()).toHaveLength(0);

    // 恢复窗口：通知全部撤下，界面状态与处理结果一致（没有残留卡片）。
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(bridge.clear).toHaveBeenCalled();
    expect(holder.querySelectorAll('[data-testid="agent-approval"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    // 队列只放内存：用例之间必须清掉，否则下一条用例会替它派发。
    useExtremeStore.setState({ queuedSends: [] });
    run.mockRestore();
    approve.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    bridge.push.mockClear();
    await i18n.changeLanguage(language);
  }
});

it("流式输出一半后失败：切到 B 再回来，正文、原因与重试入口都在", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot({ status: "running" }));
  vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-partial", "A", "extreme-partial", "10.0.0.31");
  const wsA = useExtremeStore.getState().ensureWorkspace()!;
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "生成一份配置");
    await waitForRuns(run, 1);
    const taskId = run.mock.calls[0][0].taskId;

    await emitAgent({ taskId, kind: "text_delta", content: "前半段已经写好了。" });
    await flush(2);
    expect(holder.textContent).toContain("前半段已经写好了。");

    await emitAgent({ taskId, kind: "failed", message: "连接中断", content: "" });
    await flush(2);

    // 已输出的正文保留，并标出「回复中断 + 原因」。
    const marker = holder.querySelector('[data-testid="extreme-message-interrupted"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain("回复中断");
    expect(marker?.textContent).toContain("连接中断");
    expect(holder.textContent).toContain("前半段已经写好了。");
    expect(
      Array.from(marker!.querySelectorAll("button")).some((button) => button.textContent === "重试"),
    ).toBe(true);

    // 切到 B 再切回 A：仍然能看到同一段正文、同一句原因、同一个重试入口。
    await act(async () => {
      useExtremeStore.getState().addWorkspace([]);
    });
    expect(useExtremeStore.getState().workspaceId).not.toBe(wsA);
    expect(holder.textContent).not.toContain("前半段已经写好了。");
    await act(async () => {
      useExtremeStore.getState().openWorkspace(wsA);
    });
    await flush(1);
    expect(holder.textContent).toContain("前半段已经写好了。");
    const again = holder.querySelector('[data-testid="extreme-message-interrupted"]');
    expect(again).not.toBeNull();
    expect(again?.textContent).toContain("连接中断");
    expect(
      Array.from(again!.querySelectorAll("button")).some((button) => button.textContent === "重试"),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    // 队列只放内存：用例之间必须清掉，否则下一条用例会替它派发。
    useExtremeStore.setState({ queuedSends: [] });
    run.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});
