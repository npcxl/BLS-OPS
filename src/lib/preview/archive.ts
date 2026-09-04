/**
 * Archive *listing* for the preview (no extraction).
 *
 * ZIP entries are read straight out of the central directory at the end of the
 * file, so listing a 2 GB archive costs one small read instead of inflating
 * every member. TAR is a linked list of 512-byte headers, so it is walked
 * physically (`.tar.gz` / `.tgz` is gunzipped first — within the preview size
 * budget, never beyond it).
 *
 * Formats this cannot read (RAR, 7z, bzip2, xz) are reported as unsupported
 * with a reason rather than shown as an empty archive.
 */
import { gunzipSync } from "fflate";

import { i18n } from "@/i18n";

export interface ArchiveEntry {
  name: string;
  /** Uncompressed size, 0 for directories. */
  size: number;
  directory: boolean;
}

export type ArchiveFormat = "zip" | "tar" | "tar.gz";

export interface ArchiveListing {
  format: ArchiveFormat;
  entries: ArchiveEntry[];
  /** Total uncompressed bytes of every listed entry. */
  totalSize: number;
  /** Set when the listing is known to be incomplete. */
  note?: string;
}

export class UnsupportedArchiveError extends Error {}

const MAX_ENTRIES = 5000;

export function listArchive(bytes: Uint8Array, fileName: string): ArchiveListing {
  if (isZip(bytes)) {
    const entries = listZip(bytes);
    return {
      format: "zip",
      entries: entries.slice(0, MAX_ENTRIES),
      totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
      note:
        entries.length > MAX_ENTRIES
          ? i18n.t("Showing only the first {{count}} entries", { count: MAX_ENTRIES.toLocaleString() })
          : undefined,
    };
  }

  const gzipped = /\.tgz$/i.test(fileName) || /\.tar\.gz$/i.test(fileName) || isGzip(bytes);
  const tarBytes = gzipped ? tryGunzip(bytes) : bytes;
  if (tarBytes && looksLikeTar(tarBytes)) {
    const entries = listTar(tarBytes);
    return {
      format: gzipped ? "tar.gz" : "tar",
      entries: entries.slice(0, MAX_ENTRIES),
      totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
    };
  }

  throw new UnsupportedArchiveError(
    i18n.t("Preview is not supported for this archive format (zip / tar / tar.gz only)"),
  );
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] <= 0x08;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function tryGunzip(bytes: Uint8Array): Uint8Array | null {
  try {
    return gunzipSync(bytes);
  } catch {
    return null;
  }
}

/** TAR has no leading magic — the checksum at offset 148 is the signature. */
function looksLikeTar(bytes: Uint8Array): boolean {
  if (bytes.length < 512) return false;
  const stored = parseOctal(bytes, 148, 8);
  if (stored === null) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : bytes[i];
  return sum === stored;
}

/**
 * ZIP central directory: one header per entry, starting at the offset recorded
 * in the End Of Central Directory record at the very end of the file.
 */
function listZip(bytes: Uint8Array): ArchiveEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.length);
  if (eocd < 0) {
    throw new UnsupportedArchiveError(i18n.t("Cannot read the archive directory (the file may be corrupted)"));
  }

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ArchiveEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length) break;
    if (view.getUint32(offset, true) !== 0x02014b50) break; // not a central header

    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let size = view.getUint32(offset + 24, true);

    // Zip64: sizes and offsets move into the extra field. Read them when the
    // 32-bit field is saturated, otherwise fall back to the plain value.
    if (size === 0xffffffff) {
      const extra = readZip64(view, offset + 46 + nameLength, extraLength);
      if (extra !== null) size = extra;
    }

    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeName(rawName, (flags & 0x800) !== 0);
    entries.push({ name, size, directory: name.endsWith("/") });

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZip64(view: DataView, start: number, length: number): number | null {
  let cursor = start;
  const end = start + length;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    if (id === 0x0001 && size >= 8) {
      const value = view.getBigUint64(cursor + 4, true);
      return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : value);
    }
    cursor += 4 + size;
  }
  return null;
}

/** EOCD is within the last 64 KB + 22 bytes (the trailing comment). */
function findEocd(view: DataView, length: number): number {
  const from = Math.max(0, length - 65_558);
  for (let i = length - 22; i >= from; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

function listTar(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let pendingName: string | null = null;

  while (offset + 512 <= bytes.length) {
    if (isAllZero(bytes, offset)) break; // two zero blocks end the archive
    const typeflag = String.fromCharCode(bytes[offset + 156] ?? 0);
    const size = parseOctal(bytes, offset + 124, 12) ?? 0;
    const name = readTarName(bytes, offset);
    const dataStart = offset + 512;
    const dataEnd = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === "L" || typeflag === "K") {
      // GNU long name: the next data block *is* the real name.
      pendingName = decodeName(bytes.subarray(dataStart, dataStart + size), true).replace(/\0+$/, "");
    } else if (typeflag === "x" || typeflag === "g") {
      const pax = decodeName(bytes.subarray(dataStart, dataStart + size), true);
      pendingName = paxPath(pax) ?? pendingName;
    } else if (typeflag !== "1" && typeflag !== "2" && typeflag !== "N") {
      const full = pendingName ?? name;
      if (full && full !== "./") entries.push({ name: full, size, directory: typeflag === "5" });
      pendingName = null;
    }

    offset = dataEnd;
  }
  return entries;
}

/** `ustar` splits long paths into `prefix` + `/` + `name`. */
function readTarName(bytes: Uint8Array, offset: number): string {
  const name = decodeName(bytes.subarray(offset, offset + 100), true).replace(/\0.*$/, "");
  const magic = decodeName(bytes.subarray(offset + 257, offset + 262), false);
  if (magic === "ustar") {
    const prefix = decodeName(bytes.subarray(offset + 345, offset + 500), true).replace(/\0.*$/, "");
    if (prefix) return `${prefix}/${name}`;
  }
  return name;
}

/** PAX extended header record: `N path=some/long/name\n`. */
function paxPath(records: string): string | null {
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(records);
  return match ? match[1] : null;
}

function parseOctal(bytes: Uint8Array, offset: number, length: number): number | null {
  let text = "";
  for (let i = offset; i < offset + length; i++) text += String.fromCharCode(bytes[i]);
  const cleaned = text.replace(/[^0-7]/g, "");
  if (!cleaned) return null;
  return parseInt(cleaned, 8);
}

function isAllZero(bytes: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + 512; i++) if (bytes[i] !== 0) return false;
  return true;
}

/**
 * Archive member names are bytes with no declared encoding. Bit 11 of the ZIP
 * flags means UTF-8; otherwise decode as UTF-8 anyway (it is what every modern
 * archiver writes) and let unmappable bytes fall back to Latin-1 rather than
 * showing replacement characters.
 */
function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8) {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const decoded = decoder.decode(bytes);
  return decoded.includes("�") ? latin1(bytes) : decoded;
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}
