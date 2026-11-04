import { useTranslation } from "react-i18next";
import { X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { AssignValue, ColumnAssignment } from "@/api/types/database";
import { assignmentText, sameAssignment, valueDiff } from "./pending-value-diff";

export type PendingChange =
  | {
      id: string;
      kind: "update";
      key: AssignValue[];
      label: string;
      values: ColumnAssignment[];
      expected: ColumnAssignment[];
    }
  | {
      id: string;
      kind: "delete";
      key: AssignValue[];
      label: string;
      expected: ColumnAssignment[];
    }
  | { id: string; kind: "insert"; values: ColumnAssignment[] };


export function PendingChangeList({entries: pending, onRemove, disabled = false}: {entries: PendingChange[]; onRemove: (id: string) => void; disabled?: boolean}) {
const {t} = useTranslation();
return (<div className="ops-scroll flex max-h-[55vh] flex-col gap-4 overflow-y-auto pr-1">
          {pending.length === 0 && (
            <div className="py-10 text-center text-13 text-fg-subtle">{t("暂无变更")}</div>
          )}
          {pending.map((entry) => (
            <div
              key={entry.id}
              className="shrink-0 overflow-hidden rounded-xl border border-line/70 bg-surface-1"
            >
              <div className="flex min-w-0 items-center gap-2 border-b border-line/60 bg-surface-2/50 px-3 py-2">
              <span
                className={cn(
                  "shrink-0 rounded-md px-2 py-0.5 text-11 font-medium",
                  entry.kind === "insert"
                    ? "bg-success/10 text-success"
                    : entry.kind === "delete"
                      ? "bg-danger/10 text-danger"
                      : "bg-surface-3 text-fg-muted",
                )}
              >
                {entry.kind === "insert" ? t("新增") : entry.kind === "delete" ? t("删除") : t("修改")}
              </span>
                <div className="min-w-0 flex-1 truncate font-mono text-12 text-fg" title={entry.kind === "insert" ? undefined : entry.label}>
                  {entry.kind === "insert" ? t("新增行") : entry.label}
                </div>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  size="xs"
                  className="w-6 shrink-0 !px-0"
                  aria-label={t("移除")}
                  title={t("移除")}
                  onClick={() => onRemove(entry.id)}
                >
                  <X size={14} />
                </Button>
              </div>
                <div className="overflow-x-auto">
                  <table className="w-full table-fixed border-collapse text-12 leading-relaxed">
                    <thead>
                      <tr className="text-left text-11 text-fg-subtle">
                        <th className="w-1/4 px-3 py-2 font-medium">{t("字段")}</th>
                        <th className="px-3 py-2 font-medium">{t("原值")}</th>
                        <th className="px-3 py-2 font-medium">{t("新值")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(entry.kind === "delete" ? entry.expected : entry.values).filter((assignment) =>
                        entry.kind !== "update" || !sameAssignment(entry.expected.find((old) => old.column === assignment.column)?.value, assignment.value),
                      ).map((assignment) => {
                        const old = entry.kind === "insert" ? undefined : entry.expected.find((item) => item.column === assignment.column)?.value;
                        const next = entry.kind === "delete" ? undefined : assignment.value;
                        const before = assignmentText(old);
                        const after = assignmentText(next);
                        const diff = old?.kind === "value" && next?.kind === "value"
                          ? valueDiff(before, after)
                          : { prefix: "", removed: before, added: after, suffix: "" };
                        return (
                          <tr key={assignment.column} className="border-t border-line/40 align-top">
                            <th scope="row" className="break-all px-3 py-3 text-left font-mono font-normal text-fg-muted">{assignment.column}</th>
                            <td className="whitespace-pre-wrap break-all px-3 py-3 font-mono text-fg">
                              {diff.prefix}<span className={old ? "rounded-sm bg-danger/10 text-danger" : "text-fg-subtle"}>{diff.removed}</span>{diff.suffix}
                            </td>
                            <td className="whitespace-pre-wrap break-all px-3 py-3 font-mono text-fg">
                              {diff.prefix}<span className={next ? "rounded-sm bg-success/12 text-success" : "text-fg-subtle"}>{diff.added}</span>{diff.suffix}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
            </div>
          ))}
        </div>);
}
