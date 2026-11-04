import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";
import { WorkItemRail } from "../WorkItemRail";

/**
 * 右侧的「已打开的标签」列表（顶部标签条之外的第二种展示）：
 * - 只列当前连接的工作项；
 * - 单击切到那一项；
 * - 行尾 × 走 `onRequestClose`（事务与运行中查询由 DatabaseView 收尾，不能自己关）。
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
  makeItem({ id: "b", kind: "query", objectName: "查询 1", title: "查询 1", order: 1 }),
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

const rows = () => Array.from(holder.querySelectorAll<HTMLElement>('[role="option"]'));

beforeEach(() => {
  useDatabaseWorkspaceStore.setState({ items: ITEMS, activeId: "a" });
  holder = document.createElement("div");
  document.body.appendChild(holder);
  root = createRoot(holder);
});

afterEach(() => {
  act(() => root.unmount());
  holder.remove();
  useDatabaseWorkspaceStore.setState({ items: [], activeId: null });
});

describe("WorkItemRail", () => {
  it("只列当前连接的标签，单击切换当前项", () => {
    act(() => {
      root.render(
        <WorkItemRail
          profileId="p1"
          onNewQuery={() => undefined}
          onRequestClose={() => undefined}
          onRequestCloseOthers={() => undefined}
          onRequestCloseRight={() => undefined}
        />,
      );
    });

    expect(rows()).toHaveLength(2);
    expect(rows().some((row) => row.textContent?.includes("users"))).toBe(false);

    act(() => rows()[1]!.click());
    expect(useDatabaseWorkspaceStore.getState().activeId).toBe("b");
  });

  it("行尾 × 交给 onRequestClose，不自己关标签", () => {
    const onRequestClose = vi.fn();
    act(() => {
      root.render(
        <WorkItemRail
          profileId="p1"
          onNewQuery={() => undefined}
          onRequestClose={onRequestClose}
          onRequestCloseOthers={() => undefined}
          onRequestCloseRight={() => undefined}
        />,
      );
    });

    const close = rows()[0]!.querySelector<HTMLElement>('button[aria-label="关闭标签"]')!;
    act(() => close.click());

    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(onRequestClose.mock.calls[0]?.[0]?.id).toBe("a");
    expect(useDatabaseWorkspaceStore.getState().items).toHaveLength(3);
  });
});
