/**
 * Hex view — the honest fallback for anything with no parser.
 *
 * Two jobs: render bytes as offset/hex/ASCII rows, and name what the file
 * actually is from its magic bytes. The second one matters most: an extension
 * is a claim, the header is evidence, and when they disagree the preview says
 * so instead of rendering garbage.
 */

export interface HexLine {
  offset: number;
  /** 16 bytes per row, `null` padding on the last row. */
  cells: (number | null)[];
  /** Printable ASCII, `.` for everything else. */
  text: string;
}

export const HEX_CHUNK = 8 * 1024;

export function hexDump(bytes: Uint8Array, start: number, length: number): HexLine[] {
  const lines: HexLine[] = [];
  const end = Math.min(bytes.length, start + length);
  for (let offset = start; offset < end; offset += 16) {
    const cells: (number | null)[] = [];
    let text = "";
    for (let i = 0; i < 16; i++) {
      const index = offset + i;
      if (index >= end) {
        cells.push(null);
        continue;
      }
      const byte = bytes[index];
      cells.push(byte);
      text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
    }
    lines.push({ offset, cells, text });
  }
  return lines;
}

interface Magic {
  /** Byte pattern; `null` entries are wildcards. */
  pattern: (number | null)[];
  /** Offset the pattern starts at. */
  offset?: number;
  label: string;
}

/** label 为英文 key（模块级常量），显示处统一 `t(label)`。 */
const MAGIC: Magic[] = [
  { pattern: [0x25, 0x50, 0x44, 0x46], label: "PDF Document" },
  { pattern: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], label: "PNG Image" },
  { pattern: [0xff, 0xd8, 0xff], label: "JPEG Image" },
  { pattern: [0x47, 0x49, 0x46, 0x38], label: "GIF Image" },
  { pattern: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50], label: "WebP Image" },
  { pattern: [0x42, 0x4d], label: "BMP Image" },
  { pattern: [0x50, 0x4b, 0x03, 0x04], label: "ZIP Archive" },
  { pattern: [0x50, 0x4b, 0x05, 0x06], label: "ZIP Archive (empty)" },
  { pattern: [0x1f, 0x8b], label: "gzip Archive" },
  { pattern: [0x42, 0x5a, 0x68], label: "bzip2 Archive" },
  { pattern: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], label: "xz Archive" },
  { pattern: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: "7z Archive" },
  { pattern: [0x52, 0x61, 0x72, 0x21], label: "RAR Archive" },
  { pattern: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], label: "OLE2 Compound Document (legacy Office)" },
  { pattern: [0x7f, 0x45, 0x4c, 0x46], label: "ELF Executable" },
  { pattern: [0x4d, 0x5a], label: "Windows Executable" },
  { pattern: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33], label: "SQLite Database" },
  { pattern: [0x49, 0x44, 0x33], label: "MP3 Audio" },
  { pattern: [0xff, 0xfb], label: "MP3 Audio" },
  { pattern: [0x66, 0x74, 0x79, 0x70], offset: 4, label: "MP4 / QuickTime Video" },
  { pattern: [0x1a, 0x45, 0xdf, 0xa3], label: "Matroska Video (mkv/webm)" },
  { pattern: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x41, 0x56, 0x45], label: "WAV Audio" },
  { pattern: [0x66, 0x4c, 0x61, 0x43], label: "FLAC Audio" },
  { pattern: [0x23, 0x21], label: "Script (shebang)" },
];

/** What the bytes themselves say the file is, or `null` when nothing matches. */
export function sniffType(bytes: Uint8Array): string | null {
  for (const magic of MAGIC) {
    const offset = magic.offset ?? 0;
    if (offset + magic.pattern.length > bytes.length) continue;
    let matched = true;
    for (let i = 0; i < magic.pattern.length; i++) {
      const expected = magic.pattern[i];
      if (expected === null) continue;
      if (bytes[offset + i] !== expected) {
        matched = false;
        break;
      }
    }
    if (matched) return magic.label;
  }
  return null;
}
