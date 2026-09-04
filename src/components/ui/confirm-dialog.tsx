import { useEffect } from "react";
import { useTranslation } from "react-i18next";
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
  confirmLabel,
  cancelLabel,
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  // 默认按钮文案存英文 key，此处解析（common 已有 Confirm/Cancel）。
  const confirmText = confirmLabel ?? t("Confirm");
  const cancelText = cancelLabel ?? t("Cancel");  useEffect(() => {
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
      <p className="text-12 leading-relaxed text-fg-muted">{description}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          {cancelText}
        </Button>
        <Button variant={danger ? "danger" : "primary"} size="sm" disabled={pending} onClick={onConfirm}>
          {pending ? t("Processing") : confirmText}
        </Button>
      </div>
    </Modal>
  );
}
