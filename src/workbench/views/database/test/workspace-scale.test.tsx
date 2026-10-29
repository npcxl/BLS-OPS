import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  orderedItems,
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";
import { OpenItemsPanel } from "../OpenItemsPanel";

/**
 * 规模回归：10 个连接 × 10 个工作项 = 100 项。
 *
 * 只验「能不能在预算内渲染/切换」，不做像素级断言。预算给得比真机宽，
 * 目的是拦住 O(n²) 退化、每次切换全量重建 DOM 这类问题，而不是卡死 CI。
 */

const PROFILES = 10;
const PER_PROFILE = 10;

function seedItems() {
  const store = useDatabaseWorkspaceStore.getState();
  useDatabaseWorkspaceStore.setState({ items: [], activeId: null });
  for (let profile = 0; profile < PROFILES; profile += 1) {
    for (let table = 0; table < PER_PROFILE; table += 1) {
      store.openTable({
        profileId: `p${profile}`,
        connectionName: `conn-${profile}`,
        database: `db_${profile}`,
        table: `table_${table}`,
      });
    }
  }
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// React 18 的 act 在生产构建里需要显式声明测试环境，否则每次 act 都打警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("工作项规模（10 连接 × 10 项）", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      ResizeObserverStub;
    seedItems();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useDatabaseWorkspaceStore.setState({ items: [], activeId: null });
  });

  it("首屏渲染 100 项在预算内，且行数正确", async () => {
    // 预热一次：首次挂载要初始化 i18n / 组件模块 / happy-dom，别把冷启动
    // 算成"渲染 100 项"的成本。
    await act(async () => {
      root.render(
        <OpenItemsPanel
          onRequestClose={() => undefined}
          onRequestCloseOthers={() => undefined}
          onRequestCloseRight={() => undefined}
        />,
      );
    });
    act(() => root.unmount());
    root = createRoot(container);

    const started = performance.now();
    await act(async () => {
      root.render(
        <OpenItemsPanel
          onRequestClose={() => undefined}
          onRequestCloseOthers={() => undefined}
          onRequestCloseRight={() => undefined}
        />,
      );
    });
    const elapsed = performance.now() - started;

    expect(container.querySelectorAll("[data-item-row]").length).toBe(
      PROFILES * PER_PROFILE,
    );
    // 真机上 100 项应当"瞬间"可见；超过 1s 说明渲染路径退化了。
    expect(elapsed).toBeLessThan(1000);
  });

  it("切换当前项不重建整个列表", async () => {
    await act(async () => {
      root.render(
        <OpenItemsPanel
          onRequestClose={() => undefined}
          onRequestCloseOthers={() => undefined}
          onRequestCloseRight={() => undefined}
        />,
      );
    });
    const items = useDatabaseWorkspaceStore.getState().items;
    const firstRow = container.querySelector("[data-item-row]");
    const target = items[items.length - 1];

    const started = performance.now();
    await act(async () => {
      useDatabaseWorkspaceStore.getState().setActive(target.id);
    });
    const elapsed = performance.now() - started;

    expect(useDatabaseWorkspaceStore.getState().activeId).toBe(target.id);
    // DOM 节点本身被复用（React 只改 class/aria），不是整树重建。
    expect(container.querySelector("[data-item-row]")).toBe(firstRow);
    expect(elapsed).toBeLessThan(300);
  });

  it("固定项置顶，1000 项排序也在预算内", () => {
    const base: WorkItem[] = Array.from({ length: 1000 }, (_, index) => ({
      ...useDatabaseWorkspaceStore.getState().items[index % 100],
      id: `item-${index}`,
      createdAt: 1_000 - index,
      pinned: index === 500,
    }));

    const started = performance.now();
    let sorted: WorkItem[] = [];
    for (let round = 0; round < 50; round += 1) {
      sorted = orderedItems(base);
    }
    const elapsed = performance.now() - started;

    expect(sorted[0]?.id).toBe("item-500");
    expect(elapsed).toBeLessThan(250);
  });
});
