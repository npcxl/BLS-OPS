/**
 * 表数据浏览 + 有可靠唯一键的单表修改。
 *
 * 分页两套：
 * - **keyset**：排序序列恰好等于可靠唯一键时使用；`next_cursor` 来自上一页
 *   最后一行，翻页不随 OFFSET 增大而变慢。
 * - **OFFSET**：其它排序（或没有可靠键）时使用，有 200,000 的预算上限；
 *   界面会明确说明"跨页可能重复/漏行"。
 *
 * 修改：先暂存 → 展示待提交行 → 显式提交（事务 + 影响行数校验）。
 * 结果未知时**不自动重试**，只给出按主键重新核对的语句。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileDown,
  Filter,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Table2,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorText, Modal, fieldClass, selectClass } from "@/components/ui/modal";
import { databaseApi } from "@/api/ops-api";
import type {
  AssignValue,
  BrowseFilter,
  BrowseResult,
  BrowseSort,
  ColumnAssignment,
  DatabaseProfile,
  DbSessionInfo,
  DbTableDetail,
  DbValue,
  MutationResult,
  RowMutation,
} from "@/api/types/database";
import { cn } from "@/lib/cn";
import { toDbError, useDatabaseStore } from "@/stores/database-store";
import { VirtualDataGrid, type CellAddress } from "./VirtualDataGrid";
import { TableStructure } from "./TableStructure";
import { EditRowDialog } from "./EditRowDialog";
import { ExportDialog } from "./ExportDialog";

const PAGE_SIZES = [100, 200, 500];

function rawText(value: DbValue): string | null {
  switch (value.kind) {
    case "null":
      return null;
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
    case "bit":
      return value.value;
    case "binary":
      return null;
    case "unsupported":
      return null;
  }
}

type Pending =
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

export function TableBrowser({
  tabId: _tabId,
  profile,
  session,
  database,
  table,
  initialView,
  onClose,
}: {
  tabId: string;
  profile: DatabaseProfile;
  session: DbSessionInfo | null;
  database: string;
  table: string;
  initialView: "data" | "structure";
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const details = useDatabaseStore((state) => state.details);
  const loadingDetail = useDatabaseStore((state) => state.loading);
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);

  const detailKey = `${profile.id}\u0001${database}\u0001${table}`;
  const detail: DbTableDetail | null = details[detailKey] ?? null;

  const [view, setView] = useState<"data" | "structure">(initialView);
  const [pageSize, setPageSize] = useState(200);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursor, setCursor] = useState<(string | null)[] | null>(null);
  const [cursorStack, setCursorStack] = useState<((string | null)[] | null)[]>([null]);
  const [filters, setFilters] = useState<BrowseFilter[]>([]);
  const [sorts, setSorts] = useState<BrowseSort[]>([]);
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exact, setExact] = useState<number | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [selectedCell, setSelectedCell] = useState<CellAddress | null>(null);
  const [editor, setEditor] = useState<{
    mode: "insert" | "update";
    row: DbValue[] | null;
  } | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [showPending, setShowPending] = useState(false);
  const [mutation, setMutation] = useState<MutationResult | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [allowNonTransactional, setAllowNonTransactional] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [cellDetail, setCellDetail] = useState<{
    column: string;
    value: DbValue;
  } | null>(null);
  const requestNonce = useRef(0);

  const [draftFilter, setDraftFilter] = useState<{
    column: string;
    op: BrowseFilter["op"];
    value: string;
  }>({ column: "", op: "contains", value: "" });

  useEffect(() => {
    if (!detail) void refreshTableDetail(profile.id, database, table);
  }, [database, detail, profile.id, refreshTableDetail, table]);

  const load = useCallback(async () => {
    if (!session) return;
    const nonce = ++requestNonce.current;
    setLoading(true);
    setError(null);
    try {
      const offset = cursor ? 0 : pageIndex * pageSize;
      const next = await databaseApi.browse({
        session_id: session.session_id,
        database,
        table,
        page_size: pageSize,
        offset,
        after: cursor,
        sorts: sorts.length > 0 ? sorts : null,
        filters: filters.length > 0 ? filters : null,
        pagination: "auto",
        exact_count: false,
      });
      if (nonce !== requestNonce.current) return;
      setResult(next);
      setSelectedRow(null);
      setSelectedCell(null);
    } catch (failure) {
      if (nonce !== requestNonce.current) return;
      setError(toDbError(failure).message);
    } finally {
      if (nonce === requestNonce.current) setLoading(false);
    }
  }, [cursor, database, filters, pageIndex, pageSize, session, sorts, table]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetPaging = () => {
    setPageIndex(0);
    setCursor(null);
    setCursorStack([null]);
    setExact(null);
  };

  const keyOfRow = useCallback(
    (row: DbValue[]): { key: AssignValue[]; label: string } | null => {
      if (!detail?.reliable_key || detail.reliable_key.length === 0) return null;
      const key: AssignValue[] = [];
      const labels: string[] = [];
      for (const name of detail.reliable_key) {
        const index = detail.columns.findIndex((column) => column.name === name);
        const text = index >= 0 ? rawText(row[index] ?? { kind: "null" }) : null;
        if (text === null) return null;
        key.push({ kind: "value", value: text });
        labels.push(`${name}=${text}`);
      }
      return { key, label: labels.join(", ") };
    },
    [detail],
  );

  const expectedOfRow = useCallback(
    (row: DbValue[]): ColumnAssignment[] => {
      if (!detail) return [];
      const assignments: ColumnAssignment[] = [];
      detail.columns.forEach((column, index) => {
        // 二进制列不能安全地作为比较参数（base64 与列值不是同一表示），跳过。
        if (/blob|binary/i.test(column.data_type)) return;
        const text = rawText(row[index] ?? { kind: "null" });
        assignments.push({
          column: column.name,
          value: text === null ? { kind: "null" } : { kind: "value", value: text },
        });
      });
      return assignments;
    },
    [detail],
  );

  const canEdit =
    !!session &&
    !profile.read_only &&
    detail?.kind === "table" &&
    (detail?.reliable_key?.length ?? 0) > 0;

  const selectedValues = useMemo(() => {
    if (selectedRow === null || !result) return null;
    return result.rows[selectedRow] ?? null;
  }, [result, selectedRow]);

  const addUpdate = (values: ColumnAssignment[]) => {
    if (!selectedValues) return;
    const located = keyOfRow(selectedValues);
    if (!located) return;
    setPending((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        kind: "update",
        key: located.key,
        label: located.label,
        values,
        expected: expectedOfRow(selectedValues),
      },
    ]);
  };

  const addDelete = () => {
    if (!selectedValues) return;
    const located = keyOfRow(selectedValues);
    if (!located) return;
    setPending((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        kind: "delete",
        key: located.key,
        label: located.label,
        expected: expectedOfRow(selectedValues),
      },
    ]);
  };

  const submit = async (allowOverride?: boolean) => {
    if (!session || pending.length === 0) return;
    const allow = allowOverride ?? allowNonTransactional;
    setSubmitting(true);
    setMutationError(null);
    setMutation(null);
    try {
      const rows: RowMutation[] = pending.map((entry) => {
        if (entry.kind === "insert") {
          return { kind: "insert", key: null, values: entry.values, expected: null };
        }
        if (entry.kind === "delete") {
          return {
            kind: "delete",
            key: entry.key,
            values: [],
            expected: entry.expected,
          };
        }
        return {
          kind: "update",
          key: entry.key,
          values: entry.values,
          expected: entry.expected,
        };
      });

      const outcome = await databaseApi.mutate({
        sessionId: session.session_id,
        database,
        table,
        rows,
        allowNonTransactional: allow,
      });
      setMutation(outcome);
      if (outcome.state === "committed") {
        setPending([]);
        setShowPending(false);
        await load();
      }
    } catch (failure) {
      setMutationError(toDbError(failure).message);
    } finally {
      setSubmitting(false);
    }
  };

  const nextPage = () => {
    if (!result) return;
    if (result.pagination === "keyset" && result.next_cursor) {
      setCursorStack((current) => [...current, result.next_cursor]);
      setCursor(result.next_cursor);
    } else if (result.has_more) {
      setCursor(null);
    }
    setPageIndex((index) => index + 1);
  };

  const prevPage = () => {
    if (pageIndex === 0) return;
    if (result?.pagination === "keyset") {
      const stack = [...cursorStack];
      stack.pop();
      setCursorStack(stack);
      setCursor(stack[stack.length - 1] ?? null);
    }
    setPageIndex((index) => Math.max(0, index - 1));
  };

  const sortBy = (column: { name: string }) => {
    const current = sorts[0];
    if (!current || current.column !== column.name) {
      setSorts([{ column: column.name, direction: "asc" }]);
    } else if (current.direction === "asc") {
      setSorts([{ column: column.name, direction: "desc" }]);
    } else {
      setSorts([]);
    }
    resetPaging();
  };

  const addFilter = () => {
    if (!draftFilter.column) return;
    const value = draftFilter.value;
    setFilters((current) => [
      ...current,
      {
        column: draftFilter.column,
        op: draftFilter.op,
        value:
          draftFilter.op === "is_null" || draftFilter.op === "not_null"
            ? null
            : value,
      },
    ]);
    setDraftFilter((current) => ({ ...current, value: "" }));
    resetPaging();
  };

  const columns = detail?.columns ?? [];
  const pageRows = result?.rows ?? [];
  const totalPages =
    result?.exact_rows !== null && result?.exact_rows !== undefined
      ? Math.max(1, Math.ceil(result.exact_rows / pageSize))
      : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <Table2 size={12} className="shrink-0 text-fg-subtle" />
        <span className="max-w-[240px] truncate text-12 text-fg" title={`${database}.${table}`}>
          {database}.<span className="font-medium">{table}</span>
        </span>
        {detail?.kind === "view" && (
          <span className="rounded bg-surface-2 px-1 text-[9px] text-fg-subtle">{t("视图")}</span>
        )}
        {detail?.engine && (
          <span className="text-[10px] text-fg-subtle">{detail.engine}</span>
        )}
        {detail?.estimated_rows !== null && detail?.estimated_rows !== undefined && (
          <span
            className="text-[10px] text-fg-subtle"
            title={t("information_schema.TABLES.TABLE_ROWS：估算值，不是 COUNT(*)")}
          >
            ≈ {detail.estimated_rows.toLocaleString()} {t("行")}
          </span>
        )}
        {!detail && <Loader2 size={11} className="animate-spin text-fg-subtle" />}

        <div className="ml-2 flex items-center gap-1">
          <Button
            variant={view === "data" ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setView("data")}
          >
            {t("数据")}
          </Button>
          <Button
            variant={view === "structure" ? "secondary" : "ghost"}
            size="xs"
            onClick={() => {
              setView("structure");
              if (!detail) void refreshTableDetail(profile.id, database, table);
            }}
          >
            {t("结构")}
          </Button>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={loading || !session}
            onClick={() => void load()}
          >
            {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={loading || !session}
            onClick={async () => {
              if (!session) return;
              try {
                const counted = await databaseApi.browse({
                  session_id: session.session_id,
                  database,
                  table,
                  page_size: 1,
                  offset: 0,
                  filters: filters.length > 0 ? filters : null,
                  sorts: null,
                  pagination: "offset",
                  exact_count: true,
                });
                setExact(counted.exact_rows);
              } catch (failure) {
                setError(toDbError(failure).message);
              }
            }}
            title={t("执行一次 COUNT(*)（显式请求，不在打开表时自动执行）")}
          >
            <Wand2 size={11} />
            {exact !== null ? exact.toLocaleString() : t("精确行数")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!session}
            onClick={() => setExportOpen(true)}
            title={t("按当前过滤/排序重新查询整表并流式导出")}
          >
            <FileDown size={11} />
            CSV
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!canEdit}
            onClick={() => setEditor({ mode: "insert", row: null })}
            title={
              canEdit
                ? t("新增一行")
                : t("只读：视图、无可靠唯一键或连接为只读")
            }
          >
            <Plus size={11} />
            {t("新增")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!canEdit || selectedRow === null}
            onClick={() => setEditor({ mode: "update", row: selectedValues })}
          >
            <Pencil size={11} />
            {t("编辑")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!canEdit || selectedRow === null}
            onClick={addDelete}
          >
            <Trash2 size={11} />
            {t("删除")}
          </Button>
          <Button variant="ghost" size="xs" onClick={onClose}>
            <X size={11} />
          </Button>
        </div>
      </div>

      {view === "structure" ? (
        <div className="min-h-0 flex-1">
          <TableStructure detail={detail} loading={!!loadingDetail[detailKey]} />
        </div>
      ) : (
        <>
          <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
            <Filter size={11} className="shrink-0 text-fg-subtle" />
            <select
              className={cn(selectClass, "h-[24px] w-[130px] !pr-6 text-10")}
              value={draftFilter.column}
              onChange={(event) =>
                setDraftFilter((current) => ({ ...current, column: event.target.value }))
              }
            >
              <option value="">{t("选择列")}</option>
              {columns.map((column) => (
                <option key={column.name} value={column.name}>
                  {column.name}
                </option>
              ))}
            </select>
            <select
              className={cn(selectClass, "h-[24px] w-[110px] !pr-6 text-10")}
              value={draftFilter.op}
              onChange={(event) =>
                setDraftFilter((current) => ({
                  ...current,
                  op: event.target.value as BrowseFilter["op"],
                }))
              }
            >
              <option value="contains">{t("包含")}</option>
              <option value="eq">=</option>
              <option value="ne">≠</option>
              <option value="starts_with">{t("开头是")}</option>
              <option value="gt">&gt;</option>
              <option value="gte">≥</option>
              <option value="lt">&lt;</option>
              <option value="lte">≤</option>
              <option value="is_null">IS NULL</option>
              <option value="not_null">IS NOT NULL</option>
            </select>
            <input
              className={cn(fieldClass, "h-[24px] w-[150px] text-10")}
              value={draftFilter.value}
              disabled={draftFilter.op === "is_null" || draftFilter.op === "not_null"}
              onChange={(event) =>
                setDraftFilter((current) => ({ ...current, value: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") addFilter();
              }}
              placeholder={t("值（参数绑定）")}
            />
            <Button variant="ghost" size="xs" disabled={!draftFilter.column} onClick={addFilter}>
              {t("添加筛选")}
            </Button>

            {filters.map((filter, index) => (
              <span
                key={`${filter.column}-${index}`}
                className="flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-fg-muted"
              >
                {filter.column} {filter.op} {filter.value ?? ""}
                <button
                  type="button"
                  aria-label={t("移除筛选")}
                  onClick={() => {
                    setFilters((current) => current.filter((_, i) => i !== index));
                    resetPaging();
                  }}
                >
                  <X size={9} />
                </button>
              </span>
            ))}
            {sorts.length > 0 && (
              <span className="flex shrink-0 items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                {sorts.map((sort) => `${sort.column} ${sort.direction}`).join(", ")}
                <button type="button" onClick={() => { setSorts([]); resetPaging(); }}>
                  <X size={9} />
                </button>
              </span>
            )}

            <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-fg-subtle">
              {result?.pagination === "keyset" ? "keyset" : "offset"}
              <select
                className={cn(selectClass, "h-[22px] w-[70px] !pr-5 text-10")}
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  resetPaging();
                }}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size} {t("行")}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="xs"
                disabled={pageIndex === 0 || loading}
                onClick={prevPage}
              >
                <ChevronLeft size={11} />
              </Button>
              <span>
                {pageIndex + 1}
                {totalPages ? ` / ${totalPages}` : ""}
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={loading || !result?.has_more}
                onClick={nextPage}
              >
                <ChevronRight size={11} />
              </Button>
            </span>
          </div>

          {result?.warning && (
            <div className="border-b border-warning/30 bg-warning/10 px-2 py-1 text-[10px] text-warning">
              {result.warning}
            </div>
          )}
          {error && (
            <div className="border-b border-danger/30 bg-danger/10 px-2 py-1 text-[10px] text-danger">
              {error}
            </div>
          )}

          <div className="min-h-0 flex-1">
            <VirtualDataGrid
              columns={result?.columns ?? []}
              rows={pageRows}
              rowOffset={result?.offset ?? 0}
              selectedRow={selectedRow}
              selectedCell={selectedCell}
              onSelectRow={setSelectedRow}
              onSelectCell={setSelectedCell}
              onSort={(column) => sortBy(column)}
              sortColumn={sorts[0]?.column ?? null}
              sortDirection={sorts[0]?.direction ?? null}
              canResolveRows={canEdit}
              onOpenCell={(cell) => {
                const column = result?.columns[cell.col]?.name;
                const value = pageRows[cell.row]?.[cell.col];
                if (!column || !value) return;
                if (!detail?.reliable_key || !canEdit) {
                  setCellDetail({ column, value });
                  return;
                }
                const row = pageRows[cell.row];
                const located = keyOfRow(row);
                if (!located) {
                  setCellDetail({ column, value });
                  return;
                }
                void databaseApi
                  .readCell({
                    profileId: profile.id,
                    database,
                    table,
                    keyValues: located.key.map((entry) =>
                      entry.kind === "value" ? entry.value : null,
                    ),
                    column,
                    maxBytes: 512 * 1024,
                  })
                  .then((full) => setCellDetail({ column, value: full }))
                  .catch((failure) =>
                    setCellDetail({
                      column,
                      value: {
                        kind: "unsupported",
                        type_name: "read_failed",
                        preview: toDbError(failure).message,
                        bytes: 0,
                      },
                    }),
                  );
              }}
            />
          </div>
        </>
      )}

      {pending.length > 0 && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-t border-accent/30 bg-accent/5 px-2 text-[10px] text-fg-muted">
          <span className="text-accent">
            {t("待提交 {{count}} 项", { count: pending.length })}
          </span>
          <Button variant="ghost" size="xs" onClick={() => setShowPending(true)}>
            {t("查看变更")}
          </Button>
          <Button
            variant="primary"
            size="xs"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Save size={10} />
            )}
            {t("提交修改")}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setPending([])}>
            {t("放弃")}
          </Button>
          {mutation?.state === "outcome_unknown" && (
            <span className="text-danger">{t("结果未知，请勿自动重试")}</span>
          )}
          {mutation?.state === "rolled_back" && (
            <span className="text-danger">{t("已回滚")}</span>
          )}
          {mutationError && <span className="text-danger">{mutationError}</span>}
        </div>
      )}

      {mutation && (mutation.warning || mutation.verify_hint) && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-t border-line bg-surface-2/60 px-2 py-1 text-[10px] leading-relaxed text-fg-muted">
          {mutation.warning && <p className="text-warning">{mutation.warning}</p>}
          {mutation.verify_hint && (
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-fg-subtle">
              {mutation.verify_hint}
            </pre>
          )}
          {mutation.state === "outcome_unknown" && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-1"
              onClick={() => {
                setPending([]);
                void load();
              }}
            >
              {t("我已核对，刷新数据")}
            </Button>
          )}
          {mutation.outcomes.some((outcome) => outcome.status === "conflict") && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-1"
              onClick={() => {
                setPending([]);
                void load();
              }}
            >
              {t("发生冲突：放弃暂存并刷新")}
            </Button>
          )}
          {mutationError?.includes("事务") && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-1"
              onClick={() => {
                setAllowNonTransactional(true);
                void submit(true);
              }}
            >
              {t("该表不支持事务：仍要执行（无法回滚）")}
            </Button>
          )}
        </div>
      )}

      <EditRowDialog
        open={editor !== null}
        mode={editor?.mode ?? "insert"}
        detail={detail ?? ({} as DbTableDetail)}
        row={editor?.row ?? null}
        onClose={() => setEditor(null)}
        onSubmit={(values) => {
          if (editor?.mode === "update") addUpdate(values);
          else
            setPending((current) => [
              ...current,
              { id: crypto.randomUUID(), kind: "insert", values },
            ]);
        }}
      />

      <Modal
        open={showPending}
        title={t("待提交的修改")}
        width={620}
        onClose={() => setShowPending(false)}
        footer={
          <Button variant="secondary" size="sm" onClick={() => setShowPending(false)}>
            {t("关闭")}
          </Button>
        }
      >
        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {pending.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start gap-2 rounded-[6px] border border-line px-2 py-1 text-11"
            >
              <span
                className={cn(
                  "rounded px-1 text-[9px]",
                  entry.kind === "insert"
                    ? "bg-success/15 text-success"
                    : entry.kind === "delete"
                      ? "bg-danger/15 text-danger"
                      : "bg-accent/15 text-accent",
                )}
              >
                {entry.kind === "insert" ? "INSERT" : entry.kind === "delete" ? "DELETE" : "UPDATE"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[10px] text-fg-muted">
                  {entry.kind === "insert" ? t("新增行") : entry.label}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-fg-subtle">
                  {(entry.kind === "delete" ? [] : entry.values).map((assignment) => (
                    <span key={assignment.column} className="font-mono">
                      {assignment.column} ={" "}
                      {assignment.value.kind === "null"
                        ? "NULL"
                        : assignment.value.kind === "default"
                          ? "DEFAULT"
                          : assignment.value.value}
                    </span>
                  ))}
                </div>
              </div>
              <button
                type="button"
                aria-label={t("移除")}
                onClick={() =>
                  setPending((current) => current.filter((item) => item.id !== entry.id))
                }
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
        {mutationError && <ErrorText>{mutationError}</ErrorText>}
      </Modal>

      <Modal
        open={cellDetail !== null}
        title={cellDetail ? `${cellDetail.column} · ${cellDetail.value.kind}` : ""}
        width={620}
        onClose={() => setCellDetail(null)}
      >
        {cellDetail && (
          <div className="flex flex-col gap-2">
            {cellDetail.value.kind === "text" && cellDetail.value.truncated && (
              <p className="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-[10px] text-warning">
                {t("原始 {{bytes}} 字节，这里只显示前 512 KiB 的完整读取结果。", {
                  bytes: cellDetail.value.bytes,
                })}
              </p>
            )}
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-surface-2/60 p-2 font-mono text-[11px] text-fg">
              {formatValue(cellDetail.value)}
            </pre>
          </div>
        )}
      </Modal>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        profileId={profile.id}
        sql=""
        table={{ database, table, filters, sorts }}
        title={t("导出表数据")}
      />

      {!canEdit && (
        <div className="pointer-events-none absolute bottom-1 left-2 z-10 rounded bg-surface-2/90 px-1.5 py-0.5 text-[9px] text-fg-subtle">
          {profile.read_only
            ? t("连接为只读")
            : detail?.kind === "view"
              ? t("视图默认只读")
              : t("缺少可靠唯一键：只读")}
        </div>
      )}
      {result?.truncated && (
        <span className="pointer-events-none absolute bottom-1 right-2 z-10 flex items-center gap-1 rounded bg-warning/20 px-1.5 py-0.5 text-[9px] text-warning">
          <AlertTriangle size={9} />
          {t("大字段预览已截断")}
        </span>
      )}
    </div>
  );
}

function formatValue(value: DbValue): string {
  switch (value.kind) {
    case "null":
      return "NULL";
    case "json":
      try {
        return JSON.stringify(JSON.parse(value.value), null, 2);
      } catch {
        return value.value;
      }
    case "binary":
      return value.base64;
    case "bit":
      return `${value.bits}\n${value.value}`;
    case "unsupported":
      return `${value.type_name}\n${value.preview}`;
    default:
      return rawText(value) ?? "";
  }
}
