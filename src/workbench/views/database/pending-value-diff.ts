import type { AssignValue } from "@/api/types/database";

export function sameAssignment(a: AssignValue | undefined, b: AssignValue | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && (a.kind !== "value" || (b.kind === "value" && a.value === b.value));
}

/** Compare code points so highlighting never splits a surrogate pair. */
export function valueDiff(before: string, after: string) {
  const a = Array.from(before);
  const b = Array.from(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  return {
    prefix: a.slice(0, start).join(""),
    removed: a.slice(start, a.length - end).join(""),
    added: b.slice(start, b.length - end).join(""),
    suffix: end ? a.slice(a.length - end).join("") : "",
  };
}

export function assignmentText(value: AssignValue | undefined): string {
  if (!value) return "—";
  if (value.kind === "null") return "NULL";
  if (value.kind === "default") return "DEFAULT";
  return value.value === "" ? '""' : value.value;
}
