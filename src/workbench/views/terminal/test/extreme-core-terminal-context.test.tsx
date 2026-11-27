import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import type { AgentSnapshot } from "@/api/types/agent";
import { useExtremeStore } from "@/stores/extreme-store";
import { ExtremeCoreView } from "../extreme-core/ExtremeCoreView";

/**
 * 真实终端的输出要**守同一套上下文规则**。
 *
 * 以前它在组装完聊天上下文之后单独追加，`仅本条 / 自选` 都管不到 —— 用户只
 * 问一句话，模型却能看到他刚才在终端里跑了什么。
 */

const TAIL = "TAIL-MARKER-1234\n$ uptime\n 10:00 up 3 days";

vi.mock("../extreme-core/manual-shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extreme-core/manual-shell")>();
  return { ...actual, manualShellTail: async () => TAIL };
});

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
    taskId: "task-tail",
    status: "success",
    model: "test-model",
    content: "看完了。",
    error: null,
    cwd: "/root",
    server: "server",
    sessionId: "extreme-tail",
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

async function flush(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
}

/** 一次请求里所有消息正文拼起来。 */
function payload(run: ReturnType<typeof vi.spyOn>, call: number): string {
  return run.mock.calls[call][0].messages
    .map((item: { content: string }) => item.content)
    .join("\n");
}

it("终端输出：当前会话自动带；仅本条不带；手动加入后带上并在输入框可见", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockImplementation(async (taskId: string) => ({
      ...snapshot({ taskId, content: "好" }),
      updatedAt: Date.now() + 1000,
    }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-tail", "生产", "extreme-tail", "root@10.0.0.50:22");
  useExtremeStore.getState().ensureWorkspace();
  try {
    await act(async () => root.render(<ExtremeCoreView />));

    // 1) 默认「当前会话」：终端输出属于这段对话的上下文，跟着发。
    await submit(holder, "看看磁盘");
    await flush();
    expect(payload(run, 0)).toContain("TAIL-MARKER-1234");

    // 2) 切到「仅本条」：不再自动带。
    await act(async () => useExtremeStore.getState().setContextMode("only"));
    await submit(holder, "就这一句");
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(payload(run, 1)).not.toContain("TAIL-MARKER-1234");

    // 3) 右栏「加入本次对话」：显式加入后带上，且输入框上方能看到这条材料。
    //    直接走 `openPane`（顶栏按钮 / ＋ 同一个入口），不依赖标签栏的当前列表。
    await act(async () => useExtremeStore.getState().openPane("terminal", "manual"));
    const add = Array.from(holder.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("加入本次对话"),
    );
    expect(add).toBeTruthy();
    await act(async () => add!.click());
    await flush(2);

    const composer = holder.querySelector("[data-extreme-composer]")?.textContent ?? "";
    expect(composer).toContain("真实终端最近");

    await submit(holder, "按这段输出判断");
    await flush();
    expect(run).toHaveBeenCalledTimes(3);
    expect(payload(run, 2)).toContain("TAIL-MARKER-1234");
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
