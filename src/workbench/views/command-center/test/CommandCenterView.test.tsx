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
  it("searches as you type without requiring a server connection", async () => {
    // Retrieval is local knowledge — it must work even when disconnected.
    mocks.session.phase = "closed";
    searchMock.mockResolvedValue([hit()]);
    await mount();
    await type("docker p");

    expect(searchMock).toHaveBeenCalledWith("docker p", 20);
    expect(container.textContent).toContain("docker ps -a");
  });

  it("executes a read-only command directly", async () => {
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

    const target = buttonWith("docker ps -a");
    expect(target).toBeTruthy();
    await click(target!);

    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  /**
   * 安全回归：medium 风险命令（restart / reload 等）必须先弹确认，
   * 绝不能在点击或回车后直接执行。
   */
  it("asks for confirmation before running a medium-risk command", async () => {
    searchMock.mockResolvedValue([RESTART]);
    await mount();
    await type("systemctl restart");

    const target = buttonWith("systemctl restart <unit>");
    expect(target).toBeTruthy();
    await click(target!);

    // Must NOT have executed yet.
    expect(executeMock).not.toHaveBeenCalled();
    expect(dialogText()).toContain("确认执行");

    // Confirming runs it.
    const confirm = dialogButton("确认执行");
    expect(confirm).toBeTruthy();
    await click(confirm!);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("cancelling the confirmation executes nothing", async () => {
    searchMock.mockResolvedValue([RESTART]);
    await mount();
    await type("systemctl restart");
    await click(buttonWith("systemctl restart <unit>")!);
    expect(dialogText()).toContain("确认执行");

    const cancel = dialogButton("取消");
    expect(cancel).toBeTruthy();
    await click(cancel!);
    expect(executeMock).not.toHaveBeenCalled();
    expect(dialogText()).not.toContain("确认执行");
  });

  it("blocks execution when the server lacks the tool, and says which", async () => {
    searchMock.mockResolvedValue([hit()]);
    probeMock.mockResolvedValue([]); // docker not installed
    await mount();
    await type("docker");

    await click(buttonWith("docker ps -a")!);
    expect(executeMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("服务器未安装 docker");
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
