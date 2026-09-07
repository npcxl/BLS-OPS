/**
 * 设置 → 应用更新。
 *
 * Renders the update state owned by `useUpdaterStore`; it performs no update
 * logic of its own. Everything is an i18n key resolved with `t()` here, so no
 * language is hard-coded into the component.
 */
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/modal";
import { formatBytes } from "@/lib/format";
import { UPDATE_ERROR_MESSAGES } from "@/lib/updater/errors";
import { useUpdaterStore } from "@/stores/updater-store";
import { useUpdaterActions } from "@/hooks/use-updater";
import type { UpdatePhase } from "@/api/types/updater";
import { Group, InfoRow, ListGroup, Switch } from "../settings-parts";
import { UpdateRestartDialog } from "./UpdateRestartDialog";
import { useGuardedUpdate } from "./use-guarded-update";

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
  const lastCheckedAt = useUpdaterStore((s) => s.lastCheckedAt);
  const autoCheck = useUpdaterStore((s) => s.autoCheck);

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

      {error && <ErrorText>{t(UPDATE_ERROR_MESSAGES[error.code])}</ErrorText>}

      <div className="flex flex-wrap items-center gap-1.5 px-0.5">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void check({ manual: true })}>
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
