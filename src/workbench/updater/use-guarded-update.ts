/**
 * "Install / restart, but only after asking" — shared by the settings section
 * and the auto-check banner so both behave identically.
 *
 * The rule: a restart is never silent while BLS-OPS holds live SSH sessions,
 * in-flight transfers, unsaved remote files or long-running tasks. If any of
 * those exist the user gets a dialog naming them; cancelling leaves the update
 * installed-but-waiting so it can be finished later without re-downloading.
 */
import { useCallback, useState } from "react";
import { useRestartBlockers, useUpdaterActions } from "@/hooks/use-updater";

export type GuardedAction = "install" | "restart" | null;

export function useGuardedUpdate() {
  const [pendingAction, setPendingAction] = useState<GuardedAction>(null);
  const blockers = useRestartBlockers();
  const { install, restart } = useUpdaterActions();

  const requestInstall = useCallback(() => {
    if (blockers.length > 0) setPendingAction("install");
    else void install();
  }, [blockers.length, install]);

  const requestRestart = useCallback(() => {
    if (blockers.length > 0) setPendingAction("restart");
    else void restart();
  }, [blockers.length, restart]);

  const confirm = useCallback(() => {
    const action = pendingAction;
    setPendingAction(null);
    if (action === "install") void install();
    else if (action === "restart") void restart();
  }, [pendingAction, install, restart]);

  const cancel = useCallback(() => setPendingAction(null), []);

  return { blockers, pendingAction, requestInstall, requestRestart, confirm, cancel };
}
