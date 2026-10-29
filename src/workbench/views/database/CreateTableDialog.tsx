import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ComboInput } from "@/components/ui/combo-input";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { databaseApi } from "@/api/ops-api";
import type {
  NewColumn,
  SchemaChange,
  SchemaPreview,
} from "@/api/types/database";
import { toDbError, useDatabaseStore } from "@/stores/database-store";
import {
  columnTypeTemplate,
  findColumnTypePreset,
  MYSQL_COLUMN_TYPE_OPTIONS,
} from "./column-types";

export interface CreateTableTarget {
  profileId: string;
  database: string;
}

interface DraftColumn extends NewColumn {
  primary: boolean;
}

const emptyColumn = (index: number): DraftColumn => ({
  name: index === 0 ? "id" : `column_${index + 1}`,
  column_type: index === 0 ? "BIGINT" : "VARCHAR(255)",
  nullable: index !== 0,
  auto_increment: index === 0,
  default_value: null,
  comment: "",
  primary: index === 0,
});

export function CreateTableDialog({
  target,
  sessionId,
  onClose,
  onApplied,
}: {
  target: CreateTableTarget | null;
  sessionId: string | null;
  onClose: () => void;
  onApplied: (table: string) => void;
}) {
  const { t } = useTranslation();
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState<DraftColumn[]>([emptyColumn(0)]);
  const [engine, setEngine] = useState("InnoDB");
  const [charset, setCharset] = useState("utf8mb4");
  const [preview, setPreview] = useState<SchemaPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTables = useDatabaseStore((state) => state.refreshTables);

  useEffect(() => {
    if (!target) return;
    setTable("");
    setColumns([emptyColumn(0)]);
    setEngine("InnoDB");
    setCharset("utf8mb4");
    setPreview(null);
    setError(null);
  }, [target]);

  const change = useMemo<SchemaChange | null>(() => {
    if (!target) return null;
    return {
      action: "create_table",
      database: target.database,
      table: table.trim(),
      columns: columns.map((column) => ({
        name: column.name.trim(),
        column_type: column.column_type.trim(),
        nullable: column.nullable,
        auto_increment: column.auto_increment,
        default_value: column.default_value?.trim() || null,
        comment: column.comment.trim(),
      })),
      primary_key: columns
        .filter((column) => column.primary)
        .map((column) => column.name.trim()),
      engine: engine.trim() || null,
      charset: charset.trim() || null,
      collation: null,
    };
  }, [charset, columns, engine, table, target]);

  const patch = (index: number, patchValue: Partial<DraftColumn>) => {
    setColumns((current) =>
      current.map((column, columnIndex) =>
        columnIndex === index ? { ...column, ...patchValue } : column,
      ),
    );
    setPreview(null);
  };

  const loadPreview = async () => {
    if (!change || change.action !== "create_table") return;
    if (!change.table) {
      setError(t("请输入表名"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPreview(await databaseApi.previewSchemaChange(change));
    } catch (failure) {
      setError(toDbError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!change || change.action !== "create_table" || !sessionId) {
      setError(t("连接尚未建立，无法执行 schema 修改"));
      return;
    }
    if (!preview) {
      setError(t("请先预览 DDL"));
      return;
    }
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await databaseApi.applySchemaChange(sessionId, change, preview.sql);
      await refreshTables(target.profileId, target.database);
      onApplied(change.table);
      onClose();
    } catch (failure) {
      setError(toDbError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  if (!target) return null;

  return (
    <Modal
      open
      title={t("新建表")}
      description={t("字段、主键和基础表选项；执行前先预览后端生成的 DDL。")}
      width={760}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t("取消")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void loadPreview()} disabled={busy}>
            {t("预览 DDL")}
          </Button>
          <Button variant="danger" size="sm" onClick={() => void apply()} disabled={busy || !preview}>
            {t("执行")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-12 text-fg-muted">
        <div className="grid grid-cols-3 gap-2">
          <Field label={t("表名")}>
            <input
              autoFocus
              className={fieldClass}
              value={table}
              onChange={(event) => {
                setTable(event.target.value);
                setPreview(null);
              }}
              placeholder="orders"
            />
          </Field>
          <Field label={t("引擎")}>
            <input className={fieldClass} value={engine} onChange={(event) => setEngine(event.target.value)} />
          </Field>
          <Field label={t("字符集")}>
            <input className={fieldClass} value={charset} onChange={(event) => setCharset(event.target.value)} />
          </Field>
        </div>

        <div className="overflow-hidden rounded-[6px] border border-line">
          <div className="grid grid-cols-[1.2fr_1.2fr_58px_58px_58px_1fr_28px] gap-1 border-b border-line bg-surface-2 px-2 py-1 text-11 text-fg-subtle">
            <span>{t("字段")}</span>
            <span>{t("类型")}</span>
            <span>{t("NULL")}</span>
            <span>{t("自增")}</span>
            <span>{t("主键")}</span>
            <span>{t("默认值")}</span>
            <span />
          </div>
          {columns.map((column, index) => (
            <div
              key={index}
              className="grid grid-cols-[1.2fr_1.2fr_58px_58px_58px_1fr_28px] items-center gap-1 border-b border-line/60 px-2 py-1 last:border-b-0"
            >
              <input className={fieldClass} value={column.name} onChange={(event) => patch(index, { name: event.target.value })} />
              <ComboInput
                value={column.column_type}
                options={MYSQL_COLUMN_TYPE_OPTIONS}
                placeholder={t("类型")}
                ariaLabel={t("类型")}
                onChange={(next) => patch(index, { column_type: next })}
                onPick={(option) => {
                  const preset = findColumnTypePreset(option.value);
                  patch(index, {
                    column_type: preset ? columnTypeTemplate(preset) : option.value,
                  });
                }}
              />
              <input type="checkbox" checked={column.nullable} onChange={(event) => patch(index, { nullable: event.target.checked })} />
              <input type="checkbox" checked={column.auto_increment} onChange={(event) => patch(index, { auto_increment: event.target.checked })} />
              <input type="checkbox" checked={column.primary} onChange={(event) => patch(index, { primary: event.target.checked })} />
              <input className={fieldClass} value={column.default_value ?? ""} onChange={(event) => patch(index, { default_value: event.target.value })} />
              <Button
                variant="ghost"
                size="xs"
                className="h-5 w-5 px-0"
                aria-label={t("删除字段")}
                onClick={() => {
                  setColumns((current) => current.filter((_, i) => i !== index));
                  setPreview(null);
                }}
                disabled={columns.length === 1}
              >
                <Trash2 size={11} />
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          onClick={() => setColumns((current) => [...current, emptyColumn(current.length)])}
        >
          <Plus size={12} />
          {t("添加字段")}
        </Button>

        {preview?.warning && <p className="text-warning">{preview.warning}</p>}
        {preview && (
          <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-[6px] border border-line bg-surface-2 p-2 font-mono text-11 text-fg">
            {preview.sql}
          </pre>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Modal>
  );
}
