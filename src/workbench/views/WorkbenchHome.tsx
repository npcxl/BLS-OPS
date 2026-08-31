import { useMemo, useState } from "react";
import { ArrowRight, Clock, FolderOpen, Plug, Server, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, selectClass } from "@/components/ui/modal";
import { parseSshTarget, type CredentialRecord } from "@/api/ops-api";
import { emptyServer, useDomainStore } from "@/stores/domain-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/cn";

/** Workbench Home — spec §28. All data comes from SQLite; nothing is mocked. */

/** macOS-style grouped list — a rounded panel whose rows are divided. */
function ListPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-surface-1/70 shadow-[inset_0_1px_0_rgb(255_255_255/0.4)]">
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
    <section className="flex flex-col gap-2">
      <div className="flex h-6 items-center justify-between">
        <h2 className="text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
          {title}
          {typeof count === "number" && (
            <span className="ml-1.5 rounded-[6px] bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted">
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
  if (!timestamp) return "未知时间";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

export function WorkbenchHome() {
  const [qc, setQc] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ username: string; host: string; port: number } | null>(null);

  const openTab = useWorkbenchStore((s) => s.openTab);
  const setModule = useWorkbenchStore((s) => s.setModule);
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
      .slice(0, 8);
  }, [sessions]);

  const openServer = (serverId: string, name: string, host: string, port: number) =>
    openTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: name,
      subtitle: `${host}:${port}`,
      serverId,
      sessionId: crypto.randomUUID(),
    });

  const startQuickConnect = () => {
    const parsed = parseSshTarget(qc);
    if (!parsed) {
      setParseError("格式应为 user@host[:port]，例如 root@10.0.0.11:22");
      return;
    }
    setParseError(null);
    setDraft(parsed);
  };

  return (
    <div className="h-full overflow-y-auto bg-app" data-selectable>
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 p-6">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-fg">工作台</h1>
          <p className="mt-1 text-12 text-fg-muted">本地 SSH 运维控制台 — 服务器、终端、凭据。</p>
        </div>

        <Section title="快速连接">
          <div className="flex items-center gap-1.5">
            <div className="relative flex min-w-0 flex-1 items-center">
              <Plug size={13} className="absolute left-2.5 text-fg-subtle" />
              <input
                value={qc}
                onChange={(event) => {
                  setQc(event.target.value);
                  setParseError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") startQuickConnect();
                }}
                placeholder="user@host:22 — 快速连接"
                spellCheck={false}
                className="h-[34px] w-full rounded-[8px] border border-line bg-surface-1/70 pl-8 pr-2 text-13 text-fg outline-none placeholder:text-fg-subtle shadow-[inset_0_1px_0_rgb(255_255_255/0.45)] focus:border-accent"
              />
            </div>
            <Button variant="primary" size="lg" disabled={!qc.trim()} onClick={startQuickConnect}>
              <ArrowRight size={14} />
              连接
            </Button>
          </div>
          {parseError && <ErrorText>{parseError}</ErrorText>}
        </Section>

        <Section
          title="最近会话"
          count={recent.length}
          actions={
            servers.length === 0 ? (
              <Button variant="ghost" size="xs" onClick={() => setModule("ssh")}>
                去新增服务器
              </Button>
            ) : undefined
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
                  className="flex h-10 w-full items-center gap-2.5 px-2.5 text-left transition-colors hover:bg-surface-hover/60"
                  onClick={() =>
                    openServer(
                      session.server_id,
                      session.server_name,
                      session.server_host,
                      session.server_port,
                    )
                  }
                >
                  <span
                    className={cn(
                      "h-[7px] w-[7px] shrink-0 rounded-full",
                      session.status === "connected" && !session.disconnected_at
                        ? "bg-success"
                        : "bg-fg-subtle",
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

        <Section title="收藏" count={favorites.length}>
          {favorites.length === 0 ? (
            <p className="text-12 text-fg-subtle">还没有收藏。在服务器列表中点击星标即可收藏。</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {favorites.map((server) => (
                <button
                  key={server.id}
                  type="button"
                  className="flex h-[30px] items-center gap-1.5 rounded-[9px] border border-line bg-surface-1/70 px-2.5 text-12 text-fg shadow-[0_1px_2px_rgb(15_23_42/0.05)] transition-colors hover:border-line-strong hover:bg-surface-hover hover:shadow-[0_2px_6px_rgb(15_23_42/0.08)]"
                  onClick={() => openServer(server.id, server.name, server.host, server.port)}
                >
                  <Star size={12} className="fill-current text-accent" />
                  {server.name}
                  <span className="text-11 text-fg-subtle">
                    {server.username}@{server.host}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="服务器"
          count={servers.length}
          actions={
            <Button variant="ghost" size="xs" onClick={() => setModule("ssh")}>
              管理
            </Button>
          }
        >
          {servers.length === 0 ? (
            <p className="text-12 text-fg-subtle">还没有服务器。请在左侧“终端 → 服务器列表”中新增。</p>
          ) : (
            <ListPanel>
              {servers.slice(0, 8).map((server) => (
                <div
                  key={server.id}
                  className="group flex h-10 w-full items-center gap-2.5 px-2.5 transition-colors hover:bg-surface-hover/60"
                >
                  <Server size={13} className="shrink-0 text-fg-subtle" />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-13 text-fg"
                    onClick={() => openServer(server.id, server.name, server.host, server.port)}
                  >
                    {server.name}
                    <span className="ml-2 text-11 text-fg-subtle">
                      {server.username}@{server.host}:{server.port}
                    </span>
                  </button>
                  <span className="shrink-0 text-11 text-fg-subtle">
                    {server.last_connected_at ? relativeTime(server.last_connected_at) : "从未连接"}
                  </span>
                  <button
                    type="button"
                    aria-label={server.favorite ? `取消收藏 ${server.name}` : `收藏 ${server.name}`}
                    className="shrink-0 rounded p-1 text-fg-subtle hover:text-accent"
                    onClick={() => void setFavorite(server.id, !server.favorite)}
                  >
                    <Star size={13} className={server.favorite ? "fill-current text-accent" : ""} />
                  </button>
                  <button
                    type="button"
                    aria-label={`删除 ${server.name}`}
                    className="shrink-0 rounded p-1 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
                    onClick={() => {
                      if (window.confirm(`删除服务器“${server.name}”会同时删除它的会话与命令历史，确定继续？`)) {
                        void deleteServer(server.id);
                      }
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </ListPanel>
          )}
        </Section>

        <div className="flex items-center gap-2 text-11 text-fg-subtle">
          <FolderOpen size={12} />
          数据来自本地 SQLite，凭据密钥仅保存在系统凭据管理器中。
        </div>
      </div>

      {draft && (
        <QuickConnectDialog
          draft={draft}
          onClose={() => setDraft(null)}
          onConnect={(credentialId, saveAsServer) => {
            const { username, host, port } = draft;
            const open = (serverId?: string) =>
              openTab({
                id: crypto.randomUUID(),
                type: "terminal",
                title: serverId ? (servers.find((s) => s.id === serverId)?.name ?? host) : host,
                subtitle: `${host}:${port}`,
                serverId,
                quickTarget: serverId ? undefined : `${username}@${host}:${port}`,
                credentialId,
                sessionId: crypto.randomUUID(),
              });
            if (saveAsServer) {
              const name = host;
              void useDomainStore
                .getState()
                .saveServer({
                  ...emptyServer(),
                  name,
                  host,
                  port,
                  username,
                  credential_id: credentialId,
                })
                .then((saved) => {
                  setQc("");
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
    </div>
  );
}

function QuickConnectDialog({
  draft,
  onClose,
  onConnect,
}: {
  draft: { username: string; host: string; port: number };
  onClose: () => void;
  onConnect: (credentialId: string, saveAsServer: boolean) => void;
}) {
  const credentials = useDomainStore((s) => s.credentials);
  const [credentialId, setCredentialId] = useState<string>(credentials[0]?.id ?? "");
  const [saveAsServer, setSaveAsServer] = useState(true);
  const submit = useSubmit();

  const connect = () =>
    submit.run(async () => {
      if (!credentialId) throw new Error("请先选择凭据");
      onConnect(credentialId, saveAsServer);
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
        {credentials.length === 0 ? (
          <ErrorText>还没有任何凭据，请先到“设置 → 凭据”中创建一个。</ErrorText>
        ) : (
          <Field label="凭据">
            <select
              className={selectClass}
              value={credentialId}
              onChange={(event) => setCredentialId(event.target.value)}
            >
              <option value="">请选择凭据</option>
              {credentials.map((credential: CredentialRecord) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name} · {credential.username} ·{" "}
                  {credential.credential_type === "private_key" ? "私钥" : "密码"}
                </option>
              ))}
            </select>
          </Field>
        )}

        <label className="flex items-center gap-2 text-12 text-fg-muted">
          <input
            type="checkbox"
            checked={saveAsServer}
            onChange={(event) => setSaveAsServer(event.target.checked)}
          />
          保存为服务器（下次可从列表直接连接）
        </label>

        <ErrorText>{submit.error}</ErrorText>
      </div>
    </Modal>
  );
}
