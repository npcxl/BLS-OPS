import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { useSubmit } from "@/hooks/use-submit";
import type { NameDialog } from "./utils";

/**
 * Modal wrapper for NameDialog. `onConfirm` runs on submit; `onSaved` fires
 * only after a successful action (so the panel can refresh), `onClose` on any
 * dismissal.
 */
export function NamePromptModal({
  dialog,
  onClose,
  onSaved,
}: {
  dialog: NameDialog;
  onClose: () => void;
  onSaved: () => void;
}) {
  const submit = useSubmit();
  const [value, setValue] = useState(dialog.initial);
  const trimmed = value.trim();
  const validationError = trimmed ? dialog.validate(trimmed) : null;

  const confirm = () =>
    submit.run(async () => {
      await dialog.onConfirm(trimmed);
      onSaved();
    });

  return (
    <Modal
      open
      width={380}
      title={dialog.title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={submit.pending} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={submit.pending || !trimmed || Boolean(validationError)}
            onClick={() => void confirm()}
          >
            {submit.pending ? "处理中…" : dialog.submitLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <Field label={dialog.label}>
          <input
            autoFocus
            className={fieldClass}
            value={value}
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !validationError) void confirm();
            }}
          />
        </Field>
        {validationError && <ErrorText>{validationError}</ErrorText>}
        <ErrorText>{submit.error}</ErrorText>
      </div>
    </Modal>
  );
}
