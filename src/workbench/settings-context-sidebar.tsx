import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { useLocale } from "@/i18n/use-locale";
import { KnownHostsPanel } from "./host-key-dialog";
import { cn } from "@/lib/cn";

/**
 * 主题选项。label/short 存 **i18n key**（natural keys，英文即键）：
 * 模块级常量不能用 hook，渲染处统一 `t(...)`。语言切换即重渲染。
 */
const THEME_OPTIONS: { id: ThemeMode; labelKey: string; shortKey: string; icon: React.ElementType }[] = [
  { id: "system", labelKey: "Follow system", shortKey: "System", icon: Monitor },
  { id: "light", labelKey: "Light", shortKey: "Light", icon: Sun },
  { id: "dark", labelKey: "Dark", shortKey: "Dark", icon: Moon },
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
  const { t } = useTranslation();
  const { locale, locales, setLocale } = useLocale();
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
        ? t(
            "{{count}} servers are using credential “{{name}}”.\nAfter deletion they become “no credential” and must be re-selected before connecting.\n\nDelete anyway?",
            { count: references, name: credential.name },
          )
        : t("Delete credential “{{name}}”? The key in the system credential manager is removed too.", {
            name: credential.name,
          });
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
      <Group title={t("Appearance")}>
        <ListGroup>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="shrink-0 text-12 text-fg">{t("Theme")}</span>
            <div className="flex flex-1 justify-end rounded-[8px] border border-line bg-surface-2 p-0.5">
              {THEME_OPTIONS.map((option) => {
                const Icon = option.icon;
                const active = themeMode === option.id;
                return (
                  <Tooltip key={option.id} label={t(option.labelKey)}>
                    <button
                      type="button"
                      aria-label={t(option.labelKey)}
                      className={cn(
                        "flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded-[6px] text-11 transition-colors",
                        active ? "bg-surface-active text-fg shadow-sm" : "text-fg-muted hover:text-fg",
                      )}
                      onClick={() => setThemeMode(option.id)}
                    >
                      <Icon size={13} strokeWidth={1.75} className="shrink-0" />
                      <span className="truncate">{t(option.shortKey)}</span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </div>
          {/* 语言：切换即时生效（i18next 事件广播 → 全部订阅组件重渲染），
              无需重启。选择器里用各自语言的名字展示，方便任何用户找到它。 */}
          <div className="flex items-center justify-between gap-3 border-t border-line/60 px-3 py-2">
            <span className="shrink-0 text-12 text-fg">{t("Language")}</span>
            <select
              className={cn(selectClass, "max-w-40")}
              value={locale}
              aria-label={t("Language")}
              onChange={(event) => setLocale(event.target.value as (typeof locales)[number]["code"])}
            >
              {locales.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.native}
                </option>
              ))}
            </select>
          </div>
        </ListGroup>
      </Group>

      <Group
        title={t("Credentials")}
        hint={t("Keys are only written to the system credential manager; the database keeps a reference only.")}
        action={
          <Tooltip label={t("Add credential")}>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 px-1.5"
              aria-label={t("Add credential")}
              onClick={() => setEditing(emptyCredential())}
            >
              <Plus size={13} />
            </Button>
          </Tooltip>
        }
      >
        <ListGroup>
          {credentials.length === 0 ? (
            <EmptyRow>{t("No credentials yet")}</EmptyRow>
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
                      {credential.username} ·{" "}
                      {credential.credential_type === "private_key" ? t("Private key") : t("Password")} ·{" "}
                      {credential.secret_ref ? t("Key saved") : t("Key missing")}
                    </span>
                  </span>
                  <ChevronRight size={13} className="shrink-0 text-fg-subtle" />
                </button>
                <Tooltip label={t("Delete credential {{name}}", { name: credential.name })} side="left">
                  <button
                    type="button"
                    aria-label={t("Delete credential {{name}}", { name: credential.name })}
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

      <Group title={t("Known hosts")} hint={t("Fingerprints you confirmed on first connect are listed here.")}>
        <ListGroup>
          <KnownHostsPanel />
        </ListGroup>
      </Group>

      <Group title={t("Data")}>
        <div className="flex flex-col gap-1.5">
          <CollapsibleList
            title={t("Command history")}
            load={loadHistory}
            empty={t("Commands you run in the terminal will appear here.")}
            getKey={(row: CommandHistoryRecord) => row.id}
          >
            {(row) => (
              <div className="px-3 py-1.5 hover:bg-surface-hover/60">
                <code className="block truncate font-mono text-11 text-fg" title={row.command}>
                  {row.command}
                </code>
                <span className="block truncate text-10 text-fg-subtle">
                  {row.server_name || t("No server")} · {new Date(row.timestamp).toLocaleString()}
                </span>
              </div>
            )}
          </CollapsibleList>

          <CollapsibleList
            title={t("Audit log")}
            load={loadAuditLogs}
            empty={t("No audit records yet.")}
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
        <Group title={t("Runtime")}>
          <ListGroup>
            {(
              [
                [t("Version"), `v${appInfo.version}`],
                ["Schema", `v${appInfo.schema_version}`],
                [t("Platform"), `${appInfo.os} / ${appInfo.arch}`],
                ["KeepAlive", `${appInfo.keepalive_secs}s`],
                [t("Database"), appInfo.db_path],
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
  const { t } = useTranslation();
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
      title={isNew ? t("Add credential") : t("Edit credential — {{name}}", { name: credential.name })}
      description={
        isPrivateKey
          ? t("The private key and its passphrase are one configuration; an empty passphrase means an unencrypted key.")
          : t("The password is written to the system credential manager and cannot be viewed again later.")
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={submit.pending} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" size="sm" disabled={submit.pending} onClick={() => void save()}>
            {submit.pending ? t("Saving") : t("Save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <Field label={t("Name")}>
          <input
            className={fieldClass}
            value={form.name}
            placeholder={t("e.g. production root")}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>

        <Field label={t("Username")}>
          <input
            className={fieldClass}
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
          />
        </Field>

        <Field label={t("Type")}>
          <select
            className={selectClass}
            value={form.credential_type}
            onChange={(event) => setForm({ ...form, credential_type: event.target.value })}
          >
            {CREDENTIAL_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {t(type.label)}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={isPrivateKey ? t("Private key content") : t("Password")}
          hint={
            !isNew && existing?.secret_ref
              ? isPrivateKey
                ? t("Leave empty to keep the saved private key")
                : t("Leave empty to keep the saved password")
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
                  ? t("Login password (required)")
                  : t("Leave unchanged")
            }
          />
        </Field>

        {isPrivateKey && (
          <Field
            label={t("Key passphrase")}
            hint={t("Only needed when the private key itself is encrypted; leave empty for no passphrase")}
          >
            <input
              type="password"
              className={fieldClass}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={t("Optional")}
            />
          </Field>
        )}

        {isNew && (
          <p className="flex items-center gap-1.5 text-11 text-fg-subtle">
            <ShieldCheck size={12} />
            {isPrivateKey
              ? t("Paste the private key content when creating a key credential.")
              : t("Fill in the password when creating a password credential.")}
          </p>
        )}

        <ErrorText>{submit.error}</ErrorText>
      </div>
    </Modal>
  );
}
