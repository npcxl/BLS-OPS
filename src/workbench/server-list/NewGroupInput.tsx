import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";

/**
 * Inline "new group" editor. Enter saves, Escape cancels, and there are always
 * explicit 保存 / 取消 buttons — a keyboard-only hint is not discoverable.
 *
 * The input stays open when saving fails so the typed name is not lost and the
 * error next to it stays associated with the action that produced it.
 */
export function NewGroupInput({
  pending,
  onSave,
  onCancel,
}: {
  pending: boolean;
  /** Resolves to `true` when the group was created and the editor may close. */
  onSave: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    const name = value.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      if (await onSave(name)) setValue("");
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || pending;

  return (
    <div className="flex items-center gap-1 px-2.5 py-1">
      <input
        ref={inputRef}
        autoFocus
        aria-label={t("New group name")}
        data-testid="new-group-input"
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void save();
          if (event.key === "Escape") onCancel();
        }}
        placeholder={t("Group name, press Enter to save")}
        spellCheck={false}
        className="h-[24px] min-w-0 flex-1 rounded-[5px] border border-accent bg-surface-2 px-1.5 text-11 text-fg outline-none placeholder:text-fg-subtle"
      />
      <button
        type="button"
        aria-label={t("Save group")}
        data-testid="new-group-save"
        disabled={busy}
        className="rounded p-1 text-fg-subtle hover:text-success disabled:opacity-40"
        onClick={() => void save()}
      >
        <Check size={12} />
      </button>
      <button
        type="button"
        aria-label={t("Cancel new group")}
        data-testid="new-group-cancel"
        className="rounded p-1 text-fg-subtle hover:text-fg"
        onClick={onCancel}
      >
        <X size={12} />
      </button>
    </div>
  );
}
