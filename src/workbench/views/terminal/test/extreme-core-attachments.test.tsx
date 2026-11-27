import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import type { AgentSnapshot } from "@/api/types/agent";
import { useExtremeStore } from "@/stores/extreme-store";
import { remoteAttachment } from "../extreme-core/attachments";
import { ExtremeCoreView } from "../extreme-core/ExtremeCoreView";

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
    taskId: "task-att",
    status: "success",
    model: "test-model",
    content: "",
    error: null,
    cwd: "/root",
    server: "server",
    sessionId: "extreme-att",
    steps: [],
    updatedAt: Date.now(),
    ...overrides,
  };
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

/** 等一次轮询 + 渲染落地。 */
async function flush(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
}

/** 输入区（Prompt Bar 那一块）里的文本：附件条与"正在讨论"都渲染在这里。 */
function composerText(holder: HTMLElement): string {
  return holder.querySelector("[data-extreme-composer]")?.textContent ?? "";
}

const SESSION = "extreme-att";
const PATH = "/etc/nginx/nginx.conf";

it("远程附件：选中 → 发送后气泡留文件、请求带路径；同一个文件可以再次选中再发", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  // 立刻给一个"这一轮之后"的终态快照，免得每次发送都把界面挂在执行中。
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    // taskId 要回显：视图按它把终态写回**这一轮**的任务卡。
    .mockImplementation(async (taskId: string) => ({
      ...snapshot({ taskId }),
      updatedAt: Date.now() + 1000,
    }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-att", "生产", SESSION, "root@10.0.0.30:22");
  useExtremeStore.getState().ensureWorkspace();
  // 会话里已经挂着这个远程文件（右键「添加到对话」的结果，正文已读到）。
  useExtremeStore.getState().setAttachments(() => [
    {
      ...remoteAttachment({ name: "nginx.conf", path: PATH, size: 1200, kind: "file" }, SESSION),
      state: "ready",
      text: "server { listen 80; }",
    },
  ]);
  const select = () =>
    holder.querySelector<HTMLInputElement>('input[aria-label="选择 nginx.conf"]')!;
  try {
    await act(async () => root.render(<ExtremeCoreView />));

    /*
     * 打开右栏 › 附件：与输入区 ＋ 走同一个入口（`openPane` 会把标签加进
     * "已打开列表"并展开右栏），不依赖标签栏当前开着哪些标签。
     */
    await act(async () => useExtremeStore.getState().openPane("attachments"));
    await act(async () => select().click());

    // 输入框立刻显示这个附件，右栏同步勾上。
    expect(select().checked).toBe(true);
    expect(composerText(holder)).toContain("nginx.conf");

    // 发送：请求带上同一条远程路径。
    await submit(holder, "看一下这个配置");
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    const first = run.mock.calls[0][0].messages.map((item) => item.content).join("\n");
    expect(first).toContain(PATH);

    // 气泡上仍是这个文件；勾选已经消费掉（输入框不再挂着它）。
    const bubble = holder.querySelector('[data-role="user"]')!;
    expect(bubble.textContent).toContain("nginx.conf");
    expect(select().checked).toBe(false);
    expect(composerText(holder)).not.toContain("nginx.conf");

    // **发过的文件允许再次选中**：同一份不复制，直接再发一次。
    const before = useExtremeStore.getState().attachments.length;
    await act(async () => select().click());
    expect(select().checked).toBe(true);
    expect(composerText(holder)).toContain("nginx.conf");
    expect(useExtremeStore.getState().attachments.length).toBe(before);

    await submit(holder, "再看一遍");
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    const second = run.mock.calls[1][0].messages.map((item) => item.content).join("\n");
    expect(second).toContain(PATH);
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
