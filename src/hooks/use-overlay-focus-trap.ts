import { useEffect, type RefObject } from "react";
import { isTopOverlayLayer } from "@/components/ui/overlay";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Prefer the first control a form dialog should start on, not the close button. */
const FIELD_SELECTOR =
  'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])';

/**
 * Shared modal focus contract: remember and restore the trigger, keep Tab inside
 * the panel, and only let the top overlay consume Esc.
 *
 * `Modal` and the large file preview use the same hook so their keyboard and
 * screen-reader behaviour cannot drift apart.
 */
export function useOverlayFocusTrap<T extends HTMLElement>({
  open,
  panelRef,
  layerId,
  onRequestClose,
  initialFocus = "auto",
}: {
  open: boolean;
  panelRef: RefObject<T | null>;
  layerId: string;
  onRequestClose: () => void;
  /** `auto`: data-autofocus → first field → first focusable → panel. */
  initialFocus?: "auto" | "panel";
}) {
  /** Open: remember and move focus. Close: give it back. */
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const preferred =
        initialFocus === "panel"
          ? panel
          : (panel.querySelector<HTMLElement>("[data-autofocus]") ??
            panel.querySelector<HTMLElement>(FIELD_SELECTOR) ??
            panel.querySelector<HTMLElement>(FOCUSABLE) ??
            panel);
      preferred.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [initialFocus, open, panelRef]);

  /** Esc + Tab: only the top layer, and never steal an already-consumed event. */
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopOverlayLayer(layerId)) return;
      if (event.defaultPrevented) return;

      if (event.key === "Escape") {
        event.preventDefault();
        onRequestClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => !node.hasAttribute("hidden") && node.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [layerId, onRequestClose, open, panelRef]);
}
