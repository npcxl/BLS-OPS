import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import type { AgentSnapshot } from "@/api/types/agent";
import { useExtremeStore } from "@/stores/extreme-store";
import { useExtremeSettingsStore } from "@/stores/extreme-settings-store";
import { ExtremeCoreView } from "../extreme-core/ExtremeCoreView";

/**
 * 同一台服务器上的两条对话**共用一条 SSH 连接**。
 *
 * 这组用例钉住验收路径：A 在查日志 → 用户切到 B 继续打字 → A 的结果只回到 A
 * （不打开 B 的右栏、也不吃掉 B 的这句话）→ 切回 A 才看到结果。
 */

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
    taskId: "task-iso",
    status: "success",
    model: "test-model",
    content: "好的，我去找一下日志来源。",
    error: null,
    cwd: "/root",
    server: "server",
    sessionId: "extreme-iso",
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

/** 扫描输出：两个同分候选 → 触发"要看哪一个"的歧义问题。 */
const TWO_SOURCES = "##files\n/var/log/nginx/access.log\n/var/log/nginx/error.log\n";

it("A 查日志的探测结果不会打开 B 的右栏；切回 A 才看到结果", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockImplementation(async (taskId: string) => ({
      ...snapshot({ taskId }),
      updatedAt: Date.now() + 1000,
    }));
  // 探测挂起：测试自己决定什么时候"服务器回话"。
  let release: ((value: { stdout: string; stderr: string; exit_code: number }) => void) | null = null;
  const exec = vi.spyOn(opsApi, "sshExec").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve as never;
      }) as never,
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-iso", "生产", "extreme-iso", "root@10.0.0.40:22");
  const wsA = useExtremeStore.getState().ensureWorkspace()!;
  try {
    await act(async () => root.render(<ExtremeCoreView />));

    // A：问一句要日志 → 运行结束 → 去服务器上扫来源（探测挂起）。
    await submit(holder, "看下 nginx 的日志");
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalled();

    // 用户切到 B（新建一条对话）。
    await act(async () => {
      // 这个用例验证“A 的探测不会打开 B 的右栏”：B 的新任务默认设为收起。
      useExtremeSettingsStore.getState().update({ newTaskPane: "closed" });
      useExtremeStore.getState().addWorkspace([]);
      root.render(<ExtremeCoreView />);
    });
    const wsB = useExtremeStore.getState().workspaceId!;
    expect(wsB).not.toBe(wsA);
    await flush();

    // A 的探测现在才回来：两个同分候选 → 应该只在 A 里问"要看哪一个"。
    await act(async () => {
      release?.({ stdout: TWO_SOURCES, stderr: "", exit_code: 0 });
    });
    await flush();

    const state = useExtremeStore.getState();
    expect(state.workspaceId).toBe(wsB);
    // B 的右栏没有被打开、也没有被写上别人的面板目标。
    expect(state.paneView).toBe("hidden");
    expect(state.panelTarget).toBeNull();
    // B 的对话里没有 A 的追问。
    expect(holder.textContent).not.toContain("要看哪一个");

    // 结果归 A：切回去能看到那条"要看哪一个"。
    let restored = "";
    await act(async () => {
      restored = useExtremeStore.getState().workspaces.find((item) => item.id === wsA)?.messages
        .map((message) => message.text)
        .join("\n") ?? "";
    });
    expect(restored).toContain("要看哪一个");

    await act(async () => {
      useExtremeStore.getState().openWorkspace(wsA);
      root.render(<ExtremeCoreView />);
    });
    expect(holder.textContent).toContain("要看哪一个");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    exec.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});

it("B 里的短回复不会被当成在回答 A 的日志候选", async () => {
  const run = vi.spyOn(opsApi, "aiAgentRun").mockResolvedValue(snapshot());
  const snap = vi
    .spyOn(opsApi, "aiAgentSnapshot")
    .mockImplementation(async (taskId: string) => ({
      ...snapshot({ taskId }),
      updatedAt: Date.now() + 1000,
    }));
  const exec = vi.spyOn(opsApi, "sshExec").mockResolvedValue({
    stdout: TWO_SOURCES,
    stderr: "",
    exit_code: 0,
  } as never);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  channels.clear();
  useExtremeStore.getState().enter("srv-iso2", "生产", "extreme-iso2", "root@10.0.0.41:22");
  useExtremeStore.getState().ensureWorkspace();
  try {
    await act(async () => root.render(<ExtremeCoreView />));
    await submit(holder, "看下 nginx 的日志");
    await flush();
    // A 现在在问"要看哪一个"。
    expect(holder.textContent).toContain("要看哪一个");

    // 切到 B，回一句 "1"：不是 A 的候选，必须照常走问答。
    await act(async () => {
      // 这个用例验证“A 的探测不会打开 B 的右栏”：B 的新任务默认设为收起。
      useExtremeSettingsStore.getState().update({ newTaskPane: "closed" });
      useExtremeStore.getState().addWorkspace([]);
      root.render(<ExtremeCoreView />);
    });
    await flush();
    await submit(holder, "1");
    await flush();

    const state = useExtremeStore.getState();
    // 这句话被当成普通消息发出去了（第二次 aiAgentRun），而不是开了 A 的日志面板。
    expect(run).toHaveBeenCalledTimes(2);
    expect(state.paneView).toBe("hidden");
    expect(holder.textContent).toContain("1");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    useExtremeStore.getState().exit();
    run.mockRestore();
    snap.mockRestore();
    exec.mockRestore();
    vi.unstubAllGlobals();
    channels.clear();
    await i18n.changeLanguage(language);
  }
});
