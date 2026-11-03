import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Modal, fieldClass } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useActionError } from "@/hooks/use-action-error";
import { useSubmit } from "@/hooks/use-submit";
import { CREDENTIAL_TYPES, opsApi, type CredentialRecord } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";

export function CredentialForm({
  credential,
  onClose,
  onSaved,
  variant = "modal",
}: {
  credential: CredentialRecord;
  onClose: () => void;
  onSaved?: (credential: CredentialRecord) => void;
  variant?: "modal" | "inline";
}) {
  const { t } = useTranslation();
  const saveCredential = useDomainStore((s) => s.saveCredential);
  const credentials = useDomainStore((s) => s.credentials);

  const [form, setForm] = useState<CredentialRecord>(credential);
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [importing, setImporting] = useState(false);
  const [importedFrom, setImportedFrom] = useState<string | null>(null);
  // 导入私钥失败：多半是文件不是 UTF-8 / 不是私钥 / 权限不足 —— 要能看清原因。
  const {
    error: importError,
    fail: failImport,
    clear: clearImport,
  } = useActionError();
  const submit = useSubmit();

  const existing = credentials.find((item) => item.id === form.id);
  const isNew = !existing;
  const isPrivateKey = form.credential_type === "private_key";

  /**
   * 从本地私钥文件导入。
   *
   * 文件选择器只提供路径；真正读取在 Rust 侧（≤64 KiB、必须 UTF-8、
   * 内容必须真的是私钥）。读到的内容只进当前表单，**不落库** ——
   * 仍要用户点「保存」才会写进系统凭据管理器。
   *
   * 不传 `filters`：`id_rsa` / `id_ed25519` 这类文件**没有扩展名**，
   * 按扩展名过滤会把最常见的场景挡在外面；内容是主防线。
   */
  const importKeyFile = async () => {
    clearImport();
    setImporting(true);
    try {
      const { open: openFileDialog } = await import("@tauri-apps/plugin-dialog");
      const path = await openFileDialog({
        multiple: false,
        title: t("Select a private key file"),
      });
      if (typeof path !== "string" || !path) return;
      const imported = await opsApi.credentialReadPrivateKeyFile(path);
      setSecret(imported.content);
      setImportedFrom(
        imported.encrypted === true
          ? t("Loaded {{name}} — it is encrypted, enter its passphrase below", {
              name: imported.file_name,
            })
          : t("Loaded {{name}}", { name: imported.file_name }),
      );
    } catch (cause) {
      failImport(cause, () => void importKeyFile());
    } finally {
      setImporting(false);
    }
  };

  const save = () =>
    submit.run(async () => {
      if (isNew && (!form.name.trim() || !form.username.trim() || !secret)) {
        throw new Error(t("Fill in the credential name, username and secret"));
      }
      const saved = await saveCredential(
        { ...form, name: form.name.trim(), username: form.username.trim() },
        // **秘密值不 trim**：首尾空格可以是密码本身的一部分，去掉就是另一个密码。
        // 空字符串在这里表示"这次没提供"，后端会保留原值。
        secret || undefined,
        // 口令三态：留空 = 保留原值；清除必须走显式按钮（见下）。
        isPrivateKey ? passphrase || undefined : undefined,
      );
      setSecret("");
      setPassphrase("");
      onSaved?.(saved);
      onClose();
    });

  /**
   * 显式清除已保存的私钥口令。
   *
   * 为什么需要它：空输入已改为"保留原值"，所以"清除"不能靠留空表达 ——
   * 必须有一个明确的动作，否则用户没有办法删掉旧口令。
   */
  const clearPassphrase = () =>
    submit.run(async () => {
      await saveCredential(
        { ...form, name: form.name.trim(), username: form.username.trim() },
        undefined,
        "",
      );
      onClose();
    });

  const footer = (
        <>
          <Button variant="ghost" size="sm" disabled={submit.pending} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" size="sm" disabled={submit.pending} onClick={() => void save()}>
            {submit.pending ? t("Saving") : t(variant === "inline" ? "Save credential" : "Save")}
          </Button>
        </>
  );
  const body = (
      <div className="flex flex-col gap-3">
        <Field label={t("Name")} required>
          <input
            className={fieldClass}
            value={form.name}
            placeholder={t("e.g. production root")}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>

        <Field label={t("Username")} required>
          <input
            className={fieldClass}
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
          />
        </Field>

        <Field label={t("Type")}>
          <Select
            className="w-full"
            value={form.credential_type}
            ariaLabel={t("Type")}
            options={CREDENTIAL_TYPES.map((type) => ({ value: type.value, label: t(type.label) }))}
            onChange={(next) => {
              if (variant === "inline" && next !== form.credential_type) {
                setSecret("");setPassphrase("");setImportedFrom(null);
              }
              setForm({ ...form, credential_type: next });
            }}
          />
        </Field>

        <Field
          label={isPrivateKey ? t("Private key content") : t("Password")}
          required={isNew}
          hint={
            !isNew && existing?.secret_ref
              ? isPrivateKey
                ? t("Leave empty to keep the saved private key")
                : t("Leave empty to keep the saved password")
              : undefined
          }
        >
          {isPrivateKey || variant === "modal" ? <textarea
            autoFocus={variant === "inline"}
            className="h-28 w-full resize-none rounded-[8px] border border-line bg-surface-1/70 px-2 py-1.5 font-mono text-11 text-fg outline-none placeholder:text-fg-subtle shadow-[inset_0_1px_0_rgb(255_255_255/0.45)] focus:border-accent"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              isPrivateKey
                ? "-----BEGIN OPENSSH PRIVATE KEY-----"
                : isNew
                  ? t("Login password (required)")
                  : t("Leave unchanged")
            }
          /> : <Input type="password" value={secret} autoComplete="new-password" autoFocus
            onChange={event => setSecret(event.target.value)} placeholder={t("Login password (required)")} />}
          {isPrivateKey && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="credential-import-key"
                disabled={importing}
                className="rounded-[7px] border border-line px-2 py-1 text-11 text-fg-muted disabled:opacity-50"
                onClick={() => void importKeyFile()}
              >
                {importing ? t("Reading file") : t("Import from file")}
              </button>
              {importedFrom ? (
                <span className="text-11 text-fg-subtle" data-testid="credential-import-source">
                  {importedFrom}
                </span>
              ) : null}
            </div>
          )}
          {importError ? <ErrorState error={importError} compact /> : null}
        </Field>

        {isPrivateKey && (
          <Field
            label={t("Key passphrase")}
            hint={t("Only needed when the private key itself is encrypted; leave empty for no passphrase")}
          >
            <input
              type="password"
              className={fieldClass}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={t("Optional")}
            />
            {!isNew && existing?.passphrase_ref ? (
              <button
                type="button"
                data-testid="credential-clear-passphrase"
                disabled={submit.pending}
                onClick={() => void clearPassphrase()}
                className="mt-1.5 text-11 text-fg-subtle underline-offset-2 hover:text-fg hover:underline disabled:opacity-50"
              >
                {t("Clear the saved passphrase")}
              </button>
            ) : null}
          </Field>
        )}

        {isNew && (
          <p className="flex items-center gap-1.5 text-11 text-fg-subtle">
            <ShieldCheck size={12} />
            {isPrivateKey
              ? t("Paste the private key content when creating a key credential.")
              : t("Fill in the password when creating a password credential.")}
          </p>
        )}

        {submit.error ? <ErrorState error={submit.error} compact /> : null}
      </div>
  );
  if (variant === "inline") return <div className="flex flex-col gap-4" onKeyDown={event => {
    if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
      event.preventDefault();event.stopPropagation();if (!submit.pending) void save();
    }
  }}>{body}<div className="flex items-center justify-end gap-2">{footer}</div></div>;
  return <Modal open width={480}
    title={isNew ? t("Add credential") : t("Edit credential — {{name}}", {name:credential.name})}
    description={isPrivateKey ? t("The private key and its passphrase are one configuration; an empty passphrase means an unencrypted key.") : t("The password is written to the system credential manager and cannot be viewed again later.")}
    onClose={onClose} busy={submit.pending} footer={footer}>{body}</Modal>;
}
