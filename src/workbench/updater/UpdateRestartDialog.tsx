/**
 * Confirmation shown before an update interrupts live work.
 *
 * Deliberately has **no** "install anyway without asking" and no "skip
 * verification" escape hatch: the only choices are to proceed now or to keep
 * working and restart later (the installed package is preserved either way).
 */
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { RESTART_WARNING_KEY, type RestartBlocker } from "./update-guard";

interface UpdateRestartDialogProps {
  open: boolean;
  /** `"install"` when the package still has to be fetched, `"restart"` after. */
  action: "install" | "restart";
  blockers: RestartBlocker[];
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UpdateRestartDialog({
  open,
  action,
  blockers,
  pending = false,
  onConfirm,
  onCancel,
}: UpdateRestartDialogProps) {
  const { t } = useTranslation();

  return (
    <Modal
      open={open}
      width={400}
      title={action === "install" ? t("Install update and restart?") : t("Restart to finish the update?")}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
            {t("Not now")}
          </Button>
          <Button variant="primary" size="sm" disabled={pending} onClick={onConfirm}>
            {pending ? t("Processing") : action === "install" ? t("Install and restart") : t("Restart now")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-12 leading-relaxed text-fg-muted">{t(RESTART_WARNING_KEY)}</p>
        <ul className="flex flex-col gap-1 rounded-[8px] border border-line bg-surface-2/70 px-3 py-2">
          {blockers.map((blocker) => (
            <li key={blocker.key} className="text-12 text-fg">
              {t(blocker.key, { count: blocker.count })}
            </li>
          ))}
        </ul>
        <p className="text-11 leading-relaxed text-fg-subtle">
          {t("The downloaded update is kept, so you can restart later from Settings without downloading it again.")}
        </p>
      </div>
    </Modal>
  );
}
