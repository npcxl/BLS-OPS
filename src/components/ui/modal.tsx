import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useExiting } from "@/hooks/use-exiting";

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  width?: number;
  onClose?: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

/** Centered dialog used for host-key confirmation and entity forms. */
export function Modal({ open, title, description, width = 360, onClose, footer, children }: ModalProps) {
  const { render, exiting } = useExiting(open, 150);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!render) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[130] flex items-center justify-center bg-black/24 px-4",
        exiting ? "opacity-0 transition-opacity duration-150" : "overlay-scrim",
      )}
      onMouseDown={onClose}
    >
      <div
        className={cn(
          "glass-panel-strong max-h-[85vh] overflow-hidden rounded-[18px]",
          exiting
            ? "opacity-0 translate-y-2 scale-[0.985] transition-[opacity,transform] duration-150 ease-out"
            : "overlay-enter",
        )}
        style={{ width }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-13 font-semibold text-fg">{title}</h2>
            {description && <p className="mt-0.5 text-11 leading-relaxed text-fg-muted">{description}</p>}
          </div>
          {onClose && (
            <button
              type="button"
              aria-label="关闭"
              className="rounded-[5px] p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">{children}</div>

        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export const fieldClass =
  "h-[30px] w-full rounded-[8px] border border-line bg-surface-1/70 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle shadow-[inset_0_1px_0_rgb(255_255_255/0.45)] transition-colors focus:border-accent disabled:opacity-60";

export const selectClass = cn(fieldClass, "cursor-default pr-1");

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-11 font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="text-11 leading-relaxed text-fg-subtle">{hint}</span>}
    </label>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-[8px] border border-danger/30 bg-danger/10 px-2 py-1.5 text-11 leading-relaxed text-danger">
      {children}
    </p>
  );
}
