/**
 * 结果/表数据网格：行虚拟化 + 列虚拟化。
 *
 * 为什么自己写而不是引一个库：项目的表格只需要"只读展示 + 选中 + 复制 +
 * 排序 + 列宽"，引入 300 KB 的表格库不值当；这里 300 行就能把可见范围
 * 严格限制在视口内。
 *
 * **滚动不重建结果**：`rows` 数组是稳定的，滚动只更新 `scrollTop/Left`，
 * 渲染的仍是同一批行对象，只是索引窗口变了。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DbColumn, DbValue } from "@/api/types/database";
import { cn } from "@/lib/cn";

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 36;
const GUTTER_WIDTH = 56;
const OVERSCAN_ROWS = 8;
const MIN_COL_WIDTH = 72;
const MAX_COL_WIDTH = 420;

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

export interface CellAddress {
  row: number;
  col: number;
}

interface VirtualDataGridProps {
  columns: DbColumn[];
  rows: DbValue[][];
  /** 行号从 1 开始的偏移（分页时显示全局行号）。 */
  rowOffset?: number;
  selectedRow: number | null;
  selectedCell: CellAddress | null;
  onSelectRow: (row: number) => void;
  onSelectCell: (cell: CellAddress) => void;
  onOpenCell?: (cell: CellAddress) => void;
  onSort?: (column: DbColumn) => void;
  sortColumn?: string | null;
  sortDirection?: "asc" | "desc" | null;
  /** 有可靠键时才允许双击详情/修改。 */
  canResolveRows?: boolean;
  className?: string;
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

function initialWidths(columns: DbColumn[]): number[] {
  return columns.map((column) =>
    Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, columnHint(column))),
  );
}

export const VirtualDataGrid = memo(function VirtualDataGrid({
  columns,
  rows,
  rowOffset = 0,
  selectedRow,
  selectedCell,
  onSelectRow,
  onSelectCell,
  onOpenCell,
  onSort,
  sortColumn,
  sortDirection,
  canResolveRows = false,
  className,
}: VirtualDataGridProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns));
  const [resizing, setResizing] = useState<{ col: number; startX: number; startWidth: number } | null>(
    null,
  );

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
        current.map((width, index) =>
          index === resizing.col
            ? Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, resizing.startWidth + delta))
            : width,
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
    let cursor = GUTTER_WIDTH;
    for (const width of widths) {
      result.push(cursor);
      cursor += width;
    }
    return result;
  }, [widths]);

  const totalWidth = useMemo(
    () => GUTTER_WIDTH + widths.reduce((sum, width) => sum + width, 0),
    [widths],
  );
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

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className={cn(
        "ops-scroll relative h-full min-h-0 overflow-auto bg-surface-1 font-mono text-11",
        className,
      )}
    >
      <div style={{ width: totalWidth, height: totalHeight, position: "relative" }}>
        {/* header */}
        <div
          className="sticky top-0 z-20 bg-surface-2"
          style={{ width: totalWidth, height: HEADER_HEIGHT }}
        >
          <div
            className="absolute flex items-center justify-end border-b border-r border-line px-2 text-10 text-fg-subtle"
            style={{ left: 0, top: 0, width: GUTTER_WIDTH, height: HEADER_HEIGHT }}
          >
            #
          </div>
          {visibleColumns.map((index) => {
            const column = columns[index];
            const active = sortColumn === column.name;
            return (
              <div
                key={index}
                className="absolute flex select-none flex-col justify-center border-b border-r border-line px-2"
                style={{
                  left: starts[index],
                  top: 0,
                  width: widths[index],
                  height: HEADER_HEIGHT,
                }}
                onDoubleClick={() => onSort?.(column)}
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1 text-left"
                  onClick={() => onSort?.(column)}
                  title={`${column.name} · ${column.type_name}${column.primary_key ? " · PK" : ""}`}
                >
                  <span className="truncate text-11 font-medium text-fg">{column.name}</span>
                  {column.primary_key && (
                    <span className="shrink-0 rounded-[3px] bg-accent/15 px-1 text-[9px] text-accent">
                      PK
                    </span>
                  )}
                  {active && (
                    <span className="shrink-0 text-accent">
                      {sortDirection === "desc" ? "↓" : "↑"}
                    </span>
                  )}
                </button>
                <span className="truncate text-[9px] font-normal text-fg-subtle">
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
        </div>

        {visibleRows.map((rowIndex) => {
          const row = rows[rowIndex];
          if (!row) return null;
          const selected = selectedRow === rowIndex;
          return (
            <div
              key={rowIndex}
              className={cn(
                "absolute w-full",
                selected ? "bg-accent/10" : rowIndex % 2 === 0 ? "bg-transparent" : "bg-surface-2/40",
              )}
              style={{
                top: HEADER_HEIGHT + rowIndex * ROW_HEIGHT,
                height: ROW_HEIGHT,
                width: totalWidth,
              }}
              onMouseDown={() => onSelectRow(rowIndex)}
            >
              <div
                className={cn(
                  "absolute flex cursor-default items-center justify-end border-b border-r border-line/60 px-2 text-10",
                  selected ? "text-accent" : "text-fg-subtle",
                )}
                style={{ left: 0, top: 0, width: GUTTER_WIDTH, height: ROW_HEIGHT }}
              >
                {(rowOffset + rowIndex + 1).toLocaleString()}
              </div>
              {visibleColumns.map((colIndex) => {
                const value = row[colIndex] ?? { kind: "null" as const };
                const display = cellText(value);
                const cellSelected =
                  selectedCell?.row === rowIndex && selectedCell?.col === colIndex;
                return (
                  <div
                    key={colIndex}
                    role="gridcell"
                    className={cn(
                      "absolute flex items-center overflow-hidden border-b border-r border-line/40 px-2",
                      cellSelected && "ring-1 ring-inset ring-accent/70",
                      value.kind === "null" && "text-fg-subtle",
                    )}
                    style={{
                      left: starts[colIndex],
                      top: 0,
                      width: widths[colIndex],
                      height: ROW_HEIGHT,
                    }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      onSelectRow(rowIndex);
                      onSelectCell({ row: rowIndex, col: colIndex });
                    }}
                    onDoubleClick={() => onOpenCell?.({ row: rowIndex, col: colIndex })}
                    title={
                      value.kind === "text" && value.truncated
                        ? t("预览已截断，双击查看完整值")
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
        })}

        {rows.length === 0 && (
          <div
            className="absolute flex items-center justify-center text-12 text-fg-subtle"
            style={{ left: 0, top: HEADER_HEIGHT, width: totalWidth, height: 80 }}
          >
            {t("没有数据")}
          </div>
        )}
      </div>

      {!canResolveRows && rows.length > 0 && (
        <div className="pointer-events-none sticky bottom-0 left-0 z-10 w-fit bg-surface-2/90 px-2 py-0.5 text-[10px] text-fg-subtle">
          {t("无可靠唯一键：只能查看，不能重新读取完整字段")}
        </div>
      )}
    </div>
  );
});
