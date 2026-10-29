/**
 * 从剪贴板粘贴 TSV/表格文本 → **先产出变更计划**，由调用方预览后再并入
 * 待提交修改队列。
 *
 * 为什么两步：粘贴是最容易"一次改错很多格"的操作。任何超出范围、类型不符、
 * 只读列、不可定位的行都必须先被统计出来给人看，而不是静默丢弃或静默写入。
 *
 * 本模块是纯函数，不读剪贴板、不写 React 状态、不访问数据库。
 */
import type { AssignValue } from "@/api/types/database";
import type { CellPoint } from "./selection";

export interface PasteColumn {
  name: string;
  /** 数据库原生类型名（`data_type`）。 */
  dataType: string;
  nullable: boolean;
}

export type PasteSkipReason = "read_only" | "type_mismatch" | "row_not_mutable";

export interface PasteCell {
  row: number;
  col: number;
  value: AssignValue;
}

export interface PasteSkip {
  row: number;
  col: number;
  column: string;
  reason: PasteSkipReason;
}

export interface PastePlan {
  cells: PasteCell[];
  skipped: PasteSkip[];
  /** 有改动（至少一格可写）的行数。 */
  rows: number;
  /** 有改动的列数。 */
  cols: number;
  /** 超出已加载范围被丢掉的单元格数（不当作错误，但要告诉用户）。 */
  clipped: number;
}

/** MySQL / DBeaver 的 NULL 约定：`\N` 永远是 NULL。 */
export const PASTE_NULL_TOKEN = "\\N";

const NUMERIC_TYPES =
  /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)\b/i;
const BIT_TYPES = /^bit\b/i;
const DATE_TYPE = /^date$/i;
const DATETIME_TYPE = /^(datetime|timestamp)$/i;
const TIME_TYPE = /^time$/i;
const YEAR_TYPE = /^year$/i;
const TEXTUAL_TYPES =
  /^(char|varchar|tinytext|text|mediumtext|longtext|enum|set|json|jsonb|uuid|inet|xml)\b/i;
const READ_ONLY_TYPES = /bit|blob|binary|geometry/i;

const NUMERIC_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?$/;
const TIME_RE = /^-?\d{1,3}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/;
const YEAR_RE = /^\d{4}$/;
const BIT_RE = /^[01]+$|^\d+$/;

export function isReadOnlyColumn(dataType: string): boolean {
  return READ_ONLY_TYPES.test(dataType);
}

/**
 * 解析剪贴板表格：支持 Excel/WPS 的 TSV（含 `"` 引号包住含制表符/换行的
 * 字段、`""` 转义），CRLF/LF/CR 混排，尾部换行不产生空行。
 */
export function parseClipboardMatrix(text: string): string[][] {
  if (text === "") return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === "\t") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 单个文本 → 赋值；类型不符返回 null（调用方记为 `type_mismatch`）。 */
export function parsePasteValue(text: string, column: PasteColumn): AssignValue | null {
  if (text === PASTE_NULL_TOKEN) return { kind: "null" };
  const type = column.dataType;
  if (TEXTUAL_TYPES.test(type)) {
    // 文本列里的 "NULL" 就是字符串本身，只有 `\N` 表示 NULL。
    return { kind: "value", value: text };
  }
  const trimmed = text.trim();
  if (trimmed.toUpperCase() === "NULL") return { kind: "null" };
  // 非文本列的空串只能解释成 NULL；NOT NULL 列直接拒绝，别让数据库去截断。
  if (trimmed === "") return column.nullable ? { kind: "null" } : null;
  if (NUMERIC_TYPES.test(type)) {
    return NUMERIC_RE.test(trimmed) ? { kind: "value", value: trimmed } : null;
  }
  if (BIT_TYPES.test(type)) {
    return BIT_RE.test(trimmed) ? { kind: "value", value: trimmed } : null;
  }
  if (DATE_TYPE.test(type)) {
    return DATE_RE.test(trimmed) ? { kind: "value", value: trimmed } : null;
  }
  if (DATETIME_TYPE.test(type)) {
    return DATETIME_RE.test(trimmed) ? { kind: "value", value: trimmed } : null;
  }
  if (TIME_TYPE.test(type)) {
    return TIME_RE.test(trimmed) ? { kind: "value", value: trimmed } : null;
  }
  if (YEAR_TYPE.test(type)) {
    return YEAR_RE.test(trimmed) ? { kind: "value", value: trimmed } : null;
  }
  return { kind: "value", value: text };
}

export interface PastePlanInput {
  matrix: string[][];
  /** 粘贴起点（当前焦点单元格）。 */
  start: CellPoint;
  columns: PasteColumn[];
  /** 已加载行数；超出的行列会被计入 `clipped`，绝不扩展到整表。 */
  rowCount: number;
  /** 该行能否定位（有可靠唯一键）；不能定位的行整行跳过。 */
  isRowMutable?: (row: number) => boolean;
}

export function planPaste({
  matrix,
  start,
  columns,
  rowCount,
  isRowMutable,
}: PastePlanInput): PastePlan {
  const cells: PasteCell[] = [];
  const skipped: PasteSkip[] = [];
  let clipped = 0;
  const touchedRows = new Set<number>();
  const touchedCols = new Set<number>();

  for (let offsetRow = 0; offsetRow < matrix.length; offsetRow += 1) {
    const row = start.row + offsetRow;
    const sourceRow = matrix[offsetRow] ?? [];
    if (row >= rowCount) {
      clipped += sourceRow.length;
      continue;
    }
    if (isRowMutable && !isRowMutable(row)) {
      for (let offsetCol = 0; offsetCol < sourceRow.length; offsetCol += 1) {
        const col = start.col + offsetCol;
        if (col >= columns.length) {
          clipped += 1;
          continue;
        }
        skipped.push({
          row,
          col,
          column: columns[col]?.name ?? "",
          reason: "row_not_mutable",
        });
      }
      continue;
    }
    for (let offsetCol = 0; offsetCol < sourceRow.length; offsetCol += 1) {
      const col = start.col + offsetCol;
      if (col >= columns.length) {
        clipped += 1;
        continue;
      }
      const column = columns[col];
      if (!column) {
        clipped += 1;
        continue;
      }
      if (isReadOnlyColumn(column.dataType)) {
        skipped.push({ row, col, column: column.name, reason: "read_only" });
        continue;
      }
      const value = parsePasteValue(sourceRow[offsetCol] ?? "", column);
      if (!value) {
        skipped.push({ row, col, column: column.name, reason: "type_mismatch" });
        continue;
      }
      cells.push({ row, col, value });
      touchedRows.add(row);
      touchedCols.add(col);
    }
  }

  return {
    cells,
    skipped,
    rows: touchedRows.size,
    cols: touchedCols.size,
    clipped,
  };
}
