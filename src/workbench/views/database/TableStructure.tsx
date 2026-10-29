/** 表结构：字段（类型 / NULL / 默认值 / 主键 / 自增）、索引、表定义。
 *
 * 点击字段表或「编辑结构」进入内联编辑；Ctrl+S 保存，删除字段/索引会二次确认。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ClipboardCopy,
  Copy,
  Eye,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "@/components/icons";
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
import {
  ContextMenu,
  useContextMenu,
  type ContextMenuItem,
} from "@/components/ui/context-menu";
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

/** 草稿指纹：只比"会写进 DDL 的字段"，用来判断有没有未保存的修改。 */
const draftSignature = (columns: DraftColumn[], indexes: DraftIndex[]) =>
  JSON.stringify({
    columns: columns.map((column) => [
      column.original_name,
      column.name,
      composeColumnType(column),
      column.nullable,
      column.auto_increment,
      column.primary,
      column.default_value,
      column.comment,
    ]),
    indexes: indexes.map((index) => [
      index.original_name,
      index.name,
      index.columns,
      index.unique,
    ]),
  });

export function TableStructure({
  detail,
  loading,
  section = "all",
  selectedColumn = null,
  onSelectColumn,
  profileId,
  sessionId,
  title,
  refreshing = false,
  onRefresh,
  onClose,
}: {
  detail: DbTableDetail | null;
  loading: boolean;
  section?: StructureSection;
  /** 结构工作项点击字段 → 右侧字段卡片。 */
  selectedColumn?: string | null;
  onSelectColumn?: (column: DbTableColumn) => void;
  profileId?: string;
  sessionId?: string | null;
  /** 下面四个只给结构工作项：单行头部右侧的表名 / 刷新 / 关闭。 */
  title?: string;
  refreshing?: boolean;
  onRefresh?: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  // `section="all"`（结构工作项）时页签自己管；固定 section（表数据页的
  // 结构/索引/DDL 子视图）由父组件决定显示哪一块，这里不出页签。
  const [tab, setTab] = useState<StructureTab>(section === "all" ? "columns" : section);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  // Navicat 式底部属性抽屉：选中某行才出现，可手动关掉。
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fieldClipboard, setFieldClipboard] = useState<DraftColumn[]>([]);
  const menu = useContextMenu();
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
  // 没有实际改动时「保存 / 撤销」置灰，避免点了什么也没发生。
  const baseline = fromDetail(detail);
  const dirty =
    editing &&
    draftSignature(columns, indexes) !== draftSignature(baseline.columns, baseline.indexes);
  const selectedDraft = columns.find((column) => column.key === selectedKey) ?? null;

  const startEditing = () => {
    if (!editable) return;
    const draft = fromDetail(detail);
    setColumns(draft.columns);
    setIndexes(draft.indexes);
    setEditing(true);
    setError(null);
  };

  const resetDraft = () => {
    const draft = fromDetail(detail);
    setColumns(draft.columns);
    setIndexes(draft.indexes);
    setPreview(null);
    setError(null);
  };

  const blankColumn = (): DraftColumn => ({
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
  });

  /** 不传 `after` 就追加到末尾。 */
  const addColumn = (after?: number) => {
    setColumns((current) => {
      const next = [...current];
      next.splice(after === undefined ? next.length : after + 1, 0, blankColumn());
      return next;
    });
  };

  const removeColumn = (key: string) => {
    setColumns((current) => current.filter((column) => column.key !== key));
  };

  const moveColumn = (index: number, delta: number) => {
    setColumns((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  /** 复制/粘贴：插到 `after` 后面，作为**新字段**（不带原字段名绑定）。 */
  const insertCopies = (after: number, sources: DraftColumn[]) => {
    setColumns((current) => {
      const next = [...current];
      next.splice(
        after + 1,
        0,
        ...sources.map((column) => ({
          ...column,
          key: `new:${crypto.randomUUID()}`,
          original_name: null,
          name: `${column.name || "column"}_copy`,
          primary: false,
        })),
      );
      return next;
    });
  };

  const columnMenuItems = (column: DraftColumn, index: number): ContextMenuItem[] => [
    {
      id: "copy",
      label: t("复制"),
      icon: Copy,
      onSelect: () => setFieldClipboard([column]),
    },
    {
      id: "paste",
      label: t("粘贴"),
      icon: ClipboardCopy,
      disabled: fieldClipboard.length === 0,
      onSelect: () => insertCopies(index, fieldClipboard),
    },
    {
      id: "delete",
      label: t("删除"),
      icon: Trash2,
      danger: true,
      disabled: column.primary || columns.length === 1,
      onSelect: () => removeColumn(column.key),
    },
    { separator: true },
    {
      id: "move-up",
      label: t("上移"),
      disabled: index === 0,
      onSelect: () => moveColumn(index, -1),
    },
    {
      id: "move-down",
      label: t("下移"),
      disabled: index === columns.length - 1,
      onSelect: () => moveColumn(index, 1),
    },
    { separator: true },
    {
      id: "add",
      label: t("添加字段"),
      icon: Plus,
      onSelect: () => addColumn(index),
    },
    {
      id: "duplicate",
      label: t("复制字段"),
      onSelect: () => insertCopies(index, [column]),
    },
    { separator: true },
    column.primary
      ? {
          id: "drop-primary",
          label: t("从主键中删除"),
          onSelect: () => patchColumn(column.key, { primary: false }),
        }
      : {
          id: "add-primary",
          label: t("添加到主键"),
          hint: column.nullable ? t("会自动设为 NOT NULL") : undefined,
          onSelect: () => patchColumn(column.key, { primary: true, nullable: false }),
        },
  ];

  const request = useMemo<AlterTableRequest | null>(() => {
    if (!editing || !detail || !profileId) return null;
    const marked = columns.filter((column) => column.primary);
    // 主键成员没变时保持库里原来的列序，避免"只是挪了字段顺序"也被当成重建主键。
    const unchanged =
      marked.length === detail.primary_key.length &&
      marked.every((column) =>
        detail.primary_key.some((key) => key.toLowerCase() === column.name.toLowerCase()),
      );
    const primaryKey = unchanged
      ? detail.primary_key.map(
          (key) =>
            marked.find((column) => column.name.toLowerCase() === key.toLowerCase())?.name ??
            key,
        )
      : marked.map((column) => column.name);
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
      primary_key: primaryKey,
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
      await databaseApi.applyTableSchema(sessionId, value, preview?.sql ?? "");
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
    if (!sessionId || !request || !dirty) return;
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
      className="flex h-full flex-col"
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
      {/* 固定单行头部：操作 / 页签 / 字段数 / 表名 + 刷新 + 关闭。 */}
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
        {editing ? (
          <>
            <Button
              variant="secondary"
              size="xs"
              disabled={busy || !dirty}
              onClick={() => void save()}
              title={t("保存结构修改（Ctrl+S）")}
            >
              <Save size={11} />
              {t("保存")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy || !dirty}
              onClick={resetDraft}
              title={t("丢弃未保存的修改")}
            >
              <RotateCcw size={11} />
              {t("撤销")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => addColumn()}
              title={t("添加字段")}
            >
              <Plus size={11} />
              {t("新增")}
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

        {section === "all" && (
          <div
            role="tablist"
            aria-label={t("表结构")}
            className="flex shrink-0 items-center gap-1 border-l border-line pl-2"
          >
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

        {showColumns && (
          <span className="shrink-0 text-11 text-fg-subtle">
            {t("字段（{{count}}）", { count: columns.length || detail.columns.length })}
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {title && (
            <span className="max-w-[200px] truncate text-11 text-fg-subtle">{title}</span>
          )}
          {onRefresh && (
            <Button
              variant="ghost"
              size="xs"
              className="h-6 w-6 px-0"
              disabled={refreshing}
              onClick={onRefresh}
              title={t("刷新结构")}
              aria-label={t("刷新结构")}
            >
              {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="xs"
              className="h-6 w-6 px-0"
              onClick={onClose}
              title={t("关闭")}
              aria-label={t("关闭")}
            >
              <X size={11} />
            </Button>
          )}
        </div>
      </div>

      <div className="ops-scroll min-h-0 flex-1 overflow-auto p-2">
      {showColumns && (
        <section>
          <div className="overflow-x-auto rounded-[8px] border border-line">
            {/* 固定列宽：切换页签 / 进出编辑时列不会跳动。 */}
            <table className="w-full min-w-[760px] table-fixed border-collapse text-12">
              <colgroup>
                <col className="w-[160px]" />
                <col className="w-[136px]" />
                <col className="w-[72px]" />
                <col className="w-[64px]" />
                <col className="w-[64px]" />
                <col className="w-[52px]" />
                <col className="w-[52px]" />
                <col />
                {/* 编辑态：默认值/自增在底部抽屉里；只读态才放到表格里。 */}
                {!editing && <col className="w-[130px]" />}
                {!editing && <col className="w-[56px]" />}
              </colgroup>
              <thead className="sticky top-0 z-10 bg-surface-2 text-fg-subtle">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">{t("名称")}</th>
                  <th className="px-2 py-1 text-left font-medium">{t("类型")}</th>
                  <th className="px-2 py-1 text-left font-medium">{t("长度")}</th>
                  <th className="px-2 py-1 text-left font-medium">{t("小数点")}</th>
                  <th className="px-2 py-1 text-center font-medium">{t("不是 null")}</th>
                  <th className="px-2 py-1 text-center font-medium">{t("虚拟")}</th>
                  <th className="px-2 py-1 text-center font-medium">{t("键")}</th>
                  <th className="px-2 py-1 text-left font-medium">{t("注释")}</th>
                  {!editing && <th className="px-2 py-1 text-left font-medium">{t("默认值")}</th>}
                  {!editing && <th className="px-2 py-1 text-center font-medium">{t("自增")}</th>}
                </tr>
              </thead>
              <tbody>
                {(editing ? columns : detail.columns).map((column, index) => {
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
                        drawerOpen && selectedKey === draft?.key && "bg-accent/10",
                      )}
                      onClick={() => {
                        if (draft) {
                          setFocusedKey(draft.key);
                          setSelectedKey(draft.key);
                          setDrawerOpen(true);
                        }
                        if (!editing && editable) startEditing();
                        else if (!editing) onSelectColumn?.(column as DbTableColumn);
                      }}
                      onContextMenu={
                        draft
                          ? menu.onContextMenu(() => {
                              setFocusedKey(draft.key);
                              setSelectedKey(draft.key);
                              setDrawerOpen(true);
                              return columnMenuItems(draft, index);
                            })
                          : undefined
                      }
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
                          // 注释可能很长：输入框内滚动，右侧眼睛 hover 出全文（title）。
                          <div className="flex items-center gap-1">
                            <input
                              className="min-w-0 flex-1 rounded border border-line bg-surface-2 px-1 py-0.5 text-11 text-fg outline-none focus:border-accent"
                              value={draft.comment}
                              title={draft.comment || undefined}
                              onChange={(event) =>
                                patchColumn(draft.key, { comment: event.target.value })
                              }
                              onFocus={() => setFocusedKey(draft.key)}
                            />
                            {draft.comment.trim().length > 8 && (
                              <span
                                className="shrink-0 cursor-default text-fg-subtle"
                                title={draft.comment}
                              >
                                <Eye size={11} />
                              </span>
                            )}
                          </div>
                        ) : (
                          <span
                            className="block truncate"
                            title={(column as DbTableColumn).comment || undefined}
                          >
                            {(column as DbTableColumn).comment}
                          </span>
                        )}
                      </td>
                      {!editing && (
                        <>
                          <td className="px-2 py-1 font-mono text-11 text-fg-muted">
                            {(column as DbTableColumn).default_value === null
                              ? "NULL"
                              : (column as DbTableColumn).default_value}
                          </td>
                          <td className="px-2 py-1 text-center text-11 text-fg-muted">
                            {(column as DbTableColumn).auto_increment ? "AUTO" : ""}
                          </td>
                        </>
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
          <div
            className={cn(
              "mb-1 flex items-center gap-2",
              // 页签已经写着“索引”，只有作为固定子视图时才需要标题。
              section === "all" ? "justify-end" : "justify-between",
            )}
          >
            {section !== "all" && (
              <h3 className="text-12 font-medium text-fg">{t("索引")}</h3>
            )}
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

      {showForeign && (
        <section>
          {foreignKeys.length > 0 ? (
            <div className="overflow-x-auto rounded-[8px] border border-line">
              <table className="w-full min-w-[680px] border-collapse text-12">
                <thead className="bg-surface-2 text-fg-subtle">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">{t("名称")}</th>
                    <th className="px-2 py-1 text-left font-medium">{t("字段")}</th>
                    <th className="px-2 py-1 text-left font-medium">{t("参考表")}</th>
                    <th className="px-2 py-1 text-left font-medium">{t("参考字段")}</th>
                    <th className="px-2 py-1 text-left font-medium">{t("删除时")}</th>
                    <th className="px-2 py-1 text-left font-medium">{t("更新时")}</th>
                  </tr>
                </thead>
                <tbody>
                  {foreignKeys.map((key, index) => (
                    <tr
                      key={`${key.name || "fk"}-${index}`}
                      className="border-t border-line/60"
                    >
                      <td className="px-2 py-1 font-mono text-fg">
                        {key.name || <span className="text-fg-subtle">—</span>}
                      </td>
                      <td className="px-2 py-1 font-mono text-fg-muted">
                        {key.columns.join(", ")}
                      </td>
                      <td className="px-2 py-1 font-mono text-fg-muted">{key.refTable}</td>
                      <td className="px-2 py-1 font-mono text-fg-muted">
                        {key.refColumns.join(", ")}
                      </td>
                      <td className="px-2 py-1 text-fg-subtle">{key.onDelete ?? "—"}</td>
                      <td className="px-2 py-1 text-fg-subtle">{key.onUpdate ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-12 text-fg-subtle">
              {detail.create_sql ? t("没有外键") : t("没有可用的建表语句，无法解析外键")}
            </p>
          )}
          <p className="mt-1 text-11 text-fg-subtle">
            {t("外键来自建表语句解析，只读；新建或修改外键请在 SQL 中执行。")}
          </p>
        </section>
      )}

      {showDdl && (
        <section>
          {section !== "all" && (
            <h3 className="mb-1 text-12 font-medium text-fg">{t("表定义")}</h3>
          )}
          {detail.create_sql ? (
            <pre className="ops-scroll max-h-[52vh] overflow-auto whitespace-pre-wrap rounded-[8px] border border-line bg-surface-2/50 p-2 font-mono text-11 text-fg-muted">
              {detail.create_sql}
            </pre>
          ) : (
            <p className="text-12 text-fg-subtle">{t("没有可用的建表语句")}</p>
          )}
        </section>
      )}

      {preview?.warning && (
        <p className="mt-2 text-11 text-warning">{preview.warning}</p>
      )}
      {preview && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[6px] border border-line bg-surface-2 p-2 font-mono text-11 text-fg">
          {preview.sql}
        </pre>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      </div>

      {/* 底部属性抽屉：选中某行才出现，默认值 / 自增这些长尾选项放这里。 */}
      {showColumns && editing && drawerOpen && selectedDraft && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-surface-2/40 px-2 py-1.5 text-11">
          <span className="flex min-w-0 items-center gap-1 text-fg-muted">
            <KeyRound size={11} className="shrink-0 text-fg-subtle" />
            <span className="max-w-[180px] truncate font-mono text-fg">
              {selectedDraft.name || t("未命名字段")}
            </span>
            <span className="shrink-0 font-mono text-fg-subtle">
              {composeColumnType(selectedDraft) || "—"}
            </span>
          </span>
          <label className="flex items-center gap-1 text-fg-muted">
            {t("默认值")}
            <input
              className="h-6 w-[180px] rounded border border-line bg-surface-2 px-1 font-mono text-11 text-fg outline-none focus:border-accent"
              value={selectedDraft.default_value ?? ""}
              placeholder="NULL"
              onChange={(event) =>
                patchColumn(selectedDraft.key, {
                  default_value: event.target.value || null,
                })
              }
            />
          </label>
          <label className="flex items-center gap-1 text-fg-muted">
            <input
              type="checkbox"
              checked={selectedDraft.auto_increment}
              disabled={selectedDraft.primary}
              onChange={(event) =>
                patchColumn(selectedDraft.key, {
                  auto_increment: event.target.checked,
                })
              }
            />
            {t("自增")}
          </label>
          {selectedDraft.primary && (
            <span className="text-fg-subtle">{t("主键默认自增")}</span>
          )}
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto h-6 w-6 px-0"
            onClick={() => setDrawerOpen(false)}
            aria-label={t("关闭属性面板")}
            title={t("关闭属性面板")}
          >
            <X size={11} />
          </Button>
        </div>
      )}

      <ContextMenu {...menu.props} />

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
