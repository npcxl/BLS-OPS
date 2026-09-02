/** systemd units and journald log types. */

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

/** Maximum syslog priority to include. `null` means "everything". */
export const JOURNAL_PRIORITIES = [
  { value: null, label: "全部级别" },
  { value: 0, label: "紧急" },
  { value: 1, label: "警报" },
  { value: 2, label: "严重" },
  { value: 3, label: "错误" },
  { value: 4, label: "警告" },
  { value: 5, label: "通知" },
  { value: 6, label: "信息" },
  { value: 7, label: "调试" },
] as const;

/** Chinese label for a journald priority. */
export function priorityLabel(priority: number): string {
  return JOURNAL_PRIORITIES.find((item) => item.value === priority)?.label ?? "其他";
}
