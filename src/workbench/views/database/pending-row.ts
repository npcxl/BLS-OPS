import type { ColumnAssignment, DbValue } from "@/api/types/database";

/** Display drafts without modifying the server snapshot used for keys/conflict checks. */
export function pendingRow(row: DbValue[], columns: string[], values: ColumnAssignment[]): DbValue[] {
  const next = [...row];
  for (const assignment of values) {
    const col = columns.indexOf(assignment.column);
    if (col < 0) continue;
    const value = assignment.value;
    next[col] = value.kind === "null"
      ? { kind: "null" }
      : { kind: "text", value: value.kind === "default" ? "DEFAULT" : value.value,
          bytes: new TextEncoder().encode(value.kind === "default" ? "DEFAULT" : value.value).length,
          truncated: false };
  }
  return next;
}
