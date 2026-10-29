/**
 * SQL 结果面板：像 DBeaver 一样分三块 —— **消息 / 摘要 / 结果 N**。
 *
 * - 消息：每个语句一段（语句 → 返回行/影响行 → 查询时间），末尾总耗时；
 * - 摘要：一行一个结果集（状态、行数、耗时、语句），点行跳到对应结果；
 * - 结果 N：数据网格。每个结果集保留自己的列、影响行数与错误；
 *   错误条直接显示在网格上方，不必切到消息页。
 *
 * 交互：Excel 式行列选择、复制（TSV/CSV/JSON）、双击查看完整（已接收）值。
 * **任意 SQL 没有可靠行定位**，所以这里：
 * - 不提供"重新读取完整字段"，截断的值会明确标注；
 * - 网格是只读的（`editable=false`）：粘贴/Delete/F2 都在网格层被拦掉，
 *   不会误改服务器数据。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Copy, Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { CopyNotice, useCopyFeedback } from "@/components/ui/copy-feedback";
import { Modal } from "@/components/ui/modal";
import type { DbColumn, DbValue } from "@/api/types/database";
import { cn } from "@/lib/cn";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { VirtualDataGrid, type CellAddress, type DataGridApi } from "./VirtualDataGrid";
import { EMPTY_SELECTION } from "./grid/selection";
import { copyMenuItems } from "./grid/copy-menu";
import { copySelectionToClipboard } from "./grid/copy-service";
import type { CopyFormat } from "./grid/copy-format";
import {
  buildMessageLog,
  buildSummaryRows,
  buildSummaryTsv,
  statementLine,
  totalElapsedMs,
} from "./result-log";

const EMPTY_ROWS: DbValue[][] = [];
const EMPTY_COLUMNS: DbColumn[] = [];

/** 底部区域的三块视图：消息（日志）/ 摘要（结果集一览）/ 结果 N（数据网格）。 */
type ResultView = "messages" | "summary" | "result";

function copyCellText(value: DbValue): string {
  if (value.kind === "null") return "NULL";
  if (value.kind === "unsupported") return value.preview;
  if (value.kind === "binary") return `[base64] ${value.base64}`;
  if (value.kind === "bit") return value.bits;
  if (value.kind === "float") return String(value.value);
  if (value.kind === "int" || value.kind === "decimal") return value.value;
  return value.value;
}

export function ResultsPanel({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const tab = useDatabaseWorkbenchStore((state) => state.tabs[tabId]);
  const setActive = useDatabaseWorkbenchStore((state) => state.setActiveResult);
  const { status: copyStatus, copy, notify } = useCopyFeedback();
  const gridApi = useRef<DataGridApi | null>(null);
  const menu = useContextMenu();

  const [detail, setDetail] = useState<{
    column: string;
    value: DbValue;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<ResultView>("result");

  const results = tab?.results ?? [];
  const activeKey = tab?.activeResultKey ?? results[0]?.key ?? null;
  const active = useMemo(
    () => results.find((result) => result.key === activeKey) ?? results[0] ?? null,
    [activeKey, results],
  );
  const rows = active?.rows ?? EMPTY_ROWS;
  const columns = active?.columns ?? EMPTY_COLUMNS;

  /**
   * 总耗时不能只看 `tab.elapsedMs`：后端 `Finished` 批次是 `try_send` 发的，
   * 通道满会被丢掉，这时总量停在 0，比单条语句还快。用各条耗时之和兜底。
   */
  const totalElapsed = totalElapsedMs(results, tab?.elapsedMs);

  /** 消息视图：每个语句一段（语句 → 结果 → 耗时），末尾给总耗时。 */
  const messageText = useMemo(
    () => buildMessageLog(results, tab?.elapsedMs ?? 0, t),
    [results, t, tab?.elapsedMs],
  );

  const summaryRows = useMemo(() => buildSummaryRows(results, t), [results, t]);
  const summaryText = useMemo(() => buildSummaryTsv(summaryRows, t), [summaryRows, t]);

  const runCopy = useCallback(
    async (format: CopyFormat, includeHeaders = false) => {
      const selection = gridApi.current?.getSelection() ?? EMPTY_SELECTION;
      if (selection.mode === null) return;
      const outcome = await copySelectionToClipboard({
        columns,
        rows,
        selection,
        format,
        includeHeaders,
        table: null,
      });
      if (!outcome.ok) {
        notify(false);
        if (outcome.reason === "too_large") {
          setNotice(t("选中内容超过复制上限，请改用导出。"));
        } else if (outcome.reason === "no_target") {
          setNotice(t("SQL 结果没有可靠的表名与字段信息，无法生成 INSERT。"));
        } else if (outcome.reason === "unsafe_values") {
          setNotice(t("选中数据包含截断或二进制字段，无法生成完整的 INSERT。"));
        }
        return;
      }
      notify(outcome.written);
      if (!outcome.written) return;
      if (outcome.partialCells > 0) {
        setNotice(
          t(
            "已复制 {{cells}} 个单元格；其中 {{partial}} 个字段为截断预览或不支持类型，完整内容请查看详情或导出。",
            { cells: outcome.cells, partial: outcome.partialCells },
          ),
        );
      } else {
        setNotice(null);
      }
    },
    [columns, notify, rows, t],
  );

  const openCopyMenu = (event: React.MouseEvent) => {
    const hasSelection = (gridApi.current?.getSelection() ?? EMPTY_SELECTION).mode !== null;
    menu.onContextMenu(() =>
      copyMenuItems({
        t,
        hasSelection,
        canInsert: false,
        onCopy: (format, includeHeaders) => void runCopy(format, includeHeaders),
      }),
    )(event);
  };

  if (!tab) return null;

  if (results.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-12 text-fg-subtle">
        {tab.runState === "running" ? (
          <>
            <Loader2 size={16} className="animate-spin text-accent" />
            {t("正在执行…")}
          </>
        ) : (
          <span>{t("这次执行没有返回结果")}</span>
        )}
      </div>
    );
  }

  /** 右侧「复制」按钮随当前视图走：日志/摘要整段复制，结果走网格选择。 */
  const copyCurrent = () => {
    if (view === "messages") {
      void copy(messageText);
      return;
    }
    if (view === "summary") {
      void copy(summaryText);
      return;
    }
    void runCopy("tsv");
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-1">
        <button
          type="button"
          onClick={() => setView("messages")}
          className={cn(
            "flex h-[28px] shrink-0 items-center gap-1 rounded-[6px] px-2.5 text-12",
            view === "messages"
              ? "bg-surface-3 text-fg"
              : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
          )}
        >
          {t("消息")}
        </button>
        <button
          type="button"
          onClick={() => setView("summary")}
          className={cn(
            "flex h-[28px] shrink-0 items-center gap-1 rounded-[6px] px-2.5 text-12",
            view === "summary"
              ? "bg-surface-3 text-fg"
              : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
          )}
        >
          {t("摘要")}
        </button>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-line" />
        {results.map((result) => {
          const isActive = view === "result" && result.key === (active?.key ?? "");
          return (
            <button
              key={result.key}
              type="button"
              onClick={() => {
                setActive(tabId, result.key);
                setView("result");
              }}
              className={cn(
                "flex h-[28px] shrink-0 items-center gap-1 rounded-[6px] px-2.5 text-12",
                isActive
                  ? "bg-surface-3 text-fg"
                  : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
              )}
              title={result.statement}
            >
              {result.error && <AlertTriangle size={9} className="text-danger" />}
              <span>
                {t("结果 {{index}}", { index: result.resultSetIndex + 1 })}
              </span>
              {result.columns.length > 0 ? (
                <span className="text-fg-subtle">
                  {result.receivedRows.toLocaleString()} {t("行")}
                </span>
              ) : (
                <span className="text-fg-subtle">
                  {t("影响")} {result.affectedRows}
                </span>
              )}
              {result.truncated && (
                <span className="rounded bg-warning/20 px-1 text-[9px] text-warning">
                  {t("截断")}
                </span>
              )}
            </button>
          );
        })}

        <span className="ml-auto flex shrink-0 items-center gap-2 pr-1 text-11 text-fg-subtle">
          {tab.runState === "running" && (
            <span className="flex items-center gap-1 text-accent">
              <Loader2 size={9} className="animate-spin" />
              {t("执行中")}
            </span>
          )}
          {tab.runState === "cancelling" && (
            <span className="flex items-center gap-1 text-warning">
              <Loader2 size={9} className="animate-spin" />
              {t("取消中（等待服务器确认）")}
            </span>
          )}
          {tab.truncated && (
            <span className="text-warning" title={tab.truncationReason ?? undefined}>
              {t("结果已截断")}
            </span>
          )}
          {totalElapsed > 0 && <span>{totalElapsed} ms</span>}
          {tab.receivedRows > 0 && (
            <span>
              {tab.receivedRows.toLocaleString()} {t("行")} ·{" "}
              {(tab.bytes / 1024).toFixed(0)} KiB
            </span>
          )}
          <Button variant="ghost" size="xs" onClick={copyCurrent}>
            <Copy size={10} />
            {view === "messages"
              ? t("复制日志")
              : view === "summary"
                ? t("复制摘要")
                : t("复制")}
          </Button>
        </span>
      </div>

      {tab.cacheWarning && (
        <div className="border-b border-warning/30 bg-warning/10 px-2 py-1 text-11 text-warning">
          {tab.cacheWarning}
        </div>
      )}

      {tab.truncated && tab.truncationReason && (
        <div className="border-b border-warning/30 bg-warning/10 px-2 py-1 text-11 text-warning">
          {t("结果不完整：{{reason}}。请增加过滤条件或分页，不要把它当作完整结果。", {
            reason: tab.truncationReason,
          })}
        </div>
      )}

      {notice && (
        <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-2 py-1 text-11 text-warning">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t("关闭")}>
            ×
          </button>
        </div>
      )}

      {view === "messages" ? (
        <pre className="ops-scroll min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-11 leading-[1.7] text-fg-muted">
          {messageText}
        </pre>
      ) : view === "summary" ? (
        <div className="ops-scroll min-h-0 flex-1 select-text overflow-auto">
          <table className="w-full table-fixed border-collapse text-11">
            <thead className="sticky top-0 z-[1] bg-surface-2 text-fg-subtle">
              <tr>
                <th className="w-10 border-b border-line px-2 py-1 text-left font-normal">#</th>
                <th className="w-14 border-b border-line px-2 py-1 text-left font-normal">
                  {t("状态")}
                </th>
                <th className="w-24 border-b border-line px-2 py-1 text-left font-normal">
                  {t("行数")}
                </th>
                <th className="w-20 border-b border-line px-2 py-1 text-left font-normal">
                  {t("耗时")}
                </th>
                <th className="border-b border-line px-2 py-1 text-left font-normal">
                  {t("语句")}
                </th>
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => (
                <tr
                  key={row.key}
                  className="cursor-default border-b border-line/40 hover:bg-surface-hover"
                  onClick={() => {
                    setActive(tabId, row.key);
                    setView("result");
                  }}
                >
                  <td className="px-2 py-1 text-fg-subtle">{row.index}</td>
                  <td className={cn("px-2 py-1", row.ok ? "text-success" : "text-danger")}>
                    {row.status}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-fg-muted">{row.counts}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-fg-subtle">{row.elapsed}</td>
                  <td
                    className="truncate px-2 py-1 font-mono text-fg-muted"
                    title={row.error ? `${row.statement}\n${row.error}` : row.statement}
                  >
                    {row.statement}
                    {row.error && (
                      <span className="ml-2 text-danger">{statementLine(row.error, 60)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {active?.error && (
            <div className="border-b border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertTriangle size={11} />
                {active.error.stage}
                {active.error.code !== null && (
                  <span className="opacity-80">
                    #{active.error.code} {active.error.sql_state ?? ""}
                  </span>
                )}
              </div>
              <div className="mt-0.5 break-words">{active.error.message}</div>
              {active.error.detail && (
                <div className="mt-0.5 break-words text-11 opacity-80">
                  {active.error.detail}
                </div>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1">
            {columns.length > 0 ? (
              <VirtualDataGrid
                apiRef={gridApi}
                columns={columns}
                rows={rows}
                editable={false}
                onCopy={({ format }) => void runCopy("tsv", format === "tsv-headers")}
                onOpenCell={(cell: CellAddress) => {
                  const value = rows[cell.row]?.[cell.col];
                  if (value) setDetail({ column: columns[cell.col]?.name ?? "", value });
                }}
                onCellContextMenu={(_cell, event) => openCopyMenu(event)}
                onRowContextMenu={(_row, event) => openCopyMenu(event)}
                onColumnContextMenu={(_col, event) => openCopyMenu(event)}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-12 text-fg-subtle">
                <span>
                  {t("影响 {{count}} 行", { count: active?.affectedRows ?? 0 })}
                </span>
                {active?.lastInsertId && (
                  <span className="text-[11px]">
                    last_insert_id = {active.lastInsertId}
                  </span>
                )}
                {active?.info && (
                  <span className="max-w-md text-center text-[11px]">{active.info}</span>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <CopyNotice status={copyStatus} />
      <ContextMenu {...menu.props} />

      <Modal
        open={detail !== null}
        title={detail ? `${detail.column} · ${detail.value.kind}` : ""}
        width={620}
        onClose={() => setDetail(null)}
        footer={
          detail && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copy(copyCellText(detail.value))}
            >
              <Copy size={12} />
              {t("复制完整值")}
            </Button>
          )
        }
      >
        {detail && (
          <div className="flex flex-col gap-2">
            {detail.value.kind === "text" && detail.value.truncated && (
              <p className="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] text-warning">
                {t(
                  "该值在查询结果中已被截断（原始 {{bytes}} 字节）。任意 SQL 结果没有可靠行定位，无法重新读取完整值。",
                  { bytes: detail.value.bytes },
                )}
              </p>
            )}
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-surface-2/60 p-2 font-mono text-[11px] text-fg">
              {formatDetail(detail.value)}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}

function formatDetail(value: DbValue): string {
  switch (value.kind) {
    case "null":
      return "NULL";
    case "int":
      return value.value;
    case "decimal":
      return value.value;
    case "float":
      return String(value.value);
    case "text":
      return value.value;
    case "json":
      try {
        return JSON.stringify(JSON.parse(value.value), null, 2);
      } catch {
        return value.value;
      }
    case "date":
    case "date_time":
    case "time":
      return value.value;
    case "binary":
      return value.base64;
    case "bit":
      return `${value.bits}\n十进制: ${value.value}`;
    case "unsupported":
      return `${value.type_name}（${value.bytes} 字节）\n${value.preview}`;
  }
}
