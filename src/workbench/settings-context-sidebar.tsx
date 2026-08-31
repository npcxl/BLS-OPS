import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass, selectClass } from "@/components/ui/modal";
import { CREDENTIAL_TYPES, toErrorMessage, type CredentialRecord } from "@/api/ops-api";
import { emptyCredential, useDomainStore } from "@/stores/domain-store";
import { useSubmit } from "@/hooks/use-submit";
import { KnownHostsPanel } from "./host-key-dialog";

function SubTitle({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between px-2.5">
      <span className="text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">{children}</span>
      {actions}
    </div>
  );
}

/** Settings module sidebar: credentials, known hosts and runtime diagnostics. */
export function SettingsContextSidebar() {
  const credentials = useDomainStore((s) => s.credentials);
  const refreshCredentials = useDomainStore((s) => s.refreshCredentials);
  const appInfo = useDomainStore((s) => s.appInfo);

  const [editing, setEditing] = useState<CredentialRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      await refreshCredentials();
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [refreshCredentials]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (credential: CredentialRecord) => {
    const store = useDomainStore.getState();
    const references = store.servers.filter((item) => item.credential_id === credential.id).length;
    const message =
      references > 0
        ? `有 ${references} 台服务器正在使用凭据“${credential.name}”。\n删除后这些服务器会变为“未绑定凭据”，需要重新选择才能连接。\n\n确定继续删除吗？`
        : `确定删除凭据“${credential.name}”吗？此操作会同时清除系统凭据管理器中的密钥。`;
    if (!window.confirm(message)) return;
    try {
      await store.deleteCredential(credential.id, true);
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  return (
    <div className="flex flex-col gap-1 pb-3">
      <div className="px-2.5 pt-1.5">
        <SubTitle
          actions={
            <Button
              variant="ghost"
              size="xs"
              className="h-5 px-1"
              aria-label="新增凭据"
              onClick={() => setEditing(emptyCredential())}
            >
              <Plus size={12} />
            </Button>
          }
        >
          凭据
        </SubTitle>
        <p className="mt-1 text-11 leading-relaxed text-fg-subtle">
          密钥只写入系统凭据管理器，数据库仅保存引用，且不会回传到界面。
        </p>
      </div>

      {credentials.length === 0 ? (
        <p className="px-2.5 py-2 text-11 text-fg-subtle">暂无凭据</p>
      ) : (
        credentials.map((credential) => (
          <div
            key={credential.id}
            className="group flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 hover:bg-surface-hover"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => setEditing(credential)}
            >
              <KeyRound size={13} className="shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-12 text-fg">{credential.name}</span>
                <span className="block truncate text-11 text-fg-subtle">
                  {credential.username} ·{" "}
                  {credential.credential_type === "private_key" ? "私钥" : "密码"} ·{" "}
                  {credential.secret_ref ? "密钥已保存" : "缺少密钥"}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={`删除凭据 ${credential.name}`}
              className="shrink-0 rounded p-1 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
              onClick={() => void remove(credential)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))
      )}

      <div className="mt-3 px-2.5">
        <SubTitle>已知主机</SubTitle>
      </div>
      <KnownHostsPanel />

      {appInfo && (
        <div className="mt-3 px-2.5">
          <SubTitle>运行环境</SubTitle>
          <dl className="mt-1 flex flex-col gap-0.5 text-11 text-fg-subtle">
            <div className="flex gap-2">
              <dt className="w-16 shrink-0">版本</dt>
              <dd className="min-w-0 flex-1 truncate">v{appInfo.version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0">Schema</dt>
              <dd className="min-w-0 flex-1 truncate">v{appInfo.schema_version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0">平台</dt>
              <dd className="min-w-0 flex-1 truncate">
                {appInfo.os} / {appInfo.arch}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0">KeepAlive</dt>
              <dd className="min-w-0 flex-1 truncate">{appInfo.keepalive_secs}s</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0">数据库</dt>
              <dd className="min-w-0 flex-1 break-all">{appInfo.db_path}</dd>
            </div>
          </dl>
        </div>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {editing && <CredentialForm credential={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CredentialForm({
  credential,
  onClose,
}: {
  credential: CredentialRecord;
  onClose: () => void;
}) {
  const saveCredential = useDomainStore((s) => s.saveCredential);
  const credentials = useDomainStore((s) => s.credentials);

  const [form, setForm] = useState<CredentialRecord>(credential);
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const submit = useSubmit();

  const existing = credentials.find((item) => item.id === form.id);
  const isNew = !existing;
  const isPrivateKey = form.credential_type === "private_key";

  const save = () =>
    submit.run(async () => {
      await saveCredential(
        { ...form, name: form.name.trim(), username: form.username.trim() },
        secret.trim() || undefined,
        isPrivateKey ? passphrase.trim() || undefined : undefined,
      );
      onClose();
    });

  return (
    <Modal
      open
      width={480}
      title={isNew ? "新增凭据" : `编辑凭据 — ${credential.name}`}
      description={
        isPrivateKey
          ? "私钥与私钥口令是一组配置：口令为空时按未加密私钥处理。"
          : "密码会写入系统凭据管理器，保存后无法在界面上再次查看。"
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={submit.pending} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" disabled={submit.pending} onClick={() => void save()}>
            {submit.pending ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <Field label="名称">
          <input
            className={fieldClass}
            value={form.name}
            placeholder="例如 生产环境 root"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>

        <Field label="用户名">
          <input
            className={fieldClass}
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
          />
        </Field>

        <Field label="类型">
          <select
            className={selectClass}
            value={form.credential_type}
            onChange={(event) => setForm({ ...form, credential_type: event.target.value })}
          >
            {CREDENTIAL_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={isPrivateKey ? "私钥内容" : "密码"}
          hint={
            !isNew && existing?.secret_ref
              ? isPrivateKey
                ? "留空表示保留已保存的私钥"
                : "留空表示保留已保存的密码"
              : undefined
          }
        >
          <textarea
            className="h-28 w-full resize-none rounded-[6px] border border-line bg-surface-1 px-2 py-1.5 font-mono text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              isPrivateKey
                ? "-----BEGIN OPENSSH PRIVATE KEY-----"
                : isNew
                  ? "登录密码（必填）"
                  : "留空保持不变"
            }
          />
        </Field>

        {isPrivateKey && (
          <Field label="私钥口令" hint="私钥本身加密时才需要；留空表示无口令或保持原口令">
            <input
              type="password"
              className={fieldClass}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="可留空"
            />
          </Field>
        )}

        {isNew && (
          <p className="flex items-center gap-1.5 text-11 text-fg-subtle">
            <ShieldCheck size={12} />
            {isPrivateKey ? "创建私钥凭据时必须粘贴私钥内容。" : "创建密码凭据时必须填写密码。"}
          </p>
        )}

        <ErrorText>{submit.error}</ErrorText>
      </div>
    </Modal>
  );
}
