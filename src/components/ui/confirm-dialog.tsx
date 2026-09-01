import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Reusable confirmation dialog for destructive or consequential actions. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && !pending) {
        event.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onConfirm, pending]);

  return (
    <Modal open={open} width={360} title={title} onClose={onCancel}>
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className={danger ? "mt-0.5 shrink-0 text-danger" : "mt-0.5 shrink-0 text-warning"} />
        <p className="text-12 leading-relaxed text-fg-muted">{description}</p>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={danger ? "danger" : "primary"} size="sm" disabled={pending} onClick={onConfirm}>
          {pending ? "处理中…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
