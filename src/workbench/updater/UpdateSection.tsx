/**
 * 设置 → 应用更新。
 *
 * Renders the update state owned by `useUpdaterStore`; it performs no update
 * logic of its own. Everything is an i18n key resolved with `t()` here, so no
 * language is hard-coded into the component.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { formatBytes } from "@/lib/format";
import {
  UPDATE_ERROR_MESSAGES,
  UPDATE_STAGE_MESSAGES,
  sanitizeUpdateDetail,
} from "@/lib/updater/errors";
import { buildUpdateDiagnostics } from "@/lib/updater/diagnostics";
import { useUpdaterStore } from "@/stores/updater-store";
import { useUpdaterActions } from "@/hooks/use-updater";
import { useDomainStore } from "@/stores/domain-store";
import type { UpdatePhase } from "@/api/types/updater";
import { Group, InfoRow, ListGroup, Switch } from "../settings-parts";
import { UpdateRestartDialog } from "./UpdateRestartDialog";
import { useGuardedUpdate } from "./use-guarded-update";

/**
 * The endpoint the updater reads its manifest from.
 *
 * Mirrors `tauri.conf.json → plugins.updater.endpoints[0]` — the plugin reads
 * it inside Rust, so the frontend cannot ask for it; keep the two in sync.
 * Shown in the diagnostics bundle (never a local path, never a token).
 */
const UPDATE_MANIFEST_URL =
  "https://github.com/npcxl/BLS-OPS/releases/latest/download/latest.json";
/** Manual download page — same releases, no API, no credentials. */
const RELEASES_PAGE_URL = "https://github.com/npcxl/BLS-OPS/releases/latest";

/** Status line per phase. Values are i18n keys (natural keys). */
const PHASE_LABELS: Record<UpdatePhase, string> = {
  idle: "",
  checking: "Checking for updates…",
  up_to_date: "You are already on the latest version",
  available: "A new version is available",
  downloading: "Downloading update…",
  downloaded: "Downloaded — waiting for a safe moment to install",
  installing: "Installing update…",
  restart_required: "Update installed — restart to finish",
  cancelled: "Update postponed",
  error: "Update failed",
};

function formatWhen(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export function UpdateSection() {
  const { t } = useTranslation();
  const { check, remindLater, setAutoCheck } = useUpdaterActions();
  const guard = useGuardedUpdate();

  const phase = useUpdaterStore((s) => s.phase);
  const currentVersion = useUpdaterStore((s) => s.currentVersion);
  const release = useUpdaterStore((s) => s.release);
  const progress = useUpdaterStore((s) => s.progress);
  const error = useUpdaterStore((s) => s.error);
  const errorStage = useUpdaterStore((s) => s.errorStage);
  const lastCheckedAt = useUpdaterStore((s) => s.lastCheckedAt);
  const autoCheck = useUpdaterStore((s) => s.autoCheck);
  const appInfo = useDomainStore((s) => s.appInfo);
  /** "Copied" is a one-shot confirmation; two buttons share one message. */
  const [copied, setCopied] = useState<string | null>(null);

  // Sanitised again at the render site: the UI shows text the user can copy
  // into an issue, so nothing unsanitised may reach the DOM either.
  const detail = error ? sanitizeUpdateDetail(error.detail) : "";
  const diagnostics = useMemo(
    () =>
      buildUpdateDiagnostics({
        currentVersion,
        targetVersion: release?.version ?? null,
        os: appInfo?.os ?? null,
        arch: appInfo?.arch ?? null,
        stage: errorStage,
        error,
        manifestUrl: UPDATE_MANIFEST_URL,
        lastCheckedAt,
      }),
    [appInfo?.arch, appInfo?.os, currentVersion, error, errorStage, lastCheckedAt, release?.version],
  );

  const copy = async (text: string, message: "Copied" | "Diagnostics copied") => {
    const ok = await copyText(text);
    setCopied(ok ? message : null);
    if (!ok) return;
    window.setTimeout(() => setCopied(null), 2000);
  };

  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  // Installing is allowed whenever we hold a release and are not already
  // mid-flight or waiting for a restart. From `downloaded` the same button
  // finishes the install — the package is on disk, so nothing is refetched.
  const canInstall =
    !!release &&
    (phase === "available" ||
      phase === "cancelled" ||
      phase === "error" ||
      phase === "up_to_date" ||
      phase === "downloaded");
  const percent =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : null;

  return (
    <Group title={t("App update")}>
      <ListGroup>
        <InfoRow label={t("Current version")} value={currentVersion ? `v${currentVersion}` : "—"} />
        <InfoRow label={t("Update channel")} value={t("Stable")} />
        <InfoRow label={t("Last checked")} value={formatWhen(lastCheckedAt) ?? t("Never")} />
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <span className="shrink-0 text-11 text-fg">{t("Check for updates automatically")}</span>
          <Switch
            checked={autoCheck}
            onChange={setAutoCheck}
            label={t("Check for updates automatically")}
          />
        </div>
      </ListGroup>

      {release && phase !== "up_to_date" && (
        <ListGroup>
          <InfoRow label={t("New version")} value={`v${release.version}`} />
          <InfoRow label={t("Published")} value={formatWhen(release.date) ?? "—"} />
          {release.notes && (
            <div className="px-3 py-2">
              <span className="mb-1 block text-11 text-fg-muted">{t("Release notes")}</span>
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-sans text-11 leading-relaxed text-fg">
                {release.notes}
              </pre>
            </div>
          )}
        </ListGroup>
      )}

      {(phase === "downloading" || phase === "installing") && progress && (
        <div className="flex flex-col gap-1.5 px-0.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: percent === null ? "100%" : `${percent}%` }}
            />
          </div>
          <span className="text-11 text-fg-subtle">
            {percent === null
              ? formatBytes(progress.received)
              : `${percent}% · ${formatBytes(progress.received)} / ${formatBytes(progress.total ?? 0)}`}
          </span>
        </div>
      )}

      {PHASE_LABELS[phase] && (
        <p className="px-0.5 text-11 leading-relaxed text-fg-subtle">{t(PHASE_LABELS[phase])}</p>
      )}

      {error && (
        <div className="flex flex-col gap-2 rounded-[10px] border border-danger/25 bg-danger/5 px-3 py-2.5">
          {/* Stage headline ("Downloading the update failed") + the code's
              explanation ("No network connection…") + the sanitised reason.
              Production must never be a dead end: the real cause is visible
              and copyable even though console is out of reach for users. */}
          <p className="text-12 font-medium text-danger">
            {t(UPDATE_STAGE_MESSAGES[error.stage])}
          </p>
          <p className="text-11 leading-relaxed text-fg">{t(UPDATE_ERROR_MESSAGES[error.code])}</p>
          {detail && (
            <p className="break-words text-11 leading-relaxed text-fg-muted">
              {t("Details: {{detail}}", { detail })}
            </p>
          )}
          <p className="text-11 text-fg-subtle">
            {t("Error code: {{code}}", { code: error.code })}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => void copy(detail, "Copied")}>
              {t("Copy error details")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void check({ manual: true })}
              disabled={busy}
            >
              {t("Retry")}
            </Button>
          </div>
        </div>
      )}

      {copied && <p className="px-0.5 text-11 text-success">{t(copied)}</p>}

      <div className="flex flex-wrap items-center gap-1.5 px-0.5">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void check({ manual: true })}
        >
          {phase === "checking" ? t("Checking") : t("Check for updates")}
        </Button>
        {canInstall && (
          <Button variant="primary" size="sm" disabled={busy} onClick={guard.requestInstall}>
            {phase === "downloaded" ? t("Install and restart") : t("Download and install")}
          </Button>
        )}
        {phase === "restart_required" && (
          <Button variant="primary" size="sm" onClick={guard.requestRestart}>
            {t("Restart now")}
          </Button>
        )}
        {(phase === "available" || phase === "cancelled") && (
          <Button variant="ghost" size="sm" onClick={remindLater}>
            {t("Remind me later")}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void copy(diagnostics, "Diagnostics copied")}>
          {t("Copy diagnostics")}
        </Button>
        <a
          href={RELEASES_PAGE_URL}
          target="_blank"
          rel="noreferrer"
          className="text-11 text-accent underline-offset-2 hover:underline"
        >
          {t("Download manually from GitHub")}
        </a>
      </div>

      <UpdateRestartDialog
        open={guard.pendingAction !== null}
        action={guard.pendingAction === "restart" ? "restart" : "install"}
        blockers={guard.blockers}
        onConfirm={guard.confirm}
        onCancel={guard.cancel}
      />
    </Group>
  );
}
