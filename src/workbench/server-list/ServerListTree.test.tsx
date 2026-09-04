import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";

/**
 * These drive the real store + API layer against an in-memory backend, so a
 * regression in the wiring (wrong command name, wrong payload key, missing
 * refresh) fails here rather than in the running app.
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { useDomainStore } from "@/stores/domain-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkbenchPane } from "@/workbench/types";
import type { ServerGroupRecord, ServerRecord } from "@/api/types/servers";
import { ServerListTree } from "./ServerListTree";
import { ModuleServerSidebar } from "@/workbench/module-server-sidebar";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// -- fixtures ---------------------------------------------------------------

let servers: ServerRecord[];
let groups: ServerGroupRecord[];

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

function group(id: string, name: string, sort_order = 0): ServerGroupRecord {
  return { id, name, sort_order, created_at: 0, updated_at: 0 };
}

/** Stand-in for the Rust commands, including their validation and side effects. */
function installBackend() {
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "server_list":
        return servers.map((item) => ({ ...item }));
      case "group_list":
        return groups.map((item) => ({ ...item }));
      case "server_set_favorite": {
        const found = servers.find((item) => item.id === args.id);
        if (!found) throw new Error("服务器不存在");
        found.favorite = args.favorite as boolean;
        return { ...found };
      }
      case "server_move_to_group": {
        const found = servers.find((item) => item.id === args.id);
        if (!found) throw new Error("服务器不存在");
        const groupId = (args.groupId as string | null) ?? null;
        if (groupId && !groups.some((item) => item.id === groupId)) {
          throw new Error("所选分组不存在");
        }
        found.group_id = groupId;
        return { ...found };
      }
      case "group_save": {
        const draft = args.group as ServerGroupRecord;
        const name = String(draft.name).trim();
        if (!name) throw new Error("分组名称不能为空");
        if (groups.some((item) => item.id !== draft.id && item.name === name)) {
          throw new Error(`已存在同名分组“${name}”`);
        }
        const index = groups.findIndex((item) => item.id === draft.id);
        if (index >= 0) groups[index] = { ...groups[index], name };
        else groups.push({ ...draft, name });
        return groups.find((item) => item.id === draft.id);
      }
      case "group_delete": {
        for (const item of servers) if (item.group_id === args.id) item.group_id = null;
        groups = groups.filter((item) => item.id !== args.id);
        return undefined;
      }
      case "server_delete": {
        servers = servers.filter((item) => item.id !== args.id);
        return { sessions: 0, history: 0 };
      }
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  });
}

// -- rendering --------------------------------------------------------------

let holder: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(ui: ReactNode) {
  await act(async () => {
    root.render(ui);
  });
  await flush();
}

function find(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`not found: ${selector}`);
  return el;
}

function maybe(selector: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(selector);
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("click target missing");
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

/** Sets a controlled input's value the way the browser would. */
async function type(selector: string, value: string) {
  const input = find(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

const menuEls = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menu"]'));
const menuItems = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));

function itemByLabel(menu: HTMLElement, label: string): HTMLElement {
  const found = menuItems(menu).find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`menu item not found: ${label}`);
  return found;
}

async function rightClick(selector: string) {
  const target = find(selector);
  await act(async () => {
    target.dispatchEvent(
      new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent("pointerdown", {
        bubbles: true,
        button: 2,
        clientX: 20,
        clientY: 20,
      }),
    );
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    );
  });
  await flush();
}

/** Section id → the server rows rendered inside it, in DOM order. */
function rowsIn(sectionId: string): string[] {
  const section = find(`[data-testid="group-section-${sectionId}"]`);
  return Array.from(section.querySelectorAll<HTMLElement>('[data-testid^="server-row-"]')).map(
    (row) => row.dataset.testid!.replace("server-row-", ""),
  );
}

const storedServer = (id: string) => useDomainStore.getState().servers.find((s) => s.id === id);

/** The focused leaf pane — where `openModuleTabForServer` puts its tab. */
function findActiveLeaf(pane: WorkbenchPane): WorkbenchPane {
  if (!pane.children || pane.children.length === 0) return pane;
  for (const child of pane.children) {
    const found = findActiveLeaf(child);
    if (found.tabs.some((tab) => tab.id === found.activeTabId)) return found;
  }
  return pane.children[0];
}

beforeEach(() => {
  servers = [];
  groups = [];
  installBackend();
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  holder = document.createElement("div");
  document.body.appendChild(holder);
  root = createRoot(holder);
});

afterEach(() => {
  act(() => root.unmount());
  holder.remove();
  invoke.mockReset();
});

// -- tests ------------------------------------------------------------------

describe("ServerListTree — 收藏", () => {
  it("shows a filled star for a favorited server and an outlined one otherwise", async () => {
    servers = [server("s1", { favorite: true }), server("s2")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    const fav = find('[data-testid="server-favorite-s1"] svg');
    const plain = find('[data-testid="server-favorite-s2"] svg');
    expect(fav.getAttribute("fill")).toBe("currentColor");
    expect(plain.getAttribute("fill")).toBe("none");
    expect(find('[data-testid="server-favorite-s1"]').getAttribute("aria-pressed")).toBe("true");
  });

  it("toggling the star never opens the server", async () => {
    servers = [server("s1")];
    const onOpenServer = vi.fn();
    await render(<ServerListTree title="服务器列表" onOpenServer={onOpenServer} />);

    await click(maybe('[data-testid="server-favorite-s1"]'));

    expect(onOpenServer).not.toHaveBeenCalled();
    expect(storedServer("s1")?.favorite).toBe(true);

    // Sanity: clicking the row itself still opens it.
    await click(maybe('[data-testid="server-open-s1"]'));
    expect(onOpenServer).toHaveBeenCalledTimes(1);
  });

  it("drops the 收藏 area as soon as the last favorite is removed", async () => {
    servers = [server("s1", { favorite: true }), server("s2")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    expect(maybe('[data-testid="favorites-section"]')).not.toBeNull();

    await click(maybe('[data-testid="server-favorite-s1"]'));

    expect(maybe('[data-testid="favorites-section"]')).toBeNull();
    // The server itself stays where it was — 收藏 is only a shortcut.
    expect(maybe('[data-testid="server-row-s1"]')).not.toBeNull();
  });

  it("keeps favorited servers inside their own group as well", async () => {
    servers = [server("s1", { group_id: "g1", favorite: true })];
    groups = [group("g1", "生产环境")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    expect(rowsIn("g1")).toEqual(["s1"]);
    expect(rowsIn("__ungrouped__")).toEqual([]);
  });

  it("rolls the star back and reports the error when the backend refuses", async () => {
    servers = [server("s1")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_list") return servers.map((item) => ({ ...item }));
      if (cmd === "group_list") return groups.map((item) => ({ ...item }));
      throw new Error("服务器不存在");
    });

    await click(maybe('[data-testid="server-favorite-s1"]'));

    expect(storedServer("s1")?.favorite).toBe(false);
    expect(find('[data-testid="server-list-error"]').textContent).toContain("服务器不存在");
  });
});

describe("ServerListTree — 分组", () => {
  it("renders an empty group with its 暂无服务器 placeholder", async () => {
    servers = [server("s1")];
    groups = [group("g1", "生产环境")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    const section = find('[data-testid="group-section-g1"]');
    expect(section.textContent).toContain("生产环境");
    expect(section.textContent).toContain("暂无服务器");
    expect(find('[data-testid="group-count-g1"]').textContent).toBe("0");
  });

  it("shows a newly created group immediately, before any server uses it", async () => {
    servers = [server("s1")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    await click(maybe('[aria-label="新增分组"]'));
    await type('[data-testid="new-group-input"]', "生产环境");
    await click(maybe('[data-testid="new-group-save"]'));

    expect(groups.map((item) => item.name)).toEqual(["生产环境"]);
    const created = groups[0];
    expect(maybe(`[data-testid="group-section-${created.id}"]`)).not.toBeNull();
    expect(maybe('[data-testid="new-group-input"]')).toBeNull();
  });

  it("keeps the editor open and shows the error when saving a group fails", async () => {
    servers = [server("s1")];
    groups = [group("g1", "生产环境")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    await click(maybe('[aria-label="新增分组"]'));
    await type('[data-testid="new-group-input"]', "生产环境");
    await click(maybe('[data-testid="new-group-save"]'));

    expect(find('[data-testid="server-list-error"]').textContent).toContain("已存在同名分组");
    // Still open, with the typed name intact, so the user can fix it.
    expect((find('[data-testid="new-group-input"]') as HTMLInputElement).value).toBe("生产环境");
  });

  it("moves a server into a group from the context menu", async () => {
    servers = [server("s1")];
    groups = [group("g1", "生产环境"), group("g2", "测试环境")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    expect(rowsIn("__ungrouped__")).toEqual(["s1"]);

    await rightClick('[data-testid="server-row-s1"]');
    const root1 = menuEls()[0];
    await click(itemByLabel(root1, "移动到分组"));
    const submenu = menuEls()[1];
    expect(submenu).toBeDefined();
    await click(itemByLabel(submenu, "测试环境"));

    expect(storedServer("s1")?.group_id).toBe("g2");
    expect(rowsIn("g2")).toEqual(["s1"]);
    expect(rowsIn("__ungrouped__")).toEqual([]);
  });

  it("moves a server back to 未分组", async () => {
    servers = [server("s1", { group_id: "g1" })];
    groups = [group("g1", "生产环境")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    await rightClick('[data-testid="server-row-s1"]');
    await click(itemByLabel(menuEls()[0], "移动到分组"));
    await click(itemByLabel(menuEls()[1], "未分组"));

    expect(storedServer("s1")?.group_id).toBeNull();
    expect(rowsIn("__ungrouped__")).toEqual(["s1"]);
  });

  it("returns servers to 未分组 when their group is deleted", async () => {
    servers = [server("s1", { group_id: "g1" })];
    groups = [group("g1", "生产环境")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    await click(maybe('[aria-label="删除分组 生产环境"]'));
    // Destructive actions go through ConfirmDialog, never window.confirm.
    const confirm = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "确认删除",
    );
    await click(confirm);

    expect(groups).toHaveLength(0);
    expect(storedServer("s1")?.group_id).toBeNull();
    expect(maybe('[data-testid="group-section-g1"]')).toBeNull();
    expect(rowsIn("__ungrouped__")).toEqual(["s1"]);
  });

  it("sorts favorites to the top inside a group", async () => {
    servers = [
      server("zeta", { group_id: "g1" }),
      server("alpha", { group_id: "g1", favorite: true }),
    ];
    groups = [group("g1", "生产环境")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    expect(rowsIn("g1")).toEqual(["alpha", "zeta"]);
  });

  it("right-clicking blank space offers the header actions", async () => {
    servers = [server("s1")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    // The row has its own menu; blank space must give the *list* actions.
    await rightClick('[data-testid="group-section-__ungrouped__"]');
    const labels = menuItems(menuEls()[0]).map((item) => item.textContent?.trim());
    expect(labels).toEqual(["刷新服务器", "新增服务器", "新增分组", "收起侧边栏"]);
  });

  it("整列可右键：根容器（min-h-full 撑满滚动区）空白同样给出列表动作", async () => {
    servers = [server("s1")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    await rightClick('[data-testid="server-list-tree"]');
    const labels = menuItems(menuEls()[0]).map((item) => item.textContent?.trim());
    expect(labels).toEqual(["刷新服务器", "新增服务器", "新增分组", "收起侧边栏"]);
  });

  it("a row's own menu wins over the blank-space one", async () => {
    servers = [server("s1")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    await rightClick('[data-testid="server-row-s1"]');
    const labels = menuItems(menuEls()[0]).map((item) => item.textContent?.trim());
    expect(labels).toContain("打开终端");
    expect(labels).not.toContain("新增分组");
  });

  it("行菜单打开后再在空白处右键：旧菜单被顶掉，全局只剩一个", async () => {
    servers = [server("s1")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    await rightClick('[data-testid="server-row-s1"]');
    expect(menuEls()).toHaveLength(1);

    // 空白区右键打开背景菜单（刷新/新增…），行菜单必须随之关闭。
    await rightClick('[data-testid="server-list-tree"]');
    expect(menuEls()).toHaveLength(1);
    const labels = menuItems(menuEls()[0]).map((item) => item.textContent?.trim());
    expect(labels).toEqual(["刷新服务器", "新增服务器", "新增分组", "收起侧边栏"]);
  });

  it("runs the header action chosen from the blank-space menu", async () => {
    servers = [server("s1")];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    await rightClick('[data-testid="group-section-__ungrouped__"]');
    await click(itemByLabel(menuEls()[0], "新增分组"));

    expect(maybe('[data-testid="new-group-input"]')).not.toBeNull();
  });

  it("warns about a server pointing at a group that no longer exists", async () => {
    servers = [server("s1", { group_id: "ghost" })];
    await render(<ServerListTree title="服务器列表" onOpenServer={() => undefined} />);

    expect(document.body.textContent).toContain("ghost");
    expect(rowsIn("__ungrouped__")).toEqual(["s1"]);
  });
});

describe("侧栏行为一致", () => {
  const cases = [
    { module: "projects" as const, title: "项目" },
    { module: "services" as const, title: "服务" },
    { module: "logs" as const, title: "日志" },
  ];

  for (const { module, title } of cases) {
    it(`${title}侧栏渲染同一套分组与收藏`, async () => {
      servers = [
        server("zeta", { group_id: "g1" }),
        server("alpha", { group_id: "g1", favorite: true }),
        server("solo"),
      ];
      groups = [group("g1", "生产环境"), group("g2", "测试环境")];

      await render(<ModuleServerSidebar module={module} />);

      expect(document.body.textContent).toContain(title);
      // Same ordering rules, same empty-group rendering, same favorites area.
      expect(rowsIn("g1")).toEqual(["alpha", "zeta"]);
      expect(find('[data-testid="group-section-g2"]').textContent).toContain("暂无服务器");
      expect(maybe('[data-testid="favorites-section"]')).not.toBeNull();
      expect(rowsIn("__ungrouped__")).toEqual(["solo"]);
    });
  }

  it("opens the module's own tab when a row is clicked", async () => {
    servers = [server("s1", { group_id: "g1" })];
    groups = [group("g1", "生产环境")];

    await render(<ModuleServerSidebar module="logs" />);
    await click(maybe('[data-testid="server-open-s1"]'));

    const leaf = findActiveLeaf(useWorkbenchStore.getState().rootPane);
    const active = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
    expect(active?.serverId).toBe("s1");
    expect(active?.type).toBe("logs");
  });
});
