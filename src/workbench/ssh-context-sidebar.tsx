import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderPlus, Pencil, Plug, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass, selectClass } from "@/components/ui/modal";
import { toErrorMessage, type ServerRecord } from "@/api/ops-api";
import { emptyGroup, emptyServer, useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useSubmit } from "@/hooks/use-submit";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";

const UNGROUPED = "__ungrouped__";

function SectionTitle({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between px-2.5">
      <span className="text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">{children}</span>
      {actions}
    </div>
  );
}

function ServerRow({
  server,
  onOpen,
  onEdit,
  onDelete,
  onToggleFavorite,
}: {
  server: ServerRecord;
  onOpen: (server: ServerRecord) => void;
  onEdit: (server: ServerRecord) => void;
  onDelete: (server: ServerRecord) => void;
  onToggleFavorite: (server: ServerRecord) => void;
}) {
  return (
    <div className="group flex w-full items-center rounded-[6px] px-2.5 py-1.5 hover:bg-surface-hover">
      <button type="button" className="flex min-w-0 flex-1 flex-col gap-0.5 text-left" onClick={() => onOpen(server)}>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-12 text-fg">{server.name}</span>
          {server.proxy_jump_id && (
            <span className="shrink-0 rounded-[4px] border border-line px-1 text-10 text-fg-subtle">跳板</span>
          )}
        </div>
        <span className="truncate text-11 text-fg-subtle">
          {server.username}@{server.host}:{server.port}
        </span>
      </button>
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          aria-label={server.favorite ? `取消收藏 ${server.name}` : `收藏 ${server.name}`}
          className={cn("rounded p-1 hover:text-accent", server.favorite ? "text-accent" : "text-fg-subtle")}
          onClick={() => onToggleFavorite(server)}
        >
          <Star size={12} className={server.favorite ? "fill-current" : ""} />
        </button>
        <button
          type="button"
          aria-label={`编辑 ${server.name}`}
          className="rounded p-1 text-fg-subtle opacity-0 hover:text-fg group-hover:opacity-100"
          onClick={() => onEdit(server)}
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          aria-label={`删除 ${server.name}`}
          className="rounded p-1 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
          onClick={() => onDelete(server)}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

/** SSH module sidebar: server tree with edit, favorite, delete and connect. */
export function SshContextSidebar() {
  const servers = useDomainStore((s) => s.servers);
  const groups = useDomainStore((s) => s.groups);
  const refreshServers = useDomainStore((s) => s.refreshServers);
  const removeServer = useDomainStore((s) => s.deleteServer);
  const setFavorite = useDomainStore((s) => s.setFavorite);

  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<ServerRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await refreshServers();
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [refreshServers]);

  useEffect(() => {
    void load();
  }, [load]);

  const openServer = (server: ServerRecord) =>
    useWorkbenchStore.getState().openTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
      connected: false,
    });

  const confirmDelete = async (server: ServerRecord) => {
    if (!window.confirm(`删除“${server.name}”会同时删除它的会话与命令历史，确定继续？`)) return;
    try {
      await removeServer(server.id);
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return servers;
    return servers.filter((server) =>
      `${server.name} ${server.host} ${server.username} ${server.tags.join(" ")}`.toLowerCase().includes(needle),
    );
  }, [servers, filter]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, ServerRecord[]>();
    for (const server of filtered) {
      const key = server.group_id ?? UNGROUPED;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(server);
      else buckets.set(key, [server]);
    }
    return [...buckets.entries()];
  }, [filtered]);

  return (
    <div className="flex flex-col gap-1 pb-3">
      <div className="px-2.5 pt-1.5">
        <SectionTitle
          actions={
            <Button variant="ghost" size="xs" className="h-5 px-1" aria-label="刷新服务器" onClick={() => void load()}>
              <RefreshCw size={12} />
            </Button>
          }
        >
          筛选
        </SectionTitle>
        <div className="mt-1 flex items-center gap-1">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="搜索名称、主机、用户名、标签"
            spellCheck={false}
            className="h-[30px] min-w-0 flex-1 rounded-control border border-line bg-surface-2 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          />
        </div>
      </div>

      <div className="mt-2">
        <SectionTitle
          actions={
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="xs"
                className="h-5 px-1"
                aria-label="新增服务器"
                onClick={() => setEditing(emptyServer())}
              >
                <Plus size={12} />
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="h-5 px-1"
                aria-label="新增分组"
                onClick={() => void createGroup()}
              >
                <FolderPlus size={12} />
              </Button>
            </div>
          }
        >
          服务器列表
        </SectionTitle>

        {loading ? (
          <p className="px-2.5 py-2 text-11 text-fg-subtle">正在加载…</p>
        ) : filtered.length === 0 ? (
          <p className="px-2.5 py-2 text-11 text-fg-subtle">
            {servers.length === 0 ? "暂无服务器，点击 + 新增" : "没有匹配的服务器"}
          </p>
        ) : (
          grouped.map(([groupId, items]) => {
            const group = groups.find((item) => item.id === groupId);
            const label = group?.name ?? "未分组";
            const folded = collapsed[groupId];
            return (
              <div key={groupId}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1 px-2.5 py-1 text-left text-11 font-medium text-fg-subtle hover:text-fg"
                  onClick={() => setCollapsed((current) => ({ ...current, [groupId]: !folded }))}
                >
                  <span className="w-2">{folded ? "▸" : "▾"}</span>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span>{items.length}</span>
                </button>
                {!folded &&
                  items.map((server) => (
                    <ServerRow
                      key={server.id}
                      server={server}
                      onOpen={openServer}
                      onEdit={setEditing}
                      onDelete={(item) => void confirmDelete(item)}
                      onToggleFavorite={(item) => void setFavorite(item.id, !item.favorite)}
                    />
                  ))}
              </div>
            );
          })
        )}
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {editing && <ServerForm server={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

async function createGroup() {
  const name = window.prompt("分组名称");
  if (!name?.trim()) return;
  await useDomainStore.getState().saveGroup({ ...emptyGroup(), name: name.trim() });
}

function ServerForm({ server, onClose }: { server: ServerRecord; onClose: () => void }) {
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
      onClose();
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
        host: result.host,
        port: result.port,
        hop: result.hop,
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

  return (
    <Modal
      open
      width={480}
      title={isNew ? "新增服务器" : `编辑服务器 — ${server.name || server.host}`}
      description="凭据密钥保存在系统凭据管理器中，数据库只保存引用。"
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

        <Field label="凭据" hint={credentials.length === 0 ? "还没有凭据，请在“设置 → 凭据”中创建" : undefined}>
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
