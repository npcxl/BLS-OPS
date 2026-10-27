/**
 * 单行编辑/新增。
 *
 * 每个字段都是三态：**具体值 / NULL / DEFAULT**。这三者在 SQL 里完全不同，
 * 用一个空输入框表示"NULL"或"DEFAULT"都会造成数据错误，所以必须显式选择。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, fieldClass, selectClass } from "@/components/ui/modal";
import type {
  AssignValue,
  ColumnAssignment,
  DbTableDetail,
  DbValue,
} from "@/api/types/database";

function rawText(value: DbValue): string {
  switch (value.kind) {
    case "null":
      return "";
    case "int":
    case "decimal":
      return value.value;
    case "float":
      return String(value.value);
    case "text":
    case "json":
    case "date":
    case "date_time":
    case "time":
      return value.value;
    case "bit":
      return value.value;
    case "binary":
      return value.base64;
    case "unsupported":
      return value.preview;
  }
}

function fromValue(value: DbValue): AssignValue {
  if (value.kind === "null") return { kind: "null" };
  return { kind: "value", value: rawText(value) };
}

function sameValue(a: AssignValue, b: AssignValue): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "value" && b.kind === "value") return a.value === b.value;
  return true;
}

/** 稳定引用：否则每次 render 都生成新数组，`useMemo`/`useEffect` 会反复重置输入。 */
const EMPTY_COLUMNS: DbTableDetail["columns"] = [];

export function EditRowDialog({
  open,
  mode,
  detail,
  row,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "insert" | "update";
  /** 表结构可能还没加载完：`null` 时对话框只显示"加载中"，绝不读 undefined。 */
  detail: DbTableDetail | null;
  /** update：当前行的值，顺序与 `detail.columns` 一致。 */
  row: DbValue[] | null;
  onClose: () => void;
  onSubmit: (values: ColumnAssignment[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Record<string, AssignValue>>({});
  const [error, setError] = useState<string | null>(null);
  const columns = detail?.columns ?? EMPTY_COLUMNS;

  const initial = useMemo(() => {
    const result: Record<string, AssignValue> = {};
    columns.forEach((column, index) => {
      if (mode === "update" && row) {
        result[column.name] = fromValue(row[index] ?? { kind: "null" });
      } else {
        result[column.name] = { kind: "default" };
      }
    });
    return result;
  }, [columns, mode, row]);

  useEffect(() => {
    if (open) {
      setDraft(initial);
      setError(null);
    }
  }, [open, initial]);

  const submit = () => {
    const assignments: ColumnAssignment[] = [];
    for (const column of columns) {
      const value = draft[column.name] ?? { kind: "default" as const };
      if (mode === "update") {
        if (column.primary_key) continue;
        if (sameValue(value, initial[column.name])) continue;
        assignments.push({ column: column.name, value });
      } else if (value.kind !== "default") {
        assignments.push({ column: column.name, value });
      }
    }
    if (assignments.length === 0) {
      setError(
        mode === "update"
          ? t("没有任何字段被修改")
          : t("新增行至少需要填写一个字段（DEFAULT 会被省略）"),
      );
      return;
    }
    onSubmit(assignments);
    onClose();
  };

  return (
    <Modal
      open={open}
      title={mode === "insert" ? t("新增行") : t("编辑行")}
      description={t(
        "修改先暂存，点“提交修改”才会在事务中执行；主键用于定位行，不能在这里改。",
      )}
      width={640}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button variant="primary" size="sm" onClick={submit}>
            {t("加入待提交")}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[56vh] flex-col gap-1 overflow-y-auto">
        {columns.length === 0 && (
          <p className="py-4 text-center text-11 text-fg-subtle">
            {t("表结构还在加载，请稍候…")}
          </p>
        )}
        {columns.map((column) => {
          const value = draft[column.name] ?? { kind: "default" as const };
          const binary = /blob|binary/i.test(column.data_type);
          const locked = mode === "update" && column.primary_key;
          return (
            <div
              key={column.name}
              className="grid grid-cols-[160px_90px_1fr] items-center gap-2 rounded-[6px] px-1 py-0.5 hover:bg-surface-hover/60"
            >
              <div className="flex min-w-0 items-center gap-1">
                {locked && <Lock size={10} className="shrink-0 text-fg-subtle" />}
                <span className="truncate font-mono text-11 text-fg" title={column.column_type}>
                  {column.name}
                </span>
                {column.primary_key && (
                  <span className="rounded bg-accent/15 px-1 text-[9px] text-accent">PK</span>
                )}
              </div>
              <select
                className={selectClass}
                value={value.kind}
                disabled={locked}
                onChange={(event) => {
                  const kind = event.target.value as AssignValue["kind"];
                  setDraft((current) => ({
                    ...current,
                    [column.name]: kind === "value" ? { kind: "value", value: "" } : { kind },
                  }));
                }}
              >
                <option value="value">{t("值")}</option>
                <option value="null">NULL</option>
                <option value="default">DEFAULT</option>
              </select>
              <input
                className={fieldClass}
                disabled={locked || value.kind !== "value" || binary}
                value={value.kind === "value" ? value.value : ""}
                placeholder={
                  locked
                    ? t("主键不可修改")
                    : binary
                      ? t("二进制列请在 SQL 中处理")
                      : value.kind === "null"
                        ? "NULL"
                        : value.kind === "default"
                          ? "DEFAULT"
                          : ""
                }
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [column.name]: { kind: "value", value: event.target.value },
                  }))
                }
              />
            </div>
          );
        })}
      </div>
      {error && <p className="mt-2 text-11 text-danger">{error}</p>}
    </Modal>
  );
}
