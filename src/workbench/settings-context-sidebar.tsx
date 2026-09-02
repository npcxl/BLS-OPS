import { useCallback, useEffect, useState } from "react";
import { ChevronRight, KeyRound, Monitor, Moon, Plus, ShieldCheck, Sun, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ErrorText, Field, Modal, fieldClass, selectClass } from "@/components/ui/modal";
import {
  CREDENTIAL_TYPES,
  opsApi,
  toErrorMessage,
  type AuditLogRecord,
  type CommandHistoryRecord,
  type CredentialRecord,
} from "@/api/ops-api";
import { emptyCredential, useDomainStore } from "@/stores/domain-store";
import { useSubmit } from "@/hooks/use-submit";
import { useThemeMode, type ThemeMode } from "@/hooks/use-theme";
import { KnownHostsPanel } from "./host-key-dialog";
import { cn } from "@/lib/cn";

const THEME_OPTIONS: { id: ThemeMode; label: string; short: string; icon: React.ElementType }[] = [
  { id: "system", label: "跟随系统", short: "系统", icon: Monitor },
  { id: "light", label: "浅色", short: "浅色", icon: Sun },
  { id: "dark", label: "深色", short: "深色", icon: Moon },
];

function Group({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex h-6 items-center justify-between px-0.5">
        <span className="text-11 font-semibold uppercase tracking-[0.08em] text-fg-subtle">{title}</span>
        {action}
      </div>
      {hint && <p className="px-0.5 text-11 leading-relaxed text-fg-subtle">{hint}</p>}
      {children}
    </section>
  );
}

/** macOS-style grouped inset list — a rounded panel whose rows are divided. */
function ListGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-surface-1/70 shadow-[inset_0_1px_0_rgb(255_255_255/0.4)]">
      <div className="divide-y divide-line/60">{children}</div>
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-11 text-fg-subtle">{children}</p>;
}

function CollapsibleList<T>({
  title,
  load,
  empty,
  getKey,
  children,
}: {
  title: string;
  load: () => Promise<T[]>;
  empty: string;
  getKey: (row: T) => string;
  children: (row: T) => React.ReactNode;
}) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void load().then(
      (result) => active && setRows(result),
      () => active && setRows([]),
    );
    return () => {
      active = false;
    };
  }, [load, open]);

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-surface-1/70">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-surface-hover/60"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex items-center gap-1.5 text-12 text-fg">
          <ChevronRight size={13} className={cn("transition-transform", open && "rotate-90")} />
          {title}
        </span>
        {rows && rows.length > 0 && (
          <span className="rounded-[6px] bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted">{rows.length}</span>
        )}
      </button>
      {open && (
        <div className="divide-y divide-line/60 border-t border-line">
          {rows === null ? (
            <EmptyRow>正在加载…</EmptyRow>
          ) : rows.length === 0 ? (
            <EmptyRow>{empty}</EmptyRow>
          ) : (
            rows.map((row) => <div key={getKey(row)}>{children(row)}</div>)
          )}
        </div>
      )}
    </div>
  );
}

const loadHistory = () => opsApi.listHistory(200);
const loadAuditLogs = () => opsApi.listAuditLogs(200);

/** Settings module sidebar: credentials, known hosts and runtime diagnostics. */
export function SettingsContextSidebar() {
  const credentials = useDomainStore((s) => s.credentials);
  const refreshCredentials = useDomainStore((s) => s.refreshCredentials);
  const appInfo = useDomainStore((s) => s.appInfo);

  const [themeMode, setThemeMode] = useThemeMode();
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
    <div className="flex flex-col gap-5 p-3 pb-6">
      <Group title="外观">
        <ListGroup>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="shrink-0 text-12 text-fg">主题</span>
            <div className="flex flex-1 justify-end rounded-[8px] border border-line bg-surface-2 p-0.5">
              {THEME_OPTIONS.map((option) => {
                const Icon = option.icon;
                const active = themeMode === option.id;
                return (
                  <Tooltip key={option.id} label={option.label}>
                    <button
                      type="button"
                      aria-label={option.label}
                      className={cn(
                        "flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded-[6px] text-11 transition-colors",
                        active ? "bg-surface-active text-fg shadow-sm" : "text-fg-muted hover:text-fg",
                      )}
                      onClick={() => setThemeMode(option.id)}
                    >
                      <Icon size={13} strokeWidth={1.75} className="shrink-0" />
                      <span className="truncate">{option.short}</span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        </ListGroup>
      </Group>

      <Group
        title="凭据"
        hint="密钥只写入系统凭据管理器，数据库仅保存引用，保存后无法在界面再次查看。"
        action={
          <Tooltip label="新增凭据">
            <Button
              variant="ghost"
              size="xs"
              className="h-6 px-1.5"
              aria-label="新增凭据"
              onClick={() => setEditing(emptyCredential())}
            >
              <Plus size={13} />
            </Button>
          </Tooltip>
        }
      >
        <ListGroup>
          {credentials.length === 0 ? (
            <EmptyRow>暂无凭据</EmptyRow>
          ) : (
            credentials.map((credential) => (
              <div
                key={credential.id}
                className="group flex w-full items-center gap-2 px-3 py-2 transition-colors hover:bg-surface-hover/60"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  onClick={() => setEditing(credential)}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-fg-subtle">
                    <KeyRound size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-12 text-fg">{credential.name}</span>
                    <span className="block truncate text-11 text-fg-subtle">
                      {credential.username} · {credential.credential_type === "private_key" ? "私钥" : "密码"} ·{" "}
                      {credential.secret_ref ? "密钥已保存" : "缺少密钥"}
                    </span>
                  </span>
                  <ChevronRight size={13} className="shrink-0 text-fg-subtle" />
                </button>
                <Tooltip label={`删除凭据 ${credential.name}`} side="left">
                  <button
                    type="button"
                    aria-label={`删除凭据 ${credential.name}`}
                    className="shrink-0 rounded p-1 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
                    onClick={() => void remove(credential)}
                  >
                    <Trash2 size={12} />
                  </button>
                </Tooltip>
              </div>
            ))
          )}
        </ListGroup>
      </Group>

      <Group title="已知主机" hint="首次连接时确认过的服务器指纹会记录在这里。">
        <ListGroup>
          <KnownHostsPanel />
        </ListGroup>
      </Group>

      <Group title="数据">
        <div className="flex flex-col gap-1.5">
          <CollapsibleList
            title="命令历史"
            load={loadHistory}
            empty="在终端中执行命令后会出现在这里。"
            getKey={(row: CommandHistoryRecord) => row.id}
          >
            {(row) => (
              <div className="px-3 py-1.5 hover:bg-surface-hover/60">
                <code className="block truncate font-mono text-11 text-fg" title={row.command}>
                  {row.command}
                </code>
                <span className="block truncate text-10 text-fg-subtle">
                  {row.server_name || "未关联服务器"} · {new Date(row.timestamp).toLocaleString()}
                </span>
              </div>
            )}
          </CollapsibleList>

          <CollapsibleList
            title="审计日志"
            load={loadAuditLogs}
            empty="还没有审计记录。"
            getKey={(row: AuditLogRecord) => row.id}
          >
            {(row) => (
              <div className="px-3 py-1.5 hover:bg-surface-hover/60">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-11 text-fg">{row.action}</span>
                  {row.server_name && (
                    <span className="shrink-0 truncate text-10 text-fg-subtle">{row.server_name}</span>
                  )}
                </div>
                <span className="block truncate text-10 text-fg-subtle">
                  {new Date(row.timestamp).toLocaleString()}
                  {row.details_json ? ` · ${row.details_json}` : ""}
                </span>
              </div>
            )}
          </CollapsibleList>
        </div>
      </Group>

      {appInfo && (
        <Group title="运行环境">
          <ListGroup>
            {(
              [
                ["版本", `v${appInfo.version}`],
                ["Schema", `v${appInfo.schema_version}`],
                ["平台", `${appInfo.os} / ${appInfo.arch}`],
                ["KeepAlive", `${appInfo.keepalive_secs}s`],
                ["数据库", appInfo.db_path],
              ] as [string, string][]
            ).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="shrink-0 text-11 text-fg-muted">{key}</span>
                <span className="min-w-0 flex-1 truncate text-right text-11 text-fg">{value}</span>
              </div>
            ))}
          </ListGroup>
        </Group>
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
            className="h-28 w-full resize-none rounded-[8px] border border-line bg-surface-1/70 px-2 py-1.5 font-mono text-11 text-fg outline-none placeholder:text-fg-subtle shadow-[inset_0_1px_0_rgb(255_255_255/0.45)] focus:border-accent"
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
