import "@/i18n";
import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbColumn, DbValue } from "@/api/types/database";
import { VirtualDataGrid, type DataGridApi } from "../VirtualDataGrid";
import type { CellPoint, SelectionState } from "../grid/selection";

/**
 * 只读网格的回归测试：SQL 结果面板传入 `editable={false}`，
 * 粘贴 / Delete / F2 / 撤销 都必须被网格层拦掉 —— 不允许出现"误粘贴改数据"。
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const columns: DbColumn[] = [
  {
    index: 0,
    name: "id",
    org_name: "id",
    table: "t",
    org_table: "t",
    type_name: "int",
    type_code: 3,
    nullable: false,
    unsigned: false,
    binary: false,
    primary_key: true,
    auto_increment: true,
    decimals: 0,
    charset: 0,
  },
  {
    index: 1,
    name: "name",
    org_name: "name",
    table: "t",
    org_table: "t",
    type_name: "varchar",
    type_code: 253,
    nullable: true,
    unsigned: false,
    binary: false,
    primary_key: false,
    auto_increment: false,
    decimals: 0,
    charset: 33,
  },
];

const rows: DbValue[][] = [
  [{ kind: "int", value: "1", unsigned: false }, { kind: "text", value: "a", bytes: 1, truncated: false }],
  [{ kind: "int", value: "2", unsigned: false }, { kind: "text", value: "b", bytes: 1, truncated: false }],
];

interface Handlers {
  onCopy: (payload: { format: "tsv" | "tsv-headers"; selection: SelectionState }) => void;
  onPaste: (target: CellPoint, text: string) => void;
  onClear: (selection: SelectionState) => void;
  onUndo: () => void;
  onRedo: () => void;
  onStartEdit: (cell: CellPoint) => void;
  onOpenCell: (cell: CellPoint) => void;
}

let container: HTMLDivElement;
let root: Root;
let handlers: Handlers;
let apiRef: RefObject<DataGridApi | null>;

function mount(editable: boolean, rowOffset = 0) {
  handlers = {
    onCopy: vi.fn<Handlers["onCopy"]>(),
    onPaste: vi.fn<Handlers["onPaste"]>(),
    onClear: vi.fn<Handlers["onClear"]>(),
    onUndo: vi.fn<Handlers["onUndo"]>(),
    onRedo: vi.fn<Handlers["onRedo"]>(),
    onStartEdit: vi.fn<Handlers["onStartEdit"]>(),
    onOpenCell: vi.fn<Handlers["onOpenCell"]>(),
  };
  apiRef = { current: null };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <VirtualDataGrid
        columns={columns}
        rows={rows}
        rowOffset={rowOffset}
        editable={editable}
        apiRef={apiRef}
        canUndo
        canRedo
        onCopy={handlers.onCopy}
        onPaste={handlers.onPaste}
        onClear={handlers.onClear}
        onUndo={handlers.onUndo}
        onRedo={handlers.onRedo}
        onStartEdit={handlers.onStartEdit}
        onOpenCell={handlers.onOpenCell}
      />,
    );
  });
}

function grid(): HTMLElement {
  const element = container.querySelector('[role="grid"]');
  if (!element) throw new Error("grid not rendered");
  return element as HTMLElement;
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    grid().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("只读网格（SQL 查询结果）", () => {
  it("Ctrl+V / Delete / F2 不会触发任何写操作", async () => {
    mount(false);
    press("a", { ctrlKey: true });
    press("v", { ctrlKey: true });
    press("Delete");
    press("z", { ctrlKey: true });
    press("z", { ctrlKey: true, shiftKey: true });
    press("F2");
    // Ctrl+V 是异步读剪贴板，冲一次微任务队列。
    await act(async () => {
      await Promise.resolve();
    });

    expect(handlers.onPaste).not.toHaveBeenCalled();
    expect(handlers.onClear).not.toHaveBeenCalled();
    expect(handlers.onUndo).not.toHaveBeenCalled();
    expect(handlers.onRedo).not.toHaveBeenCalled();
    expect(handlers.onStartEdit).not.toHaveBeenCalled();
    // 只读网格双击/F2 是"查看完整值"。
    expect(handlers.onOpenCell).toHaveBeenCalledTimes(1);
  });

  it("只读网格仍然可以复制（Ctrl+A 只覆盖已加载数据）", () => {
    mount(false);
    press("a", { ctrlKey: true });
    const selection = apiRef.current?.getSelection();
    expect(selection?.ranges).toEqual([{ top: 0, bottom: 1, left: 0, right: 1 }]);

    press("c", { ctrlKey: true });
    expect(handlers.onCopy).toHaveBeenCalledWith({ format: "tsv", selection });

    press("c", { ctrlKey: true, shiftKey: true });
    expect(handlers.onCopy).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: "tsv-headers" }),
    );
  });

  it("Esc 清除选择", () => {
    mount(false);
    press("a", { ctrlKey: true });
    press("Escape");
    expect(apiRef.current?.getSelection().mode).toBeNull();
  });
});

describe("可编辑网格", () => {
  it("Delete / F2 / Ctrl+Z 走编辑回调", () => {
    mount(true);
    press("a", { ctrlKey: true });
    press("Delete");
    expect(handlers.onClear).toHaveBeenCalledTimes(1);

    press("F2");
    expect(handlers.onStartEdit).toHaveBeenCalledTimes(1);

    press("z", { ctrlKey: true });
    expect(handlers.onUndo).toHaveBeenCalledTimes(1);

    press("z", { ctrlKey: true, shiftKey: true });
    expect(handlers.onRedo).toHaveBeenCalledTimes(1);
  });

  it("输入框内的 Ctrl+A 不触发网格全选", () => {
    mount(true);
    const input = document.createElement("input");
    grid().appendChild(input);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(apiRef.current?.getSelection().mode).toBeNull();
    expect(handlers.onCopy).not.toHaveBeenCalled();
  });
});

describe("行号列", () => {
  const gutterTexts = () =>
    [...grid().querySelectorAll('[role="row"]')].map(
      (row) => row.firstElementChild?.textContent,
    );

  it("首页从 1 开始", () => {
    mount(false, 0);
    expect(gutterTexts()).toEqual(["1", "2"]);
  });

  it("分页偏移后显示全局行号（不是下一页起点的回显值）", () => {
    // 第 3 页、每页 100 行 → 201 起。传 result.offset 会变成 301。
    mount(false, 200);
    expect(gutterTexts()).toEqual(["201", "202"]);
  });
});
