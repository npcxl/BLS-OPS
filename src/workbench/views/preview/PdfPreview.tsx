import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { i18n } from "@/i18n";

type PdfJsModule = typeof import("pdfjs-dist");
type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
type PdfLoadingTask = ReturnType<PdfJsModule["getDocument"]>;

/**
 * PDF preview, rendered page by page onto a canvas.
 *
 * pdf.js is ~1.3 MB and only ever needed for PDFs, so the module (and its
 * worker) is imported on first use — opening a text or image preview never
 * pays for it. The worker URL comes from Vite's `?url` import, which emits the
 * worker as its own asset instead of inlining a second copy of the library.
 *
 * Failures are shown as text, never as a blank page: a PDF we cannot render
 * still tells the user why, and the 下载 button remains available.
 */
export function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const { t } = useTranslation();
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PdfDocument | null>(null);
  /** Kept alongside the document: only the loading task can shut the worker
   *  down, and an idle worker holds the whole parsed PDF in memory. */
  const taskRef = useRef<PdfLoadingTask | null>(null);

  // -- load ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPage(1);
    setPageCount(null);

    void (async () => {
      try {
        const pdfjs = await loadPdfJs();
        if (cancelled) return;
        const task = pdfjs.getDocument({ data: bytes });
        taskRef.current = task;
        const doc = await task.promise;
        if (cancelled) {
          void task.destroy();
          taskRef.current = null;
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setLoading(false);
      } catch (cause) {
        if (!cancelled) {
          setError(toMessage(cause, i18n.t("Cannot render this PDF")));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      const task = taskRef.current;
      docRef.current = null;
      taskRef.current = null;
      // `destroy` rejects the in-flight render, which our handler ignores.
      void task?.destroy();
    };
  }, [bytes]);

  // -- render one page ----------------------------------------------------
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || pageCount === null || error) return;

    let cancelled = false;
    void (async () => {
      try {
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const available = containerRef.current?.clientWidth ?? base.width;
        const scale = ((available - 32) / base.width) * zoom;
        const ratio = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({ scale: scale * ratio });

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
        canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;

        await pdfPage.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
      } catch (cause) {
        if (!cancelled && !isCancelledError(cause)) setError(toMessage(cause, i18n.t("Failed to render page")));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [page, pageCount, zoom, error]);

  const changeZoom = useCallback((delta: number) => {
    setZoom((current) => Math.min(4, Math.max(0.25, Number((current + delta).toFixed(2)))));
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-[420px] text-12 leading-relaxed text-danger">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          <ChevronLeft size={12} />
        </Button>
        <span className="text-11 tabular-nums text-fg-muted">
          {page} / {pageCount ?? "—"}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={pageCount === null || page >= pageCount}
          onClick={() => setPage((current) => Math.min(pageCount ?? current, current + 1))}
        >
          <ChevronRight size={12} />
        </Button>
        <span className="mx-1 h-4 w-px bg-line" />
        <Button size="xs" variant="ghost" onClick={() => changeZoom(-0.25)} title={t("Zoom out")}>
          <ZoomOut size={12} />
        </Button>
        <span className="w-10 text-center text-11 tabular-nums text-fg-muted">
          {Math.round(zoom * 100)}%
        </span>
        <Button size="xs" variant="ghost" onClick={() => changeZoom(0.25)} title={t("Zoom in")}>
          <ZoomIn size={12} />
        </Button>
        {loading && (
          <span className="ml-auto flex items-center gap-1.5 text-11 text-fg-subtle">
            <Loader2 size={12} className="animate-spin" />
            {t("Loading PDF…")}
          </span>
        )}
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-surface-2/40 p-4">
        {pageCount !== null && (
          <canvas ref={canvasRef} className="mx-auto block rounded-[4px] bg-white shadow-lg" />
        )}
      </div>
    </div>
  );
}

let pdfjsPromise: Promise<PdfJsModule> | null = null;

/** Loads pdf.js once per window and points it at its worker. */
async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [pdfjs, workerUrl] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

function isCancelledError(cause: unknown): boolean {
  return cause instanceof Error && /cancel/i.test(cause.name + cause.message);
}

/** 兜底错误文案：fallback 由调用方传当前语言文案，这里只补底层错误详情。 */
function toMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  if (/password/i.test(cause.message)) {
    return i18n.t("This PDF is encrypted and needs a password to preview.");
  }
  if (/invalid/i.test(cause.message)) {
    return i18n.t("This is not a valid PDF file, or the file is corrupted.");
  }
  return i18n.t("{{message}}: {{detail}}", { message: fallback, detail: cause.message });
}
