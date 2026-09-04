import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CommandExecutionResult } from "@/api/ops-api";
import { CommandResultPanel } from "../CommandResultPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The result panel is the one place the *actual* command and the untouched
 * stdout live, so the right-click menu is the fastest way to get them out.
 * These pin the menu to the header's segmented control, including the case
 * where 结构化视图 does not exist and must not be offered.
 */
const clipboard = { text: "" };
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (text: string) => void (clipboard.text = text) },
  configurable: true,
});

function result(overrides: Partial<CommandExecutionResult> = {}): CommandExecutionResult {
  return {
    title: "磁盘占用",
    risk: "read_only",
    structured: {
      view: "table",
      title: "磁盘占用",
      summary: [],
      columns: [{ key: "fs", label: "文件系统" }],
      rows: [{ fs: "/dev/sda1" }],
      sections: [],
      warnings: [],
      meta: { command: "df -hP", exit_code: 0, duration_ms: 42, truncated: false },
      raw: { stdout: "Filesystem Size\n/dev/sda1 40G", stderr: "" },
    },
    raw: {
      command_executed: "df -hP",
      stdout: "Filesystem Size\n/dev/sda1 40G",
      stderr: "",
      duration_ms: 42,
    },
    ...overrides,
  } as CommandExecutionResult;
}

let holder: HTMLDivElement;
let root: Root;

async function render(ui: React.ReactElement) {
  await act(async () => {
    root.render(ui);
  });
}

const menuEls = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menu"]'));
const menuItems = () =>
  menuEls()[0] ? Array.from(menuEls()[0].querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
/** Label only — the "当前" hint is appended by the menu and is not the label. */
const labels = () =>
  menuItems().map((item) =>
    item.querySelector("span.truncate")?.textContent?.trim() ?? item.textContent?.trim(),
  );

async function rightClick(selector: string) {
  const target = document.body.querySelector<HTMLElement>(selector)!;
  await act(async () => {
    target.dispatchEvent(
      new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent("pointerdown", {
        bubbles: true,
        button: 2,
        clientX: 30,
        clientY: 30,
      }),
    );
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
    );
  });
}

async function clickItem(label: string) {
  const item = menuItems().find((entry) => entry.textContent?.trim().startsWith(label));
  if (!item) throw new Error(`menu item not found: ${label}`);
  await act(async () => {
    item.click();
  });
}

const panel = () => document.body.querySelector<HTMLElement>('[data-testid="result-panel"]')!;

beforeEach(() => {
  clipboard.text = "";
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  holder = document.createElement("div");
  document.body.appendChild(holder);
  root = createRoot(holder);
});

afterEach(() => {
  act(() => root.unmount());
  holder.remove();
});

describe("CommandResultPanel 右键菜单", () => {
  it("shows the header's view switch plus the copy actions", async () => {
    await render(<CommandResultPanel result={result()} />);
    await rightClick('[data-testid="result-panel"]');

    expect(labels()).toEqual([
      "Structured view",
      "Raw output",
      "Copy raw output",
      "Copy executed command",
      "Copy full result",
    ]);
  });

  it("copies the raw output", async () => {
    await render(<CommandResultPanel result={result()} />);
    await rightClick('[data-testid="result-panel"]');
    await clickItem("Copy raw output");

    expect(clipboard.text).toBe("Filesystem Size\n/dev/sda1 40G");
  });

  it("copies the command actually executed, not the knowledge id", async () => {
    await render(<CommandResultPanel result={result()} />);
    await rightClick('[data-testid="result-panel"]');
    await clickItem("Copy executed command");

    expect(clipboard.text).toBe("df -hP");
  });

  it("copies the whole result including stderr and duration", async () => {
    await render(
      <CommandResultPanel
        result={result({
          raw: { command_executed: "ls", stdout: "a", stderr: "boom", duration_ms: 7 },
        })}
      />,
    );
    await rightClick('[data-testid="result-panel"]');
    await clickItem("Copy full result");

    expect(clipboard.text).toBe("Command: ls\nDuration: 7 ms\na\n\nstderr:\nboom");
  });

  it("switches to the raw view from the menu", async () => {
    await render(<CommandResultPanel result={result()} />);
    expect(panel().textContent).toContain("/dev/sda1");

    await rightClick('[data-testid="result-panel"]');
    await clickItem("Raw output");

    expect(panel().textContent).toContain("Filesystem Size");
  });

  it("hides 结构化视图 when the output has no structured rendering", async () => {
    // A "text" view (recognized short plain output) has nothing structured to
    // switch to — the header hides the button, the menu must disable it.
    await render(
      <CommandResultPanel
        result={result({
          // Runtime sends the full protocol payload (with view/meta/raw); the
          // declared `CommandStructuredOutput` type is narrower, hence the cast.
          structured: {
            view: "text",
            title: "磁盘占用",
            summary: [],
            columns: [],
            rows: [],
            sections: [],
            warnings: [],
            meta: { command: "uptime", exit_code: 0, duration_ms: 5, truncated: false },
            raw: { stdout: " 14:00:01 up 3 days", stderr: "" },
          } as unknown as CommandExecutionResult["structured"],
        })}
      />,
    );
    await rightClick('[data-testid="result-panel"]');

    const structuredItem = menuItems().find((item) => item.textContent?.trim() === "Structured view");
    // Offering it would be a menu entry that silently does nothing.
    expect(structuredItem?.hasAttribute("disabled")).toBe(true);
  });

  it("never disables 原始输出 — raw is always kept", async () => {
    await render(<CommandResultPanel result={result()} />);
    await rightClick('[data-testid="result-panel"]');

    const raw = menuItems().find((item) => item.textContent?.trim() === "Raw output");
    expect(raw?.hasAttribute("disabled")).toBe(false);
  });
});
