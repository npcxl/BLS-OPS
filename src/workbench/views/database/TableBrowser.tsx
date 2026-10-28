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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileDown,
  FilePlus2,
  Filter,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { LoadingState } from "@/components/ui/loading";
import { ErrorText, Modal, fieldClass } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { databaseApi } from "@/api/ops-api";
import { copyText } from "@/lib/clipboard";
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
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
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

function keyToString(key: AssignValue[]): string {
  return key
    .map((value) => (value.kind === "value" ? value.value : `\u0000${value.kind}`))
    .join("\u0001");
}

function sameKey(a: AssignValue[], b: AssignValue[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => {
    const other = b[index];
    if (!other || value.kind !== other.kind) return false;
    if (value.kind === "value" && other.kind === "value") {
      return value.value === other.value;
    }
    return true;
  });
}

export function TableBrowser({
  tabId: _tabId,
  profile,
  session,
  database,
  table,
  initialView = "data",
  onClose,
  onPendingChange,
  onNewQuery,
  footer,
}: {
  tabId: string;
  profile: DatabaseProfile;
  session: DbSessionInfo | null;
  database: string;
  table: string;
  initialView?: "data" | "structure" | "indexes" | "ddl";
  connectionName?: string;
  onClose: () => void;
  onPendingChange?: (count: number) => void;
  onNewQuery?: () => void;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const details = useDatabaseStore((state) => state.details);
  const loadingDetail = useDatabaseStore((state) => state.loading);
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);
  const rightPanel = useDatabaseWorkspaceStore((state) => state.rightPanel);
  const ddl = useDatabaseWorkspaceStore((state) => state.ddl);
  const showDdl = useDatabaseWorkspaceStore((state) => state.showDdl);
  const hideDdl = useDatabaseWorkspaceStore((state) => state.hideDdl);
  const openStructure = useDatabaseWorkspaceStore((state) => state.openStructure);

  const detailKey = `${profile.id}\u0001${database}\u0001${table}`;
  const detail: DbTableDetail | null = details[detailKey] ?? null;

  const [view, setView] = useState<"data" | "structure" | "indexes" | "ddl">(
    initialView,
  );
  const [showFilters, setShowFilters] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [pageSize, setPageSize] = useState(200);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursor, setCursor] = useState<(string | null)[] | null>(null);
  const [cursorStack, setCursorStack] = useState<((string | null)[] | null)[]>([null]);
  const [filters, setFilters] = useState<BrowseFilter[]>([]);
  const [sorts, setSorts] = useState<BrowseSort[]>([]);
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 第二行（新增/删除/应用修改）默认收起，点“表格修改”才展开。 */
  const [showEditBar, setShowEditBar] = useState(false);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [selectedCell, setSelectedCell] = useState<CellAddress | null>(null);
  const [editing, setEditing] = useState<{
    cell: CellAddress;
    value: string;
    /** 大字段完整读取后的值；用于并发比较，避免跳过该列。 */
    fullValue?: DbValue;
  } | null>(null);
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
  const cellMenu = useContextMenu();

  const [draftFilter, setDraftFilter] = useState<{
    column: string;
    op: BrowseFilter["op"];
    value: string;
  }>({ column: "", op: "contains", value: "" });

  useEffect(() => {
    if (!detail) void refreshTableDetail(profile.id, database, table);
  }, [database, detail, profile.id, refreshTableDetail, table]);

  // 右栏需要显示"待修改"标记；只用 ref 保存回调，避免父组件每次渲染
  // 生成新函数 → effect 重跑 → setStatus → 再渲染的死循环。
  const pendingChangeRef = useRef(onPendingChange);
  pendingChangeRef.current = onPendingChange;
  useEffect(() => {
    pendingChangeRef.current?.(pending.length);
  }, [pending.length]);

  const lastLoadKeyRef = useRef("");

  /**
   * `force=false` 时同一组条件只查一次：首次进入查询一次，刷新按钮
   * 显式传 `force=true` 再查一次；React StrictMode 的双执行也不会重复查。
   */
  const load = useCallback(async (force = false) => {
    if (!session) return;
    const loadKey = [
      session.session_id,
      database,
      table,
      pageIndex,
      pageSize,
      JSON.stringify(filters),
      JSON.stringify(sorts),
      cursor?.join("\u0001") ?? "",
    ].join("\u0002");
    if (!force && loadKey === lastLoadKeyRef.current) return;
    lastLoadKeyRef.current = loadKey;
    const nonce = ++requestNonce.current;
    setLoading(true);
    setError(null);
    try {
      const offset = cursor ? 0 : pageIndex * pageSize;
      // 只在首页/刷新/筛选时统计总数；翻页不重复 COUNT。
      const shouldCount = force || pageIndex === 0;
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
        exact_count: shouldCount,
      });
      if (nonce !== requestNonce.current) return;
      setResult(next);
      if (shouldCount) setTotal(next.exact_rows);
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
        const value = row[index] ?? { kind: "null" as const };
        // **绝不拿截断预览做并发比较**：预览 64 KiB 和完整值永远不相等，
        // 会导致每次保存都"冲突"，或者把截断值写回。跳过这些列。
        if (
          (value.kind === "text" || value.kind === "json") &&
          value.truncated
        ) {
          return;
        }
        if (value.kind === "binary" || value.kind === "unsupported") return;
        const text = rawText(value);
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

  /**
   * 打开表单编辑前，把被结果预算截断的大字段**按主键重新读完整**。
   * 否则用户会在表单里看到 64 KiB 的预览，保存时把截断值写回数据库。
   */
  const openEditor = async (mode: "insert" | "update", row: DbValue[] | null) => {
    if (mode === "insert" || !row || !detail) {
      setEditor({ mode, row });
      return;
    }
    const located = keyOfRow(row);
    if (!located) {
      setEditor({ mode, row });
      return;
    }
    const truncated = row
      .map((value, index) => ({ value, index }))
      .filter(
        ({ value }) =>
          (value.kind === "text" || value.kind === "json") && value.truncated,
      );
    if (truncated.length === 0) {
      setEditor({ mode, row });
      return;
    }
    setEditorLoading(true);
    const full = [...row];
    let failed = false;
    try {
      const keyValues = located.key.map((entry) =>
        entry.kind === "value" ? entry.value : null,
      );
      await Promise.all(
        truncated.map(async ({ index }) => {
          const column = detail.columns[index];
          if (!column) return;
          try {
            const value = await databaseApi.readCell({
              profileId: profile.id,
              database,
              table,
              keyValues,
              column: column.name,
              maxBytes: 4 * 1024 * 1024,
            });
            if (
              (value.kind === "text" || value.kind === "json") &&
              value.truncated
            ) {
              failed = true;
              return;
            }
            full[index] = value;
          } catch {
            // 无法完整读取 → 不允许编辑，避免把预览片段写回。
            failed = true;
          }
        }),
      );
    } finally {
      setEditorLoading(false);
    }
    if (failed) {
      setError(
        t("无法读取完整字段，已阻止编辑（避免把截断预览写回数据库）"),
      );
      return;
    }
    setEditor({ mode, row: full });
  };

  /** 把一个单元格值并入同一行的待提交修改（同表、同主键）。 */
  const applyCellValue = (
    cell: CellAddress,
    value: AssignValue,
    fullValue?: DbValue,
  ) => {
    if (!canEdit || !detail) return;
    const source = pageRows[cell.row];
    const column = detail.columns[cell.col];
    if (!source || !column || column.primary_key) return;
    if (/blob|binary/i.test(column.data_type)) return;
    const rowValues = fullValue
      ? source.map((item, index) => (index === cell.col ? fullValue : item))
      : source;
    const located = keyOfRow(rowValues);
    if (!located) return;
    const assignment: ColumnAssignment = { column: column.name, value };
    setPending((current) => {
      const index = current.findIndex(
        (entry) => entry.kind === "update" && sameKey(entry.key, located.key),
      );
      if (index >= 0) {
        const entry = current[index];
        if (entry.kind !== "update") return current;
        const values = entry.values.some((item) => item.column === column.name)
          ? entry.values.map((item) =>
              item.column === column.name ? assignment : item,
            )
          : [...entry.values, assignment];
        return current.map((item, itemIndex) =>
          itemIndex === index ? { ...entry, values } : item,
        );
      }
      return [
        ...current,
        {
          id: crypto.randomUUID(),
          kind: "update" as const,
          key: located.key,
          label: located.label,
          values: [assignment],
          expected: expectedOfRow(rowValues),
        },
      ];
    });
  };

  /** 查看完整值：有可靠键时按主键重读，否则只显示已接收的预览。 */
  const openCellDetail = (cell: CellAddress) => {
    const column = result?.columns[cell.col]?.name;
    const value = pageRows[cell.row]?.[cell.col];
    if (!column || !value) return;
    const row = pageRows[cell.row];
    const located = row ? keyOfRow(row) : null;
    if (!detail?.reliable_key || !canEdit || !located) {
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
  };

  /** 双击/F2：进入单元格编辑；不可编辑的类型退回完整值查看。 */
  const startCellEdit = async (cell: CellAddress) => {
    if (!canEdit || !detail) {
      openCellDetail(cell);
      return;
    }
    const value = pageRows[cell.row]?.[cell.col];
    const column = detail.columns[cell.col];
    if (
      !value ||
      !column ||
      column.primary_key ||
      /blob|binary/i.test(column.data_type) ||
      value.kind === "unsupported"
    ) {
      openCellDetail(cell);
      return;
    }
    let text = rawText(value) ?? "";
    if ((value.kind === "text" || value.kind === "json") && value.truncated) {
      const rowValues = pageRows[cell.row];
      const located = rowValues ? keyOfRow(rowValues) : null;
      if (!located) {
        openCellDetail(cell);
        return;
      }
      try {
        const full = await databaseApi.readCell({
          profileId: profile.id,
          database,
          table,
          keyValues: located.key.map((entry) =>
            entry.kind === "value" ? entry.value : null,
          ),
          column: column.name,
          maxBytes: 4 * 1024 * 1024,
        });
        if (
          (full.kind === "text" || full.kind === "json") &&
          full.truncated
        ) {
          setError(t("字段过大，无法完整读取；只能查看，不能直接编辑"));
          openCellDetail(cell);
          return;
        }
        text = rawText(full) ?? text;
        setEditing({ cell, value: text, fullValue: full });
        return;
      } catch (failure) {
        setError(
          `${t("无法读取完整字段，已阻止编辑")}：${toDbError(failure).message}`,
        );
        openCellDetail(cell);
        return;
      }
    }
    setEditing({ cell, value: text });
  };

  const commitCellEdit = (cell: CellAddress) => {
    if (!editing || editing.cell.row !== cell.row || editing.cell.col !== cell.col) {
      return;
    }
    applyCellValue(
      cell,
      { kind: "value", value: editing.value },
      editing.fullValue,
    );
    setEditing(null);
  };

  const copyCellValue = (cell: CellAddress) => {
    const value = pageRows[cell.row]?.[cell.col];
    const text = value ? rawText(value) : null;
    if (text !== null) void copyText(text);
  };

  const filterByCell = (cell: CellAddress, exclude: boolean) => {
    const column = detail?.columns[cell.col];
    const value = pageRows[cell.row]?.[cell.col];
    if (!column || !value) return;
    if (value.kind === "binary" || value.kind === "unsupported") {
      setError(t("该字段无法按值筛选"));
      return;
    }
    const text = rawText(value);
    setFilters((current) => [
      ...current,
      {
        column: column.name,
        op: text === null ? (exclude ? "not_null" : "is_null") : exclude ? "ne" : "eq",
        value: text,
      },
    ]);
    setShowFilters(true);
    resetPaging();
  };

  const removeCellChange = (cell: CellAddress) => {
    const row = pageRows[cell.row];
    const column = detail?.columns[cell.col];
    if (!row || !column) return;
    const located = keyOfRow(row);
    if (!located) return;
    setPending((current) =>
      current.flatMap((entry) => {
        if (entry.kind !== "update" || !sameKey(entry.key, located.key)) {
          return [entry];
        }
        const values = entry.values.filter((value) => value.column !== column.name);
        return values.length > 0 ? [{ ...entry, values }] : [];
      }),
    );
  };

  const removeRowChange = (rowIndex: number) => {
    const row = pageRows[rowIndex];
    const located = row ? keyOfRow(row) : null;
    if (!located) return;
    setPending((current) =>
      current.filter(
        (entry) => entry.kind === "insert" || !sameKey(entry.key, located.key),
      ),
    );
  };

  /**
   * 截断/二进制字段不能生成"看起来完整"的 INSERT/JSON；
   * 返回 null 让调用方明确报错，而不是悄悄写入预览片段。
   */
  const buildInsertAssignments = (
    row: DbValue[],
    skipAutoIncrement: boolean,
  ): ColumnAssignment[] | null => {
    if (!detail) return null;
    const assignments: ColumnAssignment[] = [];
    for (let index = 0; index < detail.columns.length; index += 1) {
      const column = detail.columns[index];
      if (skipAutoIncrement && column.auto_increment) continue;
      const value = row[index] ?? { kind: "null" as const };
      if ((value.kind === "text" || value.kind === "json") && value.truncated) {
        return null;
      }
      if (value.kind === "binary" || value.kind === "unsupported") return null;
      const text = rawText(value);
      assignments.push({
        column: column.name,
        value: text === null ? { kind: "null" } : { kind: "value", value: text },
      });
    }
    return assignments;
  };

  const quoteIdentifier = (name: string) => `\`${name.replace(/`/g, "``")}\``;

  const copyAsInsert = (row: DbValue[]) => {
    const assignments = buildInsertAssignments(row, false);
    if (!assignments) {
      setError(t("字段内容已截断或为二进制，无法生成完整 INSERT"));
      return;
    }
    const columns = assignments
      .map((item) => quoteIdentifier(item.column))
      .join(", ");
    const values = assignments
      .map((item) =>
        item.value.kind === "value"
          ? `'${item.value.value.replace(/'/g, "''")}'`
          : "NULL",
      )
      .join(", ");
    void copyText(
      `INSERT INTO ${quoteIdentifier(database)}.${quoteIdentifier(table)} (${columns}) VALUES (${values});`,
    );
  };

  const copyAsJson = (row: DbValue[]) => {
    if (!detail) return;
    const data: Record<string, string | null> = {};
    for (let index = 0; index < detail.columns.length; index += 1) {
      const value = row[index] ?? { kind: "null" as const };
      if ((value.kind === "text" || value.kind === "json") && value.truncated) {
        setError(t("字段内容已截断，无法生成完整 JSON"));
        return;
      }
      if (value.kind === "binary" || value.kind === "unsupported") {
        setError(t("二进制/不支持字段无法生成 JSON"));
        return;
      }
      data[detail.columns[index].name] = rawText(value);
    }
    void copyText(JSON.stringify(data, null, 2));
  };

  const copyRowText = (row: DbValue[]) => {
    void copyText(
      row
        .map((value) => rawText(value) ?? "")
        .join("\t"),
    );
  };

  const insertFromRow = (row: DbValue[]) => {
    if (!canEdit) return;
    const assignments = buildInsertAssignments(row, true);
    if (!assignments) {
      setError(t("字段内容已截断或为二进制，无法复制为新行"));
      return;
    }
    setPending((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: "insert", values: assignments },
    ]);
    setShowEditBar(true);
  };

  const deleteRowAt = (rowIndex: number) => {
    if (!canEdit) return;
    const row = pageRows[rowIndex];
    const located = row ? keyOfRow(row) : null;
    if (!row || !located) return;
    setSelectedRow(rowIndex);
    setPending((current) => [
      // 同一行先删除已有的 update/delete，再标记删除，避免提交时互相冲突。
      ...current.filter(
        (entry) =>
          entry.kind === "insert" || !sameKey(entry.key, located.key),
      ),
      {
        id: crypto.randomUUID(),
        kind: "delete",
        key: located.key,
        label: located.label,
        expected: expectedOfRow(row),
      },
    ]);
  };

  const openColumnMenu = (col: number, event: React.MouseEvent) => {
    const name = result?.columns[col]?.name;
    if (!name) return;
    cellMenu.onContextMenu(() => [
      {
        id: "sort-asc",
        label: t("升序"),
        onSelect: () => {
          setSorts([{ column: name, direction: "asc" }]);
          resetPaging();
        },
      },
      {
        id: "sort-desc",
        label: t("降序"),
        onSelect: () => {
          setSorts([{ column: name, direction: "desc" }]);
          resetPaging();
        },
      },
      {
        id: "sort-clear",
        label: t("清除排序"),
        onSelect: () => {
          setSorts([]);
          resetPaging();
        },
      },
      { separator: true },
      {
        id: "filter",
        label: t("筛选"),
        onSelect: () => {
          setDraftFilter({ column: name, op: "contains", value: "" });
          setShowFilters(true);
        },
      },
      {
        id: "copy-column",
        label: t("复制列名"),
        onSelect: () => void copyText(name),
      },
      {
        id: "column-info",
        label: t("字段属性"),
        onSelect: () =>
          openStructure({
            profileId: profile.id,
            connectionName: profile.name,
            database,
            table,
          }),
      },
    ])(event);
  };

  const openRowMenu = (rowIndex: number, event: React.MouseEvent) => {
    const row = pageRows[rowIndex];
    if (!row) return;
    const located = keyOfRow(row);
    const modified = located
      ? pending.some(
          (entry) => entry.kind !== "insert" && sameKey(entry.key, located.key),
        )
      : false;
    cellMenu.onContextMenu(() => [
      {
        id: "insert",
        label: t("新增行"),
        onSelect: () => void openEditor("insert", null),
      },
      {
        id: "copy-new",
        label: t("复制为新行"),
        onSelect: () => insertFromRow(row),
      },
      {
        id: "form-edit",
        label: t("表单编辑"),
        onSelect: () => void openEditor("update", row),
      },
      {
        id: "delete-row",
        label: t("删除选中行"),
        onSelect: () => deleteRowAt(rowIndex),
      },
      { separator: true },
      {
        id: "copy-row",
        label: t("复制整行"),
        onSelect: () => copyRowText(row),
      },
      {
        id: "copy-json",
        label: t("复制为 JSON"),
        onSelect: () => copyAsJson(row),
      },
      {
        id: "copy-insert",
        label: t("复制为 INSERT"),
        onSelect: () => copyAsInsert(row),
      },
      ...(modified
        ? [
            { separator: true as const },
            {
              id: "undo-row",
              label: t("撤销行修改"),
              onSelect: () => removeRowChange(rowIndex),
            },
          ]
        : []),
    ])(event);
  };

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
    const live = useDatabaseStore.getState().sessions[profile.id];
    if (
      live &&
      (live.transaction === "in_transaction" ||
        live.transaction === "in_transaction_read_only")
    ) {
      setMutationError(
        t("当前会话有未提交事务：请先在 SQL 中 COMMIT 或 ROLLBACK，再应用表格修改"),
      );
      return;
    }
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

  const modifiedCells = useMemo(() => {
    const set = new Set<string>();
    if (!detail) return set;
    const rowIndexByKey = new Map<string, number>();
    pageRows.forEach((row, index) => {
      const located = keyOfRow(row);
      if (located) rowIndexByKey.set(keyToString(located.key), index);
    });
    for (const entry of pending) {
      if (entry.kind !== "update") continue;
      const rowIndex = rowIndexByKey.get(keyToString(entry.key));
      if (rowIndex === undefined) continue;
      for (const assignment of entry.values) {
        const colIndex = detail.columns.findIndex(
          (column) => column.name === assignment.column,
        );
        if (colIndex >= 0) set.add(`${rowIndex}:${colIndex}`);
      }
    }
    return set;
  }, [detail, keyOfRow, pageRows, pending]);

  const deletedRows = useMemo(() => {
    const set = new Set<number>();
    const keys = new Set<string>();
    for (const entry of pending) {
      if (entry.kind === "delete") keys.add(keyToString(entry.key));
    }
    pageRows.forEach((row, index) => {
      const located = keyOfRow(row);
      if (located && keys.has(keyToString(located.key))) set.add(index);
    });
    return set;
  }, [keyOfRow, pageRows, pending]);
  const totalPages =
    total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* 第一行：新建查询 + 子视图 + 表格修改开关 + 筛选/导出 + 刷新/关闭 */}
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
        <Button
          variant="primary"
          size="xs"
          onClick={onNewQuery}
          disabled={!onNewQuery}
          title={t("新建一份独立的 SQL 查询")}
        >
          <FilePlus2 size={11} />
          {t("新建查询")}
        </Button>
        <span className="mx-1 h-5 w-px shrink-0 bg-line" />
        {(
          [
            ["data", t("数据")],
            ["structure", t("结构")],
            ["ddl", "DDL"],
          ] as const
        ).map(([key, label]) => {
          const ddlActive =
            key === "ddl" &&
            rightPanel === "ddl" &&
            ddl?.profileId === profile.id &&
            ddl.database === database &&
            ddl.table === table;
          return (
            <Button
              key={key}
              variant={
                ddlActive || (key === "data" && view === "data")
                  ? "secondary"
                  : "ghost"
              }
              size="xs"
              onClick={() => {
                if (key === "ddl") {
                  // DDL 不走中央工作区：显示在右侧、加宽；再点一次恢复列表。
                  if (ddlActive) {
                    hideDdl();
                  } else {
                    if (view === "ddl") setView("data");
                    showDdl({ profileId: profile.id, database, table });
                  }
                  return;
                }
                if (key === "structure") {
                  // 表结构独立开一个工作项，和表数据页并存。
                  openStructure({
                    profileId: profile.id,
                    connectionName: profile.name,
                    database,
                    table,
                  });
                  return;
                }
                setView("data");
                if (!detail) void refreshTableDetail(profile.id, database, table);
              }}
            >
              {label}
            </Button>
          );
        })}
        {view === "data" && (
          <Button
            variant={showEditBar ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setShowEditBar((value) => !value)}
            title={t("展开新增 / 编辑 / 删除 / 应用修改")}
          >
            <Pencil size={11} />
            {t("表格修改")}
          </Button>
        )}
        <span className="mx-1 h-5 w-px shrink-0 bg-line" />
        <Button
          variant={showFilters ? "secondary" : "ghost"}
          size="xs"
          onClick={() => setShowFilters((value) => !value)}
        >
          <Filter size={11} />
          {t("筛选")}
          {filters.length > 0 ? ` (${filters.length})` : ""}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!session}
          onClick={() => setExportOpen(true)}
          title={t("按当前过滤/排序重新查询整表并流式导出")}
        >
          <FileDown size={11} />
          {t("导出")}
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="xs"
            disabled={loading || !session}
            onClick={() => void load(true)}
            title={t("刷新当前页")}
          >
            {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          </Button>
          <Button variant="ghost" size="xs" onClick={onClose} title={t("关闭")}>
            <X size={11} />
          </Button>
        </div>
      </div>

      {/* 第二行：默认收起；点“表格修改”才出现 */}
      {view === "data" && showEditBar && (
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface-2/30 px-2">
          <Button
            variant="primary"
            size="xs"
            disabled={!canEdit || editorLoading}
            onClick={() => void openEditor("insert", null)}
            title={canEdit ? t("新增一行") : t("只读：视图、无可靠唯一键或连接为只读")}
          >
            <Plus size={11} />
            {t("新增")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!canEdit || selectedRow === null || editorLoading}
            onClick={() => void openEditor("update", selectedValues)}
            title={t("用表单编辑当前行")}
          >
            <Pencil size={11} />
            {t("编辑")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!canEdit || selectedRow === null}
            onClick={addDelete}
            title={t("删除")}
          >
            <Trash2 size={11} />
            {t("删除")}
          </Button>
          <span className="mx-1 h-5 w-px shrink-0 bg-line" />
          <Button
            variant="secondary"
            size="xs"
            disabled={!canEdit || pending.length === 0 || submitting}
            onClick={() => void submit()}
          >
            {submitting ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
            {t("应用修改")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={pending.length === 0}
            onClick={() => setPending([])}
          >
            {t("撤销")}
          </Button>

        </div>
      )}

      {view !== "data" ? (
        <div className="min-h-0 flex-1">
          <TableStructure
            detail={detail}
            loading={!!loadingDetail[detailKey]}
            section={view === "structure" ? "columns" : view}
          />
        </div>
      ) : (
        <>
          {showFilters && (
          <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
            <Filter size={11} className="shrink-0 text-fg-subtle" />
            <Select
              className="w-[140px]"
              size="sm"
              value={draftFilter.column}
              placeholder={t("选择列")}
              ariaLabel={t("选择列")}
              onChange={(value) =>
                setDraftFilter((current) => ({ ...current, column: value }))
              }
              options={columns.map((column) => ({
                value: column.name,
                label: column.name,
                hint: column.data_type,
              }))}
            />
            <Select
              className="w-[112px]"
              size="sm"
              value={draftFilter.op}
              ariaLabel={t("筛选条件")}
              onChange={(value) =>
                setDraftFilter((current) => ({
                  ...current,
                  op: value as BrowseFilter["op"],
                }))
              }
              options={[
                { value: "contains", label: t("包含") },
                { value: "eq", label: "=" },
                { value: "ne", label: "≠" },
                { value: "starts_with", label: t("开头是") },
                { value: "gt", label: ">" },
                { value: "gte", label: "≥" },
                { value: "lt", label: "<" },
                { value: "lte", label: "≤" },
                { value: "is_null", label: "IS NULL" },
                { value: "not_null", label: "IS NOT NULL" },
              ]}
            />
            <input
              className={cn(fieldClass, "h-[28px] w-[160px] text-12")}
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
                className="flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-11 text-fg-muted"
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
              <span className="flex shrink-0 items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-11 text-accent">
                {sorts.map((sort) => `${sort.column} ${sort.direction}`).join(", ")}
                <button type="button" onClick={() => { setSorts([]); resetPaging(); }}>
                  <X size={9} />
                </button>
              </span>
            )}

          </div>
          )}

          {result?.warning && (
            <div className="border-b border-warning/30 bg-warning/10 px-2 py-1 text-11 text-warning">
              {result.warning}
            </div>
          )}
          {error && (
            <div className="border-b border-danger/30 bg-danger/10 px-2 py-1 text-11 text-danger">
              {error}
            </div>
          )}

          <div className="min-h-0 flex-1">
            {!result && !error ? (
              <LoadingState className="h-full" />
            ) : (
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
              modifiedCells={modifiedCells}
              deletedRows={deletedRows}
              editingCell={editing?.cell ?? null}
              editingValue={editing?.value ?? ""}
              onEditingValueChange={(value) =>
                setEditing((current) => (current ? { ...current, value } : current))
              }
              onStartEdit={(cell) => void startCellEdit(cell)}
              onCommitEdit={commitCellEdit}
              onCancelEdit={() => setEditing(null)}
              onCellContextMenu={(cell, event) => {
                const modified = modifiedCells.has(`${cell.row}:${cell.col}`);
                cellMenu.onContextMenu(() => [
                  {
                    id: "copy",
                    label: t("复制值"),
                    onSelect: () => copyCellValue(cell),
                  },
                  {
                    id: "edit",
                    label: t("编辑"),
                    onSelect: () => void startCellEdit(cell),
                  },
                  {
                    id: "detail",
                    label: t("查看完整值"),
                    onSelect: () => openCellDetail(cell),
                  },
                  { separator: true },
                  {
                    id: "filter-eq",
                    label: t("按此值筛选"),
                    onSelect: () => filterByCell(cell, false),
                  },
                  {
                    id: "filter-ne",
                    label: t("排除此值"),
                    onSelect: () => filterByCell(cell, true),
                  },
                  { separator: true },
                  {
                    id: "null",
                    label: t("设为 NULL"),
                    onSelect: () => applyCellValue(cell, { kind: "null" }),
                  },
                  {
                    id: "empty",
                    label: t("设为空字符串"),
                    onSelect: () =>
                      applyCellValue(cell, { kind: "value", value: "" }),
                  },
                  {
                    id: "default",
                    label: t("使用默认值"),
                    onSelect: () => applyCellValue(cell, { kind: "default" }),
                  },
                  ...(modified
                    ? [
                        { separator: true as const },
                        {
                          id: "undo-cell",
                          label: t("撤销当前修改"),
                          onSelect: () => removeCellChange(cell),
                        },
                      ]
                    : []),
                  { separator: true },
                  {
                    id: "copy-row",
                    label: t("复制整行"),
                    onSelect: () => copyRowText(pageRows[cell.row] ?? []),
                  },
                  {
                    id: "copy-insert",
                    label: t("复制为 INSERT"),
                    onSelect: () => copyAsInsert(pageRows[cell.row] ?? []),
                  },
                  {
                    id: "copy-json",
                    label: t("复制为 JSON"),
                    onSelect: () => copyAsJson(pageRows[cell.row] ?? []),
                  },
                  {
                    id: "delete-row",
                    label: t("删除选中行"),
                    onSelect: () => deleteRowAt(cell.row),
                  },
                ])(event);
              }}
              onRowContextMenu={openRowMenu}
              onColumnContextMenu={openColumnMenu}
              onOpenCell={openCellDetail}
            />
            )}
          </div>

          {/* 底部只有一行：待提交操作 + 总数 + 分页 + 全局状态 */}
          <div className="flex h-8 shrink-0 items-center gap-2 overflow-x-auto border-t border-line px-2 text-11 text-fg-subtle">
            {pending.length > 0 && (
              <>
                <span className="text-accent">
                  {t("待提交 {{count}} 项", { count: pending.length })}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setShowPending(true)}
                >
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
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setPending([])}
                >
                  {t("放弃")}
                </Button>
              </>
            )}
            {mutation?.state === "outcome_unknown" && (
              <span className="text-danger">{t("结果未知，请勿自动重试")}</span>
            )}
            {mutation?.state === "rolled_back" && (
              <span className="text-danger">{t("已回滚")}</span>
            )}
            {mutationError && (
              <span
                className="max-w-[220px] truncate text-danger"
                title={mutationError}
              >
                {mutationError}
              </span>
            )}
            <span className="ml-auto flex items-center gap-3">
              <span>
                {total === null
                  ? loading
                    ? t("加载中…")
                    : t("暂无数据")
                  : total === 0
                    ? t("暂无数据")
                    : t("共 {{count}} 行", { count: total.toLocaleString() })}
              </span>
              <span className="flex items-center gap-1">
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
              <Select
                className="w-[84px]"
                size="sm"
                value={String(pageSize)}
                ariaLabel={t("每页行数")}
                onChange={(value) => {
                  setPageSize(Number(value));
                  resetPaging();
                }}
                options={PAGE_SIZES.map((size) => ({
                  value: String(size),
                  label: `${size} ${t("行")}`,
                }))}
              />
            </span>
            {footer && (
              <>
                <span className="mx-1 h-4 w-px shrink-0 bg-line" />
                <div className="flex min-w-0 shrink-0 items-center gap-2">
                  {footer}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {mutation && (mutation.warning || mutation.verify_hint) && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-t border-line bg-surface-2/60 px-2 py-1 text-11 leading-relaxed text-fg-muted">
          {mutation.warning && <p className="text-warning">{mutation.warning}</p>}
          {mutation.verify_hint && (
            <pre className="mt-1 whitespace-pre-wrap font-mono text-11 text-fg-subtle">
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
          {mutationError?.includes("不支持事务") && (
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
        detail={detail}
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
          <Button variant="secondary" size="xs" onClick={() => setShowPending(false)}>
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
                  "rounded px-1 text-10",
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
                <div className="truncate font-mono text-11 text-fg-muted">
                  {entry.kind === "insert" ? t("新增行") : entry.label}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-11 text-fg-subtle">
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
              <p className="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-11 text-warning">
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

      {result?.truncated && (
        <span className="pointer-events-none absolute bottom-1 right-2 z-10 flex items-center gap-1 rounded bg-warning/20 px-1.5 py-0.5 text-10 text-warning">
          <AlertTriangle size={9} />
          {t("大字段预览已截断")}
        </span>
      )}

      <ContextMenu {...cellMenu.props} />
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
