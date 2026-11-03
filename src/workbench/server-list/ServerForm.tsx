import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toErrorMessage, type ServerRecord } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useSubmit } from "@/hooks/use-submit";
import { UNGROUPED_LABEL } from "./sections";
import { PageScroll } from "@/workbench/page-layout";
import { CredentialPicker } from "@/workbench/credential-picker";

/** Full server editor. Shared by every sidebar and the workbench home. */
export function ServerForm({ server, onClose, variant = "modal" }: { server: ServerRecord; onClose: () => void; variant?: "modal" | "inline" }) {
  const { t } = useTranslation();
  const groups = useDomainStore((s) => s.groups);
  const servers = useDomainStore((s) => s.servers);
  const saveServer = useDomainStore((s) => s.saveServer);
  const testConnection = useDomainStore((s) => s.testConnection);
  const raiseChallenge = useSessionStore((s) => s.raiseChallenge);

  const [form, setForm] = useState<ServerRecord>(server);
  const [tagText, setTagText] = useState(server.tags.join(", "));
  const submit = useSubmit();
  const [creatingCredential, setCreatingCredential] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [testState, setTestState] = useState<{ pending: boolean; result: string | null }>({
    pending: false,
    result: null,
  });
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const isNew = !servers.some((item) => item.id === form.id);

  const save = () =>
    submit.run(async () => {
      if (creatingCredential) throw new Error(t("Save or cancel the new credential first"));
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
        if (variant === "inline" && !bodyRef.current?.contains(document.activeElement)) return;
        event.preventDefault();
        if (!submit.pending) void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const footer = (
        <>
          {saveMessage && <span className="mr-auto text-11 text-success">{t(saveMessage)}</span>}
          <Button variant="ghost" size="sm" disabled={submit.pending || creatingCredential} onClick={onClose}>
            {t("Close")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={submit.pending || creatingCredential}
            type={variant === "inline" ? "submit" : "button"}
            onClick={variant === "modal" ? () => void save() : undefined}
          >
            {submit.pending ? t("Saving") : t("Save Ctrl+S")}
          </Button>
        </>
  );
  const body = (
      <div ref={bodyRef} className={variant === "inline" ? "flex flex-col gap-4 py-2" : "flex flex-col gap-2.5"}>
        {variant === "inline" && <div className="page-form-heading">{t("Connection details")}</div>}
        <Field label={t("Name")}>
          <Input
            autoFocus={variant === "inline"}
            value={form.name}
            placeholder={t("e.g. API-01")}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>

        <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
          <Field label={t("Host")}>
            <Input
              value={form.host}
              placeholder={t("10.0.0.11 or example.com")}
              onChange={(event) => setForm({ ...form, host: event.target.value })}
            />
          </Field>
          <Field label={t("Port")}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
            />
          </Field>
        </div>

        {variant === "inline" && <div className="page-form-heading border-t border-line/60 pt-4">{t("Authentication")}</div>}
        <Field label={t("Username")}>
          <Input
            disabled={creatingCredential}
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
          />
        </Field>

        <CredentialPicker value={form.credential_id ?? ""} username={form.username} host={form.host}
          onEditingChange={setCreatingCredential}
          onChange={id=>setForm(current=>({...current,credential_id:id||null}))}
          onCreated={credential=>setForm(current=>({...current,credential_id:credential.id,username:credential.username}))} />

        {variant === "inline" && <div className="page-form-heading border-t border-line/60 pt-4">{t("Asset details")}</div>}
        <Field label={t("Group")}>
          <Select
            value={form.group_id ?? ""}
            placeholder={t(UNGROUPED_LABEL)}
            onChange={(value) => setForm({ ...form, group_id: value || null })}
            options={[
              { value: "", label: t(UNGROUPED_LABEL) },
              ...groups.map((group) => ({ value: group.id, label: group.name })),
            ]}
          />
        </Field>

        <Field label={t("Tags")} hint={t("Separate with commas")}>
          <Input
            value={tagText}
            placeholder="prod, api"
            onChange={(event) => setTagText(event.target.value)}
          />
        </Field>

        <Field
          label={t("Jump host (ProxyJump)")}
          hint={t("Leave empty for direct connection; the jump host itself also needs a credential")}
        >
          <Select
            value={form.proxy_jump_id ?? ""}
            placeholder={t("Direct connection")}
            onChange={(value) => setForm({ ...form, proxy_jump_id: value || null })}
            options={[
              { value: "", label: t("Direct connection") },
              ...servers
                .filter((item) => item.id !== form.id)
                .map((item) => ({ value: item.id, label: item.name, hint: item.host })),
            ]}
          />
        </Field>

        <div className="flex items-center gap-2 pt-1">
          <Button variant="outline" size="sm" disabled={testState.pending || creatingCredential} onClick={() => void runTest()}>
            <Plug size={12} />
            {testState.pending ? t("Testing…") : t("Test connection")}
          </Button>
          {testState.result && (
            <span className="min-w-0 flex-1 truncate text-11 text-fg-muted">{testState.result}</span>
          )}
        </div>

        {submit.error ? <ErrorState error={submit.error} compact /> : null}
      </div>
  );
  if (variant === "inline") return <form className="flex min-h-0 min-w-0 flex-1 flex-col"
    onSubmit={event => {event.preventDefault();void save();}}>
    <PageScroll width="reading">{body}</PageScroll>
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>
  </form>;
  return <Modal open size="md" title={isNew ? t("Add server") : t("Edit server — {{name}}", {name:server.name || server.host})}
    onClose={onClose} footer={footer} busy={submit.pending}>{body}</Modal>;
}
