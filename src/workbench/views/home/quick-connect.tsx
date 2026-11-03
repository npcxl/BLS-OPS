/**
 * 首页"快速连接"：临时输入地址，用现有凭据或一次性密码建连。
 *
 * 输入只用于这一次连接（`quickTarget` / `oneTimePassword` 是既有的标签字段）；
 * 勾选"保存为服务器"才落库，落库内容与服务器表单一致（不写入一次性密码）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { PageScroll } from "@/workbench/page-layout";
import { CredentialPicker } from "@/workbench/credential-picker";
import { useSubmit } from "@/hooks/use-submit";
import { useDomainStore } from "@/stores/domain-store";

/** How the quick-connect attempt authenticates. */
export type QuickConnectAuth = {
  credentialId?: string;
  /** Typed for this connection only; never stored. */
  password?: string;
};

export interface QuickConnectTarget {
  username: string;
  host: string;
  port: number;
}

export function QuickConnectForm({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: (target: QuickConnectTarget, auth: QuickConnectAuth, saveAsServer: boolean) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const credentials = useDomainStore((s) => s.credentials);
  const [username, setUsername] = useState("root");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [credentialId, setCredentialId] = useState<string>(credentials.find(item => item.username === "root")?.id ?? "");
  const [password, setPassword] = useState("");
  const [saveAsServer, setSaveAsServer] = useState(true);
  const submit = useSubmit();
  const [creatingCredential, setCreatingCredential] = useState(false);

  const usingOneTimePassword = credentialId === "";
  const parsedPort = Number(port.trim());

  const connect = () =>
    submit.run(async () => {
      if (creatingCredential) throw new Error(t("Save or cancel the new credential first"));
      const cleanHost = host.trim();
      if (!cleanHost) throw new Error(t("Please enter a host"));
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error(t("Port must be between 1 and 65535"));
      }
      if (usingOneTimePassword && !password) throw new Error(t("Please enter a password"));
      await onConnect(
        { username: username.trim() || "root", host: cleanHost, port: parsedPort },
        usingOneTimePassword ? { password } : { credentialId },
        saveAsServer,
      );
    });

  return (
    <form className="flex min-h-0 min-w-0 flex-1 flex-col" onSubmit={event => {event.preventDefault();void connect();}}>
      <PageScroll width="reading">
      <div className="flex flex-col gap-4 py-2">
        <div className="page-form-heading">{t("Connection details")}</div>
        <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
        <Field label={t("Host")} required>
          <Input
            autoFocus
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="192.168.1.10"
          />
        </Field>

          <Field label={t("Port")} required>
            <Input
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-4 border-t border-line/60 pt-4">
        <div className="page-form-heading">{t("Authentication")}</div>
        <Field label={t("Username")}>
          <Input value={username} disabled={creatingCredential} onChange={event => setUsername(event.target.value)} placeholder="root" />
        </Field>

        <CredentialPicker value={credentialId} username={username} host={host}
          label={t("Credential")} noneLabel={t("Use one-time password (not saved)")}
          onChange={setCredentialId} onEditingChange={setCreatingCredential}
          onCreated={credential=>{setCredentialId(credential.id);setUsername(credential.username);setPassword("");}} />

        {usingOneTimePassword && !creatingCredential && (
          <Field
            label={t("One-time password")}
            hint={
              credentials.length === 0
                ? t("No credentials yet. You can connect with a password directly; it will not be saved.")
                : t("Used for this connection only; not written to the system credential manager.")
            }
          >
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("Login password")}
            />
          </Field>
        )}
        </div>

        <label className="flex items-center gap-2 border-t border-line/60 pt-4 text-12 text-fg-muted">
          <input type="checkbox" checked={saveAsServer} onChange={(event) => setSaveAsServer(event.target.checked)} />
          {t("Save as server (connect directly from the list next time)")}
        </label>
        {usingOneTimePassword && saveAsServer && (
          <p className="-mt-1.5 pl-[22px] text-11 leading-relaxed text-fg-subtle">
            {t(
              "The server entry is saved without credentials — pick a credential or type the password again next time.",
            )}
          </p>
        )}

        {submit.error ? <ErrorState error={submit.error} compact /> : null}
      </div>
      </PageScroll>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
        <Button variant="ghost" size="sm" disabled={submit.pending || creatingCredential} onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="primary" size="sm" type="submit" disabled={submit.pending || creatingCredential}>
          {submit.pending ? t("Connecting") : t("Connect")}
        </Button>
      </div>
    </form>
  );
}
