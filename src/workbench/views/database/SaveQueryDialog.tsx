import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, Modal, fieldClass } from "@/components/ui/modal";

/** 保存 SQL 前必须显式命名，避免所有保存结果都叫“未命名查询”。 */
export function SaveQueryDialog({
  open,
  initialName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  initialName: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (open) setName(initialName);
  }, [initialName, open]);

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <Modal
      open={open}
      title={t("保存查询")}
      description={t("给这份 SQL 起一个名字，之后可在左侧「查询」中找到。")}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("取消")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!name.trim()}
            onClick={submit}
          >
            {t("保存")}
          </Button>
        </>
      }
    >
      <Field label={t("查询名称")}>
        <input
          autoFocus
          className={fieldClass}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={t("例如：最近 7 天订单")}
        />
      </Field>
    </Modal>
  );
}
