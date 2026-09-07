/**
 * Restart safety guard — pure logic, zero I/O.
 *
 * BLS-OPS holds live SSH sessions, in-flight file transfers and unsaved remote
 * files. Restarting the app for an update kills all of them, so the update flow
 * must ask first and must say *what* would be lost.
 */
import type { ActivityCounts } from "@/stores/activity-store";

/** One reason a restart would hurt. `key` is an i18n key resolved at render. */
export interface RestartBlocker {
  key: string;
  count: number;
}

export interface GuardInput {
  /** Sessions in `connected` state. */
  connectedSessions: number;
  /** Sessions still handshaking — killing them loses the connect attempt. */
  connectingSessions: number;
  activity: ActivityCounts;
}

/** Sentence shown above the list of blockers. i18n key. */
export const RESTART_WARNING_KEY =
  "Restarting now will interrupt the following work:";

/**
 * Collects everything a restart would interrupt, in a stable display order.
 *
 * Sessions come first because losing a session is always the worst outcome:
 * the remote shell dies, file transfers break and unsaved editor buffers are
 * gone with it.
 */
export function collectRestartBlockers(input: GuardInput): RestartBlocker[] {
  const blockers: RestartBlocker[] = [];
  const push = (key: string, count: number) => {
    if (count > 0) blockers.push({ key, count });
  };

  push("{{count}} active SSH sessions", input.connectedSessions);
  push("{{count}} SSH connections still being established", input.connectingSessions);
  push("{{count}} commands are still running", input.activity.command);
  push("{{count}} file transfers in progress", input.activity.transfer);
  push("{{count}} files have unsaved changes", input.activity.editor);
  push("{{count}} long-running tasks", input.activity.long_task);

  return blockers;
}

/** True when a restart needs an explicit confirmation listing the damage. */
export function hasBlockingActivity(blockers: RestartBlocker[]): boolean {
  return blockers.length > 0;
}
