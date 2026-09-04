import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MacButton } from "@/components/ui/mac-button";
import { ErrorText, Field, Modal, fieldClass, selectClass } from "@/components/ui/modal";
import { toErrorMessage, type ServerRecord } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useSubmit } from "@/hooks/use-submit";

/** Full server editor. Shared by every sidebar and the workbench home. */
export function ServerForm({ server, onClose }: { server: ServerRecord; onClose: () => void }) {
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
      setSaveMessage("已保存");
    });

  const runTest = async () => {
    if (isNew) {
      setTestState({ pending: false, result: "请先保存服务器后再测试连接" });
      return;
    }
    setTestState({ pending: true, result: null });
    try {
      const result = await testConnection(form.id);
      if (result.status === "connected") {
        setTestState({
          pending: false,
          result: `连接成功（${result.fingerprint_type} ${result.fingerprint}）`,
        });
        return;
      }
      // Surface the same confirmation the terminal would show, so a server can
      // be trusted straight from the form.
      setTestState({ pending: false, result: "等待主机指纹确认…" });
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
        cancel: () => setTestState({ pending: false, result: "已拒绝该主机指纹" }),
      });
    } catch (cause) {
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
      title={isNew ? "新增服务器" : `编辑服务器 — ${server.name || server.host}`}
      description="凭据密钥保存在系统凭据管理器中，数据库只保存引用。"
      onClose={onClose}
      footer={
        <>
          {saveMessage && <span className="mr-auto text-11 text-success">{saveMessage}</span>}
          <Button variant="ghost" size="sm" disabled={submit.pending} onClick={onClose}>
            关闭
          </Button>
          <MacButton variant="primary" disabled={submit.pending} onClick={() => void save()}>
            {submit.pending ? "保存中…" : "保存 Ctrl+S"}
          </MacButton>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <Field label="名称">
          <input
            className={fieldClass}
            value={form.name}
            placeholder="例如 API-01"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>

        <div className="grid grid-cols-[1fr_88px] gap-2">
          <Field label="主机">
            <input
              className={fieldClass}
              value={form.host}
              placeholder="10.0.0.11 或 example.com"
              onChange={(event) => setForm({ ...form, host: event.target.value })}
            />
          </Field>
          <Field label="端口">
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

        <Field label="用户名">
          <input
            className={fieldClass}
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
          />
        </Field>

        <Field
          label="凭据"
          hint={credentials.length === 0 ? "还没有凭据，请在“设置 → 凭据”中创建" : undefined}
        >
          <select
            className={selectClass}
            value={form.credential_id ?? ""}
            onChange={(event) => setForm({ ...form, credential_id: event.target.value || null })}
          >
            <option value="">未绑定凭据</option>
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name} · {credential.username} ·{" "}
                {credential.credential_type === "private_key" ? "私钥" : "密码"}
              </option>
            ))}
          </select>
        </Field>

        <Field label="分组">
          <select
            className={selectClass}
            value={form.group_id ?? ""}
            onChange={(event) => setForm({ ...form, group_id: event.target.value || null })}
          >
            <option value="">未分组</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="标签" hint="用逗号分隔">
          <input
            className={fieldClass}
            value={tagText}
            placeholder="prod, api"
            onChange={(event) => setTagText(event.target.value)}
          />
        </Field>

        <Field label="跳板机 (ProxyJump)" hint="留空表示直连；跳板机自身也需要绑定凭据">
          <select
            className={selectClass}
            value={form.proxy_jump_id ?? ""}
            onChange={(event) => setForm({ ...form, proxy_jump_id: event.target.value || null })}
          >
            <option value="">直连</option>
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
            {testState.pending ? "测试中…" : "测试连接"}
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
