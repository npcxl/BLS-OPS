import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import type { AgentEvent, AgentSnapshot, AgentStep } from "@/api/types/agent";
import { useExtremeStore } from "@/stores/extreme-store";
import { useExtremeSettingsStore } from "@/stores/extreme-settings-store";
import { ExtremeCoreView } from "../extreme-core/ExtremeCoreView";

// 超能顶部栏与主窗口共用窗口按钮（最小化 / 最大化 / 关闭），jsdom 里没有 Tauri 运行时。
const win = vi.hoisted(() => ({
  close: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async () => () => {}),
  // 远端文件面板会读缩放比（物理像素 → CSS 像素），jsdom 里没有真实窗口。
  scaleFactor: vi.fn(async () => 1),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
// jsdom 里没有 Tauri 运行时：所有 invoke 都返回空，调用方各自的兜底才有意义。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  Channel: class {},
}));

/**
 * Tauri 事件总线的替身。
 *
 * 页面通过 `listen("agent-event")` 订阅步骤增量、通过 `listen("ai-chat-delta")`
 * 订阅流式正文；jsdom 里没有总线，这里收集回调，测试自己按 `taskId` 触发。
 */
const channels = vi.hoisted(() => {
  const handlers = new Map<string, ((event: { payload: unknown }) => void)[]>();
  return {
    handlers,
    add(name: string, handler: (event: { payload: unknown }) => void) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    emit(name: string, payload: unknown) {
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

// 远端文件面板订阅窗口拖放事件；jsdom 里没有 WebView，给一个空订阅。
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

// WebGL / WebGPU 在 jsdom 里不存在；只验证主题各自挂哪个官方背景。
vi.mock("@/components/backgrounds/galaxy", () => ({
  default: () => <div data-testid="galaxy" />,
}));
vi.mock("@/components/backgrounds/aero-shards", () => ({
  default: () => <div data-testid="aero-shards" />,
}));
vi.mock("@/hooks/use-theme", () => ({
  getThemeMode: () => "dark",
  setThemeMode: () => undefined,
  /** 顶栏的主题选择框（跟随系统 / 浅色 / 深色）也要能渲染。 */
  useThemeMode: () => ["dark", () => undefined],
  useIsDarkTheme: () => true,
}));
vi.mock("../extreme-core/preflight", () => ({
  runPreflight: () => Promise.reject(new Error("Preflight unavailable in test")),
}));
/** 真实终端尾部读取：默认空；模型快照用例里手动挂起，模拟"还在等终端输出"。 */
const manualShell = vi.hoisted(() => ({ tail: vi.fn(async () => "") }));
vi.mock("../extreme-core/manual-shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extreme-core/manual-shell")>();
  return { ...actual, manualShellTail: manualShell.tail };
});

/** 后端快照的测试替身。 */
function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    taskId: "task-test",
    status: "success",
    model: "test-model",
    content: "",
    error: null,
    cwd: "/root",
    server: "server",
    sessionId: "extreme-chat-test",
    steps: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** 触发一次 `agent-event`。 */
async function emitAgent(event: Partial<AgentEvent> & { taskId: string; kind: string }) {
  await act(async () => {
    channels.emit("agent-event", event);
  });
}

/** 把输入框改成待发送文本，并回车提交。 */
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

/**
 * 左栏按任务记开合，新建任务默认收起：要先展开，才能按文字找会话行 / 新建入口。
 */
async function expandRail(holder: HTMLElement) {
  const expand = holder.querySelector<HTMLButtonElement>('[aria-label="展开会话列表"]');
  if (expand) await act(async () => expand.click());
}

/** 让 `waitForAgentRun` 的第一次快照查询与后续渲染跑完。 */
async function flushAgent() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

it("shows structured chat errors and retries the original message once", async () => {
  const run = vi
    .spyOn(opsApi, "aiAgentRun")
    .mockRejectedValueOnce({ stage: "ai", message: "API Key 无效" })
    .mockResolvedValue(snapshot());
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockImplementation(async (taskId) => snapshot({ taskId, content: "你好，我是超能助手。" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-chat-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.42");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "你是谁");
    expect(holder.textContent).toContain("API Key 无效");

    // 任务按钮已全部移除：错误条只提示「回复重试」，重试走同一条聊天路由。
    expect(holder.textContent).toContain("回复「重试」");
    await submit(holder, "你是谁");
    await flushAgent();
    expect(holder.textContent).toContain("你好，我是超能助手。");
    expect(useExtremeStore.getState().tasks[run.mock.calls[1][0].taskId]?.status).toBe("done");

    /*
     * 重试现在是**再发一条消息**（没有按钮），所以对话里会有两条提问；
     * 关键是第二次请求带上了用户的话，并且 taskId 每次独立（取消用它定向）。
     */
    expect(useExtremeStore.getState().messages.filter((message) => message.role === "user")).toHaveLength(2);
    const first = run.mock.calls[0][0].taskId;
    const second = run.mock.calls[1][0].taskId;
    expect(first).not.toBe(second);
    expect(run.mock.calls[1][0].messages.some((message) => message.content.includes("你是谁"))).toBe(true);
    expect(snap).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    vi.unstubAllGlobals();
    await i18n.changeLanguage(language);
  }
});

it("把 agent 事件增量写进同一张任务卡，不串到别的任务", async () => {
  let finish!: (value: AgentSnapshot) => void;
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () => new Promise<AgentSnapshot>((resolve) => {
      finish = resolve;
    }),
  );
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-agent-card-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  // 换一台「主机」：工作区按服务器复用，同一台会把上一个用例的对话带进来。
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.99");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "看看这台机器");
    const taskId = run.mock.calls[0][0].taskId;

    // 只读命令：开始 → 增量输出 → 结束。
    await emitAgent({
      taskId,
      kind: "tool_started",
      stepIndex: 0,
      callId: "call-0-0",
      tool: "run_shell",
      command: "uname -a",
      risk: "read",
      state: "running",
      cwd: "/root",
    });
    await emitAgent({ taskId, kind: "tool_output", stepIndex: 0, stdout: "Linux web-01 6.8\n" });
    await emitAgent({
      taskId,
      kind: "tool_finished",
      stepIndex: 0,
      state: "success",
      exitCode: 0,
      stdout: "Linux web-01 6.8\n",
      cwd: "/srv/app",
    });

    const card = useExtremeStore.getState().tasks[taskId];
    expect(card.steps).toHaveLength(1);
    expect(card.steps[0].state).toBe("success");
    expect(card.steps[0].stdout).toContain("Linux web-01");
    expect(card.cwd).toBe("/srv/app");

    // 命令紧跟正文、默认收起：一行操作名 + 状态，点开才看命令与输出。
    const expand = holder.querySelector<HTMLButtonElement>("[data-step-part] button[aria-expanded]");
    expect(expand).toBeTruthy();
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => expand!.click());
    expect(expand?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => expand!.click());
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    expect(holder.textContent).toContain("uname -a");
    // 输出在步骤的折叠内容里（ThoughtChain 默认收起），store 里已有完整值。
    expect(card.steps[0].stdout).toContain("Linux web-01");

    /*
     * 归属不明的事件（既没有卡、也没有任何消息引用这个 taskId）**不建卡**：
     * 以前会凭空多出一张卡挂在当前对话里，正是串服务器的根源。
     */
    await emitAgent({
      taskId: "task-other",
      kind: "tool_started",
      stepIndex: 0,
      tool: "run_shell",
      command: "rm -rf /tmp/x",
      risk: "write",
      state: "running",
      cwd: "/root",
    });
    expect(useExtremeStore.getState().tasks[taskId].steps).toHaveLength(1);
    expect(useExtremeStore.getState().tasks["task-other"]).toBeUndefined();

    // 收尾：让等待中的请求结束，避免留下轮询定时器。
    await emitAgent({
      taskId,
      kind: "finished",
      content: "机器正常。",
      model: "test-model",
      cwd: "/srv/app",
    });
    await act(async () => finish(snapshot({ taskId, content: "机器正常。", cwd: "/srv/app" })));
    await flushAgent();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it.skip("AI 提问：卡片内联显示，提交后原地变成已回答", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () => new Promise<AgentSnapshot>(() => undefined),
  );
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  const answer = vi.spyOn(opsApi, "aiAgentAnswer").mockResolvedValue(true);
  const mcp = vi.spyOn(opsApi, "mcpServerList").mockResolvedValue([]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-question-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.88");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "去查一下");
    // MCP 勾选按归属异步读取；等任务卡落库后再送结构化事件。
    await flushAgent();
    const taskId = run.mock.calls[0][0].taskId;
    for (let i = 0; i < 20 && !useExtremeStore.getState().tasks[taskId]; i += 1) {
      await flushAgent();
    }
    expect(useExtremeStore.getState().tasks[taskId]).toBeTruthy();
    // 等任务卡真正上屏：问题事件要挂在已渲染的回复下面。
    for (let i = 0; i < 20 && !holder.textContent?.includes("已用时间"); i += 1) {
      await flushAgent();
    }
    const question = {
      questionId: "q-1",
      taskId,
      workspaceId: useExtremeStore.getState().workspaceId!,
      serverId: null,
      question: "查哪个环境？",
      kind: "single" as const,
      options: [
        { id: "prod", label: "生产" },
        { id: "test", label: "测试" },
      ],
      allowCustom: true,
      deadline: Date.now() + 60_000,
    };
    await emitAgent({ taskId, kind: "question_required", question });
    await flushAgent();
    expect(holder.textContent).toContain("查哪个环境？");
    expect(holder.textContent).toContain("生产");

    await act(async () =>
      holder
        .querySelector<HTMLButtonElement>('[data-testid="question-option-prod"]')!
        .click(),
    );
    await act(async () =>
      holder
        .querySelector<HTMLButtonElement>('[data-testid="question-submit"]')!
        .click(),
    );
    expect(answer).toHaveBeenCalledWith(taskId, "q-1", ["prod"], null);
    await emitAgent({
      taskId,
      kind: "question_answered",
      question,
      answer: { selected: ["prod"] },
    });
    expect(holder.textContent).toContain("已回答");
    expect(holder.textContent).toContain("生产");

    await emitAgent({ taskId, kind: "cancelled", message: "已停止" });
    await flushAgent();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    answer.mockRestore();
    mcp.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("写操作先挂起：确认前不发命令，点「允许执行」才回后端", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () => new Promise<AgentSnapshot>(() => undefined),
  );
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  const approve = vi.spyOn(opsApi, "aiAgentApprove").mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-approval-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.77");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "重启 nginx");
    const taskId = run.mock.calls[0][0].taskId;

    const approval = {
      taskId,
      kind: "approval_required",
      stepIndex: 0,
      callId: "call-0-0",
      tool: "run_shell",
      command: "systemctl restart nginx",
      script: "if ! cd /root; then exit 98; fi\nsystemctl restart nginx\n__bls_rc=$?",
      summary: "重启服务 nginx",
      risk: "write",
      state: "waiting",
      impact: "停止系统服务，访问会短暂中断",
      cwd: "/root",
    } as const;
    await emitAgent({ ...approval, kind: "tool_started" });
    await emitAgent({ ...approval });

    // 首屏：操作 · 服务器 + 一行真实影响；命令要展开「查看命令与影响」才出现。
    expect(holder.textContent).toContain("重启服务 nginx");
    expect(holder.textContent).toContain("停止系统服务，访问会短暂中断");
    expect(holder.textContent).not.toContain("systemctl restart nginx");
    expect(approve).not.toHaveBeenCalled();

    const details = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("查看命令与影响"),
    );
    expect(details).toBeTruthy();
    await act(async () => details!.click());
    expect(holder.textContent).toContain("systemctl restart nginx");
    // cd 包装与内部标记在「实际执行脚本」里，默认收起。
    const debug = holder.querySelector<HTMLDetailsElement>('[data-testid="agent-approval"] details');
    expect(debug).toBeTruthy();
    expect(debug!.open).toBe(false);

    const allow = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("允许本次"),
    );
    expect(allow).toBeTruthy();
    await act(async () => allow!.click());
    expect(approve).toHaveBeenCalledWith(taskId, "call-0-0", true);
    // 确认送达后**确认条原地消失**：先显示「已批准」，真实执行事件到了才是「运行中」。
    expect(holder.querySelector('[data-testid="agent-approval"]')).toBeNull();
    expect(holder.textContent).toContain("已批准");
    await emitAgent({ ...approval, kind: "tool_started", state: "running" });
    expect(holder.textContent).toContain("运行中");
    expect(holder.textContent).not.toContain("已允许执行：重启服务 nginx · 正在执行");

    await emitAgent({ taskId, kind: "cancelled", message: "已停止" });
    await flushAgent();
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

it("执行中补一句交给正在跑的任务，不再被挡回", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () => new Promise<AgentSnapshot>(() => undefined),
  );
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  const steer = vi.spyOn(opsApi, "aiAgentSteer").mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-steer-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.90");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "查一下 nginx");
    const taskId = run.mock.calls[0][0].taskId;

    // 默认是队列；这条用例显式切到「补充给当前任务」。
    const mode = holder.querySelector<HTMLButtonElement>(
      'button[aria-label="执行中发送方式"]',
    );
    expect(mode).toBeTruthy();
    await act(async () => mode!.click());
    const steerItem = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("补充给当前任务"),
    );
    expect(steerItem).toBeTruthy();
    await act(async () => steerItem!.click());

    // 同一句话在任务执行中再发一次：作为补充要求送进同一个 taskId。
    await submit(holder, "只看容器里的");
    expect(steer).toHaveBeenCalledWith(taskId, "只看容器里的");
    expect(holder.textContent).toContain("已更新当前任务：下一步开始前生效。");
    // 补充要求也要上屏，不能只进后端。
    expect(holder.textContent).toContain("只看容器里的");

    // 收尾：后端确认终态，避免测试结束时还有运行中的卡片。
    await emitAgent({ taskId, kind: "cancelled", message: "已停止" });
    await flushAgent();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    steer.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("message timeline: one tick per user turn, hover preview, click jumps inside the chat", async () => {
  const store = useExtremeStore;
  const sessionId = "extreme-timeline-test";
  store.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.91");
  store.getState().ensureWorkspace();
  const messages = [
    { id: "u1", role: "user" as const, text: "第一问：查服务" },
    { id: "a1", role: "assistant" as const, text: "第一答：nginx 在跑。" },
    { id: "u2", role: "user" as const, text: "第二问：看磁盘" },
    { id: "a2", role: "assistant" as const, text: "第二答：磁盘还有 40%。" },
    { id: "u3", role: "user" as const, text: "第三问：看内存" },
    { id: "a3", role: "assistant" as const, text: "第三答：内存占用 62%。" },
  ];
  store.setState({ messages, draft: "" });

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const scrollTo = vi.fn();
  const originalScrollTo = HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.scrollTo = scrollTo as never;
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    const ticks = Array.from(holder.querySelectorAll<HTMLButtonElement>('button[aria-label^="跳到第"]'));
    expect(ticks).toHaveLength(3);
    expect(ticks.map((tick) => tick.getAttribute("aria-label"))).toEqual([
      "跳到第 1 轮：第一问：查服务",
      "跳到第 2 轮：第二问：看磁盘",
      "跳到第 3 轮：第三问：看内存",
    ]);

    // 键盘聚焦立即出预览：问题 + 本轮回复摘要。
    await act(async () => ticks[2].focus());
    const preview = document.body.textContent ?? "";
    expect(preview).toContain("第三问：看内存");
    expect(preview).toContain("第三答：内存占用 62%。");

    // 点击只滚聊天容器（第三条 = 最后一轮，滚到底并恢复跟随）。
    await act(async () => ticks[2].click());
    expect(scrollTo).toHaveBeenCalled();
    expect(ticks[2].getAttribute("aria-current")).toBe("true");

    // 跳到历史轮次同样在聊天容器里滚，并把高亮切过去。
    await act(async () => ticks[0].click());
    expect(ticks[0].getAttribute("aria-current")).toBe("true");
    expect(ticks[2].getAttribute("aria-current")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    if (originalScrollTo) HTMLElement.prototype.scrollTo = originalScrollTo;
    else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    store.getState().exit();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("shows the latest request context and the task totals in the usage popover", async () => {
  let finish!: (value: AgentSnapshot) => void;
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () =>
      new Promise<AgentSnapshot>((resolve) => {
        finish = resolve;
      }),
  );
  const usage = {
    budget: 32768,
    used: 12500,
    report: { beforeTokens: 16000, afterTokens: 12500, slimmed: 2, folded: 1, droppedUnits: 1 },
    cumulative: { requests: 3, inputTokens: 40000, outputTokens: 1800 },
    breakdown: { system: 1500, history: 9000, tools: 2000 },
    goal: "查一下当前跑了哪些服务",
    toolCalls: 4,
  };
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(null);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-usage-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.90");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    expect(holder.querySelector('button[aria-label="上下文用量"]')).toBeTruthy();
    await submit(holder, "查一下当前跑了哪些服务");
    const taskId = run.mock.calls[0][0].taskId;
    await emitAgent({ taskId, kind: "context_usage", context: usage });
    await flushAgent();

    const trigger = holder.querySelector<HTMLButtonElement>('button[aria-label="上下文用量"]');
    expect(trigger).toBeTruthy();
    await act(async () => trigger!.click());

    // 菜单走 portal，挂在 document.body 上。
    const text = document.body.textContent ?? "";
    /*
     * 口径是**任务对话**（裁剪前 16000），不是"这一轮发了多少"（12500）：
     * 16000 / 32768 ≈ 48.8%。
     */
    expect(text).toContain("任务对话 16,000 / 32,768 token");
    expect(text).toContain("已占 48.8%");
    expect(text).toContain("本轮实际发送 12,500");
    expect(text).toContain("本任务累计");
    expect(text).toContain("查一下当前跑了哪些服务");
    expect(text).toContain("L1 瘦身 2 条");
    expect(text).toContain("3 次请求");
    expect(text).toContain("输入 39K");

    await act(async () => finish(snapshot({ taskId, status: "success", content: "ok" })));
    const finalUsage = { ...usage, cumulative: { ...usage.cumulative, requests: 4 } };
    await emitAgent({ taskId, kind: "finished", content: "ok", model: "test-model", context: finalUsage });
    await flushAgent();
    // 结束后仍保留最终用量。
    expect(useExtremeStore.getState().taskUsage[taskId]).toEqual(finalUsage);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("批准后不追加停在「正在执行」的气泡，结论直接写入当前回复", async () => {
  let finish!: (value: AgentSnapshot) => void;
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () =>
      new Promise<AgentSnapshot>((resolve) => {
        finish = resolve;
      }),
  );
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  const approve = vi.spyOn(opsApi, "aiAgentApprove").mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-approval-order";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.88");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "重启 nginx");
    const taskId = run.mock.calls[0][0].taskId;
    const approval = {
      taskId,
      stepIndex: 0,
      callId: "call-0-0",
      tool: "run_shell",
      command: "systemctl restart nginx",
      summary: "重启服务 nginx",
      risk: "write",
      state: "waiting",
      impact: "停止系统服务",
      cwd: "/root",
    } as const;
    await emitAgent({ ...approval, kind: "tool_started" });
    await emitAgent({ ...approval, kind: "approval_required" });

    const allow = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("允许本次"),
    );
    expect(allow).toBeTruthy();
    await act(async () => allow!.click());
    await flushAgent();

    // 不再额外生成一条「已允许执行 · 正在执行」气泡。
    expect(
      useExtremeStore
        .getState()
        .messages.some((message) => message.text.includes("已允许执行")),
    ).toBe(false);

    // 后端开始执行（步骤转 running），正文直接写入当前回复。
    await emitAgent({ ...approval, kind: "tool_started", state: "running" });
    await emitAgent({ taskId, kind: "text_delta", content: "服务已重启。" });
    await flushAgent();

    const after = useExtremeStore.getState().messages;
    const conclusionAt = after.findIndex((message) => message.text.includes("服务已重启"));
    expect(conclusionAt).toBeGreaterThan(-1);
    expect(after[conclusionAt].text).toContain("服务已重启");

    await act(async () => finish(snapshot({ taskId, status: "success", content: "服务已重启。" })));
    await emitAgent({ taskId, kind: "finished", content: "服务已重启。", model: "test-model" });
    await flushAgent();
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

it("拒绝执行：原地显示已拒绝，计划里的那一步同步标记，记录折成一行", async () => {
  // `aiAgentRun` 只负责"启动"：结束由 `finished` 事件驱动（否则流程卡在启动上）。
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  const approve = vi.spyOn(opsApi, "aiAgentApprove").mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-approval-deny-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.79");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "给 nginx 加一段访问日志");
    const taskId = run.mock.calls[0][0].taskId;

    const approval = {
      taskId,
      stepIndex: 0,
      callId: "call-0-0",
      tool: "write_file",
      path: "/etc/nginx/conf.d/ops-access.log.conf",
      command: "写入 /etc/nginx/conf.d/ops-access.log.conf",
      summary: "更新 Nginx 配置 ops-access.log.conf",
      risk: "danger",
      state: "waiting",
      impact: "新增 OPS 访问日志配置，校验通过后重载 Nginx",
      cwd: "/root",
    } as const;
    await emitAgent({ ...approval, kind: "tool_started" });
    await emitAgent({ ...approval, kind: "approval_required" });

    const deny = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("拒绝执行"),
    );
    expect(deny).toBeTruthy();
    await act(async () => deny!.click());
    await flushAgent();

    expect(approve).toHaveBeenCalledWith(taskId, "call-0-0", false);
    // 拒绝送达后确认条原地消失，这一步标成「未执行」。
    expect(holder.querySelector('[data-testid="agent-approval"]')).toBeNull();
    expect(holder.textContent).toContain("未执行");
    expect(holder.textContent).not.toContain("已拒绝执行：更新 Nginx 配置 ops-access.log.conf · 此步骤未执行");

    // 后端把这步标成失败（拒绝 → fail_step），计划里同步。
    await emitAgent({
      ...approval,
      kind: "tool_finished",
      state: "failed",
      stderr: "用户拒绝执行这条命令",
    });
    const card = useExtremeStore.getState().tasks[taskId];
    expect(card.steps.find((step) => step.id === "agent-0")?.state).toBe("failed");

    // 这一轮结束：确认条折成一行记录（不再挂在输入框上方）。
    await emitAgent({ taskId, kind: "finished", content: "那我改成只检查配置。", model: "test-model" });
    await flushAgent();
    expect(holder.textContent).not.toContain("已拒绝执行：更新 Nginx 配置 ops-access.log.conf · 此步骤未执行");
    expect(
      holder.querySelector('[data-testid="agent-approval"]'),
    ).toBeNull();

    // 接着说话：用户气泡只有他自己打的字。
    await submit(holder, "改为只检查配置");
    await flushAgent();
    const userTexts = useExtremeStore
      .getState()
      .messages.filter((message) => message.role === "user")
      .map((message) => message.text);
    expect(userTexts).toEqual(["给 nginx 加一段访问日志", "改为只检查配置"]);

    await emitAgent({ taskId, kind: "cancelled", message: "已停止" });
    await flushAgent();
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

it("待确认时可以直接回「按你说的改 / 会影响什么 / 先别动」，由原任务处理", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () => new Promise<AgentSnapshot>(() => undefined),
  );
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot({ status: "running" }));
  const approve = vi.spyOn(opsApi, "aiAgentApprove").mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-approval-reply-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.78");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "给 nginx 加一段访问日志");
    const taskId = run.mock.calls[0][0].taskId;

    const approval = {
      taskId,
      kind: "approval_required",
      stepIndex: 0,
      callId: "call-0-0",
      tool: "write_file",
      path: "/etc/nginx/conf.d/ops-access.log.conf",
      command: "写入 /etc/nginx/conf.d/ops-access.log.conf",
      summary: "更新 Nginx 配置 ops-access.log.conf",
      risk: "danger",
      state: "waiting",
      impact: "新增 OPS 访问日志配置，校验通过后重载 Nginx",
      backupPath: "/etc/nginx/conf.d/ops-access.log.conf.bls-bak.1",
      rollback:
        "cp -a '/etc/nginx/conf.d/ops-access.log.conf.bls-bak.1' '/etc/nginx/conf.d/ops-access.log.conf'",
      cwd: "/root",
    } as const;
    await emitAgent({ ...approval, kind: "tool_started" });
    await emitAgent({ ...approval });

    // 首屏就两行：摘要 · 服务器、具体影响。
    expect(holder.textContent).toContain("更新 Nginx 配置 ops-access.log.conf");
    expect(holder.textContent).toContain("新增 OPS 访问日志配置，校验通过后重载 Nginx");

    // 「会影响什么」：用卡片上的事实回答，不表态、也不新起一次运行。
    const runs = run.mock.calls.length;
    await submit(holder, "会影响什么");
    // 拦截回答是在 ask() 里 push 的本地消息：等它落到界面再断言。
    await flushAgent();
    expect(holder.textContent).toContain("影响：新增 OPS 访问日志配置");
    expect(approve).not.toHaveBeenCalled();
    expect(run.mock.calls.length).toBe(runs);
    // 这一步仍然挂着：卡片还在，等用户真正表态。
    expect(holder.querySelector('[data-testid="agent-approval"]')).not.toBeNull();

    // 「按你说的改」：交给原来那条任务（agent_approve），不新起对话。
    await submit(holder, "按你说的改");
    expect(approve).toHaveBeenCalledWith(taskId, "call-0-0", true);

    await emitAgent({ taskId, kind: "cancelled", message: "已停止" });
    await flushAgent();
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

/** 快照里的一步（只写关心的字段，其余给默认值）。 */
function agentStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    index: 0,
    callId: "call-0-0",
    tool: "run_shell",
    path: null,
    risk: "read",
    state: "success",
    command: "uname -a",
    stdout: "",
    stderr: "",
    exitCode: 0,
    cwd: "/srv/app",
    truncated: false,
    backupPath: null,
    rollback: null,
    impact: null,
    elapsedMs: 12,
    ...overrides,
  };
}

it("重进时接回运行中的任务：进度、待确认都能恢复", async () => {
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(
    snapshot({
      taskId: "task-live",
      status: "running",
      sessionId: "extreme-reattach-live",
      cwd: "/srv/app",
      steps: [
        agentStep({ stdout: "Linux web-01 6.8\n" }),
        agentStep({
          index: 1,
          callId: "call-0-1",
          risk: "write",
          state: "waiting",
          command: "systemctl restart nginx",
          summary: "重启服务 nginx",
          impact: "停止系统服务",
          exitCode: null,
        }),
      ],
      pendingApproval: {
        callId: "call-0-1",
        stepIndex: 1,
        tool: "run_shell",
        risk: "write",
        command: "systemctl restart nginx",
        script: "if ! cd /srv/app; then exit 98; fi\nsystemctl restart nginx\n__bls_rc=$?",
        summary: "重启服务 nginx",
        impact: "停止系统服务",
        cwd: "/srv/app",
      },
    }),
  );
  const approve = vi.spyOn(opsApi, "aiAgentApprove").mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-reattach-live";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.62");
  // 进入是欢迎态（懒创建）：先落一条对话，再模拟"上次留下的消息"。
  useExtremeStore.getState().ensureWorkspace();
  const store = useExtremeStore.getState();
  store.pushMessage({ id: "m-user", role: "user", text: "重启 nginx", taskId: "task-live" });
  store.pushMessage({ id: "m-reply", role: "assistant", text: "" });
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await flushAgent();

    const card = useExtremeStore.getState().tasks["task-live"];
    expect(card).toBeTruthy();
    expect(card.steps).toHaveLength(2);
    // 有一部在等确认：卡片必须是"等你确认"，不能显示成还在跑。
    expect(card.status).toBe("confirming");
    // 首屏只有「摘要 · 服务器 + 影响」，命令进详情。
    expect(holder.textContent).toContain("重启服务 nginx");
    expect(holder.textContent).toContain("停止系统服务");
    expect(holder.textContent).not.toContain("systemctl restart nginx");

    const allow = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("允许本次"),
    );
    expect(allow).toBeTruthy();
    await act(async () => allow!.click());
    expect(approve).toHaveBeenCalledWith("task-live", "call-0-1", true);

    await emitAgent({ taskId: "task-live", kind: "cancelled", message: "已停止" });
    await flushAgent();
    // 收尾后气泡有结论，不再停在"正在回答…"。
    expect(holder.textContent).toContain("已停止");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    snap.mockRestore();
    approve.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("重进时发现任务已结束：补上结论与卡片", async () => {
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(
    snapshot({
      taskId: "task-done",
      status: "success",
      sessionId: "extreme-reattach-done",
      model: "test-model",
      content: "机器正常，nginx 在跑。",
      cwd: "/srv/app",
      steps: [agentStep({ stdout: "Linux web-01 6.8\n" })],
    }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-reattach-done";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.63");
  useExtremeStore.getState().ensureWorkspace();
  const store = useExtremeStore.getState();
  store.pushMessage({ id: "m-user", role: "user", text: "看看这台机器", taskId: "task-done" });
  store.pushMessage({ id: "m-reply", role: "assistant", text: "" });
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await flushAgent();

    const card = useExtremeStore.getState().tasks["task-done"];
    expect(card.status).toBe("done");
    expect(card.steps).toHaveLength(1);
    // 重进后恢复结论和已完成的工具记录。
    expect(holder.textContent).toContain("机器正常，nginx 在跑。");
    expect(holder.querySelector("[data-agent-activity]")?.textContent).toContain("处理过程");
    // 计数说的是"执行了几个操作"，不再暴露"工具调用"这类内部说法。
    expect(holder.querySelector("[data-agent-activity]")?.textContent).toContain("1 个操作");
    expect(holder.textContent).not.toContain("工具调用 ·");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    snap.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("新建任务直接建空白任务进欢迎态，不弹窗", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-new-task";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.71");
  // 先有一条消息，才不是"本来就在欢迎态"。
  useExtremeStore.getState().ensureWorkspace();
  useExtremeStore.getState().pushMessage({ id: "m-1", role: "user", text: "看看这台机器" });
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    const before = useExtremeStore.getState().workspaceId;
    expect(holder.textContent).not.toContain("选择本机文件夹（可选）");

    await expandRail(holder);
    const create = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("新建任务"),
    );
    expect(create).toBeTruthy();
    await act(async () => create!.click());

    const after = useExtremeStore.getState();
    // 新任务当场分配 id、对话清空、进入欢迎态。
    expect(after.workspaceId).not.toBe(before);
    expect(after.messages).toHaveLength(0);
    // 不能有弹窗，文件夹选择只是欢迎页里的可选项。
    expect(holder.querySelector(".ant-modal")).toBeNull();
    expect(holder.textContent).toContain("选择本机文件夹（可选）");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("重试：这句话自己上屏、清空输入框，并用原问题重跑", async () => {
  let finishSecond!: (value: AgentSnapshot) => void;
  const run = vi
    .spyOn(opsApi, "aiAgentRun")
    .mockRejectedValueOnce({ stage: "ai", message: "模型超时" })
    .mockImplementationOnce(
      () =>
        new Promise<AgentSnapshot>((resolve) => {
          finishSecond = resolve;
        }),
    );
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockResolvedValue(snapshot({ status: "running" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-retry-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.81");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "看看这台机器");
    await flushAgent();
    expect(
      useExtremeStore.getState().messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(holder.textContent).toContain("模型超时");

    await submit(holder, "重试");
    await flushAgent();

    const users = useExtremeStore.getState().messages.filter((message) => message.role === "user");
    // 「重试」自己上屏；原提问不再重复出现一条。
    expect(users).toHaveLength(2);
    expect(users[1].text).toBe("重试");
    // 输入框清空。
    expect(holder.querySelector("textarea")!.value).toBe("");
    // 第二次确实发起了，而且发的是**原问题**、目标还是这台会话。
    expect(run).toHaveBeenCalledTimes(2);
    const second = run.mock.calls[1][0];
    const sent = second.messages;
    expect(sent[sent.length - 1]).toMatchObject({ role: "user", content: "看看这台机器" });
    expect(second.sessionId).toBe(sessionId);
    expect(second.server).toBe("server");
    // 重试卡挂在「重试」这条消息上，并写明在重试哪一步。
    const retryTaskId = users[1].taskId;
    expect(retryTaskId).toBeTruthy();
    const retrying = useExtremeStore.getState().tasks[retryTaskId!];
    expect(retrying?.status).toBe("running");
    expect(retrying?.result).toContain("正在重试");

    // 收尾：让第二次运行正常结束，复位 in-flight 标记。
    const taskId = second.taskId;
    await act(async () =>
      finishSecond(snapshot({ taskId, status: "success", content: "好了" })),
    );
    await emitAgent({ taskId, kind: "finished", content: "好了", model: "test-model" });
    await flushAgent();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("执行中重复提交「重试」：只起一次，并说明任务仍在执行", async () => {
  let finishRetry!: (value: AgentSnapshot) => void;
  const run = vi
    .spyOn(opsApi, "aiAgentRun")
    // 先失败一次，让「重试」有明确目标。
    .mockRejectedValueOnce({ stage: "ai", message: "模型超时" })
    .mockImplementationOnce(
      () =>
        new Promise<AgentSnapshot>((resolve) => {
          finishRetry = resolve;
        }),
    );
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockResolvedValue(snapshot({ status: "running" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-retry-busy";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.82");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "看看这台机器");
    await flushAgent();
    expect(run).toHaveBeenCalledTimes(1);

    const textarea = holder.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "重试",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    /*
     * 同一 tick 连按两次回车：第一次受理，第二次必须被挡掉
     * （`asking` 的 state 还没更新，靠同步的 in-flight 标记兜住）。
     */
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAgent();

    // 失败那次 + 一次重试 = 2；重复提交没有起第三次。
    expect(run).toHaveBeenCalledTimes(2);
    // 「重试」只出现一条气泡（被挡下的那次不重复上屏）。
    const retryBubbles = useExtremeStore.getState().messages.filter(
      (message) => message.role === "user" && message.text === "重试",
    );
    expect(retryBubbles).toHaveLength(1);
    // 明确说明"仍在执行"，而不是静默吞掉。
    expect(holder.textContent).toContain("任务仍在执行");

    // 收尾。
    const taskId = run.mock.calls[1][0].taskId;
    await act(async () => finishRetry(snapshot({ taskId, status: "success", content: "完成" })));
    await emitAgent({ taskId, kind: "finished", content: "完成", model: "test-model" });
    await flushAgent();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("A 执行中切到 B：B 是空白对话，A 的事件不会画到 B", async () => {
  let finishA!: (value: AgentSnapshot) => void;
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () =>
      new Promise<AgentSnapshot>((resolve) => {
        finishA = resolve;
      }),
  );
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockResolvedValue(snapshot({ status: "running" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore
    .getState()
    .enter("srv-a", "生产", "extreme-switch-a", "root@10.0.0.1:22");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "看看 A");
    const taskA = run.mock.calls[0][0].taskId;
    const workspaceA = useExtremeStore.getState().workspaceId!;

    // 切到另一台服务器：应当是一条**空白**对话，看不到 A 的内容。
    await act(async () => {
      useExtremeStore.getState().enter("srv-b", "测试", "extreme-switch-b", "root@10.0.0.2:22");
    });
    expect(useExtremeStore.getState().messages).toHaveLength(0);
    // 左栏会列出所有服务器的对话（这是要的），所以只看**对话区**。
    const thread = () => holder.querySelector(".extreme-core-main")!;
    expect(thread().textContent).not.toContain("看看 A");
    expect(useExtremeStore.getState().workspaceId).not.toBe(workspaceA);

    // A 的任务继续在后台推进：事件只能落到 A。
    await emitAgent({
      taskId: taskA,
      kind: "tool_started",
      stepIndex: 0,
      tool: "run_shell",
      command: "uname -a",
      risk: "read",
      state: "running",
      cwd: "/root",
    });
    await emitAgent({
      taskId: taskA,
      kind: "tool_finished",
      stepIndex: 0,
      state: "success",
      stdout: "Linux web-a 6.8\n",
      exitCode: 0,
      cwd: "/srv",
    });
    await emitAgent({
      taskId: taskA,
      kind: "finished",
      content: "A 完成了",
      model: "test-model",
      cwd: "/srv",
    });

    // B 的对话区里不能出现 A 的任何东西。
    expect(thread().textContent).not.toContain("uname -a");
    expect(thread().textContent).not.toContain("A 完成了");
    const entryA = useExtremeStore.getState().workspaces.find((entry) => entry.id === workspaceA)!;
    expect(entryA.messages.some((message) => message.text === "A 完成了")).toBe(true);
    expect(useExtremeStore.getState().tasks[taskA].workspaceId).toBe(workspaceA);

    // 切回 A：对话、结论、任务卡都回来了。
    await act(async () => {
      useExtremeStore.getState().openWorkspace(workspaceA);
    });
    expect(useExtremeStore.getState().workspaceId).toBe(workspaceA);
    expect(thread().textContent).toContain("看看 A");
    expect(thread().textContent).toContain("A 完成了");
    expect(useExtremeStore.getState().tasks[taskA].workspaceId).toBe(workspaceA);

    await act(async () =>
      finishA(snapshot({ taskId: taskA, status: "success", content: "A 完成了" })),
    );
    await flushAgent();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("重试只重跑当前对话的失败任务，不会去重跑另一台服务器的", async () => {
  let finish!: (value: AgentSnapshot) => void;
  const run = vi
    .spyOn(opsApi, "aiAgentRun")
    // A 与 B 各失败一次，第三次（重试）挂起以便断言。
    .mockRejectedValueOnce({ stage: "ai", message: "模型超时" })
    .mockRejectedValueOnce({ stage: "ai", message: "模型超时" })
    .mockImplementationOnce(
      () =>
        new Promise<AgentSnapshot>((resolve) => {
          finish = resolve;
        }),
    );
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockResolvedValue(snapshot({ status: "running" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-a", "生产", "retry-scope-a", "root@10.0.0.1:22");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "A 的问题");
    await flushAgent();

    // 切到另一台，也失败一次。
    await act(async () => {
      useExtremeStore.getState().enter("srv-b", "测试", "retry-scope-b", "root@10.0.0.2:22");
    });
    await submit(holder, "B 的问题");
    await flushAgent();
    expect(run).toHaveBeenCalledTimes(2);

    await submit(holder, "重试");
    await flushAgent();

    // 第三次请求发的是 **B 的问题**，不是 A 的。
    expect(run).toHaveBeenCalledTimes(3);
    const third = run.mock.calls[2][0];
    const sent = third.messages;
    expect(sent[sent.length - 1]).toMatchObject({ role: "user", content: "B 的问题" });
    expect(third.sessionId).toBe("retry-scope-b");

    const taskId = third.taskId;
    await act(async () => finish(snapshot({ taskId, status: "success", content: "完成" })));
    await emitAgent({ taskId, kind: "finished", content: "完成", model: "test-model" });
    await flushAgent();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("审批时问「会影响什么」：先回答，不代替用户确认", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () => new Promise<AgentSnapshot>(() => undefined),
  );
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockResolvedValue(snapshot({ status: "running" }));
  const approve = vi.spyOn(opsApi, "aiAgentApprove").mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-ask", "生产", "extreme-ask", "root@10.0.0.9:22");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "重启 nginx");
    const taskId = run.mock.calls[0][0].taskId;
    const approvalEvent = {
      taskId,
      stepIndex: 0,
      callId: "call-0-0",
      tool: "run_shell",
      command: "systemctl restart nginx",
      risk: "write",
      state: "waiting",
      impact: "停止系统服务",
      cwd: "/root",
    } as const;
    await emitAgent({ ...approvalEvent, kind: "tool_started" });
    await emitAgent({ ...approvalEvent, kind: "approval_required" });

    await submit(holder, "会影响什么");
    await flushAgent();

    // 用卡片上的事实回答；确认条还在，也没替用户点允许。
    expect(holder.textContent).toContain("停止系统服务");
    expect(holder.textContent).toContain("等待你的确认");
    expect(approve).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);

    await emitAgent({ taskId, kind: "cancelled", message: "已停止" });
    await flushAgent();
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

it("审批请求发送失败：确认条保留，用户还能再处理", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () => new Promise<AgentSnapshot>(() => undefined),
  );
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockResolvedValue(snapshot({ status: "running" }));
  const approve = vi
    .spyOn(opsApi, "aiAgentApprove")
    .mockRejectedValue({ stage: "io", message: "连接断开" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-approve-fail", "生产", "extreme-af", "root@10.0.0.10:22");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "重启 nginx");
    const taskId = run.mock.calls[0][0].taskId;
    const approvalEvent = {
      taskId,
      stepIndex: 0,
      callId: "call-0-0",
      tool: "run_shell",
      command: "systemctl restart nginx",
      risk: "write",
      state: "waiting",
      cwd: "/root",
    } as const;
    await emitAgent({ ...approvalEvent, kind: "tool_started" });
    await emitAgent({ ...approvalEvent, kind: "approval_required" });

    const allow = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("允许本次"),
    );
    await act(async () => allow!.click());
    await flushAgent();

    // 送达失败：确认条**还在**、按钮还能再点，原因写在条上。
    expect(approve).toHaveBeenCalledTimes(1);
    expect(holder.textContent).toContain("没有送达服务器");
    expect(holder.textContent).toContain("可以再试一次");
    expect(holder.querySelector('[data-testid="agent-approval"]')?.getAttribute("data-phase")).toBe(
      "failed",
    );
    const retryAllow = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("允许本次"),
    );
    expect(retryAllow).toBeTruthy();

    await emitAgent({ taskId, kind: "cancelled", message: "已停止" });
    await flushAgent();
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

it("停止是两阶段：先「正在停止」，后端确认后才「已停止」；停止中发消息不动执行", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () => new Promise<AgentSnapshot>(() => undefined),
  );
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockResolvedValue(snapshot({ status: "running" }));
  const cancel = vi
    .spyOn(opsApi, "aiChatCancel")
    .mockRejectedValueOnce(new Error("IPC unavailable"))
    .mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-stop", "生产", "extreme-stop", "root@10.0.0.11:22");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "看看这台机器");
    const taskId = run.mock.calls[0][0].taskId;
    await emitAgent({
      taskId,
      kind: "tool_started",
      stepIndex: 0,
      tool: "run_shell",
      command: "uname -a",
      risk: "read",
      state: "running",
      cwd: "/root",
    });

    /*
     * 全页只有 Prompt Bar 右下角一个停止键（发送键的执行态）。
     * 状态行不再摆按钮 —— 那里只说明进度。
     */
    expect(
      Array.from(holder.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "停止",
      ),
    ).toHaveLength(0);
    const stop = () =>
      holder
        .querySelector<HTMLButtonElement>('button[aria-label="停止"], button[aria-label="Stop"]')!
        .click();
    await act(async () => stop());
    expect(holder.textContent).toContain("停止请求未能确认");
    expect(holder.textContent).not.toContain("正在停止…");
    await act(async () => stop());
    await flushAgent();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledWith(taskId);
    expect(holder.textContent).toContain("正在停止…");
    expect(holder.textContent).not.toContain("已停止");

    // 停止过程中继续输入：消息不受理、草稿留着、不重复启动。
    const textarea = holder.querySelector("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!
      .set!;
    await act(async () => {
      setValue.call(textarea, "再补一句");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAgent();
    expect(textarea.value).toBe("再补一句");
    expect(run).toHaveBeenCalledTimes(1);
    expect(holder.textContent).toContain("停止完成后这条消息才能发送");

    // 后端确认终态：这时才显示"已停止"。
    await emitAgent({ taskId, kind: "cancelled", message: "已停止" });
    await flushAgent();
    expect(holder.textContent).toContain("已停止");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    cancel.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("部署计划执行中：停止入口同样只有 Prompt Bar 一个，状态行只说进度", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-plan-stop", "生产", "extreme-plan-stop", "root@10.0.0.31:22");
  const workspaceId = useExtremeStore.getState().ensureWorkspace()!;
  useExtremeStore.getState().pushMessage({ id: "m-plan", role: "user", text: "部署一下" });
  // 计划在跑：这是本地循环，没有任务卡，只有 `executing`。
  useExtremeStore.getState().setExecutingFor(workspaceId, true);
  try {
    await act(async () => root.render(<ExtremeCoreView />));

    // 状态行说进度，不放按钮。
    expect(holder.textContent).toContain("正在执行部署计划");
    expect(
      Array.from(holder.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "停止",
      ),
    ).toHaveLength(0);

    // 整个页面只有 Prompt Bar 那一个停止键。
    const stops = holder.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="停止"], button[aria-label="Stop"]',
    );
    expect(stops).toHaveLength(1);
    await act(async () => stops[0].click());
    // 点了之后：状态行改为"正在停止"，按钮不再重复提交（连点无害）。
    expect(holder.textContent).toContain("正在停止");
    await act(async () => stops[0].click());
    expect(holder.textContent).toContain("当前步骤结束后不会再继续");
  } finally {
    useExtremeStore.getState().setExecutingFor(workspaceId, false);
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("已有草稿时编辑旧消息：不覆盖草稿，并说明原因", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-edit", "生产", "extreme-edit", "root@10.0.0.12:22");
  const store = useExtremeStore.getState();
  store.pushMessage({ id: "m-old", role: "user", text: "旧的问题" });
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    const textarea = holder.querySelector("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!
      .set!;
    await act(async () => {
      setValue.call(textarea, "写到一半的草稿");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // 消息操作条：自己的气泡下有「复制 / 编辑」两个图标按钮。
    const edit = holder.querySelector<HTMLButtonElement>(
      '[data-role="user"] button[aria-label="编辑"]',
    );
    expect(edit).toBeTruthy();
    await act(async () => edit!.click());

    // 草稿没被 "旧的问题" 顶掉，并且说清了为什么。
    expect(textarea.value).toBe("写到一半的草稿");
    expect(holder.textContent).toContain("还有未发送的草稿");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("右栏按标签页工作：固定入口开标签，收起再开复原，换会话记住各自的标签", async () => {
  /*
   * 窗口尺寸一律不许改：以前打开右栏会把外框往右扩一段，用户看到的是
   * "窗口自己变宽"，收起再开还会和实际宽度对不上。现在宽度在窗口内自适应。
   */
  const widen = vi
    .spyOn(opsApi, "extremePanelWiden")
    .mockResolvedValue({ widened: false, added: 0, reason: "内部按分栏显示" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-panel", "生产", "extreme-panel", "root@10.0.0.20:22");
  const firstWorkspace = useExtremeStore.getState().ensureWorkspace()!;
  // 这个用例验证“从固定入口打开”：先确保右栏是收起的初始状态。
  useExtremeStore.getState().setPaneView("hidden");
  useExtremeStore.getState().pushMessage({ id: "m-1", role: "user", text: "看看日志" });
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    const open = () => holder.querySelector<HTMLButtonElement>('button[aria-label="远程工作区"]')!;
    expect(open()).toBeTruthy();
    await act(async () => open().click());
    expect(widen).not.toHaveBeenCalled();

    // 浏览器式标签：打开时只显示当前对话已有/按需打开的标签。
    const tab = (label: string) =>
      Array.from(holder.querySelectorAll<HTMLElement>('[role="tab"]')).find(
        (node) => node.textContent?.trim() === label,
      );
    expect(tab("远程文件"), "远程文件").toBeTruthy();
    expect(tab("远程文件")!.getAttribute("aria-selected")).toBe("true");

    // 快捷入口在顶栏（服务器名右侧、展开左边），标签行整行留给标签。
    const shortcut = holder.querySelector<HTMLButtonElement>(
      '[data-pane-view] .extreme-core-pane-toolbar button[aria-label="服务器终端"]',
    );
    expect(shortcut).toBeTruthy();
    expect(
      holder.querySelector('.extreme-core-pane-tabs button[aria-label="服务器终端"]'),
    ).toBeNull();
    await act(async () => shortcut!.click());
    expect(widen).not.toHaveBeenCalled();
    expect(tab("终端")!.getAttribute("aria-selected")).toBe("true");
    expect(tab("远程文件")).toBeTruthy();
    // 「终端」内部的两段（子标签不带业务状态，标题固定）。
    for (const label of ["执行输出", "真实终端"]) {
      expect(tab(label), label).toBeTruthy();
    }
    await act(async () => tab("执行输出")!.click());
    expect(tab("执行输出")!.getAttribute("aria-selected")).toBe("true");

    const closeTerminal = tab("终端")!.querySelector<HTMLButtonElement>('button[aria-label="关闭标签"]')!;
    await act(async () => closeTerminal.click());
    expect(tab("终端")).toBeUndefined();
    await act(async () => shortcut!.click());
    expect(tab("终端")!.getAttribute("aria-selected")).toBe("true");

    // 收起 → 再打开：回到「终端 › 执行输出」，窗口尺寸始终不动。
    const close = holder.querySelector<HTMLButtonElement>('[data-pane-view] button[aria-label="收起右栏"]')!;
    await act(async () => close.click());
    expect(widen).not.toHaveBeenCalled();
    await act(async () => open().click());
    expect(widen).not.toHaveBeenCalled();
    expect(tab("终端")!.getAttribute("aria-selected")).toBe("true");
    expect(tab("执行输出")!.getAttribute("aria-selected")).toBe("true");

    /*
     * 展开是**全屏**：从左侧任务栏右缘铺到窗口右缘，不再是带 16px 空隙的浮窗。
     */
    const expand = holder.querySelector<HTMLButtonElement>(
      '[data-pane-view] button[aria-label="展开视图"]',
    )!;
    await act(async () => expand.click());
    const expanded = holder.querySelector<HTMLElement>('[data-pane-view="expanded"]')!;
    expect(expanded.className).toContain("extreme-core-pane-expanded");
    expect(expanded.className).not.toContain("rounded-xl");
    expect(holder.querySelector(".extreme-core-row")).toBeTruthy();
    const restore = Array.from(holder.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("退出全屏"),
    )!;
    await act(async () => restore.click());
    expect(holder.querySelector('[data-pane-view="expanded"]')).toBeNull();

    // 换一条会话：新任务默认收起右栏，不继承上一条的展开状态。
    await act(async () => {
      useExtremeStore.getState().addWorkspace([]);
    });
    await act(async () => root.render(<ExtremeCoreView />));
    expect(holder.querySelector("[data-pane-view]")).toBeNull();

    // 切回第一条：恢复「终端」。
    await act(async () => {
      useExtremeStore.getState().openWorkspace(firstWorkspace);
    });
    await act(async () => root.render(<ExtremeCoreView />));
    expect(tab("终端")!.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      useExtremeStore.getState().pushMessage({
        id: "panel-website",
        role: "assistant",
        text: "查看 http://example.org/ops",
      });
    });
    const link = holder.querySelector<HTMLAnchorElement>('a[href="http://example.org/ops"]');
    expect(link).toBeTruthy();
    await act(async () => link!.click());
    expect(tab("浏览器")!.getAttribute("aria-selected")).toBe("true");
    expect(useExtremeStore.getState().browserByWorkspace[firstWorkspace]).toBe("http://example.org/ops");

    /*
     * 显式外拖：窗口目标宽度变大，新增宽度全部给右栏；聊天容器本身的宽度
     * 在 jsdom 里没有布局，只能断言“窗口请求 + 右栏变宽”这条契约。
     */
    const resize = vi
      .spyOn(opsApi, "extremePanelResize")
      .mockResolvedValue({ widened: true, added: 80, reason: null });
    const outer = holder.querySelector<HTMLElement>('[aria-label="向外拖宽右栏"]')!;
    expect(outer).toBeTruthy();
    const before = useExtremeStore.getState().paneWidth;
    const pointer = (type: string, clientX: number) =>
      new MouseEvent(type, { bubbles: true, clientX, button: 0 });
    await act(async () => {
      outer.dispatchEvent(pointer("pointerdown", 600));
      window.dispatchEvent(pointer("pointermove", 680));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 680));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(resize).toHaveBeenCalled();
    // 绝对目标宽度：基准窗口 + 拖动位移（80），不是每帧叠加。
    expect(resize.mock.calls[0][0]).toBeGreaterThan(window.innerWidth);
    expect(useExtremeStore.getState().paneWidth).toBeGreaterThan(before);
    resize.mockRestore();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    widen.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("左侧会话右键可重命名（Enter 保存）并删除；删完回到欢迎态", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-menu", "aliyun", "extreme-menu", "root@10.0.0.40:22");
  const id = useExtremeStore.getState().ensureWorkspace()!;
  useExtremeStore
    .getState()
    .pushMessage({ id: "m-1", role: "user", text: "看看这台机器" });
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    // 新任务默认收起左栏：展开后才按文字找得到这一行。
    await expandRail(holder);
    const item = () =>
      Array.from(holder.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("看看这台机器"),
      )!;
    expect(item()).toBeTruthy();

    // 右键 → 菜单（portal 到 body）。
    await act(async () => {
      item().dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 120 }),
      );
    });
    const renameItem = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "重命名",
    );
    expect(renameItem).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "删除对话",
      ),
    ).toBe(true);

    // 重命名：输入框预填当前标题，Enter 保存后列表立即更新。
    await act(async () => renameItem!.click());
    const input = holder.querySelector<HTMLInputElement>('input[aria-label="对话名称"]');
    expect(input?.value).toBe("看看这台机器");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input!, "巡检 aliyun");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(holder.textContent).toContain("巡检 aliyun");
    expect(
      useExtremeStore.getState().workspaces.find((entry) => entry.id === id)?.title,
    ).toBe("巡检 aliyun");

    // Esc 取消：改到一半按 Esc 不保存。
    await act(async () => {
      Array.from(holder.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("巡检 aliyun"))!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 120 }));
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "重命名")!
        .click();
    });
    const again = holder.querySelector<HTMLInputElement>('input[aria-label="对话名称"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(again, "不要保存");
      again.dispatchEvent(new Event("input", { bubbles: true }));
      again.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(
      useExtremeStore.getState().workspaces.find((entry) => entry.id === id)?.title,
    ).toBe("巡检 aliyun");
    expect(holder.textContent).not.toContain("不要保存");

    // 删除：弹窗写明标题与服务器，取消时保留会话。
    const renamed = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("巡检 aliyun"),
    )!;
    const openDeleteDialog = async () => {
      await act(async () => {
        renamed.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 120 }),
        );
      });
      const deleteItem = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "删除对话",
      )!;
      await act(async () => deleteItem.click());
      return document.querySelector('[role="dialog"][aria-modal="true"]')!;
    };

    const dialog = await openDeleteDialog();
    expect(dialog.textContent).toContain("删除「巡检 aliyun」？（aliyun）");
    const cancel = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "取消",
    )!;
    await act(async () => cancel.click());
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(useExtremeStore.getState().workspaces.some((entry) => entry.id === id)).toBe(true);

    const reopened = await openDeleteDialog();
    const confirmDelete = Array.from(reopened.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "删除",
    )!;
    await act(async () => confirmDelete.click());
    // 只删掉了这一条；同一台服务器没有别的对话 → 回到欢迎态。
    expect(useExtremeStore.getState().workspaces.some((entry) => entry.id === id)).toBe(false);
    expect(useExtremeStore.getState().workspaceId).toBeNull();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("保留模型加载前的输入焦点，并在返回同一对话时恢复光标", async () => {
  type Providers = Awaited<ReturnType<typeof opsApi.aiProviderList>>;
  let resolveProviders!: (providers: Providers) => void;
  const providerList = vi.spyOn(opsApi, "aiProviderList").mockImplementation(
    () => new Promise((resolve) => { resolveProviders = resolve; }),
  );
  const memories = vi.spyOn(opsApi, "extremeMemoryList").mockResolvedValue([]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  useExtremeStore.getState().enter("srv-focus", "测试", "extreme-focus", "root@127.0.0.1:22");
  useExtremeStore.getState().ensureWorkspace();
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    const composer = holder.querySelector("[data-extreme-composer]")!;
    const input = composer.querySelector("textarea")!;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "保留草稿");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.setSelectionRange(2, 2);
      resolveProviders([{ id: "p1", name: "Test", model: "test-model", enabled: true, is_default: true }] as Providers);
    });
    expect(composer.querySelector("textarea")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(composer.textContent).toContain("test-model");

    const memory = holder.querySelector<HTMLButtonElement>('[data-testid="rail-memory"]')!;
    const back = () => holder.querySelector<HTMLButtonElement>('button[aria-label="返回对话"]')!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => memory.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    await act(async () => memory.click());
    // jsdom does not move focus automatically when the chat becomes hidden.
    back().focus();
    await act(async () => back().click());
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("保留草稿");
    expect(input.selectionStart).toBe(2);

    memory.focus();
    await act(async () => memory.click());
    await act(async () => back().click());
    expect(document.activeElement).toBe(memory);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    providerList.mockRestore();
    memories.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("输入区是官方 Prompt Bar：模型 / 思考强度 / 上下文都在组件里选，并按模型记住", async () => {
  const providers = vi.spyOn(opsApi, "aiProviderList").mockResolvedValue([
    {
      id: "p1",
      name: "DeepSeek",
      model: "deepseek-chat",
      enabled: true,
      is_default: true,
      updated_at: 1,
      context_window: 1024 * 1024,
      context_budgets: [300 * 1024, 600 * 1024, 1024 * 1024],
      reasoning_efforts: ["low", "high", "max"],
    },
    {
      id: "p2",
      name: "备份",
      model: "qwen-max",
      enabled: true,
      context_window: 0,
      reasoning_efforts: [],
    },
    {
      id: "p3",
      name: "停用的",
      model: "old",
      enabled: false,
      context_window: 0,
      reasoning_efforts: [],
    },
  ] as never);
  let finish!: (value: AgentSnapshot) => void;
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () =>
      new Promise<AgentSnapshot>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  localStorage.removeItem("bls-ops.extreme-model-settings.v1");
  useExtremeStore.setState({ modelSettings: {} });
  useExtremeStore.getState().enter("srv-prefs", "生产", "extreme-prefs", "root@10.0.0.31:22");
  useExtremeStore.getState().ensureWorkspace();
  try {
    await act(async () => root.render(<ExtremeCoreView />));

    // 旧底栏的下拉 / 模型入口全部移除；输入区就是 Prompt Bar。
    expect(holder.querySelector('select[aria-label="上下文范围"]')).toBeNull();
    expect(holder.querySelector('select[aria-label="输出形态"]')).toBeNull();
    expect(holder.querySelector('select[aria-label="模型"]')).toBeNull();
    const composer = holder.querySelector("[data-extreme-composer]")!;
    const textarea = composer.querySelector("textarea")!;
    expect(textarea.getAttribute("aria-label")).toBe("提示词");
    const sendButton = () =>
      composer.querySelector<HTMLButtonElement>('button[aria-label="发送"], button[aria-label="停止"]')!;
    expect(sendButton().getAttribute("aria-label")).toBe("发送");
    expect(composer.querySelector('button[aria-label="添加文件与引用来源"]')).toBeTruthy();
    expect(composer.querySelector('button[aria-label="权限"]')).toBeTruthy();
    expect(composer.querySelector('button[aria-label="选择思考强度"]')).toBeTruthy();

    // 模型：组件自带的选择器，只列启用的配置。
    const modelButton = () => composer.querySelector<HTMLButtonElement>('button[aria-label="选择模型"]')!;
    expect(modelButton().textContent).toContain("deepseek-chat");
    await act(async () => modelButton().click());
    const options = () => Array.from(composer.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(options().some((option) => option.textContent?.includes("deepseek-chat"))).toBe(true);
    expect(options().some((option) => option.textContent?.includes("qwen-max"))).toBe(true);
    expect(composer.textContent).not.toContain("old");

    // 换到 qwen-max：外部 store 立刻同步，强度 / 预算按这个模型重新算。
    await act(async () => options().find((option) => option.textContent?.includes("qwen-max"))!.click());
    expect(useExtremeStore.getState().chatPrefs.providerId).toBe("p2");
    expect(modelButton().textContent).toContain("qwen-max");

    // 没有声明思考强度的模型：弹层说明原因，不再显示一根动不了的滑杆。
    const qwenEffortButton = composer.querySelector<HTMLButtonElement>('button[aria-label="选择思考强度"]')!;
    await act(async () => qwenEffortButton.click());
    expect(
      composer.querySelector('[role="dialog"][aria-label="思考强度"]')?.textContent,
    ).toContain("没有可调的思考强度");
    expect(composer.querySelector('[role="slider"]')).toBeNull();
    await act(async () => qwenEffortButton.click());

    // 发一条：请求锁定 p2；qwen-max 不支持思考强度，发 null。
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(textarea, "看看这台机器");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => sendButton().click());
    expect(run).toHaveBeenCalledTimes(1);
    const first = run.mock.calls[0][0];
    expect(first.providerId).toBe("p2");
    expect(first.reasoningEffort).toBeNull();
    // 发送后组件切到「停止」。
    expect(sendButton().getAttribute("aria-label")).toBe("停止");

    await act(async () => finish(snapshot({ taskId: first.taskId, status: "success", content: "好了" })));
    await emitAgent({ taskId: first.taskId, kind: "finished", content: "好了", model: "test-model" });
    await flushAgent();

    // 切回 DeepSeek：自己带 300K / 600K / 1M 档位。
    await act(async () => modelButton().click());
    await act(async () =>
      options().find((option) => option.textContent?.includes("deepseek-chat"))!.click(),
    );
    expect(useExtremeStore.getState().chatPrefs.providerId).toBe("p1");

    // 「上下文」范围与档位各是一个统一 Select（与 Prompt Bar 同一套面板）。
    const budgetButton = composer.querySelector<HTMLButtonElement>('button[aria-label="上下文长度"]')!;
    await act(async () => budgetButton.click());
    const budgetMenu = document.querySelector<HTMLElement>('[role="listbox"][aria-label="上下文长度"]')!;
    const budgetOption = (label: string) =>
      Array.from(budgetMenu.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((node) =>
        node.textContent?.includes(label),
      )!;
    await act(async () => budgetOption("600K").click());
    const workspaceNow = useExtremeStore.getState().workspaceId!;
    expect(
      useExtremeStore.getState().modelSettingsByWorkspace[workspaceNow]?.["p:p1"],
    ).toMatchObject({ budget: 600 * 1024 });

    // 思考强度：组件里的滑杆选到最高档（MAX），发送时按模型记住。
    const effortButton = composer.querySelector<HTMLButtonElement>('button[aria-label="选择思考强度"]')!;
    await act(async () => effortButton.click());
    const slider = composer.querySelector<HTMLElement>('[role="slider"]')!;
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(effortButton.textContent).toContain("MAX");
    expect(
      useExtremeStore.getState().modelSettingsByWorkspace[workspaceNow]?.["p:p1"]?.effort,
    ).toBe("max");

    await act(async () => {
      setValue.call(textarea, "再看一次");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => sendButton().click());
    const second = run.mock.calls[1][0];
    expect(second.providerId).toBe("p1");
    expect(second.reasoningEffort).toBe("max");
    expect(second.contextBudget).toBe(600 * 1024);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    useExtremeStore.setState({ modelSettings: {} });
    localStorage.removeItem("bls-ops.extreme-model-settings.v1");
    providers.mockRestore();
    run.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("发送即锁定模型：A 等终端输出时切到 B，A 的请求仍用 A 的模型", async () => {
  const providers = vi.spyOn(opsApi, "aiProviderList").mockResolvedValue([
    {
      id: "pa",
      name: "A",
      model: "model-a",
      enabled: true,
      is_default: true,
      updated_at: 2,
      context_window: 1024 * 1024,
      context_budgets: [300 * 1024, 600 * 1024],
      reasoning_efforts: ["low", "high"],
    },
    {
      id: "pb",
      name: "B",
      model: "model-b",
      enabled: true,
      context_window: 1024 * 1024,
      reasoning_efforts: [],
    },
  ] as never);
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.setState({ modelSettings: {} });
  useExtremeSettingsStore.getState().update({ replyLanguage: "en" });
  useExtremeStore.getState().enter("srv-select", "生产", "extreme-select", "root@10.0.0.41:22");
  useExtremeStore.getState().ensureWorkspace();
  useExtremeStore.getState().setProviderId("pa");
  // 普通档（不是最高档）：这一轮保持原流程，不开启强制计划。
  useExtremeStore.getState().setModelSetting("p:pa", { effort: "low", budget: 600 * 1024 });

  let release!: (value: string) => void;
  const tail = new Promise<string>((resolve) => {
    release = resolve;
  });
  manualShell.tail.mockReturnValueOnce(tail);

  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // A 发送：请求会卡在“读取终端输出”上。
    await submit(holder, "A 的问题");
    expect(run).not.toHaveBeenCalled();

    // 等 A 的终端输出时切到 B，并给 B 选另一个模型。
    await act(async () => {
      useExtremeStore.getState().addWorkspace([]);
    });
    await act(async () => {
      useExtremeStore.getState().setProviderId("pb");
    });
    await act(async () => {
      release("");
      await tail;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(run).toHaveBeenCalledTimes(1);
    const request = run.mock.calls[0][0];
    expect(request.providerId).toBe("pa");
    expect(request.reasoningEffort).toBe("low");
    expect(request.planRequired).toBe(false);
    expect(request.contextBudget).toBe(600 * 1024);
    // 回复语言是独立偏好：设置为英文时请求带 en，而不是只跟界面语言。
    expect(request.replyLanguage).toBe("en");
    // 测试环境默认开放"连接即用"的内置技能；外部 MCP 未连接时不带工具。
    expect(request.enabledBuiltins).toEqual(
      expect.arrayContaining(["inspect", "logs", "files"]),
    );
    expect(request.enabledMcpTools).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    useExtremeStore.setState({ modelSettings: {} });
    useExtremeSettingsStore.getState().reset();
    manualShell.tail.mockReset();
    manualShell.tail.mockImplementation(async () => "");
    providers.mockRestore();
    run.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("计划页展开执行器给的步骤与证据，点一步跳到终端", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-plan", "生产", "extreme-plan", "root@10.0.0.40:22");
  const workspaceId = useExtremeStore.getState().ensureWorkspace()!;
  useExtremeStore.getState().pushMessage({
    id: "m-plan",
    role: "user",
    text: "更新 OPS 前端并检查证书",
    taskId: "task-plan",
  });
  useExtremeStore.getState().upsertTask({
    id: "task-plan",
    kind: "deploy",
    title: "更新 OPS",
    goal: "更新 OPS 前端并检查证书",
    workspaceId,
    serverId: "srv-plan",
    server: "生产",
    sessionId: "extreme-plan",
    status: "running",
    result: "",
    createdAt: 1,
    updatedAt: 2,
    steps: [
      { id: "s1", title: "定位服务", command: "systemctl status ops", state: "done", stdout: "active (running)" },
      { id: "s2", title: "备份旧版本", command: "cp -r /opt/app /opt/app.bak", state: "running" },
      { id: "s3", title: "发布", command: "rsync -a dist/ /opt/app/", state: "pending" },
    ],
    artifacts: [],
  } as never);
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    /*
     * 直接置为「分栏 + 计划」：这条用例只关心计划页渲染，
     * 不依赖上一个用例留下的右栏开合状态。
     */
    await act(async () => {
      useExtremeStore.getState().setPaneView("split");
      useExtremeStore.getState().setPaneTab("plan");
    });
    await act(async () => root.render(<ExtremeCoreView />));
    // 标签上带步骤计数，用 includes 匹配（textContent 会是「计划3」）。
    const planTab = Array.from(holder.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (node) => node.textContent?.includes("计划"),
    )!;
    expect(planTab.getAttribute("aria-selected")).toBe("true");

    // 复杂任务：展开步骤，带执行器证据，并显示一行进展。
    expect(holder.textContent).toContain("1. 定位服务");
    expect(holder.textContent).toContain("active (running)");
    expect(holder.textContent).toContain("正在执行：备份旧版本");

    // 点步骤：跳到「终端 → 执行输出」。
    const step = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("定位服务"),
    )!;
    await act(async () => step.click());
    const terminalTab = Array.from(holder.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (node) => node.textContent?.includes("终端"),
    )!;
    expect(terminalTab.getAttribute("aria-selected")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("运行记录保留发起时的上下文 / 输出 / 模型（改选不影响已发起的）", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockImplementation(
    () => new Promise<AgentSnapshot>(() => undefined),
  );
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockResolvedValue(snapshot({ status: "running" }));
  const providers = vi.spyOn(opsApi, "aiProviderList").mockResolvedValue([
    { id: "p1", name: "DeepSeek", model: "deepseek-v3", enabled: true },
  ] as never);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-run-meta", "生产", "extreme-run-meta", "root@10.0.0.41:22");
  useExtremeStore.getState().ensureWorkspace();
  useExtremeStore.getState().setContextMode("only");
  useExtremeStore.getState().setOutputStyle("brief");
  useExtremeStore.getState().setProviderId("p1");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "更新 OPS 前端并检查证书");
    await flushAgent();

    // 发起后把下拉改回默认：运行记录仍显示发起时的选择。
    await act(async () => {
      useExtremeStore.getState().setContextMode("session");
      useExtremeStore.getState().setProviderId(null);
      useExtremeStore.getState().setPaneView("split");
      useExtremeStore.getState().setPaneTab("plan");
    });
    await act(async () => root.render(<ExtremeCoreView />));
    expect(holder.textContent).toContain("仅本条 · 简洁结论 · DeepSeek");

    await emitAgent({ taskId: run.mock.calls[0][0].taskId, kind: "cancelled" });
    await flushAgent();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    providers.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("keeps the main window's caption buttons and adds collapse / close", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-chrome-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "203.0.113.42");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    // 顶栏现在是项目的 `page-toolbar`（div），不是 <header>。
    const toolbar = holder.querySelector(".page-toolbar")!;
    // 整条顶栏是拖拽区（窗口无边框时唯一的拖动入口）。
    expect(toolbar.hasAttribute("data-tauri-drag-region")).toBe(true);

    const buttons = Array.from(toolbar.querySelectorAll("button"));
    // 主窗口同款三个窗口按钮在最右，关闭是最后一个。
    win.close.mockClear();
    await act(async () => buttons[buttons.length - 1].click());
    expect(win.close).toHaveBeenCalledTimes(1);

    // 返回按钮和终端工具条一样是 24px 纯图标按钮，用 aria-label 定位。
    const back =
      holder.querySelector<HTMLButtonElement>('button[aria-label*="返回"]') ??
      buttons.find((button) => button.textContent?.includes("返回"));
    expect(back).toBeTruthy();
    await act(async () => back!.click());
    expect(useExtremeStore.getState().active).toBe(false);
    // 返回只退出超能：会话与上下文都还在。
    expect(useExtremeStore.getState().sessionId).toBe(sessionId);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    vi.unstubAllGlobals();
    await i18n.changeLanguage(language);
  }
});

it("只在浅色欢迎页挂载 Aero Shards，进入对话后卸载背景", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rootElement = document.documentElement;
  const previousTheme = rootElement.dataset.theme;
  rootElement.dataset.theme = "light";
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore
    .getState()
    .enter("welcome-server-id", "welcome server", "extreme-light-bg", "203.0.113.120");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    // 浅色走官方 Aero Shards（深色才用 Galaxy）。
    expect(holder.querySelector('[data-testid="aero-shards"]')).not.toBeNull();
    expect(holder.querySelector('[data-testid="galaxy"]')).toBeNull();
    await act(async () => {
      useExtremeStore.getState().pushMessage({ id: "welcome-to-chat", role: "user", text: "检查服务状态" });
    });
    expect(holder.querySelector('.extreme-core[data-welcome="false"]')).not.toBeNull();
    expect(holder.querySelector('[data-testid="aero-shards"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    vi.unstubAllGlobals();
    if (previousTheme) rootElement.dataset.theme = previousTheme;
    else delete rootElement.dataset.theme;
    await i18n.changeLanguage(language);
  }
});

it("深色欢迎页挂载 Galaxy，进入对话后卸载背景", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rootElement = document.documentElement;
  const previousTheme = rootElement.dataset.theme;
  rootElement.dataset.theme = "dark";
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore
    .getState()
    .enter("welcome-dark-server-id", "dark welcome server", "extreme-dark-bg", "203.0.113.121");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    // 深色 + 新建任务（欢迎态）：官方 Galaxy；不挂浅色那套。
    expect(holder.querySelector('[data-testid="galaxy"]')).not.toBeNull();
    expect(holder.querySelector('[data-testid="aero-shards"]')).toBeNull();
    await act(async () => {
      useExtremeStore.getState().pushMessage({ id: "welcome-dark-to-chat", role: "user", text: "检查服务状态" });
    });
    expect(holder.querySelector('[data-testid="galaxy"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    vi.unstubAllGlobals();
    if (previousTheme) rootElement.dataset.theme = previousTheme;
    else delete rootElement.dataset.theme;
    await i18n.changeLanguage(language);
  }
});

it("气泡下有复制 / 引用 / 编辑，编辑与引用把文本送回输入框并聚焦末尾", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockImplementation(async (taskId) => snapshot({ taskId, content: "第一行\n第二行" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-actions-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  // 换一台「主机」：工作区按服务器复用，同一台会把上一个用例的对话带进来。
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "198.51.100.7");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "看这段日志");
    await flushAgent();

    const textarea = holder.querySelector("textarea")!;
    const userRows = holder.querySelectorAll('[data-role="user"]');
    const replyRows = holder.querySelectorAll('[data-role="assistant"]');
    // 自己的两句动作、回复的两句动作（项目 Tooltip + 图标按钮）。
    const own = userRows[userRows.length - 1].querySelectorAll<HTMLButtonElement>(
      'button[aria-label="复制"], button[aria-label="编辑"]',
    );
    const reply = replyRows[replyRows.length - 1].querySelectorAll<HTMLButtonElement>(
      'button[aria-label="复制"], button[aria-label="引用"]',
    );
    expect(own).toHaveLength(2);
    expect(reply).toHaveLength(2);

    // 编辑（自己那句的第二项）：原文回填，光标在末尾。
    await act(async () => own[1].click());
    expect(textarea.value).toBe("看这段日志");
    expect(textarea.selectionStart).toBe(textarea.value.length);

    // 引用（回复的第二项）：整段变成引用块，光标落在末尾的空行后。
    await act(async () => reply[1].click());
    expect(textarea.value).toBe("> 第一行\n> 第二行\n\n看这段日志");
    expect(textarea.selectionStart).toBe(textarea.value.length);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

/* ---------------- MAX 强制计划 / 执行前说明 ---------------- */

it("MAX：计划卡在右上角，说明在命令上方；同组重复事件只留一条说明", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot());
  const providers = vi.spyOn(opsApi, "aiProviderList").mockResolvedValue([
    {
      id: "p1",
      name: "DeepSeek",
      model: "deepseek-v4",
      enabled: true,
      is_default: true,
      updated_at: 1,
      context_window: 1024 * 1024,
      context_budgets: [300 * 1024],
      // 供应商最高档只到 high：用户仍然可以选 MAX，门控不能丢。
      reasoning_efforts: ["low", "high"],
    },
  ] as never);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.setState({ modelSettings: {} });
  useExtremeStore.getState().enter("server-max-plan", "server", "extreme-max-plan", "198.51.100.31");
  useExtremeStore.getState().ensureWorkspace();
  useExtremeStore.getState().setProviderId("p1");

  const planOf = (state: "pending" | "done") => ({
    understanding: "把站点部署到 nginx",
    summary: "先检查再部署",
    prerequisites: ["确认是生产环境"],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    steps: [
      {
        id: "s1",
        title: "检查 Nginx 配置",
        action: "nginx -T",
        verify: "确认站点目录",
        kind: "probe",
        state,
      },
      {
        id: "s2",
        title: "更新站点",
        action: "写入新的配置",
        verify: "nginx -t 通过",
        kind: "action",
        state: "pending",
      },
    ],
  });

  try {
    await act(async () => root.render(<ExtremeCoreView />));
    // 等提供方列表装进来，再按模型记住 MAX（与真实菜单写入同一个键）。
    await flushAgent();
    useExtremeStore.getState().setModelSetting("p:p1", { effort: "max" });
    await submit(holder, "把站点部署到 nginx");

    const request = run.mock.calls[0][0];
    // 用户选 MAX：请求发 max（后端按能力落成 high），同时开启强制计划。
    expect(request.reasoningEffort).toBe("max");
    expect(request.planRequired).toBe(true);
    const taskId = request.taskId;

    await emitAgent({ taskId, kind: "plan_updated", plan: planOf("pending") });
    await emitAgent({
      taskId,
      kind: "tool_started",
      stepIndex: 0,
      callId: "call-0-0",
      tool: "run_shell",
      risk: "read",
      // 已经跑完的命令：这条用例验证排版与计划卡，不需要 ThoughtLine 动效。
      state: "success",
      command: "nginx -T",
      summary: "读取 Nginx 配置",
      planStepId: "s1",
      groupId: "p-s1",
      note: "先看看站点配置指向哪个目录。",
    });
    await flushAgent();

    const text = holder.textContent ?? "";
    expect(text).toContain("执行计划");
    expect(text).toContain("检查 Nginx 配置");
    // 说明必须排在命令上方。
    expect(text.indexOf("先看看站点配置指向哪个目录。")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("先看看站点配置指向哪个目录。")).toBeLessThan(
      text.indexOf("读取 Nginx 配置"),
    );

    // 点计划卡里的步骤：定位到聊天里对应的命令行（滚动 + 短暂高亮）。
    const planStep = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("检查 Nginx 配置"),
    );
    expect(planStep).toBeTruthy();
    await act(async () => planStep!.click());
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(
      holder.querySelector('[data-plan-focus]') ??
        holder.querySelector('[data-plan-step="s1"]'),
    ).toBeTruthy();

    // 同一组的下一条命令：不重复补说明。
    await emitAgent({
      taskId,
      kind: "tool_started",
      stepIndex: 1,
      callId: "call-0-1",
      tool: "run_shell",
      risk: "read",
      state: "success",
      command: "cat /etc/nginx/nginx.conf",
      summary: "查看 Nginx 配置",
      planStepId: "s1",
      groupId: "p-s1",
    });
    await flushAgent();
    expect((holder.textContent ?? "").split("先看看站点配置指向哪个目录。").length - 1).toBe(1);

    // 真实事件推进计划步骤：计划卡上的完成数跟着变，位置不跳。
    await emitAgent({ taskId, kind: "plan_updated", plan: planOf("done") });
    await flushAgent();
    expect(holder.textContent).toContain("1/2");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    useExtremeStore.setState({ modelSettings: {} });
    run.mockRestore();
    snap.mockRestore();
    providers.mockRestore();
    vi.unstubAllGlobals();
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    channels.clear();
    await i18n.changeLanguage(language);
  }
});
