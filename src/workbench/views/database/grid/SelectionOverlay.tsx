/**
 * 选择覆盖层：只画矩形，不参与单元格渲染。
 *
 * 这是"选择变化不重渲染数据"的关键——行/列内容与选择状态完全解耦，
 * 拖动选择时只有这个组件重渲染（几十个 div），可见行一个都不动。
 *
 * 所有矩形都按**已渲染窗口**裁剪：跨可视区域的选择只画落在窗口内的部分，
 * 滚动时窗口变化自然补齐（未渲染的行本来就没有 DOM）。
 */
import type { ReactElement } from "react";
import { cn } from "@/lib/cn";
import { useSelectionSnapshot, type SelectionStore } from "./selection-store";
import { liveRange } from "./selection";

export interface OverlayWindow {
  firstRow: number;
  lastRow: number;
  /** 内容坐标（含行号列偏移前）的可见列范围。 */
  firstCol: number;
  lastCol: number;
}

interface SelectionOverlayProps {
  store: SelectionStore;
  window: OverlayWindow;
  starts: number[];
  widths: number[];
  rowHeight: number;
  headerHeight: number;
  gutterWidth: number;
}

export function SelectionOverlay({
  store,
  window: view,
  starts,
  widths,
  rowHeight,
  headerHeight,
  gutterWidth,
}: SelectionOverlayProps) {
  const selection = useSelectionSnapshot(store);
  if (selection.mode === null) return null;

  const rects: ReactElement[] = [];
  selection.ranges.forEach((range, index) => {
    const top = Math.max(range.top, view.firstRow);
    const bottom = Math.min(range.bottom, view.lastRow);
    const left = Math.max(range.left, view.firstCol);
    const right = Math.min(range.right, view.lastCol);
    if (top > bottom || left > right) return;
    const x = gutterWidth + (starts[left] ?? 0);
    const width = Math.max(
      2,
      (starts[right] ?? 0) + (widths[right] ?? 0) - (starts[left] ?? 0),
    );
    rects.push(
      <div
        key={`range-${index}`}
        className="pointer-events-none absolute z-20 border border-grid-selection-border bg-grid-selection"
        style={{
          left: x,
          top: headerHeight + top * rowHeight,
          width,
          height: (bottom - top + 1) * rowHeight,
        }}
      />,
    );
    // 整行选择时行号列一起高亮，避免"选中了但看不出从哪一行开始"。
    if (selection.mode === "row") {
      rects.push(
        <div
          key={`gutter-${index}`}
          className="pointer-events-none absolute z-[26] border-y border-r border-grid-selection-border bg-grid-selection"
          style={{
            left: 0,
            top: headerHeight + top * rowHeight,
            width: gutterWidth,
            height: (bottom - top + 1) * rowHeight,
          }}
        />,
      );
    }
  });

  const focus = selection.focus;
  const showFocus =
    focus.row >= view.firstRow &&
    focus.row <= view.lastRow &&
    focus.col >= view.firstCol &&
    focus.col <= view.lastCol &&
    liveRange(selection) !== null;

  return (
    <>
      {rects}
      {showFocus && (
        <div
          className="pointer-events-none absolute z-[21] border-2 border-accent"
          style={{
            left: gutterWidth + (starts[focus.col] ?? 0),
            top: headerHeight + focus.row * rowHeight,
            width: Math.max(2, widths[focus.col] ?? 0),
            height: rowHeight,
          }}
        />
      )}
    </>
  );
}

/**
 * 提交结果的行级瞬态底色（已提交=绿、失败=红）。
 *
 * 同样走覆盖层：只画几条带子，行内容一个都不重渲染。
 * 只画窗口内的行，滚出去再滚回来也正确（索引不变）。
 */
export function RowToneOverlay({
  tones,
  window: view,
  rowHeight,
  headerHeight,
  width,
}: {
  tones: { index: number; tone: "committed" | "failed" }[];
  window: OverlayWindow;
  rowHeight: number;
  headerHeight: number;
  width: number;
}) {
  if (tones.length === 0) return null;
  return (
    <>
      {tones
        .filter((row) => row.index >= view.firstRow && row.index <= view.lastRow)
        .map((row) => (
          <div
            key={`tone-${row.index}`}
            className={cn(
              "pointer-events-none absolute left-0 z-[19]",
              row.tone === "committed" ? "bg-success/10" : "bg-danger/12",
            )}
            style={{
              top: headerHeight + row.index * rowHeight,
              height: rowHeight,
              width,
            }}
          />
        ))}
    </>
  );
}

interface ColumnSelectionOverlayProps {
  store: SelectionStore;
  starts: number[];
  widths: number[];
  gutterWidth: number;
  headerHeight: number;
  firstCol: number;
  lastCol: number;
}

/** 列头选中态：只在整列选择时出现。 */
export function ColumnSelectionOverlay({
  store,
  starts,
  widths,
  gutterWidth,
  headerHeight,
  firstCol,
  lastCol,
}: ColumnSelectionOverlayProps) {
  const selection = useSelectionSnapshot(store);
  if (selection.mode !== "column") return null;
  return (
    <>
      {selection.ranges.map((range, index) => {
        const left = Math.max(range.left, firstCol);
        const right = Math.min(range.right, lastCol);
        if (left > right) return null;
        return (
          <div
            key={index}
            className="pointer-events-none absolute inset-y-0 z-10 border-b-2 border-grid-selection-border bg-grid-selection"
            style={{
              left: gutterWidth + (starts[left] ?? 0),
              width: Math.max(
                2,
                (starts[right] ?? 0) + (widths[right] ?? 0) - (starts[left] ?? 0),
              ),
              height: headerHeight,
            }}
          />
        );
      })}
    </>
  );
}
