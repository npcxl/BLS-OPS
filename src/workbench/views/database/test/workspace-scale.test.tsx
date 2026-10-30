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
 * 只验「能不能渲染/切换」，不做像素级断言。**绝对时间只做灾难性退化的冒烟阈值**：
 * jsdom 里渲染 100 行受机器负载影响极大（同一份代码在满核并行时能差 4 倍），
 * 拿 1s 卡它只会稳定地误报。真正与负载无关的保证在同组第二个用例里：
 * 「切换当前项不重建整个列表」。
 */

const PROFILES = 10;
const PER_PROFILE = 10;
/**
 * 冒烟预算：超过这个数量级说明渲染路径真的退化了（O(n²)、每次全量重建），
 * 而不是"这台机器忙"。真机实测在 0.1-0.3s 量级。
 */
const RENDER_BUDGET_MS = 5000;

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
    // 灾难性退化阈值（与负载无关的保证见下一个用例）。
    expect(elapsed).toBeLessThan(RENDER_BUDGET_MS);
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
