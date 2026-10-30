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
import { Field, Modal, fieldClass, selectClass } from "@/components/ui/modal";
import { useSubmit } from "@/hooks/use-submit";
import type { CredentialRecord } from "@/api/ops-api";
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

export function QuickConnectDialog({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: (target: QuickConnectTarget, auth: QuickConnectAuth, saveAsServer: boolean) => void;
}) {
  const { t } = useTranslation();
  const credentials = useDomainStore((s) => s.credentials);
  const [username, setUsername] = useState("root");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [credentialId, setCredentialId] = useState<string>(credentials[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [saveAsServer, setSaveAsServer] = useState(true);
  const submit = useSubmit();

  const usingOneTimePassword = credentialId === "";
  const parsedPort = Number(port.trim());

  const connect = () =>
    submit.run(async () => {
      const cleanHost = host.trim();
      if (!cleanHost) throw new Error(t("Please enter a host"));
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error(t("Port must be between 1 and 65535"));
      }
      if (usingOneTimePassword && !password) throw new Error(t("Please enter a password"));
      onConnect(
        { username: username.trim() || "root", host: cleanHost, port: parsedPort },
        usingOneTimePassword ? { password } : { credentialId },
        saveAsServer,
      );
    });

  return (
    <Modal
      open
      width={440}
      title={t("Quick connect")}
      description={t("Connect once without saving a server, or save it for next time.")}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" size="sm" disabled={submit.pending} onClick={() => void connect()}>
            {submit.pending ? t("Connecting") : t("Connect")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t("Host")}>
          <input
            autoFocus
            className={fieldClass}
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="192.168.1.10"
            onKeyDown={(event) => {
              if (event.key === "Enter") void connect();
            }}
          />
        </Field>

        <div className="grid grid-cols-[1fr_96px] gap-2">
          <Field label={t("Username")}>
            <input
              className={fieldClass}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label={t("Port")}>
            <input
              className={fieldClass}
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </Field>
        </div>

        {credentials.length > 0 && (
          <Field
            label={t("Saved credentials")}
            hint={t("Select \"one-time password\" to connect without any saved credentials")}
          >
            <select
              className={selectClass}
              value={credentialId}
              onChange={(event) => setCredentialId(event.target.value)}
            >
              <option value="">{t("Use one-time password (not saved)")}</option>
              {credentials.map((credential: CredentialRecord) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name} · {credential.username} ·{" "}
                  {credential.credential_type === "private_key" ? t("Private key") : t("Password")}
                </option>
              ))}
            </select>
          </Field>
        )}

        {usingOneTimePassword && (
          <Field
            label={t("One-time password")}
            hint={
              credentials.length === 0
                ? t("No credentials yet. You can connect with a password directly; it will not be saved.")
                : t("Used for this connection only; not written to the system credential manager.")
            }
          >
            <input
              type="password"
              className={fieldClass}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void connect();
              }}
              placeholder={t("Login password")}
            />
          </Field>
        )}

        <label className="flex items-center gap-2 text-12 text-fg-muted">
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
    </Modal>
  );
}
