import { useEffect, useRef, useState } from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useObjectUrl } from "@/hooks/use-object-url";
import { formatSize } from "@/lib/format";

const STEPS = [10, 25, 50, 75, 100, 150, 200, 300, 400];

/**
 * Image preview with fit-to-window and explicit zoom.
 *
 * Rendering goes through a `blob:` URL (the bytes never touch disk), and SVG is
 * drawn as an image rather than inlined — `<img>` cannot run scripts, so a
 * server-side SVG cannot reach the WebView.
 */
export function ImagePreview({ bytes, mime }: { bytes: Uint8Array; mime: string }) {
  const url = useObjectUrl(bytes, mime);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // A new image resets the zoom: keeping 400% from the previous file would
  // show a corner of the new one and look broken.
  useEffect(() => {
    setZoom("fit");
    setNatural(null);
  }, [bytes]);

  const stepZoom = (direction: 1 | -1) => {
    const current = zoom === "fit" ? 100 : zoom;
    const index = STEPS.findIndex((step) => step >= current);
    const nextIndex = Math.max(
      0,
      Math.min(STEPS.length - 1, (index < 0 ? STEPS.indexOf(100) : index) + direction),
    );
    setZoom(STEPS[nextIndex]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <Button
          size="xs"
          variant={zoom === "fit" ? "secondary" : "ghost"}
          onClick={() => setZoom("fit")}
          title="适应窗口"
        >
          <Maximize2 size={12} />
          适应
        </Button>
        <Button size="xs" variant="ghost" onClick={() => stepZoom(-1)} title="缩小">
          <ZoomOut size={12} />
        </Button>
        <span className="w-12 text-center text-11 tabular-nums text-fg-muted">
          {zoom === "fit" ? "自适应" : `${zoom}%`}
        </span>
        <Button size="xs" variant="ghost" onClick={() => stepZoom(1)} title="放大">
          <ZoomIn size={12} />
        </Button>
        <span className="ml-auto truncate text-11 text-fg-subtle">
          {natural ? `${natural.width} × ${natural.height} · ` : ""}
          {formatSize(bytes.length)}
        </span>
      </div>

      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto p-4"
        style={{
          // Checkerboard so transparent PNGs are visibly transparent.
          backgroundImage:
            "linear-gradient(45deg, rgb(127 127 127 / 0.12) 25%, transparent 25%, transparent 75%, rgb(127 127 127 / 0.12) 75%), linear-gradient(45deg, rgb(127 127 127 / 0.12) 25%, transparent 25%, transparent 75%, rgb(127 127 127 / 0.12) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 8px 8px",
        }}
      >
        <div className="flex min-h-full items-center justify-center">
          {url && (
            <img
              src={url}
              alt=""
              className={zoom === "fit" ? "max-h-full max-w-full" : undefined}
              style={
                zoom === "fit"
                  ? { objectFit: "contain" }
                  : { width: `${zoom}%`, height: "auto", objectFit: "contain" }
              }
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
