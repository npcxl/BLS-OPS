/**
 * 新建 string 键的表单（SET NX，绝不覆盖已有键）。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormDialog } from "@/components/ui/form-dialog";
import { Field, fieldClass } from "@/components/ui/modal";
import { databaseApi } from "@/api/ops-api";
import { cn } from "@/lib/cn";
import { toDbError } from "@/stores/database-store";

export function NewKeyDialog({
  open,
  profileId,
  dbIndex,
  onClose,
  onCreated,
}: {
  open: boolean;
  profileId: string;
  dbIndex: number;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  // 每次重新打开都是干净的表单：上一轮的键名/报错不该跟着进来。
  useEffect(() => {
    if (!open) return;
    setKey("");
    setValue("");
    setKeyError(null);
    setFailure(null);
    setSaving(false);
  }, [open]);

  const submit = async () => {
    const trimmed = key.trim();
    if (!trimmed) {
      setKeyError(t("键名不能为空"));
      return;
    }
    // Redis 键允许空格，但前后空白几乎总是误粘贴 —— 明确提示，不静默裁剪。
    if (trimmed !== key) {
      setKeyError(t("键名首尾不能有空白字符"));
      return;
    }
    setKeyError(null);
    setFailure(null);
    setSaving(true);
    try {
      await databaseApi.redisCreateString(profileId, dbIndex, trimmed, value);
      onCreated(trimmed);
    } catch (cause) {
      setFailure(cause);
    } finally {
      setSaving(false);
    }
  };

  const errorInfo = failure ? toDbError(failure) : null;

  return (
    <FormDialog
      open={open}
      title={t("新建 string 键")}
      description={t("键不存在时才会创建（SET NX），不会覆盖已有键。")}
      size="md"
      submitLabel={t("创建")}
      submitting={saving}
      error={errorInfo ?? undefined}
      onSubmit={() => void submit()}
      onCancel={onClose}
      dirty={key.length > 0 || value.length > 0}
      footerExtra={`db ${dbIndex}`}
    >
      <Field label={t("键名")} required error={keyError}>
        <input
          className={fieldClass}
          value={key}
          spellCheck={false}
          autoComplete="off"
          data-autofocus
          onChange={(event) => setKey(event.target.value)}
          placeholder="user:1001"
        />
      </Field>
      <Field label={t("初始值")} hint={t("可留空：先建一个空字符串键。")}>
        <textarea
          className={cn(fieldClass, "h-24 resize-y py-1.5 font-mono")}
          value={value}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// 值面板
// ---------------------------------------------------------------------------
