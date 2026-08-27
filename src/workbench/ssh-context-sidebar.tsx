import { useCallback, useEffect, useState } from "react";
import { Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { opsApi, type ServerRecord } from "@/api/ops-api";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";

type ServerStatus = "connected" | "idle" | "reconnect" | "error";

const STATUS_DOT: Record<ServerStatus, string> = {
  connected: "bg-success",
  idle: "bg-fg-subtle",
  reconnect: "bg-warning",
  error: "bg-danger",
};

function statusOf(server: ServerRecord): ServerStatus {
  return server.status === "connected" || server.status === "reconnect" || server.status === "error" ? server.status : "idle";
}

function SectionTitle({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between px-2.5">
      <span className="text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">{children}</span>
      {actions}
    </div>
  );
}

function ServerRow({ server, onOpen, onDelete }: { server: ServerRecord; onOpen: (server: ServerRecord) => void; onDelete: (server: ServerRecord) => void }) {
  const status = statusOf(server);
  return (
    <div className="group flex w-full items-center rounded-[6px] px-2.5 py-1.5 hover:bg-surface-hover">
      <button type="button" className="flex min-w-0 flex-1 flex-col gap-0.5 text-left" onClick={() => onOpen(server)}>
        <div className="flex items-center gap-1.5">
          <span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", STATUS_DOT[status])} />
          <span className="truncate text-12 text-fg">{server.name}</span>
        </div>
        <span className="truncate pl-[13px] text-11 text-fg-subtle">{server.username}@{server.host}:{server.port}</span>
      </button>
      <button type="button" aria-label={`删除 ${server.name}`} className="rounded p-1 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100" onClick={() => onDelete(server)}>
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function emptyServer(): ServerRecord {
  const now = Date.now();
  return { id: crypto.randomUUID(), name: "", host: "", port: 22, username: "root", credential_id: null, group_id: null, tags: [], proxy_jump_id: null, status: "idle", created_at: now, updated_at: now };
}

export function SshContextSidebar() {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [qc, setQc] = useState("");
  const [form, setForm] = useState<ServerRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadServers = useCallback(async () => {
    setLoading(true);
    try {
      setServers(await opsApi.listServers());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadServers(); }, [loadServers]);

  const save = async () => {
    if (!form) return;
    try {
      const saved = await opsApi.saveServer({ ...form, name: form.name.trim(), host: form.host.trim(), username: form.username.trim(), updated_at: Date.now() });
      setServers((current) => [saved, ...current.filter((server) => server.id !== saved.id)]);
      setForm(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = async (server: ServerRecord) => {
    if (!window.confirm(`确定删除服务器“${server.name}”吗？`)) return;
    try {
      await opsApi.deleteServer(server.id);
      setServers((current) => current.filter((item) => item.id !== server.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openServer = (server: ServerRecord) => useWorkbenchStore.getState().openTab({ id: crypto.randomUUID(), type: "terminal", title: server.name, subtitle: `${server.host}:${server.port}`, serverId: server.id, connected: false });
  const visibleServers = qc.trim() ? servers.filter((server) => `${server.name} ${server.host} ${server.username}`.toLowerCase().includes(qc.trim().toLowerCase())) : servers;

  return (
    <div className="flex flex-col gap-1 pb-3">
      <div className="px-2.5 pt-1.5">
        <SectionTitle actions={<Plug size={12} className="text-fg-subtle" />}>快速连接</SectionTitle>
        <div className="mt-1 flex items-center gap-1">
          <input value={qc} onChange={(event) => setQc(event.target.value)} placeholder="搜索服务器" spellCheck={false} className="h-[30px] min-w-0 flex-1 rounded-control border border-line bg-surface-2 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent" />
          <Button variant="ghost" size="sm" className="h-[30px] px-2" aria-label="刷新服务器" onClick={() => void loadServers()}><RefreshCw size={13} /></Button>
        </div>
      </div>

      <div className="mt-2">
        <SectionTitle actions={<Button variant="ghost" size="xs" className="h-5 px-1" aria-label="新增服务器" onClick={() => setForm(emptyServer())}><Plus size={12} /></Button>}>服务器列表</SectionTitle>
        {loading ? <p className="px-2.5 py-2 text-11 text-fg-subtle">正在加载…</p> : visibleServers.length === 0 ? <p className="px-2.5 py-2 text-11 text-fg-subtle">暂无服务器</p> : visibleServers.map((server) => <ServerRow key={server.id} server={server} onOpen={openServer} onDelete={remove} />)}
      </div>

      {error && <p className="mx-2.5 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-11 text-danger">{error}</p>}

      {form && <div className="mx-2.5 mt-2 rounded-[6px] border border-line bg-surface-2 p-2.5">
        <div className="mb-2 text-12 font-semibold text-fg">{servers.some((server) => server.id === form.id) ? "编辑服务器" : "新增服务器"}</div>
        <div className="flex flex-col gap-1.5">
          {(["name", "host", "username"] as const).map((field) => <input key={field} value={form[field]} onChange={(event) => setForm({ ...form, [field]: event.target.value })} placeholder={{ name: "名称", host: "主机地址", username: "用户名" }[field]} className="h-7 rounded border border-line bg-surface-1 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent" />)}
          <input type="number" min={1} max={65535} value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} placeholder="端口" className="h-7 rounded border border-line bg-surface-1 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent" />
          <div className="flex justify-end gap-1.5 pt-1"><Button variant="ghost" size="sm" onClick={() => setForm(null)}>取消</Button><Button variant="primary" size="sm" onClick={() => void save()}>保存</Button></div>
        </div>
      </div>}
    </div>
  );
}
