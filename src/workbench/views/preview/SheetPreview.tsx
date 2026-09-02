import { useEffect, useMemo, useState } from "react";
import type { SheetTable } from "@/lib/preview/xlsx";
import { cn } from "@/lib/cn";

const PAGE = 300;

/**
 * Spreadsheet preview: one sheet at a time, first row treated as the header.
 *
 * Rendering is paged (300 rows) because a workbook can legally hold a million
 * rows; putting them all in the DOM would freeze the window. Cells are plain
 * strings — formulas are already resolved to their cached values by the parser.
 */
export function SheetPreview({ sheets }: { sheets: SheetTable[] }) {
  const [index, setIndex] = useState(0);
  const [limit, setLimit] = useState(PAGE);

  // A different workbook resets both: the previous sheet index and row count
  // belong to the file that is no longer open.
  useEffect(() => {
    setIndex(0);
    setLimit(PAGE);
  }, [sheets]);

  const sheet = sheets[Math.min(index, sheets.length - 1)];
  const visible = useMemo(() => sheet?.rows.slice(0, limit) ?? [], [sheet, limit]);
  if (!sheet) return null;

  const [header, ...body] = visible;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sheets.length > 1 && (
        <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
          {sheets.map((item, itemIndex) => (
            <button
              key={`${item.name}-${itemIndex}`}
              type="button"
              className={cn(
                "shrink-0 rounded-[6px] px-2 py-0.5 text-11",
                itemIndex === index
                  ? "bg-accent/15 text-fg"
                  : "text-fg-muted hover:bg-surface-hover hover:text-fg",
              )}
              onClick={() => {
                setIndex(itemIndex);
                setLimit(PAGE);
              }}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-separate border-spacing-0 text-11">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 w-10 border-b border-r border-line bg-surface-2 px-1.5 py-1 text-10 font-normal text-fg-subtle" />
              {header.map((cell, cellIndex) => (
                <th
                  key={cellIndex}
                  className="sticky top-0 z-10 min-w-[90px] border-b border-r border-line bg-surface-2 px-2 py-1 text-left font-semibold text-fg"
                >
                  {cell === "" ? columnName(cellIndex) : cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-surface-hover/50">
                <td className="sticky left-0 z-10 border-b border-r border-line bg-surface-1 px-1.5 py-1 text-10 tabular-nums text-fg-subtle">
                  {rowIndex + 2}
                </td>
                {header.map((_, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="max-w-[320px] truncate border-b border-r border-line px-2 py-1 text-fg-muted"
                    title={row[cellIndex] ?? ""}
                  >
                    {row[cellIndex] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {body.length < sheet.rows.length && (
          <div className="p-2">
            <button
              type="button"
              className="rounded-[6px] px-2 py-1 text-11 text-fg-muted hover:bg-surface-hover hover:text-fg"
              onClick={() => setLimit((current) => current + PAGE)}
            >
              继续显示后 {Math.min(PAGE, sheet.rows.length - body.length)} 行（共{" "}
              {sheet.rows.length.toLocaleString()} 行）
            </button>
          </div>
        )}
      </div>

      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line px-2 text-10 text-fg-subtle">
        <span>
          {sheet.rows.length.toLocaleString()} 行 × {(sheet.rows[0]?.length ?? 0).toLocaleString()} 列
        </span>
        {sheet.truncatedRows > 0 && (
          <span className="text-warning">另有 {sheet.truncatedRows.toLocaleString()} 行未渲染</span>
        )}
      </div>
    </div>
  );
}

/** Excel-style column labels for empty header cells (`A`, `B`, … `AA`). */
function columnName(index: number): string {
  let name = "";
  let value = index;
  do {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name;
}
