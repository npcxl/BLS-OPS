/**
 * Preview dispatcher: bytes + file name → a renderable model.
 *
 * One rule runs through this module: **the preview never invents content.**
 * Every branch either parses the real bytes or returns `unsupported` with the
 * reason it could not. There is no placeholder text, no "looks like a
 * spreadsheet" guess, and a truncated payload is reported as truncated.
 *
 * Parsers that allocate object URLs (docx/pptx images) hand back a `dispose`
 * callback — the caller owns it and must call it when the preview closes.
 */
import { fileKind, type EditorLanguage } from "@/lib/file-kind";

import {
  listArchive,
  UnsupportedArchiveError,
  type ArchiveEntry,
  type ArchiveFormat,
} from "./archive";
import { type DocBlock, type Slide } from "./blocks";
import { parseDocx } from "./docx";
import { parseXlsx, type SheetTable } from "./xlsx";
import { parsePptx } from "./pptx";
import { sniffType } from "./hex";

export type PreviewModel =
  | { kind: "image"; bytes: Uint8Array; mime: string }
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "sheet"; sheets: SheetTable[] }
  | { kind: "doc"; blocks: DocBlock[] }
  | { kind: "slides"; slides: Slide[] }
  | { kind: "text"; text: string; language?: EditorLanguage }
  | { kind: "media"; bytes: Uint8Array; mime: string; audio: boolean }
  | {
      kind: "archive";
      format: ArchiveFormat;
      entries: ArchiveEntry[];
      totalSize: number;
    }
  | { kind: "hex"; bytes: Uint8Array; detected: string | null }
  | { kind: "unsupported"; reason: string; hint?: string };

export interface PreviewResult {
  model: PreviewModel;
  /** Banner shown above the content (truncation, partial parse, …). */
  note?: string;
  /** Releases every object URL the parse created. */
  dispose: () => void;
}

/** Characters of text we are willing to put in the DOM at once. */
const MAX_TEXT_CHARS = 400_000;

export interface PreviewInput {
  name: string;
  /** MIME type guessed by the backend from the file name. */
  mime: string;
  bytes: Uint8Array;
  /** Full size on the server, which may exceed `bytes.length`. */
  size?: number;
}

export function buildPreview({ name, bytes, size }: PreviewInput): PreviewResult {
  const notes: string[] = [];
  if (size !== undefined && size > bytes.length) {
    notes.push(`文件共 ${formatBytes(size)}，预览只加载了前 ${formatBytes(bytes.length)}`);
  }
  const noop = () => {};
  const withNote = (model: PreviewModel, extra?: string): PreviewResult => {
    const all = extra ? [...notes, extra] : notes;
    return {
      model,
      ...(all.length > 0 ? { note: all.join(" · ") } : {}),
      dispose: noop,
    };
  };

  const extension = extensionOf(name);
  // Delimited text is a spreadsheet, not a blob of text — decide before the
  // category switch, which would otherwise treat .csv as plain text.
  if (extension === "csv" || extension === "tsv") {
    return withNote(parseSpreadsheet(bytes, name, extension));
  }

  const category = fileKind(name).category;
  switch (category) {
    case "image":
      return withNote({ kind: "image", bytes, mime: imageMime(extension) });
    case "pdf":
      return withNote({ kind: "pdf", bytes });
    case "video":
      return withNote({ kind: "media", bytes, mime: mediaMime(name, extension), audio: false });
    case "audio":
      return withNote({ kind: "media", bytes, mime: mediaMime(name, extension), audio: true });
    case "sheet":
      return withNote(parseSpreadsheet(bytes, name, extension));
    case "doc":
      return parseDocument(bytes, extension, notes.join(" · ") || undefined);
    case "code":
    case "text":
      return withNote(readText(bytes, fileKind(name).language));
    case "archive":
      return withNote(parseArchive(bytes, name, extension));
    default:
      break;
  }

  // Unknown extension: let the bytes decide whether this is text. Files with
  // no extension are common on servers (README, Dockerfile, …), and so is
  // UTF-8 Chinese — which a byte-value heuristic would call binary.
  const decoded = tryDecodeAsText(bytes);
  if (decoded !== null) {
    return withNote(
      { kind: "text", text: decoded.slice(0, MAX_TEXT_CHARS) },
      decoded.length > MAX_TEXT_CHARS
        ? `仅显示前 ${MAX_TEXT_CHARS.toLocaleString()} 个字符`
        : undefined,
    );
  }
  return withNote({ kind: "hex", bytes, detected: sniffType(bytes) });
}

// -- per-category parsing ---------------------------------------------------

function parseSpreadsheet(bytes: Uint8Array, name: string, extension: string): PreviewModel {
  if (extension === "csv" || extension === "tsv") {
    const sheets = [parseDelimited(decodeText(bytes), extension === "tsv" ? "\t" : null, name)];
    return { kind: "sheet", sheets };
  }
  if (extension === "xls") return legacyOffice("xls");
  if (extension === "ods") {
    return {
      kind: "unsupported",
      reason: "OpenDocument 表格（.ods）暂不支持预览",
      hint: "可下载后用 LibreOffice / WPS 打开",
    };
  }
  try {
    const { sheets, warning } = parseXlsx(bytes);
    if (sheets.length === 0) {
      return { kind: "unsupported", reason: warning ?? "这个工作簿里没有可显示的内容" };
    }
    return { kind: "sheet", sheets };
  } catch (cause) {
    return parseFailure(cause, "无法解析这个 Excel 文件");
  }
}

function parseDocument(
  bytes: Uint8Array,
  extension: string,
  note: string | undefined,
): PreviewResult {
  const result = (model: PreviewModel, dispose: () => void): PreviewResult => ({
    model,
    ...(note ? { note } : {}),
    dispose,
  });

  if (extension === "pptx") {
    try {
      const { slides, media } = parsePptx(bytes);
      if (slides.length === 0) {
        return result({ kind: "unsupported", reason: "这个演示文稿没有幻灯片" }, () =>
          media.forEach((store) => store.revoke()),
        );
      }
      return result({ kind: "slides", slides }, () => media.forEach((store) => store.revoke()));
    } catch (cause) {
      return result(parseFailure(cause, "无法解析这个 PowerPoint 文件"), () => {});
    }
  }
  if (extension === "docx") {
    try {
      const { blocks, media } = parseDocx(bytes);
      if (blocks.length === 0) {
        return result(
          { kind: "unsupported", reason: "这个文档没有可显示的正文内容" },
          () => media.revoke(),
        );
      }
      return result({ kind: "doc", blocks }, () => media.revoke());
    } catch (cause) {
      return result(parseFailure(cause, "无法解析这个 Word 文档"), () => {});
    }
  }
  if (extension === "doc" || extension === "ppt") {
    return result(legacyOffice(extension), () => {});
  }
  if (extension === "odt" || extension === "odp") {
    return result(
      {
        kind: "unsupported",
        reason: `OpenDocument 文档（.${extension}）暂不支持预览`,
        hint: "可下载后用 LibreOffice / WPS 打开",
      },
      () => {},
    );
  }
  return result({ kind: "hex", bytes, detected: sniffType(bytes) }, () => {});
}

function parseArchive(bytes: Uint8Array, name: string, extension: string): PreviewModel {
  if (extension === "7z" || extension === "rar" || extension === "bz2" || extension === "xz") {
    return {
      kind: "unsupported",
      reason: `.${extension} 压缩包暂不支持解析`,
      hint: "可下载后用本地压缩软件打开",
    };
  }
  if (extension === "iso" || extension === "deb" || extension === "rpm") {
    return { kind: "unsupported", reason: `.${extension} 文件暂不支持预览`, hint: "可下载后使用" };
  }
  try {
    const listing = listArchive(bytes, name);
    return {
      kind: "archive",
      format: listing.format,
      entries: listing.entries,
      totalSize: listing.totalSize,
    };
  } catch (cause) {
    if (cause instanceof UnsupportedArchiveError) {
      return { kind: "unsupported", reason: cause.message, hint: "可下载后用本地压缩软件打开" };
    }
    return parseFailure(cause, "无法读取这个压缩包");
  }
}

function readText(bytes: Uint8Array, language?: EditorLanguage): PreviewModel {
  const text = decodeText(bytes);
  return {
    kind: "text",
    text: text.slice(0, MAX_TEXT_CHARS),
    ...(language ? { language } : {}),
  };
}

function parseFailure(cause: unknown, fallback: string): PreviewModel {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind: "unsupported", reason: `${fallback}：${message}` };
}

function legacyOffice(extension: string): PreviewModel {
  return {
    kind: "unsupported",
    reason: `.${extension} 是旧版 Office 二进制格式，无法在应用内解析`,
    hint: "请下载后用 Office / WPS 打开，或另存为新版 .docx / .xlsx 格式",
  };
}

// -- text decoding ----------------------------------------------------------

/**
 * Bytes → text, trying UTF-8 first and falling back to GB18030 (servers in
 * this tool's target environments still hold GBK config and log files) before
 * giving up and decoding as Latin-1, which never fails.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // not this encoding — try the next one
    }
  }
  return new TextDecoder("latin1").decode(bytes);
}

/** Control characters a text file may legitimately contain. */
const TEXT_CONTROLS = new Set(["\t", "\n", "\r", "\f"]);

/**
 * Decodes bytes as text only if they really are text.
 *
 * A strict decode is the test: UTF-8 first, then GB18030, both with
 * `fatal: true`, so a single bad byte means "not this encoding" rather than a
 * replacement character. Anything that decodes but still contains NUL or other
 * control bytes is binary (a UTF-16 file decodes cleanly as UTF-8, so the
 * control check is what catches it).
 *
 * Returns `null` when no encoding fits — the caller then falls back to hex.
 */
function tryDecodeAsText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return "";
  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(sample);
      if (isTextLike(text)) return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // not this encoding — try the next one
    }
  }
  return null;
}

function isTextLike(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20) return TEXT_CONTROLS.has(char);
    if (code === 0x7f) return false;
  }
  return true;
}

// -- delimited text (csv / tsv) --------------------------------------------

/** Rows we render from a delimited file; the rest are counted, not shown. */
const MAX_DELIMITED_ROWS = 2000;

function parseDelimited(text: string, forced: string | null, name: string): SheetTable {
  const delimiter = forced ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let total = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      total += 1;
      if (rows.length < MAX_DELIMITED_ROWS) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    total += 1;
    if (rows.length < MAX_DELIMITED_ROWS) rows.push(row);
  }

  return {
    name: name || "Sheet1",
    rows,
    totalRows: total,
    truncatedRows: Math.max(0, total - rows.length),
  };
}

/** Picks the delimiter that splits the first line into the most fields. */
function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n")).slice(0, 4096);
  let best = ",";
  let bestCount = 0;
  for (const candidate of [",", ";", "\t", "|"]) {
    const count = firstLine.split(candidate).length;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

// -- small helpers ----------------------------------------------------------

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function imageMime(extension: string): string {
  switch (extension) {
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    case "ico":
      return "image/x-icon";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    default:
      return "image/png";
  }
}

function mediaMime(name: string, extension: string): string {
  const known: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/aac",
    opus: "audio/ogg",
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    flv: "video/x-flv",
  };
  return known[extensionOf(name)] ?? known[extension] ?? "application/octet-stream";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}
