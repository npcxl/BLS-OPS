import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Check, ChevronsLeft, Container, FolderPlus, Globe, Pencil, Plug, Plus, RefreshCw, ScrollText, SquareCheckBig, Star, Trash2, X } from "lucide-react";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorText, Field, Modal, fieldClass, selectClass } from "@/components/ui/modal";
import { toErrorMessage, type ServerGroupRecord, type ServerRecord } from "@/api/ops-api";
import { emptyGroup, emptyServer, useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useSubmit } from "@/hooks/use-submit";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { MacButton } from "@/components/ui/mac-button";

const UNGROUPED = "__ungrouped__";

/** The session-driven management modules reachable from a server. */
export type ManageKind = "service" | "logs" | "docker" | "nginx";

const MANAGE_LABELS: Record<ManageKind, string> = {
  service: "服务",
  logs: "日志",
  docker: "容器",
  nginx: "网关",
};

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
  onMonitor,
  onManage,
  onEdit,
  onDelete,
  onToggleFavorite,
}: {
  server: ServerRecord;
  onOpen: (server: ServerRecord) => void;
  /** Opens read-only monitoring for this server. */
  onMonitor: (server: ServerRecord) => void;
  /** Opens one of the P3 session-driven management modules. */
  onManage: (server: ServerRecord, kind: ManageKind) => void;
  onEdit: (server: ServerRecord) => void;
  onDelete: (server: ServerRecord) => void;
  onToggleFavorite: (server: ServerRecord) => void;
}) {
  const menu = useContextMenu();

  return (
    <>
      <div
        className="flex w-full items-center rounded-[6px] px-2.5 py-1.5 hover:bg-surface-hover"
        onContextMenu={menu.onContextMenu(() => [
          { id: "connect", label: "打开终端", icon: Plug, onSelect: () => onOpen(server) },
          { id: "monitor", label: "打开监控", icon: Activity, onSelect: () => onMonitor(server) },
          { id: "sep-manage", separator: true },
          { id: "services", label: "服务管家", icon: SquareCheckBig, onSelect: () => onManage(server, "service") },
          { id: "logs", label: "日志中心", icon: ScrollText, onSelect: () => onManage(server, "logs") },
          { id: "docker", label: "Docker 管家", icon: Container, onSelect: () => onManage(server, "docker") },
          { id: "nginx", label: "Nginx 管家", icon: Globe, onSelect: () => onManage(server, "nginx") },
          { id: "favorite", label: server.favorite ? "取消收藏" : "收藏", icon: Star, onSelect: () => onToggleFavorite(server) },
          { id: "edit", label: "编辑服务器", icon: Pencil, onSelect: () => onEdit(server) },
          { id: "sep", separator: true },
          { id: "delete", label: "删除服务器", icon: Trash2, danger: true, onSelect: () => onDelete(server) },
        ])}
      >
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
      </div>
      <ContextMenu {...menu.props} title={server.name} />
    </>
  );
}

/** Collapsible group header with inline rename and delete. */
function GroupHeader({
  label,
  count,
  group,
  folded,
  renaming,
  onToggle,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
}: {
  label: string;
  count: number;
  group?: ServerGroupRecord;
  folded: boolean;
  renaming: boolean;
  onToggle: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(label);

  if (renaming) {
    const commit = () => {
      const next = value.trim();
      if (next && next !== label) onRename(next);
      else onCancelRename();
    };
    return (
      <div className="flex items-center gap-1 px-2.5 py-1">
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") onCancelRename();
          }}
          onBlur={commit}
          className="h-[22px] min-w-0 flex-1 rounded-[5px] border border-accent bg-surface-2 px-1.5 text-11 text-fg outline-none"
        />
      </div>
    );
  }

  return (
    <div className="group/g flex w-full items-center px-2.5 py-1 text-11 font-medium text-fg-subtle hover:text-fg">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={onToggle}>
        <span className="w-2 shrink-0">{folded ? "▸" : "▾"}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0">{count}</span>
      </button>
      {group && (
        <span className="flex shrink-0 items-center opacity-0 group-hover/g:opacity-100">
          <button
            type="button"
            aria-label={`重命名分组 ${label}`}
            className="rounded p-1 hover:text-fg"
            onClick={onStartRename}
          >
            <Pencil size={11} />
          </button>
          <button
            type="button"
            aria-label={`删除分组 ${label}`}
            className="rounded p-1 hover:text-danger"
            onClick={onDelete}
          >
            <Trash2 size={11} />
          </button>
        </span>
      )}
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
  const saveGroup = useDomainStore((s) => s.saveGroup);
  const setSidebarCollapsed = useWorkbenchStore((s) => s.setSidebarCollapsed);
  const removeGroup = useDomainStore((s) => s.deleteGroup);
  const [editing, setEditing] = useState<ServerRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServerRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const newGroupRef = useRef<HTMLInputElement>(null);

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

  // Reuses an existing terminal tab for this server when one exists, so the
  // SSH session (and the file panel's state) survives switching around.
  const openServer = (server: ServerRecord) =>
    useWorkbenchStore.getState().openOrFocusServerTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  // Monitoring deliberately gets its own tab and its own session: it runs
  // read-only exec channels and must not disturb an open shell.
  const openMonitor = (server: ServerRecord) =>
    useWorkbenchStore.getState().openTab({
      id: crypto.randomUUID(),
      type: "monitor",
      title: `${server.name} · 监控`,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  /**
   * The P3 modules each get their own tab and their own session: they run
   * read-only (or validated) exec channels and must not disturb an open shell.
   */
  const openManage = (server: ServerRecord, kind: ManageKind) =>
    useWorkbenchStore.getState().openTab({
      id: crypto.randomUUID(),
      type: kind,
      title: `${server.name} · ${MANAGE_LABELS[kind]}`,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await removeServer(deleteTarget.id);
      setDeleteTarget(null);
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  const grouped = useMemo(() => {
    const buckets = new Map<string, ServerRecord[]>();
    for (const server of servers) {
      const key = server.group_id ?? UNGROUPED;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(server);
      else buckets.set(key, [server]);
    }
    return [...buckets.entries()];
  }, [servers]);

  const renameGroup = async (group: ServerGroupRecord, name: string) => {
    setRenamingGroupId(null);
    try {
      await saveGroup({ ...group, name, updated_at: Date.now() });
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  const confirmDeleteGroup = async (group: ServerGroupRecord, used: number) => {
    const message =
      used > 0
        ? `分组“${group.name}”中有 ${used} 台服务器。\n删除分组后这些服务器会变为“未分组”，服务器本身不会被删除。\n\n确定删除分组吗？`
        : `确定删除分组“${group.name}”吗？`;
    if (!window.confirm(message)) return;
    try {
      await removeGroup(group.id);
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name) {
      setCreatingGroup(false);
      return;
    }
    try {
      await saveGroup({ ...emptyGroup(), name });
      setNewGroupName("");
      setCreatingGroup(false);
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  return (
    <div className="flex flex-col gap-1 pb-3">
      <div className="mt-1">
        <SectionTitle
          actions={
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="xs"
                className="h-5 w-5 px-0"
                aria-label="刷新服务器"
                title="刷新服务器"
                onClick={() => void load()}
              >
                <RefreshCw size={12} />
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="h-5 w-5 px-0"
                aria-label="收起侧边栏"
                title="收起侧边栏"
                onClick={() => setSidebarCollapsed(true)}
              >
                <ChevronsLeft size={12} />
              </Button>
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
                onClick={() => {
                  setCreatingGroup(true);
                  requestAnimationFrame(() => newGroupRef.current?.focus());
                }}
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
        ) : servers.length === 0 ? (
          <p className="px-2.5 py-2 text-11 text-fg-subtle">暂无服务器，点击 + 新增</p>
        ) : (
          grouped.map(([groupId, items]) => {
            const group = groups.find((item) => item.id === groupId);
            return (
              <div key={groupId}>
                <GroupHeader
                  label={group?.name ?? "未分组"}
                  count={items.length}
                  group={group}
                  folded={Boolean(collapsed[groupId])}
                  renaming={renamingGroupId === groupId}
                  onToggle={() => setCollapsed((current) => ({ ...current, [groupId]: !current[groupId] }))}
                  onStartRename={() => setRenamingGroupId(groupId)}
                  onRename={(name) => {
                    if (group) void renameGroup(group, name);
                    else setRenamingGroupId(null);
                  }}
                  onCancelRename={() => setRenamingGroupId(null)}
                  onDelete={() => {
                    if (group) void confirmDeleteGroup(group, items.length);
                  }}
                />
                {!collapsed[groupId] &&
                  items.map((server) => (
                    <ServerRow
                      key={server.id}
                      server={server}
                      onOpen={openServer}
                      onMonitor={openMonitor}
                      onManage={openManage}
                      onEdit={setEditing}
                      onDelete={setDeleteTarget}
                      onToggleFavorite={(item) => void setFavorite(item.id, !item.favorite)}
                    />
                  ))}
              </div>
            );
          })
        )}
      </div>

      {creatingGroup && (
        <div className="flex items-center gap-1 px-2.5 py-1">
          <input
            ref={newGroupRef}
            autoFocus
            value={newGroupName}
            onChange={(event) => setNewGroupName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createGroup();
              if (event.key === "Escape") {
                setNewGroupName("");
                setCreatingGroup(false);
              }
            }}
            placeholder="分组名称，回车保存"
            spellCheck={false}
            className="h-[24px] min-w-0 flex-1 rounded-[5px] border border-accent bg-surface-2 px-1.5 text-11 text-fg outline-none placeholder:text-fg-subtle"
          />
          <button
            type="button"
            aria-label="保存分组"
            className="rounded p-1 text-fg-subtle hover:text-success"
            onClick={() => void createGroup()}
          >
            <Check size={12} />
          </button>
          <button
            type="button"
            aria-label="取消"
            className="rounded p-1 text-fg-subtle hover:text-fg"
            onClick={() => {
              setNewGroupName("");
              setCreatingGroup(false);
            }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {editing && <ServerForm server={editing} onClose={() => setEditing(null)} />}
      {deleteTarget && (
        <ConfirmDialog
          open
          title="删除服务器"
          description={`删除“${deleteTarget.name}”会同时删除它的会话与命令历史。此操作不可撤销。`}
          confirmLabel="确认删除"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
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
          <MacButton  disabled={submit.pending} onClick={() => void save()}>
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
