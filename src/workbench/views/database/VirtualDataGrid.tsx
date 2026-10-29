/**
 * 结果/表数据网格：行虚拟化 + 列虚拟化 + Excel 式选择。
 *
 * 为什么自己写而不是引一个库：项目的表格只需要"只读展示 + 选择 + 复制 +
 * 排序 + 列宽"，引入 300 KB 的表格库不值当；这里 400 行就能把可见范围
 * 严格限制在视口内。
 *
 * **两条性能红线**：
 * 1. 滚动不重建结果：`rows` 数组稳定，滚动只更新 `scroll`；
 * 2. **选择不重渲染数据**：选择状态放在外部 store 里，只有
 *    `SelectionOverlay` 订阅它；行组件是 `memo` 的，选择/编辑/拖动都不会
 *    让可见行重新渲染（编辑框是独立覆盖层，也不进单元格）。
 *
 * 选择模型本身在 `./grid/selection.ts`（纯函数、不碰 DOM）；这里只做
 * 坐标 ↔ 行列索引的映射和键盘/鼠标事件分发。
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type { DbColumn, DbValue } from "@/api/types/database";
import { cn } from "@/lib/cn";
import { readText } from "@/lib/clipboard";
import {
  EMPTY_SELECTION,
  extendSelection,
  focusAt,
  isCellSelected,
  isColumnSelected,
  isRowSelected,
  moveFocus,
  selectAll,
  selectCellAt,
  selectColumnAt,
  selectRowAt,
  type CellPoint,
  type GridBounds,
  type SelectionMode,
  type SelectionState,
} from "./grid/selection";
import { createSelectionStore } from "./grid/selection-store";
import { ColumnSelectionOverlay, SelectionOverlay } from "./grid/SelectionOverlay";

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 42;
const GUTTER_WIDTH = 64;
const OVERSCAN_ROWS = 8;
const MIN_COL_WIDTH = 72;
const MAX_COL_WIDTH = 420;
/** 拖动选择时贴近边缘多近开始自动滚动（px）与每帧滚动步长（px）。 */
const DRAG_EDGE = 26;
const DRAG_STEP = 16;

export type CellAddress = CellPoint;

/** 父组件（工具栏/右键菜单/提交后移动焦点）用这个命令式 API。 */
export interface DataGridApi {
  getSelection(): SelectionState;
  getFocus(): CellAddress | null;
  selectAll(): void;
  /** 相对移动焦点（确认编辑后 Enter/Tab 的落点），并保证可见。 */
  moveFocus(delta: CellPoint): void;
  focus(): void;
}

function columnHint(column: DbColumn): number {
  const type = column.type_name.toUpperCase();
  if (["JSON", "LONGTEXT", "MEDIUMTEXT", "TEXT"].includes(type)) return 260;
  if (["DATETIME", "TIMESTAMP", "DATE", "TIME"].includes(type)) return 168;
  if (["BLOB", "MEDIUMBLOB", "LONGBLOB", "VARBINARY", "BIT"].includes(type)) return 140;
  if (
    ["BIGINT", "INT", "INTEGER", "SMALLINT", "TINYINT", "MEDIUMINT", "DECIMAL", "FLOAT", "DOUBLE"].includes(
      type,
    )
  ) {
    return 118;
  }
  return Math.max(120, Math.min(220, column.name.length * 9 + 48));
}

function initialWidths(columns: DbColumn[]): number[] {
  return columns.map((column) =>
    Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, columnHint(column))),
  );
}

/** 内容坐标 → 列索引（二分：100 列时也不必线性扫）。 */
function columnAtOffset(x: number, starts: number[]): number {
  let low = 0;
  let high = starts.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((starts[mid] ?? 0) <= x) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** 焦点是否在可编辑控件里：这些位置保留浏览器原生的 Ctrl+C/A/V。 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return target.closest(".cm-editor") !== null;
}

export function cellText(value: DbValue): { text: string; tone: string; truncated: boolean } {
  switch (value.kind) {
    case "null":
      return { text: "NULL", tone: "text-fg-subtle italic", truncated: false };
    case "int":
      return {
        text: value.value,
        tone: value.unsigned ? "text-fg" : "text-fg",
        truncated: false,
      };
    case "decimal":
      return { text: value.value, tone: "text-fg", truncated: false };
    case "float":
      return { text: String(value.value), tone: "text-fg", truncated: false };
    case "text":
      return {
        text: value.value,
        tone: "text-fg",
        truncated: value.truncated,
      };
    case "json":
      return {
        text: value.value,
        tone: "text-accent",
        truncated: value.truncated,
      };
    case "date":
    case "date_time":
    case "time":
      return { text: value.value, tone: "text-fg-muted", truncated: false };
    case "binary":
      return {
        text: `[二进制 ${value.bytes} B]`,
        tone: "text-fg-subtle",
        truncated: value.truncated,
      };
    case "bit":
      return { text: `${value.bits} (${value.value})`, tone: "text-fg-muted", truncated: false };
    case "unsupported":
      return {
        text: `[${value.type_name}] ${value.preview.slice(0, 40)}`,
        tone: "text-danger",
        truncated: value.preview.length < value.bytes,
      };
  }
}

type Hit =
  | { kind: "corner" }
  | { kind: "columnHeader"; col: number }
  | { kind: "rowHeader"; row: number }
  | { kind: "cell"; point: CellPoint };

interface VirtualDataGridProps {
  columns: DbColumn[];
  rows: DbValue[][];
  /**
   * 0 基行偏移：第 n 行显示 `rowOffset + n + 1`。
   * 分页时传 `(pageIndex * pageSize)` —— **不要传 `BrowseResult.offset`**，
   * 后端返回的是"下一页起点"（已加上本页行数）。
   */
  rowOffset?: number;
  className?: string;
  apiRef?: RefObject<DataGridApi | null>;
  /** 兼容宿主的选择状态展示/编辑按钮；视觉选择由覆盖层负责。 */
  selectedRow?: number | null;
  selectedCell?: CellPoint | null;
  onSelectRow?: (row: number) => void;
  onSelectCell?: (cell: CellPoint) => void;

  /** 只读网格：禁止 F2/双击编辑、粘贴、Delete、撤销。 */
  editable?: boolean;
  editingCell?: CellAddress | null;
  editingValue?: string;
  onEditingValueChange?: (value: string) => void;
  onStartEdit?: (cell: CellAddress) => void;
  /** `move` 表示确认后焦点往哪儿走（Enter 向下 / Tab 向右）。 */
  onCommitEdit?: (cell: CellAddress, move: "down" | "up" | "right" | "left" | null) => void;
  onCancelEdit?: () => void;

  /** 复制：网格只负责发起，格式与表名由宿主决定。 */
  onCopy?: (payload: {
    format: "tsv" | "tsv-headers";
    selection: SelectionState;
  }) => void;
  onPaste?: (target: CellAddress, text: string) => void;
  onClear?: (selection: SelectionState) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;

  onOpenCell?: (cell: CellAddress) => void;
  onSort?: (column: DbColumn) => void;
  sortColumn?: string | null;
  sortDirection?: "asc" | "desc" | null;
  /** 单元格是否已有待提交修改（`row:col`）。 */
  modifiedCells?: Set<string>;
  /** 已标记删除的行（当前页索引）。 */
  deletedRows?: Set<number>;
  onCellContextMenu?: (cell: CellAddress, event: React.MouseEvent) => void;
  onRowContextMenu?: (row: number, event: React.MouseEvent) => void;
  onColumnContextMenu?: (col: number, event: React.MouseEvent) => void;
}

interface GridRowProps {
  rowIndex: number;
  displayIndex: number;
  row: DbValue[];
  columns: DbColumn[];
  widths: number[];
  starts: number[];
  visibleColumns: number[];
  width: number;
  deleted: boolean;
  modifiedCells?: Set<string>;
}

/**
 * 一行。**不接收任何选择/编辑 props**：选择由覆盖层画，编辑框是独立覆盖层，
 * 所以鼠标拖动选择时这里不会重渲染。
 */
const GridRow = memo(function GridRow({
  rowIndex,
  displayIndex,
  row,
  columns,
  widths,
  starts,
  visibleColumns,
  width,
  deleted,
  modifiedCells,
}: GridRowProps) {
  return (
    <div
      role="row"
      className={cn(
        "absolute left-0",
        deleted
          ? "bg-danger/10 line-through decoration-danger/40"
          : rowIndex % 2 === 1
            ? "bg-surface-2/40"
            : undefined,
      )}
      style={{
        top: HEADER_HEIGHT + rowIndex * ROW_HEIGHT,
        height: ROW_HEIGHT,
        width,
      }}
    >
      <div
        className="sticky left-0 z-[25] flex items-center justify-end border-b border-r border-line bg-surface-2 px-2 text-10 text-fg-subtle select-none"
        style={{ width: GUTTER_WIDTH, height: ROW_HEIGHT }}
      >
        {displayIndex}
      </div>
      {visibleColumns.map((colIndex) => {
        const value = row[colIndex] ?? { kind: "null" as const };
        const display = cellText(value);
        const modified = modifiedCells?.has(`${rowIndex}:${colIndex}`);
        return (
          <div
            key={colIndex}
            role="gridcell"
            className={cn(
              "absolute top-0 flex items-center overflow-hidden border-b border-r border-line/40 px-2",
              modified && "bg-warning/10",
              value.kind === "null" && "text-fg-subtle",
            )}
            style={{
              left: GUTTER_WIDTH + (starts[colIndex] ?? 0),
              width: widths[colIndex],
              height: ROW_HEIGHT,
            }}
            title={
              (value.kind === "text" || value.kind === "json") && value.truncated
                ? columns[colIndex]?.name
                : undefined
            }
          >
            <span className={cn("truncate", display.tone)}>{display.text}</span>
            {display.truncated && (
              <span className="ml-1 shrink-0 text-[9px] text-warning">…</span>
            )}
          </div>
        );
      })}
    </div>
  );
});

export const VirtualDataGrid = memo(function VirtualDataGrid({
  columns,
  rows,
  rowOffset = 0,
  className,
  apiRef,
  selectedRow: _selectedRow,
  selectedCell: _selectedCell,
  onSelectRow,
  onSelectCell,
  editable = false,
  editingCell = null,
  editingValue = "",
  onEditingValueChange,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onCopy,
  onPaste,
  onClear,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  onOpenCell,
  onSort,
  sortColumn,
  sortDirection,
  modifiedCells,
  deletedRows,
  onCellContextMenu,
  onRowContextMenu,
  onColumnContextMenu,
}: VirtualDataGridProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const suppressBlur = useRef(false);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns));
  const [resizing, setResizing] = useState<{ col: number; startX: number; startWidth: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState<SelectionMode | null>(null);
  const dragRef = useRef<{ x: number; y: number; mode: SelectionMode } | null>(null);

  const bounds: GridBounds = useMemo(
    () => ({ rows: rows.length, cols: columns.length }),
    [columns.length, rows.length],
  );
  const store = useMemo(() => createSelectionStore(bounds), []);
  const width = useMemo(
    () => columns.reduce((sum, _column, index) => sum + (widths[index] ?? MIN_COL_WIDTH), GUTTER_WIDTH),
    [columns, widths],
  );

  useEffect(() => {
    store.setBounds(bounds);
  }, [bounds, store]);

  // 换数据（翻页/切结果集）时清空选择：旧索引对新数据没有意义。
  useEffect(() => {
    store.reset();
  }, [rows, store]);

  useEffect(() => {
    setWidths(initialWidths(columns));
    setScroll({ top: 0, left: 0 });
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, [columns]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    setViewport({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: MouseEvent) => {
      const delta = event.clientX - resizing.startX;
      setWidths((current) =>
        current.map((value, index) =>
          index === resizing.col
            ? Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, resizing.startWidth + delta))
            : value,
        ),
      );
    };
    const onUp = () => setResizing(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);

  const starts = useMemo(() => {
    const result: number[] = [];
    let cursor = 0;
    for (const value of widths) {
      result.push(cursor);
      cursor += value;
    }
    return result;
  }, [widths]);

  const totalHeight = HEADER_HEIGHT + rows.length * ROW_HEIGHT;

  const visibleRows = useMemo(() => {
    const first = Math.max(
      0,
      Math.floor((scroll.top - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN_ROWS,
    );
    const last = Math.min(
      rows.length,
      Math.ceil((scroll.top + viewport.height - HEADER_HEIGHT) / ROW_HEIGHT) + OVERSCAN_ROWS,
    );
    const indexes: number[] = [];
    for (let index = first; index < last; index += 1) indexes.push(index);
    return indexes;
  }, [rows.length, scroll.top, viewport.height]);

  const visibleColumns = useMemo(() => {
    const left = Math.max(0, scroll.left);
    const right = left + Math.max(viewport.width, 400);
    const indexes: number[] = [];
    for (let index = 0; index < columns.length; index += 1) {
      const start = starts[index] ?? 0;
      const end = start + (widths[index] ?? MIN_COL_WIDTH);
      if (end >= left - 200 && start <= right + 200) indexes.push(index);
    }
    return indexes;
  }, [columns.length, scroll.left, starts, viewport.width, widths]);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    setScroll({ top: target.scrollTop, left: target.scrollLeft });
  }, []);

  /** 屏幕坐标 → 命中区域。读元素实时 scroll，保证拖动循环里不落后一帧。 */
  const hitTest = useCallback(
    (clientX: number, clientY: number): Hit | null => {
      const element = containerRef.current;
      if (!element || rows.length === 0 || columns.length === 0) return null;
      const rect = element.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      if (localY < HEADER_HEIGHT) {
        if (localX < GUTTER_WIDTH) return { kind: "corner" };
        const col = columnAtOffset(element.scrollLeft + localX - GUTTER_WIDTH, starts);
        return { kind: "columnHeader", col: Math.min(col, columns.length - 1) };
      }
      const contentY = element.scrollTop + localY - HEADER_HEIGHT;
      const row = Math.floor(contentY / ROW_HEIGHT);
      if (row < 0 || row >= rows.length) return null;
      if (localX < GUTTER_WIDTH) return { kind: "rowHeader", row };
      const col = columnAtOffset(element.scrollLeft + localX - GUTTER_WIDTH, starts);
      return { kind: "cell", point: { row, col: Math.min(col, columns.length - 1) } };
    },
    [columns.length, rows.length, starts],
  );

  /** 键盘导航时把焦点单元格滚进视口（含行号列/表头占位）。 */
  const ensureVisible = useCallback(
    (point: CellPoint) => {
      const element = containerRef.current;
      if (!element) return;
      const top = HEADER_HEIGHT + point.row * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      const viewTop = element.scrollTop + HEADER_HEIGHT;
      const viewBottom = element.scrollTop + element.clientHeight;
      if (top < viewTop) element.scrollTop = top - HEADER_HEIGHT;
      else if (bottom > viewBottom) element.scrollTop = bottom - element.clientHeight;
      const left = (starts[point.col] ?? 0) + GUTTER_WIDTH;
      const right = left + (widths[point.col] ?? MIN_COL_WIDTH);
      const viewLeft = element.scrollLeft + GUTTER_WIDTH;
      const viewRight = element.scrollLeft + element.clientWidth;
      if (left < viewLeft) element.scrollLeft = left - GUTTER_WIDTH;
      else if (right > viewRight) element.scrollLeft = right - element.clientWidth;
    },
    [starts, widths],
  );

  const stateOf = useCallback(() => store.getSnapshot(), [store]);

  const startEdit = useCallback(
    (point: CellPoint) => {
      if (!editable) {
        onOpenCell?.(point);
        return;
      }
      onStartEdit?.(point);
      ensureVisible(point);
    },
    [editable, ensureVisible, onOpenCell, onStartEdit],
  );

  // ---- 拖动选择 -----------------------------------------------------------
  const applyDrag = useCallback(
    (clientX: number, clientY: number, mode: SelectionMode) => {
      const hit = hitTest(clientX, clientY);
      if (!hit) return;
      if (hit.kind === "cell") {
        store.update((state) => extendSelection(state, hit.point, store.getBounds(), mode));
      } else if (hit.kind === "rowHeader") {
        store.update((state) =>
          extendSelection(state, { row: hit.row, col: state.focus.col }, store.getBounds(), "row"),
        );
      } else if (hit.kind === "columnHeader") {
        store.update((state) =>
          extendSelection(state, { row: state.focus.row, col: hit.col }, store.getBounds(), "column"),
        );
      }
    },
    [hitTest, store],
  );

  /**
   * 监听**在 mousedown 里同步挂上**，不放在 effect 里：一次极快的点击可能在
   * effect 执行前就结束，那样 mouseup 永远收不到，拖动状态会卡住、之后不按
   * 键移动鼠标还会继续扩选。
   */
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const stopDrag = useCallback(() => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    dragRef.current = null;
    setDragging(null);
  }, []);

  const beginDrag = useCallback(
    (event: React.MouseEvent, mode: SelectionMode) => {
      stopDrag();
      dragRef.current = { x: event.clientX, y: event.clientY, mode };
      const onMove = (moveEvent: MouseEvent) => {
        if (!dragRef.current) return;
        dragRef.current = {
          ...dragRef.current,
          x: moveEvent.clientX,
          y: moveEvent.clientY,
        };
        applyDrag(moveEvent.clientX, moveEvent.clientY, mode);
      };
      const onUp = () => stopDrag();
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      dragCleanupRef.current = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      setDragging(mode);
    },
    [applyDrag, stopDrag],
  );

  useEffect(() => () => dragCleanupRef.current?.(), []);

  // 拖到视口边缘时自动滚动：跨可视区域选择靠它把未渲染的行"拉"出来。
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const tick = () => {
      const drag = dragRef.current;
      const element = containerRef.current;
      if (drag && element) {
        const rect = element.getBoundingClientRect();
        let dx = 0;
        let dy = 0;
        if (drag.y < rect.top + HEADER_HEIGHT + DRAG_EDGE) dy = -DRAG_STEP;
        else if (drag.y > rect.bottom - DRAG_EDGE) dy = DRAG_STEP;
        if (drag.x < rect.left + GUTTER_WIDTH + DRAG_EDGE) dx = -DRAG_STEP;
        else if (drag.x > rect.right - DRAG_EDGE) dx = DRAG_STEP;
        if (dx !== 0 || dy !== 0) {
          element.scrollLeft += dx;
          element.scrollTop += dy;
          applyDrag(drag.x, drag.y, drag.mode);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [applyDrag, dragging]);

  // ---- 鼠标 ---------------------------------------------------------------
  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-cell-editor]")) return;
    if (target.closest("[data-sort-button]")) return;
    const hit = hitTest(event.clientX, event.clientY);
    if (!hit) return;
    // 不用浏览器文本选区模拟数据选择：直接吃掉默认行为。
    event.preventDefault();
    containerRef.current?.focus({ preventScroll: true });

    if (editingCell) {
      const sameCell =
        hit.kind === "cell" &&
        hit.point.row === editingCell.row &&
        hit.point.col === editingCell.col;
      if (!sameCell) onCommitEdit?.(editingCell, null);
    }

    const modifiers = {
      shift: event.shiftKey,
      toggle: event.ctrlKey || event.metaKey,
    };
    const state = stateOf();
    const gridBounds = store.getBounds();

    if (hit.kind === "corner") {
      store.update((current) => selectAll(current, gridBounds));
      return;
    }
    if (hit.kind === "columnHeader") {
      store.set(selectColumnAt(state, hit.col, gridBounds, modifiers));
      beginDrag(event, "column");
      return;
    }
    if (hit.kind === "rowHeader") {
      store.set(selectRowAt(state, hit.row, gridBounds, modifiers));
      onSelectRow?.(hit.row);
      beginDrag(event, "row");
      return;
    }
    store.set(selectCellAt(state, hit.point, gridBounds, modifiers));
    onSelectRow?.(hit.point.row);
    onSelectCell?.(hit.point);
    beginDrag(event, "cell");
  };

  /**
   * 双击进入编辑（F2 也行）。**单击只选择**：如果单击就进编辑，输入框会抢走
   * 焦点，随后的 Ctrl+C 会被输入框当成原生复制 —— 选中区域的 TSV 复制就没了。
   */
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-cell-editor]") || target.closest("[data-sort-button]")) return;
    const hit = hitTest(event.clientX, event.clientY);
    if (!hit) return;
    if (hit.kind === "columnHeader") {
      const column = columns[hit.col];
      if (column) onSort?.(column);
      return;
    }
    if (hit.kind === "cell") startEdit(hit.point);
  };

  /**
   * 右键的目标先变成"当前选择"：在选区外点 → 改成该单元格/行/列；
   * 在选区内点 → 保留多选，这样「复制选中区域」才和 Ctrl+C 一致。
   */
  const ensureSelectionFor = (target: Hit) => {
    const state = store.getSnapshot();
    const gridBounds = store.getBounds();
    if (target.kind === "cell") {
      if (state.mode !== "cell" || !isCellSelected(state, target.point.row, target.point.col)) {
        store.set(selectCellAt(state, target.point, gridBounds, {}));
      }
      return;
    }
    if (target.kind === "rowHeader") {
      if (state.mode !== "row" || !isRowSelected(state, target.row)) {
        store.set(selectRowAt(state, target.row, gridBounds, {}));
      }
      return;
    }
    if (target.kind === "columnHeader") {
      if (state.mode !== "column" || !isColumnSelected(state, target.col)) {
        store.set(selectColumnAt(state, target.col, gridBounds, {}));
      }
    }
  };

  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const hit = hitTest(event.clientX, event.clientY);
    if (!hit) return;
    ensureSelectionFor(hit);
    if (hit.kind === "cell") onCellContextMenu?.(hit.point, event);
    else if (hit.kind === "rowHeader") onRowContextMenu?.(hit.row, event);
    else if (hit.kind === "columnHeader") onColumnContextMenu?.(hit.col, event);
  };

  // ---- 键盘 ---------------------------------------------------------------
  const pageRows = Math.max(1, Math.floor((viewport.height - HEADER_HEIGHT) / ROW_HEIGHT) - 1);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isTextEntryTarget(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    const state = stateOf();
    const gridBounds = store.getBounds();
    const hasSelection = state.mode !== null;
    const lower = key.toLowerCase();

    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (mod && lower === "c") {
      if (!hasSelection) return;
      consume();
      onCopy?.({ format: event.shiftKey ? "tsv-headers" : "tsv", selection: state });
      return;
    }
    if (mod && lower === "v") {
      if (!editable || !onPaste) return;
      consume();
      const target = hasSelection ? state.focus : { row: 0, col: 0 };
      void readText().then((text) => {
        if (text) onPaste(target, text);
      });
      return;
    }
    if (mod && lower === "a") {
      consume();
      store.update((current) => selectAll(current, gridBounds));
      return;
    }
    if (mod && lower === "z") {
      if (!editable) return;
      consume();
      if (event.shiftKey) {
        if (canRedo) onRedo?.();
      } else if (canUndo) {
        onUndo?.();
      }
      return;
    }
    if (mod && lower === "y") {
      if (!editable || !canRedo) return;
      consume();
      onRedo?.();
      return;
    }
    if (mod && (key === "Home" || key === "End")) {
      consume();
      const target =
        key === "Home"
          ? { row: 0, col: 0 }
          : { row: gridBounds.rows - 1, col: gridBounds.cols - 1 };
      const next = focusAt(hasSelection ? state : EMPTY_SELECTION, target, gridBounds, event.shiftKey);
      store.set(next);
      ensureVisible(next.focus);
      return;
    }

    if (key === "Escape") {
      if (!hasSelection) return;
      consume();
      store.reset();
      return;
    }
    if ((key === "Delete" || key === "Backspace") && editable) {
      if (!hasSelection || !onClear) return;
      consume();
      onClear(state);
      return;
    }
    if (key === "F2" || (key === "Enter" && !mod)) {
      if (!hasSelection) return;
      consume();
      startEdit(state.focus);
      return;
    }
    if (key === "Tab") {
      if (!hasSelection) return;
      consume();
      const next = moveFocus(state, { row: 0, col: event.shiftKey ? -1 : 1 }, gridBounds, false);
      store.set(next);
      ensureVisible(next.focus);
      return;
    }

    const steps: Record<string, CellPoint> = {
      ArrowDown: { row: 1, col: 0 },
      ArrowUp: { row: -1, col: 0 },
      ArrowLeft: { row: 0, col: -1 },
      ArrowRight: { row: 0, col: 1 },
      PageDown: { row: pageRows, col: 0 },
      PageUp: { row: -pageRows, col: 0 },
      Home: { row: 0, col: -gridBounds.cols },
      End: { row: 0, col: gridBounds.cols },
    };
    const step = steps[key];
    if (!step) return;
    consume();
    if (!hasSelection) {
      const next = focusAt(EMPTY_SELECTION, { row: 0, col: 0 }, gridBounds, false);
      store.set(next);
      ensureVisible(next.focus);
      return;
    }
    const delta = mod
      ? {
          row: step.row === 0 ? 0 : Math.sign(step.row) * gridBounds.rows,
          col: step.col === 0 ? 0 : Math.sign(step.col) * gridBounds.cols,
        }
      : step;
    const next = moveFocus(state, delta, gridBounds, event.shiftKey);
    store.set(next);
    ensureVisible(next.focus);
  };

  // ---- 对外 API -----------------------------------------------------------
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      getSelection: () => store.getSnapshot(),
      getFocus: () => (store.getSnapshot().mode === null ? null : store.getSnapshot().focus),
      selectAll: () => store.update((current, gridBounds) => selectAll(current, gridBounds)),
      moveFocus: (delta) => {
        const next = moveFocus(store.getSnapshot(), delta, store.getBounds(), false);
        store.set(next);
        ensureVisible(next.focus);
      },
      focus: () => containerRef.current?.focus({ preventScroll: true }),
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, ensureVisible, store]);

  const overlayWindow = useMemo(
    () => ({
      firstRow: Math.max(0, Math.floor((scroll.top - HEADER_HEIGHT) / ROW_HEIGHT) - 2),
      lastRow: Math.min(
        Math.max(0, rows.length - 1),
        Math.ceil((scroll.top + viewport.height - HEADER_HEIGHT) / ROW_HEIGHT) + 2,
      ),
      firstCol: visibleColumns[0] ?? 0,
      lastCol: visibleColumns[visibleColumns.length - 1] ?? 0,
    }),
    [rows.length, scroll.top, viewport.height, visibleColumns],
  );

  const editingPosition = editingCell
    ? {
        left: GUTTER_WIDTH + (starts[editingCell.col] ?? 0),
        top: HEADER_HEIGHT + editingCell.row * ROW_HEIGHT,
        width: widths[editingCell.col] ?? MIN_COL_WIDTH,
      }
    : null;

  return (
    <div className={cn("relative h-full min-h-0", className)}>
      <div
        ref={containerRef}
        role="grid"
        aria-label={t("数据网格")}
        aria-rowcount={rows.length}
        aria-colcount={columns.length}
        aria-readonly={!editable}
        tabIndex={0}
        onScroll={onScroll}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        className="ops-scroll relative h-full overflow-auto bg-surface-1 font-mono text-12 outline-none select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <div style={{ width, height: totalHeight, position: "relative" }}>
          {/* 表头 */}
          <div
            className="sticky top-0 z-30 bg-surface-2"
            style={{ width, height: HEADER_HEIGHT }}
          >
            <div
              className="sticky left-0 top-0 z-10 flex items-center justify-center border-b border-r border-line bg-surface-2 text-10 text-fg-subtle"
              style={{ width: GUTTER_WIDTH, height: HEADER_HEIGHT }}
              title={t("全选（Ctrl+A）")}
            >
              #
            </div>
            {visibleColumns.map((index) => {
              const column = columns[index];
              if (!column) return null;
              const active = sortColumn === column.name;
              return (
                <div
                  key={index}
                  role="columnheader"
                  className="absolute flex select-none flex-col justify-center border-b border-r border-line px-2"
                  style={{
                    left: GUTTER_WIDTH + (starts[index] ?? 0),
                    top: 0,
                    width: widths[index],
                    height: HEADER_HEIGHT,
                  }}
                  onContextMenu={(event) => {
                    // 列头有独立 handler（容器那层会被 stopPropagation 掉），
                    // 所以这里同样要先把选择切到该列。
                    event.stopPropagation();
                    ensureSelectionFor({ kind: "columnHeader", col: index });
                    onColumnContextMenu?.(index, event);
                  }}
                >
                  <div className="flex min-w-0 items-center gap-1">
                    <span
                      className="truncate text-12 font-medium text-fg"
                      title={`${column.name} · ${column.type_name}${column.primary_key ? " · PK" : ""}`}
                    >
                      {column.name}
                    </span>
                    {column.primary_key && (
                      <span className="shrink-0 rounded-[3px] bg-accent/15 px-1 text-[9px] text-accent">
                        PK
                      </span>
                    )}
                    <button
                      type="button"
                      data-sort-button
                      aria-label={t("排序")}
                      className={cn(
                        "ml-auto shrink-0 rounded px-1 text-11 leading-none",
                        active ? "text-accent" : "text-fg-subtle hover:text-fg",
                      )}
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSort?.(column);
                      }}
                    >
                      {active ? (sortDirection === "desc" ? "↓" : "↑") : "⇅"}
                    </button>
                  </div>
                  <span className="truncate text-11 font-normal text-fg-subtle">
                    {column.type_name}
                    {column.unsigned ? " UNSIGNED" : ""}
                    {column.nullable ? "" : " NOT NULL"}
                  </span>
                  <span
                    className="absolute right-0 top-0 h-full w-[5px] cursor-col-resize hover:bg-accent/20"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setResizing({
                        col: index,
                        startX: event.clientX,
                        startWidth: widths[index],
                      });
                    }}
                  />
                </div>
              );
            })}
            <ColumnSelectionOverlay
              store={store}
              starts={starts}
              widths={widths}
              gutterWidth={GUTTER_WIDTH}
              headerHeight={HEADER_HEIGHT}
              firstCol={overlayWindow.firstCol}
              lastCol={overlayWindow.lastCol}
            />
          </div>

          {visibleRows.map((rowIndex) => {
            const row = rows[rowIndex];
            if (!row) return null;
            return (
              <GridRow
                key={rowIndex}
                rowIndex={rowIndex}
                displayIndex={rowOffset + rowIndex + 1}
                row={row}
                columns={columns}
                widths={widths}
                starts={starts}
                visibleColumns={visibleColumns}
                width={width}
                deleted={deletedRows?.has(rowIndex) ?? false}
                modifiedCells={modifiedCells}
              />
            );
          })}

          <SelectionOverlay
            store={store}
            window={overlayWindow}
            starts={starts}
            widths={widths}
            rowHeight={ROW_HEIGHT}
            headerHeight={HEADER_HEIGHT}
            gutterWidth={GUTTER_WIDTH}
          />

          {editingCell && editingPosition && (
            <div
              data-cell-editor
              className="absolute z-[28]"
              style={{
                left: editingPosition.left,
                top: editingPosition.top,
                width: editingPosition.width,
                height: ROW_HEIGHT,
              }}
            >
              <input
                autoFocus
                value={editingValue}
                aria-label={columns[editingCell.col]?.name ?? t("编辑单元格")}
                className="h-full w-full min-w-0 rounded-[3px] border border-accent bg-surface-1 px-1 font-mono text-12 text-fg outline-none"
                onChange={(event) => onEditingValueChange?.(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onCommitEdit?.(editingCell, "down");
                  } else if (event.key === "Tab") {
                    event.preventDefault();
                    onCommitEdit?.(editingCell, event.shiftKey ? "left" : "right");
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    suppressBlur.current = true;
                    onCancelEdit?.();
                  }
                }}
                onBlur={() => {
                  if (suppressBlur.current) {
                    suppressBlur.current = false;
                    return;
                  }
                  onCommitEdit?.(editingCell, null);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
