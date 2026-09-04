/** systemd units and journald log types. */

import { i18n } from "@/i18n";

// -- systemd ----------------------------------------------------------------

export interface ServiceUnit {
  /** Unit name, e.g. `nginx.service`. */
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  /**
   * Enabled at boot. `null` when systemd reports a state with no on/off
   * meaning (`static`, `indirect`, `masked`) — never a guessed `false`.
   */
  enabled: boolean | null;
  enabled_state: string | null;
}

export type ServiceActionName =
  | "start"
  | "stop"
  | "restart"
  | "reload"
  | "enable"
  | "disable";

// -- journald ---------------------------------------------------------------

export interface JournalEntry {
  /** ISO 8601 in UTC. */
  timestamp: string;
  unit: string;
  /** syslog priority, 0 (emerg) … 7 (debug). */
  priority: number;
  message: string;
}

export interface JournalDiskUsage {
  raw: string;
  bytes: number | null;
}

/** journald 优先级下拉 —— label 为英文 key，取用时经 `t(...)` 翻译。 */
export const JOURNAL_PRIORITIES = [
  { value: null, label: "All Levels" },
  { value: 0, label: "Emergency" },
  { value: 1, label: "Alert" },
  { value: 2, label: "Critical" },
  { value: 3, label: "Error" },
  { value: 4, label: "Warning" },
  { value: 5, label: "Notice" },
  { value: 6, label: "Info" },
  { value: 7, label: "Debug" },
] as const;

/** Label for a journald priority (localized). Unknown values fall back to "Other". */
export function priorityLabel(priority: number): string {
  const found = JOURNAL_PRIORITIES.find((item) => item.value === priority);
  return found ? i18n.t(found.label) : i18n.t("Other");
}
