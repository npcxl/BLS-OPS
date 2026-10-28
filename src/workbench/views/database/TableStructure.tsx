/** 表结构：字段（类型 / NULL / 默认值 / 主键 / 自增）、索引、表定义。
 *
 * 点击字段表或「编辑结构」进入内联编辑；Ctrl+S 保存，删除字段/索引会二次确认。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Pencil, Plus, Trash2 } from "@/components/icons";
import type {
  AlterTableRequest,
  ColumnEdit,
  DbTableColumn,
  DbTableDetail,
  IndexEdit,
  SchemaPreview,
} from "@/api/types/database";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ComboInput } from "@/components/ui/combo-input";
import { ErrorText } from "@/components/ui/modal";
import { LoadingState } from "@/components/ui/loading";
import { databaseApi } from "@/api/ops-api";
import { cn } from "@/lib/cn";
import { toDbError, useDatabaseStore } from "@/stores/database-store";
import { findColumnTypePreset, MYSQL_COLUMN_TYPE_OPTIONS } from "./column-types";
import { parseForeignKeys } from "./foreign-keys";

export type StructureSection = "all" | "columns" | "indexes" | "ddl" | "foreign";

/** `section="all"` 时的页签顺序，对齐 Navicat。 */
const STRUCTURE_TABS = [
  ["columns", "表结构"],
  ["indexes", "索引"],
  ["ddl", "DDL"],
  ["foreign", "外键"],
] as const satisfies readonly (readonly [Exclude<StructureSection, "all">, string])[];

type StructureTab = Exclude<StructureSection, "all">;

interface DraftColumn extends ColumnEdit {
  key: string;
  primary: boolean;
  base_type: string;
  length: string;
  scale: string;
}

function parseColumnType(value: string): {
  base: string;
  length: string;
  scale: string;
} {
  const match = value.trim().match(/^([^(]+?)(?:\((\d+)(?:\s*,\s*(\d+))?\))?$/);
  if (!match) return { base: value.trim(), length: "", scale: "" };
  return {
    base: match[1].trim(),
    length: match[2] ?? "",
    scale: match[3] ?? "",
  };
}

function composeColumnType(column: DraftColumn): string {
  const base = column.base_type.trim();
  if (!base) return "";
  if (!column.length.trim()) return base;
  return column.scale.trim()
    ? `${base}(${column.length.trim()},${column.scale.trim()})`
    : `${base}(${column.length.trim()})`;
}

interface DraftIndex extends IndexEdit {
  key: string;
  primary: boolean;
}

const fromDetail = (detail: DbTableDetail) => ({
  columns: detail.columns.map<DraftColumn>((column) => {
    const type = parseColumnType(column.column_type);
    return {
      key: `col:${column.name}`,
      original_name: column.name,
      name: column.name,
      column_type: column.column_type,
      base_type: type.base,
      length: type.length,
      scale: type.scale,
      nullable: column.nullable,
      auto_increment: column.auto_increment,
      default_value: column.default_value,
      comment: column.comment,
      primary: column.primary_key,
    };
  }),
  indexes: detail.indexes
    .filter((index) => !index.primary)
    .map<DraftIndex>((index) => ({
      key: `idx:${index.name}`,
      original_name: index.name,
      name: index.name,
      columns: index.columns.map((column) => column.name),
      unique: index.unique,
      primary: false,
    })),
});

export function TableStructure({
  detail,
  loading,
  section = "all",
  selectedColumn = null,
  onSelectColumn,
  profileId,
  sessionId,
}: {
  detail: DbTableDetail | null;
  loading: boolean;
  section?: StructureSection;
  /** 结构工作项点击字段 → 右侧字段卡片。 */
  selectedColumn?: string | null;
  onSelectColumn?: (column: DbTableColumn) => void;
  profileId?: string;
  sessionId?: string | null;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  // `section="all"`（结构工作项）时页签自己管；固定 section（表数据页的
  // 结构/索引/DDL 子视图）由父组件决定显示哪一块，这里不出页签。
  const [tab, setTab] = useState<StructureTab>(section === "all" ? "columns" : section);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [columns, setColumns] = useState<DraftColumn[]>([]);
  const [indexes, setIndexes] = useState<DraftIndex[]>([]);
  const [preview, setPreview] = useState<SchemaPreview | null>(null);
  const [pending, setPending] = useState<AlterTableRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTableDetail = useDatabaseStore(
    (state) => state.refreshTableDetail,
  );
  const enteredTableRef = useRef<string | null>(null);

  const editable = detail?.kind === "table" && !!profileId && !!sessionId;
  const foreignKeys = useMemo(
    () => parseForeignKeys(detail?.create_sql ?? null),
    [detail?.create_sql],
  );

  // 打开结构页默认进入编辑，不再要求先点“编辑结构”。
  useEffect(() => {
    if (!detail || detail.kind !== "table" || !profileId || !sessionId) return;
    const key = `${profileId}\u0001${detail.database}\u0001${detail.table}`;
    if (enteredTableRef.current === key) return;
    enteredTableRef.current = key;
    const draft = fromDetail(detail);
    setColumns(draft.columns);
    setIndexes(draft.indexes);
    setFocusedKey(draft.columns[0]?.key ?? null);
    setEditing(true);
    setPreview(null);
    setError(null);
  }, [detail, profileId, sessionId]);

  useEffect(() => {
    if (!editing) return;
    setPreview(null);
    setError(null);
  }, [columns, indexes, editing]);

  if (loading && !detail) {
    return <LoadingState className="h-full" />;
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center text-12 text-fg-subtle">
        {t("没有表结构信息")}
      </div>
    );
  }

  const active: StructureTab = section === "all" ? tab : section;
  const showColumns = active === "columns";
  const showIndexes = active === "indexes";
  const showDdl = active === "ddl";
  const showForeign = active === "foreign";
  const showMeta = section === "all" || active === "columns";

  const startEditing = () => {
    if (!editable) return;
    const draft = fromDetail(detail);
    setColumns(draft.columns);
    setIndexes(draft.indexes);
    setEditing(true);
    setError(null);
  };

  const request = useMemo<AlterTableRequest | null>(() => {
    if (!editing || !detail || !profileId) return null;
    return {
      database: detail.database,
      table: detail.table,
      columns: columns.map((column) => ({
        original_name: column.original_name,
        name: column.name,
        column_type: composeColumnType(column),
        nullable: column.nullable,
        auto_increment: column.auto_increment,
        default_value: column.default_value,
        comment: column.comment,
      })),
      indexes: indexes.map(({ key: _key, primary: _primary, ...index }) => ({
        ...index,
        columns: index.columns.filter(Boolean),
      })),
    };
  }, [columns, detail, editing, indexes, profileId]);

  const patchColumn = (key: string, patch: Partial<DraftColumn>) => {
    setColumns((current) =>
      current.map((column) =>
        column.key === key ? { ...column, ...patch } : column,
      ),
    );
  };

  const patchIndex = (key: string, patch: Partial<DraftIndex>) => {
    setIndexes((current) =>
      current.map((index) => (index.key === key ? { ...index, ...patch } : index)),
    );
  };

  const apply = async (value: AlterTableRequest) => {
    if (!sessionId || !profileId) return;
    setBusy(true);
    setError(null);
    try {
      await databaseApi.applyTableSchema(sessionId, value);
      await refreshTableDetail(profileId, value.database, value.table);
      setEditing(false);
      setPending(null);
      setPreview(null);
    } catch (failure) {
      setError(toDbError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!sessionId || !request) return;
    setBusy(true);
    setError(null);
    try {
      const result = await databaseApi.previewTableSchema(sessionId, request);
      setPreview(result);
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

  return (
    <div
      className={cn(
        "ops-scroll h-full p-3",
        editing ? "overflow-auto" : "overflow-y-auto",
      )}
      onKeyDownCapture={(event) => {
        if (
          editing &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <div
        className={cn(
          "mb-2 flex flex-wrap items-center gap-1",
          section === "all" ? "justify-between" : "justify-end",
        )}
      >
        {section === "all" && (
          <div role="tablist" aria-label={t("表结构")} className="flex flex-wrap items-center gap-1">
            {STRUCTURE_TABS.map(([key, label]) => (
              <Button
                key={key}
                role="tab"
                aria-selected={tab === key}
                variant={tab === key ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setTab(key)}
              >
                {t(label)}
              </Button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
        {editing ? (
          <>
            <Button variant="ghost" size="xs" onClick={() => void save()} disabled={busy}>
              {t("保存")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => {
                const draft = fromDetail(detail);
                setColumns(draft.columns);
                setIndexes(draft.indexes);
                setPreview(null);
                setError(null);
              }}
            >
              {t("撤销")}
            </Button>
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => setEditing(false)}>
              {t("取消")}
            </Button>
          </>
        ) : (
          editable && (
            <Button variant="secondary" size="xs" onClick={startEditing}>
              <Pencil size={11} />
              {t("编辑结构")}
            </Button>
          )
        )}
      </div>

      {showColumns && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-11 text-fg-muted">
          <span>
            {t("类型")}: {detail.kind === "view" ? t("视图") : t("表")}
          </span>
          <span>
            {t("引擎")}: {detail.engine ?? "—"}
          </span>
          <span>
            {t("可安全定位")}: {detail.reliable_key ? detail.reliable_key.join(", ") : t("否")}
          </span>
          {editing && <span className="text-accent">{t("编辑中，Ctrl+S 保存")}</span>}
        </div>
      )}

      {showColumns && (
        <section className="mb-4">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-12 font-medium text-fg">
              {t("字段（{{count}}）", { count: columns.length || detail.columns.length })}
            </h3>
            {editing && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  setColumns((current) => [
                    ...current,
                    {
                      key: `new:${crypto.randomUUID()}`,
                      original_name: null,
                      name: "",
                      column_type: "varchar(255)",
                      base_type: "varchar",
                      length: "255",
                      scale: "",
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
            )}
          </div>
          <div className="overflow-x-auto rounded-[8px] border border-line">
            <table className="w-full min-w-[780px] border-collapse text-12">
              <thead className="bg-surface-2 text-fg-subtle">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">{t("名称")}</th>
                  <th className="px-2 py-1 text-left font-medium">{t("类型")}</th>
                  <th className="w-[64px] px-2 py-1 text-left font-medium">{t("长度")}</th>
                  <th className="w-[58px] px-2 py-1 text-left font-medium">{t("小数点")}</th>
                  <th className="w-[70px] px-2 py-1 text-center font-medium">{t("不是 null")}</th>
                  <th className="w-[54px] px-2 py-1 text-center font-medium">{t("虚拟")}</th>
                  <th className="w-[70px] px-2 py-1 text-center font-medium">{t("键")}</th>
                  <th className="px-2 py-1 text-left font-medium">{t("注释")}</th>
                  <th className="w-[110px] px-2 py-1 text-left font-medium">{t("默认值")}</th>
                  <th className="w-[58px] px-2 py-1 text-center font-medium">{t("自增")}</th>
                  {editing && <th className="w-7 px-1" />}
                </tr>
              </thead>
              <tbody>
                {(editing ? columns : detail.columns).map((column) => {
                  const draft = editing ? (column as DraftColumn) : null;
                  const primary = draft ? draft.primary : (column as DbTableColumn).primary_key;
                  return (
                    <tr
                      key={draft?.key ?? (column as DbTableColumn).name}
                      className={cn(
                        "border-t border-line/60",
                        !editing && onSelectColumn && "cursor-text hover:bg-surface-hover",
                        (focusedKey === draft?.key ||
                          selectedColumn ===
                            (draft?.name ?? (column as DbTableColumn).name)) &&
                          "bg-accent/10",
                      )}
                      onClick={() => {
                        if (draft) setFocusedKey(draft.key);
                        if (!editing && editable) startEditing();
                        else if (!editing) onSelectColumn?.(column as DbTableColumn);
                      }}
                    >
                      <td className="px-2 py-1 font-mono text-fg">
                        {draft ? (
                          <input
                            className="w-full min-w-0 rounded border border-line bg-surface-2 px-1 py-0.5 font-mono text-12 text-fg outline-none focus:border-accent"
                            value={draft.name}
                            onChange={(event) => patchColumn(draft.key, { name: event.target.value })}
                            onFocus={() => setFocusedKey(draft.key)}
                          />
                        ) : (
                          <span className="truncate">{(column as DbTableColumn).name}</span>
                        )}
                      </td>
                      <td className="px-2 py-1 font-mono text-fg-muted">
                        {draft ? (
                          // 类型可下拉、也可手写（enum('a','b') 这种列表里给不了）；
                          // 选列表项时把长度/小数点按 Navicat 的默认值一并填好。
                          <span className="block min-w-[104px]" onFocus={() => setFocusedKey(draft.key)}>
                            <ComboInput
                              value={draft.base_type}
                              options={MYSQL_COLUMN_TYPE_OPTIONS}
                              placeholder={t("类型")}
                              ariaLabel={t("类型")}
                              onChange={(next) => patchColumn(draft.key, { base_type: next })}
                              onPick={(option) => {
                                const preset = findColumnTypePreset(option.value);
                                patchColumn(draft.key, {
                                  base_type: option.value,
                                  length: preset?.length ?? "",
                                  scale: preset?.scale ?? "",
                                });
                              }}
                            />
                          </span>
                        ) : (
                          parseColumnType((column as DbTableColumn).column_type).base
                        )}
                      </td>
                      <td className="px-2 py-1 font-mono text-fg-muted">
                        {draft ? (
                          <input
                            className="w-full rounded border border-line bg-surface-2 px-1 py-0.5 font-mono text-12 text-fg outline-none focus:border-accent"
                            value={draft.length}
                            onChange={(event) =>
                              patchColumn(draft.key, { length: event.target.value })
                            }
                            onFocus={() => setFocusedKey(draft.key)}
                          />
                        ) : (
                          parseColumnType((column as DbTableColumn).column_type).length
                        )}
                      </td>
                      <td className="px-2 py-1 font-mono text-fg-muted">
                        {draft ? (
                          <input
                            className="w-full rounded border border-line bg-surface-2 px-1 py-0.5 font-mono text-12 text-fg outline-none focus:border-accent"
                            value={draft.scale}
                            onChange={(event) =>
                              patchColumn(draft.key, { scale: event.target.value })
                            }
                            onFocus={() => setFocusedKey(draft.key)}
                          />
                        ) : (
                          parseColumnType((column as DbTableColumn).column_type).scale
                        )}
                      </td>
                      <td className="px-2 py-1 text-center text-fg-muted">
                        {draft ? (
                          <input
                            type="checkbox"
                            checked={!draft.nullable}
                            onChange={(event) =>
                              patchColumn(draft.key, { nullable: !event.target.checked })
                            }
                          />
                        ) : (
                          <input
                            type="checkbox"
                            checked={!(column as DbTableColumn).nullable}
                            disabled
                          />
                        )}
                      </td>
                      <td className="px-2 py-1 text-center text-fg-subtle">
                        <input
                          type="checkbox"
                          checked={false}
                          disabled
                          title={t("暂不支持虚拟列")}
                        />
                      </td>
                      <td className="px-2 py-1 text-center text-fg-muted">
                        {primary && (
                          <span className="inline-flex items-center gap-0.5 font-mono text-11 text-accent">
                            <KeyRound size={11} />
                            1
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-fg-subtle">
                        {draft ? (
                          <input
                            className="w-full min-w-[100px] rounded border border-line bg-surface-2 px-1 py-0.5 text-11 text-fg outline-none focus:border-accent"
                            value={draft.comment}
                            onChange={(event) =>
                              patchColumn(draft.key, { comment: event.target.value })
                            }
                            onFocus={() => setFocusedKey(draft.key)}
                          />
                        ) : (
                          (column as DbTableColumn).comment
                        )}
                      </td>
                      <td className="max-w-[150px] px-2 py-1 font-mono text-fg-muted">
                        {draft ? (
                          <input
                            className="w-full min-w-[90px] rounded border border-line bg-surface-2 px-1 py-0.5 font-mono text-11 text-fg outline-none focus:border-accent"
                            value={draft.default_value ?? ""}
                            onChange={(event) =>
                              patchColumn(draft.key, {
                                default_value: event.target.value || null,
                              })
                            }
                            onFocus={() => setFocusedKey(draft.key)}
                          />
                        ) : (column as DbTableColumn).default_value === null ? (
                          "NULL"
                        ) : (
                          (column as DbTableColumn).default_value
                        )}
                      </td>
                      <td className="px-2 py-1 text-center">
                        {draft ? (
                          <input
                            type="checkbox"
                            checked={draft.auto_increment}
                            disabled={draft.primary}
                            onChange={(event) =>
                              patchColumn(draft.key, {
                                auto_increment: event.target.checked,
                              })
                            }
                          />
                        ) : (column as DbTableColumn).auto_increment ? (
                          <span className="text-11 text-fg-muted">AUTO</span>
                        ) : null}
                      </td>
                      {editing && (
                        <td className="px-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-5 w-5 px-0"
                            aria-label={t("删除字段")}
                            disabled={!!primary || columns.length === 1}
                            onClick={(event) => {
                              event.stopPropagation();
                              setColumns((current) =>
                                current.filter((entry) => entry.key !== draft!.key),
                              );
                            }}
                          >
                            <Trash2 size={11} />
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {showIndexes && (
        <section className="mb-4">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-12 font-medium text-fg">{t("索引")}</h3>
            {editing && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  setIndexes((current) => [
                    ...current,
                    {
                      key: `new:${crypto.randomUUID()}`,
                      original_name: null,
                      name: "",
                      columns: [],
                      unique: false,
                      primary: false,
                    },
                  ])
                }
              >
                <Plus size={11} />
                {t("添加索引")}
              </Button>
            )}
          </div>
          {!editing && detail.indexes.length === 0 ? (
            <p className="text-12 text-fg-subtle">{t("没有索引")}</p>
          ) : editing ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 rounded-[6px] border border-line px-2 py-1 text-12">
                <span className="font-mono text-fg">PRIMARY</span>
                <span className="text-11 text-fg-subtle">{t("主键索引不可删除")}</span>
              </div>
              {indexes.map((index) => (
                <div
                  key={index.key}
                  className="grid grid-cols-[1fr_1.6fr_60px_28px] items-center gap-2 rounded-[6px] border border-line px-2 py-1"
                >
                  <input
                    className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono text-12 text-fg outline-none focus:border-accent"
                    value={index.name}
                    placeholder={t("索引名")}
                    onChange={(event) => patchIndex(index.key, { name: event.target.value })}
                  />
                  <input
                    className="rounded border border-line bg-surface-2 px-1 py-0.5 font-mono text-12 text-fg outline-none focus:border-accent"
                    value={index.columns.join(", ")}
                    placeholder={t("字段，用逗号分隔")}
                    onChange={(event) =>
                      patchIndex(index.key, {
                        columns: event.target.value.split(",").map((value) => value.trim()).filter(Boolean),
                      })
                    }
                  />
                  <label className="flex items-center gap-1 text-11">
                    <input
                      type="checkbox"
                      checked={index.unique}
                      onChange={(event) => patchIndex(index.key, { unique: event.target.checked })}
                    />
                    UNIQUE
                  </label>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-5 w-5 px-0"
                    aria-label={t("删除索引")}
                    onClick={() => setIndexes((current) => current.filter((entry) => entry.key !== index.key))}
                  >
                    <Trash2 size={11} />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {detail.indexes.map((index) => (
                <div
                  key={index.name}
                  className={cn(
                    "flex flex-wrap items-center gap-2 rounded-[6px] border border-line px-2 py-1 text-12",
                    index.primary && "border-accent/30 bg-accent/5",
                  )}
                >
                  <span className="font-mono text-fg">{index.name}</span>
                  {index.primary && (
                    <span className="rounded bg-accent/15 px-1 text-10 text-accent">PRIMARY</span>
                  )}
                  {index.unique && !index.primary && (
                    <span className="rounded bg-surface-2 px-1 text-10 text-fg-subtle">UNIQUE</span>
                  )}
                  <span className="text-11 text-fg-subtle">{index.kind}</span>
                  <span className="font-mono text-11 text-fg-muted">
                    ({index.columns
                      .map(
                        (column) =>
                          `${column.name}${column.sub_part ? `(${column.sub_part})` : ""}${
                            column.direction === "desc" ? " DESC" : ""
                          }`,
                      )
                      .join(", ")})
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {showDdl && (
        <section>
          <h3 className="mb-1 text-12 font-medium text-fg">{t("表定义")}</h3>
          {detail.create_sql ? (
            <pre className="ops-scroll max-h-[52vh] overflow-auto whitespace-pre-wrap rounded-[8px] border border-line bg-surface-2/50 p-2 font-mono text-11 text-fg-muted">
              {detail.create_sql}
            </pre>
          ) : (
            <p className="text-12 text-fg-subtle">{t("没有可用的建表语句")}</p>
          )}
        </section>
      )}

      {preview && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[6px] border border-line bg-surface-2 p-2 font-mono text-11 text-fg">
          {preview.sql}
        </pre>
      )}
      {error && <ErrorText>{error}</ErrorText>}

      <ConfirmDialog
        open={pending !== null}
        danger
        title={t("保存表结构修改？")}
        description={preview?.sql ?? t("修改包含删除字段或索引，无法撤销；请确认 DDL 后继续。")}
        confirmLabel={t("保存")}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) void apply(pending);
        }}
      />
    </div>
  );
}
