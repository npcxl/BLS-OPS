import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Download,
  Loader2,
  Pencil,
  X,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading";
import { useOverlayLayer } from "@/components/ui/overlay";
import { useOverlayFocusTrap } from "@/hooks/use-overlay-focus-trap";
import { PageNotice, PageStatusBar } from "@/workbench/page-layout";
import { opsApi } from "@/api/ops-api";
import { fileKind, isEditableKind } from "@/lib/file-kind";
import { toAppError } from "@/lib/app-error";
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
  /** 保留原始异常：交给 ErrorState 统一转成"阶段 + 摘要 + 详情"。 */
  | { status: "error"; cause: unknown }
  | { status: "ready"; result: PreviewResult };

/**
 * 预览来源。
 *
 * 服务器文件走 SFTP（沿用组件原有读取），本地文件直接把字节交给同一个
 * `buildPreview` —— 两条路只是"字节从哪来"不同，渲染与错误提示完全共用。
 */
export type PreviewSource =
  | { kind: "remote"; sessionId: string; path: string }
  | { kind: "local"; name: string; bytes: Uint8Array; size?: number; mime?: string };

export interface FilePreviewModalProps {
  /** 旧的远程签名，调用方不用改。 */
  sessionId?: string;
  target?: PreviewTarget;
  /** 新签名：本地或远程，二选一。 */
  source?: PreviewSource;
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
export default function FilePreviewModal({ sessionId, target, source, onClose, onEdit }: FilePreviewModalProps) {
  const { t } = useTranslation();
  const { render, exiting } = useExiting(true, 150);
  const [state, setState] = useState<State>({ status: "loading" });
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** 重试计数：失败后点「重试」重新拉一次文件。 */
  const [attempt, setAttempt] = useState(0);

  // 预览是一个全屏浮层：登记到浮层栈，Esc 只关最上层（上面的确认框先关）。
  const layer = useOverlayLayer(true, "preview");
  const panelRef = useRef<HTMLDivElement>(null);

  /** 统一成一种来源：本地字节优先，否则按远程路径读 SFTP。 */
  const remote = source
    ? source.kind === "remote"
      ? source
      : null
    : sessionId && target
      ? { kind: "remote" as const, sessionId, path: target.path }
      : null;
  const local = source?.kind === "local" ? source : null;
  const name = local?.name ?? target?.name ?? "";
  const size = local?.size ?? target?.size ?? local?.bytes.length ?? 0;

  // 依赖必须是稳定值：`local` / `remote` 每次渲染都是新对象，直接进 deps 会无限重读。
  const localBytes = local?.bytes ?? null;
  const localMime = local?.mime ?? "";
  const localSize = local?.size;
  const remoteSession = remote?.sessionId ?? null;
  const remotePath = remote?.path ?? null;

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;
    setState({ status: "loading" });

    void (async () => {
      try {
        // 本地附件还没上传：字节就在内存里，不需要也不该去连服务器。
        const payload = localBytes
          ? { mime: localMime, size: localSize ?? localBytes.length, bytes: localBytes }
          : remoteSession && remotePath
            ? await opsApi.sftpReadBinary(remoteSession, remotePath, PREVIEW_BUDGET).then((res) => ({
                mime: res.mime,
                size: res.size,
                bytes: base64ToBytes(res.data),
              }))
            : null;
        if (cancelled) return;
        if (!payload) throw new Error(t("没有可预览的来源"));
        const result = buildPreview({
          name: name || "file",
          mime: payload.mime,
          bytes: payload.bytes,
          size: payload.size,
        });
        if (cancelled) {
          result.dispose();
          return;
        }
        dispose = result.dispose;
        setState({ status: "ready", result });
      } catch (cause) {
        if (!cancelled) setState({ status: "error", cause });
      }
    })();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [localBytes, localMime, localSize, remoteSession, remotePath, name, attempt, t]);

  // Same focus, Tab and Esc contract as `Modal`; the preview only keeps its
  // full-bleed body layout.
  useOverlayFocusTrap({
    open: true,
    panelRef,
    layerId: layer.id,
    onRequestClose: onClose,
    initialFocus: "panel",
  });

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const download = async () => {
    if (downloading || !remote) return;
    setDownloading(true);
    setToast(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const destination = await save({
        title: t("Download {{name}}", { name }),
        defaultPath: name,
      });
      if (!destination) return;
      const written = await opsApi.sftpDownloadFile(remote.sessionId, remote.path, destination);
      setToast(t("Saved {{size}} → {{path}}", { size: formatSize(written), path: destination }));
    } catch (cause) {
      setToast(t("Download failed: {{message}}", { message: toAppError(cause).message }));
    } finally {
      setDownloading(false);
    }
  };

  if (!render) return null;

  const kind = fileKind({ name, kind: "file" });
  /** 本地文件的"路径"就是它自己的名字；远程才有绝对路径。 */
  const location = remote?.path ?? t("本地文件（未上传）");

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 flex items-center justify-center bg-black/40 px-4 py-6",
        exiting ? "opacity-0 transition-opacity duration-150" : "overlay-scrim",
      )}
      style={{ zIndex: layer.zIndex }}
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        tabIndex={-1}
        className={cn(
          "page-overlay-surface h-[88vh] max-h-[88vh] w-[min(1100px,94vw)] outline-none",
          exiting
            ? "opacity-0 translate-y-2 scale-[0.985] transition-[opacity,transform] duration-150 ease-out"
            : "overlay-enter",
        )}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="page-overlay-header items-center">
          <span className="mt-0.5 shrink-0">
            <Icon icon={FILE_ICONS[kind.iconKey]} width={15} height={15} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="page-overlay-title truncate">{name}</h2>
            <p className="page-overlay-subtitle truncate">
              {location} · {formatSize(size)} · {t(kind.label)}
            </p>
          </div>
          {/* 本地文件已经在用户机器上，没有"下载"这回事。 */}
          {remote && (
            <Button
              size="xs"
              variant="secondary"
              disabled={downloading}
              onClick={() => void download()}
            >
              {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {t("Download")}
            </Button>
          )}
          {onEdit && target && remote && isEditableKind({ name, kind: "file" }) && (
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

        {state.status === "loading" && <LoadingState className="h-full" label={t("Reading file…")} />}

        {state.status === "error" && (
          <div className="flex flex-1 items-center justify-center p-6">
            <ErrorState
              error={state.cause}
              title={t("Preview failed")}
              description={t("You can download it to view locally.")}
              onRetry={() => setAttempt((value) => value + 1)}
            />
          </div>
        )}

        {state.status === "ready" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {state.result.note && (
              <PageNotice tone="warning" className="border-x-0 border-t-0">
                {state.result.note}
              </PageNotice>
            )}
            <PreviewBody model={state.result.model} />
          </div>
        )}

        {toast && (
          <PageStatusBar className="justify-start whitespace-normal">
            <span className="break-all">{toast}</span>
          </PageStatusBar>
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
        <EmptyState
          className="h-full"
          icon={<AlertCircle size={18} strokeWidth={1.5} />}
          title={model.reason}
          description={model.hint}
        />
      );
  }
}
