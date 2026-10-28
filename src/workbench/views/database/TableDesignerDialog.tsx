import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorText, Modal, fieldClass } from "@/components/ui/modal";
import { databaseApi } from "@/api/ops-api";
import type {
  AlterTableRequest,
  ColumnEdit,
  DbTableDetail,
  IndexEdit,
  SchemaPreview,
} from "@/api/types/database";
import { toDbError, useDatabaseStore } from "@/stores/database-store";

interface DraftColumn extends ColumnEdit {
  key: string;
  primary: boolean;
}

interface DraftIndex extends IndexEdit {
  key: string;
}

function extractDefault(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function TableDesignerDialog({
  target,
  detail,
  sessionId,
  onClose,
  onSaved,
}: {
  target: { profileId: string; database: string; table: string } | null;
  detail: DbTableDetail | null;
  sessionId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [columns, setColumns] = useState<DraftColumn[]>([]);
  const [indexes, setIndexes] = useState<DraftIndex[]>([]);
  const [preview, setPreview] = useState<SchemaPreview | null>(null);
  const [pending, setPending] = useState<AlterTableRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);

  useEffect(() => {
    if (!target || !detail) return;
    setColumns(
      detail.columns.map((column) => ({
        key: column.name,
        original_name: column.name,
        name: column.name,
        column_type: column.column_type,
        nullable: column.nullable,
        auto_increment: column.auto_increment,
        default_value: column.default_value,
        comment: column.comment,
        primary: column.primary_key,
      })),
    );
    setIndexes(
      detail.indexes
        .filter((index) => !index.primary)
        .map((index) => ({
          key: index.name,
          original_name: index.name,
          name: index.name,
          columns: index.columns.map((column) => column.name),
          unique: index.unique,
        })),
    );
    setPreview(null);
    setPending(null);
    setError(null);
  }, [detail, target]);

  const request = useMemo<AlterTableRequest | null>(() => {
    if (!target) return null;
    return {
      database: target.database,
      table: target.table,
      columns: columns.map(({ primary: _primary, key: _key, ...column }) => column),
      indexes: indexes.map(({ key: _key, ...index }) => ({
        ...index,
        columns: index.columns.filter(Boolean),
      })),
    };
  }, [columns, indexes, target]);

  const patchColumn = (key: string, patch: Partial<DraftColumn>) => {
    setColumns((current) =>
      current.map((column) =>
        column.key === key ? { ...column, ...patch } : column,
      ),
    );
    setPreview(null);
  };

  const patchIndex = (key: string, patch: Partial<DraftIndex>) => {
    setIndexes((current) =>
      current.map((index) => (index.key === key ? { ...index, ...patch } : index)),
    );
    setPreview(null);
  };

  const runPreview = async (): Promise<SchemaPreview | null> => {
    if (!request || !sessionId) {
      setError(t("连接尚未建立，无法预览 DDL"));
      return null;
    }
    const result = await databaseApi.previewTableSchema(sessionId, request);
    setPreview(result);
    return result;
  };

  const apply = async (value: AlterTableRequest) => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await databaseApi.applyTableSchema(sessionId, value);
      await refreshTableDetail(
        target?.profileId ?? "",
        value.database,
        value.table,
      );
      onSaved();
      onClose();
    } catch (failure) {
      setError(toDbError(failure).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const save = async () => {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runPreview();
      if (!result) return;
      if (result.destructive) {
        setPending(request);
        setBusy(false);
        return;
      }
      await apply(request);
    } catch (failure) {
      setError(toDbError(failure).message);
      setBusy(false);
    }
  };

  if (!target || !detail) return null;

  return (
    <>
      <Modal
        open
        title={t("设计表：{{name}}", { name: target.table })}
        description={t("直接修改字段/索引，Ctrl+S 保存；删除字段或索引会先二次确认。")}
        width={980}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              {t("取消")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void runPreview().catch((failure) => setError(toDbError(failure).message))}
              disabled={busy}
            >
              {t("预览 DDL")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
              {t("保存")}
            </Button>
          </>
        }
      >
        <div
          className="flex flex-col gap-4 text-12 text-fg-muted"
          onKeyDownCapture={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save();
            }
          }}
        >
          <section>
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-12 font-medium text-fg">{t("字段")}</h3>
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  setColumns((current) => [
                    ...current,
                    {
                      key: `new-${crypto.randomUUID()}`,
                      original_name: null,
                      name: "",
                      column_type: "VARCHAR(255)",
                      nullable: true,
                      auto_increment: false,
                      default_value: null,
                      comment: "",
                      primary: false,
                    },
                  ])
                }
              >
                <Plus size={11} />
                {t("添加字段")}
              </Button>
            </div>
            <div className="overflow-x-auto rounded-[6px] border border-line">
              <div className="min-w-[840px]">
                <div className="grid grid-cols-[1.2fr_1.2fr_52px_52px_1fr_1fr_28px] gap-1 border-b border-line bg-surface-2 px-2 py-1 text-11 text-fg-subtle">
                  <span>{t("字段")}</span>
                  <span>{t("类型")}</span>
                  <span>NULL</span>
                  <span>{t("自增")}</span>
                  <span>{t("默认值")}</span>
                  <span>{t("注释")}</span>
                  <span />
                </div>
                {columns.map((column) => (
                  <div
                    key={column.key}
                    className="grid grid-cols-[1.2fr_1.2fr_52px_52px_1fr_1fr_28px] items-center gap-1 border-b border-line/60 px-2 py-1 last:border-b-0"
                  >
                    <input
                      className={fieldClass}
                      value={column.name}
                      onChange={(event) => patchColumn(column.key, { name: event.target.value })}
                    />
                    <input
                      className={fieldClass}
                      value={column.column_type}
                      onChange={(event) =>
                        patchColumn(column.key, { column_type: event.target.value })
                      }
                    />
                    <input
                      type="checkbox"
                      checked={column.nullable}
                      onChange={(event) =>
                        patchColumn(column.key, { nullable: event.target.checked })
                      }
                    />
                    <input
                      type="checkbox"
                      checked={column.auto_increment}
                      disabled={column.primary}
                      onChange={(event) =>
                        patchColumn(column.key, { auto_increment: event.target.checked })
                      }
                    />
                    <input
                      className={fieldClass}
                      value={column.default_value ?? ""}
                      onChange={(event) =>
                        patchColumn(column.key, {
                          default_value: extractDefault(event.target.value),
                        })
                      }
                    />
                    <input
                      className={fieldClass}
                      value={column.comment}
                      onChange={(event) =>
                        patchColumn(column.key, { comment: event.target.value })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-5 w-5 px-0"
                      aria-label={t("删除字段")}
                      disabled={column.primary || columns.length === 1}
                      onClick={() =>
                        setColumns((current) =>
                          current.filter((entry) => entry.key !== column.key),
                        )
                      }
                    >
                      <Trash2 size={11} />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section>
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-12 font-medium text-fg">{t("索引")}</h3>
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  setIndexes((current) => [
                    ...current,
                    {
                      key: `new-${crypto.randomUUID()}`,
                      original_name: null,
                      name: "",
                      columns: [],
                      unique: false,
                    },
                  ])
                }
              >
                <Plus size={11} />
                {t("添加索引")}
              </Button>
            </div>
            <div className="overflow-hidden rounded-[6px] border border-line">
              {indexes.length === 0 ? (
                <p className="px-2 py-2 text-11 text-fg-subtle">{t("没有索引")}</p>
              ) : (
                indexes.map((index) => (
                  <div
                    key={index.key}
                    className="grid grid-cols-[1fr_1.6fr_60px_28px] items-center gap-1 border-b border-line/60 px-2 py-1 last:border-b-0"
                  >
                    <input
                      className={fieldClass}
                      value={index.name}
                      placeholder={t("索引名")}
                      onChange={(event) => patchIndex(index.key, { name: event.target.value })}
                    />
                    <input
                      className={fieldClass}
                      value={index.columns.join(", ")}
                      placeholder={t("字段，用逗号分隔")}
                      onChange={(event) =>
                        patchIndex(index.key, {
                          columns: event.target.value
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                    <label className="flex items-center gap-1 text-11">
                      <input
                        type="checkbox"
                        checked={index.unique}
                        onChange={(event) =>
                          patchIndex(index.key, { unique: event.target.checked })
                        }
                      />
                      UNIQUE
                    </label>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-5 w-5 px-0"
                      aria-label={t("删除索引")}
                      onClick={() =>
                        setIndexes((current) =>
                          current.filter((entry) => entry.key !== index.key),
                        )
                      }
                    >
                      <Trash2 size={11} />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </section>

          {preview && (
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-[6px] border border-line bg-surface-2 p-2 font-mono text-11 text-fg">
              {preview.sql}
            </pre>
          )}
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        danger
        title={t("保存表结构修改？")}
        description={
          preview?.sql ??
          t("修改包含删除字段或索引，无法撤销；请确认 DDL 后继续。")
        }
        confirmLabel={t("保存")}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) void apply(pending);
        }}
      />
    </>
  );
}
