import { useMemo, useState } from "react";
import {
  Clock,
  Copy,
  Pencil,
  Plug,
  Plus,
  Server as ServerIcon,
  Star,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { ErrorText, Field, Modal, fieldClass, selectClass } from "@/components/ui/modal";
import { copyText } from "@/lib/clipboard";
import { type CredentialRecord, type ServerRecord } from "@/api/ops-api";
import { emptyServer, useDomainStore } from "@/stores/domain-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/cn";
import { ServerForm } from "@/workbench/server-list";

/** Workbench Home — spec §28. All data comes from SQLite; nothing is mocked. */

/** macOS-style grouped list — a rounded panel whose rows are divided. */
function ListPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-surface-1/70 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
      <div className="divide-y divide-line/60">{children}</div>
    </div>
  );
}

function Section({
  title,
  count,
  actions,
  children,
}: {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex h-6 items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
          {title}
          {typeof count === "number" && (
            <span className="rounded-[6px] bg-surface-2 px-1.5 py-0.5 text-10 font-medium text-fg-muted">
              {count}
            </span>
          )}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function relativeTime(timestamp?: number | null): string {
  if (!timestamp) return "从未连接";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

export function WorkbenchHome() {
  const [draft, setDraft] = useState<{ username: string; host: string; port: number } | null>(null);
  const [editing, setEditing] = useState<ServerRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServerRecord | null>(null);

  const openTab = useWorkbenchStore((s) => s.openTab);
  const openOrFocusServerTab = useWorkbenchStore((s) => s.openOrFocusServerTab);
  const servers = useDomainStore((s) => s.servers);
  const sessions = useDomainStore((s) => s.sessions);
  const deleteServer = useDomainStore((s) => s.deleteServer);
  const setFavorite = useDomainStore((s) => s.setFavorite);

  const favorites = useMemo(() => servers.filter((server) => server.favorite), [servers]);
  const recent = useMemo(() => {
    const seen = new Set<string>();
    return sessions
      .filter((session) => {
        if (!session.server_id || seen.has(session.server_id)) return false;
        seen.add(session.server_id);
        return true;
      })
      .slice(0, 5);
  }, [sessions]);

  const openServer = (serverId: string, name: string, host: string, port: number) =>
    openOrFocusServerTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: name,
      subtitle: `${host}:${port}`,
      serverId,
      sessionId: crypto.randomUUID(),
    });

  return (
    <div className="h-full overflow-y-auto bg-surface-1" data-selectable>
      <div className="mx-auto flex max-w-[860px] flex-col gap-7 p-7">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] text-fg">工作台</h1>
          <p className="mt-1 text-12 text-fg-muted">本地 SSH 运维控制台</p>
        </div>

        {servers.length === 0 ? (
          <EmptyServers onAdd={() => setEditing(emptyServer())} />
        ) : (
          <>
            <Section
              title="最近会话"
              count={recent.length}
              actions={
                <button
                  type="button"
                  className="text-11 text-fg-subtle transition-colors hover:text-accent"
                  onClick={() => useWorkbenchStore.getState().setModule("ssh")}
                >
                  全部服务器 →
                </button>
              }
            >
              {recent.length === 0 ? (
                <p className="text-12 text-fg-subtle">还没有连接记录。连接一次后会出现在这里。</p>
              ) : (
                <ListPanel>
                  {recent.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className="flex h-11 w-full items-center gap-2.5 px-3 text-left transition-colors hover:bg-surface-hover/60"
                      onClick={() =>
                        openServer(session.server_id, session.server_name, session.server_host, session.server_port)
                      }
                    >
                      <span
                        className={cn(
                          "h-[7px] w-[7px] shrink-0 rounded-full",
                          session.status === "connected" && !session.disconnected_at ? "bg-success" : "bg-fg-subtle",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-13 text-fg">
                        {session.server_name}
                        <span className="ml-2 text-11 text-fg-subtle">
                          {session.username}@{session.server_host}:{session.server_port}
                        </span>
                      </span>
                      {session.error_message && (
                        <span className="shrink-0 truncate text-11 text-danger">{session.error_message}</span>
                      )}
                      <span className="flex shrink-0 items-center gap-1 text-11 text-fg-subtle">
                        <Clock size={12} />
                        {relativeTime(session.connected_at ?? session.disconnected_at)}
                      </span>
                    </button>
                  ))}
                </ListPanel>
              )}
            </Section>

            <Section
              title="收藏"
              count={favorites.length}
              actions={
                <button
                  type="button"
                  className="text-11 text-fg-subtle transition-colors hover:text-accent"
                  onClick={() => useWorkbenchStore.getState().setModule("ssh")}
                >
                  管理 →
                </button>
              }
            >
              {favorites.length === 0 ? (
                <p className="text-12 text-fg-subtle">在服务器列表中点击星标即可收藏。</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {favorites.map((server) => (
                    <button
                      key={server.id}
                      type="button"
                      className="flex h-[32px] items-center gap-1.5 rounded-[9px] border border-line bg-surface-1/70 px-3 text-12 text-fg shadow-[0_1px_2px_rgb(15_23_42/0.05)] transition-colors hover:border-line-strong hover:bg-surface-hover hover:shadow-[0_2px_6px_rgb(15_23_42/0.08)]"
                      onClick={() => openServer(server.id, server.name, server.host, server.port)}
                    >
                      <Star size={12} className="fill-current text-accent" />
                      {server.name}
                    </button>
                  ))}
                </div>
              )}
            </Section>

            <Section
              title="服务器"
              count={servers.length}
              actions={
                <Tooltip label="新增服务器">
                  <Button variant="ghost" size="xs" className="h-6 px-2" onClick={() => setEditing(emptyServer())}>
                    <Plus size={13} />
                    新增
                  </Button>
                </Tooltip>
              }
            >
              <ListPanel>
                {servers.map((server) => (
                  <ServerHomeRow
                    key={server.id}
                    server={server}
                    onOpen={() => openServer(server.id, server.name, server.host, server.port)}
                    onToggleFavorite={() => void setFavorite(server.id, !server.favorite)}
                    onEdit={() => setEditing(server)}
                    onDelete={() => setDeleteTarget(server)}
                  />
                ))}
              </ListPanel>
            </Section>
          </>
        )}
      </div>

      {draft && (
        <QuickConnectDialog
          draft={draft}
          onClose={() => setDraft(null)}
          onConnect={(auth, saveAsServer) => {
            const { username, host, port } = draft;
            const open = (serverId?: string) =>
              openTab({
                id: crypto.randomUUID(),
                type: "terminal",
                title: serverId ? (servers.find((s) => s.id === serverId)?.name ?? host) : host,
                subtitle: `${host}:${port}`,
                serverId,
                quickTarget: serverId ? undefined : `${username}@${host}:${port}`,
                credentialId: auth.credentialId,
                oneTimePassword: auth.password,
                sessionId: crypto.randomUUID(),
              });
            if (saveAsServer) {
              const name = host;
              void useDomainStore
                .getState()
                .saveServer({ ...emptyServer(), name, host, port, username, credential_id: auth.credentialId ?? null })
                .then((saved) => {
                  open(saved.id);
                })
                .catch(() => open());
            } else {
              open();
            }
            setDraft(null);
          }}
        />
      )}

      {editing && <ServerForm server={editing} onClose={() => setEditing(null)} />}
      {deleteTarget && (
        <ConfirmDialog
          open
          title="删除服务器"
          description={`删除“${deleteTarget.name}”会同时删除它的会话与命令历史。此操作不可撤销。`}
          confirmLabel="确认删除"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void deleteServer(deleteTarget.id).then(() => setDeleteTarget(null))}
        />
      )}
    </div>
  );
}

function ServerHomeRow({
  server,
  onOpen,
  onToggleFavorite,
  onEdit,
  onDelete,
}: {
  server: ServerRecord;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // The card only shows two hover icons; the rest of the actions (编辑, 复制
  // 地址) live in the right-click menu, same as in the server list.
  const menu = useContextMenu();
  const items: ContextMenuItem[] = [
    { id: "open", label: "打开终端", icon: Plug, onSelect: onOpen },
    {
      id: "favorite",
      label: server.favorite ? "取消收藏" : "收藏",
      icon: Star,
      onSelect: onToggleFavorite,
    },
    { id: "sep-edit", separator: true },
    { id: "edit", label: "编辑服务器", icon: Pencil, onSelect: onEdit },
    {
      id: "copy-target",
      label: "复制连接地址",
      icon: Copy,
      onSelect: () => void copyText(`${server.username}@${server.host}:${server.port}`),
    },
    { id: "sep-delete", separator: true },
    { id: "delete", label: "删除服务器", icon: Trash2, danger: true, onSelect: onDelete },
  ];

  return (
    <div
      data-testid={`home-server-row${server.id ? `-${server.id}` : ""}`}
      className="group flex h-11 w-full items-center gap-2.5 px-3 transition-colors hover:bg-surface-hover/60"
      onContextMenu={menu.onContextMenu(() => items)}
    >
      <ServerIcon size={14} className="shrink-0 text-fg-subtle" />
      <button type="button" className="min-w-0 flex-1 truncate text-left text-13 text-fg" onClick={onOpen}>
        {server.name}
        <span className="ml-2 text-11 text-fg-subtle">
          {server.username}@{server.host}:{server.port}
        </span>
      </button>
      <span className="shrink-0 text-11 text-fg-subtle">{relativeTime(server.last_connected_at)}</span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Tooltip label={server.favorite ? "取消收藏" : "收藏"} side="left">
          <Button variant="ghost" size="xs" className="h-6 w-6 px-0" aria-label="收藏" onClick={onToggleFavorite}>
            <Star size={13} className={server.favorite ? "fill-current text-accent" : ""} />
          </Button>
        </Tooltip>
        <Tooltip label="删除" side="left">
          <Button variant="ghost" size="xs" className="h-6 w-6 px-0 hover:text-danger" aria-label="删除" onClick={onDelete}>
            <Trash2 size={13} />
          </Button>
        </Tooltip>
      </div>

      <ContextMenu {...menu.props} title={server.name} />
    </div>
  );
}

function EmptyServers({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed border-line bg-surface-1/50 px-6 py-14 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-fg-subtle">
        <ServerIcon size={22} />
      </span>
      <div>
        <p className="text-14 font-medium text-fg">还没有服务器</p>
        <p className="mt-1 text-12 text-fg-subtle">新增一台服务器即可开始连接与管理。</p>
      </div>
      <Button variant="primary" size="sm" onClick={onAdd}>
        <Plus size={13} />
        新增服务器
      </Button>
    </div>
  );
}

/** How the quick-connect attempt authenticates. */
export type QuickConnectAuth = {
  credentialId?: string;
  /** Typed for this connection only; never stored. */
  password?: string;
};

function QuickConnectDialog({
  draft,
  onClose,
  onConnect,
}: {
  draft: { username: string; host: string; port: number };
  onClose: () => void;
  onConnect: (auth: QuickConnectAuth, saveAsServer: boolean) => void;
}) {
  const credentials = useDomainStore((s) => s.credentials);
  const [credentialId, setCredentialId] = useState<string>(credentials[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [saveAsServer, setSaveAsServer] = useState(true);
  const submit = useSubmit();

  const usingOneTimePassword = credentialId === "";

  const connect = () =>
    submit.run(async () => {
      if (usingOneTimePassword) {
        if (!password) throw new Error("请输入密码");
        onConnect({ password }, saveAsServer);
        return;
      }
      onConnect({ credentialId }, saveAsServer);
    });

  return (
    <Modal
      open
      width={420}
      title="连接到主机"
      description={`${draft.username}@${draft.host}:${draft.port}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" disabled={submit.pending} onClick={() => void connect()}>
            {submit.pending ? "连接中…" : "连接"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {credentials.length > 0 && (
          <Field label="已保存凭据" hint="选择“一次性密码”可不依赖任何已保存凭据">
            <select className={selectClass} value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
              <option value="">使用一次性密码（不保存）</option>
              {credentials.map((credential: CredentialRecord) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name} · {credential.username} ·{" "}
                  {credential.credential_type === "private_key" ? "私钥" : "密码"}
                </option>
              ))}
            </select>
          </Field>
        )}

        {usingOneTimePassword && (
          <Field
            label="一次性密码"
            hint={
              credentials.length === 0
                ? "还没有凭据，可先直接用密码连接。密钥不会保存。"
                : "仅用于本次连接，不会写入系统凭据管理器。"
            }
          >
            <input
              type="password"
              autoFocus
              className={fieldClass}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void connect();
              }}
              placeholder="登录密码"
            />
          </Field>
        )}

        <label className="flex items-center gap-2 text-12 text-fg-muted">
          <input type="checkbox" checked={saveAsServer} onChange={(event) => setSaveAsServer(event.target.checked)} />
          保存为服务器（下次可从列表直接连接）
        </label>
        {usingOneTimePassword && saveAsServer && (
          <p className="-mt-1.5 pl-[22px] text-11 leading-relaxed text-fg-subtle">
            服务器条目会被保存，但不含凭据——下次连接仍需选择凭据或再次输入密码。
          </p>
        )}

        <ErrorText>{submit.error}</ErrorText>
      </div>
    </Modal>
  );
}

// ServerForm 复用 ssh-context-sidebar 的导出，避免重复实现。
