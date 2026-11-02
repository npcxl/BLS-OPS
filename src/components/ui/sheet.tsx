import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "@/components/icons";
import { cn } from "@/lib/cn";
import { useExiting } from "@/hooks/use-exiting";
import { isTopOverlayLayer, OverlayDepthContext, useOverlayLayer } from "@/components/ui/overlay";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Side sheet — the shared shell for inspectors and large previews.
 *
 * Same lifecycle contract as `Modal`: portal, overlay stack (Esc only closes the
 * top layer), remembered focus, Tab trap, and a `busy` state that swallows
 * close requests during saves. Only the placement and surface differ.
 */
export function Sheet({
  open,
  title,
  description,
  onClose,
  footer,
  actions,
  width = 520,
  busy = false,
  closeOnBackdrop = true,
  children,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClose?: () => void;
  footer?: ReactNode;
  /** Header actions, kept next to the close button. */
  actions?: ReactNode;
  width?: number;
  busy?: boolean;
  closeOnBackdrop?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { render, exiting } = useExiting(open, 150);
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const layer = useOverlayLayer(open, "sheet");

  const requestClose = useCallback(() => {
    if (busy || !onClose) return;
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const layerId = layer.id;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopOverlayLayer(layerId)) return;
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, requestClose, layer.id]);

  if (!render) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 flex justify-end bg-black/24",
        exiting ? "opacity-0 transition-opacity duration-150" : "overlay-scrim",
      )}
      style={{ zIndex: layer.zIndex }}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!closeOnBackdrop) return;
        requestClose();
      }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className={cn(
          "page-overlay-surface h-full max-w-full outline-none",
          exiting ? "translate-x-3 opacity-0 transition-[opacity,transform] duration-150" : "overlay-enter",
        )}
        style={{ width: `min(${width}px, 94vw)` }}
      >
        <div className="page-overlay-header">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="page-overlay-title">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="page-overlay-subtitle">
                {description}
              </p>
            )}
          </div>
          {actions}
          {onClose && (
            <button
              type="button"
              aria-label={t("Close")}
              aria-disabled={busy || undefined}
              className={cn(
                "shrink-0 rounded-[5px] p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg",
                busy && "pointer-events-none opacity-40",
              )}
              onClick={requestClose}
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <OverlayDepthContext.Provider value={layer.childDepth}>{children}</OverlayDepthContext.Provider>
        </div>

        {footer && <div className="page-overlay-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
