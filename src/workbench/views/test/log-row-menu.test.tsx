import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The log table is a dense grid where the useful next step (filter to this
 * unit, copy this line) was keyboard-free: you had to retype the unit into the
 * toolbar. These pin the row menu to the toolbar controls that already exist.
 *
 * Only the menu wiring is exercised, so the view is rendered directly rather
 * than going through a live SSH session.
 */
const clipboard = { text: "" };
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (text: string) => void (clipboard.text = text) },
  configurable: true,
});

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// The session hook subscribes to the transport-closed event; nothing closes
// during these tests, so the listener can be a permanent no-op.
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => undefined,
}));

import { LogCenterView } from "../LogCenterView";
import type { WorkspaceTab } from "@/workbench/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let holder: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<LogCenterView tab={TAB} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const ALL = [
  { timestamp: "2026-09-04T01:02:03Z", priority: 3, unit: "nginx.service", message: "boom" },
  { timestamp: "2026-09-04T01:02:04Z", priority: 6, unit: "sshd.service", message: "accepted" },
];

const TAB = {
  id: "tab-1",
  type: "logs",
  title: "web-01",
  subtitle: "10.0.0.5:22",
  serverId: "srv-1",
  sessionId: "sess-1",
} as unknown as WorkspaceTab;

const menuItems = () =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));

const labels = () =>
  menuItems().map(
    (item) => item.querySelector("span.truncate")?.textContent?.trim() ?? item.textContent?.trim(),
  );

const rows = () => Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="log-row"]'));

async function rightClick(el: HTMLElement, x = 20, y = 20) {
  await act(async () => {
    el.dispatchEvent(
      new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent("pointerdown", {
        bubbles: true,
        button: 2,
        clientX: x,
        clientY: y,
      }),
    );
    el.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  });
}

async function clickItem(startsWith: string) {
  const item = menuItems().find((entry) => entry.textContent?.trim().startsWith(startsWith));
  if (!item) throw new Error(`menu item not found: ${startsWith}`);
  await act(async () => {
    item.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function json(payload: unknown) {
  return JSON.stringify(payload);
}

beforeEach(() => {
  clipboard.text = "";
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });

  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "ssh_connect_monitor") {
      return { status: "connected", host: "10.0.0.5", port: 22, fingerprint_type: "ed25519", fingerprint: "SHA256:abc" };
    }
    if (cmd === "ssh_disconnect") return undefined;
    if (cmd === "session_list") return [];
    if (cmd === "journal_query") {
      // The priority filter runs on the server (`journalctl -u/-p`), so the
      // stub applies it too — otherwise filtering would look like a no-op.
      const lastCall = invoke.mock.calls[invoke.mock.calls.length - 1] ?? [];
      const args = (lastCall[1] ?? {}) as { unit?: string | null };
      return ALL.filter((entry) => !args.unit || entry.unit === args.unit);
    }
    if (cmd === "journal_disk_usage") return { raw: "12M" };
    return json(null);
  });

  holder = document.createElement("div");
  document.body.appendChild(holder);
  root = createRoot(holder);
});

afterEach(() => {
  act(() => root.unmount());
  holder.remove();
  invoke.mockReset();
});

describe("LogCenterView 行右键菜单", () => {
  it("offers copy and the toolbar filters on a row", async () => {
    await render();
    expect(rows()).toHaveLength(2);

    await rightClick(rows()[0]);

    expect(labels()).toEqual([
      "复制该行",
      "复制全部（2 条）",
      "只看「错误」及以上",
      "只看单元 nginx.service",
      "在结果中搜索该消息",
      "清除筛选",
    ]);
  });

  it("copies the row exactly as the table shows it", async () => {
    await render();
    await rightClick(rows()[0]);
    await clickItem("复制该行");

    expect(clipboard.text).toBe("2026-09-04T01:02:03Z  错误  nginx.service  boom");
  });

  it("copies every visible row", async () => {
    await render();
    await rightClick(rows()[0]);
    await clickItem("复制全部");

    expect(clipboard.text.split("\n")).toHaveLength(2);
    expect(clipboard.text).toContain("accepted");
  });

  it("filters to the row's unit by reusing the toolbar's unit field", async () => {
    await render();
    await rightClick(rows()[0]);
    await clickItem("只看单元 nginx.service");

    // The unit filter is the toolbar's own input, so the row count follows it.
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("boom");
  });

  it("marks the filter the row already has as 当前 and disables it", async () => {
    await render();
    // Filter everything down to nginx first…
    await rightClick(rows()[0]);
    await clickItem("只看单元 nginx.service");

    // …then right-click the surviving row: its own filter is now active.
    await rightClick(rows()[0]);
    const item = menuItems().find((entry) => entry.textContent?.includes("只看单元"));
    expect(item?.hasAttribute("disabled")).toBe(true);
    expect(item?.textContent).toContain("当前");
  });

  it("clears every filter in one go", async () => {
    await render();
    await rightClick(rows()[0]);
    await clickItem("只看单元 nginx.service");
    expect(rows()).toHaveLength(1);

    await rightClick(rows()[0]);
    await clickItem("清除筛选");
    expect(rows()).toHaveLength(2);
  });
});
