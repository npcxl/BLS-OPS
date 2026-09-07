/**
 * Non-blocking "a new version is available" card.
 *
 * Shown only for *automatic* findings: it never downloads, never installs and
 * never restarts on its own — the user picks install, later, or dismiss. A
 * manual check that finds nothing new is reported inside the settings page
 * instead of as a popup.
 */
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdaterStore } from "@/stores/updater-store";
import { useUpdaterActions } from "@/hooks/use-updater";
import { UpdateRestartDialog } from "./UpdateRestartDialog";
import { useGuardedUpdate } from "./use-guarded-update";

export function UpdateNotification() {
  const { t } = useTranslation();
  const { remindLater, dismissBanner } = useUpdaterActions();
  const guard = useGuardedUpdate();

  const visible = useUpdaterStore((s) => s.bannerVisible);
  const release = useUpdaterStore((s) => s.release);

  if (!visible || !release) return null;

  return (
    <>
      <div className="glass-panel fixed bottom-4 right-4 z-50 flex w-[320px] flex-col gap-2 rounded-[12px] border border-line p-3 shadow-[0_8px_28px_rgb(15_23_42/0.16)]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-12 font-semibold text-fg">{t("Update available")}</p>
            <p className="truncate text-11 text-fg-subtle">v{release.version}</p>
          </div>
          <button
            type="button"
            aria-label={t("Close")}
            className="shrink-0 rounded p-0.5 text-fg-subtle hover:text-fg"
            onClick={dismissBanner}
          >
            <X size={13} />
          </button>
        </div>

        {release.notes && (
          <p className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-11 leading-relaxed text-fg-muted">
            {release.notes}
          </p>
        )}

        <div className="flex items-center justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={remindLater}>
            {t("Remind me later")}
          </Button>
          <Button variant="primary" size="sm" onClick={guard.requestInstall}>
            {t("Download and install")}
          </Button>
        </div>
      </div>

      <UpdateRestartDialog
        open={guard.pendingAction !== null}
        action={guard.pendingAction === "restart" ? "restart" : "install"}
        blockers={guard.blockers}
        onConfirm={guard.confirm}
        onCancel={guard.cancel}
      />
    </>
  );
}
