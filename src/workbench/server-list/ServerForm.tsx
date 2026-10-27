import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MacButton } from "@/components/ui/mac-button";
import { ErrorText, Field, Modal, fieldClass, selectClass } from "@/components/ui/modal";
import { toErrorMessage, type ServerRecord } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useSubmit } from "@/hooks/use-submit";
import { UNGROUPED_LABEL } from "./sections";

/** Full server editor. Shared by every sidebar and the workbench home. */
export function ServerForm({ server, onClose }: { server: ServerRecord; onClose: () => void }) {
  const { t } = useTranslation();
  const credentials = useDomainStore((s) => s.credentials);
  const groups = useDomainStore((s) => s.groups);
  const servers = useDomainStore((s) => s.servers);
  const saveServer = useDomainStore((s) => s.saveServer);
  const testConnection = useDomainStore((s) => s.testConnection);
  const raiseChallenge = useSessionStore((s) => s.raiseChallenge);

  const [form, setForm] = useState<ServerRecord>(server);
  const [tagText, setTagText] = useState(server.tags.join(", "));
  const submit = useSubmit();
  const [testState, setTestState] = useState<{ pending: boolean; result: string | null }>({
    pending: false,
    result: null,
  });
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const isNew = !servers.some((item) => item.id === form.id);

  const save = () =>
    submit.run(async () => {
      await saveServer({
        ...form,
        tags: tagText
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      // 存 i18n key，渲染处 t()：语言切换后残留的提示也跟随当前语言。
      setSaveMessage("Saved");
    });

  const runTest = async () => {
    if (isNew) {
      setTestState({ pending: false, result: t("Save the server before testing the connection") });
      return;
    }
    setTestState({ pending: true, result: null });
    try {
      const result = await testConnection(form.id);
      if (result.status === "connected") {
        setTestState({
          pending: false,
          result: t("Connected ({{name}})", {
            name: `${result.fingerprint_type} ${result.fingerprint}`,
          }),
        });
        return;
      }
      // Surface the same confirmation the terminal would show, so a server can
      // be trusted straight from the form.
      setTestState({ pending: false, result: t("Waiting for host key confirmation…") });
      raiseChallenge({
        sessionId: `probe-${form.id}`,
        kind: result.status === "host_key_changed" ? "changed" : "unknown",
        challengeHost: result.challenge_host,
        challengePort: result.challenge_port,
        targetHost: result.host,
        targetPort: result.port,
        isJumpHop: result.challenge_port !== result.port || result.challenge_host !== result.host,
        fingerprint: result.fingerprint,
        fingerprintType: result.fingerprint_type,
        knownFingerprint: "known_fingerprint" in result ? result.known_fingerprint : undefined,
        retry: () => void runTest(),
        cancel: () => setTestState({ pending: false, result: t("Host key rejected") }),
      });
    } catch (cause) {
      // 后端错误消息原样透传显示，不进语言包。
      setTestState({ pending: false, result: toErrorMessage(cause) });
    }
  };

  useEffect(() => {
    if (!saveMessage) return;
    const timer = window.setTimeout(() => setSaveMessage(null), 2200);
    return () => window.clearTimeout(timer);
  }, [saveMessage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!submit.pending) void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <Modal
      open
      width={360}
      title={isNew ? t("Add server") : t("Edit server — {{name}}", { name: server.name || server.host })}
      description={t("Credentials are stored in the system keychain; the database only keeps a reference.")}
      onClose={onClose}
      footer={
        <>
          {saveMessage && <span className="mr-auto text-11 text-success">{t(saveMessage)}</span>}
          <Button variant="ghost" size="sm" disabled={submit.pending} onClick={onClose}>
            {t("Close")}
          </Button>
          <MacButton variant="primary" disabled={submit.pending} onClick={() => void save()}>
            {submit.pending ? t("Saving") : t("Save Ctrl+S")}
          </MacButton>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <Field label={t("Name")}>
          <input
            className={fieldClass}
            value={form.name}
            placeholder={t("e.g. API-01")}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>

        <div className="grid grid-cols-[1fr_88px] gap-2">
          <Field label={t("Host")}>
            <input
              className={fieldClass}
              value={form.host}
              placeholder={t("10.0.0.11 or example.com")}
              onChange={(event) => setForm({ ...form, host: event.target.value })}
            />
          </Field>
          <Field label={t("Port")}>
            <input
              type="number"
              min={1}
              max={65535}
              className={fieldClass}
              value={form.port}
              onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
            />
          </Field>
        </div>

        <Field label={t("Username")}>
          <input
            className={fieldClass}
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
          />
        </Field>

        <Field
          label={t("Credential")}
          hint={
            credentials.length === 0
              ? t("No credentials yet. Create one in Settings → Credentials")
              : undefined
          }
        >
          <select
            className={selectClass}
            value={form.credential_id ?? ""}
            onChange={(event) => setForm({ ...form, credential_id: event.target.value || null })}
          >
            <option value="">{t("No credential")}</option>
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name} · {credential.username} ·{" "}
                {credential.credential_type === "private_key" ? t("Private key") : t("Password")}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t("Group")}>
          <select
            className={selectClass}
            value={form.group_id ?? ""}
            onChange={(event) => setForm({ ...form, group_id: event.target.value || null })}
          >
            <option value="">{t(UNGROUPED_LABEL)}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t("Tags")} hint={t("Separate with commas")}>
          <input
            className={fieldClass}
            value={tagText}
            placeholder="prod, api"
            onChange={(event) => setTagText(event.target.value)}
          />
        </Field>

        <Field
          label={t("Jump host (ProxyJump)")}
          hint={t("Leave empty for direct connection; the jump host itself also needs a credential")}
        >
          <select
            className={selectClass}
            value={form.proxy_jump_id ?? ""}
            onChange={(event) => setForm({ ...form, proxy_jump_id: event.target.value || null })}
          >
            <option value="">{t("Direct connection")}</option>
            {servers
              .filter((item) => item.id !== form.id)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.host}
                </option>
              ))}
          </select>
        </Field>

        <div className="flex items-center gap-2 pt-1">
          <Button variant="outline" size="sm" disabled={testState.pending} onClick={() => void runTest()}>
            <Plug size={12} />
            {testState.pending ? t("Testing…") : t("Test connection")}
          </Button>
          {testState.result && (
            <span className="min-w-0 flex-1 truncate text-11 text-fg-muted">{testState.result}</span>
          )}
        </div>

        <ErrorText>{submit.error}</ErrorText>
      </div>
    </Modal>
  );
}
