import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The home card only shows two hover icons (收藏 / 删除), so 编辑 and 复制连接
 * 地址 were unreachable from it. These pin the card's right-click menu — and
 * that it stays consistent with the server list's own row menu.
 */
const clipboard = { text: "" };
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (text: string) => void (clipboard.text = text) },
  configurable: true,
});

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));

import { useDomainStore } from "@/stores/domain-store";
import type { ServerRecord } from "@/api/types/servers";
import { WorkbenchHome } from "./WorkbenchHome";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let holder: HTMLDivElement;
let root: Root;
let servers: ServerRecord[];

function server(id: string, overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id,
    name: id,
    host: `${id}.local`,
    port: 22,
    username: "root",
    credential_id: null,
    group_id: null,
    tags: [],
    proxy_jump_id: null,
    favorite: false,
    last_connected_at: null,
    status: "idle",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  await act(async () => {
    root.render(<WorkbenchHome />);
  });
  await flush();
}

const menuItems = () =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
const labels = () =>
  menuItems().map(
    (item) => item.querySelector("span.truncate")?.textContent?.trim() ?? item.textContent?.trim(),
  );

const card = () => document.body.querySelector<HTMLElement>('[data-testid="home-server-row-web-01"]')!;

async function rightClick(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(
      new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent("pointerdown", {
        bubbles: true,
        button: 2,
        clientX: 20,
        clientY: 20,
      }),
    );
    el.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    );
  });
}

async function clickItem(label: string) {
  const item = menuItems().find((entry) => entry.textContent?.trim() === label);
  if (!item) throw new Error(`menu item not found: ${label}`);
  await act(async () => {
    item.click();
  });
  await flush();
}

beforeEach(() => {
  clipboard.text = "";
  servers = [server("web-01", { favorite: true })];
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });

  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "server_list":
        return servers.map((item) => ({ ...item }));
      case "group_list":
        return [];
      case "credential_list":
        return [];
      case "session_list":
        return [];
      case "server_set_favorite": {
        const found = servers.find((item) => item.id === args.id)!;
        found.favorite = args.favorite as boolean;
        return { ...found };
      }
      default:
        return null;
    }
  });

  // WorkbenchHome reads the store directly (App.tsx normally refreshes it), so
  // the test seeds the same shape a loaded app would have.
  act(() => {
    useDomainStore.setState({ servers: [...servers], sessions: [], credentials: [] });
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

describe("WorkbenchHome 服务器卡片右键菜单", () => {
  it("offers the actions the two hover icons cannot hold", async () => {
    await render();
    await rightClick(card());

    expect(labels()).toEqual([
      "打开终端",
      "取消收藏",
      "编辑服务器",
      "复制连接地址",
      "删除服务器",
    ]);
  });

  it("opens the server form from 编辑服务器", async () => {
    await render();
    await rightClick(card());
    await clickItem("编辑服务器");

    expect(document.body.textContent).toContain("编辑服务器 — web-01");
  });

  it("copies the connection address", async () => {
    await render();
    await rightClick(card());
    await clickItem("复制连接地址");

    expect(clipboard.text).toBe("root@web-01.local:22");
  });

  it("asks for confirmation before deleting", async () => {
    await render();
    await rightClick(card());
    await clickItem("删除服务器");

    // Destructive actions always go through ConfirmDialog.
    expect(document.body.textContent).toContain("删除“web-01”会同时删除它的会话与命令历史");
  });

  it("toggles the favorite through the menu", async () => {
    await render();
    await rightClick(card());
    await clickItem("取消收藏");

    expect(useDomainStore.getState().servers[0].favorite).toBe(false);
  });
});
