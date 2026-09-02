import { useEffect, useMemo, useState } from "react";
import { HEX_CHUNK, hexDump } from "@/lib/preview/hex";
import { formatSize } from "@/lib/format";

/**
 * Hex view for files with no parser.
 *
 * Paged in 8 KB chunks: a 20 MB file is 1.2 M rows, and rendering them all
 * would hang the window. The header reports what the magic bytes actually say
 * the file is, which is the whole reason this view exists.
 */
export function HexPreview({
  bytes,
  detected,
}: {
  bytes: Uint8Array;
  detected: string | null;
}) {
  const [shown, setShown] = useState(HEX_CHUNK);

  useEffect(() => {
    setShown(HEX_CHUNK);
  }, [bytes]);

  const lines = useMemo(() => hexDump(bytes, 0, Math.min(shown, bytes.length)), [bytes, shown]);
  const hex = (value: number) => value.toString(16).padStart(2, "0").toUpperCase();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-11">
        <span className="text-fg-muted">十六进制</span>
        {detected && <span className="text-fg-subtle">· 识别为 {detected}</span>}
        <span className="ml-auto text-fg-subtle">
          已显示 {formatSize(Math.min(shown, bytes.length))} / {formatSize(bytes.length)}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-11 leading-[1.5]">
        {lines.map((line) => (
          <div key={line.offset} className="flex gap-3 px-2 hover:bg-surface-hover/40">
            <span className="shrink-0 text-fg-subtle">{hex(line.offset >>> 24)}{hex((line.offset >>> 16) & 0xff)}{hex((line.offset >>> 8) & 0xff)}{hex(line.offset & 0xff)}</span>
            <span className="shrink-0 whitespace-pre text-fg-muted">
              {line.cells.map((cell, index) => (
                <span key={index} className={cell === null ? "text-transparent" : undefined}>
                  {cell === null ? "  " : `${hex(cell)} `}
                </span>
              ))}
            </span>
            <span className="shrink-0 whitespace-pre text-fg-subtle">{line.text}</span>
          </div>
        ))}
      </div>

      {shown < bytes.length && (
        <div className="shrink-0 border-t border-line p-2">
          <button
            type="button"
            className="rounded-[6px] px-2 py-1 text-11 text-fg-muted hover:bg-surface-hover hover:text-fg"
            onClick={() => setShown((current) => current + HEX_CHUNK)}
          >
            继续显示后 {formatSize(Math.min(HEX_CHUNK, bytes.length - shown))}
          </button>
        </div>
      )}
    </div>
  );
}
