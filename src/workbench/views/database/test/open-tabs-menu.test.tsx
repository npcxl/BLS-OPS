import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";
import { OpenTabsMenu } from "../OpenTabsMenu";

/**
 * 标签条右侧「已打开的标签」浮窗：
 * - 只列当前连接的标签（别的连接属于它们自己的标签条）；
 * - 搜索按标题 / 表名 / 库名过滤；
 * - 点击、↑↓ + Enter 都能切到对应标签并收起；
 * - Esc 关闭；底部仍能新建查询。
 */

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makeItem(over: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    kind: "table",
    profileId: "p1",
    connectionName: "生产库",
    database: "ops",
    objectName: over.id,
    title: over.id,
    pinned: false,
    preview: false,
    order: 0,
    createdAt: 0,
    pendingCount: 0,
    running: false,
    dirty: false,
    savedQueryId: null,
    ...over,
  };
}

const ITEMS: WorkItem[] = [
  makeItem({ id: "a", objectName: "orders", title: "orders", order: 0 }),
  makeItem({
    id: "b",
    kind: "query",
    objectName: "Slow query",
    title: "Slow query",
    database: "报表",
    order: 1,
    dirty: true,
  }),
  makeItem({
    id: "other",
    profileId: "p2",
    connectionName: "测试库",
    objectName: "users",
    title: "users",
    order: 2,
  }),
];

let holder: HTMLDivElement;
let root: Root;

const trigger = () => holder.querySelector<HTMLElement>('button[aria-haspopup="dialog"]');
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const options = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));
const searchInput = () =>
  document.body.querySelector<HTMLInputElement>('input[aria-label="搜索已打开的标签…"]');

function openPanel() {
  act(() => trigger()!.click());
}

/** React 19 的受控 input：必须先走原型上的 setter，否则 value 改了但 onChange 不触发。 */
function typeSearch(value: string) {
  const input = searchInput()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(target: EventTarget, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  useDatabaseWorkspaceStore.setState({ items: ITEMS, activeId: "a" });

  holder = document.createElement("div");
  document.body.appendChild(holder);
  root = createRoot(holder);
  act(() => {
    root.render(<OpenTabsMenu profileId="p1" onNewQuery={() => undefined} />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  holder.remove();
  useDatabaseWorkspaceStore.setState({ items: [], activeId: null });
});

describe("OpenTabsMenu", () => {
  it("只列出当前连接的标签，点击后切到那个标签并收起", () => {
    openPanel();

    expect(dialog()).not.toBeNull();
    expect(options().map((row) => row.textContent)).toHaveLength(2);
    expect(options()[0]?.textContent).toContain("orders");
    expect(options().some((row) => row.textContent?.includes("users"))).toBe(false);

    act(() => options()[1]!.click());

    expect(useDatabaseWorkspaceStore.getState().activeId).toBe("b");
    expect(dialog()).toBeNull();
  });

  it("搜索按标题 / 库名过滤，没命中时给空状态", () => {
    openPanel();

    typeSearch("slow");
    expect(options()).toHaveLength(1);
    expect(options()[0]?.textContent).toContain("Slow query");

    typeSearch("报表");
    expect(options()).toHaveLength(1);

    typeSearch("不存在的表");
    expect(options()).toHaveLength(0);
    expect(dialog()?.textContent).toContain("没有匹配的标签");
  });

  it("↑↓ + Enter 打开标签，Esc 关闭", () => {
    openPanel();

    pressKey(searchInput()!, "ArrowDown");
    pressKey(searchInput()!, "Enter");

    expect(useDatabaseWorkspaceStore.getState().activeId).toBe("b");
    expect(dialog()).toBeNull();

    openPanel();
    pressKey(window, "Escape");
    expect(dialog()).toBeNull();
  });

  it("底部仍然可以新建查询", () => {
    const onNewQuery = vi.fn();
    act(() => {
      root.render(<OpenTabsMenu profileId="p1" onNewQuery={onNewQuery} />);
    });
    openPanel();

    const create = Array.from(dialog()!.querySelectorAll<HTMLElement>("button")).find((button) =>
      button.textContent?.includes("新建查询"),
    )!;
    act(() => create.click());

    expect(onNewQuery).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });
});
