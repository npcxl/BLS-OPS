import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * 首页回归：
 * - 服务器行右键菜单（收藏 / 编辑 / 复制 / 删除）与旧首页一致；
 * - 挂载时只读本地数据，绝不自动建 SSH / 数据库连接；
 * - 概览数字与资产区来自真实 Store / 本地命令，不是写死的。
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
import { useSessionStore } from "@/stores/session-store";
import { useDatabaseStore } from "@/stores/database-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { ServerRecord } from "@/api/types/servers";
import type { DatabaseProfile } from "@/api/types/database";
import { WorkbenchHome } from "../home/WorkbenchHome";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let holder: HTMLDivElement;
let root: Root;
let servers: ServerRecord[];
let profiles: DatabaseProfile[];
let confirmed: Record<string, unknown[]>;

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
    environment: "unspecified",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function profile(id: string, overrides: Partial<DatabaseProfile> = {}): DatabaseProfile {
  return {
    id,
    name: id,
    engine: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    default_database: null,
    has_password: false,
    ssh_server_id: null,
    tls_mode: "disabled",
    tls_ca_path: null,
    tls_server_name: null,
    read_only: false,
    redis_mode: null,
    sentinel_master: null,
    nodes_json: null,
    connect_timeout_ms: 10_000,
    query_timeout_ms: 60_000,
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
  await flush();
}

const menuItems = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
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

async function switchAssetTab(label: string) {
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="radio"]')).find((entry) =>
    entry.textContent?.trim().startsWith(label),
  );
  if (!option) throw new Error(`asset tab not found: ${label}`);
  await act(async () => {
    option.click();
  });
  await flush();
}

beforeEach(() => {
  clipboard.text = "";
  servers = [server("web-01", { favorite: true })];
  profiles = [];
  confirmed = {};
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
      case "db_profile_list":
        return profiles.map((item) => ({ ...item }));
      case "db_profile_status":
        return {
          profile_id: args.profileId,
          generation: 0,
          connected: false,
          tunnel_active: false,
          tunnel_local_port: null,
          open_sessions: 0,
          active_queries: 0,
          server_version: null,
        };
      case "confirmed_projects_list":
        return confirmed[String(args.serverId)] ?? [];
      case "server_set_favorite": {
        const found = servers.find((item) => item.id === args.id)!;
        found.favorite = args.favorite as boolean;
        return { ...found };
      }
      default:
        return null;
    }
  });

  // WorkbenchHome reads the stores directly (App.tsx normally refreshes them),
  // so the test seeds the same shape a loaded app would have.
  act(() => {
    useDomainStore.setState({ servers: [...servers], sessions: [], credentials: [], groups: [] });
    useSessionStore.setState({ sessions: {}, challenge: null });
    useDatabaseStore.setState({
      profiles: [],
      sessions: {},
      statuses: {},
      sessionErrors: {},
      loadingProfiles: false,
      profileError: null,
    });
    useWorkbenchStore.setState({ focusedPaneId: null });
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
      "Open terminal",
      "Unfavorite",
      "Edit server",
      "Copy connection address",
      "Delete server",
    ]);
  });

  it("opens the server form from Edit server", async () => {
    await render();
    await rightClick(card());
    await clickItem("Edit server");

    expect(document.body.textContent).toContain("Edit server — web-01");
  });

  it("copies the connection address", async () => {
    await render();
    await rightClick(card());
    await clickItem("Copy connection address");

    expect(clipboard.text).toBe("root@web-01.local:22");
  });

  it("asks for confirmation before deleting", async () => {
    await render();
    await rightClick(card());
    await clickItem("Delete server");

    // Destructive actions always go through ConfirmDialog.
    expect(document.body.textContent).toContain(
      'Deleting "web-01" will also delete its sessions and command history. This action cannot be undone.',
    );
  });

  it("toggles the favorite through the menu", async () => {
    await render();
    await rightClick(card());
    await clickItem("Unfavorite");

    expect(useDomainStore.getState().servers[0].favorite).toBe(false);
  });
});

describe("WorkbenchHome 数据来源", () => {
  it("挂载时只读本地状态，不自动建立任何连接", async () => {
    profiles = [profile("db-01")];
    await render();

    const commands = invoke.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).not.toContain("db_connect");
    expect(commands).not.toContain("db_redis_connect");
    expect(commands).not.toContain("ssh_connect");
    expect(commands).not.toContain("ssh_connect_monitor");
  });

  it("概览的服务器数来自 Store，实时会话数来自会话注册表", async () => {
    act(() => {
      useSessionStore.setState({
        sessions: {
          "s-1": { sessionId: "s-1", tabId: "t-1", title: "web-01", status: "connected" },
          "s-2": { sessionId: "s-2", tabId: "t-2", title: "web-02", status: "error", error: "auth" },
        },
      });
    });

    await render();

    const serversCard = document.body.querySelector('[data-testid="home-stat-servers"]');
    const sessionsCard = document.body.querySelector('[data-testid="home-stat-sessions"]');
    expect(serversCard?.textContent).toContain("1");
    expect(sessionsCard?.textContent).toContain("1");
    expect(sessionsCard?.textContent).toContain("1 sessions failed");
  });

  it("数据库资产来自连接配置，点击打开既有的数据库标签", async () => {
    profiles = [profile("db-01", { name: "订单库" })];
    await render();
    await switchAssetTab("Database");

    const row = document.body.querySelector<HTMLElement>('[data-testid="home-database-row-db-01"]');
    expect(row?.textContent).toContain("订单库");

    await act(async () => {
      row?.querySelector("button")?.click();
    });

    const tabs = useWorkbenchStore.getState().rootPane.tabs;
    expect(tabs.some((tab) => tab.type === "database" && tab.profileId === "db-01")).toBe(true);
  });

  it("项目资产来自已确认项目，点击进入对应服务器的项目标签", async () => {
    confirmed = {
      "web-01": [
        {
          id: "cp-1",
          server_id: "web-01",
          canonical_path: "/srv/shop",
          name: "shop",
          project_type: "node",
          candidate_payload: "{}",
          scan_state: "missing",
          confirmed_at: 1000,
          updated_at: 1000,
          last_seen_at: 1000,
          missing_since: 2000,
        },
      ],
    };
    await render();
    await switchAssetTab("Projects");

    const row = document.body.querySelector<HTMLElement>('[data-testid^="home-project-row-"]');
    expect(row?.textContent).toContain("shop");
    expect(row?.textContent).toContain("/srv/shop");
    // 扫描结论要如实显示，不能把"本次没找到"画成正常。
    expect(row?.textContent).toContain("Not found this scan");

    await act(async () => {
      row?.click();
    });

    const tabs = useWorkbenchStore.getState().rootPane.tabs;
    expect(tabs.some((tab) => tab.type === "project" && tab.serverId === "web-01")).toBe(true);
  });

  it("没有查询历史时不给最近数据库编造记录", async () => {
    profiles = [profile("db-01", { name: "订单库" })];
    await render();

    expect(document.body.textContent).toContain(
      "No query history yet. Queries appear here after you run one.",
    );
  });
});
