/**
 * Read-only xlsx (and xlsm) reader for the file preview.
 *
 * An .xlsx is a ZIP of XML parts. We read the four that carry content:
 *
 * | part                     | what it gives us                     |
 * |--------------------------|--------------------------------------|
 * | `xl/workbook.xml`        | sheet names, in workbook order       |
 * | `xl/_rels/workbook.xml.rels` | sheet name → worksheet part      |
 * | `xl/sharedStrings.xml`   | the string pool cells point into     |
 * | `xl/worksheets/*.xml`    | rows and cells                       |
 * | `xl/styles.xml`          | number formats (to spot dates)       |
 *
 * Formulas are resolved to their **cached** values (`<v>`), which is exactly
 * what Excel last wrote — recomputing them would be wrong *and* unsafe.
 *
 * Rendering is capped (rows and columns) so a 200 MB workbook cannot lock the
 * window; `truncatedRows` tells the UI how much was left out.
 */
import { strFromU8, unzipSync } from "fflate";

import { attr, decodeXmlEntities, elementText, findTags, stripTags } from "./xml";

export interface SheetTable {
  name: string;
  /** First row is the header when `header` is true. */
  rows: string[][];
  /** Non-empty rows in the sheet, before the render cap. */
  totalRows: number;
  truncatedRows: number;
}

export interface XlsxModel {
  sheets: SheetTable[];
  /** Set when the workbook had no readable sheet at all. */
  warning?: string;
}

const MAX_ROWS = 2000;
const MAX_COLS = 64;

/** Number-format ids Excel treats as dates out of the box. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

export function parseXlsx(bytes: Uint8Array): XlsxModel {
  const zip = unzipSync(bytes);
  const read = (name: string): string | null => {
    const part = zip[name];
    return part ? strFromU8(part) : null;
  };

  const sharedStrings = readSharedStrings(read("xl/sharedStrings.xml"));
  const dateStyles = readDateStyles(read("xl/styles.xml"));
  const sheets = listSheets(read("xl/workbook.xml"), read("xl/_rels/workbook.xml.rels"), zip);

  if (sheets.length === 0) {
    return { sheets: [], warning: "这个工作簿里没有找到可读取的工作表。" };
  }

  return {
    sheets: sheets.map((sheet) => {
      const xml = read(sheet.part);
      if (!xml) return { name: sheet.name, rows: [], totalRows: 0, truncatedRows: 0 };
      return parseSheet(xml, sheet.name, sharedStrings, dateStyles);
    }),
  };
}

function readSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  // One `<si>` may hold several runs, whose text is concatenated — and the
  // runs carry XML entities, so each one is decoded (an "&" typed into a cell
  // arrives as `&amp;`).
  return findTags(xml, "si").map((si) =>
    findTags(si.body, "t")
      .map((tag) => decodeXmlEntities(stripTags(tag.body)))
      .join(""),
  );
}

/**
 * One boolean per cell-style index: does that style render as a date?
 * Custom formats count when their code contains date/time placeholders.
 */
function readDateStyles(xml: string | null): boolean[] {
  if (!xml) return [];
  const custom = new Map<number, boolean>();
  for (const fmt of findTags(xml, "numFmt")) {
    const id = Number(attr(fmt.attrs, "numFmtId"));
    const code = attr(fmt.attrs, "formatCode") ?? "";
    if (Number.isFinite(id)) custom.set(id, /[ymdhs]/i.test(code.replace(/"[^"]*"/g, "")));
  }
  const xfs = findTags(xml, "cellXfs");
  const container = xfs[0]?.body ?? "";
  return findTags(container, "xf").map((xf) => {
    const id = Number(attr(xf.attrs, "numFmtId"));
    if (!Number.isFinite(id)) return false;
    return custom.get(id) ?? BUILTIN_DATE_FORMATS.has(id);
  });
}

function listSheets(
  workbookXml: string | null,
  relsXml: string | null,
  zip: Record<string, Uint8Array>,
): { name: string; part: string }[] {
  const relTargets = new Map<string, string>();
  if (relsXml) {
    for (const rel of findTags(relsXml, "Relationship")) {
      const id = attr(rel.attrs, "Id");
      const target = attr(rel.attrs, "Target");
      if (id && target) relTargets.set(id, target);
    }
  }

  const sheets = (workbookXml ? findTags(workbookXml, "sheet") : []).map((sheet, index) => {
    const name = attr(sheet.attrs, "name") ?? `Sheet${index + 1}`;
    const rid = attr(sheet.attrs, "id") ?? attr(sheet.attrs, "r:id");
    const target = rid ? relTargets.get(rid) : undefined;
    return { name, part: resolvePart(target, `worksheets/sheet${index + 1}.xml`) };
  });
  if (sheets.length > 0) return sheets;

  // Workbook part missing/unreadable: fall back to whatever worksheets the
  // archive actually holds, in numeric order.
  return Object.keys(zip)
    .filter((key) => /^xl\/worksheets\/sheet\d+\.xml$/.test(key))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b))
    .map((key) => ({ name: key.replace(/^.*\/(.*)\.xml$/, "$1"), part: key }));
}

function sheetNumber(path: string): number {
  const match = /sheet(\d+)\.xml$/.exec(path);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** Relationship targets are relative to the workbook's folder (`xl/`). */
function resolvePart(target: string | undefined, fallback: string): string {
  if (!target) return `xl/${fallback}`;
  if (target.startsWith("/")) return target.slice(1);
  if (target.includes("/")) return `xl/${target}`;
  return `xl/${fallback}`;
}

function parseSheet(
  xml: string,
  name: string,
  sharedStrings: string[],
  dateStyles: boolean[],
): SheetTable {
  const rows: string[][] = [];
  let totalRows = 0;
  let truncatedRows = 0;

  for (const row of findTags(xml, "row")) {
    const cells = findTags(row.body, "c");
    let width = 0;
    for (const cell of cells) width = Math.max(width, columnIndex(attr(cell.attrs, "r")) + 1);
    if (width === 0) continue; // row with no cells at all
    totalRows += 1;

    if (rows.length >= MAX_ROWS) {
      truncatedRows += 1;
      continue;
    }

    const values: string[] = new Array(Math.min(width, MAX_COLS)).fill("");
    for (const cell of cells) {
      const column = columnIndex(attr(cell.attrs, "r"));
      if (column >= MAX_COLS) continue;
      const styleIndex = Number(attr(cell.attrs, "s"));
      values[column] = cellValue(
        cell.body,
        attr(cell.attrs, "t"),
        sharedStrings,
        Number.isFinite(styleIndex) ? dateStyles[styleIndex] === true : false,
      );
    }
    rows.push(values);
  }

  // Trailing empty rows are noise in a preview.
  while (rows.length > 0 && rows[rows.length - 1].every((value) => value === "")) rows.pop();

  return { name, rows, totalRows, truncatedRows };
}

function cellValue(
  body: string,
  type: string | null,
  sharedStrings: string[],
  isDateStyle: boolean,
): string {
  switch (type) {
    case "s": {
      const index = Number(elementText(body, "v"));
      return Number.isFinite(index) ? (sharedStrings[index] ?? "") : "";
    }
    case "inlineStr":
      return findTags(body, "is")
        .map((is) => elementText(is.body, "t"))
        .join("");
    case "str":
      return elementText(body, "v");
    case "b":
      return elementText(body, "v") === "1" ? "TRUE" : "FALSE";
    case "e":
      return elementText(body, "v");
    case "d": {
      const iso = elementText(body, "v");
      const parsed = new Date(iso);
      return Number.isNaN(parsed.getTime()) ? iso : formatDateTime(parsed, false);
    }
    default: {
      const raw = elementText(body, "v");
      if (raw === "") return "";
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return raw;
      if (isDateStyle && numeric > 0) return serialToDate(numeric);
      // Keep Excel's own precision instead of JS's 1.2345678901234567e+30.
      return Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toPrecision(12)));
    }
  }
}

/** `A1` → 0, `AB12` → 27. Handles missing/invalid refs as column 0. */
function columnIndex(ref: string | null): number {
  if (!ref) return 0;
  const letters = /^([A-Z]+)/i.exec(ref.trim());
  if (!letters) return 0;
  let index = 0;
  for (const char of letters[1].toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * Excel serial date → readable string. The 1899-12-30 epoch (not 1899-12-31)
 * is Excel's deliberate 1900-leap-year bug; matching it keeps dates aligned
 * with what Excel shows.
 */
function serialToDate(serial: number): string {
  const days = Math.floor(serial);
  const fraction = serial - days;
  const millis = Date.UTC(1899, 11, 30) + days * 86_400_000 + Math.round(fraction * 86_400_000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return String(serial);
  return formatDateTime(date, fraction > 0);
}

function formatDateTime(date: Date, withTime: boolean): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const base = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (!withTime) return base;
  return `${base} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
