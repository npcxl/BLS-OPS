import "@/i18n";
import { act, Profiler, type ProfilerOnRenderCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbColumn, DbValue } from "@/api/types/database";
import { VirtualDataGrid } from "../VirtualDataGrid";

/**
 * 100 列网格的可重复 React commit 基准。
 *
 * happy-dom 没有真实布局，通过固定 1600x800 视口驱动行列虚拟化；
 * 这里记录的是 React commit 时间，不是浏览器 paint/layout 时间。
 */
const COLUMNS = 100;
const ROWS = 1000;

class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

const columns: DbColumn[] = Array.from({ length: COLUMNS }, (_, index) => ({
  index,
  name: `column_${index}`,
  org_name: `column_${index}`,
  table: "wide_table",
  org_table: "wide_table",
  type_name: "varchar",
  type_code: 253,
  nullable: true,
  unsigned: false,
  binary: false,
  primary_key: index === 0,
  auto_increment: false,
  decimals: 0,
  charset: 33,
}));

const rows: DbValue[][] = Array.from({ length: ROWS }, (_, row) =>
  Array.from({ length: COLUMNS }, (_, col) => ({
    kind: "text" as const,
    value: `row-${row}-column-${col}`,
    bytes: 24,
    truncated: false,
  })),
);

let container: HTMLDivElement;
let root: Root;
let commits: { phase: string; duration: number }[] = [];

const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
  commits.push({ phase, duration: actualDuration });
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 1600,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 800,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commits = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <Profiler id="wide-grid" onRender={onRender}>
        <VirtualDataGrid columns={columns} rows={rows} editable={false} />
      </Profiler>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("VirtualDataGrid 100-column benchmark", () => {
  it("renders only the virtualized viewport and records commit costs", () => {
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    expect(grid).not.toBeNull();
    const cells = container.querySelectorAll('[role="gridcell"]').length;
    expect(cells).toBeGreaterThan(0);

    act(() => {
      grid.scrollTop = 2000;
      grid.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    act(() => {
      grid.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const initial = commits.find((entry) => entry.phase === "mount");
    const largest = Math.max(...commits.map((entry) => entry.duration));
    console.log(
      JSON.stringify({
        rows: ROWS,
        columns: COLUMNS,
        renderedCells: cells,
        commits: commits.length,
        initialCommitMs: Number((initial?.duration ?? 0).toFixed(2)),
        largestCommitMs: Number(largest.toFixed(2)),
      }),
    );

    // 只验证虚拟化生效和基准可运行，不把 happy-dom 的绝对耗时当浏览器性能。
    expect(cells).toBeLessThan(COLUMNS * 80);
    expect(commits.length).toBeGreaterThan(0);
  });
});
