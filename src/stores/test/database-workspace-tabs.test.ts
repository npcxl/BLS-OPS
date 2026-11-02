import { beforeEach, describe, expect, it } from "vitest";
import {
  orderedItems,
  useDatabaseWorkspaceStore,
} from "../database-workspace-store";

/**
 * 顶部标签条的三条规则，单独用纯 store 测试锁住（不依赖 DOM）：
 * 1. 同一连接只有一个预览标签，下一次单击替换它；
 * 2. 已经开始干活（有草稿/待提交）的预览标签不被替换，自动升级为常驻；
 * 3. 拖动排序只改顺序，不丢标签、不跨连接。
 */

const OPEN = {
  profileId: "p1",
  connectionName: "本机",
  database: "shop",
};

describe("database workspace tabs", () => {
  beforeEach(() => {
    useDatabaseWorkspaceStore.setState({
      items: [],
      activeId: null,
      savedQueries: [],
    });
  });

  it("同一连接只保留一个预览标签", () => {
    const store = useDatabaseWorkspaceStore.getState();
    store.openTable({ ...OPEN, table: "orders", preview: true });
    store.openTable({ ...OPEN, table: "users", preview: true });

    const items = useDatabaseWorkspaceStore.getState().items;
    expect(items.map((item) => item.objectName)).toEqual(["users"]);
    expect(items[0].preview).toBe(true);
  });

  it("有未提交修改的预览标签不会被替换，而是升级为常驻", () => {
    const store = useDatabaseWorkspaceStore.getState();
    const ordersId = store.openTable({ ...OPEN, table: "orders", preview: true });
    useDatabaseWorkspaceStore.getState().setStatus(ordersId, { pendingCount: 2 });

    useDatabaseWorkspaceStore.getState().openTable({ ...OPEN, table: "users", preview: true });

    const items = useDatabaseWorkspaceStore.getState().items;
    expect(items).toHaveLength(2);
    const orders = items.find((item) => item.objectName === "orders");
    expect(orders?.preview).toBe(false);
    expect(items.find((item) => item.objectName === "users")?.preview).toBe(true);
  });

  it("再次明确打开同一张表会把它从预览升级为常驻", () => {
    const store = useDatabaseWorkspaceStore.getState();
    const id = store.openTable({ ...OPEN, table: "orders", preview: true });
    useDatabaseWorkspaceStore.getState().openTable({ ...OPEN, table: "orders" });

    const item = useDatabaseWorkspaceStore.getState().items.find((entry) => entry.id === id);
    expect(item?.preview).toBe(false);
  });

  it("拖动排序改变顺序，固定项仍然置顶", () => {
    const store = useDatabaseWorkspaceStore.getState();
    store.openTable({ ...OPEN, table: "a" });
    store.openTable({ ...OPEN, table: "b" });
    store.openTable({ ...OPEN, table: "c" });
    useDatabaseWorkspaceStore.getState().togglePin(
      useDatabaseWorkspaceStore.getState().items.find((item) => item.objectName === "b")!.id,
    );

    const items = useDatabaseWorkspaceStore.getState().items;
    const a = items.find((item) => item.objectName === "a")!;
    const c = items.find((item) => item.objectName === "c")!;
    useDatabaseWorkspaceStore.getState().reorder(c.id, a.id);

    const ordered = orderedItems(useDatabaseWorkspaceStore.getState().items);
    expect(ordered.map((item) => item.objectName)).toEqual(["b", "c", "a"]);
  });

  it("关闭当前标签后落到相邻标签，而不是列表末尾", () => {
    const store = useDatabaseWorkspaceStore.getState();
    store.openTable({ ...OPEN, table: "a" });
    const b = store.openTable({ ...OPEN, table: "b" });
    useDatabaseWorkspaceStore.getState().openTable({ ...OPEN, table: "c" });
    useDatabaseWorkspaceStore.getState().setActive(b);

    useDatabaseWorkspaceStore.getState().close(b);

    const state = useDatabaseWorkspaceStore.getState();
    expect(state.activeId).not.toBe(b);
    expect(
      state.items.find((item) => item.id === state.activeId)?.objectName,
    ).toBe("c");
  });
});
