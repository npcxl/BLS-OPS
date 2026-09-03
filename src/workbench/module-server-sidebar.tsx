import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronsLeft, FolderPlus, Plus, RefreshCw } from "lucide-react";
import type { NavModule } from "@/workbench/types";
import { useDomainStore } from "@/stores/domain-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { IconButton } from "@/components/ui/mac-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toErrorMessage, type ServerGroupRecord } from "@/api/ops-api";
import { emptyGroup, emptyServer } from "@/stores/domain-store";
import {
  GroupHeader,
  SectionTitle,
  ServerRow,
} from "./ssh-context-sidebar";

const UNGROUPED = "__ungrouped__";

/** Modules that, when opened from the rail, show a left server list instead of
 *  a placeholder — picking a server opens that module bound to that server. */
export const SERVER_LIST_MODULES: NavModule[] = ["services", "logs", "projects", "commands"];

const MODULE_TITLE: Record<NavModule, string> = {
  ssh: "服务器列表",
  servers: "服务器",
  services: "服务",
  logs: "日志",
  projects: "项目",
  commands: "命令",
  deploy: "部署",
  tasks: "任务",
  ai: "智能助手",
  settings: "设置",
};

export function isServerListModule(module: NavModule): boolean {
  return SERVER_LIST_MODULES.includes(module);
}

/**
 * Left server-list sidebar shared by the session-driven modules (项目 / 服务 / 日志).
 *
 * It reuses the exact same `SectionTitle` / `ServerRow` / `GroupHeader` rendering
 * as the terminal's `SshContextSidebar` so the rail looks identical across modules —
 * only the title (项目 / 服务 / 日志) and the row's primary click differ: here a
 * click opens that module bound to the server instead of a terminal.
 */
export function ModuleServerSidebar({ module }: { module: NavModule }) {
  const servers = useDomainStore((s) => s.servers);
  const groups = useDomainStore((s) => s.groups);
  const refreshServers = useDomainStore((s) => s.refreshServers);
  const removeServer = useDomainStore((s) => s.deleteServer);
  const setFavorite = useDomainStore((s) => s.setFavorite);
  const saveGroup = useDomainStore((s) => s.saveGroup);
  const removeGroup = useDomainStore((s) => s.deleteGroup);
  const openModuleTabForServer = useWorkbenchStore((s) => s.openModuleTabForServer);
  const setSidebarCollapsed = useWorkbenchStore((s) => s.setSidebarCollapsed);

  const [editing, setEditing] = useState<ReturnType<typeof emptyServer> | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ReturnType<typeof emptyServer> | null>(null);
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

  const openServerModule = (server: ReturnType<typeof emptyServer>) =>
    openModuleTabForServer(module, server.id);

  const openMonitor = (server: ReturnType<typeof emptyServer>) =>
    useWorkbenchStore.getState().openTab({
      id: crypto.randomUUID(),
      type: "monitor",
      title: `${server.name} · 监控`,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  const openManage = (server: ReturnType<typeof emptyServer>, kind: "service" | "logs") =>
    useWorkbenchStore.getState().openTab({
      id: crypto.randomUUID(),
      type: kind,
      title: `${server.name} · ${kind === "service" ? "服务" : "日志"}`,
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
    const buckets = new Map<string, ReturnType<typeof emptyServer>[]>();
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
              <IconButton icon={RefreshCw} size="xs" className="h-5 w-5 px-0" tip="刷新服务器" onClick={() => void load()} />
              <IconButton
                icon={ChevronsLeft}
                size="xs"
                className="h-5 w-5 px-0"
                tip="收起侧边栏"
                onClick={() => setSidebarCollapsed(true)}
              />
              <IconButton icon={Plus} size="xs" className="h-5 px-1" tip="新增服务器" onClick={() => setEditing(emptyServer())} />
              <IconButton
                icon={FolderPlus}
                size="xs"
                className="h-5 px-1"
                tip="新增分组"
                onClick={() => {
                  setCreatingGroup(true);
                  requestAnimationFrame(() => newGroupRef.current?.focus());
                }}
              />
            </div>
          }
        >
          {MODULE_TITLE[module] ?? module}
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
                      onOpen={openServerModule}
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
        </div>
      )}

      {error && <p className="px-2.5 py-1 text-11 text-danger">{error}</p>}

      {editing && (
        <ServerFormInline server={editing} onClose={() => setEditing(null)} />
      )}
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

/** Minimal inline server form reused by the module sidebar (same shape as the
 *  terminal's `ServerForm`, kept local to avoid dragging the modal stack here). */
function ServerFormInline({ server, onClose }: { server: ReturnType<typeof emptyServer>; onClose: () => void }) {
  const saveServer = useDomainStore((s) => s.saveServer);
  const groups = useDomainStore((s) => s.groups);
  const [form, setForm] = useState(server);

  return (
    <div className="mx-2.5 mt-2 rounded-[10px] border border-line bg-surface-1/70 p-3 shadow-[inset_0_1px_0_rgb(255_255_255/0.4)]">
      <div className="flex flex-col gap-2.5">
        <input
          className="h-[28px] rounded-[6px] border border-line bg-surface-2 px-2 text-12 text-fg outline-none focus:border-accent"
          value={form.name}
          placeholder="名称"
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
        <div className="grid grid-cols-[1fr_72px] gap-2">
          <input
            className="h-[28px] rounded-[6px] border border-line bg-surface-2 px-2 text-12 text-fg outline-none focus:border-accent"
            value={form.host}
            placeholder="主机"
            onChange={(event) => setForm({ ...form, host: event.target.value })}
          />
          <input
            type="number"
            className="h-[28px] rounded-[6px] border border-line bg-surface-2 px-2 text-12 text-fg outline-none focus:border-accent"
            value={form.port}
            onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
          />
        </div>
        <input
          className="h-[28px] rounded-[6px] border border-line bg-surface-2 px-2 text-12 text-fg outline-none focus:border-accent"
          value={form.username}
          placeholder="用户名"
          onChange={(event) => setForm({ ...form, username: event.target.value })}
        />
        <select
          className="h-[28px] rounded-[6px] border border-line bg-surface-2 px-2 text-12 text-fg outline-none focus:border-accent"
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
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            className="rounded-[6px] px-2.5 py-1 text-12 text-fg-subtle hover:bg-surface-hover"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-[6px] bg-accent px-2.5 py-1 text-12 font-medium text-white hover:opacity-90"
            onClick={async () => {
              try {
                await saveServer(form);
                onClose();
              } catch {
                /* surfaced via list reload */
              }
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
