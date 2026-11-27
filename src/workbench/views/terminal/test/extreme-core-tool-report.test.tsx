import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import type { AgentEvent, AgentSnapshot } from "@/api/types/agent";
import { useExtremeStore, type ExtremeAttachment } from "@/stores/extreme-store";
import { ExtremeCoreView } from "../extreme-core/ExtremeCoreView";

// 顶部栏要窗口 API；jsdom 里没有 Tauri 运行时。
const win = vi.hoisted(() => ({
  close: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async () => () => {}),
  scaleFactor: vi.fn(async () => 1),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  Channel: class {},
}));

/** 事件总线的替身：测试自己按 taskId 触发终态。 */
const channels = vi.hoisted(() => {
  const handlers = new Map<string, ((event: { payload: unknown }) => void)[]>();
  return {
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
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@/components/backgrounds/galaxy", () => ({ default: () => null }));
vi.mock("@/components/backgrounds/aero-shards", () => ({ default: () => null }));
vi.mock("@/hooks/use-theme", () => ({
  getThemeMode: () => "dark",
  setThemeMode: () => undefined,
  useThemeMode: () => ["dark", () => undefined],
  useIsDarkTheme: () => true,
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
    sessionId: "tool-report-test",
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

/** 上传 + 续跑要跑好几轮 Promise，比一次 30ms 的 flush 更久。 */
async function flush(times = 4) {
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

/** 三个待上传的文本附件。 */
function attachments(): ExtremeAttachment[] {
  return ["web/index.html", "web/app.js", "web/style.css"].map((path, index) => ({
    id: `file-${index}`,
    name: path.split("/").pop()!,
    path,
    size: 32,
    state: "ready" as const,
    text: "<!-- test -->",
    uploadState: "local" as const,
  }));
}

it("上传结果挂在操作链下面，不再变成用户气泡，模型拿到真实回执并继续", async () => {
  // `aiAgentRun` 只负责"启动"：真正结束由 `finished` 事件驱动。
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot());
  const sizes = new Map<string, number>();
  const ssh = vi.spyOn(opsApi, "sshExec").mockImplementation(async (_session, command) => {
    if (command.includes("mkdir -p")) {
      const parent = /mkdir -p -- '([^']+)'/.exec(command)?.[1] ?? "";
      return { stdout: `/root/${parent}`, stderr: "", exit_code: 0, truncated: false };
    }
    if (command.includes("wc -c")) {
      const path = /test -f '([^']+)'/.exec(command)?.[1] ?? "";
      const size = sizes.get(path) ?? sizes.get(`${path}.part`) ?? 0;
      return { stdout: String(size), stderr: "", exit_code: 0, truncated: false };
    }
    return { stdout: "no", stderr: "", exit_code: 0, truncated: false };
  });
  const write = vi.spyOn(opsApi, "sftpWriteChunk").mockImplementation(
    async (_session, path, offset, base64) => {
      const total = offset + atob(base64).length;
      sizes.set(path, total);
      return total;
    },
  );
  const finish = vi.spyOn(opsApi, "sftpStageFinish").mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-tool-report-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "198.51.100.21");
  useExtremeStore.getState().setAttachments(() => attachments());
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "把这三个文件传到服务器上");

    const taskId = run.mock.calls[0][0].taskId;
    // 模型先回一句人话 + 请求上传，随后由平台执行、把回执交给它继续。
    await emitAgent({
      taskId,
      kind: "finished",
      content: "先把文件传上去，我接着分析目录结构。\n[[upload]]",
      model: "test-model",
    });
    await flush();

    // 1) 聊天里只有用户自己发的那一句（没有「平台执行结果」气泡）。
    const users = useExtremeStore.getState().messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].text).toBe("把这三个文件传到服务器上");
    expect(holder.textContent).not.toContain("平台执行结果");
    expect(holder.textContent).not.toContain("结果见上一条提示");
    // 动作标记本身也不该留在气泡里。
    expect(holder.textContent).not.toContain("[[upload]]");

    // 2) 操作链下面只有一行上传结果，目录可点。
    expect(write).toHaveBeenCalledTimes(3);
    // 自动暂存已经传过：这次 [[upload]] 只核验并复用，不再重传。
    expect(holder.textContent).toContain("复用 3 个");
    expect(holder.querySelectorAll(".extreme-core-report")).toHaveLength(1);
    const path = holder.querySelector(".extreme-core-report-path");
    expect(path?.textContent).toContain("/.bls-ops/staging/");

    // 3) 模型拿到了真实回执，并且续跑仍挂在同一个 taskId 上。
    expect(run).toHaveBeenCalledTimes(2);
    const followUp = run.mock.calls[1][0];
    expect(followUp.taskId).toBe(taskId);
    expect(
      followUp.messages.some((message: { content: string }) =>
        message.content.includes("复用 3 个"),
      ),
    ).toBe(true);
    await emitAgent({ taskId, kind: "text_delta", content: "正在检查上传结果。[[up" });
    const replies = useExtremeStore.getState().messages.filter((message) => message.role === "assistant");
    expect(replies[0]?.text).toBe("先把文件传上去，我接着分析目录结构。");
    expect(replies[1]?.text).toBe("正在检查上传结果。");
    await emitAgent({ taskId, kind: "text_delta", content: 'load]]\n<tool name="run_shell">{"command":"ls"}' });
    expect(holder.textContent).not.toContain('{"command":"ls"}');
    await emitAgent({ taskId, kind: "finished", content: "上传后的文件已检查。", model: "test-model" });
    expect(ssh).toHaveBeenCalled();
    expect(snap).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    ssh.mockRestore();
    write.mockRestore();
    finish.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("上传失败：步骤自己写清原因，用户正在输入的草稿不动", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot());
  const ssh = vi.spyOn(opsApi, "sshExec").mockImplementation(async (_session, command) => {
    if (command.includes("mkdir -p")) {
      const parent = /mkdir -p -- '([^']+)'/.exec(command)?.[1] ?? "";
      return { stdout: `/root/${parent}`, stderr: "", exit_code: 0, truncated: false };
    }
    return { stdout: "no", stderr: "", exit_code: 0, truncated: false };
  });
  const write = vi
    .spyOn(opsApi, "sftpWriteChunk")
    .mockRejectedValue(new Error("Permission denied"));
  const finish = vi.spyOn(opsApi, "sftpStageFinish").mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-tool-report-fail";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "198.51.100.22");
  useExtremeStore.getState().setAttachments(() => attachments());
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "把这三个文件传到服务器上");
    const taskId = run.mock.calls[0][0].taskId;

    // 用户已经在写下一句话了，上传失败不能把它清掉。
    const textarea = holder.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "写了一半的话",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await emitAgent({
      taskId,
      kind: "finished",
      content: "先上传。\n[[upload]]",
      model: "test-model",
    });
    await flush();

    expect(holder.querySelectorAll(".extreme-core-report")).toHaveLength(1);
    expect(holder.textContent).toContain("上传失败");
    expect(holder.textContent).toContain("Permission denied");
    expect(textarea.value).toBe("写了一半的话");

    // 回执照样交给模型：它知道文件没上去，可以换方案。
    expect(run).toHaveBeenCalledTimes(2);
    const followUp = run.mock.calls[1][0];
    expect(
      followUp.messages.some((message: { content: string }) =>
        message.content.includes("Permission denied"),
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    ssh.mockRestore();
    write.mockRestore();
    finish.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("模型正文按增量上屏：同一条气泡长大，内部标记不显示", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-stream-text-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "198.51.100.24");
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "这个包是新的吗");
    const taskId = run.mock.calls[0][0].taskId;

    await emitAgent({ taskId, kind: "text_delta", content: "先看一下。" });
    // 正文按帧合并、按节奏补间上屏：等补间跑完再断言。
    await flush();
    expect(holder.textContent).toContain("先看一下。");

    // 半截标记（`[[up`）先压住不显示，等 `]]` 到了再当标记删掉。
    await emitAgent({ taskId, kind: "text_delta", content: "\n[[up" });
    await flush(1);
    expect(holder.textContent).not.toContain("[[up");
    await emitAgent({ taskId, kind: "text_delta", content: "load]]" });
    await flush();
    expect(holder.textContent).not.toContain("[[upload]]");
    expect(holder.textContent).toContain("先看一下。");

    await emitAgent({
      taskId,
      kind: "finished",
      content: "先看一下。\n[[upload]]",
      model: "test-model",
    });
    await flush();

    // 全程只有一条 assistant 气泡（增量追加，不是每片一条）。
    const replies = useExtremeStore
      .getState()
      .messages.filter((message) => message.role === "assistant" && message.text);
    expect(replies.length).toBe(1);
    expect(replies[0].text).toContain("先看一下。");
    expect(replies[0].text).not.toContain("[[upload]]");
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

it("模型输出 [[start]] 不能替用户按下执行键", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi.spyOn(opsApi, "aiAgentSnapshot").mockResolvedValue(snapshot());
  const ssh = vi
    .spyOn(opsApi, "sshExec")
    .mockResolvedValue({ stdout: "", stderr: "", exit_code: 0, truncated: false });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const sessionId = "extreme-plan-gate-test";
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter(`server-${sessionId}`, "server", sessionId, "198.51.100.23");
  // 预置一版"已生成、等用户确认"的计划（UI 上确实有可执行的步骤）。
  useExtremeStore.setState({
    planTaskId: "task-plan-1",
    planSession: sessionId,
    plan: [
      {
        id: "up",
        kind: "up",
        title: "启动容器",
        detail: "docker compose up -d",
        command: "docker compose up -d",
        state: "pending",
      },
    ],
  });
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "这版方案怎么样");
    const taskId = run.mock.calls[0][0].taskId;

    // 模型自己说"开始"，但用户还没表态。
    await emitAgent({
      taskId,
      kind: "finished",
      content: "方案没问题，我这就开始。\n[[start]]",
      model: "test-model",
    });
    await flush();

    // 计划步骤一条都没执行。
    const executed = ssh.mock.calls.map((call) => String(call[1]));
    expect(executed.some((command) => command.includes("docker compose up"))).toBe(false);
    // 模型收到的是"请用户确认"，不是"已执行"。
    expect(run).toHaveBeenCalledTimes(2);
    const followUp = run.mock.calls[1][0];
    expect(
      followUp.messages.some((message: { content: string }) =>
        message.content.includes("计划还没有得到用户确认"),
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    ssh.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});
