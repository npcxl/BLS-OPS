import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

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
export function Modal({ open, title, description, width = 460, onClose, footer, children }: ModalProps) {
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

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 px-4"
      onMouseDown={onClose}
    >
      <div
        className="glass-panel-strong max-h-[85vh] overflow-hidden rounded-2xl"
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
  "h-[30px] w-full rounded-[6px] border border-line bg-surface-1 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent disabled:opacity-60";

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
    <p className="rounded-[6px] border border-danger/40 bg-danger/10 px-2 py-1.5 text-11 leading-relaxed text-danger">
      {children}
    </p>
  );
}
