/**
 * 把选中区域序列化成剪贴板文本（TSV / CSV / JSON / SQL INSERT）。
 *
 * 三条硬约束：
 * 1. **NULL 与空字符串必须可区分**：分隔符格式里 NULL 输出为空（不加引号），
 *    空字符串输出为 `""`（显式引号）——这是 PostgreSQL COPY 的约定，Excel/WPS
 *    粘贴后都是空单元格，但在文本层面可区分，且不需要发明 `NULL` 之类的
 *    假值（会和真实文本 `NULL` 混淆）。
 * 2. **精度不丢**：整数/DECIMAL 在协议层就是字符串（见 `api/types/database`），
 *    这里原样输出，绝不 `Number()`；JSON 里也保持字符串。
 * 3. **不冒充完整数据**：截断的大字段原样输出并在 `issues` 里报告；截断的
 *    二进制输出显式占位符；二进制/不支持类型不允许生成 INSERT。
 *
 * 复制只读取**已加载**的行，永不触发查询。
 */
import type { DbColumn, DbValue } from "@/api/types/database";
import type { SelectionRange, SelectionState } from "./selection";

export type CopyFormat = "tsv" | "csv" | "json" | "insert";

export interface CopyTableRef {
  database: string;
  table: string;
}

export interface CopyRequest {
  columns: DbColumn[];
  rows: DbValue[][];
  selection: SelectionState;
  format: CopyFormat;
  /** 分隔符格式是否带列名（Ctrl+Shift+C）。 */
  includeHeaders?: boolean;
  /** 只有表名与字段名可靠时才传；传了才提供 INSERT。 */
  table?: CopyTableRef | null;
  /** 字符预算（默认见 `DEFAULT_COPY_CHAR_BUDGET`）。 */
  maxChars?: number;
}

export type CopyIssueCode = "truncated" | "binary" | "unsupported";

export interface CopyIssue {
  code: CopyIssueCode;
  cells: number;
}

export type CopyBlockedReason = "empty" | "too_large" | "no_target" | "unsafe_values";

export type CopyResult =
  | {
      ok: true;
      text: string;
      chars: number;
      rows: number;
      cells: number;
      issues: CopyIssue[];
      /**
       * 不是"完整原值"的单元格数（截断预览 / 不支持类型）。
       * 未截断的二进制是**无损** base64，不算在内；它仍会出现在 `issues.binary`
       * 里，因为往文本剪贴板里放二进制本身值得提示。
       */
      partialCells: number;
    }
  | { ok: false; reason: CopyBlockedReason; chars: number };

/** 约 4M 字符 ≈ 8 MB 内存：再大就让用户走导出，避免卡死 WebView。 */
export const DEFAULT_COPY_CHAR_BUDGET = 4_000_000;

/** 每写这么多字符就让出一次事件循环，避免长任务冻结界面。 */
const YIELD_EVERY_CHARS = 200_000;

interface CopyField {
  text: string;
  isNull: boolean;
  truncated: boolean;
  binary: boolean;
  unsupported: boolean;
}

/** 单元格 → 复制用的文本字段（与展示文本不同：不美化、不加省略号）。 */
export function copyField(value: DbValue | undefined): CopyField {
  if (!value) {
    return { text: "", isNull: true, truncated: false, binary: false, unsupported: false };
  }
  switch (value.kind) {
    case "null":
      return { text: "", isNull: true, truncated: false, binary: false, unsupported: false };
    case "int":
    case "decimal":
      return { text: value.value, isNull: false, truncated: false, binary: false, unsupported: false };
    case "float":
      return {
        text: String(value.value),
        isNull: false,
        truncated: false,
        binary: false,
        unsupported: false,
      };
    case "date":
    case "date_time":
    case "time":
      return { text: value.value, isNull: false, truncated: false, binary: false, unsupported: false };
    case "bit":
      return { text: value.value, isNull: false, truncated: false, binary: false, unsupported: false };
    case "text":
    case "json":
      return {
        text: value.value,
        isNull: false,
        truncated: value.truncated,
        binary: false,
        unsupported: false,
      };
    case "binary":
      return {
        // 截断的 base64 是**有损**的：宁可给一个明显的占位符，也不输出半个 payload。
        text: value.truncated
          ? `[binary ${value.bytes} B truncated]`
          : `base64:${value.base64}`,
        isNull: false,
        truncated: value.truncated,
        binary: true,
        unsupported: false,
      };
    case "unsupported":
      return {
        text: `[${value.type_name} ${value.bytes} B]`,
        isNull: false,
        truncated: false,
        binary: false,
        unsupported: true,
      };
  }
}

/** 分隔符字段：NULL→空、空字符串→`""`、含分隔符/引号/换行→整体加引号并双写引号。 */
export function delimitedField(field: CopyField, delimiter: "\t" | ","): string {
  if (field.isNull) return "";
  if (field.text === "") return '""';
  const text = field.text;
  const needsQuotes =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r");
  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** 列名去重：`SELECT a.id, b.id` 复制成 JSON 时不能互相覆盖。 */
export function uniqueColumnNames(columns: readonly DbColumn[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((column) => {
    const base = column.name || `column_${column.index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function isNumericType(dataType: string): boolean {
  return /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)\b/i.test(
    dataType,
  );
}

const NUMERIC_LITERAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

function sqlLiteral(field: CopyField, dataType: string): string | null {
  if (field.isNull) return "NULL";
  if (field.binary || field.unsupported || field.truncated) return null;
  if (isNumericType(dataType) && NUMERIC_LITERAL.test(field.text)) return field.text;
  // MySQL/MariaDB 方言（当前唯一适配器）：反斜杠是转义符，必须先转义。
  return `'${field.text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function collectIssues(field: CopyField, issues: Map<CopyIssueCode, number>): void {
  if (field.truncated) issues.set("truncated", (issues.get("truncated") ?? 0) + 1);
  if (field.binary) issues.set("binary", (issues.get("binary") ?? 0) + 1);
  if (field.unsupported) issues.set("unsupported", (issues.get("unsupported") ?? 0) + 1);
}

/** 复制结果太大时立刻停下：先把钱花在检查预算上，而不是先拼完再判断。 */
class BudgetExceeded extends Error {}

interface Builder {
  chunks: string[];
  chars: number;
  rows: number;
  cells: number;
  /** 截断预览 / 不支持类型的单元格数（不完整的复制内容）。 */
  partial: number;
}

function assertBudget(builder: Builder, limit: number): void {
  if (builder.chars > limit) throw new BudgetExceeded();
}

function push(builder: Builder, text: string): void {
  builder.chunks.push(text);
  builder.chars += text.length;
}

function* blockRows(range: SelectionRange): Generator<{ row: number; range: SelectionRange }> {
  for (let row = range.top; row <= range.bottom; row += 1) {
    yield { row, range };
  }
}

const nextTick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * 生成复制文本。异步是因为大区域要分片让出主线程；小区域只走一次循环，
 * 不会引入可见延迟。
 */
export async function buildCopyText(request: CopyRequest): Promise<CopyResult> {
  const { columns, rows, selection, format } = request;
  const limit = request.maxChars ?? DEFAULT_COPY_CHAR_BUDGET;
  const ranges = selection.mode === null ? [] : selection.ranges;
  if (ranges.length === 0) return { ok: false, reason: "empty", chars: 0 };
  if (columns.length === 0) return { ok: false, reason: "empty", chars: 0 };

  const insertTable = request.table ?? null;
  const columnNames = uniqueColumnNames(columns);

  if (format === "insert") {
    if (!insertTable) return { ok: false, reason: "no_target", chars: 0 };
    const mismatched = columns.some(
      (column) => column.org_table !== "" && column.org_table !== insertTable.table,
    );
    if (mismatched) return { ok: false, reason: "no_target", chars: 0 };
  }

  const builder: Builder = { chunks: [], chars: 0, rows: 0, cells: 0, partial: 0 };
  const issues = new Map<CopyIssueCode, number>();
  const jsonDocs: string[] = [];
  const insertRows: string[] = [];
  const delimiter: "\t" | "," = format === "csv" ? "," : "\t";
  let lastYield = 0;

  try {
    for (const range of ranges) {
      if (
        (format === "tsv" || format === "csv") &&
        request.includeHeaders &&
        builder.rows === 0 &&
        range === ranges[0]
      ) {
        const labels: CopyField[] = [];
        for (let col = range.left; col <= range.right; col += 1) {
          labels.push({
            text: columnNames[col] ?? `column_${col + 1}`,
            isNull: false,
            truncated: false,
            binary: false,
            unsupported: false,
          });
        }
        push(builder, `${labels.map((label) => delimitedField(label, delimiter)).join(delimiter)}\n`);
      }

      for (const { row } of blockRows(range)) {
        const values = rows[row] ?? [];
        const fields: CopyField[] = [];
        for (let col = range.left; col <= range.right; col += 1) {
          const field = copyField(values[col]);
          collectIssues(field, issues);
          if (field.truncated || field.unsupported) builder.partial += 1;
          fields.push(field);
        }
        builder.cells += fields.length;
        builder.rows += 1;

        if (format === "tsv" || format === "csv") {
          push(
            builder,
            `${fields.map((field) => delimitedField(field, delimiter)).join(delimiter)}\n`,
          );
        } else if (format === "json") {
          const doc: Record<string, string | null> = {};
          fields.forEach((field, index) => {
            doc[columnNames[range.left + index] ?? `column_${range.left + index + 1}`] =
              field.isNull ? null : field.text;
          });
          const line = JSON.stringify(doc);
          jsonDocs.push(line);
          builder.chars += line.length;
        } else {
          const literals = fields.map((field, index) =>
            sqlLiteral(field, columns[range.left + index]?.type_name ?? ""),
          );
          if (literals.some((literal) => literal === null)) {
            return { ok: false, reason: "unsafe_values", chars: builder.chars };
          }
          const line = `(${literals.join(", ")})`;
          insertRows.push(line);
          builder.chars += line.length;
        }

        assertBudget(builder, limit);
        if (builder.chars - lastYield > YIELD_EVERY_CHARS) {
          lastYield = builder.chars;
          await nextTick();
        }
      }
    }

    if (format === "json") {
      const body = jsonDocs.map((doc) => `  ${doc}`).join(",\n");
      return {
        ok: true,
        text: jsonDocs.length > 0 ? `[\n${body}\n]\n` : "[]\n",
        chars: body.length,
        rows: builder.rows,
        cells: builder.cells,
        issues: [...issues].map(([code, cells]) => ({ code, cells })),
        partialCells: builder.partial,
      };
    }

    if (format === "insert") {
      const columnList = insertColumnList(columns, ranges);
      if (!columnList) return { ok: false, reason: "no_target", chars: 0 };
      const head = `INSERT INTO ${quoteIdentifier(insertTable!.database)}.${quoteIdentifier(
        insertTable!.table,
      )} (${columnList}) VALUES\n`;
      return {
        ok: true,
        text: `${head}${insertRows.join(",\n")};\n`,
        chars: builder.chars,
        rows: builder.rows,
        cells: builder.cells,
        issues: [...issues].map(([code, cells]) => ({ code, cells })),
        partialCells: builder.partial,
      };
    }

    return {
      ok: true,
      text: builder.chunks.join(""),
      chars: builder.chars,
      rows: builder.rows,
      cells: builder.cells,
      issues: [...issues].map(([code, cells]) => ({ code, cells })),
      partialCells: builder.partial,
    };
  } catch (failure) {
    if (failure instanceof BudgetExceeded) {
      return { ok: false, reason: "too_large", chars: builder.chars };
    }
    throw failure;
  }
}

/**
 * INSERT 的列清单：所有块必须列相同，否则 `INSERT (cols) VALUES (...)` 会错位。
 * 列不一致时拒绝生成（而不是悄悄按第一块来）。
 */
function insertColumnList(
  columns: readonly DbColumn[],
  ranges: readonly SelectionRange[],
): string | null {
  const first = ranges[0];
  const sameShape = ranges.every(
    (range) => range.left === first.left && range.right === first.right,
  );
  if (!sameShape) return null;
  const names: string[] = [];
  for (let col = first.left; col <= first.right; col += 1) {
    const column = columns[col];
    if (!column) return null;
    names.push(quoteIdentifier(column.org_name || column.name));
  }
  return names.join(", ");
}
