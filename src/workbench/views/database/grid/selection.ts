/**
 * 数据网格选择模型 —— **纯数据，不依赖 React、不依赖 DOM**。
 *
 * 为什么不用浏览器文本选区：文本选区只能表达"页面上的字符范围"，无法表达
 * 行/列/矩形，也无法跨虚拟滚动的未渲染行；而复制、粘贴、删除都需要**行列
 * 索引**。这里用 anchor（起点）/focus（焦点）/ranges（已确定的块）表达，
 * 渲染层只负责把这些块画成矩形。
 *
 * 不变式：
 * - `mode === null` 时 `ranges` 为空，表示没有选择；
 * - `mode !== null` 时 `ranges` 的最后一块**永远是** `anchor → focus` 的实时块，
 *   这样拖动时只需替换最后一块，Ctrl+点击追加的块自然保留在前面。
 */

export interface CellPoint {
  row: number;
  col: number;
}

/** 选择以什么为单位：单元格矩形 / 整行 / 整列。 */
export type SelectionMode = "cell" | "row" | "column";

/** 规范化后的块（top ≤ bottom，left ≤ right），单位是行列索引。 */
export interface SelectionRange {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SelectionState {
  mode: SelectionMode | null;
  anchor: CellPoint;
  focus: CellPoint;
  ranges: SelectionRange[];
}

/** 网格当前的数据规模（行数 = 已加载行，列数 = 结果列数）。 */
export interface GridBounds {
  rows: number;
  cols: number;
}

export interface SelectionModifiers {
  shift?: boolean;
  /** Ctrl / Meta 点击：追加或移除一个 1×1 块。 */
  toggle?: boolean;
}

export const EMPTY_SELECTION: SelectionState = {
  mode: null,
  anchor: { row: 0, col: 0 },
  focus: { row: 0, col: 0 },
  ranges: [],
};

/** 全选/删除时的安全上限：超过就不展开成单元格列表。 */
export const MAX_ENUMERATED_CELLS = 5000;

export function isSelectionEmpty(state: SelectionState): boolean {
  return state.mode === null || state.ranges.length === 0;
}

export function clampIndex(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0;
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(value)));
}

export function clampPoint(point: CellPoint, bounds: GridBounds): CellPoint {
  return {
    row: clampIndex(point.row, bounds.rows),
    col: clampIndex(point.col, bounds.cols),
  };
}

/** 按模式把 anchor/focus 展开成矩形。整行/整列模式会撑满另一维。 */
export function makeRange(
  mode: SelectionMode,
  anchor: CellPoint,
  focus: CellPoint,
  bounds: GridBounds,
): SelectionRange {
  const a = clampPoint(anchor, bounds);
  const f = clampPoint(focus, bounds);
  const top = Math.min(a.row, f.row);
  const bottom = Math.max(a.row, f.row);
  const left = Math.min(a.col, f.col);
  const right = Math.max(a.col, f.col);
  if (mode === "row") {
    return { top, bottom, left: 0, right: Math.max(0, bounds.cols - 1) };
  }
  if (mode === "column") {
    return { top: 0, bottom: Math.max(0, bounds.rows - 1), left, right };
  }
  return { top, bottom, left, right };
}

/** 实时块（anchor → focus）；没有选择时返回 null。 */
export function liveRange(state: SelectionState): SelectionRange | null {
  if (state.mode === null || state.ranges.length === 0) return null;
  return state.ranges[state.ranges.length - 1];
}

/** 除实时块以外的块（Ctrl 多选累积的部分）。 */
function committedRanges(state: SelectionState): SelectionRange[] {
  return state.mode === null ? [] : state.ranges.slice(0, -1);
}

function settle(
  mode: SelectionMode,
  anchor: CellPoint,
  focus: CellPoint,
  committed: SelectionRange[],
  bounds: GridBounds,
): SelectionState {
  const a = clampPoint(anchor, bounds);
  const f = clampPoint(focus, bounds);
  return {
    mode,
    anchor: a,
    focus: f,
    ranges: [...committed, makeRange(mode, a, f, bounds)],
  };
}

/**
 * 单击单元格。
 * - 普通点击：整块替换；
 * - Shift：保留 anchor，扩展实时块（模式沿用当前模式，没有则用 cell）；
 * - Ctrl/Meta：追加/移除一个 1×1 块。
 */
export function selectCellAt(
  state: SelectionState,
  point: CellPoint,
  bounds: GridBounds,
  modifiers: SelectionModifiers = {},
): SelectionState {
  const target = clampPoint(point, bounds);
  if (modifiers.shift) {
    const mode = state.mode ?? "cell";
    return settle(mode, state.mode ? state.anchor : target, target, committedRanges(state), bounds);
  }
  if (modifiers.toggle) {
    const index = state.ranges.findIndex(
      (range) =>
        range.top === target.row &&
        range.bottom === target.row &&
        range.left === target.col &&
        range.right === target.col,
    );
    if (index >= 0) {
      const ranges = state.ranges.filter((_, current) => current !== index);
      if (ranges.length === 0) return EMPTY_SELECTION;
      return {
        mode: state.mode,
        anchor: target,
        focus: target,
        ranges,
      };
    }
    return settle("cell", target, target, state.mode === "cell" ? state.ranges : [], bounds);
  }
  return settle("cell", target, target, [], bounds);
}

/** 点击行号：整行选择；Shift 扩展、Ctrl 追加。 */
export function selectRowAt(
  state: SelectionState,
  row: number,
  bounds: GridBounds,
  modifiers: SelectionModifiers = {},
): SelectionState {
  const target = { row: clampIndex(row, bounds.rows), col: state.focus.col };
  if (modifiers.shift && state.mode) {
    const mode = state.mode === "column" ? "row" : state.mode;
    return settle(mode, state.anchor, target, committedRanges(state), bounds);
  }
  if (modifiers.toggle) {
    return settle("row", target, target, state.mode === "row" ? state.ranges : [], bounds);
  }
  return settle("row", target, target, [], bounds);
}

/** 点击列头：整列选择；Shift 扩展、Ctrl 追加。 */
export function selectColumnAt(
  state: SelectionState,
  col: number,
  bounds: GridBounds,
  modifiers: SelectionModifiers = {},
): SelectionState {
  const target = { row: state.focus.row, col: clampIndex(col, bounds.cols) };
  if (modifiers.shift && state.mode) {
    const mode = state.mode === "row" ? "column" : state.mode;
    return settle(mode, state.anchor, target, committedRanges(state), bounds);
  }
  if (modifiers.toggle) {
    return settle("column", target, target, state.mode === "column" ? state.ranges : [], bounds);
  }
  return settle("column", target, target, [], bounds);
}

/** 拖动/Shift+单击的行列扩展：只动实时块，已追加的块保留。 */
export function extendSelection(
  state: SelectionState,
  point: CellPoint,
  bounds: GridBounds,
  mode?: SelectionMode,
): SelectionState {
  const nextMode = mode ?? state.mode ?? "cell";
  const anchor = state.mode === null ? clampPoint(point, bounds) : state.anchor;
  return settle(nextMode, anchor, point, committedRanges(state), bounds);
}

/** 方向键/PageUp/PageDown 移动焦点；`extension` 为 false 时塌缩成单格。 */
export function moveFocus(
  state: SelectionState,
  delta: CellPoint,
  bounds: GridBounds,
  extension: boolean,
): SelectionState {
  const next = {
    row: clampIndex(state.focus.row + delta.row, bounds.rows),
    col: clampIndex(state.focus.col + delta.col, bounds.cols),
  };
  if (!extension) return settle("cell", next, next, [], bounds);
  return extendSelection(state, next, bounds, state.mode ?? "cell");
}

/** 把焦点直接放到某个点（PageDown 之类需要绝对定位时用）。 */
export function focusAt(
  state: SelectionState,
  point: CellPoint,
  bounds: GridBounds,
  extension: boolean,
): SelectionState {
  const target = clampPoint(point, bounds);
  if (!extension) return settle("cell", target, target, [], bounds);
  return extendSelection(state, target, bounds, state.mode ?? "cell");
}

/** Ctrl+A：选中**当前已加载**的全部数据（不触发任何查询）。 */
export function selectAll(_state: SelectionState, bounds: GridBounds): SelectionState {
  if (bounds.rows === 0 || bounds.cols === 0) return EMPTY_SELECTION;
  return settle(
    "cell",
    { row: 0, col: 0 },
    { row: bounds.rows - 1, col: bounds.cols - 1 },
    [],
    bounds,
  );
}

export function clearSelection(): SelectionState {
  return EMPTY_SELECTION;
}

/** 数据规模变化后把选择夹回范围内；行/列被清空时直接清掉选择。 */
export function clampSelection(state: SelectionState, bounds: GridBounds): SelectionState {
  if (state.mode === null) return state;
  if (bounds.rows === 0 || bounds.cols === 0) return EMPTY_SELECTION;
  const anchor = clampPoint(state.anchor, bounds);
  const focus = clampPoint(state.focus, bounds);
  const committed = state.ranges
    .slice(0, -1)
    .map((range) => ({
      top: clampIndex(range.top, bounds.rows),
      bottom: clampIndex(range.bottom, bounds.rows),
      left: clampIndex(range.left, bounds.cols),
      right: clampIndex(range.right, bounds.cols),
    }))
    .map((range) => ({
      top: Math.min(range.top, range.bottom),
      bottom: Math.max(range.top, range.bottom),
      left: Math.min(range.left, range.right),
      right: Math.max(range.left, range.right),
    }));
  return settle(state.mode, anchor, focus, committed, bounds);
}

export function isCellSelected(state: SelectionState, row: number, col: number): boolean {
  if (state.mode === null) return false;
  return state.ranges.some(
    (range) =>
      row >= range.top && row <= range.bottom && col >= range.left && col <= range.right,
  );
}

export function isRowSelected(state: SelectionState, row: number): boolean {
  if (state.mode === null) return false;
  return state.ranges.some((range) => row >= range.top && row <= range.bottom);
}

export function isColumnSelected(state: SelectionState, col: number): boolean {
  if (state.mode === null) return false;
  return state.ranges.some((range) => col >= range.left && col <= range.right);
}

export interface SelectionStats {
  /** 块数量（Ctrl 多选会 > 1）。 */
  blocks: number;
  /** 行并集（用于状态栏文案，不代表矩形）。 */
  rows: number;
  cols: number;
  cells: number;
}

export function selectionStats(state: SelectionState): SelectionStats {
  if (state.mode === null || state.ranges.length === 0) {
    return { blocks: 0, rows: 0, cols: 0, cells: 0 };
  }
  let cells = 0;
  const rows = new Set<number>();
  const cols = new Set<number>();
  for (const range of state.ranges) {
    cells += (range.bottom - range.top + 1) * (range.right - range.left + 1);
    for (let row = range.top; row <= range.bottom; row += 1) rows.add(row);
    for (let col = range.left; col <= range.right; col += 1) cols.add(col);
  }
  return { blocks: state.ranges.length, rows: rows.size, cols: cols.size, cells };
}

/**
 * 展开成单元格列表（行优先，块之间按选择顺序）。
 *
 * 只在有上限的小范围操作里用（Delete 清空）；复制走块迭代，不铺平成数组，
 * 否则 10 万行 × 100 列会直接把内存打爆。
 */
export function* iterateSelectionCells(
  state: SelectionState,
  limit: number = Number.POSITIVE_INFINITY,
): Generator<CellPoint> {
  if (state.mode === null) return;
  let produced = 0;
  for (const range of state.ranges) {
    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let col = range.left; col <= range.right; col += 1) {
        if (produced >= limit) return;
        produced += 1;
        yield { row, col };
      }
    }
  }
}
