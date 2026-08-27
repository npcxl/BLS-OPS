import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { opsApi, type CredentialRecord } from "@/api/ops-api";

function emptyCredential(): CredentialRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: "",
    credential_type: "password",
    username: "root",
    secret_ref: null,
    created_at: now,
    updated_at: now,
  };
}

export function SettingsContextSidebar() {
  const [credentials, setCredentials] = useState<CredentialRecord[]>([]);
  const [form, setForm] = useState<CredentialRecord | null>(null);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCredentials(await opsApi.listCredentials());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!form) return;
    try {
      const saved = await opsApi.saveCredential({ ...form, name: form.name.trim(), username: form.username.trim(), updated_at: Date.now() }, secret || undefined);
      setCredentials((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setForm(null);
      setSecret("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = async (credential: CredentialRecord) => {
    if (!window.confirm(`确定删除凭据“${credential.name}”吗？`)) return;
    try {
      await opsApi.deleteCredential(credential.id, credential.secret_ref);
      setCredentials((current) => current.filter((item) => item.id !== credential.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex flex-col gap-1 pb-3">
      <div className="px-2.5 pt-1.5">
        <div className="flex h-7 items-center justify-between">
          <span className="text-11 font-semibold tracking-[0.08em] text-fg-subtle">凭据</span>
          <Button variant="ghost" size="xs" className="h-5 px-1" aria-label="新增凭据" onClick={() => setForm(emptyCredential())}><Plus size={12} /></Button>
        </div>
        <p className="mt-1 text-11 leading-relaxed text-fg-subtle">敏感信息仅保存到系统凭据管理器。</p>
      </div>

      {credentials.length === 0 ? <p className="px-2.5 py-2 text-11 text-fg-subtle">暂无凭据</p> : credentials.map((credential) => <div key={credential.id} className="group flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 hover:bg-surface-hover">
        <KeyRound size={13} className="shrink-0 text-fg-subtle" />
        <div className="min-w-0 flex-1"><div className="truncate text-12 text-fg">{credential.name}</div><div className="truncate text-11 text-fg-subtle">{credential.username} · {credential.credential_type}</div></div>
        <button type="button" aria-label={`删除凭据 ${credential.name}`} className="rounded p-1 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100" onClick={() => void remove(credential)}><Trash2 size={12} /></button>
      </div>)}

      {error && <p className="mx-2.5 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-11 text-danger">{error}</p>}

      {form && <div className="mx-2.5 mt-2 rounded-[6px] border border-line bg-surface-2 p-2.5">
        <div className="mb-2 text-12 font-semibold text-fg">{credentials.some((item) => item.id === form.id) ? "编辑凭据" : "新增凭据"}</div>
        <div className="flex flex-col gap-1.5">
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="凭据名称" className="h-7 rounded border border-line bg-surface-1 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent" />
          <input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="用户名" className="h-7 rounded border border-line bg-surface-1 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent" />
          <select value={form.credential_type} onChange={(event) => setForm({ ...form, credential_type: event.target.value })} className="h-7 rounded border border-line bg-surface-1 px-2 text-12 text-fg outline-none"><option value="password">密码</option><option value="private_key">私钥</option><option value="private_key_passphrase">私钥口令</option></select>
          <textarea value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={form.credential_type === "password" ? "输入密码" : "输入私钥或口令"} rows={3} className="resize-none rounded border border-line bg-surface-1 px-2 py-1.5 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent" />
          <div className="flex justify-end gap-1.5 pt-1"><Button variant="ghost" size="sm" onClick={() => { setForm(null); setSecret(""); }}>取消</Button><Button variant="primary" size="sm" onClick={() => void save()}>保存</Button></div>
        </div>
      </div>}
    </div>
  );
}
