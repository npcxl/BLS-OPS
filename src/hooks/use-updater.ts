/**
 * React bindings for the update flow.
 *
 * Mounted **once** (in `Workbench`) so that exactly one place decides when an
 * automatic check happens. Every other component only reads the store and
 * calls its actions — no component may call `check()` on its own.
 */
import { useEffect, useMemo } from "react";
import {
  AUTO_CHECK_DELAY_MS,
  useUpdaterStore,
} from "@/stores/updater-store";
import { countTickets, useActivityStore } from "@/stores/activity-store";
import {
  selectActiveCount,
  selectConnectingCount,
  useSessionStore,
} from "@/stores/session-store";
import { collectRestartBlockers, type RestartBlocker } from "@/workbench/updater/update-guard";
import { isDevRuntime } from "@/lib/updater/updater-client";

/**
 * Startup auto-check.
 *
 * - runs once per process (`checkedThisLaunch`);
 * - delayed so it never competes with the first render / DB init;
 * - skipped entirely in `tauri dev`;
 * - failures are recorded in the store, never thrown — a broken update server
 *   must not break app startup.
 */
export function useAutoUpdateCheck(): void {
  const init = useUpdaterStore((s) => s.init);
  const check = useUpdaterStore((s) => s.check);
  const autoCheck = useUpdaterStore((s) => s.autoCheck);
  const checkedThisLaunch = useUpdaterStore((s) => s.checkedThisLaunch);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (isDevRuntime() || !autoCheck || checkedThisLaunch) return;
    const timer = window.setTimeout(() => {
      void check({ manual: false }).catch(() => undefined);
    }, AUTO_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoCheck, checkedThisLaunch, check]);
}

/** Stable action bundle for the settings UI. */
export function useUpdaterActions() {
  const check = useUpdaterStore((s) => s.check);
  const install = useUpdaterStore((s) => s.install);
  const restart = useUpdaterStore((s) => s.restart);
  const remindLater = useUpdaterStore((s) => s.remindLater);
  const dismissBanner = useUpdaterStore((s) => s.dismissBanner);
  const setAutoCheck = useUpdaterStore((s) => s.setAutoCheck);

  return useMemo(
    () => ({ check, install, restart, remindLater, dismissBanner, setAutoCheck }),
    [check, install, restart, remindLater, dismissBanner, setAutoCheck],
  );
}

/**
 * What a restart right now would interrupt.
 *
 * Sessions come from the session store (the single source of truth for live
 * SSH state); everything else is a ticket registered by the owning component.
 */
export function useRestartBlockers(): RestartBlocker[] {
  const connectedSessions = useSessionStore(selectActiveCount);
  const connectingSessions = useSessionStore(selectConnectingCount);
  const tickets = useActivityStore((s) => s.tickets);

  return useMemo(
    () => collectRestartBlockers({ connectedSessions, connectingSessions, activity: countTickets(tickets) }),
    [connectedSessions, connectingSessions, tickets],
  );
}
