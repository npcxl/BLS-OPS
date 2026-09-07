/**
 * Registry of work that an application restart would interrupt.
 *
 * Terminal "is a command running" state cannot be observed reliably — a shell
 * is interactive by definition — so instead of guessing, the components that
 * actually own a long-running operation register a ticket here while it runs
 * and drop it when it finishes (or when they unmount).
 *
 * Nothing is ever invented: an absent ticket means "not running", not
 * "probably running".
 */
import { useEffect } from "react";
import { create } from "zustand";

export type ActivityKind =
  /** A command dispatched through the command centre or a management module. */
  | "command"
  /** An SFTP upload or download. */
  | "transfer"
  /** A remote file open in the editor with unsaved changes. */
  | "editor"
  /** A long-running task such as a project scan. */
  | "long_task";

export interface ActivityTicket {
  id: string;
  kind: ActivityKind;
}

export type ActivityCounts = Record<ActivityKind, number>;

interface ActivityState {
  tickets: Record<string, ActivityTicket>;
  begin: (kind: ActivityKind) => string;
  end: (id: string) => void;
}

let nextId = 0;

export const useActivityStore = create<ActivityState>()((set) => ({
  tickets: {},

  begin: (kind) => {
    const id = `activity-${++nextId}`;
    set((state) => ({ tickets: { ...state.tickets, [id]: { id, kind } } }));
    return id;
  },

  end: (id) =>
    set((state) => {
      if (!state.tickets[id]) return state;
      const next = { ...state.tickets };
      delete next[id];
      return { tickets: next };
    }),
}));

/** Counts running work per kind — the only shape the restart guard consumes. */
export function countTickets(tickets: Record<string, ActivityTicket>): ActivityCounts {
  const counts: ActivityCounts = { command: 0, transfer: 0, editor: 0, long_task: 0 };
  for (const ticket of Object.values(tickets)) counts[ticket.kind] += 1;
  return counts;
}

/**
 * Registers a ticket while `active` is true and releases it on flip/unmount.
 *
 * The ticket is released on unmount too, so closing a tab mid-transfer can
 * never leave a phantom "work in progress" that blocks restarts forever.
 */
export function useActivityTicket(kind: ActivityKind, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const id = useActivityStore.getState().begin(kind);
    return () => useActivityStore.getState().end(id);
  }, [active, kind]);
}

/** Test-only helper: wipes every ticket between cases. */
export function resetActivity(): void {
  useActivityStore.setState({ tickets: {} });
}
