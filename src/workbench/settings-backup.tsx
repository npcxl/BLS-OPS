/**
 * 设置页 · 配置备份与恢复。
 *
 * 文件选择走系统对话框（用户明确意图），读写由 Rust 完成；这里只负责：
 * 收集 localStorage 里的偏好、展示预览、把导入结果说清楚。
 *
 * 两条必须如实告知用户的事：
 * 1. 备份**不含密钥** —— 导入后凭据要重新绑定。
 * 2. 导入是整批事务 —— 失败时不会留下半份数据。
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { opsApi, toErrorMessage, type BackupPreview } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";
import { applyTheme } from "@/hooks/use-theme";
import { Group, ListGroup } from "./settings-parts";

/** 分区 key → 文案 key（`t()` 未命中时原样显示英文，不至于空白）。 */
const SECTION_LABELS: Record<string, string> = {
  servers: "Servers",
  groups: "Groups",
  credentials: "Credentials",
  known_hosts: "Known hosts",
  projects: "Projects",
  project_reviews: "Project reviews",
  project_merges: "Project merges",
};

/**
 * 收集偏好设置。
 *
 * 只带字符串值：localStorage 里目前全是开关与选择项，凭据在系统钥匙串里，
 * 不在这里 —— 所以整份带走是安全的。
 */
function collectSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      const value = key ? localStorage.getItem(key) : null;
      if (key && value !== null) out[key] = value;
    }
  } catch {
    // localStorage 不可用（极端 WebView 配置）：不带设置，数据照常导出。
  }
  return out;
}

/** 写回偏好，返回实际写入的条数。主题立刻生效，其余下次启动生效。 */
function applySettings(settings: unknown): number {
  if (!settings || typeof settings !== "object") return 0;
  let applied = 0;
  for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    try {
      localStorage.setItem(key, value);
      applied += 1;
    } catch {
      // 单个键写不进去就跳过，不影响其它设置。
    }
  }
  return applied;
}

interface PendingImport {
  path: string;
  preview: BackupPreview;
}

export function BackupSettingsGroup() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  /** 默认只导入新增：覆盖别人的配置应该是显式选择。 */
  const [overwrite, setOverwrite] = useState(false);

  const exportConfig = useCallback(async () => {
    setBusy("export");
    setNotice(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `bls-ops-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const summary = await opsApi.backupExport(path, collectSettings());
      setNotice({
        tone: "success",
        text: t(
          "Exported {{servers}} servers, {{groups}} groups, {{credentials}} credentials and {{projects}} projects to {{path}}",
          {
            servers: summary.servers,
            groups: summary.groups,
            credentials: summary.credentials,
            projects: summary.projects,
            path: summary.path,
          },
        ),
      });
    } catch (cause) {
      setNotice({ tone: "danger", text: toErrorMessage(cause) });
    } finally {
      setBusy(null);
    }
  }, [t]);

  const pickImport = useCallback(async () => {
    setBusy("import");
    setNotice(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      const preview = await opsApi.backupPreview(picked);
      setOverwrite(false);
      setPending({ path: picked, preview });
    } catch (cause) {
      setNotice({ tone: "danger", text: toErrorMessage(cause) });
    } finally {
      setBusy(null);
    }
  }, []);

  const runImport = useCallback(async () => {
    if (!pending) return;
    setBusy("import");
    try {
      const result = await opsApi.backupImport(pending.path, overwrite);
      const settingsApplied = applySettings(result.settings);
      // 主题立刻跟上；语言等下次启动生效（重载会中断正在跑的会话）。
      applyTheme();
      await useDomainStore.getState().refreshAll();
      setPending(null);
      setNotice({
        tone: "success",
        text: t(
          "Imported: {{added}} added, {{overwritten}} overwritten, {{skipped}} skipped. Rebind credentials before connecting.",
          {
            added: result.added,
            overwritten: result.overwritten,
            skipped: result.skipped,
          },
        ) + (settingsApplied > 0 ? ` ${t("{{count}} preferences restored.", { count: settingsApplied })}` : ""),
      });
    } catch (cause) {
      setNotice({ tone: "danger", text: toErrorMessage(cause) });
    } finally {
      setBusy(null);
    }
  }, [overwrite, pending, t]);

  const total = pending?.preview.sections.reduce(
    (sum, section) => ({ added: sum.added + section.added, conflicts: sum.conflicts + section.conflicts }),
    { added: 0, conflicts: 0 },
  );

  return (
    <Group
      title={t("Backup & restore")}
      hint={t(
        "Bring your servers, groups, tags, jump hosts, projects and preferences to a new machine. Rebinding credentials is the only step left.",
      )}
    >
      <ListGroup>
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <div className="text-12 text-fg">{t("Export configuration")}</div>
            <div className="text-11 leading-relaxed text-fg-subtle">
              {t(
                "Creates a file you can take to another machine. Passwords and private keys are not included.",
              )}
            </div>
          </div>
          <Button variant="secondary" size="xs" disabled={busy !== null} onClick={() => void exportConfig()}>
            {busy === "export" ? t("Exporting…") : t("Export…")}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line/60 px-3 py-2">
          <div className="min-w-0">
            <div className="text-12 text-fg">{t("Import configuration")}</div>
            <div className="text-11 leading-relaxed text-fg-subtle">
              {t("Preview first: you decide whether existing entries are kept or overwritten.")}
            </div>
          </div>
          <Button variant="secondary" size="xs" disabled={busy !== null} onClick={() => void pickImport()}>
            {busy === "import" && !pending ? t("Reading…") : t("Import…")}
          </Button>
        </div>
      </ListGroup>

      {notice && (
        <p
          className={cn(
            "mt-2 rounded-[8px] border px-2.5 py-1.5 text-11 leading-relaxed",
            notice.tone === "danger"
              ? "border-danger/30 bg-danger/10 text-danger"
              : "border-success/30 bg-success/10 text-success",
          )}
        >
          {notice.text}
        </p>
      )}

      <Modal
        open={pending !== null}
        width={520}
        title={t("Import configuration")}
        description={
          pending
            ? t("From {{path}} · exported by version {{version}}", {
                path: pending.path,
                version: pending.preview.app_version,
              })
            : undefined
        }
        onClose={() => setPending(null)}
      >
        {pending && (
          <div className="flex flex-col gap-3">
            <div className="rounded-[8px] border border-line">
              {pending.preview.sections.map((section, index) => (
                <div
                  key={section.key}
                  className={cn(
                    "flex items-center justify-between gap-2 px-3 py-1.5 text-11",
                    index > 0 && "border-t border-line/60",
                  )}
                >
                  <span className="text-fg">{t(SECTION_LABELS[section.key] ?? section.key)}</span>
                  <span className="shrink-0 font-mono text-fg-subtle">
                    {t("{{total}} total", { total: section.total })}
                    <span className="ml-2 text-success">+{section.added}</span>
                    {section.conflicts > 0 && (
                      <span className="ml-1 text-warning">{t("{{count}} conflicts", { count: section.conflicts })}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>

            {pending.preview.conflict_samples.length > 0 && (
              <div className="rounded-[8px] border border-line bg-surface-2/60 px-3 py-2">
                <div className="mb-1 text-10 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
                  {t("Conflicts (already on this machine)")}
                </div>
                <ul className="space-y-0.5 font-mono text-10 text-fg-muted">
                  {pending.preview.conflict_samples.map((sample) => (
                    <li key={sample} className="truncate" title={sample}>
                      {sample}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {pending.preview.warnings.map((warning) => (
              <p key={warning} className="text-11 leading-relaxed text-warning">
                {t(warning)}
              </p>
            ))}

            <label className="flex items-start gap-2 rounded-[8px] border border-line px-3 py-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
              />
              <span className="min-w-0 text-11 leading-relaxed text-fg-muted">
                {t("Overwrite existing entries (off = import new entries only, keep this machine's version)")}
              </span>
            </label>

            <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
              <Button variant="ghost" size="sm" disabled={busy === "import"} onClick={() => setPending(null)}>
                {t("Cancel")}
              </Button>
              <Button variant="primary" size="sm" disabled={busy === "import"} onClick={() => void runImport()}>
                {busy === "import"
                  ? t("Importing…")
                  : t("Import {{count}} entries", { count: total?.added ?? 0 })}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Group>
  );
}
