import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, KeyRound, Monitor, Moon, Plus, Sun, Trash2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { ErrorState } from "@/components/ui/error-state";
import { CredentialForm } from "./credential-form";
export { CredentialForm } from "./credential-form";
import { useActionError } from "@/hooks/use-action-error";
import { Select } from "@/components/ui/select";
import {
  opsApi,
  type AuditLogRecord,
  type CommandHistoryRecord,
  type CredentialRecord,
} from "@/api/ops-api";
import { emptyCredential, useDomainStore } from "@/stores/domain-store";
import { useThemeMode, type ThemeMode } from "@/hooks/use-theme";
import { useDensityMode } from "@/hooks/use-density";
import { useWindowMaterial, useWindowTransparency } from "@/lib/window-material";
import { useLocale } from "@/i18n/use-locale";
import { KnownHostsPanel } from "./host-key-dialog";
import { UpdateSection } from "./updater/UpdateSection";
import { AiProviderSettings } from "./settings-ai";
import { EmptyRow, Group, ListGroup, Switch } from "./settings-parts";
import { SegmentedControl } from "./page-layout";
import { setInspectionMode, useInspectionMode } from "@/stores/inspection-store";
import { TerminalSettingsGroup } from "./settings-terminal";
import { BackupSettingsGroup } from "./settings-backup";
import { ShortcutSettingsGroup } from "./settings-shortcuts";
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

/** 材质回退原因 → 说明。null 表示磨砂正常。 */
function materialReasonText(t: (key: string) => string, reason: string): string {
  switch (reason) {
    case "user_disabled":
      return t("Off: the window uses a solid background.");
    case "system_transparency_off":
      return t("Windows transparency effects are off in system settings, so a solid background is used.");
    case "os_unsupported":
      return t("This Windows version does not support Acrylic, so a solid background is used.");
    case "platform_unsupported":
      return t("Native blur is only available on Windows, so a solid background is used.");
    default:
      return t("The native material could not be applied, so a solid background is used.");
  }
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

export type SettingsCategory = "general" | "terminal" | "security" | "data" | "ai" | "updates" | "about";

/** Existing settings sections, filtered by the settings page navigation. */
export function SettingsContextSidebar({ category }: { category?: SettingsCategory }) {
  const visible = (id: SettingsCategory) => !category || category === id;
  const { t } = useTranslation();
  const { locale, locales, setLocale } = useLocale();
  const credentials = useDomainStore((s) => s.credentials);
  const refreshCredentials = useDomainStore((s) => s.refreshCredentials);
  const appInfo = useDomainStore((s) => s.appInfo);

  const [themeMode, setThemeMode] = useThemeMode();
  const [density, setDensity] = useDensityMode();
  const [transparency, setTransparency] = useWindowTransparency();
  const material = useWindowMaterial();
  // 系统层面的原因（版本过低 / 系统关闭透明效果）不归用户开关管：开关要灰掉。
  const materialReason =
    material && material.reason !== "user_disabled" ? material.reason : null;
  const materialBlocked =
    materialReason === "os_unsupported" ||
    materialReason === "system_transparency_off" ||
    materialReason === "platform_unsupported";
  const inspection = useInspectionMode();
  const servers = useDomainStore((s) => s.servers);
  const [editing, setEditing] = useState<CredentialRecord | null>(null);
  /** 原始异常：读凭据失败要能看清是钥匙串权限还是存储损坏。 */
  const { error, fail, clear, retry } = useActionError();
  /** 删除凭据：不可撤销（钥匙串里的密钥一并删除），必须过确认弹窗。 */
  const [pendingDelete, setPendingDelete] = useState<CredentialRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      await refreshCredentials();
      clear();
    } catch (cause) {
      fail(cause, () => void load());
    }
  }, [refreshCredentials, clear, fail]);

  useEffect(() => {
    if (!category || category === "security") void load();
  }, [load, category]);

  const remove = async (credential: CredentialRecord) => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await useDomainStore.getState().deleteCredential(credential.id, true);
      clear();
      setPendingDelete(null);
    } catch (cause) {
      // 就地显示在弹窗里：同一件事不在背景页再报一遍。
      setDeleteError(cause);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {visible("general") && (<Group title={t("Appearance")}>
        <ListGroup>
          <div className="page-form-row">
            <span className="shrink-0 text-12 text-fg">{t("Theme")}</span>
            <SegmentedControl
              value={themeMode}
              onChange={setThemeMode}
              label={t("Theme")}
              items={THEME_OPTIONS.map((option) => {
                const Icon = option.icon;
                return {
                  id: option.id,
                  label: (
                    <>
                      <Icon size={13} strokeWidth={1.75} className="shrink-0" />
                      <span className="truncate">{t(option.shortKey)}</span>
                    </>
                  ),
                };
              })}
            />
          </div>
          {/* 密度是全局变体：只改 --page-* 令牌，页面不各自写间距。 */}
          <div className="page-form-row">
            <div className="min-w-0">
              <div className="text-12 text-fg">{t("Compact mode")}</div>
              <div className="page-form-help">{t("Tighter rows, toolbars and section spacing.")}</div>
            </div>
            <SegmentedControl
              value={density}
              onChange={setDensity}
              label={t("Density")}
              items={[
                { id: "comfortable", label: t("Comfortable") },
                { id: "compact", label: t("Compact") },
              ]}
            />
          </div>
          {/* 窗口透明效果：原生 Acrylic 的开头。关掉时外壳走实色回退
              （`[data-material="solid"]`），不是因为"不支持"，而是用户选择。
              系统版本过低或系统关闭透明效果时，这一项会显示为不可用并说明原因。 */}
          <div className="page-form-row">
            <div className="min-w-0">
              <div className="text-12 text-fg">{t("Window transparency")}</div>
              <div className="text-11 leading-relaxed text-fg-subtle">
                {materialReason
                  ? materialReasonText(t, materialReason)
                  : t("Acrylic blur behind the window. Turn off for a solid background.")}
              </div>
            </div>
            <Switch
              checked={transparency && !materialBlocked}
              disabled={materialBlocked}
              label={t("Window transparency")}
              onChange={(next) => setTransparency(next)}
            />
          </div>
          {/* 语言：切换即时生效（i18next 事件广播 → 全部订阅组件重渲染），
              无需重启。选择器里用各自语言的名字展示，方便任何用户找到它。 */}
          <div className="page-form-row">
            <span className="shrink-0 text-12 text-fg">{t("Language")}</span>
            <Select
              className="max-w-40"
              value={locale}
              ariaLabel={t("Language")}
              options={locales.map((item) => ({ value: item.code, label: item.native }))}
              onChange={(next) => setLocale(next as (typeof locales)[number]["code"])}
            />
          </div>
        </ListGroup>
      </Group>)}

      {visible("terminal") && <TerminalSettingsGroup />}

      {visible("security") && (<Group
        title={t("Safety")}
        hint={t("Read-only inside the app.")}
      >
        <ListGroup>
          <div className="page-form-row">
            <div className="min-w-0">
              <div className="text-12 text-fg">{t("Inspection mode (read-only)")}</div>
              <div className="text-11 leading-relaxed text-fg-subtle">
                {t("Disables writes and service changes.")}
              </div>
            </div>
            <Switch
              checked={inspection}
              onChange={setInspectionMode}
              label={t("Inspection mode (read-only)")}
            />
          </div>
        </ListGroup>
      </Group>)}

      {visible("data") && <BackupSettingsGroup />}

      {visible("terminal") && <ShortcutSettingsGroup />}

      {visible("security") && (<Group
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
                    onClick={() => setPendingDelete(credential)}
                  >
                    <Trash2 size={12} />
                  </button>
                </Tooltip>
              </div>
            ))
          )}
        </ListGroup>
      </Group>)}

      {/* P5.5.1：AI 模型提供方（密钥只进钥匙串；没有"读取 API Key"的入口）。 */}
      {visible("ai") && <AiProviderSettings />}

      {visible("security") && (<Group title={t("Known hosts")} hint={t("Fingerprints you confirmed on first connect are listed here.")}>
        <ListGroup>
          <KnownHostsPanel />
        </ListGroup>
      </Group>)}

      {visible("data") && (<Group title={t("Data")}>
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
      </Group>)}

      {visible("updates") && <UpdateSection />}

      {visible("about") && appInfo && (
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
              <div key={key} className="page-form-row">
                <span className="shrink-0 text-11 text-fg-muted">{key}</span>
                <span className="min-w-0 flex-1 truncate text-right text-11 text-fg">{value}</span>
              </div>
            ))}
          </ListGroup>
        </Group>
      )}

      {visible("security") && error ? <ErrorState error={error} compact onRetry={retry} className="px-3" /> : null}

      {visible("about") && !appInfo && <EmptyRow>{t("Loading")}</EmptyRow>}
      {editing && <CredentialForm credential={editing} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={pendingDelete !== null}
        risk="irreversible"
        title={t("Delete credential")}
        description={
          pendingDelete ? (
            <span className="break-all text-fg">{pendingDelete.name}</span>
          ) : null
        }
        consequences={(() => {
          const references = pendingDelete
            ? servers.filter((item) => item.credential_id === pendingDelete.id).length
            : 0;
          return [
            t("The key in the system credential manager is removed too."),
            ...(references > 0
              ? [
                  t(
                    "{{count}} servers use this credential; they become “no credential” and must be re-selected before connecting.",
                    { count: references },
                  ),
                ]
              : []),
          ];
        })()}
        confirmLabel={t("Delete")}
        pending={deleting}
        error={deleteError ?? undefined}
        onConfirm={() => {
          if (pendingDelete) void remove(pendingDelete);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
