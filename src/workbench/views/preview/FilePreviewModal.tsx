import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Download,
  Loader2,
  Pencil,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { opsApi, toErrorMessage } from "@/api/ops-api";
import { fileKind, isEditableKind } from "@/lib/file-kind";
import { formatSize } from "@/lib/format";
import { FILE_ICONS } from "@/lib/icons/vscode-file-icons";
import { base64ToBytes } from "@/lib/preview/base64";
import { buildPreview, type PreviewResult } from "@/lib/preview";
import { cn } from "@/lib/cn";
import { useExiting } from "@/hooks/use-exiting";
import { ArchivePreview } from "./ArchivePreview";
import { DocxPreview, SlidesPreview } from "./DocPreview";
import { HexPreview } from "./HexPreview";
import { ImagePreview } from "./ImagePreview";
import { MediaPreview } from "./MediaPreview";
import { PdfPreview } from "./PdfPreview";
import { SheetPreview } from "./SheetPreview";
import { TextPreview } from "./TextPreview";

/**
 * How much of a file the preview pulls over the wire.
 *
 * 20 MB covers a photo, a PDF or a workbook with room to spare. Anything
 * larger is still downloadable — it just is not rendered, because a preview
 * that takes ten seconds to appear is not a preview. The backend truncates and
 * reports it, and the banner says so.
 */
const PREVIEW_BUDGET = 20 * 1024 * 1024;

export interface PreviewTarget {
  path: string;
  name: string;
  size: number;
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: PreviewResult };

export interface FilePreviewModalProps {
  sessionId: string;
  target: PreviewTarget;
  onClose: () => void;
  /** Opens the file in the editor (only offered for editable kinds). */
  onEdit?: (target: PreviewTarget) => void;
}

/**
 * Universal file preview.
 *
 * Reads the file's bytes over SFTP and hands them to `buildPreview`, which
 * decides how (or whether) they can be rendered. Every branch either shows the
 * real content or states why it cannot — there is no "preview not supported"
 * dead end without a reason, and 下载 always works regardless.
 */
export default function FilePreviewModal({ sessionId, target, onClose, onEdit }: FilePreviewModalProps) {
  const { t } = useTranslation();
  const { render, exiting } = useExiting(true, 150);
  const [state, setState] = useState<State>({ status: "loading" });
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;
    setState({ status: "loading" });

    void (async () => {
      try {
        const payload = await opsApi.sftpReadBinary(sessionId, target.path, PREVIEW_BUDGET);
        if (cancelled) return;
        const bytes = base64ToBytes(payload.data);
        const result = buildPreview({
          name: target.name,
          mime: payload.mime,
          bytes,
          size: payload.size,
        });
        if (cancelled) {
          result.dispose();
          return;
        }
        dispose = result.dispose;
        setState({ status: "ready", result });
      } catch (cause) {
        if (!cancelled) setState({ status: "error", message: toErrorMessage(cause) });
      }
    })();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [sessionId, target.path, target.name]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setToast(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const destination = await save({
        title: t("Download {{name}}", { name: target.name }),
        defaultPath: target.name,
      });
      if (!destination) return;
      const written = await opsApi.sftpDownloadFile(sessionId, target.path, destination);
      setToast(t("Saved {{size}} → {{path}}", { size: formatSize(written), path: destination }));
    } catch (cause) {
      setToast(t("Download failed: {{message}}", { message: toErrorMessage(cause) }));
    } finally {
      setDownloading(false);
    }
  };

  if (!render) return null;

  const kind = fileKind({ name: target.name, kind: "file" });

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[135] flex items-center justify-center bg-black/40 px-4 py-6",
        exiting ? "opacity-0 transition-opacity duration-150" : "overlay-scrim",
      )}
      onMouseDown={onClose}
    >
      <div
        className={cn(
          "glass-panel-strong flex h-[88vh] max-h-[88vh] w-[min(1100px,94vw)] flex-col overflow-hidden rounded-[18px]",
          exiting
            ? "opacity-0 translate-y-2 scale-[0.985] transition-[opacity,transform] duration-150 ease-out"
            : "overlay-enter",
        )}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-2.5">
          <span className="mt-0.5 shrink-0">
            <Icon icon={FILE_ICONS[kind.iconKey]} width={15} height={15} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-13 font-semibold text-fg">{target.name}</h2>
            <p className="truncate text-11 text-fg-subtle">
              {target.path} · {formatSize(target.size)} · {t(kind.label)}
            </p>
          </div>
          <Button
            size="xs"
            variant="secondary"
            disabled={downloading}
            onClick={() => void download()}
          >
            {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {t("Download")}
          </Button>
          {onEdit && isEditableKind({ name: target.name, kind: "file" }) && (
            <Button size="xs" variant="ghost" onClick={() => onEdit(target)}>
              <Pencil size={12} />
              {t("Edit")}
            </Button>
          )}
          <button
            type="button"
            aria-label={t("Close")}
            className="rounded-[5px] p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        {state.status === "loading" && (
          <div className="flex flex-1 items-center justify-center gap-2 text-12 text-fg-subtle">
            <Loader2 size={14} className="animate-spin" />
            {t("Reading file…")}
          </div>
        )}

        {state.status === "error" && (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="flex max-w-[460px] flex-col items-center gap-2 text-center">
              <AlertCircle size={20} className="text-danger" />
              <p className="text-12 leading-relaxed text-danger">{state.message}</p>
              <p className="text-11 text-fg-subtle">{t("You can download it to view locally.")}</p>
            </div>
          </div>
        )}

        {state.status === "ready" && (
          <div className="flex min-h-0 flex-1 flex-col">
            {state.result.note && (
              <div className="shrink-0 border-b border-line bg-warning/10 px-3 py-1.5 text-11 text-warning">
                {state.result.note}
              </div>
            )}
            <PreviewBody model={state.result.model} />
          </div>
        )}

        {toast && (
          <div className="shrink-0 border-t border-line bg-surface-2 px-3 py-1.5 text-11 text-fg-muted">
            <span className="break-all">{toast}</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function PreviewBody({ model }: { model: PreviewResult["model"] }) {
  switch (model.kind) {
    case "image":
      return <ImagePreview bytes={model.bytes} mime={model.mime} />;
    case "pdf":
      return <PdfPreview bytes={model.bytes} />;
    case "sheet":
      return <SheetPreview sheets={model.sheets} />;
    case "doc":
      return <DocxPreview blocks={model.blocks} />;
    case "slides":
      return <SlidesPreview slides={model.slides} />;
    case "text":
      return <TextPreview text={model.text} />;
    case "media":
      return <MediaPreview bytes={model.bytes} mime={model.mime} audio={model.audio} />;
    case "archive":
      return (
        <ArchivePreview
          entries={model.entries}
          format={model.format}
          totalSize={model.totalSize}
        />
      );
    case "hex":
      return <HexPreview bytes={model.bytes} detected={model.detected} />;
    case "unsupported":
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="flex max-w-[460px] flex-col items-center gap-2 text-center">
            <AlertCircle size={20} className="text-fg-subtle" />
            <p className="text-12 leading-relaxed text-fg">{model.reason}</p>
            {model.hint && <p className="text-11 leading-relaxed text-fg-subtle">{model.hint}</p>}
          </div>
        </div>
      );
  }
}
