import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  clampSelection,
  clearSelection,
  extendSelection,
  focusAt,
  isCellSelected,
  isColumnSelected,
  isRowSelected,
  iterateSelectionCells,
  liveRange,
  moveFocus,
  selectAll,
  selectCellAt,
  selectColumnAt,
  selectRowAt,
  selectionStats,
} from "../grid/selection";

const bounds = { rows: 100, cols: 10 };

describe("selection model — 单元格", () => {
  it("单击选中一格，并把焦点放在该格", () => {
    const state = selectCellAt(EMPTY_SELECTION, { row: 3, col: 2 }, bounds);
    expect(state.mode).toBe("cell");
    expect(state.focus).toEqual({ row: 3, col: 2 });
    expect(state.ranges).toEqual([{ top: 3, bottom: 3, left: 2, right: 2 }]);
    expect(isCellSelected(state, 3, 2)).toBe(true);
    expect(isCellSelected(state, 3, 3)).toBe(false);
  });

  it("Shift+单击从 anchor 扩展成矩形（正反方向都规范化）", () => {
    const first = selectCellAt(EMPTY_SELECTION, { row: 1, col: 1 }, bounds);
    const extended = selectCellAt(first, { row: 5, col: 4 }, bounds, { shift: true });
    expect(liveRange(extended)).toEqual({ top: 1, bottom: 5, left: 1, right: 4 });

    const backwards = selectCellAt(first, { row: 0, col: 0 }, bounds, { shift: true });
    expect(liveRange(backwards)).toEqual({ top: 0, bottom: 1, left: 0, right: 1 });
  });

  it("Ctrl+单击追加不连续块，再点同一格取消该块", () => {
    const first = selectCellAt(EMPTY_SELECTION, { row: 1, col: 1 }, bounds);
    const second = selectCellAt(first, { row: 8, col: 6 }, bounds, { toggle: true });
    expect(second.ranges).toHaveLength(2);
    expect(isCellSelected(second, 1, 1)).toBe(true);
    expect(isCellSelected(second, 8, 6)).toBe(true);
    expect(second.focus).toEqual({ row: 8, col: 6 });

    const removed = selectCellAt(second, { row: 8, col: 6 }, bounds, { toggle: true });
    expect(removed.ranges).toHaveLength(1);
    expect(isCellSelected(removed, 8, 6)).toBe(false);

    const emptied = selectCellAt(
      selectCellAt(EMPTY_SELECTION, { row: 2, col: 2 }, bounds),
      { row: 2, col: 2 },
      bounds,
      { toggle: true },
    );
    expect(emptied).toBe(EMPTY_SELECTION);
  });

  it("拖动扩展跨可视区域时保留 anchor，并把焦点夹到数据边界", () => {
    const start = selectCellAt(EMPTY_SELECTION, { row: 0, col: 0 }, bounds);
    const dragged = extendSelection(start, { row: 99, col: 9 }, bounds, "cell");
    expect(liveRange(dragged)).toEqual({ top: 0, bottom: 99, left: 0, right: 9 });
    // 超出边界的焦点不会让范围越界。
    const clamped = extendSelection(start, { row: 500, col: -5 }, bounds, "cell");
    expect(liveRange(clamped)).toEqual({ top: 0, bottom: 99, left: 0, right: 0 });
  });
});

describe("selection model — 行 / 列", () => {
  it("点击行号选中整行，Shift 扩展多行", () => {
    const row = selectRowAt(EMPTY_SELECTION, 4, bounds);
    expect(row.mode).toBe("row");
    expect(isRowSelected(row, 4)).toBe(true);
    expect(liveRange(row)).toEqual({ top: 4, bottom: 4, left: 0, right: 9 });

    const many = selectRowAt(row, 9, bounds, { shift: true });
    expect(liveRange(many)).toEqual({ top: 4, bottom: 9, left: 0, right: 9 });
    expect(selectionStats(many).rows).toBe(6);
  });

  it("点击列头选中整列，且撑满已加载行", () => {
    const column = selectColumnAt(EMPTY_SELECTION, 3, bounds);
    expect(column.mode).toBe("column");
    expect(isColumnSelected(column, 3)).toBe(true);
    expect(liveRange(column)).toEqual({ top: 0, bottom: 99, left: 3, right: 3 });
    expect(selectionStats(column).cells).toBe(100);
  });
});

describe("selection model — 键盘", () => {
  it("Ctrl+A 只覆盖已加载数据", () => {
    const all = selectAll(EMPTY_SELECTION, { rows: 200, cols: 100 });
    expect(liveRange(all)).toEqual({ top: 0, bottom: 199, left: 0, right: 99 });
    expect(selectionStats(all).cells).toBe(200 * 100);
    expect(selectAll(EMPTY_SELECTION, { rows: 0, cols: 10 })).toBe(EMPTY_SELECTION);
  });

  it("方向键塌缩成单格，Shift+方向键扩展", () => {
    const start = selectCellAt(EMPTY_SELECTION, { row: 2, col: 2 }, bounds);
    const moved = moveFocus(start, { row: 1, col: 0 }, bounds, false);
    expect(moved.focus).toEqual({ row: 3, col: 2 });
    expect(moved.ranges).toEqual([{ top: 3, bottom: 3, left: 2, right: 2 }]);

    const extended = moveFocus(start, { row: 2, col: 3 }, bounds, true);
    expect(liveRange(extended)).toEqual({ top: 2, bottom: 4, left: 2, right: 5 });
    expect(extended.anchor).toEqual({ row: 2, col: 2 });
  });

  it("焦点不会移出数据范围", () => {
    const state = selectCellAt(EMPTY_SELECTION, { row: 0, col: 0 }, bounds);
    expect(moveFocus(state, { row: -5, col: -5 }, bounds, false).focus).toEqual({
      row: 0,
      col: 0,
    });
    const last = focusAt(state, { row: 999, col: 999 }, bounds, false);
    expect(last.focus).toEqual({ row: 99, col: 9 });
  });

  it("Esc 清除选择", () => {
    const state = selectCellAt(EMPTY_SELECTION, { row: 1, col: 1 }, bounds);
    expect(clearSelection()).toBe(EMPTY_SELECTION);
    expect(state.mode).not.toBeNull();
  });
});

describe("selection model — 边界与遍历", () => {
  it("翻页后把越界选择夹回新的数据范围", () => {
    const state = selectAll(EMPTY_SELECTION, { rows: 100, cols: 10 });
    const clamped = clampSelection(state, { rows: 20, cols: 4 });
    expect(liveRange(clamped)).toEqual({ top: 0, bottom: 19, left: 0, right: 3 });
    expect(clampSelection(state, { rows: 0, cols: 0 })).toBe(EMPTY_SELECTION);
  });

  it("展开单元格时遵守上限（防止 Ctrl+A 后铺平百万格）", () => {
    const all = selectAll(EMPTY_SELECTION, { rows: 100, cols: 10 });
    expect([...iterateSelectionCells(all, 50)]).toHaveLength(50);
    expect([...iterateSelectionCells(all)]).toHaveLength(1000);
  });

  it("多块选择的统计是并集", () => {
    const first = selectCellAt(EMPTY_SELECTION, { row: 0, col: 0 }, bounds);
    const second = selectCellAt(first, { row: 10, col: 5 }, bounds, { toggle: true });
    const stats = selectionStats(second);
    expect(stats.blocks).toBe(2);
    expect(stats.rows).toBe(2);
    expect(stats.cols).toBe(2);
    expect(stats.cells).toBe(2);
  });
});
