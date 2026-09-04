import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { useSubmit } from "@/hooks/use-submit";
import type { NameDialog } from "./utils";

/**
 * Modal wrapper for NameDialog. `onConfirm` runs on submit; `onSaved` fires
 * only after a successful action (so the panel can refresh), `onClose` on any
 * dismissal.
 *
 * `dialog.title/label/submitLabel` 存的是英文 key（构造处无法调 hook），渲染
 * 处统一 `t(...)`；`initial` 是默认文件名（数据），构造处已按当前语言生成。
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
  const { t } = useTranslation();
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
      title={t(dialog.title)}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={submit.pending} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={submit.pending || !trimmed || Boolean(validationError)}
            onClick={() => void confirm()}
          >
            {submit.pending ? t("Processing") : t(dialog.submitLabel)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <Field label={t(dialog.label)}>
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
