import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSearchHit } from "@/api/ops-api";

// React 19 requires this flag for act() outside react-dom/test-utils.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Mocks are hoisted, so shared state lives in `vi.hoisted` — that lets each
 * test move the session between connected / disconnected without remounting.
 */
const mocks = vi.hoisted(() => ({
  session: {
    ready: true,
    hasTarget: true,
    sessionId: "session-1",
    phase: "connected" as "connected" | "connecting" | "closed",
    error: null as string | null,
  },
}));

vi.mock("@/hooks/use-command-session", () => ({
  useCommandSession: () => mocks.session,
}));

vi.mock("@/api/ops-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops-api")>();
  return {
    ...actual,
    opsApi: {
      ...actual.opsApi,
      commandSearch: vi.fn(),
      commandExecute: vi.fn(),
      commandToggleFavorite: vi.fn(),
      commandProbeTools: vi.fn(),
    },
  };
});

import { opsApi } from "@/api/ops-api";
import { CommandCenterView } from "../CommandCenterView";

const searchMock = vi.mocked(opsApi.commandSearch);
const executeMock = vi.mocked(opsApi.commandExecute);
const probeMock = vi.mocked(opsApi.commandProbeTools);

function hit(overrides: Partial<CommandSearchHit> = {}): CommandSearchHit {
  return {
    id: "docker.ps.all",
    executable: "docker",
    subcommand: "ps",
    title: "查看所有容器",
    description: "显示运行中和已停止的容器",
    category: "container",
    syntax: "docker ps -a",
    risk: "read_only",
    mutability: "read",
    output_adapter: "docker-container-table",
    requires: ["docker"],
    required_params: [],
    placeholders: [],
    can_execute: true,
    favorite: false,
    score: 100,
    ...overrides,
  };
}

const RESTART = hit({
  id: "systemctl.restart",
  executable: "systemctl",
  subcommand: "restart",
  title: "重启服务",
  syntax: "systemctl restart <unit>",
  risk: "medium",
  mutability: "change",
  requires: ["systemctl"],
  required_params: [],
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<CommandCenterView tab={{ id: "tab-1", type: "command_center", title: "命令" } as never} />);
  });
}

/** Types into the search box and lets the 120ms debounce settle. */
async function type(value: string) {
  const input = container.querySelector("input") as HTMLInputElement;
  // React tracks the value internally: assigning `input.value` directly is
  // invisible to it, so go through the native setter before dispatching.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

/**
 * 新交互（用户裁决）：输入只给行内 ghost，**按 Tab 才展开完整列表**。
 * 列表操作类用例都先 type 再 pressTab 回到"之前的流程"。
 */
async function pressKey(key: string) {
  const input = container.querySelector("input") as HTMLInputElement;
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function pressTab() {
  await pressKey("Tab");
}

/** Buttons inside the view (the suggestion list). */
function buttonWith(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text),
  );
}

/**
 * Buttons inside a dialog. ConfirmDialog renders through a portal into
 * `document.body`, so it is NOT inside the mounted container.
 */
function dialogButton(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text),
  );
}

function dialogText(): string {
  return document.body.textContent ?? "";
}

async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { ready: true, hasTarget: true, sessionId: "session-1", phase: "connected", error: null };
  searchMock.mockResolvedValue([]);
  probeMock.mockResolvedValue(["docker", "systemctl"]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CommandCenterView", () => {
  it("blank input fires zero search API calls and renders no hint at all", async () => {
    await mount();
    await type("   "); // 纯空白 = 视为空输入

    expect(searchMock).toHaveBeenCalledTimes(0);
    expect(container.querySelector("kbd")).toBeNull();
    expect(container.querySelector("svg.text-fg-subtle + div")?.textContent ?? "").not.toContain(
      "docker ps -a",
    );
    expect(buttonWith("查看所有容器")).toBeUndefined();
  });

  it("typing shows an inline ghost + Tab badge, NOT the list and NOT a hit count", async () => {
    // Retrieval is local knowledge — it must work even when disconnected.
    mocks.session.phase = "closed";
    searchMock.mockResolvedValue([hit()]);
    await mount();
    await type("docker p");

    expect(searchMock).toHaveBeenCalledWith("docker p", 20);
    // 收起态：完整列表（<button> 项）不出现，但 ghost 提示与 Tab 徽标在。
    expect(buttonWith("查看所有容器")).toBeUndefined();
    expect(container.querySelector("kbd")).not.toBeNull();
    // 命中数量（"x hits"）已删除 —— 轻提示模式不打扰。
    expect(container.textContent).not.toContain("hits");
  });

  it("Tab fills the first suggestion and expands the full list", async () => {
    searchMock.mockResolvedValue([hit()]);
    await mount();
    await type("docker p");
    await pressTab();

    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("docker ps -a");
    expect(buttonWith("查看所有容器")).toBeTruthy();
  });

  it("ArrowDown also fills the first suggestion and expands", async () => {
    searchMock.mockResolvedValue([hit()]);
    await mount();
    await type("docker p");
    await pressKey("ArrowDown");

    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("docker ps -a");
    expect(buttonWith("查看所有容器")).toBeTruthy();
  });

  it("collapsed Enter executes the first (ghost) suggestion directly", async () => {
    searchMock.mockResolvedValue([hit()]);
    executeMock.mockResolvedValue({
      knowledge_id: "docker.ps.all",
      title: "查看所有容器",
      risk: "read_only",
      raw: { command_executed: "docker ps -a", stdout: "", stderr: "", duration_ms: 1 },
      structured: null,
    } as never);
    await mount();
    await type("docker");

    await pressKey("Enter");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("collapsed Enter still goes through confirmation for medium risk", async () => {
    searchMock.mockResolvedValue([RESTART]);
    await mount();
    await type("systemctl restart");

    await pressKey("Enter");
    expect(executeMock).not.toHaveBeenCalled();
    expect(dialogText()).toContain("Confirm execution");
  });

  it("Escape clears the query, collapses the list and keeps focus", async () => {
    searchMock.mockResolvedValue([hit()]);
    await mount();
    await type("docker p");
    await pressTab();
    expect(buttonWith("查看所有容器")).toBeTruthy();

    await pressKey("Escape");
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(buttonWith("查看所有容器")).toBeUndefined();
    expect(container.querySelector("kbd")).toBeNull();
    // 焦点保持在输入框。
    expect(document.activeElement).toBe(input);
  });

  it("editing the query while expanded returns to the collapsed ghost state", async () => {
    searchMock.mockResolvedValue([hit()]);
    await mount();
    await type("docker p");
    await pressTab();
    expect(buttonWith("查看所有容器")).toBeTruthy();

    // 展开态手动改字 → 重新进入 collapsed（ghost + Tab 徽标，列表消失）。
    await type("docker ps ");
    expect(buttonWith("查看所有容器")).toBeUndefined();
    expect(container.querySelector("kbd")).not.toBeNull();
  });

  it("expanded list keeps select / run / click / favorite behaviors", async () => {
    searchMock.mockResolvedValue([hit()]);
    executeMock.mockResolvedValue({
      knowledge_id: "docker.ps.all",
      title: "查看所有容器",
      risk: "read_only",
      raw: { command_executed: "docker ps -a", stdout: "", stderr: "", duration_ms: 1 },
      structured: null,
    } as never);
    await mount();
    await type("docker p");
    await pressTab();

    // 鼠标点击执行。
    await click(buttonWith("docker ps -a")!);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  /**
   * 安全回归：medium 风险命令（restart / reload 等）必须先弹确认，
   * 绝不能在点击或回车后直接执行。
   */
  it("asks for confirmation before running a medium-risk command from the expanded list", async () => {
    searchMock.mockResolvedValue([RESTART]);
    await mount();
    await type("systemctl restart");
    await pressTab();

    const target = buttonWith("systemctl restart <unit>");
    expect(target).toBeTruthy();
    await click(target!);

    // Must NOT have executed yet.
    expect(executeMock).not.toHaveBeenCalled();
    expect(dialogText()).toContain("Confirm execution");

    // Confirming runs it.
    const confirm = dialogButton("Confirm execution");
    expect(confirm).toBeTruthy();
    await click(confirm!);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("cancelling the confirmation executes nothing", async () => {
    searchMock.mockResolvedValue([RESTART]);
    await mount();
    await type("systemctl restart");
    await pressTab();
    await click(buttonWith("systemctl restart <unit>")!);
    expect(dialogText()).toContain("Confirm execution");

    const cancel = dialogButton("Cancel");
    expect(cancel).toBeTruthy();
    await click(cancel!);
    expect(executeMock).not.toHaveBeenCalled();
    expect(dialogText()).not.toContain("Confirm execution");
  });

  it("blocks execution when the server lacks the tool, and says which", async () => {
    searchMock.mockResolvedValue([hit()]);
    probeMock.mockResolvedValue([]); // docker not installed
    await mount();
    await type("docker");
    await pressTab();

    await click(buttonWith("docker ps -a")!);
    expect(executeMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Not installed on server: docker");
  });

  it("probes the tools required by the hits (not an empty first render)", async () => {
    // Regression: probing before the first search returned zero tools, so every
    // command was wrongly reported as "not installed".
    searchMock.mockResolvedValue([hit()]);
    await mount();
    await type("docker");

    expect(probeMock).toHaveBeenCalledWith("session-1", ["docker"]);
  });
});
